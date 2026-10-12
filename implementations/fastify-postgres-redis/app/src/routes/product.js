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
import { resolveUnitPrice } from '../pricing.js';
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

/** Tier and region are free-form tokens: an unknown tier prices as `standard` (SPEC.md), an unknown region has no stock. */
const token = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,32}$' };

export default async function productRoutes(app, { catalog, redis, counters }) {
	app.get(
		'/product/:id',
		{
			schema: {
				params: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['id'] },
				querystring: { type: 'object', properties: { tier: token, region: token } },
			},
		},
		async (request, reply) => {
			const timer = phaseTimer();
			const productId = request.params.id;
			const tier = request.query.tier ?? 'standard';
			const region = request.query.region ?? 'us-east';

			const view = await timer.data(getView(redis, productId, tier, region));
			if (view.json !== null) {
				counters.add('view.hit');
				reply.header('server-timing', timer.header('hit')).type('application/json; charset=utf-8');
				return view.json;
			}
			counters.add('view.miss');

			const [products, variantRows] = await timer.data(
				Promise.all([catalog.products([productId]), catalog.variantsWithAvailability(productId, catalog.locationsIn(region))])
			);
			const product = products.get(productId);
			if (!product) throw new HttpError(404, 'product_not_found', `unknown product: ${productId}`);
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
			const json = serializeView({ product, variants, availability, resolvedPrice, related, tier, region });

			await timer.data(storeView(redis, productId, tier, region, view.stamp, json));
			reply.header('server-timing', timer.header('miss')).type('application/json; charset=utf-8');
			return json;
		}
	);
}
