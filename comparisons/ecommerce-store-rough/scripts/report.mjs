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
const files = [...readFileSync(logPath, 'utf8').matchAll(/^summary: \/results\/(summary-[^\s]+\.json)$/gm)].map((m) => join(rawDir, m[1]));
if (!files.length) throw new Error(`no summaries named in ${logPath}`);

/** VM CPU no cgroup was charged for (kernel threads, interrupts), from the wrapper. */
const unchargedVmCores = (step) => step.machine?.unchargedCores ?? null;
const contended = (step) => !!step.machine?.contended;
const coresOf = (step, c) => step.machine?.perGroup?.[c]?.cores ?? null;
const throttleOf = (step, c) => step.machine?.perGroup?.[c]?.throttledSeconds ?? 0;

const all = files.map((file) => {
	const s = JSON.parse(readFileSync(file, 'utf8'));
	const share = s.conditions.harness?.quoteShare;
	const mix = share === undefined || share === 0.5 ? '' : share === 1 ? ', quotes only' : share === 0 ? ', products only' : `, quote share ${share}`;
	const parts = [...(s.target === 'fpr' ? [`${s.conditions.budget?.mode} budget`] : []), ...(mix ? [mix.slice(2)] : [])];
	const config = `${s.target === 'fpr' ? 'fastify-postgres-redis' : 'harper reference'}${parts.length ? ` (${parts.join(', ')})` : ''}`;
	// Host (macOS) load outside the VM during the trial, from scripts/host-load.sh.
	let host = null;
	try {
		const lines = readFileSync(join(rawDir, `host-${s.target}-${s.conditions.stamp}.txt`), 'utf8').trim().split('\n').map((l) => l.split(' '));
		const other = lines.map((l) => Number(l[2]));
		host = { samples: lines.length, nonVmBusyCoresMean: +(other.reduce((a, b) => a + b, 0) / other.length).toFixed(2), nonVmBusyCoresMax: Math.max(...other) };
	} catch {}
	return { file: basename(file), config, summary: s, host, contended: s.steps.some((step) => contended(step)) };
});
// A STEP during which another container on the machine was busy is contaminated and excluded;
// the trial's other steps still count. Each row reports how many clean observations it rests on.
const trials = all;
const discarded = all.filter((t) => t.contended);


const median = (xs) => {
	const v = xs.filter((x) => x !== null && x !== undefined && !Number.isNaN(x)).sort((a, b) => a - b);
	if (!v.length) return null;
	const mid = Math.floor(v.length / 2);
	return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};
const fmt = (xs, digits = 1) => {
	const v = xs.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
	if (!v.length) return '-';
	const m = median(v).toFixed(digits);
	if (v.length === 1) return m;
	return `${m} [${Math.min(...v).toFixed(digits)}-${Math.max(...v).toFixed(digits)}]`;
};

const configs = [...new Set(trials.map((t) => t.config))];
const out = [];
const compact = { session: basename(logPath), trialsWithContendedSteps: discarded.map((t) => t.file), configs: {} };

for (const config of configs) {
	const group = trials.filter((t) => t.config === config);
	const first = group[0].summary;
	const components = Object.keys(first.cgroups.paths).filter((n) => n !== 'budget');
	compact.configs[config] = {
		trials: group.map((t) => ({
			file: t.file,
			stamp: t.summary.conditions.stamp,
			coldStartFirst200Ms: t.summary.conditions.lifecycle?.coldStartFirst200Ms ?? null,
			host: t.host,
			contention: t.summary.conditions.contentionAtStart?.busyOtherContainers ?? null,
			steps: t.summary.steps.map((s) => ({
				contended: contended(s),
				offered: s.offeredRate, achieved: s.achievedRate, saturated: s.saturated, shed: s.shed, errors: s.errors,
				p50: s.p50, p90: s.p90, p99: s.p99, quoteP99: s.quote.p99, productP99: s.product.p99, dispatchLagP99: s.dispatchLagP99,
				productCacheHitRate: s.productCacheHitRate, invalidations: s.invalidations, writeFailures: s.writeFailures,
				generatorCpuLoad: s.generatorCpuLoad, generatorSaturated: s.generatorSaturated,
				targetCpuLoad: s.targetCpuLoad, targetCpuMsPerOk: s.targetCpuMsPerOk,
				cores: Object.fromEntries(components.map((c) => [c, coresOf(s, c)])),
				throttledSeconds: Object.fromEntries(components.map((c) => [c, throttleOf(s, c)])),
				generatorContainerCores: s.machine?.generatorContainerCores ?? null,
				otherContainerCores: s.machine?.otherContainerCores ?? null,
				vmServicesCores: s.machine?.vmServicesCores ?? null,
				machineBusyCores: s.machine?.machineCores?.busy ?? null,
				unchargedVmCores: unchargedVmCores(s),
			})),
		})),
		budget: first.conditions.budget,
		images: first.conditions.images,
		limits: first.cgroups.limits,
	};

	out.push(`### ${config}`, '');
	out.push(`${group.length} trial(s), ${group.filter((t) => t.contended).length} with at least one contended step (those steps excluded; n = clean observations per row). Cold start to first 200: ${fmt(group.map((t) => t.summary.conditions.lifecycle?.coldStartFirst200Ms), 0)} ms. Contention at start: ${group.map((t) => t.summary.conditions.contentionAtStart?.busyOtherContainers || 'none').join(', ')}. Host (macOS) cores busy outside the VM, mean per trial: ${group.map((t) => t.host?.nonVmBusyCoresMean ?? '-').join(', ')}.`, '');
	const header = ['offered rps', 'n', 'achieved rps', 'shed', 'p50 ms', 'p99 ms', 'quote p99', 'product p99', 'product hit %', ...components.map((c) => `${c} cores`), 'target cores', 'target CPU ms/req', 'uncharged VM cores', 'gen CPU'];
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
				fmt(steps.map((s) => unchargedVmCores(s)), 2),
				fmt(steps.map((s) => s.generatorCpuLoad), 2) + (steps.some((s) => s.generatorSaturated) ? ` (${steps.filter((s) => s.generatorSaturated).length}x gen flag)` : ''),
			].join(' | ')} |`
		);
	}
	out.push('');
}

writeFileSync(logPath.replace(/\.log$/, '.json').replace('/raw/', '/'), JSON.stringify(compact, null, 2));
console.log(out.join('\n'));
