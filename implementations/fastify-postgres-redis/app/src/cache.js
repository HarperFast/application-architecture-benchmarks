/**
 * Redis: derived caches only (CACHE-001). Nothing here is authoritative; FLUSHALL changes
 * latency, never a response.
 *
 * Two caches share one Redis:
 *
 *   e:<type>:<id>                  entity cache (cart, customer, product, variant), cache-aside
 *   pdp:<product>:<tier>:<region>  the resolved product aggregate, serialized once
 *
 * Freshness (CACHE-002) comes from EXPLICIT INVALIDATION ON WRITE: the write surface commits to
 * Postgres and then, before it responds, invalidates in one MULTI/EXEC every key the write can
 * have changed. Expiry is a memory-bounding backstop, not the freshness mechanism.
 *
 * Plain cache-aside has a well-known race: a reader misses, reads the OLD row, the writer
 * commits and deletes the key, then the reader stores the old row, which survives until expiry,
 * far longer than FRESH_MS. Both caches therefore carry GENERATIONS: a write sets a fresh,
 * unique token on a generation key alongside the delete, and a fill reads the generation BEFORE
 * it reads Postgres.
 *
 *   - Entities: the fill stores only if the generation is unchanged (Lua compare-and-set).
 *   - Product aggregates: the generations a view was built under are stored WITH it, and a read
 *     serves the view only if they still match the current ones (fetched in the same MGET). This
 *     also covers keys a write cannot enumerate: a view cached under a tier or region outside the
 *     dataset's vocabulary is still invalidated, because validity is checked against
 *     per-product (price) and per-product-region (inventory) generations, not by key deletion.
 *
 * Generation keys outlive every cached value (GEN_TTL > VIEW_TTL, ENTITY_TTL, and many times the
 * Postgres statement timeout that bounds a fill), and tokens are unique, so expiry or eviction of
 * a generation key can only cause a miss or a discarded fill, never a stale value served.
 */
import { randomUUID } from 'node:crypto';
import { createClient, defineScript } from 'redis';
import { config } from './config.js';

const COND_SET = defineScript({
	// KEYS: key1, gen1, key2, gen2, ...   ARGV: ttlMs, expectedGen1, value1, expectedGen2, value2, ...
	SCRIPT: `
local stored = 0
for i = 1, #KEYS, 2 do
  local current = redis.call('GET', KEYS[i + 1]) or ''
  if current == ARGV[i + 1] then
    redis.call('SET', KEYS[i], ARGV[i + 2], 'PX', ARGV[1])
    stored = stored + 1
  end
end
return stored`,
	parseCommand(parser, keys, args) {
		parser.pushKeysLength(keys);
		for (const arg of args) parser.push(arg);
	},
	transformReply: undefined,
});

export const keys = {
	entity: (type, id) => `e:${type}:${id}`,
	entityGen: (type, id) => `g:${type}:${id}`,
	/** CACHE-003 / PDP-002: every dimension the aggregate varies by is in the key. */
	view: (productId, tier, region) => `pdp:${productId}:${tier}:${region}`,
	/** Bumped by a price write: price is in every tier x region view of the product. */
	productGen: (productId) => `g:pdp:${productId}`,
	/** Bumped by an inventory write: availability is in the views for that one region. */
	regionGen: (productId, region) => `g:pdp:${productId}:${region}`,
};

export async function createRedis() {
	const client = createClient({
		url: config.redisUrl,
		scripts: { condSet: COND_SET },
		socket: { noDelay: true, keepAlive: true },
	});
	client.on('error', (error) => console.error('redis client error', error.message));
	await client.connect();
	return client;
}

/**
 * Cache counters, per worker, flushed to a Redis hash once a second so a run can read measured
 * hit rates (OBS-002, WRITE-003) across all workers without IPC.
 */
export function createCounters(redis) {
	const counts = new Map();
	const add = (field, n = 1) => {
		if (n) counts.set(field, (counts.get(field) ?? 0) + n);
	};
	const flush = async () => {
		if (!counts.size) return;
		const batch = [...counts];
		counts.clear();
		const multi = redis.multi();
		for (const [field, n] of batch) multi.hIncrBy('stats:cache', field, n);
		await multi.exec();
	};
	const timer = setInterval(() => flush().catch(() => {}), 1000);
	timer.unref();
	return { add, flush, stop: () => clearInterval(timer) };
}

/**
 * Read-through for entities. `load(ids)` reads Postgres and returns Map<id, entity>. Returns
 * Map<id, entity> for the ids that exist; unknown ids are absent (and never cached).
 */
export async function getEntities(redis, counters, type, ids, load) {
	const unique = ids.length === 1 ? ids : [...new Set(ids)];
	const found = new Map();
	if (!unique.length) return found;
	const cached = await redis.mGet(unique.map((id) => keys.entity(type, id)));
	const misses = [];
	for (let i = 0; i < unique.length; i++) {
		if (cached[i] === null) misses.push(unique[i]);
		else found.set(unique[i], JSON.parse(cached[i]));
	}
	counters.add(`${type}.hit`, unique.length - misses.length);
	if (!misses.length) return found;
	counters.add(`${type}.miss`, misses.length);

	// Generations are read BEFORE Postgres; see the module comment.
	const gens = await redis.mGet(misses.map((id) => keys.entityGen(type, id)));
	const loaded = await load(misses);
	const fillKeys = [];
	const fillArgs = [String(config.entityTtlMs)];
	for (let i = 0; i < misses.length; i++) {
		const entity = loaded.get(misses[i]);
		if (!entity) continue;
		found.set(misses[i], entity);
		fillKeys.push(keys.entity(type, misses[i]), keys.entityGen(type, misses[i]));
		fillArgs.push(gens[i] ?? '', JSON.stringify(entity));
	}
	// Not awaited: the response does not depend on the fill landing, and a fill that lost a race
	// with a write is correctly discarded by the script.
	if (fillKeys.length) redis.condSet(fillKeys, fillArgs).catch((error) => console.error('entity fill failed', error.message));
	return found;
}

/**
 * Product aggregate lookup, one round trip: the cached view and the two generations it must
 * have been built under. Returns the serialized JSON on a valid hit, else null, plus the
 * current generations for a fill to record.
 */
export async function getView(redis, productId, tier, region) {
	const [value, productGen, regionGen] = await redis.mGet([
		keys.view(productId, tier, region),
		keys.productGen(productId),
		keys.regionGen(productId, region),
	]);
	const stamp = `${productGen ?? ''}|${regionGen ?? ''}|`;
	if (value !== null && value.startsWith(stamp)) return { json: value.slice(stamp.length), stamp };
	return { json: null, stamp };
}

/** Store a freshly assembled view under the generations read before it was assembled. */
export function storeView(redis, productId, tier, region, stamp, json) {
	return redis.set(keys.view(productId, tier, region), stamp + json, { expiration: { type: 'PX', value: config.viewTtlMs } });
}

/**
 * Invalidate atomically: set a fresh unique token on each generation key and delete the cached
 * keys, in one MULTI/EXEC. Resolves once Redis has applied it, so the write surface can respond
 * only after its invalidation is visible.
 */
export async function invalidate(redis, genKeys, cacheKeys) {
	const token = randomUUID();
	const multi = redis.multi();
	for (const key of genKeys) multi.set(key, token, { expiration: { type: 'PX', value: config.genTtlMs } });
	if (cacheKeys.length) multi.del(cacheKeys);
	await multi.exec();
}
