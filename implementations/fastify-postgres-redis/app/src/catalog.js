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
 *   location, rate                    Held in each worker's memory, re-read every LOOKUP_REFRESH_MS
 *                                     (half of FRESH_MS). 8 and 22 rows; no application path writes
 *                                     them, but they are writable in Postgres, and CACHE-002 bounds
 *                                     every cached value. The reference bounds its memos the same way.
 */
import { getEntities } from './cache.js';
import { SQL, query, toCart, toCustomer, toProduct, toRate, toVariant, toPromotion } from './db.js';

const byKey = (rows, map, key) => new Map(rows.map((row) => [row[key], map(row)]));

/** Re-read interval for the in-memory lookup tables: half of FRESH_MS (CACHE-002). */
export const LOOKUP_REFRESH_MS = 500;

/**
 * Locations and rates, held per worker and re-read on an interval so no copy is older than
 * LOOKUP_REFRESH_MS plus one read. A failed re-read keeps the previous copy and is logged; it
 * does not fail requests.
 */
export function createStatics(pool) {
	let value = null;
	let timer = null;
	const load = async () => {
		const [locations, rates] = await Promise.all([query(pool, SQL.locations, []), query(pool, SQL.rates, [])]);
		if (!locations.rows.length || !rates.rows.length) {
			throw new Error('location or rate table is empty; load the dataset before starting the app');
		}
		const locationsByRegion = new Map();
		const regionOfLocation = new Map();
		for (const row of locations.rows) {
			if (!locationsByRegion.has(row.region)) locationsByRegion.set(row.region, []);
			locationsByRegion.get(row.region).push(row.id); // ordered by priority, then id
			regionOfLocation.set(row.id, row.region);
		}
		value = { locationsByRegion, regionOfLocation, regions: [...locationsByRegion.keys()], rates: rates.rows.map(toRate) };
	};
	return {
		/** Load once (before the worker accepts traffic), then keep re-reading. */
		async start() {
			await load();
			timer = setInterval(() => load().catch((error) => console.error('lookup table refresh failed', error.message)), LOOKUP_REFRESH_MS);
			timer.unref();
		},
		stop: () => clearInterval(timer),
		current: () => value,
	};
}

/**
 * @param {{pool, redis, counters, statics, cached?: boolean}} deps  `cached: false` reads every entity
 *   straight from Postgres. Used only by the /__audit routes, which compare a cached answer with
 *   one computed from the source of truth (CACHE-001), never by the endpoints under test.
 */
export function createCatalog({ pool, redis, counters, statics, cached = true }) {
	const loadCarts = async (ids) => byKey((await query(pool, SQL.carts, [ids])).rows, toCart, 'id');
	const loadCustomers = async (ids) => byKey((await query(pool, SQL.customers, [ids])).rows, toCustomer, 'id');
	const loadProducts = async (ids) => byKey((await query(pool, SQL.products, [ids])).rows, toProduct, 'id');
	const loadVariants = async (ids) => byKey((await query(pool, SQL.variants, [ids])).rows, toVariant, 'sku');

	const current = () => statics.current();

	return {
		/** Location ids in a region, ascending priority (QUOTE-003). */
		locationsIn: (region) => current().locationsByRegion.get(region) ?? [],
		regionOf: (locationId) => current().regionOfLocation.get(locationId),
		/** Every region with a fulfillment location. */
		regions: () => current().regions,
		hasRegion: (region) => current().locationsByRegion.has(region),
		rates: () => current().rates,

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
