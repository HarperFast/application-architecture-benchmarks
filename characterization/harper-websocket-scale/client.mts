/**
 * Load-generator child process for benchmarks/ws-scale/run.mts. Driven over IPC by the orchestrator.
 *
 * Holds many WebSocket connections with as little client-side state as possible (raw `ws` plus
 * mqtt-packet rather than mqtt.js) so one process can hold tens of thousands of connections.
 * Also acts as the publisher: MQTT publishes over one WebSocket, or REST PUTs.
 */
import WebSocket from 'ws';
import http from 'node:http';
import mqttPacket from 'mqtt-packet';

type Protocol = 'mqtt' | 'ws';

interface ConnectCommand {
	cmd: 'connect';
	host: string;
	port: number;
	protocol: Protocol;
	/** global index of this process's first connection; topic assignment is by global index */
	startIndex: number;
	count: number;
	subsPerConn: number;
	topics: number;
	sourceIps: string[];
	concurrency: number;
	auth: string;
	keepalive: number;
	/** per-worker Unix sockets to spread connections over (as a TLS-terminating proxy would), instead of TCP */
	udsPaths?: string[];
	/** 0 = read normally; otherwise this fraction of connections pause their socket (slow consumers) */
	slowFraction?: number;
}

interface PublishCommand {
	cmd: 'publish';
	host: string;
	port: number;
	mode: 'mqtt' | 'put';
	topics: number;
	/** first topic to publish to; topics are cycled from here */
	topicOffset: number;
	rate: number;
	payloadBytes: number;
	durationMs: number;
	auth: string;
}

const PORTS_PER_SOURCE_IP = 25_000;
const HIST_SCALE = 8; // buckets per power of two of microseconds
const HIST_SIZE = HIST_SCALE * 32;

const stats = {
	connected: 0,
	failed: 0,
	closed: 0,
	subscribed: 0,
	received: 0,
	receivedBytes: 0,
	published: 0,
	publishErrors: 0,
	publishCompleted: 0,
	latencyHist: new Array<number>(HIST_SIZE).fill(0),
	lastError: '',
	closeCodes: {} as Record<string, number>,
};

const sockets: WebSocket[] = [];

function nowMs() {
	return performance.timeOrigin + performance.now();
}

function recordLatency(buf: Buffer) {
	// every payload starts its JSON with "t":<epoch ms> near the front (after id for records)
	const head = buf.toString('latin1', 0, Math.min(buf.length, 80));
	const match = /"t":([\d.]+)/.exec(head);
	if (!match) return;
	const us = Math.max(0, (nowMs() - Number(match[1])) * 1000);
	stats.latencyHist[Math.min(HIST_SIZE - 1, Math.floor(Math.log2(us + 1) * HIST_SCALE))]++;
}

function topicFor(connIndex: number, sub: number, subsPerConn: number, topics: number) {
	return (connIndex * Math.max(1, subsPerConn) + sub) % topics;
}

function openConnection(cmd: ConnectCommand, index: number): Promise<void> {
	const globalIndex = cmd.startIndex + index;
	const localAddress = cmd.sourceIps[Math.floor(index / PORTS_PER_SOURCE_IP) % cmd.sourceIps.length];
	const path = cmd.protocol === 'mqtt' ? '/mqtt' : `/Bench/${topicFor(globalIndex, 0, 1, cmd.topics)}`;
	const slow = cmd.slowFraction ? index % Math.round(1 / cmd.slowFraction) === 0 : false;
	return new Promise((resolve) => {
		const url = cmd.udsPaths?.length
			? `ws+unix:${cmd.udsPaths[globalIndex % cmd.udsPaths.length]}:${path}`
			: `ws://${cmd.host}:${cmd.port}${path}`;
		const ws = new WebSocket(url, cmd.protocol === 'mqtt' ? ['mqtt'] : [], {
			localAddress,
			perMessageDeflate: false,
			headers: { authorization: cmd.auth },
			handshakeTimeout: 60_000,
		});
		let settled = false;
		const done = () => {
			if (!settled) {
				settled = true;
				resolve();
			}
		};
		ws.on('error', (error) => {
			if (!settled) stats.failed++;
			stats.lastError = error.message;
			done();
		});
		ws.on('close', (code) => {
			if (settled) {
				stats.closed++;
				stats.closeCodes[code] = (stats.closeCodes[code] ?? 0) + 1;
			}
			done();
		});
		ws.on('open', () => {
			stats.connected++;
			sockets.push(ws);
			if (slow) (ws as any)._socket.pause();
			if (cmd.protocol === 'ws') {
				stats.subscribed++;
				ws.on('message', (data: Buffer) => {
					stats.received++;
					stats.receivedBytes += data.length;
					recordLatency(data);
				});
				return done();
			}
			const parser = mqttPacket.parser({ protocolVersion: 4 });
			ws.on('message', (data: Buffer) => parser.parse(data));
			parser.on('error', (error) => (stats.lastError = error.message));
			parser.on('packet', (packet: any) => {
				switch (packet.cmd) {
					case 'connack':
						if (cmd.subsPerConn === 0) return done();
						ws.send(
							mqttPacket.generate({
								cmd: 'subscribe',
								messageId: 1,
								subscriptions: Array.from({ length: cmd.subsPerConn }, (_, sub) => ({
									topic: `Bench/${topicFor(globalIndex, sub, cmd.subsPerConn, cmd.topics)}`,
									qos: 0,
								})),
							} as any)
						);
						return;
					case 'suback':
						stats.subscribed += cmd.subsPerConn;
						return done();
					case 'publish':
						stats.received++;
						stats.receivedBytes += packet.payload.length;
						recordLatency(packet.payload);
				}
			});
			ws.send(
				mqttPacket.generate({
					cmd: 'connect',
					protocolId: 'MQTT',
					protocolVersion: 4,
					clean: true,
					clientId: `b${process.pid}-${index}`,
					keepalive: cmd.keepalive,
				} as any)
			);
			if (cmd.keepalive > 0) {
				// jitter so pings don't arrive in lockstep
				const ping = mqttPacket.generate({ cmd: 'pingreq' } as any);
				const period = cmd.keepalive * 750;
				setTimeout(() => {
					const timer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(ping), period);
					ws.on('close', () => clearInterval(timer));
				}, Math.random() * period);
			}
		});
	});
}

