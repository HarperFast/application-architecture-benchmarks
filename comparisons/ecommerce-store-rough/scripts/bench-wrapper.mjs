/**
 * Machine-level accounting around the ecommerce-store harness (bench/run.mjs), unmodified.
 *
 * The harness (ecommerce-store harper-5.3 and later) accounts the TARGET's CPU per step from
 * cgroup v2 (`--target-cgroups`) and timestamps every step. What it cannot see, and what a
 * multi-container target on a shared machine needs, this adds:
 *
 *   - the generator container's own CPU (the harness reports only its Node process);
 *   - every OTHER container's CPU, including containers that start and exit inside a step:
 *     contention, flagged per step. Tier 1 (a Podman machine): every libpod scope outside the
 *     target and the generator, and the VM's own services. Tier 2 (environments/gcp): any scope
 *     in bench-target.slice that is not the target's, any other scope in bench-generator.slice,
 *     and containers misplaced in system.slice;
 *   - machine-wide CPU from /proc/stat, so the CPU no cgroup was charged for (kernel network
 *     processing between containers, interrupts) is visible per step;
 *   - per-container throttling for the target, which the harness also reports;
 *   - for a target that serves STATS_URL (fastify-postgres-redis' /__stats): its cache and
 *     buffer counters per step: entity and aggregate cache hit rates, Redis keyspace hits,
 *     misses and evictions, Postgres shared-buffer hits and reads.
 *
 * Counters are sampled every SAMPLE_MS (STATS_URL every STATS_MS) and joined to the harness's
 * step epochs (startedAtEpochMs to drainEndEpochMs, the window the harness accounts target CPU
 * over) by linear interpolation.
 *
 * Runs inside the generator container, outside the target's budget, with the machine's cgroup
 * tree mounted read-only at CGROUP_ROOT (/host-cgroup, the harness's default).
 *
 *   CGROUPS='{"app":"/machine.slice/.../libpod-<id>.scope",...}' TARGET=fpr \
 *     node /cmp/bench-wrapper.mjs -- --url http://app:3000 --rates 100,200 --target-cgroups app=<id>,...
 *
 * Environment: CGROUPS (name -> cgroup path), BUDGET_CGROUP (optional shared slice), TARGET,
 * CONDITIONS (path to the run conditions JSON written by run.sh; merged into the summary),
 * STATS_URL (optional).
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';

const ROOT = process.env.CGROUP_ROOT ?? '/host-cgroup';
const SAMPLE_MS = 200;
const STATS_MS = 2000;
const STATS_URL = process.env.STATS_URL || null;
/** Tier 2 (environments/gcp/host-setup.sh) when its slices exist; a Podman machine otherwise. */
const TARGET_SLICE = '/bench.slice/bench-target.slice';
const GENERATOR_SLICE = '/bench.slice/bench-generator.slice';
const SLICED = existsSync(`${ROOT}${TARGET_SLICE}/cpu.stat`);
const groups = JSON.parse(process.env.CGROUPS ?? '{}');
if (process.env.BUDGET_CGROUP) groups.budget = process.env.BUDGET_CGROUP;
const target = process.env.TARGET ?? 'unknown';
const separator = process.argv.indexOf('--');
const harnessArgs = separator === -1 ? process.argv.slice(2) : process.argv.slice(separator + 1);

const usageOf = (path) => {
	try {
		return Number(/usage_usec (\d+)/.exec(readFileSync(`${ROOT}${path}/cpu.stat`, 'utf8'))[1]);
	} catch {
		return null;
	}
};
function cpuStat(path) {
	const out = {};
	for (const line of readFileSync(`${ROOT}${path}/cpu.stat`, 'utf8').trim().split('\n')) {
		const [key, value] = line.split(' ');
		out[key] = Number(value);
	}
	return out;
}
const readNumber = (path, file) => {
	try {
		return Number(readFileSync(`${ROOT}${path}/${file}`, 'utf8').trim());
	} catch {
		return null;
	}
};

