/**
 * Cache-coherence audit for the Fastify + Postgres + Redis target, run after a measurement once
 * the write stream has stopped.
 *
 * The harness counts every 2xx as success, so a stale cache would pass a run silently. This
 * compares, byte for byte, what the cached endpoints answer against the app's /__audit routes,
 * which compute the same response from Postgres alone (no entity cache, no aggregate cache). Any
 * difference is a value the caches failed to invalidate (CACHE-001, CACHE-002).
 *
 * Covers what the run wrote, at a bounded size on any dataset: the products its write stream
 * touched, rebuilt from the run record with the harness's own planWrites (same seed, same counts,
 * the product ids in the same file order), most-written first, in all 16 views; a stride across
 * the products it did not write; and the hottest carts by the workload's scrambled Zipf, whose
 * quotes read the written variants through the entity cache. Without a run record, the hottest
 * products by the same Zipf stand in for the written ones. On `bench` an unbounded sample was
 * 3.2 million comparisons, hours of work.
 *
 *   node audit-coherence.mjs --url http://localhost:39926 --dataset <expanded dataset dir> \
 *     --ecommerce-store <checkout> [--record <run record>] [--products 400] [--carts 500]
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
const RECORD = argOf('record', null);
const PRODUCTS = Number(argOf('products', 400));
const CARTS = Number(argOf('carts', 500));
const TIERS = ['standard', 'silver', 'gold', 'platinum'];
const REGIONS = ['us-east', 'us-west', 'eu-central', 'apac'];

const { planWrites, sampleIds } = await import(pathToFileURL(join(ES, 'bench/workload.mjs')).href);
const { scramble } = await import(pathToFileURL(join(ES, 'node_modules/@ecommerce-store/spec/src/index.ts')).href);
const rows = JSON.parse(readFileSync(join(DATASET, 'MANIFEST.json'), 'utf8')).files;
const [cartIds, productIds] = await Promise.all([
	sampleIds(DATASET, 'cart', 'id', rows.cart.rows, rows.cart.rows),
	sampleIds(DATASET, 'product', 'id', rows.product.rows, rows.product.rows),
]);

/** The first half of `list`, then an even stride across the rest, `n` in all. */
const spread = (list, n) => {
	if (list.length <= n) return list;
	const head = list.slice(0, n >> 1);
	const rest = list.slice(n >> 1);
	const k = n - head.length;
	return [...head, ...Array.from({ length: k }, (_, j) => rest[Math.floor((j * rest.length) / k)])];
};
const hottest = (n, count) => Array.from({ length: Math.min(n, count) }, (_, rank) => scramble(rank, count));

// Products written in this run, as run.mjs planned them: the warm-up's and every step's seconds at
// the write rate, drawn with the write seed.
let written;
let source;
if (RECORD) {
	const h = JSON.parse(readFileSync(RECORD, 'utf8')).conditions.harness;
	const planned = [h.warmup.seconds, ...h.rates.map(() => h.durationSeconds)].reduce((sum, s) => sum + Math.round(h.writeRate * s), 0);
	const counts = new Map();
	if (h.writeRate > 0) {
		for (const w of planWrites({ productCount: productIds.length, total: Math.max(1, planned), seed: h.seeds.writes })) counts.set(w.productIndex, (counts.get(w.productIndex) ?? 0) + 1);
	}
	written = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([index]) => index);
	source = `${written.length} products written by ${planned} planned writes`;
} else {
	written = hottest(PRODUCTS * 4, productIds.length);
	source = `no run record: the ${written.length} hottest products stand in for the written ones`;
}
const writtenSet = new Set(written);
const writtenPicked = spread(written, Math.round(PRODUCTS * 0.75));
const strideCount = PRODUCTS - writtenPicked.length;
const unwritten = Array.from({ length: strideCount }, (_, j) => Math.floor((j * productIds.length) / strideCount)).filter((index) => !writtenSet.has(index));
const products = [...writtenPicked, ...unwritten].map((index) => productIds[index]);
const carts = hottest(CARTS, cartIds.length).map((index) => cartIds[index]);

const checks = [];
for (const id of products) {
	for (const tier of TIERS) for (const region of REGIONS) checks.push({ cached: ['GET', `/product/${id}?tier=${tier}&region=${region}`], fresh: ['GET', `/__audit/product/${id}?tier=${tier}&region=${region}`] });
}
for (const id of carts) checks.push({ cached: ['POST', `/cart/${id}/quote`], fresh: ['POST', `/__audit/cart/${id}/quote`] });

const text = async ([method, path]) => {
	const response = await fetch(URL + path, { method, headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined, body: method === 'POST' ? '{}' : undefined });
	return `${response.status} ${await response.text()}`;
};

let next = 0;
let mismatches = 0;
const examples = [];
await Promise.all(
	Array.from({ length: 16 }, async () => {
		while (next < checks.length) {
			const check = checks[next++];
			const [cached, fresh] = await Promise.all([text(check.cached), text(check.fresh)]);
			if (cached !== fresh) {
				mismatches++;
				if (examples.length < 10) examples.push(check.cached.join(' '));
			}
		}
	})
);
console.log(`coherence audit: ${checks.length - mismatches}/${checks.length} cached responses identical to the source of truth (${products.length} products x 16 views: ${writtenPicked.length} of the ${source}, ${unwritten.length} not written; the ${carts.length} hottest carts' quotes)`);
for (const example of examples) console.log(`  STALE: ${example}`);
process.exit(mismatches ? 1 : 0);
