# ecommerce-store: gaps before a tier-2 run

What the Harper reference implementation's harness and containers ([`HarperFast/ecommerce-store`](https://github.com/HarperFast/ecommerce-store), read at `1b99341`, 2026-10-12) need before a run on the [tier-2 host](README.md) produces numbers worth keeping. Read from the code; nothing here has been run on tier 2. Changes belong in that repository; this list is the input to them, not a patch.

The first three block a valid tier-2 run. The rest make its results incomplete or harder to defend.

## Blocking

### 1. No way to place the target in the target slice

`containers/run-benchmark.sh` runs `compose -f compose.yaml` with nothing else layered on, and `compose.yaml` sets neither `cgroup_parent` nor a cpuset. On the tier-2 host, an unplaced container lands in `system.slice`, which is confined to the housekeeping CPUs: Harper would run on CPUs 0–1 beside the Docker daemon, outside the 2-CPU target budget, and the run would be invalid.

Suggested change: let the orchestrator layer extra compose files (for example a `COMPOSE_EXTRA` variable appended as further `-f` arguments), and ship the tier-2 placement as an override so tier 1 and the checkout stay untouched:

```yaml
# containers/compose.tier2.yaml
services:
  harper:
    cgroup_parent: bench-target.slice
  bench:
    cgroup_parent: bench-generator.slice
```

The snapshot and restore steps use `compose run harper`, so they inherit the placement too, which keeps the restore's page cache charged inside the target's budget.

### 2. Target CPU is not measured in container runs

In the container workflow, `bench/run.mjs` runs inside the `bench` container. `findHarperPid()` looks for the target with `ps -A | grep -i harper`, but that container has its own PID namespace and cannot see Harper. `node:24-slim` does not ship `ps` (checked against the local image, Node 24.21.0), so the pipeline returns an empty string, the PID becomes 0, and `targetCpuSeconds` is `null` for every step. Were `procps` installed, the grep would match the generator's own command line, which contains `http://harper:9926`, and report the generator's CPU as the target's.

Suggested change: measure target CPU from the host, from cgroup v2 `cpu.stat` of the target slice and of each container scope, which is what [`sample.sh`](sample.sh) records, and stop reporting the PID-based figure from inside a container. This also delivers the per-component breakdown an assembled stack needs, since each of its containers has its own scope.

### 3. Cold start runs on a warm page cache and inside the target's budget

After a restore, the script starts Harper (`up -d`, then `sleep`), and the measured cold start is a later `compose restart`. Nothing drops the page cache between the stop and the start inside that restart, so "cold" starts with the dataset's files already cached by the restore and the first start. The readiness probe is `compose exec -T harper node -e "fetch(...)"` once a second: it spawns a Node process inside the target container, which spends the target's CPU and adds its own startup time to the measurement, at one-second resolution.

Suggested change: split the restart into stop, a pre-start hook (the tier-2 hook drops the page cache as root), and start; probe from outside the target (the generator container or the host) at 50 ms or finer.

## Incomplete or hard to defend

| Gap | Why it matters on tier 2 | Suggested change |
|-|-|-|
| Steps carry no absolute time | `sample.sh` timestamps every sample; without each step's wall-clock start and end, per-step cycles, effective frequency, and per-component CPU cannot be joined. `offerSeconds` is a duration only. | Record `Date.now()` at warm-up and step start, offer end, and drain end. |
| No cycle or clock figures in the run record | The record's caveat is a hardcoded "CPU clock NOT pinned". On tier 2 the clock is measured, and ops per gigacycle needs counted cycles per step. | Join host-side cycles into the record (or a sidecar file) per step: target gigacycles, effective GHz, generator gigacycles. Derive the caveat from the environment rather than hardcoding it. |
| The target is left running | `run-benchmark.sh` ends with Harper up. Targets share `bench-target.slice`, so a resident Harper would hold memory inside the next target's budget. | Stop the target at the end of each run, or offer a flag that does. |
| Run conditions are the generator's view | `conditions.host` is `os.cpus()` inside the generator container: every host CPU and the guest-reported model, with no cpusets, limits, instance type, turbo mode, PMU, kernel, runtime versions, image digests, or networking mode. | Accept an external conditions directory (from [`conditions.sh`](conditions.sh) and `vm.sh describe`) and reference or embed it; record the tier. |
| Snapshots have no provenance | `SKIP_LOAD=1` accepts any `.snapshots/<scale>.tar.gz`. A tier-1 snapshot (arm64, Podman on macOS) copied to the x86-64 tier-2 host would be restored without complaint. | Write the dataset manifest hash, image digest, Harper version, architecture, and creation time beside the snapshot, and refuse a mismatch. |
| Run-level requirements are not checked | Already in the plan: `scripts/verify-run-record.mjs` is not invoked. | Invoke it after each trial; a failing trial is re-run, and the failure is kept. |
| Generator headroom is shown by CPU only | `generatorCpuLoad` per step is the right primary check. That the open-loop schedule held is derivable from retained samples (`arrivalMs − ms` is dispatch lag) but not summarized. | Report p99 dispatch lag per step beside `generatorCpuLoad`, and flag a step where it exceeds a few milliseconds. |
| Image tags, not digests | `node:24-slim` (generator and target base) is a moving tag. | Record digests every trial (`conditions.sh` does) and pin them for a published run. |
| Host-side Node | `run-benchmark.sh` runs `prepare-dataset.mjs` and `load-dataset.mjs` with the host's `node`, which must be 22 or later. | Nothing required: `host-setup.sh` installs Node 24. Running both steps in a container would remove the host dependency. |
| Short steps | At 15 s, a quarter-second of error at each step boundary in the cycle join is up to about 3% of the step. | Longer steps for published runs, or accept the 250 ms sampling error and state it. |

## Not specific to tier 2

The [missing ground-truth guard](https://github.com/HarperFast/ecommerce-store/blob/main/docs/plan.md#open) still blocks publication on any tier: a run counts every 2xx as a success, so throughput says nothing about quote correctness.