/** Whole-VM CPU seconds by state, from /proc/stat (not namespaced). */
function readMachine() {
	const fields = readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
	const [user, nice, system, idle, iowait, irq, softirq, steal] = fields.map((ticks) => ticks / 100);
	return { user: user + nice, system, idle, iowait, irq, softirq, steal };
}

const targetPaths = new Set(Object.values(groups));
const containerScope = /^(libpod|docker)-([0-9a-f]{12})[0-9a-f]*\.scope$/;
// Docker and Podman both name a container's hostname after the first 12 characters of its id.
const selfId = hostname();
let generatorScope = null;
const listDir = (dir) => {
	try {
		return readdirSync(`${ROOT}${dir}`);
	} catch {
		return [];
	}
};
/**
 * Every container scope that is neither the target's nor the generator's: short id -> usage_usec.
 * Tier 1: under /machine.slice (pod slices included). Tier 2: under the target and generator
 * slices, where nothing else should be, and under /system.slice, where a container lands when it
 * was not placed (it then runs on the housekeeping CPUs, outside every budget).
 */
function foreignUsage() {
	const usage = {};
	const visit = (dir, depth) => {
		for (const entry of listDir(dir)) {
			const path = `${dir}/${entry}`;
			if (depth === 0 && /^machine-libpod_pod_.*\.slice$/.test(entry)) visit(path, 1);
			const match = containerScope.exec(entry);
			if (!match || targetPaths.has(path)) continue;
			if (match[2] === selfId) {
				generatorScope = path;
				continue;
			}
			const used = usageOf(path);
			if (used !== null) usage[`${dir.split('/').at(-1)}:${match[2]}`] = used;
		}
	};
	if (SLICED) {
		visit(TARGET_SLICE, 1);
		visit(GENERATOR_SLICE, 1);
		visit('/system.slice', 1);
	} else {
		visit('/machine.slice', 0);
	}
	return usage;
}

/** CPU charged to each top-level cgroup; their sum against /proc/stat leaves what none was charged. */
function topLevelUsage() {
	const out = {};
	for (const entry of listDir('')) {
		const used = usageOf(`/${entry}`);
		if (used !== null) out[entry] = used;
	}
	return out;
}

async function pollStats() {
	try {
		const response = await fetch(STATS_URL, { signal: AbortSignal.timeout(1500) });
		if (response.ok) statsSeries.push(await response.json());
	} catch {}
}

function sample() {
	const top = topLevelUsage();
	const snap = { epochMs: Date.now(), machine: readMachine(), foreign: foreignUsage(), groups: {}, top };
	snap.allTopLevelUsec = Object.values(top).reduce((a, b) => a + b, 0);
	if (SLICED) {
		// Tier 2: the target's and generator's slices hold every container that should run; the
		// housekeeping slices hold the OS, the Docker daemon and the sampler.
		snap.allContainersUsec = usageOf('/bench.slice');
		snap.vmServicesUsec = snap.allTopLevelUsec - (top['bench.slice'] ?? 0);
		snap.generatorSliceUsec = usageOf(GENERATOR_SLICE);
		snap.targetSliceUsec = usageOf(TARGET_SLICE);
	} else {
		snap.allContainersUsec = usageOf('/machine.slice');
		snap.vmServicesUsec = snap.allTopLevelUsec - (top['machine.slice'] ?? 0);
	}
	snap.generatorUsec = generatorScope ? usageOf(generatorScope) : null;
	for (const [name, path] of Object.entries(groups)) {
		const cpu = cpuStat(path);
		snap.groups[name] = { usageUsec: cpu.usage_usec, throttledUsec: cpu.throttled_usec, nrThrottled: cpu.nr_throttled, memoryBytes: readNumber(path, 'memory.current') };
	}
	return snap;
}

