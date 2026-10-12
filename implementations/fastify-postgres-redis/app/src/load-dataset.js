/**
 * Load the committed ecommerce-store dataset into Postgres. Seeding is not measured (benchmarks
 * README, Run lifecycle); this exists to be correct.
 *
 *   node src/load-dataset.js --dataset /dataset
 *
 * 1. Verify every file against MANIFEST.json, sha256 over uncompressed bytes and row count,
 *    BEFORE anything is written (DATA-003). A gzipped dataset (`bench`) is verified and loaded
 *    straight from the .gz files, so nothing is expanded to disk.
 * 2. In one transaction: create the tables, COPY every row, then add keys and indexes (the order
 *    the PostgreSQL manual recommends for bulk loads), and record the manifest.
 * 3. VACUUM ANALYZE, so planner statistics and the visibility map are current before any run.
 * 4. FLUSHALL Redis. Every cached value derives from the tables just replaced (CACHE-001).
 *
 * Rows are mapped field by field and any unexpected or missing field fails the load, the same
 * guard the reference gets from `@sealed` tables.
 */
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { createClient } from 'redis';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};
const DIR = argOf('dataset', '/dataset');
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://store:store@localhost:5432/store';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const SQL_DIR = join(import.meta.dirname, '..', 'sql');

// --- COPY text-format encoding ---------------------------------------------------------------
const ESCAPES = { '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' };
const escape = (s) => s.replace(/[\\\t\n\r]/g, (c) => ESCAPES[c]);
const str = (v) => {
	if (typeof v !== 'string') throw new TypeError(`expected a string, got ${JSON.stringify(v)}`);
	return v;
};
const text = (v) => escape(str(v));
const int = (v) => {
	if (!Number.isSafeInteger(v)) throw new TypeError(`expected an integer, got ${JSON.stringify(v)}`);
	return String(v);
};
const textArray = (v) => {
	if (!Array.isArray(v)) throw new TypeError(`expected an array, got ${JSON.stringify(v)}`);
	// Array literal first (elements double-quoted, `"` and `\` backslash-escaped), then COPY-escaped once.
	return escape(`{${v.map((x) => `"${str(x).replace(/["\\]/g, '\\$&')}"`).join(',')}}`);
};
const json = (v) => escape(JSON.stringify(v));

/** Per table: the exact field set, the column list, and the row encoder. */
const TABLES = {
	location: {
		fields: ['id', 'priority', 'region'],
		columns: 'id, region, priority',
		encode: (r) => [text(r.id), text(r.region), int(r.priority)],
	},
	rate: {
		fields: ['amountMinor', 'basisPoints', 'id', 'jurisdiction', 'kind', 'region', 'weightMax', 'weightMin'],
		columns: 'id, kind, region, weight_min, weight_max, jurisdiction, amount_minor, basis_points',
		encode: (r) => [text(r.id), text(r.kind), text(r.region), int(r.weightMin), int(r.weightMax), text(r.jurisdiction), int(r.amountMinor), int(r.basisPoints)],
	},
	promotion: {
		fields: ['amountBasisPoints', 'amountMinor', 'categoryIds', 'categoryKeys', 'id', 'kind', 'skus', 'thresholdMinor', 'tierKeys', 'tiers'],
		columns: 'id, kind, tiers, skus, category_ids, tier_keys, category_keys, threshold_minor, amount_minor, amount_basis_points',
		encode: (r) => [
			text(r.id), text(r.kind), textArray(r.tiers), textArray(r.skus), textArray(r.categoryIds),
			textArray(r.tierKeys), textArray(r.categoryKeys), int(r.thresholdMinor), int(r.amountMinor), int(r.amountBasisPoints),
		],
	},
	customer: {
		fields: ['id', 'loyaltyBalance', 'region', 'taxJurisdiction', 'tier'],
		columns: 'id, tier, loyalty_balance, region, tax_jurisdiction',
		encode: (r) => [text(r.id), text(r.tier), int(r.loyaltyBalance), text(r.region), text(r.taxJurisdiction)],
	},
	product: {
		fields: ['categoryIds', 'id', 'relatedProductIds', 'reviewRollup', 'title', 'weight'],
		columns: 'id, title, category_ids, weight, related_product_ids, review_count, review_average_centistars',
		encode: (r) => [
			text(r.id), text(r.title), textArray(r.categoryIds), int(r.weight), textArray(r.relatedProductIds),
			int(r.reviewRollup.count), int(r.reviewRollup.averageCentistars),
		],
	},
	variant: {
		fields: ['basePrice', 'options', 'productId', 'sku', 'weight'],
		columns: 'sku, product_id, options, base_price, weight',
		encode: (r) => [text(r.sku), text(r.productId), json(r.options), int(r.basePrice), int(r.weight)],
	},
	inventory: {
		fields: ['id', 'locationId', 'onHand', 'sku'],
		columns: 'sku, location_id, on_hand',
		encode: (r) => {
			if (r.id !== `${r.sku}:${r.locationId}`) throw new Error(`inventory id ${r.id} is not sku:locationId`);
			return [text(r.sku), text(r.locationId), int(r.onHand)];
		},
	},
	cart: {
		fields: ['customerId', 'id', 'lines'],
		columns: 'id, customer_id, lines',
		encode: (r) => {
			for (const line of r.lines) {
				if (Object.keys(line).sort().join() !== 'quantity,sku' || !Number.isSafeInteger(line.quantity) || line.quantity < 1) {
					throw new Error(`cart ${r.id} has a malformed line ${JSON.stringify(line)}`);
				}
			}
			return [text(r.id), text(r.customerId), json(r.lines)];
		},
	},
};
// Parents before children, so the foreign keys added afterwards validate in a natural order.
const LOAD_ORDER = ['location', 'rate', 'promotion', 'customer', 'product', 'variant', 'inventory', 'cart'];

