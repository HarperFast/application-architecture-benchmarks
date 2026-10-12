/**
 * Build one Fastify instance with its Postgres pool and Redis client.
 */
import Fastify, { LogController } from 'fastify';
import { config } from './config.js';
import { createPool, query, SQL } from './db.js';
import { createCounters, createRedis } from './cache.js';
import { createCatalog, createStatics } from './catalog.js';
import quoteRoutes from './routes/quote.js';
import productRoutes from './routes/product.js';
import adminRoutes from './routes/admin.js';

export async function buildApp() {
	const app = Fastify({
		logger: { level: config.logLevel },
		// Per-request logging is a real per-request cost and not part of the application under
		// test; the reference runs with logging at `warn` too.
		logController: new LogController({ disableRequestLogging: true }),
		return503OnClosing: true,
	});

	const pool = createPool();
	const statics = createStatics(pool);
	let redis;
	let counters;
	try {
		redis = await createRedis();
		counters = createCounters(redis);
		await statics.start();
	} catch (error) {
		counters?.stop();
		statics.stop();
		await Promise.allSettled([pool.end(), redis?.destroy()]);
		throw error;
	}
	const catalog = createCatalog({ pool, redis, counters, statics });
	const freshCatalog = createCatalog({ pool, redis, counters, statics, cached: false });

	app.addHook('onClose', async () => {
		statics.stop();
		counters.stop();
		await counters.flush().catch(() => {});
		await Promise.allSettled([pool.end(), redis.close()]);
	});

	// SPEC's ApiError shape. Validation failures are 400s; anything unexpected is a 500 that is
	// logged, never a silently wrong 200.
	app.setErrorHandler((error, request, reply) => {
		const status = error.validation ? 400 : (error.statusCode ?? 500);
		if (status >= 500) request.log.error({ err: error }, 'request failed');
		reply.status(status).send({
			error: { code: error.code ?? (status >= 500 ? 'internal_error' : 'bad_request'), message: error.message },
		});
	});

	await app.register(quoteRoutes, { catalog, freshCatalog });
	await app.register(productRoutes, { catalog, freshCatalog, redis, counters });
	await app.register(adminRoutes, { pool, redis, catalog });

	/** Liveness and readiness: both backing services answer. */
	app.get('/health', async () => {
		await Promise.all([pool.query('SELECT 1'), redis.ping()]);
		return { ok: true };
	});

	/** Run-record metadata: the loaded dataset's manifest and the configuration in force. */
	app.get('/__meta', async () => {
		const { rows } = await query(pool, SQL.manifest, []);
		const versions = await pool.query("SELECT current_setting('server_version') AS postgres");
		const redisInfo = await redis.info('server');
		return {
			dataset: rows[0] ?? null,
			versions: {
				node: process.versions.node,
				fastify: app.version,
				postgres: versions.rows[0].postgres,
				redis: /redis_version:(\S+)/.exec(redisInfo)?.[1] ?? null,
			},
			config: { ...config, databaseUrl: undefined },
		};
	});

	return app;
}
