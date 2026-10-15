/**
 * PostgreSQL access: the source of truth for all eight entities.
 *
 * node-postgres with a pool per worker. Every hot statement is a NAMED query, so it is parsed
 * and planned once per connection and executed as a prepared statement thereafter. Batched
 * reads use `= ANY($1::text[])` so one round trip resolves a whole wave (every record is still
 * read; nothing is pre-joined into the source of truth, DATA-001).
 */
import pg from 'pg';
import { config } from './config.js';

// int8 (bigint) arrives as a string by default. Money is stored as bigint minor units; parse it
// to a Number and refuse anything outside the exact integer range rather than lose a cent.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => {
	const n = Number(value);
	if (!Number.isSafeInteger(n)) throw new RangeError(`int8 value outside the exact integer range: ${value}`);
	return n;
});

export function createPool() {
	const pool = new pg.Pool({
		connectionString: config.databaseUrl,
		max: config.pgPoolMax,
		idleTimeoutMillis: 0,
		connectionTimeoutMillis: 10_000,
		statement_timeout: config.pgStatementTimeoutMs,
		application_name: `store-app-${process.pid}`,
	});
	pool.on('error', (error) => console.error('pg pool error', error));
	return pool;
}

/** Named statements. Text is fixed; names are stable so each connection prepares them once. */
export const SQL = {
	carts: {
		name: 'carts_by_id',
		text: 'SELECT id, customer_id, lines FROM cart WHERE id = ANY($1::text[])',
	},
	customers: {
		name: 'customers_by_id',
		text: 'SELECT id, tier, loyalty_balance, region, tax_jurisdiction FROM customer WHERE id = ANY($1::text[])',
	},
	products: {
		name: 'products_by_id',
		text: `SELECT id, title, category_ids, weight, related_product_ids, review_count, review_average_centistars
		       FROM product WHERE id = ANY($1::text[])`,
	},
	variants: {
		name: 'variants_by_sku',
		text: 'SELECT sku, product_id, options, base_price, weight FROM variant WHERE sku = ANY($1::text[])',
	},
	/** Quote wave 3: on-hand per (sku, location) for the customer's region. Served by the covering PK. */
	inventoryForLines: {
		name: 'inventory_for_lines',
		text: `SELECT sku, location_id, on_hand FROM inventory
		       WHERE sku = ANY($1::text[]) AND location_id = ANY($2::text[])`,
	},
	/**
	 * Product aggregate: a product's variants with their availability in one region. The
	 * inventory sum is a correlated subquery per variant over the (sku, location_id) primary key.
	 */
	variantsForProduct: {
		name: 'variants_for_product',
		text: `SELECT v.sku, v.product_id, v.options, v.base_price, v.weight,
		              COALESCE((SELECT sum(i.on_hand) FROM inventory i
		                        WHERE i.sku = v.sku AND i.location_id = ANY($2::text[])), 0)::bigint AS available
		       FROM variant v WHERE v.product_id = $1 ORDER BY v.sku`,
	},
	/**
	 * Candidate promotions. `tier_keys` / `category_keys` carry the dataset's '*' sentinel for an
	 * unrestricted dimension, so array overlap against [value, '*'] returns a SUPERSET of the
	 * eligible set through the GIN indexes; pricing.js applies the authoritative arrays.
	 */
	promotions: {
		name: 'promotion_candidates',
		text: `SELECT id, kind, tiers, skus, category_ids, threshold_minor, amount_minor, amount_basis_points
		       FROM promotion WHERE tier_keys && $1::text[] AND category_keys && $2::text[] ORDER BY id`,
	},
	locations: { name: 'locations_all', text: 'SELECT id, region, priority FROM location ORDER BY priority, id' },
	rates: {
		name: 'rates_all',
		text: 'SELECT id, kind, region, weight_min, weight_max, jurisdiction, amount_minor, basis_points FROM rate ORDER BY id',
	},
	updateVariantPrice: {
		name: 'update_variant_price',
		text: 'UPDATE variant SET base_price = $2 WHERE sku = $1 RETURNING product_id',
	},
	updateInventory: {
		name: 'update_inventory',
		text: `UPDATE inventory i SET on_hand = $3 FROM variant v
		       WHERE i.sku = $1 AND i.location_id = $2 AND v.sku = i.sku
		       RETURNING v.product_id`,
	},
	manifest: { name: 'dataset_manifest', text: 'SELECT scale, seed, generator_version, spec_version, files, loaded_at FROM dataset_manifest' },
};

export const query = (pool, statement, values) => pool.query({ ...statement, values });

// Row mappers: database shape -> wire shape (SPEC.md field names, packages/spec model.ts).
export const toCart = (row) => ({ id: row.id, customerId: row.customer_id, lines: row.lines });
export const toCustomer = (row) => ({
	id: row.id,
	tier: row.tier,
	loyaltyBalance: row.loyalty_balance,
	region: row.region,
	taxJurisdiction: row.tax_jurisdiction,
});
export const toProduct = (row) => ({
	id: row.id,
	title: row.title,
	categoryIds: row.category_ids,
	weight: row.weight,
	relatedProductIds: row.related_product_ids,
	reviewRollup: { averageCentistars: row.review_average_centistars, count: row.review_count },
});
export const toVariant = (row) => ({
	sku: row.sku,
	productId: row.product_id,
	options: row.options,
	basePrice: row.base_price,
	weight: row.weight,
});
export const toPromotion = (row) => ({
	id: row.id,
	kind: row.kind,
	tiers: row.tiers,
	skus: row.skus,
	categoryIds: row.category_ids,
	thresholdMinor: row.threshold_minor,
	amountMinor: row.amount_minor,
	amountBasisPoints: row.amount_basis_points,
});
export const toRate = (row) => ({
	id: row.id,
	kind: row.kind,
	region: row.region,
	weightMin: row.weight_min,
	weightMax: row.weight_max,
	jurisdiction: row.jurisdiction,
	amountMinor: row.amount_minor,
	basisPoints: row.basis_points,
});
