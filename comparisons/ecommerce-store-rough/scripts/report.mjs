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
import { pageCacheDropOf } from './page-cache-drop.mjs';

const logPath = process.argv[2];
const rawDir = dirname(logPath);
const log = readFileSync(logPath, 'utf8');
// session.sh sets a trial aside (verification, cycle join, maintenance event, page-cache drop,
// contention) and re-runs it; the set-aside attempt stays on disk and is counted here, not aggregated.
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
	// Each step's offer window, which the summary does not carry, for the writes-included rate.
	let cycles = null;
	let offerSeconds = null;
	try {
		const record = JSON.parse(readFileSync(join(rawDir, s.runRecord), 'utf8'));
		offerSeconds = new Map(record.steps.map((step) => [step.label, step.offerSeconds]));
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
	// Tier 2: whether the page-cache drop before the cold start emptied the target slice, from the
	// host samples (scripts/page-cache-drop.mjs; run.sh also records it per trial).
	const pageCacheDrop = pageCacheDropOf(join(rawDir, `samples-${s.target}-${s.conditions.stamp}`), s.conditions);
	return { file: basename(file), config, summary: s, host, cycles, offerSeconds, memoryBasis, harperMemory, pageCacheDrop, contended: s.steps.some((step) => contended(step)) };
});
const cycleStep = (trial, step) => trial.cycles?.steps?.find((c) => c.label === step.label) ?? null;
const cyclesOf = (trial, step) => {
	const c = cycleStep(trial, step);
	return c?.target ? { ...c.target, opsPerGigacycle: c.opsPerGigacycle, cpuAgreement: c.cpuAgreement } : null;
};
// Clock drift (environments/gcp "The clock on GCP", decision 5). Effective frequency rises with how
// busy the target's CPUs are, so a step is compared only with steps at the same utilization: with
// the same step (target and offered rate) across the session's trials, and, where the target used
// its whole CPU budget, with every such step of every target in the session. A step beyond the
// drift threshold in either check marks its trial for re-running (2%, or three times the spread
// the session's clock probe measured; DRIFT overrides).
const DRIFT = Number(process.env.DRIFT ?? 0.02);
const FULL_BUDGET = 0.95;
const ghzOf = (trial, step) => (contended(step) ? null : cyclesOf(trial, step)?.effectiveGHz ?? null);
const atFullBudget = (trial, step) => step.targetCpuLoad >= FULL_BUDGET * (trial.summary.conditions.budget?.targetCpus ?? Infinity);
const stepKey = (trial, step) => `${trial.config}\t${step.offeredRate}`;
const sameStep = Map.groupBy(all.flatMap((t) => t.summary.steps.map((s) => [stepKey(t, s), ghzOf(t, s)])), ([key]) => key);
const stepGHz = new Map([...sameStep].map(([key, pairs]) => [key, median(pairs.map(([, ghz]) => ghz))]));
const sessionGHz = median(all.flatMap((t) => t.summary.steps.filter((s) => atFullBudget(t, s)).map((s) => ghzOf(t, s))));
const off = (ghz, ref) => (ghz && ref ? ghz / ref - 1 : null);
const clockOf = (trial, step) => {
	const ghz = ghzOf(trial, step);
	if (!ghz) return null;
	const full = atFullBudget(trial, step);
	const fromStep = off(ghz, stepGHz.get(stepKey(trial, step)));
	const fromSession = full ? off(ghz, sessionGHz) : null;
	return { atFullBudget: full, fromStep, fromSession, drifted: Math.abs(fromStep) > DRIFT || Math.abs(fromSession ?? 0) > DRIFT };
};
const drifted = (trial, step) => !!clockOf(trial, step)?.drifted;
const rerun = all.filter((t) => t.summary.steps.some((s) => drifted(t, s)));
const pct = (x) => `${(x * 100).toFixed(2)}%`;
/** The deviation of largest magnitude, with its sign. */
const extreme = (xs) => xs.filter((x) => x !== null && x !== undefined).reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
const largest = (pick) => extreme(all.flatMap((t) => t.summary.steps.map((s) => pick(clockOf(t, s) ?? {}))));
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
	if (all.some((t) => t.cycles)) {
		const session = sessionGHz ? `against the session median of every such step, ${sessionGHz.toFixed(3)} GHz, largest deviation ${pct(largest((c) => c.fromSession))}` : 'none in this session';
		const verdict = rerun.length ? `Re-run: ${rerun.map((t) => `${t.file} (${t.summary.steps.filter((s) => drifted(t, s)).map((s) => s.offeredRate).join(', ')} rps)`).join('; ')}.` : 'No step drifted.';
		out.push(`Clock drift beyond ${+(DRIFT * 100).toFixed(2)}%, marked †. Each step against the median of the same step across its target's trials: largest deviation ${pct(largest((c) => c.fromStep))}. Each step at full budget (target CPU at least ${FULL_BUDGET * 100}% of its budget) ${session}. ${verdict}`, '');
	}
}
const compact = { session: basename(logPath), setAside: Object.fromEntries(setAside), clock: { driftThreshold: DRIFT, fullBudgetShare: FULL_BUDGET, sessionFullBudgetGHz: sessionGHz, trialsToRerun: rerun.map((t) => t.file) }, trialsWithContendedSteps: discarded.map((t) => t.file), configs: {} };