const manifest = JSON.parse(await readFile(join(DIR, 'MANIFEST.json'), 'utf8'));
const fileOf = (table) => join(DIR, `${table}.ndjson${manifest.compressed ? '.gz' : ''}`);
const open = (table) => {
	const raw = createReadStream(fileOf(table));
	return manifest.compressed ? raw.pipe(createGunzip()) : raw;
};

console.log(`dataset ${manifest.scale} · seed ${manifest.seed} · generator ${manifest.generatorVersion} · spec ${manifest.specVersion}`);
if (Object.keys(manifest.files).sort().join() !== [...LOAD_ORDER].sort().join()) {
	throw new Error(`DATA-001: manifest lists [${Object.keys(manifest.files)}], expected the eight entities`);
}

// --- 1. verify ---------------------------------------------------------------------------------
for (const table of LOAD_ORDER) {
	const hash = createHash('sha256');
	let rows = 0;
	for await (const chunk of open(table)) {
		hash.update(chunk);
		for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) rows++;
	}
	const sha256 = hash.digest('hex');
	const expected = manifest.files[table];
	if (sha256 !== expected.sha256 || rows !== expected.rows) {
		throw new Error(`DATA-003: ${table} does not match MANIFEST.json (sha256 ${sha256}, rows ${rows}; expected ${expected.sha256}, ${expected.rows})`);
	}
	console.log(`  verified ${table.padEnd(10)} ${String(rows).padStart(10)} rows  ${sha256.slice(0, 16)}…`);
}

// --- 2. load -----------------------------------------------------------------------------------
const client = new pg.Client({ connectionString: DATABASE_URL, application_name: 'store-loader' });
await client.connect();
const started = Date.now();
try {
	await client.query("SET maintenance_work_mem = '256MB'");
	await client.query('SET synchronous_commit = off');
	await client.query('BEGIN');
	await client.query(await readFile(join(SQL_DIR, 'schema.sql'), 'utf8'));

	for (const table of LOAD_ORDER) {
		const spec = TABLES[table];
		const expectedFields = spec.fields.join();
		let rows = 0;
		async function* encoded() {
			let batch = '';
			for await (const line of createInterface({ input: open(table), crlfDelay: Infinity })) {
				if (!line) continue;
				const row = JSON.parse(line);
				const fields = Object.keys(row).sort().join();
				if (fields !== expectedFields) throw new Error(`${table} row has fields [${fields}], expected [${expectedFields}]`);
				batch += spec.encode(row).join('\t') + '\n';
				rows++;
				if (batch.length > 1 << 16) {
					yield batch;
					batch = '';
				}
			}
			if (batch) yield batch;
		}
		const t0 = Date.now();
		await pipeline(Readable.from(encoded()), client.query(copyFrom(`COPY ${table} (${spec.columns}) FROM STDIN (FORMAT text)`)));
		if (rows !== manifest.files[table].rows) throw new Error(`${table}: copied ${rows} rows, manifest says ${manifest.files[table].rows}`);
		console.log(`  loaded   ${table.padEnd(10)} ${String(rows).padStart(10)} rows  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
	}

	const t0 = Date.now();
	await client.query(await readFile(join(SQL_DIR, 'indexes.sql'), 'utf8'));
	console.log(`  keys, indexes and foreign keys  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
	await client.query(
		'INSERT INTO dataset_manifest (scale, seed, generator_version, spec_version, files) VALUES ($1, $2, $3, $4, $5)',
		[manifest.scale, manifest.seed, manifest.generatorVersion, manifest.specVersion, JSON.stringify(manifest.files)]
	);
	await client.query('COMMIT');
} catch (error) {
	await client.query('ROLLBACK').catch(() => {});
	throw error;
}

// --- 3. statistics and visibility map ----------------------------------------------------------
{
	const t0 = Date.now();
	await client.query('VACUUM (ANALYZE)');
	console.log(`  vacuum analyze  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
	for (const table of LOAD_ORDER) {
		const { rows } = await client.query(`SELECT count(*)::bigint AS n FROM ${table}`);
		if (rows[0].n !== String(manifest.files[table].rows)) throw new Error(`${table}: table holds ${rows[0].n} rows after load`);
	}
}
await client.end();

// --- 4. drop every derived value ---------------------------------------------------------------
const redis = createClient({ url: REDIS_URL });
redis.on('error', (error) => console.error('redis', error.message));
await redis.connect();
await redis.flushAll();
await redis.close();

console.log(`\nloaded ${manifest.scale} in ${((Date.now() - started) / 1000).toFixed(1)}s; Redis flushed`);
