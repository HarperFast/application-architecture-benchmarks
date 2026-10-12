/**
 * The pricing engine: SPEC.md "Resolved unit price" and "Promotion evaluation order".
 *
 * Written from SPEC.md, not copied from the Harper reference. The ecommerce-store plan asks
 * every stack to compare against the same answers without sharing pricing code, so this is an
 * independent implementation; agreement with the reference is checked by a differential run
 * (comparisons/ecommerce-store-rough/scripts/diff-reference.mjs), not assumed.
 *
 * Pure: no I/O, no clock, no randomness. All money is integer minor units and every
 * arithmetic step is exact integer arithmetic within Number.MAX_SAFE_INTEGER (DATA-002).
 */

/** SPEC.md "Resolved unit price". A tier absent from this table resolves as `standard`. */
export const TIER_BASIS_POINTS = Object.freeze({ standard: 10000, silver: 9500, gold: 9000, platinum: 8500 });

/** SPEC.md step 8. */
export const MAX_STACKABLE_PER_LINE = 3;
/** SPEC.md step 9: discountTotal never exceeds 60% of the subtotal, floored. */
export const MAX_DISCOUNT_BASIS_POINTS = 6000;

/** Guard the one place integer arithmetic could leave the exact range. */
function assertSafe(value, what) {
	if (!Number.isSafeInteger(value)) throw new RangeError(`${what} is outside the exact integer range: ${value}`);
	return value;
}

/** `round_half_up(amount * basisPoints / 10000)` for non-negative integers, exactly. */
export function applyBasisPoints(amount, basisPoints) {
	const scaled = assertSafe(amount * basisPoints + 5000, 'amount x basis points');
	return (scaled - (scaled % 10000)) / 10000;
}

/** `floor(amount * basisPoints / 10000)`, exactly. Used for the cap, which must never round up. */
function floorBasisPoints(amount, basisPoints) {
	const scaled = assertSafe(amount * basisPoints, 'amount x basis points');
	return (scaled - (scaled % 10000)) / 10000;
}

export function resolveUnitPrice(basePrice, tier) {
	const basisPoints = Object.hasOwn(TIER_BASIS_POINTS, tier) ? TIER_BASIS_POINTS[tier] : TIER_BASIS_POINTS.standard;
	return applyBasisPoints(basePrice, basisPoints);
}

/** An empty eligibility array means the promotion is unrestricted on that dimension. */
export function isEligible(promotion, tier, sku, categoryIds) {
	if (promotion.tiers.length && !promotion.tiers.includes(tier)) return false;
	if (promotion.skus.length && !promotion.skus.includes(sku)) return false;
	if (promotion.categoryIds.length && !promotion.categoryIds.some((c) => categoryIds.includes(c))) return false;
	return true;
}

/** The promotion's amount against `base`: basis points when set, otherwise a fixed amount capped at `base`. */
function discountFor(promotion, base) {
	if (promotion.amountBasisPoints) return applyBasisPoints(base, promotion.amountBasisPoints);
	return Math.min(promotion.amountMinor ?? 0, base);
}

const bySku = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Merge cart lines by SKU (SPEC.md: "Merge cart lines by SKU before evaluation"), keeping
 * first-occurrence order so the response itemizes lines in cart order.
 */
export function mergeLines(lines) {
	const merged = new Map();
	for (const line of lines) {
		const existing = merged.get(line.sku);
		if (existing) existing.quantity += line.quantity;
		else merged.set(line.sku, { sku: line.sku, quantity: line.quantity });
	}
	return [...merged.values()];
}

/**
 * Evaluate promotions in the normative order.
 *
 * @param {object} input
 * @param {{sku: string, quantity: number, unitPrice: number, categoryIds: string[]}[]} input.lines merged lines
 * @param {object[]} input.promotions candidate promotions (a superset of the eligible set is fine)
 * @param {string} input.tier the customer's tier
 * @returns {{subtotal: number, discountTotal: number, applied: Map<string, string[]>}}
 */
