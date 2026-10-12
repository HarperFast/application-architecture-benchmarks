# ecommerce-store: rough comparison (step 0)

The [step-0 rough benchmark](../../README.md#0-rough-benchmark-first) for the ecommerce-store application: the Harper reference against [Fastify + Postgres + Redis](../../implementations/fastify-postgres-redis), both containerized on one local machine. The output is [findings.md](findings.md). Nothing here is a result; tier-1 numbers are signal only, and the `dev` dataset fits in memory, so it is never a benchmark target.

## What is compared

| Target | Source | Budget |
|-|-|-|
| `harper` | The ecommerce-store checkout's own `containers/compose.yaml` `harper` service, extended unmodified (host port changed, profile added) | One container, 2 CPU / 2 GiB, 2 Harper threads |
| `fpr` | [`implementations/fastify-postgres-redis`](../../implementations/fastify-postgres-redis) | Three containers, 2 CPU / 2 GiB summed: `shared` (one cgroup slice) or `split` (per-container quotas) |

The specification, dataset, conformance suite and load harness come from a checkout of [ecommerce-store](https://github.com/HarperFast/ecommerce-store), referenced by path and never modified. It must include the cgroup-accounting harness (`bench/cgroups.mjs`, branch `harper-5.3` at the time of writing): `main`'s harness dispatched every open-loop arrival one interval late, counted completions after the step window, could not account a containerized target's CPU, and aimed most writes at products the reads never touch. Set `ECOMMERCE_STORE_DIR` (or edit `.env`) to that checkout; `scripts/run.sh setup` otherwise finds the sibling checkout of this repository's main worktree. The reference is built from the same checkout (Harper 5.3.2 there).

## Run

Requires Podman (or Docker) with Compose, Node 24 on the host for the correctness tools, and the ecommerce-store checkout with its `e2e/` dependencies installed.

```bash
scripts/run.sh setup              # writes .env: ECOMMERCE_STORE_DIR and local Harper test credentials
scripts/run.sh load fpr           # verify + load dev, snapshot the Postgres volume (not measured)
scripts/run.sh load harper        # build the reference image, load dev over its operations API, snapshot
scripts/run.sh conformance fpr    # restore, cold start, ecommerce-store e2e suite -> results/conformance-fpr.json
scripts/run.sh conformance harper
scripts/run.sh diff               # every quote and product response, fpr vs harper -> results/diff-reference.json
scripts/run.sh coherence fpr      # the reference's verify-coherence.mjs: readers racing price writers
scripts/run.sh coherence harper
scripts/session.sh                # the measured session (below)
node scripts/report.mjs results/raw/session-<stamp>.log > results/session-<stamp>.md
```

`scripts/run.sh bench <target>` runs one trial: restore the snapshot, wait until no other container on the machine is busy, cold-start the target (every process at once, timed by the reference's outside probe `containers/wait-ready.mjs` to the first 200 from the product endpoint), then the harness's warm-up and load ladder from a generator container outside the target's budget, with the target's containers passed as `--target-cgroups` so the harness accounts their CPU itself; then post-run statistics, the reference's `verify-run-record.mjs --dev`, and, for `fpr`, the coherence audit. `RATES`, `DURATION`, `WARMUP` and `BUDGET` (`shared` or `split`) configure it.

`scripts/session.sh` alternates the targets trial by trial in one session (the methodology's "measure every target in one session"), with the same ladder and write stream for each, then runs the `split` sensitivity trials. A trial during which any other container on the machine became busy is flagged, kept, re-run, and excluded from the report.

## Scripts

| Script | Purpose |
|-|-|
| `run.sh` | Orchestration: setup, load and snapshot, restore, cold start, conformance, diff, bench, audit |
| `session.sh` | One alternating measurement session |
| `bench-wrapper.mjs` | Runs the unmodified `bench/run.mjs` inside the generator container and adds what it does not measure: the generator container's own CPU, every other container's and the VM services' CPU per step (contention), machine-wide CPU from `/proc/stat` (CPU no cgroup was charged for), and the shared budget slice; joined to the harness's step epochs |
| `busy.mjs` | Instantaneous CPU of other containers before a trial (`podman stats` reports lifetime averages) |
| `host-load.sh` | macOS host CPU outside the VM during a trial (the VM's vCPUs share the laptop's cores with everything else) |
| `diff-reference.mjs` | Differential correctness: all 2,000 quotes and all 2,000 products x 5 tiers x 4 regions, both targets, freshly restored |
| `audit-coherence.mjs` | After a run: cached `fpr` responses vs the same responses computed from Postgres alone |
| `conformance-report.mjs` | Playwright JSON to a per-requirement conformance report |
| `report.mjs` | A session's trials to median [min-max] tables and a compact JSON |

## Outputs

`results/` holds the committed, small artifacts: conformance reports, the diff, and per-session summaries (`session-<stamp>.md` / `.json`). `results/raw/` (not committed) keeps every raw run record with all per-request samples, the per-trial summaries with CPU time series, run conditions, console logs, and post-run Postgres and Redis statistics.

## Fixed run conditions

- One podman machine (libkrun VM, 6 vCPU, 7.45 GiB) on macOS, shared with other projects; contention is detected per step.
- User-defined bridge networks, plain HTTP. The generator reaches either target over a bridge; `fpr`'s app reaches Postgres and Redis over its own bridge.
- Named volumes on the VM's disk, never tmpfs. Every trial restores the loaded state from a tar snapshot of the target's volume; Redis starts empty (no persistence), as does the reference's derived cache in its snapshot.
- The harness, its ladder, warm-up (10 s at the first rate), 50% quote share, 20 writes/s through each target's write surface, and the 750 in-flight ceiling are identical for both targets.
- CPU clock not pinned (impossible in this tier): no ops-per-gigacycle figure exists for any of these runs.
