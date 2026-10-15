/**
 * Diagnostic, not a measurement: where a target spends a request, from its own Server-Timing
 * header (OBS-001: `data`, `compute`, `total`), one request at a time so no queueing is included.
 *
 * Warms the target with the hottest keys first (the workload's scrambled Zipf), then times quotes
 * for the hottest carts and product aggregates for the hottest products in one tier and region,
 * and prints the median and p90 of each phase. Run against a freshly restored target outside a
 * measured trial; the numbers describe one target's service time, never a comparison result.
 *
 *   node server-timing.mjs --url http://localhost:39936 --dataset <expanded dataset dir> \
 *     --ecommerce-store <checkout> [--carts 400] [--products 400] [--warm 2000]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 || !args[i + 1] ? fallback : args[i + 1];
};
const URL = argOf('url');
const DATASET = argOf('dataset');
const ES = argOf('ecommerce-store');
const CARTS = Number(argOf('carts', 400));
const PRODUCTS = Number(argOf('products', 400));
const WARM = Number(argOf('warm', 2000));

const { sampleIds } = await import(pathToFileURL(join(ES, 'bench/workload.mjs')).href);
const { scramble } = await import(pathToFileURL(join(ES, 'node_modules/@ecommerce-store/spec/src/index.ts')).href);
const rows = JSON.parse(readFileSync(join(DATASET, 'MANIFEST.json'), 'utf8')).files;
const [cartIds, productIds] = await Promise.all([
	sampleIds(DATASET, 'cart', 'id', rows.cart.rows, rows.cart.rows),
	sampleIds(DATASET, 'product', 'id', rows.product.rows, rows.product.rows),
]);
const hottest = (ids, n) => Array.from({ length: Math.min(n, ids.length) }, (_, rank) => ids[scramble(rank, ids.length)]);

const timing = (header) => Object.fromEntries((header ?? '').split(',').map((part) => {
	const [name, ...params] = part.trim().split(';');
	const dur = params.map((p) => /^dur=([\d.]+)$/.exec(p.trim())).find(Boolean);
	return [name, dur ? Number(dur[1]) : null];
}).filter(([name]) => name));
async function call(kind, id) {
	const started = performance.now();
	const response = kind === 'quote'
		? await fetch(`${URL}/cart/${id}/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
		: await fetch(`${URL}/product/${id}?tier=standard&region=us-east`);
	const body = await response.text();
	return { status: response.status, clientMs: performance.now() - started, bytes: body.length, ...timing(response.headers.get('server-timing')) };
}

// Warm-up: the hottest keys, four at a time, quotes and products alternating.
const warmCarts = hottest(cartIds, WARM / 2);
const warmProducts = hottest(productIds, WARM / 2);
let w = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
	while (w < WARM) {
		const i = w++;
		await (i % 2 ? call('product', warmProducts[i >> 1]) : call('quote', warmCarts[i >> 1]));
	}
}));

const quantile = (xs, q) => { const v = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)] : null; };
const summarize = (samples) => {
	const phases = [...new Set(samples.flatMap((s) => Object.keys(s)))].filter((k) => !['status', 'bytes'].includes(k));
	return Object.fromEntries([['n', samples.length], ['non2xx', samples.filter((s) => s.status >= 300).length], ['bytesMedian', quantile(samples.map((s) => s.bytes), 0.5)],
		...phases.map((p) => [p, { p50: quantile(samples.map((s) => s[p]), 0.5), p90: quantile(samples.map((s) => s[p]), 0.9) }])]);
};
const quotes = [];
for (const id of hottest(cartIds, CARTS)) quotes.push(await call('quote', id));
const products = [];
for (const id of hottest(productIds, PRODUCTS)) products.push(await call('product', id));
console.log(JSON.stringify({ url: URL, warm: WARM, quote: summarize(quotes), product: summarize(products) }, null, 2));
