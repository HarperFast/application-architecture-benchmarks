/**
 * Per-container CPU accounting around the UNMODIFIED ecommerce-store harness.
 *
 * bench/run.mjs samples one target process with `ps`, which cannot see into another container
 * (inside the generator's container it finds nothing, so targetCpuSeconds is null) and cannot
 * represent a target made of several processes. This wrapper runs the harness as a child,
 * timestamps the step boundaries from its output, and reads each target container's cgroup v2
 * counters (cpu.stat, memory.current) at those boundaries and once a second. It then joins the
 * counters with the harness's run record into a per-step summary: throughput and latency from the
 * harness, CPU seconds and CPU throttling per container from the kernel.
 *
 * Runs inside the generator container (outside the target's budget) with the machine's cgroup
 * tree mounted read-only at /host/cgroup.
 *
 *   CGROUPS='{"app":"/machine.slice/.../libpod-<id>.scope",...}' TARGET=fpr \
 *     node /cmp/bench-wrapper.mjs -- --url http://app:3000 --rates 100,200 ...
 *
 * Environment: CGROUPS (name -> cgroup path), BUDGET_CGROUP (optional shared slice), TARGET,
 * CONDITIONS (path to a JSON file of run conditions written by run.sh; merged into the summary).
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';

const ROOT = '/host/cgroup';
const groups = JSON.parse(process.env.CGROUPS ?? '{}');
if (process.env.BUDGET_CGROUP) groups.budget = process.env.BUDGET_CGROUP;
const target = process.env.TARGET ?? 'unknown';
const separator = process.argv.indexOf('--');
const harnessArgs = separator === -1 ? process.argv.slice(2) : process.argv.slice(separator + 1);

function readCpu(path) {
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

/**
 * Machine-wide CPU from /proc/stat (not namespaced, so this is the whole podman VM), in seconds.
 * Kernel network processing (softirq) is not reliably charged to the cgroup that caused it, and a
 * chatty multi-container stack causes more of it than a single process; recording it per step
 * shows how much CPU the per-container figures cannot attribute.
 */
function readMachine() {
	const fields = readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
	const [user, nice, system, idle, iowait, irq, softirq, steal] = fields.map((ticks) => ticks / 100);
	return { user: user + nice, system, idle, iowait, irq, softirq, steal };
}

/**
 * Every OTHER container on the machine: any libpod scope under machine.slice (including inside pod
 * slices) that is neither a target container nor this generator container. A measurement taken
 * while something else on the machine is busy is contaminated; this makes that visible per step
 * instead of assuming the idle check at the start still holds.
 */
const targetPaths = new Set(Object.values(groups));
const selfPrefix = `libpod-${hostname()}`;
let generatorScope = null;
function foreignUsage() {
	const usage = {};
	const visit = (dir, depth) => {
		let entries = [];
		try {
			entries = readdirSync(`${ROOT}${dir}`);
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = `${dir}/${entry}`;
			if (depth === 0 && entry.startsWith('machine-libpod_pod_') && entry.endsWith('.slice')) visit(path, 1);
			if (!entry.startsWith('libpod-') || entry.startsWith('libpod-conmon-') || !entry.endsWith('.scope')) continue;
			if (targetPaths.has(path)) continue;
			if (entry.startsWith(selfPrefix)) {
				generatorScope = path;
				continue;
			}
			try {
				usage[entry.slice(7, 19)] = Number(/usage_usec (\d+)/.exec(readFileSync(`${ROOT}${path}/cpu.stat`, 'utf8'))[1]);
			} catch {}
		}
	};
	visit('/machine.slice', 0);
	return usage;
}

function snapshot(label) {
	const snap = { label, t: performance.now(), wall: Date.now(), machine: readMachine(), foreign: foreignUsage(), groups: {} };
	// Every container ever on the machine, transient ones included: a parent cgroup keeps the
	// usage of children that have exited.
	snap.allContainersUsec = Number(/usage_usec (\d+)/.exec(readFileSync(`${ROOT}/machine.slice/cpu.stat`, 'utf8'))[1]);
	if (generatorScope) {
		try {
			snap.generatorUsec = Number(/usage_usec (\d+)/.exec(readFileSync(`${ROOT}${generatorScope}/cpu.stat`, 'utf8'))[1]);
		} catch {}
	}
	for (const [name, path] of Object.entries(groups)) {
		const cpu = readCpu(path);
		snap.groups[name] = {
			usageUsec: cpu.usage_usec,
			userUsec: cpu.user_usec,
			systemUsec: cpu.system_usec,
			nrThrottled: cpu.nr_throttled,
			throttledUsec: cpu.throttled_usec,
			memoryBytes: readNumber(path, 'memory.current'),
		};
	}
	return snap;
}

// Validate the cgroup paths before starting a run that would otherwise record nothing.
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

