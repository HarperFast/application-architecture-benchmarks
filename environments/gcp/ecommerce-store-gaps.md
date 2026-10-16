# ecommerce-store: gaps before a tier-2 run

What the Harper reference implementation's harness and containers ([`HarperFast/ecommerce-store`](https://github.com/HarperFast/ecommerce-store), read at [`f47978b`][f47978b], 2026-10-15) needed before a run on the [tier-2 host](README.md) produces numbers worth keeping, and what is still open. Read from the code, then run: the first tier-2 sessions (2026-10-15 and 16, [findings](../../comparisons/ecommerce-store-rough/findings-tier2.md)) exercised every closure below with no change to ecommerce-store. Changes belong in that repository; this list is the input to them, not a patch.

The list was first read at `1b99341` (2026-10-12). [HarperFast/ecommerce-store#4](https://github.com/HarperFast/ecommerce-store/pull/4), squash-merged as [`f47978b`][f47978b], closed all three blocking gaps and nine of the ten lesser ones; the tenth needed no change. Still open: [heap and cache sizes](#open) are derived from the container's limit rather than configured, and the [ground-truth guard](#not-specific-to-tier-2) is missing. Every closure has since run on tier 2.

## Blocking, all closed

### 1. Placement in the target slice

**Closed in [`f47978b`][f47978b].** `COMPOSE_EXTRA` layers extra compose files over `compose.yaml`, and `containers/compose.tier2.yaml` sets `cgroup_parent: bench-target.slice` on `harper` and `bench-generator.slice` on `bench`. The seed, snapshot, and restore use `compose run harper`, so they inherit the placement. `verify-run-record.mjs` fails a tier-2 record whose target's applied cgroup parent is not `bench-target.slice`, or whose target cgroups lie outside it.

The override also resets Harper's CPU quota (`cpus: !reset null`, Compose 2.24 or later), so the slice's cpuset is the only CPU limit, and keeps an explicit 2 GiB container memory limit, equal to the slice's; verification fails a tier-2 target without one. See [heap and cache sizes](#open) for why the limit matters.

Was: `run-benchmark.sh` ran `compose.yaml` alone, with no `cgroup_parent`, so Harper would have landed in `system.slice` on the housekeeping CPUs.

### 2. Target CPU from cgroups

**Closed in [`f47978b`][f47978b].** The PID-based figure is gone. `bench/cgroups.mjs` reads cgroup v2 `cpu.stat` (and memory) at every step boundary through a read-only mount of the host's `/sys/fs/cgroup` in the generator container. The target defaults to its container's scope; `TARGET_CGROUPS` names other cgroups, one per container of a separated stack, or the slice itself (`target=/bench.slice/bench-target.slice`). Each step records `targetCpuSeconds` and per-cgroup `targetComponents`, and verification fails a step without a target CPU figure. Tested under Podman on tier 1, not yet under Docker on the tier-2 host.

Was: `findHarperPid()` ran `ps` inside the generator container, which cannot see Harper and has no `ps`, so `targetCpuSeconds` was null in every container run.

### 3. Cold start on a cold page cache, probed from outside

**Closed in [`f47978b`][f47978b].** Each trial restores the snapshot, stops the target, runs `PRE_START_HOOK` on the host, and starts it. The hook runs as the operator through `bash -c`, so the tier-2 value is `sync; echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null`. Verification fails a `bench` record without a hook. Readiness is probed by `containers/wait-ready.mjs` on the host, through the published port every 25 ms, timed from before `compose up`; on tier 2 that Node process runs in `user.slice` on the housekeeping CPUs. The compose CLI's share of the cold start is recorded separately (`composeUpMs`), and no target container has a healthcheck.

Was: the measured start was a `compose restart` on a warm page cache, probed by a Node process spawned inside the target once a second.

## Lesser gaps

| Gap | Status | What `f47978b` does, or what remains |
|-|-|-|
| Steps carry no absolute time | Closed | Every step records `startedAtEpochMs`, `offerEndEpochMs`, and `drainEndEpochMs`; the warm-up records its start and drain end. |
| No cycle or clock figures in the run record | Closed | With `SAMPLES_DIR` set to `sample.sh`'s output, the orchestrator runs `bench/cycles.mjs`, which joins the slices' 250 ms perf counts to each step (offer start to drain end, prorating cut intervals): target gigacycles, CPU seconds, effective GHz, and IPC, generator gigacycles, ops per gigacycle, and perf-against-cgroup CPU agreement, plus a per-trial effective-frequency summary. Verification fails a tier-2 step without cycles. The caveat is derived from the tier. Remains: ops counts successful reads (`step.ok`), not the background writes, which are identical for every target; the join is tested against the qualification's per-CPU probe output and a synthetic per-cgroup layout, not a real `sample.sh` capture; and the [drift rule](README.md#the-clock-on-gcp) compares a trial with the session median, across trials and targets, which no single target's harness can do. |
| The target is left running | Closed | An exit trap stops the target with a 120 s grace, on success or failure, unless `KEEP_TARGET=1`. |
| Run conditions are the generator's view | Closed | The orchestrator records what the generator cannot see under `conditions.orchestrator`: tier, container CLI and version, compose files, networking, Harper version, image id, architecture, and build commit, base-image digests, budget requested and applied (CPU quota, memory, cgroup parent), generator image and budget, snapshot provenance, the pre-start hook, cold start, and other containers running. `CONDITIONS_DIR` records the path of `conditions.sh` output, a reference rather than a copy, so the record is complete only alongside the session directory. The generator's own view is now `generatorHost`. |
| Snapshots have no provenance | Closed | Each snapshot gets a JSON record of scale, dataset manifest SHA-256, schema SHA-256 (comments excluded), Harper version, architecture, image id, code commit, and creation time. `SKIP_LOAD=1` refuses a snapshot whose scale, dataset, schema, Harper version, or architecture differs or is unknown, or that has no record, unless `ALLOW_UNVERIFIED_SNAPSHOT=1`. Snapshot names include the Harper and dataset generator versions. |
| Run-level requirements are not checked | Closed | `verify-run-record.mjs` runs after every trial, after the cycle join. A failing trial is counted, its record kept, and the orchestrator exits 1. |
| Generator headroom is shown by CPU only | Closed | Every step records dispatch lag p50, p99, and maximum. Verification notes a p99 above 5 ms and fails generator CPU load above 0.8. |
| Image tags, not digests | Closed | `x-base-images` in `compose.yaml` pins `node:24` and `node:24-slim` by multi-arch index digest, the same release on arm64 and x86-64. The record carries both digests and the generator's image, and verification fails a `bench` record with any unpinned. Harper itself is pinned by version (5.3.2) and checked at build time, but its dependencies resolve when the image is built, so the image id, recorded every trial, identifies the build. |
| Host-side Node | No change needed | The host's `node` (22.18 or later) still runs `prepare-dataset.mjs`, `load-dataset.mjs`, `wait-ready.mjs`, and the provenance checks; `host-setup.sh` installs Node 24. A fresh checkout also needs `npm install --ignore-scripts --no-audit --no-fund` at the repository root, because the harness and the verifier import `@ecommerce-store/spec` from the workspace; the orchestrator refuses to start without it. |
| Short steps | Closed | `bench` steps default to 60 s (`PUBLISHED_RUN.minStepSeconds`), and verification fails a `bench` record with shorter ones. |

## Open

| Gap | Why it matters on tier 2 | Suggested change |
|-|-|-|
| Heap and cache sizes are derived, not configured | A container cannot see its slice's limits ([Host](README.md#host)), so anything sized from memory has to be configured. Harper's thread count is (`HARPER_THREADS=2`), but its worker heaps and RocksDB block cache are sized from `process.constrainedMemory()`: in Harper 5.3.2 each worker's old-space limit is the larger of available memory ÷ (10 + threads ÷ 4) and 512 MiB, and the block cache is 25% of available memory, with a write buffer manager a third of that charged to it. The explicit 2 GiB container limit makes those 512 MiB per worker and 512 MiB of cache, and verification fails a tier-2 target without the limit, but the record carries only the limit, and the sizes would change silently with a Harper release or another budget. The generator's Node heap is sized the same way from its own 1 GiB limit; it sits outside the budget and its peak memory is recorded. | Set `threads.maxHeapMemory` and `storage.rocks.blockCacheSize` in `HARPER_SET_CONFIG` from the budget, as a separated stack sets Postgres `shared_buffers` and Redis `maxmemory`, and record them under `conditions.orchestrator.target.budget`; or at least record the resolved sizes. The comparison's `run.sh` now records them after every trial from inside the running target; every trial of the first tier-2 sessions resolved 512 MiB per worker, a 512 MiB block cache and a 171 MiB write-buffer manager. ecommerce-store's own orchestrator does not record them yet. |

## Not specific to tier 2

The [missing ground-truth guard](https://github.com/HarperFast/ecommerce-store/blob/main/docs/plan.md#open) still blocks publication on any tier: a run counts every 2xx as a success, so throughput says nothing about quote correctness.

## Also in `f47978b`

Not gaps on the list above, but part of what a tier-2 run of the reference now does:

- **Published-run settings.** `PUBLISHED_RUN` in `@ecommerce-store/spec`: `bench` steps of at least 60 s, seeded Poisson arrivals (the same arrival times for every target), and base images pinned by digest; verification fails a `bench` record without any of them.
- **A fixed warm-up.** `WARMUP`: 120,000 requests at 100 rps on `bench`, about 20 minutes, from the same request stream as the ladder. Verification fails a record whose warm-up differs. A trial is therefore about 30 minutes: restore, cold start, warm-up, and seven 60 s steps.
- **Every key reachable.** Reads draw every cart and product with a scrambled discrete Zipf (exponent 0.8845, dataset generator 0.5.0), and verification fails `DATA-004` when fewer keys were reachable than the tables hold. A 20,000-key sample had kept the working set inside the target's memory.
- **`DATA-004` judged per cgroup.** `scripts/memory-pressure.mjs` judges each target cgroup against its own memory limit, and summed peaks against the recorded budget: the evidence holds when one reached 90% of its limit and kept reading from disk in every step. `TARGET_CGROUPS=target=/bench.slice/bench-target.slice` judges the slice's `memory.peak` against its 2 GiB.
- **`bench` only on tier 2.** `run-benchmark.sh` refuses `SCALE=bench` unless `TIER=2`.
- **Other builds in one session.** `TARGET_REF=<commit>` builds that commit's application code with the checkout's Dockerfile and harness, tagged by commit (`TARGET_IMAGE_TAG`), against the same snapshot, whose provenance checks the schema; `TARGET_IMAGE` names the image repository, so two compose projects do not replace each other's builds.

[f47978b]: https://github.com/HarperFast/ecommerce-store/commit/f47978bfc956f859aa2a0bc417a77ea50e12b25e
