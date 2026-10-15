/**
 * Which containers are busy RIGHT NOW. `podman stats --no-stream` reports CPU averaged over a
 * container's whole lifetime, so a long-idle container that just started a benchmark reads as
 * idle and vice versa. This samples each container's cgroup cpu.stat twice, three seconds apart.
 *
 * Runs in a helper container with the machine's cgroup tree at /host/cgroup.
 * Input: CGROUPS='{"name":"/machine.slice/...scope",...}'. Output: name=percent for busy ones.
 */
import { readFileSync } from 'node:fs';

const groups = JSON.parse(process.env.CGROUPS ?? '{}');
const threshold = Number(process.env.THRESHOLD ?? '5');
const usage = (path) => {
	try {
		return Number(/usage_usec (\d+)/.exec(readFileSync(`/host/cgroup${path}/cpu.stat`, 'utf8'))[1]);
	} catch {
		return null;
	}
};
const before = Object.fromEntries(Object.entries(groups).map(([name, path]) => [name, usage(path)]));
const t0 = performance.now();
await new Promise((resolve) => setTimeout(resolve, 3000));
const seconds = (performance.now() - t0) / 1000;
const busy = [];
for (const [name, path] of Object.entries(groups)) {
	const after = usage(path);
	if (after === null || before[name] === null) continue;
	const percent = ((after - before[name]) / 1e6 / seconds) * 100;
	if (percent > threshold) busy.push(`${name}=${percent.toFixed(1)}%`);
}
console.log(busy.join(','));