async function connectAll(cmd: ConnectCommand) {
	let next = 0;
	const worker = async () => {
		while (next < cmd.count) await openConnection(cmd, next++);
	};
	await Promise.all(Array.from({ length: cmd.concurrency }, worker));
}

function makePayload(bytes: number, seq: number) {
	const prefix = `{"t":${nowMs().toFixed(3)},"s":${seq},"p":"`;
	return prefix + 'x'.repeat(Math.max(0, bytes - prefix.length - 2)) + '"}';
}

async function publish(cmd: PublishCommand) {
	let send: (topic: number, seq: number) => void;
	if (cmd.mode === 'mqtt') {
		const ws = new WebSocket(`ws://${cmd.host}:${cmd.port}/mqtt`, ['mqtt'], {
			perMessageDeflate: false,
			headers: { authorization: cmd.auth },
		});
		await new Promise<void>((resolve, reject) => {
			ws.on('error', reject);
			ws.on('open', () => {
				const parser = mqttPacket.parser({ protocolVersion: 4 });
				ws.on('message', (data: Buffer) => parser.parse(data));
				parser.on('packet', (packet: any) => packet.cmd === 'connack' && resolve());
				ws.send(
					mqttPacket.generate({
						cmd: 'connect',
						protocolId: 'MQTT',
						protocolVersion: 4,
						clean: true,
						clientId: `pub${process.pid}`,
						keepalive: 0,
					} as any)
				);
			});
		});
		send = (topic, seq) => {
			ws.send(
				mqttPacket.generate({
					cmd: 'publish',
					topic: `Bench/${topic}`,
					payload: Buffer.from(makePayload(cmd.payloadBytes, seq)),
					qos: 0,
					retain: false,
				} as any)
			);
			stats.published++;
		};
	} else {
		const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
		send = (topic, seq) => {
			const body = makePayload(cmd.payloadBytes, seq);
			const req = http.request(
				{
					host: cmd.host,
					port: cmd.port,
					path: `/Bench/${topic}`,
					method: 'PUT',
					agent,
					headers: {
						'content-type': 'application/json',
						'content-length': Buffer.byteLength(body),
						'authorization': cmd.auth,
					},
				},
				(res) => {
					res.resume();
					if (res.statusCode! >= 300) stats.publishErrors++;
					else stats.publishCompleted++;
				}
			);
			req.on('error', () => stats.publishErrors++);
			req.end(body);
			stats.published++;
		};
	}
	const TICK_MS = 5;
	const start = performance.now();
	let sent = 0;
	let topic = 0;
	while (performance.now() - start < cmd.durationMs) {
		const target = Math.floor(((performance.now() - start) / 1000) * cmd.rate);
		while (sent < target) send((cmd.topicOffset + topic++) % cmd.topics, sent++);
		await new Promise((resolve) => setTimeout(resolve, TICK_MS));
	}
}

process.on('message', async (message: any) => {
	switch (message.cmd) {
		case 'connect':
			await connectAll(message);
			process.send!({ reply: 'connect', ...snapshot() });
			break;
		case 'publish':
			await publish(message);
			process.send!({ reply: 'publish', ...snapshot() });
			break;
		case 'stats':
			process.send!({ reply: 'stats', ...snapshot() });
			break;
		case 'close':
			for (const ws of sockets) ws.terminate();
			process.send!({ reply: 'close', ...snapshot() });
			setTimeout(() => process.exit(0), 100);
	}
});

function snapshot() {
	return { ...stats, open: stats.connected - stats.closed, rss: process.memoryUsage().rss };
}
