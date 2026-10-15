/**
 * The write surface the background writer drives: SPEC.md "Background writes", WRITE-001.
 *
 * Each write commits to Postgres, then invalidates every cached value it can have changed, and
 * only then responds; a read issued after the response observes the write (PDP-003, WRITE-002).
 * This is the coherence cost a separated stack pays: the Postgres write plus a Redis round trip
 * that sets generation tokens and deletes keys.
 *
 *   price write      variant entity + all tier x region views of the product (17 keys) and the
 *                    product's price generation
 *   inventory write  the tier views of the product in that location's region (4 keys) and that
 *                    region's generation; inventory itself is not entity-cached
 *
 * `invalidated` reports the cached keys targeted, which is what the harness sums as the
 * invalidation fan-out. Not an endpoint under test; its latency is not a headline metric.
 */
import { invalidate, keys } from '../cache.js';
import { SQL, query } from '../db.js';
import { TIER_BASIS_POINTS } from '../pricing.js';
import { HttpError } from '../timing.js';

const TIERS = Object.keys(TIER_BASIS_POINTS);

export default async function adminRoutes(app, { pool, redis, catalog }) {
	app.post('/admin/variant/:sku', async (request) => {
		const { sku } = request.params;
		const basePrice = request.body?.basePrice;
		if (!Number.isSafeInteger(basePrice) || basePrice < 0) {
			throw new HttpError(400, 'invalid_body', 'basePrice must be a non-negative integer in minor units');
		}
		const { rows } = await query(pool, SQL.updateVariantPrice, [sku, basePrice]);
		if (!rows.length) throw new HttpError(404, 'sku_not_found', `unknown sku: ${sku}`);
		const productId = rows[0].product_id;

		const cacheKeys = [keys.entity('variant', sku)];
		for (const region of catalog.regions()) for (const tier of TIERS) cacheKeys.push(keys.view(productId, tier, region));
		await invalidate(redis, [keys.entityGen('variant', sku), keys.productGen(productId)], cacheKeys);
		return { sku, basePrice, invalidated: cacheKeys.length };
	});

	app.post('/admin/inventory/:id', async (request) => {
		const { id } = request.params;
		const onHand = request.body?.onHand;
		if (!Number.isSafeInteger(onHand) || onHand < 0) {
			throw new HttpError(400, 'invalid_body', 'onHand must be a non-negative integer');
		}
		// The wire id is `${sku}:${locationId}` (the dataset's inventory id); storage keys the
		// row by the (sku, location_id) pair the specification names.
		const separator = id.indexOf(':');
		if (separator <= 0) throw new HttpError(404, 'inventory_not_found', `unknown inventory record: ${id}`);
		const sku = id.slice(0, separator);
		const locationId = id.slice(separator + 1);
		const { rows } = await query(pool, SQL.updateInventory, [sku, locationId, onHand]);
		if (!rows.length) throw new HttpError(404, 'inventory_not_found', `unknown inventory record: ${id}`);
		const productId = rows[0].product_id;
		const region = catalog.regionOf(locationId);

		const cacheKeys = TIERS.map((tier) => keys.view(productId, tier, region));
		await invalidate(redis, [keys.regionGen(productId, region)], cacheKeys);
		return { id, onHand, region, invalidated: cacheKeys.length };
	});
}
