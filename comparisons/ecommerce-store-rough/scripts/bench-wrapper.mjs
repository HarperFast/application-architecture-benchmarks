/**
 * Machine-level accounting around the ecommerce-store harness (bench/run.mjs), unmodified.
 *
 * The harness (ecommerce-store harper-5.3 and later) accounts the TARGET's CPU per step from
 * cgroup v2 (`--target-cgroups`) and timestamps every step. What it cannot see, and what a
 * multi-container target on a shared machine needs, this adds:
 *
 *   - the generator container's own CPU (the harness reports only its Node process);
 *   - every OTHER container's CPU, including containers that start and exit inside a step
 *     (machine.slice keeps their usage), and the VM's own services (the podman service, image
 *     builds): contention, flagged per step;
 *   - machine-wide CPU from /proc/stat, so the CPU no cgroup was charged for (kernel network
 *     processing between containers, hypervisor interrupts) is visible per step;
 *   - per-container throttling for the target, which the harness also reports, kept here so a
 *     summary is self-contained.
 *
 * Counters are sampled every SAMPLE_MS and joined to the harness's step epochs
 * (startedAtEpochMs to drainEndEpochMs, the window the harness accounts target CPU over) by
 * linear interpolation.
 *
 * Runs inside the generator container, outside the target's budget, with the machine's cgroup
 * tree mounted read-only at CGROUP_ROOT (/host-cgroup, the harness's default).
 *
 *   CGROUPS='{"app":"/machine.slice/.../libpod-<id>.scope",...}' TARGET=fpr \
 *     node /cmp/bench-wrapper.mjs -- --url http://app:3000 --rates 100,200 --target-cgroups app=<id>,...
 *
 * Environment: CGROUPS (name -> cgroup path), BUDGET_CGROUP (optional shared slice), TARGET,
 * CONDITIONS (path to the run conditions JSON written by run.sh; merged into the summary).
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';

const ROOT = process.env.CGROUP_ROOT ?? '/host-cgroup';
const SAMPLE_MS = 200;
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
const selfPrefix = `libpod-${hostname()}`;
let generatorScope = null;
/** Every other container scope (inside pod slices too): id -> usage_usec. */
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
			const used = usageOf(path);
			if (used !== null) usage[entry.slice(7, 19)] = used;
		}
	};
	visit('/machine.slice', 0);
	return usage;
}

function sample() {
	const snap = { epochMs: Date.now(), machine: readMachine(), foreign: foreignUsage(), groups: {} };
	snap.allContainersUsec = usageOf('/machine.slice');
	snap.vmServicesUsec = 0;
	for (const entry of readdirSync(ROOT)) {
		if (entry === 'machine.slice') continue;
		snap.vmServicesUsec += usageOf(`/${entry}`) ?? 0;
	}
	snap.generatorUsec = generatorScope ? usageOf(generatorScope) : null;
	for (const [name, path] of Object.entries(groups)) {
		const cpu = cpuStat(path);
		snap.groups[name] = { usageUsec: cpu.usage_usec, throttledUsec: cpu.throttled_usec, nrThrottled: cpu.nr_throttled, memoryBytes: readNumber(path, 'memory.current') };
	}
	return snap;
}

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

const series = [sample()];
const sampler = setInterval(() => series.push(sample()), SAMPLE_MS);
let runRecordPath = null;

const child = spawn('node', ['/work/bench/run.mjs', ...harnessArgs], { stdio: ['ignore', 'pipe', 'inherit'], cwd: '/work' });
for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
	const record = /^(?:run record|raw samples retained): (.+)$/.exec(line);
	if (record) runRecordPath = record[1].trim();
	console.log(line);
}
const exitCode = await new Promise((resolve) => child.on('close', resolve));
clearInterval(sampler);
series.push(sample());
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
		contended: otherContainerCores > 0.05 || foreignCores > 0.05 || vmServicesCores > 0.25 || appeared,
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
console.log(`summary: ${out}`);
