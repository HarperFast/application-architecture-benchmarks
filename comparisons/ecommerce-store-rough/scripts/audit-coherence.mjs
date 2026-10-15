/**
 * Cache-coherence audit for the Fastify + Postgres + Redis target, run after a measurement once
 * the write stream has stopped.
 *
 * The harness counts every 2xx as success, so a stale cache would pass a run silently. This
 * compares, byte for byte, what the cached endpoints answer against the app's /__audit routes,
 * which compute the same response from Postgres alone (no entity cache, no aggregate cache). Any
 * difference is a value the caches failed to invalidate (CACHE-001, CACHE-002).
 *
 * Covers the hot set the workload actually wrote to: the first products and carts by the
 * workload's skewed index, plus a stride across the rest.
 *
 *   node audit-coherence.mjs --url http://localhost:39926 --dataset <dev dir>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};
const URL = argOf('url');
const DATASET = argOf('dataset');
const TIERS = ['standard', 'silver', 'gold', 'platinum'];
const REGIONS = ['us-east', 'us-west', 'eu-central', 'apac'];

const ids = (table, field) =>
	readFileSync(join(DATASET, `${table}.ndjson`), 'utf8').trim().split('\n').map((line) => JSON.parse(line)[field]);
const pick = (all, head, stride) => [...new Set([...all.slice(0, head), ...all.filter((_, i) => i % stride === 0)])];

const products = pick(ids('product', 'id'), 200, 10);
const carts = pick(ids('cart', 'id'), 300, 5);

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
console.log(`coherence audit: ${checks.length - mismatches}/${checks.length} cached responses identical to the source of truth (${products.length} products x 16 views, ${carts.length} quotes)`);
for (const example of examples) console.log(`  STALE: ${example}`);
process.exit(mismatches ? 1 : 0);