const statsSeries = [];
for (const [name, path] of Object.entries(groups)) {
	if (!existsSync(`${ROOT}${path}/cpu.stat`)) {
		console.error(`cgroup for ${name} not found at ${ROOT}${path}`);
		process.exit(2);
	}
}
const limits = Object.fromEntries(
	Object.entries(groups).map(([name, path]) => [name, {
		cpuMax: readFileSync(`${ROOT}${path}/cpu.max`, 'utf8').trim(),
		memoryMax: readFileSync(`${ROOT}${path}/memory.max`, 'utf8').trim(),
	}])
);

foreignUsage(); // finds the generator's own scope before the first sample
const series = [sample()];
const sampler = setInterval(() => series.push(sample()), SAMPLE_MS);
if (STATS_URL) await pollStats();
const statsPoller = STATS_URL ? setInterval(pollStats, STATS_MS) : null;
let runRecordPath = null;

const child = spawn('node', ['/work/bench/run.mjs', ...harnessArgs], { stdio: ['ignore', 'pipe', 'inherit'], cwd: '/work' });
for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
	const record = /^(?:run record|raw samples retained): (.+)$/.exec(line);
	if (record) runRecordPath = record[1].trim();
	console.log(line);
}
const exitCode = await new Promise((resolve) => child.on('close', resolve));
clearInterval(sampler);
if (statsPoller) clearInterval(statsPoller);
series.push(sample());
if (STATS_URL) await pollStats();
if (!runRecordPath || !existsSync(runRecordPath)) {
	console.error(`harness exited ${exitCode}; no run record, no summary written`);
	process.exit(exitCode || 1);
}

// --- join the samples to the harness's step windows ---------------------------------------------
const record = JSON.parse(readFileSync(runRecordPath, 'utf8'));
const round = (n, d = 3) => (n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const quantile = (sorted, q) => (sorted.length ? sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1))] : null);

/** A counter's value at `epochMs`, interpolated between the samples around it. */
function at(epochMs, pick) {
	let i = series.findIndex((s) => s.epochMs >= epochMs);
	if (i === -1) i = series.length - 1;
	if (i === 0) return pick(series[0]);
	const a = series[i - 1];
	const b = series[i];
	const va = pick(a);
	const vb = pick(b);
	if (va === null || vb === null || va === undefined || vb === undefined) return vb ?? va ?? null;
	const f = b.epochMs === a.epochMs ? 1 : Math.min(1, Math.max(0, (epochMs - a.epochMs) / (b.epochMs - a.epochMs)));
	return va + (vb - va) * f;
}

