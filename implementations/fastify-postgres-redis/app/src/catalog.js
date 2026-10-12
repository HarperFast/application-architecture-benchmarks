/**
 * Data access shared by the endpoints: the entity cache in front of Postgres, plus the two
 * small static lookup tables.
 *
 * What is cached where, and why:
 *
 *   cart, customer, product, variant  Redis entity cache (cache-aside, invalidation + generation
 *                                     guard, TTL backstop). Read by key on every quote.
 *   inventory                         NOT cached. The most write-hot entity, and the one whose
 *                                     staleness matters most; read from Postgres per request.
 *   promotion                         NOT cached. Candidate collection is part of the measured
 *                                     fan-out, as in the reference; one GIN-indexed query.
 *   location, rate                    Loaded once per worker at startup. 8 and 22 rows, never
 *                                     written by any surface (the reference does the same).
 */
import { getEntities } from './cache.js';
import { SQL, query, toCart, toCustomer, toProduct, toRate, toVariant, toPromotion } from './db.js';

const byKey = (rows, map, key) => new Map(rows.map((row) => [row[key], map(row)]));

/**
 * @param {{pool, redis, counters, cached?: boolean}} deps  `cached: false` reads every entity
 *   straight from Postgres. Used only by the /__audit routes, which compare a cached answer with
 *   one computed from the source of truth (CACHE-001), never by the endpoints under test.
 */
export function createCatalog({ pool, redis, counters, cached = true }) {
	const loadCarts = async (ids) => byKey((await query(pool, SQL.carts, [ids])).rows, toCart, 'id');
	const loadCustomers = async (ids) => byKey((await query(pool, SQL.customers, [ids])).rows, toCustomer, 'id');
	const loadProducts = async (ids) => byKey((await query(pool, SQL.products, [ids])).rows, toProduct, 'id');
	const loadVariants = async (ids) => byKey((await query(pool, SQL.variants, [ids])).rows, toVariant, 'sku');

	let statics = null;

	return {
		/** Share the static tables of an initialized catalog instead of reading them again. */
		shareStatics(other) {
			statics = other.statics();
		},
		statics: () => statics,
		/** Load locations and rates. Called once before the worker accepts traffic. */
		async init() {
			const [locations, rates] = await Promise.all([query(pool, SQL.locations, []), query(pool, SQL.rates, [])]);
			const locationsByRegion = new Map();
			const regionOfLocation = new Map();
			for (const row of locations.rows) {
				if (!locationsByRegion.has(row.region)) locationsByRegion.set(row.region, []);
				locationsByRegion.get(row.region).push(row.id); // already ordered by priority, then id
				regionOfLocation.set(row.id, row.region);
			}
			if (!locations.rows.length || !rates.rows.length) {
				throw new Error('location or rate table is empty; load the dataset before starting the app');
			}
			statics = { locationsByRegion, regionOfLocation, rates: rates.rows.map(toRate) };
		},
		/** Location ids in a region, ascending priority (QUOTE-003). */
		locationsIn: (region) => statics.locationsByRegion.get(region) ?? [],
		regionOf: (locationId) => statics.regionOfLocation.get(locationId),
		/** Every region with a fulfillment location. */
		regions: () => [...statics.locationsByRegion.keys()],
		rates: () => statics.rates,

		carts: (ids) => (cached ? getEntities(redis, counters, 'cart', ids, loadCarts) : loadCarts(ids)),
		customers: (ids) => (cached ? getEntities(redis, counters, 'customer', ids, loadCustomers) : loadCustomers(ids)),
		products: (ids) => (cached ? getEntities(redis, counters, 'product', ids, loadProducts) : loadProducts(ids)),
		variants: (ids) => (cached ? getEntities(redis, counters, 'variant', ids, loadVariants) : loadVariants(ids)),

		/** Map<sku, onHand[]> aligned to `locationIds` order; absent rows are zero. */
		async inventory(skus, locationIds) {
			const onHand = new Map(skus.map((sku) => [sku, new Array(locationIds.length).fill(0)]));
			if (!skus.length || !locationIds.length) return onHand;
			const position = new Map(locationIds.map((id, i) => [id, i]));
			const { rows } = await query(pool, SQL.inventoryForLines, [skus, locationIds]);
			for (const row of rows) onHand.get(row.sku)[position.get(row.location_id)] = row.on_hand;
			return onHand;
		},

		async promotions(tier, categoryIds) {
			const { rows } = await query(pool, SQL.promotions, [[tier, '*'], [...categoryIds, '*']]);
			return rows.map(toPromotion);
		},

		/** Variants of a product, ascending sku, each with its availability summed over `locationIds`. */
		async variantsWithAvailability(productId, locationIds) {
			const { rows } = await query(pool, SQL.variantsForProduct, [productId, locationIds]);
			return rows;
		},
	};
}