const marks = { start: snapshot('start'), warmupStart: null, warmupEnd: null, ladderStart: null, steps: [] };
const series = [];
const sampler = setInterval(() => series.push(snapshot('tick')), 1000);
let runRecordPath = null;

const child = spawn('node', ['/work/bench/run.mjs', ...harnessArgs], { stdio: ['ignore', 'pipe', 'inherit'], cwd: '/work' });
for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
	if (line.startsWith('warm-up ')) marks.warmupStart = snapshot('warmup-start');
	else if (/^\s+first response/.test(line)) marks.warmupEnd = snapshot('warmup-end');
	else if (/^─+$/.test(line)) marks.ladderStart = snapshot('ladder-start');
	else if (marks.ladderStart && /^\s*\d+\s+\d+\s/.test(line)) marks.steps.push(snapshot(`step-${marks.steps.length}`));
	const retained = /^raw samples retained: (.+)$/.exec(line);
	if (retained) runRecordPath = retained[1].trim();
	console.log(line);
}
const exitCode = await new Promise((resolve) => child.on('close', resolve));
clearInterval(sampler);
marks.end = snapshot('end');
if (exitCode !== 0 || !runRecordPath) {
	console.error(`harness exited ${exitCode}; no summary written`);
	process.exit(exitCode || 1);
}