export function evaluatePromotions({ lines, promotions, tier }) {
	const gross = new Map();
	const remaining = new Map();
	const applied = new Map();
	const lineBySku = new Map();
	let subtotal = 0;
	for (const line of lines) {
		const amount = assertSafe(line.unitPrice * line.quantity, 'line amount');
		gross.set(line.sku, amount);
		remaining.set(line.sku, amount);
		applied.set(line.sku, []);
		lineBySku.set(line.sku, line);
		subtotal += amount;
	}
	assertSafe(subtotal, 'subtotal');

	// Step 9: a running cap. Every draw is bounded by the headroom left at that moment.
	const ceiling = floorBasisPoints(subtotal, MAX_DISCOUNT_BASIS_POINTS);
	let spent = 0;

	/**
	 * Draw `amount` down across `skus` in proportion to what each still has left: largest
	 * remainder, ties on ascending SKU. Remainders are compared as exact integers
	 * (`remaining * budget mod pool`), never as floating-point fractions. Returns the SKUs that
	 * actually received a non-zero share, which are the lines the promotion is attributed to.
	 */
	const drawDown = (skus, amount) => {
		const eligible = skus.filter((sku) => remaining.get(sku) > 0);
		let pool = 0;
		for (const sku of eligible) pool += remaining.get(sku);
		const budget = Math.min(amount, pool, ceiling - spent);
		if (budget <= 0) return [];
		const shares = eligible.map((sku) => {
			const scaled = assertSafe(remaining.get(sku) * budget, 'allocation');
			const remainder = scaled % pool;
			return { sku, whole: (scaled - remainder) / pool, remainder };
		});
		let allocated = 0;
		for (const share of shares) allocated += share.whole;
		const order = [...shares].sort((a, b) => b.remainder - a.remainder || bySku(a.sku, b.sku));
		for (const share of order) {
			if (allocated >= budget) break;
			if (share.whole + 1 > remaining.get(share.sku)) continue;
			share.whole++;
			allocated++;
		}
		const touched = [];
		for (const share of shares) {
			if (share.whole <= 0) continue;
			remaining.set(share.sku, remaining.get(share.sku) - share.whole);
			spent += share.whole;
			touched.push(share.sku);
		}
		return touched;
	};

	const attribute = (promotion, skus) => {
		for (const sku of skus) applied.get(sku).push(promotion.id);
	};

	// Step 6: a non-zero thresholdMinor gates every kind against the PRE-discount subtotal.
	const meetsThreshold = (promotion) => subtotal >= (promotion.thresholdMinor ?? 0);

	// Step 1: collect eligibility per promotion, one entry per promotion, SKUs ascending.
	// Step 7: ties at any step break on ascending promotion id, so evaluate in id order.
	const sortedSkus = [...gross.keys()].sort(bySku);
	const byKind = { exclusive: [], threshold: [], bogo: [], stackable: [] };
	for (const promotion of [...promotions].sort(byId)) {
		const skus = sortedSkus.filter((sku) => isEligible(promotion, tier, sku, lineBySku.get(sku).categoryIds));
		if (skus.length && byKind[promotion.kind]) byKind[promotion.kind].push({ promotion, skus });
	}

	// Step 2: exclusive. Highest value against the subtotal wins (ties: lower id); if it
	// applies, nothing else does.
	let best = null;
	let bestValue = 0;
	for (const entry of byKind.exclusive) {
		if (!meetsThreshold(entry.promotion)) continue;
		const value = discountFor(entry.promotion, subtotal);
		if (value > bestValue) {
			best = entry;
			bestValue = value;
		}
	}
	if (best) {
		const touched = drawDown(best.skus, bestValue);
		if (touched.length) {
			attribute(best.promotion, touched);
			return { subtotal, discountTotal: spent, applied };
		}
	}

	// Step 3: threshold. Cart-wide, once each, against the pre-discount subtotal.
	for (const entry of byKind.threshold) {
		if (!meetsThreshold(entry.promotion)) continue;
		const touched = drawDown(entry.skus, discountFor(entry.promotion, subtotal));
		if (touched.length) attribute(entry.promotion, touched);
	}

	// Step 4: BOGO. Once each, to the single lowest-priced qualifying unit (quantity >= 2 and
	// a non-zero remaining amount), ties on ascending SKU.
	for (const entry of byKind.bogo) {
		if (!meetsThreshold(entry.promotion)) continue;
		let target = null;
		for (const sku of entry.skus) {
			const line = lineBySku.get(sku);
			if (line.quantity < 2 || remaining.get(sku) <= 0) continue;
			if (!target || line.unitPrice < target.unitPrice) target = line; // skus ascend, so ties keep the lower sku
		}
		if (!target) continue;
		const touched = drawDown([target.sku], discountFor(entry.promotion, target.unitPrice));
		if (touched.length) attribute(entry.promotion, touched);
	}

	// Step 5 and 8: stackable. Once per eligible line against that line's REMAINING amount,
	// so percentages compound; at most three per line, in ascending promotion id.
	const stacked = new Map();
	for (const entry of byKind.stackable) {
		if (!meetsThreshold(entry.promotion)) continue;
		const touched = [];
		for (const sku of entry.skus) {
			const count = stacked.get(sku) ?? 0;
			if (count >= MAX_STACKABLE_PER_LINE) continue;
			const left = remaining.get(sku);
			if (left <= 0) continue;
			if (!drawDown([sku], discountFor(entry.promotion, left)).length) continue;
			stacked.set(sku, count + 1);
			touched.push(sku);
		}
		if (touched.length) attribute(entry.promotion, touched);
	}

	return { subtotal, discountTotal: spent, applied };
}

/**
 * Shipping: the band for the region whose inclusive [weightMin, weightMax] contains the total
 * weight. SPEC.md: exactly one band matches; zero or several is invalid data and fails loudly.
 */
export function resolveShipping(rates, region, totalWeight) {
	let match = null;
	for (const rate of rates) {
		if (rate.kind !== 'shipping' || rate.region !== region) continue;
		if (totalWeight < rate.weightMin || totalWeight > rate.weightMax) continue;
		if (match) throw new Error(`invalid rate data: several shipping bands match ${region} at ${totalWeight}`);
		match = rate;
	}
	if (!match) throw new Error(`invalid rate data: no shipping band matches ${region} at ${totalWeight}`);
	return match.amountMinor;
}

/** Tax: exactly one rate per jurisdiction, applied to the post-discount subtotal (QUOTE-007). */
export function resolveTax(rates, jurisdiction, taxable) {
	let match = null;
	for (const rate of rates) {
		if (rate.kind !== 'tax' || rate.jurisdiction !== jurisdiction) continue;
		if (match) throw new Error(`invalid rate data: several tax rates for ${jurisdiction}`);
		match = rate;
	}
	if (!match) throw new Error(`invalid rate data: no tax rate for ${jurisdiction}`);
	return applyBasisPoints(Math.max(0, taxable), match.basisPoints);
}
