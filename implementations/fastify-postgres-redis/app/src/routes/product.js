/**
 * GET /product/:id?tier=&region=: SPEC.md "GET /product/:id?tier=&region=". The read-heavy leg.
 *
 * The resolved aggregate is cached in Redis under product x tier x region (CACHE-003, PDP-002),
 * serialized once at fill time, and served as stored bytes on a hit, so a hit is byte-identical
 * to the fill that produced it (CACHE-001). Validity is checked against the generations the
 * write surface bumps (see cache.js), so a write is visible on the next read (PDP-003).
 *
 * On a miss: the product (entity cache) and its variants with regional availability (one
 * Postgres query) are read together; then the related products (entity cache).
 */
import fastJsonStringify from 'fast-json-stringify';
import { getView, storeView } from '../cache.js';
import { TIER_BASIS_POINTS, resolveUnitPrice } from '../pricing.js';
import { HttpError, phaseTimer } from '../timing.js';

const rollup = { type: 'object', properties: { averageCentistars: { type: 'integer' }, count: { type: 'integer' } } };
const serializeView = fastJsonStringify({
	type: 'object',
	properties: {
		product: {
			type: 'object',
			properties: {
				id: { type: 'string' },
				title: { type: 'string' },
				categoryIds: { type: 'array', items: { type: 'string' } },
				weight: { type: 'integer' },
				relatedProductIds: { type: 'array', items: { type: 'string' } },
				reviewRollup: rollup,
			},
		},
		variants: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					sku: { type: 'string' },
					productId: { type: 'string' },
					options: { type: 'object', additionalProperties: { type: 'string' } },
					basePrice: { type: 'integer' },
					weight: { type: 'integer' },
				},
			},
		},
		availability: { type: 'object', additionalProperties: { type: 'integer' } },
		resolvedPrice: { type: 'object', additionalProperties: { type: 'integer' } },
		related: {
			type: 'array',
			items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, reviewRollup: rollup } },
		},
		tier: { type: 'string' },
		region: { type: 'string' },
	},
});

/**
 * The cache key may only carry values the write surface invalidates, and the key space must be
 * bounded. A tier outside the normative table resolves as `standard` (SPEC.md "Resolved unit
 * price"), so it is served under the `standard` key and says `standard`; a region with no
 * fulfillment location is refused with 400. Both as the reference does (ecommerce-store
 * harper-5.3 resources/product.js).
 */
const token = { type: 'string', maxLength: 64 };
function viewDimensions(catalog, query) {
	const tier = Object.hasOwn(TIER_BASIS_POINTS, query.tier ?? '') ? query.tier : 'standard';
	const region = query.region ?? 'us-east';
	if (!catalog.hasRegion(region)) throw new HttpError(400, 'unknown_region', `unknown region: ${region}`);
	return { tier, region };
}

/**
 * Assemble one product aggregate from the entity cache and Postgres and serialize it. Returns
 * null for an unknown product.
 */
export async function assembleProduct(catalog, productId, tier, region, timer) {
	const [products, variantRows] = await timer.data(
		Promise.all([catalog.products([productId]), catalog.variantsWithAvailability(productId, catalog.locationsIn(region))])
	);
	const product = products.get(productId);
	if (!product) return null;
	const relatedById = await timer.data(catalog.products(product.relatedProductIds));

	const availability = {};
	const resolvedPrice = {};
	const variants = variantRows.map((row) => {
		availability[row.sku] = row.available;
		resolvedPrice[row.sku] = resolveUnitPrice(row.base_price, tier);
		return { sku: row.sku, productId: row.product_id, options: row.options, basePrice: row.base_price, weight: row.weight };
	});
	const related = [];
	for (const id of product.relatedProductIds) {
		const item = relatedById.get(id);
		if (item) related.push({ id: item.id, title: item.title, reviewRollup: item.reviewRollup });
	}
	return serializeView({ product, variants, availability, resolvedPrice, related, tier, region });
}

const params = { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['id'] };
const querystring = { type: 'object', properties: { tier: token, region: token } };

export default async function productRoutes(app, { catalog, freshCatalog, redis, counters }) {
	app.get('/product/:id', { schema: { params, querystring } }, async (request, reply) => {
		const timer = phaseTimer();
		const productId = request.params.id;
		const { tier, region } = viewDimensions(catalog, request.query);

		const view = await timer.data(getView(redis, productId, tier, region));
		if (view.json !== null) {
			counters.add('view.hit');
			reply.header('server-timing', timer.header('hit')).type('application/json; charset=utf-8');
			return view.json;
		}
		counters.add('view.miss');

		const json = await assembleProduct(catalog, productId, tier, region, timer);
		if (json === null) throw new HttpError(404, 'product_not_found', `unknown product: ${productId}`);
		// Not awaited, like an entity fill: the response does not depend on it (see storeView).
		storeView(redis, productId, tier, region, view.stamp, json).catch((error) => console.error('view fill failed', error.message));
		reply.header('server-timing', timer.header('miss')).type('application/json; charset=utf-8');
		return json;
	});

	// Audit only (never driven by the harness): the aggregate assembled from Postgres alone,
	// neither reading nor filling any cache. A coherent cache serves exactly these bytes.
	app.get('/__audit/product/:id', { schema: { params, querystring } }, async (request, reply) => {
		const productId = request.params.id;
		const { tier, region } = viewDimensions(freshCatalog, request.query);
		const json = await assembleProduct(freshCatalog, productId, tier, region, phaseTimer());
		if (json === null) throw new HttpError(404, 'product_not_found', `unknown product: ${productId}`);
		reply.type('application/json; charset=utf-8');
		return json;
	});
}