function accountWindow(fromMs, toMs) {
	const seconds = (toMs - fromMs) / 1000;
	const cores = (pick, scale = 1e6) => {
		const a = at(fromMs, pick);
		const b = at(toMs, pick);
		return a === null || b === null ? null : round((b - a) / scale / seconds);
	};
	const perGroup = {};
	for (const name of Object.keys(groups)) {
		perGroup[name] = {
			cores: cores((s) => s.groups[name].usageUsec),
			throttledSeconds: round(((at(toMs, (s) => s.groups[name].throttledUsec) ?? 0) - (at(fromMs, (s) => s.groups[name].throttledUsec) ?? 0)) / 1e6),
		};
	}
	const machine = {};
	for (const key of Object.keys(series[0].machine)) machine[key] = cores((s) => s.machine[key], 1);
	machine.busy = round(machine.user + machine.system + machine.irq + machine.softirq);
	// Foreign containers present at both ends, plus everything in machine.slice that is neither
	// the target nor the generator (which also catches containers that came and went).
	const before = series.filter((s) => s.epochMs <= fromMs).at(-1) ?? series[0];
	const after = series.find((s) => s.epochMs >= toMs) ?? series.at(-1);
	const foreign = {};
	let foreignCores = 0;
	for (const [id, usec] of Object.entries(after.foreign)) {
		if (before.foreign[id] === undefined) continue;
		const c = (usec - before.foreign[id]) / 1e6 / ((after.epochMs - before.epochMs) / 1000);
		foreignCores += c;
		if (c > 0.01) foreign[id] = round(c);
	}
	const targetCores = groups.budget ? perGroup.budget.cores : Object.keys(groups).reduce((sum, n) => sum + (perGroup[n].cores ?? 0), 0);
	const generatorCores = cores((s) => s.generatorUsec);
	const allContainerCores = cores((s) => s.allContainersUsec);
	const vmServicesCores = cores((s) => s.vmServicesUsec);
	const otherContainerCores = round(allContainerCores - targetCores - (generatorCores ?? 0));
	const appeared = Object.keys(after.foreign).some((id) => before.foreign[id] === undefined);
	// Tier 2: the target's CPUs are its slice's, so only a scope inside bench-target.slice competes
	// for them; generator-slice and misplaced (system.slice) containers are recorded and flagged.
	const inTargetSlice = Object.entries(foreign).filter(([id]) => id.startsWith('bench-target.slice:'));
	const misplaced = Object.keys(after.foreign).filter((id) => id.startsWith('system.slice:'));
	const contended = SLICED
		? inTargetSlice.length > 0 || Object.keys(after.foreign).some((id) => id.startsWith('bench-target.slice:')) || otherContainerCores > 0.05
		: otherContainerCores > 0.05 || foreignCores > 0.05 || vmServicesCores > 0.25 || appeared;
	return {
		windowSeconds: round(seconds),
		perGroup,
		targetCores: round(targetCores),
		generatorContainerCores: generatorCores,
		otherContainerCores,
		foreignByContainer: foreign,
		vmServicesCores,
		machineCores: machine,
		// What no cgroup was charged for: the VM's kernel and interrupt time outside every cgroup.
		unchargedCores: round(machine.busy - allContainerCores - vmServicesCores),
		misplacedContainers: misplaced.length ? misplaced : undefined,
		contended,
	};
}

/**
 * The target's own cache and buffer counters over a window (STATS_URL), from cumulative counters
 * polled every STATS_MS and interpolated at the window's ends. A counter that went backwards was
 * reset (Redis evicted the stats hash, or a restart); the window then reports null for it.
 */
function statsWindow(fromMs, toMs) {
	if (statsSeries.length < 2) return null;
	const valueAt = (epochMs, pick) => {
		let i = statsSeries.findIndex((s) => s.epochMs >= epochMs);
		if (i === -1) return pick(statsSeries.at(-1)) ?? null;
		if (i === 0) return pick(statsSeries[0]) ?? null;
		const a = statsSeries[i - 1];
		const b = statsSeries[i];
		const va = pick(a);
		const vb = pick(b);
		if (va == null || vb == null) return null;
		if (vb < va) return null;
		return va + ((vb - va) * (epochMs - a.epochMs)) / Math.max(1, b.epochMs - a.epochMs);
	};
	const delta = (pick) => {
		const a = valueAt(fromMs, pick);
		const b = valueAt(toMs, pick);
		return a === null || b === null || b < a ? null : Math.round(b - a);
	};
	const rate = (hits, misses) => (hits === null || misses === null || hits + misses === 0 ? null : round(hits / (hits + misses), 4));
	const counts = {
		entityHits: ['cart', 'customer', 'product', 'variant'].reduce((sum, t) => { const d = delta((s) => s.cache?.[`${t}.hit`] ?? 0); return sum === null || d === null ? null : sum + d; }, 0),
		entityMisses: ['cart', 'customer', 'product', 'variant'].reduce((sum, t) => { const d = delta((s) => s.cache?.[`${t}.miss`] ?? 0); return sum === null || d === null ? null : sum + d; }, 0),
		viewHits: delta((s) => s.cache?.['view.hit'] ?? 0),
		viewMisses: delta((s) => s.cache?.['view.miss'] ?? 0),
		redisKeyspaceHits: delta((s) => s.redis?.keyspaceHits),
		redisKeyspaceMisses: delta((s) => s.redis?.keyspaceMisses),
		redisEvictedKeys: delta((s) => s.redis?.evictedKeys),
		pgBlocksHit: delta((s) => s.postgres?.blks_hit),
		pgBlocksRead: delta((s) => s.postgres?.blks_read),
	};
	const last = statsSeries.filter((s) => s.epochMs <= toMs).at(-1) ?? statsSeries.at(-1);
	return {
		...counts,
		entityHitRate: rate(counts.entityHits, counts.entityMisses),
		viewHitRate: rate(counts.viewHits, counts.viewMisses),
		redisKeyspaceHitRate: rate(counts.redisKeyspaceHits, counts.redisKeyspaceMisses),
		// A "read" is a block Postgres did not hold in shared_buffers; it may still have come from
		// the page cache. The harness's per-container disk reads (io.stat) separate the two.
		pgBufferHitRate: rate(counts.pgBlocksHit, counts.pgBlocksRead),
		redisUsedMemoryBytes: last?.redis?.usedMemory ?? null,
		redisMaxmemoryBytes: last?.redis?.maxmemory ?? null,
	};
}