for (const config of configs) {
	const group = trials.filter((t) => t.config === config);
	const first = group[0].summary;
	const components = Object.keys(first.cgroups.paths).filter((n) => n !== 'budget');
	compact.configs[config] = {
		trials: group.map((t) => ({
			file: t.file,
			stamp: t.summary.conditions.stamp,
			coldStartFirst200Ms: t.summary.conditions.lifecycle?.coldStartFirst200Ms ?? null,
			pageCacheDrop: t.pageCacheDrop,
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
				clock: clockOf(t, s),
			})),
		})),
		budget: first.conditions.budget,
		build: first.conditions.target?.build ?? null,
		images: first.conditions.images,
		limits: first.cgroups.limits,
	};

	out.push(`### ${config}`, '');
	out.push(`${group.length} trial(s), ${group.filter((t) => t.contended).length} with at least one contended step (those steps excluded; n = clean observations per row). Cold start to first 200: ${fmt(group.map((t) => t.summary.conditions.lifecycle?.coldStartFirst200Ms), 0)} ms. Contention at start: ${group.map((t) => t.summary.conditions.contentionAtStart?.busyOtherContainers || 'none').join(', ')}.${group.some((t) => t.host) ? ` Host (macOS) cores busy outside the VM, median per trial: ${group.map((t) => t.host?.nonVmBusyCoresMedian ?? '-').join(', ')}.` : ''}`, '');
	out.push('Per trial:', '');
	for (const t of group) {
		const r = t.harperMemory?.resolved;
		const sizing = r ? `; Harper resolved from ${(t.harperMemory.inputs.constrainedMemoryBytes / MiB).toFixed(0)} MiB constrained memory: ${r.workerMaxOldGenerationMiB} MiB old space per worker, ${(r.rocksBlockCacheBytes / MiB).toFixed(0)} MiB block cache, ${(r.rocksWriteBufferManagerBytes / MiB).toFixed(0)} MiB write-buffer manager` : '';
		const d = t.pageCacheDrop;
		const drop = d.beforeMiB === undefined ? '' : `; page-cache drop: ${d.cgroup} ${d.beforeMiB.toFixed(0)} MiB before, ${d.lowestMiB.toFixed(0)} MiB at its lowest within 2.5 s (${d.verdict}${d.verdict === 'dropped' ? '' : ' ⚠'})`;
		out.push(`- ${t.summary.conditions.stamp}: DATA-004 memory basis: ${t.memoryBasis ?? 'no verifier output'}${sizing}${drop}.`);
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
		const head = ['offered rps', 'n', 'target gigacycles', 'effective GHz', 'off step median', 'off session, full budget', 'IPC', 'ops per gigacycle', 'perf / cgroup CPU', 'generator GHz'];
		out.push(`Cycles (tier 2, sample.sh joined to each step; "off" columns: the largest deviation in the row; † clock drift beyond ${+(DRIFT * 100).toFixed(2)}%):`, '', `| ${head.join(' | ')} |`, `|${head.map(() => '-').join('|')}|`);
		for (const rate of rates) {
			const pairs = group.map((t) => [t, t.summary.steps.find((s) => s.offeredRate === rate)]).filter(([t, s]) => s && !contended(s) && cyclesOf(t, s));
			if (!pairs.length) continue;
			const cy = (pick, digits) => fmt(pairs.map(([t, s]) => pick(cyclesOf(t, s)) ?? NaN), digits);
			const gen = fmt(pairs.map(([t, s]) => cycleStep(t, s)?.generator?.effectiveGHz ?? NaN), 3);
			const worst = (pick) => {
				const xs = pairs.map(([t, s]) => pick(clockOf(t, s))).filter((x) => x !== null);
				return xs.length ? pct(extreme(xs)) : '-';
			};
			out.push(`| ${[rate, pairs.length, cy((c) => c.gigacycles, 1), cy((c) => c.effectiveGHz, 3) + (pairs.some(([t, s]) => drifted(t, s)) ? ' †' : ''), worst((c) => c.fromStep), worst((c) => c.fromSession), cy((c) => c.ipc, 2), cy((c) => c.opsPerGigacycle, 0), cy((c) => c.cpuAgreement, 2), gen].join(' | ')} |`);
		}
		out.push('');
	}
}

