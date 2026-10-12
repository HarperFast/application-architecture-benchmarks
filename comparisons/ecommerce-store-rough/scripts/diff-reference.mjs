/**
 * Differential correctness check: every quote and product aggregate from two implementations,
 * compared response by response against the same freshly loaded dataset.
 *
 * Neither side is ground truth. The ecommerce-store plan still lacks independently computed
 * expected values, so agreement between two independent implementations (this stack's pricing is
 * written from SPEC.md, not copied) is the strongest available evidence, and every disagreement is
 * investigated against SPEC.md rather than resolved in the reference's favour.
 *
 * Responses are compared as JSON values with object keys canonicalized (key order is not part of
 * the cross-implementation contract; QUOTE-008 byte identity is per implementation). Array order
 * is compared as is.
 *
 *   node diff-reference.mjs --a http://localhost:39936 --b http://localhost:39926 --dataset <dev dir> --out diff.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};
const A = argOf('a');
const B = argOf('b');
const DATASET = argOf('dataset');
const OUT = argOf('out');
const CONCURRENCY = Number(argOf('concurrency', '16'));
const TIERS = ['standard', 'silver', 'gold', 'platinum', 'unlisted-tier'];
const REGIONS = ['us-east', 'us-west', 'eu-central', 'apac'];

const ids = (table, field) =>
	readFileSync(join(DATASET, `${table}.ndjson`), 'utf8').trim().split('\n').map((line) => JSON.parse(line)[field]);

const canonical = (value) => {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
	return value;
};

async function call(base, req) {
	const response = await fetch(base + req.path, {
		method: req.method,
		headers: req.method === 'POST' ? { 'content-type': 'application/json' } : undefined,
		body: req.method === 'POST' ? '{}' : undefined,
	});
	const text = await response.text();
	let body = null;
	try {
		body = JSON.parse(text);
	} catch {}
	return { status: response.status, body };
}

/** Where two JSON values first differ, as a path, for the report. */
function firstDifference(a, b, path = '$') {
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return `${path}.length ${a.length} != ${b.length}`;
		for (let i = 0; i < a.length; i++) {
			const d = firstDifference(a[i], b[i], `${path}[${i}]`);
			if (d) return d;
		}
		return null;
	}
	if (a && b && typeof a === 'object' && typeof b === 'object') {
		const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
		for (const k of [...keys].sort()) {
			const d = firstDifference(a[k], b[k], `${path}.${k}`);
			if (d) return d;
		}
		return null;
	}
	return a === b ? null : `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
}

const requests = [];
for (const id of ids('cart', 'id')) requests.push({ kind: 'quote', method: 'POST', path: `/cart/${id}/quote` });
for (const id of ids('product', 'id')) {
	for (const tier of TIERS) for (const region of REGIONS) requests.push({ kind: 'product', method: 'GET', path: `/product/${id}?tier=${tier}&region=${region}` });
}
requests.push({ kind: 'quote', method: 'POST', path: '/cart/no-such-cart/quote' });
requests.push({ kind: 'product', method: 'GET', path: '/product/no-such-product?tier=standard&region=us-east' });

const result = { a: A, b: B, compared: 0, equal: 0, statusMismatch: 0, bodyMismatch: 0, byKind: {}, examples: [] };
let next = 0;
async function worker() {
	while (next < requests.length) {
		const req = requests[next++];
		const [ra, rb] = await Promise.all([call(A, req), call(B, req)]);
		const kind = (result.byKind[req.kind] ??= { compared: 0, equal: 0, mismatched: 0 });
		result.compared++;
		kind.compared++;
		let difference = null;
		if (ra.status !== rb.status) {
			result.statusMismatch++;
			difference = `status ${ra.status} != ${rb.status}`;
		} else if (ra.status === 200) {
			difference = firstDifference(canonical(ra.body), canonical(rb.body));
			if (difference) result.bodyMismatch++;
		}
		if (difference) {
			kind.mismatched++;
			if (result.examples.length < 50) result.examples.push({ request: `${req.method} ${req.path}`, difference });
		} else {
			result.equal++;
			kind.equal++;
		}
		if (result.compared % 5000 === 0) process.stderr.write(`  ${result.compared}/${requests.length}\n`);
	}
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(`compared ${result.compared}: ${result.equal} equal, ${result.statusMismatch} status mismatches, ${result.bodyMismatch} body mismatches`);
for (const [kind, k] of Object.entries(result.byKind)) console.log(`  ${kind}: ${k.equal}/${k.compared} equal`);
for (const ex of result.examples.slice(0, 15)) console.log(`  ${ex.request}\n    ${ex.difference}`);
process.exit(result.statusMismatch + result.bodyMismatch === 0 ? 0 : 1);
