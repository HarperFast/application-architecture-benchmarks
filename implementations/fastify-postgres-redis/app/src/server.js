/**
 * Process entry point. Node runs JavaScript on one thread, so using more than one core takes
 * more than one process: the primary forks WORKERS HTTP workers (node:cluster) sharing the
 * listening port, and restarts any that exit. Each worker owns its own Postgres pool and Redis
 * connection.
 */
import cluster from 'node:cluster';
import { config } from './config.js';
import { buildApp } from './app.js';

if (cluster.isPrimary && config.workers > 1) {
	console.log(`primary ${process.pid}: forking ${config.workers} workers`, JSON.stringify({ ...config, databaseUrl: undefined }));
	let stopping = false;
	for (let i = 0; i < config.workers; i++) cluster.fork();
	cluster.on('exit', (worker, code, signal) => {
		if (stopping) return;
		console.error(`worker ${worker.process.pid} exited (${signal ?? code}); restarting`);
		cluster.fork();
	});
	const stop = () => {
		stopping = true;
		for (const worker of Object.values(cluster.workers)) worker.process.kill('SIGTERM');
		setTimeout(() => process.exit(0), 5000).unref();
		cluster.on('exit', () => {
			if (!Object.keys(cluster.workers).length) process.exit(0);
		});
	};
	process.on('SIGTERM', stop);
	process.on('SIGINT', stop);
} else {
	const app = await buildApp();
	await app.listen({ port: config.port, host: config.host });
	const stop = async () => {
		await app.close();
		process.exit(0);
	};
	process.on('SIGTERM', stop);
	process.on('SIGINT', stop);
}
