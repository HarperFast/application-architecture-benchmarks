/**
 * Reduce a Playwright JSON report of the ecommerce-store conformance suite to a conformance
 * report: one entry per test with the requirement ids its title carries, and its outcome.
 *
 *   node conformance-report.mjs <playwright.json> <target> <ecommerce-store commit>
 */
import { readFileSync } from 'node:fs';

const [file, target, suiteCommit] = process.argv.slice(2);
const report = JSON.parse(readFileSync(file, 'utf8'));
const tests = [];
const walk = (suite, path) => {
	for (const spec of suite.specs ?? []) {
		for (const t of spec.tests ?? []) {
			const result = t.results?.at(-1);
			tests.push({
				file: spec.file,
				title: spec.title,
				requirements: (/^\[([^\]]+)\]/.exec(spec.title)?.[1] ?? '').split(/\s+/).filter(Boolean),
				status: t.status === 'expected' ? 'passed' : t.status === 'skipped' ? 'skipped' : 'failed',
				durationMs: result?.duration ?? null,
				error: result?.error?.message?.split('\n')[0] ?? null,
			});
		}
	}
	for (const child of suite.suites ?? []) walk(child, [...path, child.title]);
};
for (const suite of report.suites ?? []) walk(suite, [suite.title]);

const byRequirement = {};
for (const t of tests) for (const id of t.requirements) (byRequirement[id] ??= []).push(t.status);
console.log(
	JSON.stringify(
		{
			target,
			suite: { repo: 'ecommerce-store', path: 'e2e/', commit: suiteCommit, playwright: report.config?.version ?? null },
			ranAt: report.stats?.startTime ?? null,
			passed: tests.filter((t) => t.status === 'passed').length,
			failed: tests.filter((t) => t.status === 'failed').length,
			skipped: tests.filter((t) => t.status === 'skipped').length,
			requirements: Object.fromEntries(
				Object.entries(byRequirement)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([id, statuses]) => [id, statuses.every((s) => s === 'passed') ? 'pass' : statuses.includes('failed') ? 'fail' : 'skipped'])
			),
			tests,
		},
		null,
		2
	)
);
