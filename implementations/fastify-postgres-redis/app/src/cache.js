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
 * unique token on a generation alongside the delete, and a fill reads the generation BEFORE it
 * reads Postgres (in the same round trip as the cached values).
 *
 *   - Entities: the fill stores only if the generation is unchanged (Lua compare-and-set).
 *   - Product aggregates: the generations a view was built under are stored WITH it, and a read
 *     serves the view only if they still match the current ones (fetched in the same round trip).
 *     Validity is checked against per-product (price) and per-product-region (inventory)
 *     generations, so it does not depend on the write surface deleting every key it affected.
 *
 * A generation must not disappear while a value it guards can still be served: a fill that read
 * an absent generation stamps itself with the empty string, which would match again once the
 * write's token was gone. So generations are FIELDS of one hash per kind,
 *
 *   g:<type>  field <id>                       entity generations (only variants are written)
 *   g:pdp     fields <product>, <product>:<region>   aggregate generations (price, inventory)
 *
 * each field with its own expiry (HSETEX) and the hash key itself with none, under
 * `maxmemory-policy volatile-lru` (redis.conf): every cached value carries a TTL and is evictable,
 * while the generation hashes and the stats:cache counters are never evicted. A generation
 * field lives GEN_TTL, longer than any cached value (GEN_TTL > VIEW_TTL, ENTITY_TTL, and many
 * times the Postgres statement timeout that bounds a fill), and tokens are unique, so expiry of
 * a generation can only cause a miss or a discarded fill, never a stale value served.
 */
import { randomUUID } from 'node:crypto';
import { createClient, defineScript } from 'redis';
import { config } from './config.js';

const COND_SET = defineScript({
	// KEYS: genHash, key1, key2, ...   ARGV: ttlMs, field1, expectedGen1, value1, field2, expectedGen2, value2, ...
	SCRIPT: `
local stored = 0
for i = 2, #KEYS do
  local a = 3 * i - 4
  local current = redis.call('HGET', KEYS[1], ARGV[a]) or ''
  if current == ARGV[a + 1] then
    redis.call('SET', KEYS[i], ARGV[a + 2], 'PX', ARGV[1])
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
	/** The hash holding every generation of one entity type, one field per id. */
	entityGens: (type) => `g:${type}`,
	/** [hash, field] of one entity's generation. */
	entityGen: (type, id) => [`g:${type}`, id],
	/** CACHE-003 / PDP-002: every dimension the aggregate varies by is in the key. */
	view: (productId, tier, region) => `pdp:${productId}:${tier}:${region}`,
	viewGens: 'g:pdp',
	/** Bumped by a price write: price is in every tier x region view of the product. */
	productGen: (productId) => ['g:pdp', productId],
	/** Bumped by an inventory write: availability is in the views for that one region. */
	regionGen: (productId, region) => ['g:pdp', `${productId}:${region}`],
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
	// One round trip: node-redis writes commands issued in the same tick together. The
	// generations are read BEFORE Postgres; see the module comment.
	const [cached, gens] = await Promise.all([
		redis.mGet(unique.map((id) => keys.entity(type, id))),
		redis.hmGet(keys.entityGens(type), unique),
	]);
	const misses = [];
	for (let i = 0; i < unique.length; i++) {
		if (cached[i] === null) misses.push(i);
		else found.set(unique[i], JSON.parse(cached[i]));
	}
	counters.add(`${type}.hit`, unique.length - misses.length);
	if (!misses.length) return found;
	counters.add(`${type}.miss`, misses.length);

	const loaded = await load(misses.map((i) => unique[i]));
	const fillKeys = [keys.entityGens(type)];
	const fillArgs = [String(config.entityTtlMs)];
	for (const i of misses) {
		const entity = loaded.get(unique[i]);
		if (!entity) continue;
		found.set(unique[i], entity);
		fillKeys.push(keys.entity(type, unique[i]));
		fillArgs.push(unique[i], gens[i] ?? '', JSON.stringify(entity));
	}
	// Not awaited: the response does not depend on the fill landing, and a fill that lost a race
	// with a write is correctly discarded by the script.
	if (fillKeys.length > 1) redis.condSet(fillKeys, fillArgs).catch((error) => console.error('entity fill failed', error.message));
	return found;
}

/**
 * Product aggregate lookup, one round trip: the cached view and the two generations it must
 * have been built under. Returns the serialized JSON on a valid hit, else null, plus the
 * current generations for a fill to record.
 */
export async function getView(redis, productId, tier, region) {
	const [value, [productGen, regionGen]] = await Promise.all([
		redis.get(keys.view(productId, tier, region)),
		redis.hmGet(keys.viewGens, [keys.productGen(productId)[1], keys.regionGen(productId, region)[1]]),
	]);
	const stamp = `${productGen ?? ''}|${regionGen ?? ''}|`;
	if (value !== null && value.startsWith(stamp)) return { json: value.slice(stamp.length), stamp };
	return { json: null, stamp };
}

/**
 * Store a freshly assembled view under the generations read before it was assembled. The caller
 * need not wait for it: a view stored after a write is stamped with the old generations and is
 * never served.
 */
export function storeView(redis, productId, tier, region, stamp, json) {
	return redis.set(keys.view(productId, tier, region), stamp + json, { expiration: { type: 'PX', value: config.viewTtlMs } });
}

/**
 * Invalidate atomically: set a fresh unique token on each generation ([hash, field] pairs) and
 * delete the cached keys, in one MULTI/EXEC. Resolves once Redis has applied it, so the write
 * surface can respond only after its invalidation is visible.
 */
export async function invalidate(redis, gens, cacheKeys) {
	const token = randomUUID();
	const multi = redis.multi();
	for (const [hash, field] of gens) multi.hSetEx(hash, { [field]: token }, { expiration: { type: 'PX', value: config.genTtlMs } });
	if (cacheKeys.length) multi.del(cacheKeys);
	await multi.exec();
}
