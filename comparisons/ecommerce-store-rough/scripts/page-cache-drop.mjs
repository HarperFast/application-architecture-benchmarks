/**
 * Tier 2: did the page-cache drop before a trial's cold start empty the target's slice?
 *
 * ecommerce-store's verify-run-record.mjs checks that a drop was configured (`preStartHook`,
 * `pageCacheDroppedAt`), not that it took effect (implementation review M5). The host samples can
 * show it: a restore runs in bench-target.slice, so the restored files sit in the slice's page
 * cache until the drop, and sample.sh records the slice's memory.current every second.
 *
 *   node scripts/page-cache-drop.mjs <samples dir> <conditions json>
 *
 * Prints one JSON object; exits 1 only when the slice plainly did not empty ("not dropped"), which
 * run.sh treats as a fault that sets the trial aside.
 *
 * The drop time is recorded after the hook returns, to the second, so the drop ended within the
 * second after it, and the target's processes start at once. The lowest sample from a second
 * before that time to 2.5 s after it is the slice with its page cache dropped and its processes
 * barely started; the first tier-2 sessions show 0 to 2 MiB there in every trial, against 2,047
 * MiB before.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MiB = 2 ** 20;
/** Too little page cache before the drop to tell a drop from the processes' own start. */
const MIN_BEFORE_BYTES = 256 * MiB;

/**
 * @param {string} csv  sample.sh cgroups.csv
 * @param {string} droppedAt  ISO time the conditions record (`pageCacheDroppedAt`)
 * @param {string} cgroup  the target's slice, relative to the cgroup root
 */
export function pageCacheDrop(csv, droppedAt, cgroup = 'bench.slice/bench-target.slice') {
	const at = Date.parse(droppedAt ?? '');
	if (!Number.isFinite(at)) return { verdict: 'not judged', reason: 'no drop time recorded' };
	const samples = [];
	for (const line of csv.split('\n')) {
		const cells = line.split(',');
		if (cells[1] !== cgroup || cells[7] === '') continue;
		const epoch = Number(cells[0]);
		if (epoch > at + 2500) break;
		samples.push([epoch, Number(cells[7])]);
	}
	const before = samples.filter(([epoch]) => epoch < at);
	const around = samples.filter(([epoch]) => epoch >= at - 1000);
	if (!before.length || !around.length) return { verdict: 'not judged', reason: 'no samples around the drop' };
	const beforeBytes = Math.max(...before.map(([, bytes]) => bytes));
	const [lowestAt, lowestBytes] = around.reduce((low, sample) => (sample[1] < low[1] ? sample : low));
	const figures = { cgroup, beforeMiB: +(beforeBytes / MiB).toFixed(1), lowestMiB: +(lowestBytes / MiB).toFixed(1), lowestMsAfterRecordedDrop: lowestAt - at };
	if (beforeBytes < MIN_BEFORE_BYTES) return { verdict: 'not judged', reason: `under ${MIN_BEFORE_BYTES / MiB} MiB before the drop`, ...figures };
	// Within a second of the drop the processes have started too, so a slice at a few hundred MiB
	// may be their start rather than a cache left in place; only a slice still near its pre-drop
	// size is a drop that did not happen.
	const verdict = lowestBytes <= beforeBytes * 0.1 ? 'dropped' : lowestBytes >= beforeBytes * 0.9 ? 'not dropped' : 'inconclusive';
	return { verdict, ...figures };
}

/** The check for one trial's raw files: its samples directory and conditions. */
export function pageCacheDropOf(samplesDir, conditions) {
	let csv;
	try {
		csv = readFileSync(join(samplesDir, 'cgroups.csv'), 'utf8');
	} catch {
		return { verdict: 'not judged', reason: 'no host samples' };
	}
	return pageCacheDrop(csv, conditions.pageCacheDroppedAt);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [samplesDir, conditionsFile] = process.argv.slice(2);
	if (!samplesDir || !conditionsFile) {
		console.error('usage: node scripts/page-cache-drop.mjs <samples dir> <conditions json>');
		process.exit(2);
	}
	const result = pageCacheDropOf(samplesDir, JSON.parse(readFileSync(conditionsFile, 'utf8')));
	console.log(JSON.stringify(result));
	process.exit(result.verdict === 'not dropped' ? 1 : 0);
}
