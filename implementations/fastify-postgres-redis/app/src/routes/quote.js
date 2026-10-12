/**
 * POST /cart/:id/quote: SPEC.md "POST /cart/:id/quote". The primary endpoint under test.
 *
 * Never response-cached (QUOTE-001). Entity caches do their normal job. The reads form a
 * dependency graph, and each read is issued the moment its inputs exist:
 *
 *   cart ──┬─> variants ──> products ──┐
 *          └─> customer ──┬────────────┴─> promotions (tier x categories)
 *                         └─> inventory (skus x the customer's region locations)
 *   then pricing in JS; shipping and tax from the static rate table.
 *
 * Every record the specification names is read (DATA-001); batching a wave into one MGET or one
 * `= ANY($1)` query reads the same records in fewer round trips.
 */
import { HttpError, phaseTimer } from '../timing.js';
import { evaluatePromotions, mergeLines, resolveShipping, resolveTax, resolveUnitPrice } from '../pricing.js';

const quoteSchema = {
	type: 'object',
	properties: {
		cartId: { type: 'string' },
		tier: { type: 'string' },
		loyaltyBalance: { type: 'integer' },
		region: { type: 'string' },
		taxJurisdiction: { type: 'string' },
		totalWeight: { type: 'integer' },
		lines: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					sku: { type: 'string' },
					quantity: { type: 'integer' },
					unitPrice: { type: 'integer' },
					appliedPromotionIds: { type: 'array', items: { type: 'string' } },
					lineTotal: { type: 'integer' },
					shortfall: { type: 'integer' },
				},
			},
		},
		subtotal: { type: 'integer' },
		discountTotal: { type: 'integer' },
		shipping: { type: 'integer' },
		tax: { type: 'integer' },
		grandTotal: { type: 'integer' },
		currency: { type: 'string' },
	},
};

export default async function quoteRoutes(app, { catalog }) {
	app.post(
		'/cart/:id/quote',
		{
			schema: {
				params: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['id'] },
				response: { 200: quoteSchema },
			},
		},
		async (request, reply) => {
			const timer = phaseTimer();
			const cartId = request.params.id;

			// Wave 1: the cart.
			const cart = (await timer.data(catalog.carts([cartId]))).get(cartId);
			if (!cart) throw new HttpError(404, 'cart_not_found', `unknown cart: ${cartId}`);
			const lines = mergeLines(cart.lines);
			const skus = lines.map((line) => line.sku);

			// Waves 2-4, each read issued as soon as its inputs resolve.
			const variantsP = catalog.variants(skus);
			const customerP = catalog.customers([cart.customerId]).then((found) => found.get(cart.customerId));
			const productsP = variantsP.then((variants) => {
				const unknown = skus.find((sku) => !variants.has(sku));
				// QUOTE-002: an unknown sku fails the quote; it is never silently dropped.
				if (unknown) throw new HttpError(400, 'unknown_sku', `unknown sku: ${unknown}`);
				return catalog.products(skus.map((sku) => variants.get(sku).productId));
			});
			const inventoryP = customerP.then((customer) =>
				customer ? catalog.inventory(skus, catalog.locationsIn(customer.region)) : null
			);
			const promotionsP = Promise.all([customerP, productsP]).then(([customer, products]) => {
				if (!customer) return [];
				const categories = new Set();
				for (const product of products.values()) for (const category of product.categoryIds) categories.add(category);
				return catalog.promotions(customer.tier, [...categories]);
			});
			const [variants, customer, products, inventory, promotions] = await timer.data(
				Promise.all([variantsP, customerP, productsP, inventoryP, promotionsP])
			);
			if (!customer) throw new HttpError(400, 'customer_not_found', `cart ${cartId} names an unknown customer`);

			// Pricing (QUOTE-004, QUOTE-005) and availability (QUOTE-003).
			let totalWeight = 0;
			const priced = lines.map((line) => {
				const variant = variants.get(line.sku);
				const product = products.get(variant.productId);
				if (!product) throw new HttpError(400, 'unknown_product', `sku ${line.sku} names an unknown product`);
				totalWeight += variant.weight * line.quantity;
				return {
					sku: line.sku,
					quantity: line.quantity,
					unitPrice: resolveUnitPrice(variant.basePrice, customer.tier),
					categoryIds: product.categoryIds,
				};
			});
			const { subtotal, discountTotal, applied } = evaluatePromotions({ lines: priced, promotions, tier: customer.tier });

			const rates = catalog.rates();
			const shipping = resolveShipping(rates, customer.region, totalWeight); // QUOTE-006
			const tax = resolveTax(rates, customer.taxJurisdiction, subtotal - discountTotal); // QUOTE-007

			const outLines = priced.map((line) => {
				// Draw from each location in ascending priority until satisfied; price the full
				// quantity and report what could not be covered.
				let shortfall = line.quantity;
				for (const onHand of inventory.get(line.sku)) {
					if (shortfall === 0) break;
					if (onHand > 0) shortfall -= Math.min(onHand, shortfall);
				}
				return {
					sku: line.sku,
					quantity: line.quantity,
					unitPrice: line.unitPrice,
					appliedPromotionIds: applied.get(line.sku),
					lineTotal: line.unitPrice * line.quantity,
					shortfall,
				};
			});

			reply.header('server-timing', timer.header('miss'));
			return {
				cartId,
				tier: customer.tier,
				loyaltyBalance: customer.loyaltyBalance ?? 0, // QUOTE-004: read and carried, never redeemed
				region: customer.region,
				taxJurisdiction: customer.taxJurisdiction,
				totalWeight,
				lines: outLines,
				subtotal,
				discountTotal,
				shipping,
				tax,
				grandTotal: subtotal - discountTotal + shipping + tax,
				currency: 'USD',
			};
		}
	);
}