// --- join the counters with the run record -----------------------------------------------------
const record = JSON.parse(readFileSync(runRecordPath, 'utf8'));
const quantile = (sorted, q) => (sorted.length ? sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1))] : null);
const round = (n, d = 2) => (n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

function delta(from, to) {
	const seconds = (to.t - from.t) / 1000;
	const perGroup = {};
	for (const name of Object.keys(groups)) {
		const a = from.groups[name];
		const b = to.groups[name];
		const cpuSeconds = (b.usageUsec - a.usageUsec) / 1e6;
		perGroup[name] = {
			cpuSeconds: round(cpuSeconds, 3),
			cpuUtilization: round(cpuSeconds / seconds, 3),
			throttledSeconds: round((b.throttledUsec - a.throttledUsec) / 1e6, 3),
			throttledPeriods: b.nrThrottled - a.nrThrottled,
		};
	}
	const machine = {};
	for (const key of Object.keys(to.machine)) machine[key] = round((to.machine[key] - from.machine[key]) / seconds, 3);
	machine.busy = round(machine.user + machine.system + machine.irq + machine.softirq, 3);
	// Other containers' CPU over the window (present at both ends; one that started mid-window
	// counts from its first sample, so this can under-read but never over-read).
	const foreign = {};
	let foreignCores = 0;
	for (const [id, usec] of Object.entries(to.foreign)) {
		const before = from.foreign[id];
		if (before === undefined) continue;
		const cores = (usec - before) / 1e6 / seconds;
		foreignCores += cores;
		if (cores > 0.01) foreign[id] = round(cores, 3);
	}
	const generatorCores = from.generatorUsec !== undefined && to.generatorUsec !== undefined ? round((to.generatorUsec - from.generatorUsec) / 1e6 / seconds, 3) : null;
	// Everything in machine.slice that is neither the target nor the generator: other containers,
	// including any that started and exited inside the window, plus conmon processes.
	const targetUsec = groups.budget
		? to.groups.budget.usageUsec - from.groups.budget.usageUsec
		: Object.keys(groups).reduce((sum, name) => sum + (to.groups[name].usageUsec - from.groups[name].usageUsec), 0);
	const unattributedContainerCores = round(
		(to.allContainersUsec - from.allContainersUsec - targetUsec - ((to.generatorUsec ?? 0) - (from.generatorUsec ?? 0))) / 1e6 / seconds,
		3
	);
	return {
		windowSeconds: round(seconds, 3),
		perGroup,
		machineCoresBusy: machine,
		generatorContainerCores: generatorCores,
		foreignCores: round(foreignCores, 3),
		foreignByContainer: foreign,
		unattributedContainerCores,
		contended: foreignCores > 0.05 || unattributedContainerCores > 0.05 || Object.keys(to.foreign).some((id) => from.foreign[id] === undefined),
	};
}

const components = Object.keys(groups).filter((name) => name !== 'budget');
const latencySummary = (samples) => {
	const ok = samples.filter((s) => s.status >= 200 && s.status < 300);
	const sorted = ok.map((s) => s.arrivalMs ?? s.ms).sort((a, b) => a - b);
	return { ok: ok.length, p50: round(quantile(sorted, 0.5)), p90: round(quantile(sorted, 0.9)), p99: round(quantile(sorted, 0.99)) };
};

const steps = record.steps.map((step, i) => {
	const from = i === 0 ? marks.ladderStart : marks.steps[i - 1];
	const to = marks.steps[i];
	const cpu = from && to ? delta(from, to) : null;
	const targetCpuSeconds = cpu ? components.reduce((sum, name) => sum + cpu.perGroup[name].cpuSeconds, 0) : null;
	const products = step.samples.filter((s) => s.kind === 'product');
	const productCache = products.filter((s) => s.status >= 200 && s.status < 300 && s.cacheHit !== null && s.cacheHit !== undefined);
	return {
		label: step.label,
		offeredRate: step.offeredRate,
		achievedRate: round(step.achievedRate, 1),
		ok: step.ok,
		errors: step.errors,
		shed: step.shed,
		outstandingAtDeadline: step.outstandingAtDeadline,
		p50: round(step.p50),
		p90: round(step.p90),
		p99: round(step.p99),
		max: round(step.max),
		quote: latencySummary(step.samples.filter((s) => s.kind === 'quote')),
		product: latencySummary(products),
		// The harness's cacheHitRate counts quotes (always `miss`, by QUOTE-001) in the
		// denominator; the product-only rate is the cache's own hit rate.
		cacheHitRate: round(step.cacheHitRate, 4),
		productCacheHitRate: productCache.length ? round(productCache.filter((s) => s.cacheHit === 1).length / productCache.length, 4) : null,
		writesIssued: step.writesIssued,
		writeFailures: step.writeFailures,
		invalidations: step.invalidations,
		generatorCpuLoad: round(step.generatorCpuLoad, 3),
		generatorSaturated: step.generatorCpuLoad > 0.8,
		cpu,
		targetCpuSeconds: round(targetCpuSeconds, 3),
		targetCpuMsPerOk: targetCpuSeconds !== null && step.ok ? round((targetCpuSeconds * 1000) / step.ok, 3) : null,
	};
});

let conditions = {};
if (process.env.CONDITIONS && existsSync(process.env.CONDITIONS)) conditions = JSON.parse(readFileSync(process.env.CONDITIONS, 'utf8'));
const summary = {
	target,
	runRecord: basename(runRecordPath),
	conditions: { ...conditions, harness: record.conditions.harness, dataset: record.conditions.dataset, lifecycle: { ...conditions.lifecycle, ...record.conditions.lifecycle }, host: record.conditions.host, caveats: record.conditions.caveats },
	cgroups: { paths: groups, limits },
	warmup: marks.warmupStart && marks.warmupEnd ? delta(marks.warmupStart, marks.warmupEnd) : null,
	steps,
	memoryPeakBytes: Object.fromEntries(Object.keys(groups).map((name) => [name, Math.max(...series.map((s) => s.groups[name].memoryBytes ?? 0), marks.end.groups[name].memoryBytes ?? 0)])),
	series: series.map((s) => ({ wall: s.wall, groups: Object.fromEntries(Object.entries(s.groups).map(([n, g]) => [n, { usageUsec: g.usageUsec, throttledUsec: g.throttledUsec, memoryBytes: g.memoryBytes }])) })),
};
const out = join('/results', `summary-${target}-${basename(runRecordPath).replace(/^run-/, '')}`);
writeFileSync(out, JSON.stringify(summary, null, 2));

// --- print -------------------------------------------------------------------------------------
const pad = (v, n) => String(v ?? '-').padStart(n);
console.log(`\nper-container CPU (cgroup v2) for ${target}:`);
console.log(`${'rate'.padStart(5)} ${'achieved'.padStart(9)} ${'p50'.padStart(8)} ${'p99'.padStart(9)} ${'q.p99'.padStart(9)} ${'pdp.p99'.padStart(9)} ${'pdpHit'.padStart(7)} ${'genCPU'.padStart(6)}  ${components.map((c) => `${c}`.padStart(16)).join('')} ${'cpu/ok ms'.padStart(10)} ${'vm busy'.padStart(8)} ${'softirq'.padStart(8)}`);
for (const step of steps) {
	const cols = components.map((c) => {
		const g = step.cpu?.perGroup[c];
		return pad(g ? `${g.cpuUtilization.toFixed(2)}${g.throttledSeconds > 0 ? ` t${g.throttledSeconds.toFixed(1)}s` : ''}` : '-', 16);
	});
	console.log(
		`${pad(step.offeredRate, 5)} ${pad(step.achievedRate, 9)} ${pad(step.p50, 8)} ${pad(step.p99, 9)} ${pad(step.quote.p99, 9)} ${pad(step.product.p99, 9)} ${pad(step.productCacheHitRate === null ? '-' : (step.productCacheHitRate * 100).toFixed(1) + '%', 7)} ${pad(step.generatorCpuLoad, 6)}  ${cols.join('')} ${pad(step.targetCpuMsPerOk, 10)} ${pad(step.cpu?.machineCoresBusy.busy, 8)} ${pad(step.cpu?.machineCoresBusy.softirq, 8)}${step.cpu?.contended ? `  CONTENDED: other containers ${Math.max(step.cpu.foreignCores, step.cpu.unattributedContainerCores)} cores` : ''}`
	);
}
console.log('(per-container columns: cores used over the step window; tN.Ns = seconds spent CPU-throttled; vm busy / softirq: whole podman VM, every container and the generator included)');
console.log(`summary: ${out}`);