const latency = (samples) => {
	const ok = samples.filter((s) => s.status >= 200 && s.status < 300);
	const sorted = ok.map((s) => s.arrivalMs ?? s.ms).sort((a, b) => a - b);
	return { ok: ok.length, p50: round(quantile(sorted, 0.5), 2), p90: round(quantile(sorted, 0.9), 2), p99: round(quantile(sorted, 0.99), 2) };
};

const steps = record.steps.map((step) => ({
	label: step.label,
	offeredRate: step.offeredRate,
	achievedRate: round(step.achievedRate, 1),
	saturated: step.saturated,
	ok: step.ok,
	okInWindow: step.okInWindow,
	errors: step.errors,
	shed: step.shed,
	outstandingAtDeadline: step.outstandingAtDeadline,
	p50: round(step.p50, 2),
	p90: round(step.p90, 2),
	p99: round(step.p99, 2),
	max: round(step.max, 2),
	dispatchLagP99: round(step.dispatchLagP99, 2),
	quote: latency(step.samples.filter((s) => s.kind === 'quote')),
	product: latency(step.samples.filter((s) => s.kind === 'product')),
	productCacheHitRate: round(step.cacheHitRate, 4),
	writesIssued: step.writesIssued,
	writeFailures: step.writeFailures,
	invalidations: step.invalidations,
	generatorCpuLoad: round(step.generatorCpuLoad),
	generatorSaturated: step.generatorCpuLoad > 0.8 || step.dispatchLagP99 > 5,
	// The harness's own cgroup accounting of the target (authoritative), and this wrapper's.
	targetCpuSeconds: round(step.targetCpuSeconds),
	targetCpuLoad: round(step.targetCpuLoad),
	targetComponents: step.targetComponents,
	targetCpuMsPerOk: step.targetCpuSeconds !== null && step.ok ? round((step.targetCpuSeconds * 1000) / step.ok) : null,
	machine: accountWindow(step.startedAtEpochMs, step.drainEndEpochMs),
	targetStats: STATS_URL ? statsWindow(step.startedAtEpochMs, step.drainEndEpochMs) : undefined,
}));

let conditions = {};
if (process.env.CONDITIONS && existsSync(process.env.CONDITIONS)) conditions = JSON.parse(readFileSync(process.env.CONDITIONS, 'utf8'));
const memoryPeakBytes = Object.fromEntries(Object.keys(groups).map((name) => [name, Math.max(...series.map((s) => s.groups[name].memoryBytes ?? 0))]));
const summary = {
	target,
	runRecord: basename(runRecordPath),
	complete: record.complete ?? null,
	conditions: {
		...conditions,
		harness: record.conditions?.harness,
		dataset: record.conditions?.dataset,
		lifecycle: { ...conditions.lifecycle, ...record.conditions?.lifecycle },
		caveats: record.conditions?.caveats,
		harnessCode: record.conditions?.code,
	},
	cgroups: { paths: groups, limits },
	steps,
	memoryPeakBytes,
	layout: SLICED ? 'tier 2 slices (bench.slice)' : 'podman machine (machine.slice)',
	statsSamples: STATS_URL ? statsSeries.length : undefined,
};
const out = join('/results', `summary-${target}-${basename(runRecordPath).replace(/^run-/, '')}`);
writeFileSync(out, JSON.stringify(summary, null, 2));

