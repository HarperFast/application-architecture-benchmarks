/**
 * Runtime configuration, from the environment. Every value that changes a measurement is
 * logged at startup and exposed on GET /__meta so a run record can carry it.
 */
const int = (name, fallback) => {
	const raw = process.env[name];
	if (raw === undefined || raw === '') return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value)) throw new Error(`${name} must be an integer, got ${raw}`);
	return value;
};

export const config = Object.freeze({
	port: int('PORT', 3000),
	host: process.env.HOST ?? '0.0.0.0',
	/** HTTP worker processes (node:cluster). Sized to the app container's CPU share. */
	workers: int('WORKERS', 2),
	databaseUrl: process.env.DATABASE_URL ?? 'postgres://store:store@localhost:5432/store',
	/** Connections per worker. Total across workers must stay under Postgres max_connections. */
	pgPoolMax: int('PG_POOL_MAX', 8),
	/** Bounds a fill, which in turn bounds the invalidation-race window (see cache.js). */
	pgStatementTimeoutMs: int('PG_STATEMENT_TIMEOUT_MS', 5000),
	redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
	/** SPEC.md FRESH_MS, recorded with the configuration. Freshness itself comes from invalidation. */
	freshMs: int('FRESH_MS', 1000),
	/** Product aggregate expiry backstop. Matches the reference's ProductView expiration (120 s). */
	viewTtlMs: int('VIEW_TTL_MS', 120_000),
	/**
	 * Entity cache expiry backstop. Freshness comes from invalidation, and Redis's LRU bounds
	 * memory: an hour outlasts a whole trial, so on `bench` the cache fills to maxmemory and
	 * evicts rather than expiring. At 300 s, expiry bounded it well below maxmemory at every rate
	 * under the top step of the first tier-2 sessions (implementation review P5).
	 */
	entityTtlMs: int('ENTITY_TTL_MS', 3_600_000),
	/**
	 * Lifetime of a generation (invalidation token). Must exceed every cached value's TTL and the
	 * longest possible fill (bounded by pgStatementTimeoutMs); see cache.js for why.
	 */
	genTtlMs: int('GEN_TTL_MS', 7_200_000),
	logLevel: process.env.LOG_LEVEL ?? 'warn',
});

if (config.genTtlMs <= Math.max(config.viewTtlMs, config.entityTtlMs, config.pgStatementTimeoutMs * 10)) {
	throw new Error('GEN_TTL_MS must exceed VIEW_TTL_MS, ENTITY_TTL_MS and 10x PG_STATEMENT_TIMEOUT_MS');
}
