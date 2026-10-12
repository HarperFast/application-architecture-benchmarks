/**
 * Hand-computed cases for the pricing engine, one per rule in SPEC.md "Promotion evaluation
 * order". These are independent of any implementation's output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBasisPoints, evaluatePromotions, mergeLines, resolveShipping, resolveTax, resolveUnitPrice } from '../src/pricing.js';

const promo = (id, kind, extra = {}) => ({
	id, kind, tiers: [], skus: [], categoryIds: [], thresholdMinor: 0, amountMinor: 0, amountBasisPoints: 0, ...extra,
});
const line = (sku, quantity, unitPrice, categoryIds = ['c']) => ({ sku, quantity, unitPrice, categoryIds });
const run = (lines, promotions, tier = 'standard') => {
	const out = evaluatePromotions({ lines, promotions, tier });
	return { ...out, applied: Object.fromEntries(out.applied) };
};

test('tier pricing rounds half up, unknown tier is standard', () => {
	assert.equal(resolveUnitPrice(1000, 'silver'), 950);
	assert.equal(resolveUnitPrice(1001, 'gold'), 901); // 900.9 -> 901
	assert.equal(resolveUnitPrice(1005, 'platinum'), 854); // 854.25 -> 854
	assert.equal(resolveUnitPrice(1010, 'platinum'), 859); // 858.5 -> 859 (half up)
	assert.equal(resolveUnitPrice(1234, 'diamond'), 1234);
	assert.equal(resolveUnitPrice(1234, 'constructor'), 1234); // not an inherited property
	assert.equal(applyBasisPoints(5, 1000), 1); // 0.5 -> 1
});

test('lines merge by sku, keeping first-occurrence order', () => {
	assert.deepEqual(mergeLines([{ sku: 'b', quantity: 1 }, { sku: 'a', quantity: 2 }, { sku: 'b', quantity: 3 }]), [
		{ sku: 'b', quantity: 4 },
		{ sku: 'a', quantity: 2 },
	]);
});

test('unrestricted promotions are eligible; restricted ones respect tier, sku and category', () => {
	const r = run(
		[line('a', 1, 1000, ['shoes']), line('b', 1, 1000, ['hats'])],
		[
			promo('p1', 'stackable', { amountBasisPoints: 1000 }), // everything
			promo('p2', 'stackable', { amountBasisPoints: 1000, tiers: ['gold'] }), // wrong tier
			promo('p3', 'stackable', { amountBasisPoints: 1000, categoryIds: ['hats'] }),
			promo('p4', 'stackable', { amountBasisPoints: 1000, skus: ['a'] }),
		]
	);
	assert.deepEqual(r.applied, { a: ['p1', 'p4'], b: ['p1', 'p3'] });
	// a: 1000 -100 = 900, -90 = 810; b: 1000 -100 = 900, -90 = 810.
	assert.equal(r.discountTotal, 380);
});

test('an applicable exclusive excludes everything else; highest value wins, ties on lower id', () => {
	const r = run(
		[line('a', 1, 10000), line('b', 1, 10000)],
		[
			promo('x1', 'exclusive', { amountMinor: 500 }),
			promo('x2', 'exclusive', { amountBasisPoints: 1000 }), // 2000 on a 20000 subtotal
			promo('x3', 'exclusive', { amountMinor: 2000 }), // ties x2, loses on id
			promo('s1', 'stackable', { amountBasisPoints: 5000 }),
		]
	);
	assert.equal(r.discountTotal, 2000);
	assert.deepEqual(r.applied, { a: ['x2'], b: ['x2'] });
});

test('an exclusive gated by its threshold does not apply, and the others do', () => {
	const r = run([line('a', 1, 1000)], [promo('x1', 'exclusive', { amountMinor: 500, thresholdMinor: 5000 }), promo('t1', 'threshold', { amountMinor: 100, thresholdMinor: 1000 })]);
	assert.equal(r.discountTotal, 100);
	assert.deepEqual(r.applied, { a: ['t1'] });
});

test('cart-wide discounts allocate by largest remainder, ties on ascending sku', () => {
	// 100 across remaining amounts 1, 1, 1 (pool 3): 33 each, then 1 to the lowest sku.
	const r = run([line('c', 1, 1), line('a', 1, 1), line('b', 1, 1)], [promo('t1', 'threshold', { amountMinor: 1 })]);
	// subtotal 3, cap floor(1.8) = 1, so only 1 can be drawn: shares 0.333 each, remainder tie -> 'a'.
	assert.equal(r.discountTotal, 1);
	assert.deepEqual(r.applied, { c: [], a: ['t1'], b: [] });
});

test('threshold applies once against the pre-discount subtotal', () => {
	const r = run(
		[line('a', 1, 6000), line('b', 1, 4000)],
		[promo('t1', 'threshold', { amountBasisPoints: 1000, thresholdMinor: 10000 }), promo('t2', 'threshold', { amountMinor: 1000, thresholdMinor: 10001 })]
	);
	// t1: 10% of 10000 = 1000, split 600/400. t2 not met.
	assert.equal(r.discountTotal, 1000);
	assert.deepEqual(r.applied, { a: ['t1'], b: ['t1'] });
});

test('BOGO discounts the single lowest-priced qualifying unit, once', () => {
	const r = run(
		[line('a', 2, 3000), line('b', 3, 1000), line('c', 1, 500)],
		[promo('g1', 'bogo', { amountBasisPoints: 10000 })]
	);
	// c has quantity 1 and does not qualify; b is the cheapest qualifying unit.
	assert.equal(r.discountTotal, 1000);
	assert.deepEqual(r.applied, { a: [], b: ['g1'], c: [] });
});

test('stackables compound on the remaining amount, at most three per line in id order', () => {
	const r = run(
		[line('a', 1, 10000)],
		[
			promo('s1', 'stackable', { amountBasisPoints: 1000 }),
			promo('s2', 'stackable', { amountBasisPoints: 1000 }),
			promo('s3', 'stackable', { amountBasisPoints: 1000 }),
			promo('s4', 'stackable', { amountBasisPoints: 1000 }),
		]
	);
	// 10000 -> 9000 -> 8100 -> 7290; s4 exceeds the per-line limit.
	assert.equal(r.discountTotal, 2710);
	assert.deepEqual(r.applied, { a: ['s1', 's2', 's3'] });
});

test('the 60% cap is a running bound: the crossing discount is partial, later ones are not attributed', () => {
	const r = run(
		[line('a', 1, 1001)],
		[promo('t1', 'threshold', { amountBasisPoints: 5000 }), promo('s1', 'stackable', { amountBasisPoints: 5000 }), promo('s2', 'stackable', { amountMinor: 1 })]
	);
	// cap floor(600.6) = 600. t1: 501 (half up of 500.5). s1: 50% of 500 = 250, partial to 99. s2: nothing left.
	assert.equal(r.discountTotal, 600);
	assert.deepEqual(r.applied, { a: ['t1', 's1'] });
});

test('a non-zero thresholdMinor gates every kind, BOGO included', () => {
	const r = run([line('a', 2, 1000)], [promo('g1', 'bogo', { amountBasisPoints: 10000, thresholdMinor: 2001 })]);
	assert.equal(r.discountTotal, 0);
});

test('shipping needs exactly one band; tax applies to the post-discount amount', () => {
	const rates = [
		{ id: 's0', kind: 'shipping', region: 'r', weightMin: 0, weightMax: 1000, amountMinor: 499 },
		{ id: 's1', kind: 'shipping', region: 'r', weightMin: 1001, weightMax: 5000, amountMinor: 899 },
		{ id: 't', kind: 'tax', jurisdiction: 'j', basisPoints: 888 },
	];
	assert.equal(resolveShipping(rates, 'r', 1000), 499);
	assert.equal(resolveShipping(rates, 'r', 1001), 899);
	assert.throws(() => resolveShipping(rates, 'r', 5001));
	assert.throws(() => resolveShipping(rates, 'nowhere', 10));
	assert.equal(resolveTax(rates, 'j', 1074), 95); // 95.37 -> 95
	assert.throws(() => resolveTax(rates, 'nowhere', 10));
});
