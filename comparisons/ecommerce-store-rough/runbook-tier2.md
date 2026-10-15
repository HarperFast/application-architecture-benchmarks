# Runbook: one tier-2 `bench` session, Harper reference vs Fastify + Postgres + Redis

The first tier-2 session is exploratory: step 0 for tier 2, not a publishable result. It runs both targets, and optionally the reference's unbatched build, against the `bench` dataset on the GCP host of [`environments/gcp`](../../environments/gcp/README.md), interleaved in one session, with every trial restored, cold-started on a dropped page cache, warmed up identically, sampled for cycles, and verified.

The host is set up, qualified and torn down exactly as `environments/gcp/README.md` says; this runbook does not repeat it, and points to its section for each of those steps.

What is tested and what is not is listed at the end. Nothing in the tier-2 path that needs the Linux host (slices, Docker's cgroup layout, `perf`, `sample.sh`, `conditions.sh`, `drop_caches` on the host) has run yet.

## Pinned inputs

| Input | Value |
|-|-|
| ecommerce-store | `main` at `f47978b` (where #4 merged), dataset generator 0.5.0 |
| application-architecture-benchmarks | the commit of this runbook: `main` from `2529e09`, where `environments/gcp` (#5) and this comparison (#6) merged, or the session's own branch |
| Machine | `c4-standard-16-lssd`, ALL_CORE_MAX, PMU, SMT off (`environments/gcp` "Instance") |
| Ladder | `25,50,100,200,400,800,1600` rps, 60 s steps; 50% quotes, 20 writes/s |
| Warm-up | the harness's fixed `bench` warm-up, 120,000 requests at 100 rps (`WARMUP` in ecommerce-store `packages/spec`), identical for every target |
| Arrivals | seeded Poisson, the harness's `bench` default (`PUBLISHED_RUN`), the same arrival times for every target |
| Budget | `bench-target.slice`: CPUs 2-3, `MemoryMax=2G`, no swap, every target container in it, no CPU quotas |
| Generator | `bench-generator.slice` (CPUs 4-7), container limit 4 CPU / 3 GiB, the same for every target |

## 1. Provision, set up the host, qualify the clock

`environments/gcp/README.md`, "Session procedure" steps 1 and 2. Keep the session directory `S=/mnt/lssd/out/$SESSION` and the probe's drift threshold; everything below runs on the VM, inside `tmux`.

## 2. Code and data

`environments/gcp/README.md` step 3 checks out ecommerce-store at the pinned commit, pulls its LFS objects, and expands and verifies the `bench` dataset (`scripts/prepare-dataset.mjs --scale bench`, about 4.3 GB under `.work/dataset/bench`). Two additions:

```bash
cd /mnt/lssd/src/ecommerce-store && npm install --ignore-scripts --no-audit --no-fund   # the harness and verify-run-record import @ecommerce-store/spec from the workspace; run.sh stops early without it
git -C /mnt/lssd/src/application-architecture-benchmarks checkout <commit of this runbook>
```

## 3. Configure the comparison

```bash
cd /mnt/lssd/src/application-architecture-benchmarks/comparisons/ecommerce-store-rough
export TIER=2 SCALE=bench ECOMMERCE_STORE_DIR=/mnt/lssd/src/ecommerce-store
scripts/run.sh setup        # writes .env: the checkout path and a random Harper admin password, a test credential that never leaves the VM
```

`TIER=2` makes `scripts/run.sh` use Docker, layer [`compose.tier2.yaml`](compose.tier2.yaml) (every target container in `bench-target.slice` with no CPU quota; the generator and loaders in `bench-generator.slice`), drop the host's page cache before every cold start, keep snapshots uncompressed, and record tier 2 in every run record. `SCALE=bench` is refused on tier 1.

## 4. Seed and snapshot each target (not measured)

```bash
scripts/run.sh load fpr       # verify the 8 tables against MANIFEST.json, COPY them into Postgres, build keys and indexes, VACUUM ANALYZE, snapshot the volume
scripts/run.sh load harper    # build the reference image, seed it over its operations API (ecommerce-store scripts/load-dataset.mjs), snapshot its volume
```

| | `fpr` | `harper` |
|-|-|-|
| Estimate | 10-20 min. Verification takes about 6 s and client-side encoding about 45 s (measured locally on `bench`, without loading); the rest is Postgres writing about 6 GB on two cores inside a 1,280 MiB container, then the indexes and foreign keys | about 20 min (`environments/gcp` step 3) |
| Disk | about 7 GB volume plus a 7 GB uncompressed snapshot | the reference's volume plus its snapshot |

The `fpr` loader runs in the generator slice; Postgres stays in the target slice with the same memory sizing it is measured under, so a load that does not fit there fails here rather than during a trial. The `harper-unbatched` build restores `harper`'s snapshot and has no load of its own; `scripts/session.sh` builds it.

## 5. Run the session

Record the session's host conditions once, then start the session. Do not also start the session-wide sampler from the `environments/gcp` procedure: `scripts/run.sh` runs `sample.sh` around each trial, and two `perf` instances would multiplex the counters.

```bash
sudo bash ~/conditions.sh $S/conditions /mnt/lssd/src/*
SESSION_MINUTES=$(( 480 - $(awk '{print int($1 / 60)}' /proc/uptime) - 60 )) \
SAMPLE_SH=$HOME/sample.sh CONDITIONS_SH=$HOME/conditions.sh TARGETS="harper fpr" SESSION_TRIALS=3 scripts/session.sh
```

Add `harper-unbatched` to `TARGETS` for the quote-batching A/B; it builds the reference from `HARPER_UNBATCHED_REF` (default `dd3a5f5^`) with ecommerce-store's own build variables, and is refused if that commit's schema differs from the checkout's.

Rounds alternate the order (`harper fpr`, then `fpr harper`, ...). For each trial, `scripts/run.sh bench <target>`:

1. Stops every target, so nothing else is resident in `bench-target.slice`.
2. Restores the target's snapshot into its volume, from a helper container in the target slice: delete, then untar.
3. Starts `sample.sh` as its own system unit (`arch-bench-sampler-<stamp>`, on the housekeeping CPUs), writing to `results/raw/samples-<target>-<stamp>/`.
4. Drops the page cache (`sync; echo 3 | sudo tee /proc/sys/vm/drop_caches`) and starts every process of the target at once; the reference's outside probe times the first successful product response.
5. Runs the harness from the generator container, unmodified: the fixed warm-up, then the ladder, accounting the target's CPU, memory, page cache and disk reads per container. For `fpr`, it also polls `/__stats` every 2 s for the cache and buffer counters per step.
6. Joins the samples' cycles into the run record with ecommerce-store's `bench/cycles.mjs --write` (the join its own orchestrator runs with `SAMPLES_DIR`), stops the sampler, runs ecommerce-store's `verify-run-record.mjs` (which on tier 2 also fails a step without cycles, a target outside the slice or without its own memory limit, and on `bench` steps under 60 s, non-Poisson arrivals or base images not pinned by digest), checks `maintenance.log` for a migration or termination notice, runs `conditions.sh` into `results/raw/hostconditions-<target>-<stamp>/`, and for `fpr` the coherence audit. For the reference it also records, from inside the running target, the worker heap and RocksDB block-cache sizes Harper resolved from its 2 GiB container limit, with the inputs and the source lines of the rules it read (`results/raw/harper-memory-<target>-<stamp>.json`); the report prints them per trial.
7. Stops the target.

A trial that fails verification or the cycle join, saw a maintenance event, or had another container in the target slice is set aside and re-run (up to `MAX_ATTEMPTS` attempts, default 3, and only while `SESSION_MINUTES` allows). The set-aside attempt stays on disk and in the session log; nothing is deleted.

### What fits before the VM deletes itself

The VM deletes itself 8 h after boot (`vm.sh`, `MAX_RUN`). A trial takes about 30 min: 1 min of restore and cold start, 20 min of warm-up, seven 60 s steps with their drains (about 8 min), and 1 to 2 min of checks. Before the session:

| Phase | Time |
|-|-|
| Provision, host setup, clock probe (steps 1-2) | about 30 min |
| Code and data, the workspace install (step 2) | about 15 min |
| Seeding `fpr` and `harper` (step 4) | about 40 min |
| Collection and teardown, with margin (step 7) | keep 1 h |

That leaves about 5.5 h, or 9 to 10 trials with no re-runs. The default, three rounds of `harper fpr`, is 6 trials and about 3 h, which leaves room for re-runs. The A/B fits as two rounds of `harper fpr harper-unbatched` (6 trials); three rounds of it (9 trials, about 4.5 h) fit only if nothing is re-run. Either way, set `SESSION_MINUTES` so the session stops starting trials while there is still time to collect:

```bash
SESSION_MINUTES=$(( 480 - $(awk '{print int($1 / 60)}' /proc/uptime) - 60 ))   # minutes to the self-delete, less an hour
```

`TRIAL_MINUTES` (default 35 on `bench`) is how long the session assumes the next trial needs. At the recommended instance's $1/h, a full 8 h session costs about $8.

Watch it with short ssh calls (`tail results/raw/trials.log`); every trial line names its verdict.

## 6. Report

```bash
node scripts/report.mjs results/raw/session-<stamp>.log > results/session-<stamp>.md
```

Per target and step: median and range across accepted trials of throughput, latency, CPU per request, memory, disk reads; for `fpr`, entity, aggregate and Redis keyspace hit rates, evictions, Postgres buffer hit rate and blocks read; on tier 2, gigacycles, effective GHz, IPC and ops per gigacycle, with any step whose clock left the session median by more than 2% marked (set `DRIFT` to the probe's threshold if it is larger).

## 7. Collect and tear down

Copy `results/raw/` (every run record, summary, conditions, verification, console, sample directory, host conditions and the session log) and `results/session-<stamp>.*` into `$S`, then follow `environments/gcp/README.md` step 6. Snapshots are not kept: every session re-seeds.

## Restore strategy

Every trial starts from the same bytes. After seeding, each target's stateful volume is archived once per session with a clean shutdown first (Postgres gets 120 s to checkpoint, so no restore replays WAL). Before every trial the volume is emptied and the archive extracted into it by a helper container in the target slice, the host's page cache is dropped, and only then does the target start. Redis has no persistence, so it starts empty in every trial; Harper's derived product view is restored as the seed left it. On tier 2 the archives are uncompressed tar on the local SSD (about 30-60 s to restore 7 GB); on tier 1 they are gzipped.

## Memory sizing in the target slice

Each `fpr` container has its own memory limit, and every process is sized from that limit explicitly, because a container cannot see its slice's limits:

| Container | Limit | Sizing |
|-|-|-|
| app | 512 MiB | 2 workers; Node heap cap 160 MiB per process (primary and each worker) |
| postgres | 1,280 MiB | `shared_buffers` 320 MB, `effective_cache_size` 960 MB, `work_mem` 4 MB, `maintenance_work_mem` 64 MB (256 MB while loading) |
| redis | 256 MiB | `maxmemory` 153 MB, `allkeys-lru` |

`MEMORY_SPLIT=slice` removes the per-container memory limits (each container may use the slice's 2 GiB) while keeping the same process sizing; it is a sensitivity, not the default.

On `bench`, `verify-run-record.mjs` judges DATA-004's memory evidence per cgroup: each container against its own limit, and the summed peaks against the 2 GiB budget. One of them must be pressed (`memory.peak` at 90% of its limit or more) and still reading (at least 1 MiB of disk reads or a refault in every measured step). Each trial's verdict line in `results/raw/trials.log` carries the `DATA-004 memory basis:` that met it; for this stack it should be Postgres against its 1,280 MiB.

## Not yet tested

Tested locally on `dev` with tier-1 placement: the whole trial and session path, three targets alternating, the unbatched build, `/__stats` polling, the report, the loader's `--verify-only` and `--encode-only` against `bench` (no `bench` data was loaded locally), and ecommerce-store's cycle join against synthetic `sample.sh` output.

Untested until the first session:

- `compose.tier2.yaml` under Docker with the systemd cgroup driver, and `cgroup_parent: bench-target.slice` for a three-container target.
- Discovering Docker container scopes (`docker-<id>.scope`) from the host and from the generator, and the wrapper's tier-2 accounting (target-slice intruders, generator-slice neighbours, containers misplaced in `system.slice`).
- `sudo systemd-run` of `sample.sh` per trial, and `conditions.sh` per trial.
- The cycle join against real `perf stat --for-each-cgroup -x,` output: the qualification recorded per-CPU CSV and a human-readable cgroup-mode summary, not cgroup-mode CSV, so that layout is inferred from perf's documentation.
- Running the join in the generator container against a per-trial sample directory owned by root.
- Loading `bench` into Postgres, its time and disk, and the uncompressed snapshot's restore time.
- DATA-004's memory evidence for either target on `bench`.