// Between configurations (implementation review M1, M2). Efficiency where both served every
// arrival and throughput at the top step answer different questions and give different ratios, so
// both are printed, each also with the background writes counted as served operations beside the
// reads. Each configuration is compared with the first Harper reference configuration (or the
// first configuration). A ratio is the configuration's figure over the baseline's, inverted for CPU
// per operation so that above 1 always favours the configuration: the ratio of the two sides'
// medians, then in brackets the range over every pairing of one trial of each.
{
	const baseline = configs.find((c) => trials.find((t) => t.config === c).summary.target === 'harper') ?? configs[0];
	/** Writes the target acknowledged in the step (issued in its offer window; a write is not timed). */
	const acked = (s) => (s.writesIssued ?? 0) - (s.writeFailures ?? 0);
	const metrics = [
		{ key: 'throughput', head: 'throughput', of: (t, s) => s.achievedRate },
		{ key: 'throughputWithWrites', head: 'throughput, writes counted', of: (t, s) => { const sec = t.offerSeconds?.get(s.label); return sec ? s.achievedRate + acked(s) / sec : null; } },
		{ key: 'cpuPerOp', head: 'CPU per request', lowerIsBetter: true, of: (t, s) => s.targetCpuMsPerOk },
		{ key: 'cpuPerOpWithWrites', head: 'CPU per operation, writes counted', lowerIsBetter: true, of: (t, s) => (s.ok + acked(s) > 0 ? (s.targetCpuSeconds * 1000) / (s.ok + acked(s)) : null) },
		{ key: 'opsPerGigacycle', head: 'ops per gigacycle', of: (t, s) => cyclesOf(t, s)?.opsPerGigacycle ?? null },
		{ key: 'opsPerGigacycleWithWrites', head: 'ops per gigacycle, writes counted', of: (t, s) => { const c = cyclesOf(t, s); return c?.gigacycles ? (s.ok + acked(s)) / c.gigacycles : null; } },
	];
	const served = (s) => !s.saturated && !s.shed;
	/** Each trial's clean step at `rate`, as [trial, step]; null if any trial lacks one. */
	const stepsAt = (config, rate) => {
		const pairs = trials.filter((t) => t.config === config).map((t) => [t, t.summary.steps.find((s) => s.offeredRate === rate)]);
		return pairs.every(([, s]) => s && !contended(s)) ? pairs : null;
	};
	const ratio = (metric, a, b) => {
		const values = (pairs) => pairs.map(([t, s]) => metric.of(t, s)).filter((x) => Number.isFinite(x) && x > 0);
		const va = values(a), vb = values(b);
		if (!va.length || !vb.length) return null;
		const r = (x, y) => (metric.lowerIsBetter ? y / x : x / y);
		const all = va.flatMap((x) => vb.map((y) => r(x, y)));
		return { median: r(median(va), median(vb)), min: Math.min(...all), max: Math.max(...all) };
	};
	const fmtRatio = (r) => (r ? `${r.median.toFixed(2)}× [${r.min.toFixed(2)}-${r.max.toFixed(2)}]` : '-');
	const highestServed = (config, rates) => rates.filter((rate) => stepsAt(config, rate)?.every(([, s]) => served(s))).at(-1) ?? null;
	compact.between = { baseline, configs: {} };
	const others = configs.filter((c) => c !== baseline);
	if (others.length) {
		out.push('### Between configurations', '');
		out.push(`Each configuration against ${baseline}. A ratio is its figure over the baseline's (for CPU, the baseline's over its own), so above 1 favours it: the ratio of the two sides' medians, and in brackets the range over every pairing of one trial of each. "Served": no arrival shed and the step not saturated, in every trial of both. Writes counted: the ${trials[0].summary.conditions.harness?.writeRate ?? 'background'} writes/s each target acknowledged, as operations beside the reads.`, '');
	}
	for (const config of others) {
		const rates = [...new Set(trials.filter((t) => t.config === config || t.config === baseline).flatMap((t) => t.summary.steps.map((s) => s.offeredRate)))].sort((x, y) => x - y);
		const rows = rates.map((rate) => {
			const a = stepsAt(config, rate), b = stepsAt(baseline, rate);
			if (!a || !b) return { offered: rate, served: null };
			return { offered: rate, served: [...a, ...b].every(([, s]) => served(s)), ...Object.fromEntries(metrics.map((m) => [m.key, ratio(m, a, b)])) };
		});
		const matched = rows.filter((r) => r.served).at(-1) ?? null;
		const top = rows.filter((r) => r.served !== null).at(-1) ?? null;
		const saturatedAt = (c, rate) => `${stepsAt(c, rate).filter(([, s]) => !served(s)).length} of ${stepsAt(c, rate).length}`;
		compact.between.configs[config] = { highestServed: { [config]: highestServed(config, rates), [baseline]: highestServed(baseline, rates) }, matchedRate: matched?.offered ?? null, topRate: top?.offered ?? null, steps: rows };
		out.push(`#### ${config}`, '');
		out.push(`Highest offered rate served in every trial: ${highestServed(config, rates) ?? 'none'} rps, against ${highestServed(baseline, rates) ?? 'none'} rps for the baseline.`, '');
		if (matched) {
			// Both served the same reads and writes, so counting the writes changes these ratios only
			// if one target failed writes the other acknowledged.
			const same = fmtRatio(matched.cpuPerOp) === fmtRatio(matched.cpuPerOpWithWrites) && fmtRatio(matched.opsPerGigacycle) === fmtRatio(matched.opsPerGigacycleWithWrites);
			const withWrites = same ? 'the same with writes counted' : `writes counted, ${fmtRatio(matched.cpuPerOpWithWrites)} and ${fmtRatio(matched.opsPerGigacycleWithWrites)}`;
			out.push(`- **Matched rate, ${matched.offered} rps** (the highest both served): CPU per request ${fmtRatio(matched.cpuPerOp)}, ops per gigacycle ${fmtRatio(matched.opsPerGigacycle)}; ${withWrites}.`);
		}
		if (top && top !== matched) out.push(`- **Top step, ${top.offered} rps offered** (not served in ${saturatedAt(config, top.offered)} trials, and ${saturatedAt(baseline, top.offered)} of the baseline's): throughput ${fmtRatio(top.throughput)}, writes counted ${fmtRatio(top.throughputWithWrites)}; ops per gigacycle ${fmtRatio(top.opsPerGigacycle)}, writes counted ${fmtRatio(top.opsPerGigacycleWithWrites)}.`);
		out.push('');
		const head = ['offered rps', 'served', ...metrics.map((m) => m.head)];
		out.push(`| ${head.join(' | ')} |`, `|${head.map(() => '-').join('|')}|`);
		for (const r of rows) out.push(`| ${[r.offered, r.served === null ? 'no clean step' : r.served ? 'yes' : 'no', ...metrics.map((m) => fmtRatio(r[m.key]))].join(' | ')} |`);
		out.push('');
	}
}

writeFileSync(logPath.replace(/\.log$/, '.json').replace('/raw/', '/'), JSON.stringify(compact, null, 2));
console.log(out.join('\n'));