// --- print -------------------------------------------------------------------------------------
const components = Object.keys(groups).filter((n) => n !== 'budget');
const pad = (v, n) => String(v ?? '-').padStart(n);
console.log(`\nper-container CPU (cgroup v2) for ${target}, cores over each step's offer + drain window:`);
console.log(`${'rate'.padStart(5)} ${'achieved'.padStart(9)} ${'p50'.padStart(7)} ${'p99'.padStart(8)} ${'q.p99'.padStart(8)} ${'pdp.p99'.padStart(8)} ${'hit%'.padStart(6)} ${'gen'.padStart(5)}  ${components.map((c) => c.padStart(14)).join('')} ${'cpu/ok'.padStart(7)} ${'uncharged'.padStart(9)} ${'others'.padStart(7)}`);
for (const step of steps) {
	const cols = components.map((c) => {
		const g = step.machine.perGroup[c];
		return pad(`${g.cores?.toFixed(2)}${g.throttledSeconds >= 0.05 ? ` t${g.throttledSeconds.toFixed(1)}s` : ''}`, 14);
	});
	const flags = `${step.generatorSaturated ? '  GEN-SAT' : ''}${step.saturated ? '  SATURATED' : ''}${step.machine.contended ? `  CONTENDED (others ${step.machine.otherContainerCores}, vm services ${step.machine.vmServicesCores})` : ''}`;
	console.log(
		`${pad(step.offeredRate, 5)} ${pad(step.achievedRate, 9)} ${pad(step.p50, 7)} ${pad(step.p99, 8)} ${pad(step.quote.p99, 8)} ${pad(step.product.p99, 8)} ${pad(step.productCacheHitRate === null ? '-' : (step.productCacheHitRate * 100).toFixed(1), 6)} ${pad(step.generatorCpuLoad?.toFixed(2), 5)}  ${cols.join('')} ${pad(step.targetCpuMsPerOk, 7)} ${pad(step.machine.unchargedCores, 9)} ${pad(step.machine.otherContainerCores, 7)}${flags}`
	);
}
if (STATS_URL) {
	const pct = (v) => (v === null || v === undefined ? '-' : (v * 100).toFixed(1));
	const diskRead = (step) => {
		const list = step.targetComponents;
		if (!list?.length || list.some((c) => c.diskReadBytes == null)) return '-';
		return (list.reduce((sum, c) => sum + c.diskReadBytes, 0) / 2 ** 20).toFixed(1);
	};
	console.log(`\ncache and buffers for ${target} (${STATS_URL}), per step:`);
	console.log(`${'rate'.padStart(5)} ${'entity%'.padStart(8)} ${'view%'.padStart(7)} ${'redis%'.padStart(7)} ${'evicted'.padStart(8)} ${'redisMiB'.padStart(9)} ${'pgbuf%'.padStart(7)} ${'pgReads'.padStart(8)} ${'diskMiB'.padStart(8)}`);
	for (const step of steps) {
		const t = step.targetStats ?? {};
		console.log(`${pad(step.offeredRate, 5)} ${pad(pct(t.entityHitRate), 8)} ${pad(pct(t.viewHitRate), 7)} ${pad(pct(t.redisKeyspaceHitRate), 7)} ${pad(t.redisEvictedKeys, 8)} ${pad(t.redisUsedMemoryBytes == null ? null : (t.redisUsedMemoryBytes / 2 ** 20).toFixed(0), 9)} ${pad(pct(t.pgBufferHitRate), 7)} ${pad(t.pgBlocksRead, 8)} ${pad(diskRead(step), 8)}`);
	}
}
console.log(`summary: ${out}`);
