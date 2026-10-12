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

const all = files.map((file) => {
	const s = JSON.parse(readFileSync(file, 'utf8'));
	const config = s.target === 'fpr' ? `fastify-postgres-redis (${s.conditions.budget?.mode} budget)` : 'harper reference';
	// Host (macOS) load outside the VM during the trial, from scripts/host-load.sh.
	let host = null;
	try {
		const lines = readFileSync(join(rawDir, `host-${s.target}-${s.conditions.stamp}.txt`), 'utf8').trim().split('\n').map((l) => l.split(' '));
		const other = lines.map((l) => Number(l[2]));
		host = { samples: lines.length, nonVmBusyCoresMean: +(other.reduce((a, b) => a + b, 0) / other.length).toFixed(2), nonVmBusyCoresMax: Math.max(...other) };
	} catch {}
	return { file: basename(file), config, summary: s, host, contended: s.steps.some((step) => step.cpu?.contended) };
});
// A trial during which another container on the machine was busy is contaminated: excluded,
// and counted in the report.
const trials = all.filter((t) => !t.contended);
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
const compact = { session: basename(logPath), discardedContendedTrials: discarded.map((t) => t.file), configs: {} };

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
				offered: s.offeredRate, achieved: s.achievedRate, shed: s.shed, errors: s.errors,
				p50: s.p50, p90: s.p90, p99: s.p99, quoteP99: s.quote.p99, productP99: s.product.p99,
				productCacheHitRate: s.productCacheHitRate, invalidations: s.invalidations, writeFailures: s.writeFailures,
				generatorCpuLoad: s.generatorCpuLoad, targetCpuMsPerOk: s.targetCpuMsPerOk,
				cores: Object.fromEntries(components.map((c) => [c, s.cpu?.perGroup[c]?.cpuUtilization ?? null])),
				throttledSeconds: Object.fromEntries(components.map((c) => [c, s.cpu?.perGroup[c]?.throttledSeconds ?? null])),
				machineBusyCores: s.cpu?.machineCoresBusy?.busy ?? null,
			})),
		})),
		budget: first.conditions.budget,
		images: first.conditions.images,
		limits: first.cgroups.limits,
	};

	out.push(`### ${config}`, '');
	out.push(`${group.length} uncontended trial(s)${discarded.some((t) => t.config === config) ? ` (${discarded.filter((t) => t.config === config).length} contended trial(s) excluded)` : ''}. Cold start to first 200: ${fmt(group.map((t) => t.summary.conditions.lifecycle?.coldStartFirst200Ms), 0)} ms. Contention at start: ${group.map((t) => t.summary.conditions.contentionAtStart?.busyOtherContainers || 'none').join(', ')}. Host (macOS) cores busy outside the VM, mean per trial: ${group.map((t) => t.host?.nonVmBusyCoresMean ?? '-').join(', ')}.`, '');
	const header = ['offered rps', 'achieved rps', 'shed', 'p50 ms', 'p99 ms', 'quote p99', 'product p99', 'product hit %', ...components.map((c) => `${c} cores`), 'target CPU ms/req', 'gen CPU'];
	out.push(`| ${header.join(' | ')} |`, `|${header.map(() => '-').join('|')}|`);
	const rates = first.steps.map((s) => s.offeredRate);
	for (const rate of rates) {
		const steps = group.map((t) => t.summary.steps.find((s) => s.offeredRate === rate)).filter(Boolean);
		const throttle = (c) => {
			const t = steps.map((s) => s.cpu?.perGroup[c]?.throttledSeconds ?? 0);
			return Math.max(...t) > 0 ? ` (thr ${fmt(t)}s)` : '';
		};
		out.push(
			`| ${[
				rate,
				fmt(steps.map((s) => s.achievedRate)),
				fmt(steps.map((s) => s.shed), 0),
				fmt(steps.map((s) => s.p50)),
				fmt(steps.map((s) => s.p99)),
				fmt(steps.map((s) => s.quote.p99)),
				fmt(steps.map((s) => s.product.p99)),
				fmt(steps.map((s) => (s.productCacheHitRate ?? NaN) * 100)),
				...components.map((c) => fmt(steps.map((s) => s.cpu?.perGroup[c]?.cpuUtilization), 2) + throttle(c)),
				fmt(steps.map((s) => s.targetCpuMsPerOk), 3),
				fmt(steps.map((s) => s.generatorCpuLoad), 2),
			].join(' | ')} |`
		);
	}
	out.push('');
}

writeFileSync(logPath.replace(/\.log$/, '.json').replace('/raw/', '/'), JSON.stringify(compact, null, 2));
console.log(out.join('\n'));
