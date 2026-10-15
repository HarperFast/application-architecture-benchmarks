/**
 * Aggregate one measurement session into a compact, committable summary and markdown tables.
 *
 *   node scripts/report.mjs results/raw/session-<stamp>.log > results/session-<stamp>.md
 *
 * Reads every per-trial summary the session log names, groups trials by configuration (target and
 * budget mode), and reports each ladder step as median [min-max] across trials. Raw samples stay in
 * results/raw (not committed); the JSON written next to the markdown keeps every trial's per-step
 * figures so other intervals can be computed later.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

const logPath = process.argv[2];
const rawDir = dirname(logPath);
const log = readFileSync(logPath, 'utf8');
// session.sh sets a trial aside (verification, cycle join, maintenance event, contention) and re-runs
// it; the set-aside attempt stays on disk and is counted here, not aggregated.
const setAside = new Map([...log.matchAll(/^set aside: (\S+) (summary-\S+\.json) \((.*)\);/gm)].map((m) => [m[2], m[3]]));
const named = [...log.matchAll(/^summary: \/results\/(summary-[^\s]+\.json)$/gm)].map((m) => m[1]);
const files = named.filter((name) => !setAside.has(name)).map((name) => join(rawDir, name));
if (!files.length) throw new Error(`no accepted summaries named in ${logPath}`);

/** VM CPU no cgroup was charged for (kernel threads, interrupts), from the wrapper. */
const unchargedVmCores = (step) => step.machine?.unchargedCores ?? null;
const contended = (step) => !!step.machine?.contended;
const coresOf = (step, c) => step.machine?.perGroup?.[c]?.cores ?? null;
const throttleOf = (step, c) => step.machine?.perGroup?.[c]?.throttledSeconds ?? 0;
/** Summed over the target's containers, from the harness's own cgroup accounting (null if absent). */
const componentSum = (step, field) => {
	const list = step.targetComponents;
	if (!list?.length || list.some((c) => c[field] === null || c[field] === undefined)) return null;
	return list.reduce((sum, c) => sum + c[field], 0);
};
const MiB = 2 ** 20;
const median = (xs) => {
	const v = xs.filter((x) => x !== null && x !== undefined && !Number.isNaN(x)).sort((a, b) => a - b);
	if (!v.length) return null;
	const mid = Math.floor(v.length / 2);
	return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

const all = files.map((file) => {
	const s = JSON.parse(readFileSync(file, 'utf8'));
	const share = s.conditions.harness?.quoteShare;
	const mix = share === undefined || share === 0.5 ? '' : share === 1 ? ', quotes only' : share === 0 ? ', products only' : `, quote share ${share}`;
	const diagnostics = [
		...(s.conditions.harness?.writeRate === 0 ? ['writes off'] : []),
		...('preStartHook' in s.conditions && !s.conditions.preStartHook ? ['no page-cache drop'] : []),
	];
	const budget = s.conditions.budget;
	const memory = budget?.memorySplit === 'slice' ? ', memory: slice only' : '';
	const parts = [...(s.target === 'fpr' ? [`${budget?.mode} budget${memory}`] : []), ...(mix ? [mix.slice(2)] : []), ...diagnostics];
	const name = { fpr: 'fastify-postgres-redis', harper: 'harper reference', 'harper-unbatched': `harper reference, unbatched build (${s.conditions.target?.build?.commit?.slice(0, 7) ?? '?'})` }[s.target] ?? s.target;
	const config = `${name}${parts.length ? ` (${parts.join(', ')})` : ''}`;
	// Tier 2: per-step cycles, which ecommerce-store's bench/cycles.mjs joined into the run record
	// after the wrapper wrote this summary.
	let cycles = null;
	try {
		const record = JSON.parse(readFileSync(join(rawDir, s.runRecord), 'utf8'));
		if (record.steps.some((step) => step.cycles)) cycles = { steps: record.steps.map((step) => ({ label: step.label, ...step.cycles })), conditions: record.conditions.cycles };
	} catch {}
	// Host (macOS) load outside the VM during the trial, from scripts/host-load.sh.
	let host = null;
	try {
		const lines = readFileSync(join(rawDir, `host-${s.target}-${s.conditions.stamp}.txt`), 'utf8').trim().split('\n').map((l) => l.split(' '));
		// macOS `top` occasionally reports an absurd first sample for a just-started process; a
		// sample above the machine's core count is discarded, and the median is reported.
		const other = lines.map((l) => Number(l[2])).filter((v) => Number.isFinite(v) && v <= 12).sort((a, b) => a - b);
		host = { samples: other.length, discarded: lines.length - other.length, nonVmBusyCoresMedian: other[Math.floor(other.length / 2)] ?? null, nonVmBusyCoresMax: other.at(-1) ?? null };
	} catch {}
	// The verifier's DATA-004 memory basis, and (Harper) the heap and block-cache sizes the target
	// resolved from its memory limit (scripts/run.sh harper_memory).
	let memoryBasis = null;
	try {
		memoryBasis = /DATA-004 memory basis: (.*)/.exec(readFileSync(join(rawDir, `verify-${s.target}-${s.conditions.stamp}.txt`), 'utf8'))?.[1] ?? 'not printed';
	} catch {}
	let harperMemory = null;
	try {
		harperMemory = JSON.parse(readFileSync(join(rawDir, `harper-memory-${s.target}-${s.conditions.stamp}.json`), 'utf8'));
	} catch {}
	return { file: basename(file), config, summary: s, host, cycles, memoryBasis, harperMemory, contended: s.steps.some((step) => contended(step)) };
});
const cycleStep = (trial, step) => trial.cycles?.steps?.find((c) => c.label === step.label) ?? null;
const cyclesOf = (trial, step) => {
	const c = cycleStep(trial, step);
	return c?.target ? { ...c.target, opsPerGigacycle: c.opsPerGigacycle, cpuAgreement: c.cpuAgreement } : null;
};
// The session's clock: the median effective frequency over every accepted step of every target.
// A step that leaves it by more than the drift threshold is flagged (environments/gcp: 2%, or three
// times the spread the session's clock probe measured; DRIFT overrides).
const sessionGHz = median(all.flatMap((t) => t.summary.steps.map((s) => cyclesOf(t, s)?.effectiveGHz)));
const DRIFT = Number(process.env.DRIFT ?? 0.02);
const drifted = (trial, step) => {
	const ghz = cyclesOf(trial, step)?.effectiveGHz;
	return sessionGHz && ghz ? Math.abs(ghz - sessionGHz) / sessionGHz > DRIFT : false;
};
// A STEP during which another container on the machine was busy is contaminated and excluded;
// the trial's other steps still count. Each row reports how many clean observations it rests on.
const trials = all;
const discarded = all.filter((t) => t.contended);



const fmt = (xs, digits = 1) => {
	const v = xs.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
	if (!v.length) return '-';
	const m = median(v).toFixed(digits);
	if (v.length === 1) return m;
	return `${m} [${Math.min(...v).toFixed(digits)}-${Math.max(...v).toFixed(digits)}]`;
};

const configs = [...new Set(trials.map((t) => t.config))];
const out = [];
{
	const c = trials[0].summary.conditions;
	const commits = [...new Set(trials.map((t) => t.summary.conditions.code?.ecommerceStore?.commit?.slice(0, 7)))].join(', ');
	const tier = c.tier ?? 1;
	const standing = tier === 2 ? 'tier 2, exploratory (step 0 for tier 2), not publishable' : 'tier 1 signal, not results';
	out.push(`Dataset \`${c.dataset?.scale}\` generator ${c.dataset?.generatorVersion} · ecommerce-store ${commits} · ${standing}.`, '');
	if (setAside.size) out.push(`Set aside and re-run: ${[...setAside].map(([f, why]) => `${f} (${why})`).join('; ')}.`, '');
	if (sessionGHz) out.push(`Session clock: median effective ${sessionGHz.toFixed(3)} GHz over every step with cycle data; steps more than ${(DRIFT * 100).toFixed(0)}% from it are marked with †.`, '');
}
const compact = { session: basename(logPath), setAside: Object.fromEntries(setAside), sessionEffectiveGHz: sessionGHz, trialsWithContendedSteps: discarded.map((t) => t.file), configs: {} };

for (const config of configs) {
	const group = trials.filter((t) => t.config === config);
	const first = group[0].summary;
	const components = Object.keys(first.cgroups.paths).filter((n) => n !== 'budget');
	compact.configs[config] = {
		trials: group.map((t) => ({
			file: t.file,
			stamp: t.summary.conditions.stamp,
			coldStartFirst200Ms: t.summary.conditions.lifecycle?.coldStartFirst200Ms ?? null,
			memoryBasis: t.memoryBasis,
			harperMemory: t.harperMemory ? { inputs: t.harperMemory.inputs, configured: t.harperMemory.configured, resolved: t.harperMemory.resolved } : null,
			host: t.host,
			contention: t.summary.conditions.contentionAtStart?.busyOtherContainers ?? null,
			steps: t.summary.steps.map((s) => ({
				contended: contended(s),
				offered: s.offeredRate, achieved: s.achievedRate, saturated: s.saturated, shed: s.shed, errors: s.errors,
				p50: s.p50, p90: s.p90, p99: s.p99, quoteP99: s.quote.p99, productP99: s.product.p99, dispatchLagP99: s.dispatchLagP99,
				productCacheHitRate: s.productCacheHitRate, invalidations: s.invalidations, writeFailures: s.writeFailures,
				generatorCpuLoad: s.generatorCpuLoad, generatorSaturated: s.generatorSaturated,
				targetCpuLoad: s.targetCpuLoad, targetCpuMsPerOk: s.targetCpuMsPerOk,
				targetMemoryBytes: componentSum(s, 'memoryCurrentBytes'), targetPageCacheBytes: componentSum(s, 'pageCacheBytes'),
				targetDiskReadBytes: componentSum(s, 'diskReadBytes'), targetPageCacheRefaults: componentSum(s, 'pageCacheRefaults'),
				cores: Object.fromEntries(components.map((c) => [c, coresOf(s, c)])),
				throttledSeconds: Object.fromEntries(components.map((c) => [c, throttleOf(s, c)])),
				generatorContainerCores: s.machine?.generatorContainerCores ?? null,
				otherContainerCores: s.machine?.otherContainerCores ?? null,
				vmServicesCores: s.machine?.vmServicesCores ?? null,
				machineBusyCores: s.machine?.machineCores?.busy ?? null,
				unchargedVmCores: unchargedVmCores(s),
				targetStats: s.targetStats ?? null,
				cycles: cyclesOf(t, s),
				clockDrift: drifted(t, s),
			})),
		})),
		budget: first.conditions.budget,
		build: first.conditions.target?.build ?? null,
		images: first.conditions.images,
		limits: first.cgroups.limits,
	};

	out.push(`### ${config}`, '');
	out.push(`${group.length} trial(s), ${group.filter((t) => t.contended).length} with at least one contended step (those steps excluded; n = clean observations per row). Cold start to first 200: ${fmt(group.map((t) => t.summary.conditions.lifecycle?.coldStartFirst200Ms), 0)} ms. Contention at start: ${group.map((t) => t.summary.conditions.contentionAtStart?.busyOtherContainers || 'none').join(', ')}. Host (macOS) cores busy outside the VM, median per trial: ${group.map((t) => t.host?.nonVmBusyCoresMedian ?? '-').join(', ')}.`, '');
	out.push('Per trial:', '');
	for (const t of group) {
		const r = t.harperMemory?.resolved;
		const sizing = r ? `; Harper resolved from ${(t.harperMemory.inputs.constrainedMemoryBytes / MiB).toFixed(0)} MiB constrained memory: ${r.workerMaxOldGenerationMiB} MiB old space per worker, ${(r.rocksBlockCacheBytes / MiB).toFixed(0)} MiB block cache, ${(r.rocksWriteBufferManagerBytes / MiB).toFixed(0)} MiB write-buffer manager` : '';
		out.push(`- ${t.summary.conditions.stamp}: DATA-004 memory basis: ${t.memoryBasis ?? 'no verifier output'}${sizing}.`);
	}
	out.push('');
	const header = ['offered rps', 'n', 'achieved rps', 'shed', 'p50 ms', 'p99 ms', 'quote p99', 'product p99', 'product hit %', ...components.map((c) => `${c} cores`), 'target cores', 'target CPU ms/req', 'target memory MiB', 'disk reads MiB', 'uncharged VM cores', 'gen CPU'];
	out.push(`| ${header.join(' | ')} |`, `|${header.map(() => '-').join('|')}|`);
	const rates = first.steps.map((s) => s.offeredRate);
	for (const rate of rates) {
		const steps = group.map((t) => t.summary.steps.find((s) => s.offeredRate === rate)).filter((s) => s && !contended(s));
		if (!steps.length) {
			out.push(`| ${rate} | 0 | ${header.slice(2).map(() => '-').join(' | ')} |`);
			continue;
		}
		const throttle = (c) => {
			const t = steps.map((s) => throttleOf(s, c));
			return Math.max(...t) >= 0.05 ? ` (thr ${fmt(t)}s)` : '';
		};
		out.push(
			`| ${[
				rate,
				steps.length,
				fmt(steps.map((s) => s.achievedRate)),
				fmt(steps.map((s) => s.shed), 0),
				fmt(steps.map((s) => s.p50)),
				fmt(steps.map((s) => s.p99)),
				fmt(steps.map((s) => s.quote.p99)),
				fmt(steps.map((s) => s.product.p99)),
				fmt(steps.map((s) => (s.productCacheHitRate ?? NaN) * 100)),
				...components.map((c) => fmt(steps.map((s) => coresOf(s, c)), 2) + throttle(c)),
				fmt(steps.map((s) => s.targetCpuLoad), 2),
				fmt(steps.map((s) => s.targetCpuMsPerOk), 3),
				fmt(steps.map((s) => (componentSum(s, 'memoryCurrentBytes') ?? NaN) / MiB), 0),
				fmt(steps.map((s) => (componentSum(s, 'diskReadBytes') ?? NaN) / MiB), 1),
				fmt(steps.map((s) => unchargedVmCores(s)), 2),
				fmt(steps.map((s) => s.generatorCpuLoad), 2) + (steps.some((s) => s.generatorSaturated) ? ` (${steps.filter((s) => s.generatorSaturated).length}x gen flag)` : ''),
			].join(' | ')} |`
		);
	}
	out.push('');

	// The stack's own cache and buffer counters (/__stats), and the target's disk reads.
	if (group.some((t) => t.summary.steps.some((s) => s.targetStats))) {
		const head = ['offered rps', 'n', 'entity cache hit %', 'aggregate cache hit %', 'Redis keyspace hit %', 'Redis evictions', 'Redis used MiB', 'Postgres buffer hit %', 'Postgres blocks read', 'disk reads MiB'];
		out.push(`Cache and buffers (fastify-postgres-redis /__stats, per step):`, '', `| ${head.join(' | ')} |`, `|${head.map(() => '-').join('|')}|`);
		for (const rate of rates) {
			const steps = group.map((t) => t.summary.steps.find((s) => s.offeredRate === rate)).filter((s) => s && !contended(s) && s.targetStats);
			if (!steps.length) continue;
			const st = (pick, scale = 1, digits = 1) => fmt(steps.map((s) => { const v = pick(s.targetStats); return v === null || v === undefined ? NaN : v * scale; }), digits);
			out.push(`| ${[rate, steps.length, st((t) => t.entityHitRate, 100), st((t) => t.viewHitRate, 100), st((t) => t.redisKeyspaceHitRate, 100), st((t) => t.redisEvictedKeys, 1, 0), st((t) => t.redisUsedMemoryBytes, 1 / MiB, 0), st((t) => t.pgBufferHitRate, 100, 2), st((t) => t.pgBlocksRead, 1, 0), fmt(steps.map((s) => (componentSum(s, 'diskReadBytes') ?? NaN) / MiB), 1)].join(' | ')} |`);
		}
		out.push('');
	}

	// Tier 2: cycles per step, from sample.sh via bench/cycles.mjs.
	if (group.some((t) => t.cycles)) {
		const head = ['offered rps', 'n', 'target gigacycles', 'effective GHz', 'IPC', 'ops per gigacycle', 'perf / cgroup CPU', 'generator GHz'];
		out.push(`Cycles (tier 2, sample.sh joined to each step; † clock drift beyond ${(DRIFT * 100).toFixed(0)}%):`, '', `| ${head.join(' | ')} |`, `|${head.map(() => '-').join('|')}|`);
		for (const rate of rates) {
			const pairs = group.map((t) => [t, t.summary.steps.find((s) => s.offeredRate === rate)]).filter(([t, s]) => s && !contended(s) && cyclesOf(t, s));
			if (!pairs.length) continue;
			const cy = (pick, digits) => fmt(pairs.map(([t, s]) => pick(cyclesOf(t, s)) ?? NaN), digits);
			const gen = fmt(pairs.map(([t, s]) => cycleStep(t, s)?.generator?.effectiveGHz ?? NaN), 3);
			out.push(`| ${[rate, pairs.length, cy((c) => c.gigacycles, 1), cy((c) => c.effectiveGHz, 3) + (pairs.some(([t, s]) => drifted(t, s)) ? ' †' : ''), cy((c) => c.ipc, 2), cy((c) => c.opsPerGigacycle, 0), cy((c) => c.cpuAgreement, 2), gen].join(' | ')} |`);
		}
		out.push('');
	}
}

writeFileSync(logPath.replace(/\.log$/, '.json').replace('/raw/', '/'), JSON.stringify(compact, null, 2));
console.log(out.join('\n'));
