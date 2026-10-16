# ecommerce-store: rough comparison (step 0)

The [step-0 rough benchmark](../../README.md#0-rough-benchmark-first) for the ecommerce-store application: the Harper reference against [Fastify + Postgres + Redis](../../implementations/fastify-postgres-redis), both containerized on one local machine. The output is [findings.md](findings.md). Nothing here is a result; tier-1 numbers are signal only, and the `dev` dataset fits in memory, so it is never a benchmark target.

The same orchestration runs tier-2 sessions on the GCP host of [`environments/gcp`](../../environments/gcp/README.md) against the `bench` dataset: [runbook-tier2.md](runbook-tier2.md). The first two, exploratory (step 0 for tier 2), are in [findings-tier2.md](findings-tier2.md).

## What is compared

| Target | Source | Budget |
|-|-|-|
| `harper` | The ecommerce-store checkout's own `containers/compose.yaml` `harper` service, extended unmodified (host port changed, profile added) | One container, 2 CPU / 2 GiB, 2 Harper threads |
| `harper-unbatched` | The same service built from `HARPER_UNBATCHED_REF` (default `dd3a5f5^`, before the reference's quote reads were batched) through ecommerce-store's own build variables; restores `harper`'s snapshot | As `harper` |
| `fpr` | [`implementations/fastify-postgres-redis`](../../implementations/fastify-postgres-redis) | Three containers, 2 CPU / 2 GiB summed. Tier 1: `shared` (one cgroup slice) or `split` (per-container quotas). Tier 2: `bench-target.slice`. Memory split per container, 512 / 1,280 / 256 MiB |

The specification, dataset, conformance suite and load harness come from a checkout of [ecommerce-store](https://github.com/HarperFast/ecommerce-store), referenced by path and never modified. It must include the cgroup-accounting harness (`bench/cgroups.mjs`; `main` from `f47978b`, where HarperFast/ecommerce-store#4 merged; the measured `dev` sessions here used that branch at `5c32151`, dataset generator 0.5.0, and the tier-2 orchestration is pinned to `f47978b`): the harness before #4 dispatched every open-loop arrival one interval late, counted completions after the step window, could not account a containerized target's CPU, and aimed most writes at products the reads never touch. Set `ECOMMERCE_STORE_DIR` (or edit `.env`) to that checkout, with its workspace installed (`npm install --ignore-scripts --no-audit --no-fund` at its root; `run.sh` stops early otherwise); `scripts/run.sh setup` otherwise finds the sibling checkout of this repository's main worktree. The reference is built from the same checkout (Harper 5.3.2 there).

## Run

Requires Podman (or Docker) with Compose, Node 24 on the host for the correctness tools, and the ecommerce-store checkout with its workspace and `e2e/` dependencies installed.

```bash
scripts/run.sh setup              # writes .env: ECOMMERCE_STORE_DIR and local Harper test credentials
scripts/run.sh load fpr           # verify + load dev, snapshot the Postgres volume (not measured)
scripts/run.sh load harper        # build the reference image, load dev over its operations API, snapshot
scripts/run.sh conformance fpr    # restore, cold start, ecommerce-store e2e suite -> results/conformance-fpr-dataset-<generator>.json
scripts/run.sh conformance harper
scripts/run.sh diff               # every quote and product response, fpr vs harper -> results/diff-reference-dataset-<generator>.json
scripts/run.sh coherence fpr      # the reference's verify-coherence.mjs: readers racing price writers
scripts/run.sh coherence harper
scripts/session.sh                # the measured session (below)
node scripts/report.mjs results/raw/session-<stamp>.log > results/session-<stamp>.md
```

`scripts/run.sh bench <target>` runs one trial: stop every target, restore the snapshot, wait until no other container on the machine is busy (tier 1; on tier 2 other containers are recorded), drop the page cache (the restore filled it; `PRE_START_HOOK`, as in the reference's orchestrator), cold-start the target (every process at once, timed by the reference's outside probe `containers/wait-ready.mjs` to the first 200 from the product endpoint), then the harness's fixed warm-up and load ladder from a generator container outside the target's budget, with the target's containers passed as `--target-cgroups` so the harness accounts their CPU itself. Afterwards: post-run statistics, the reference's `verify-run-record.mjs` (`--dev` on `dev`), for `fpr` the coherence audit, and on tier 2 ecommerce-store's cycle join (`bench/cycles.mjs`, into the run record) and the host conditions. `RATES`, `DURATION`, `BUDGET`, `MEMORY_SPLIT`, the memory split and `BENCH_ARGS` configure it; `QUOTE_SHARE`, `WRITE_RATE` and an empty `PRE_START_HOOK` are for diagnostics. The warm-up is the harness's own, fixed per scale and identical for every target.

`scripts/session.sh` runs the `TARGETS` (default `harper fpr`) round by round in one session, reversing the order every other round (the methodology's "measure every target in one session"), with the same ladder and write stream for each, then, on tier 1, any `split` sensitivity trials. A trial that fails verification or the cycle join, saw a host maintenance event, had another container busy during a step, or (tier 2) whose page-cache drop left the target slice full is set aside, kept on disk, re-run, and left out of the report, which lists it.

## Scripts

| Script | Purpose |
|-|-|
| `run.sh` | Orchestration on tier 1 or 2: setup, build, load and snapshot, restore, cold start, conformance, diff, bench, audit |
| `session.sh` | One interleaved measurement session |
| `compose.tier2.yaml` | Tier-2 placement: every target container in `bench-target.slice` without a CPU quota; the generator and loaders in `bench-generator.slice` |
| `bench-wrapper.mjs` | Runs the unmodified `bench/run.mjs` inside the generator container and adds what it does not measure: the generator container's own CPU, every other container's and the host services' CPU per step (contention; on tier 2, anything else in the target slice), machine-wide CPU from `/proc/stat` (CPU no cgroup was charged for), the shared budget slice, and for `fpr` its cache and buffer counters from `/__stats`; joined to the harness's step epochs |
| `busy.mjs` | Instantaneous CPU of other containers before a trial (`podman stats` reports lifetime averages) |
| `host-load.sh` | macOS host CPU outside the VM during a trial (the VM's vCPUs share the laptop's cores with everything else) |
| `diff-reference.mjs` | Differential correctness: every quote and every product x 5 tiers x 4 regions (on `dev`, 2,000 of each), both targets, freshly restored; reads gzipped datasets and takes every Nth cart and product with `--cart-stride` and `--product-stride` (`DIFF_ARGS`), for `bench` |
| `page-cache-drop.mjs` | Tier 2: whether the page-cache drop before the cold start emptied the target slice, from `sample.sh`'s memory samples; a slice left full sets the trial aside |
| `audit-coherence.mjs` | After a run: cached `fpr` responses vs the same responses computed from Postgres alone, for the products the run wrote (rebuilt from its run record), a stride of the rest and the hottest carts |
| `server-timing.mjs` | Diagnostic (`run.sh timing <target>`): a target's own `Server-Timing` phases, one request at a time, on its hottest keys |
| `promotion-probe.sh` | Diagnostic: the quote's promotion candidate lookup on both targets, the reference's indexed search timed by condition and `fpr`'s `EXPLAIN ANALYZE` |
| `conformance-report.mjs` | Playwright JSON to a per-requirement conformance report |
| `report.mjs` | A session's trials to median [min-max] tables and a compact JSON, then each configuration against the reference: efficiency at the matched rate and throughput at the top step, each also with the writes counted |

## Outputs

`results/` holds the committed, small artifacts: conformance reports, coherence output and the diff, each named by dataset generator version, and per-session summaries (`session-<stamp>.md` / `.json`). Results from dataset generator 0.4.0 are kept and marked superseded. `results/raw/` (not committed) keeps every raw run record with all per-request samples, the per-trial summaries with CPU time series, run conditions, console logs, and post-run Postgres and Redis statistics.

## Fixed run conditions

- One podman machine (libkrun VM, 6 vCPU, 7.45 GiB) on macOS, shared with other projects; contention is detected per step.
- User-defined bridge networks, plain HTTP. The generator reaches either target over a bridge; `fpr`'s app reaches Postgres and Redis over its own bridge.
- Named volumes on the VM's disk, never tmpfs. Every trial restores the loaded state from a tar snapshot of the target's volume (named by target, scale and dataset generator version) and then drops the VM's page cache; Redis starts empty (no persistence), as does the reference's derived cache in its snapshot.
- Disk: a Podman VM's image grows with every restore and does not return freed blocks by itself (`podman machine ssh sudo fstrim -v /` does), and raw run records are tens of megabytes each. Check free space before a large step.
- The harness, its ladder, warm-up, 50% quote share, 20 writes/s through each target's write surface, and the 750 in-flight ceiling are identical for every target. The measured `dev` sessions used a 10 s warm-up at the first rate; the harness now fixes the warm-up per scale (`dev` 2,000 requests at 200 rps, `bench` 120,000 at 100 rps).
- Base images are pinned by digest (the stack's in its `compose.yaml`, the generator's here) and recorded with every run.
- CPU clock not pinned (impossible in this tier): no ops-per-gigacycle figure exists for any of these runs.
