# Budget points

A tier-2 [stack comparison](../../README.md#stack-comparisons) gives every target the same CPU and RAM, summed across all its processes. A **budget point** is one such pair. The first is 2 CPU / 2 GiB on `c4-standard-16-lssd` ([Instance](README.md#instance)). This file designs the second, **4 CPU / 4 GiB**, for later sessions.

> **Status, 2026-10-15: design only.** Nothing here has run. Every duration, fill time and saving below is an estimate, and each says what it rests on. The first full 2/2 session is running as this is written; its memory, disk-read and generator figures should replace the tier-1 calibration used here before any 4/4 session is planned.

## Why a second point, and why 4/4

Two reasons to measure beyond 2/2:

- **Fixed overheads.** 2 GiB is small for a three-process stack. Each process's runtime, binaries and buffers take a larger share of a small budget, which a reviewer could fairly call a handicap for the separated stack.
- **Realism.** 2 GiB is smaller than typical production deployments.

A second point is **a second measurement, never pooled with the first**. Both points use the same dataset, harness, ladder rules, warm-up rule and claim rules. Each point is its own set of sessions; a session runs one point, with every target interleaved in it. Results are reported per point ("on the same 4 CPU / 4 GiB …"). Comparing points means comparing each point's within-session result, such as whether the ranking held, never a ratio built from numbers taken in different sessions.

Why 4/4 and not 8/8: `DATA-004` requires a working set larger than memory. The pinned `bench` dataset is about 6 GB on disk per target: Harper's RocksDB measured 6.0 GB, and Postgres is estimated at 6–7 GB ([findings](../../comparisons/ecommerce-store-rough/findings.md#tier-2-readiness)). At 8 GiB most of it fits, so `DATA-004` would fail. At 4 GiB it still exceeds the budget (below). CPU and memory scale together, keeping 1 GiB per core as at 2/2; varying one alone is a different question.

## Instance and layout

### Machine type

All C4 `-lssd` shapes run on Granite Rapids. With `--threads-per-core=1` each visible CPU is a whole core, and billing stays per vCPU. Shapes from Google's [general-purpose machines](https://docs.cloud.google.com/compute/docs/general-purpose-machines) page, read 2026-10-15; prices from the Cloud Billing Catalog API, read 2026-10-15 (us-central1, on demand; C4 core $0.03465/h, RAM $0.003938/GiB-h, Titanium SSD $0.16/GiB-month at 730 h, all unchanged from 2026-10-14):

| Shape | Cores, SMT off | Memory | Titanium SSD | vNUMA nodes | Machine $/h | With boot disk and IPv4 |
|-|-|-|-|-|-|-|
| `c4-standard-16-lssd` (2/2 today) | 8 | 60 GB | 2 × 375 GiB | 1 | $0.955 | $0.97 |
| **`c4-standard-24-lssd`** | **12** | **90 GB** | **4 × 375 GiB** | **1** | **$1.515** | **$1.53** |
| `c4-standard-32-lssd` | 16 | 120 GB | 5 × 375 GiB | 1 | $1.992 | $2.00 |

Boot disk and address: 50 GiB of Hyperdisk Balanced at $0.08/GiB-month and an external IPv4 at $0.005/h, about $0.011/h together.

**Recommended: `c4-standard-24-lssd`.** It is the smallest shape that holds 2 OS cores, 4 target cores and the same 4-core generator slice as 2/2. `-16-lssd` has 8 cores, so 4/4 would cut the generator to 2 cores and make it differ between points. `-32-lssd` costs 31% more for four cores the layout has no use for. Google lists one vNUMA node for both candidates, so every slice is on one node by construction. Its table marks that node "shared", and `-48-lssd`'s "isolated", without defining either term; nothing here relies on them. Capacity for `-24-lssd` per zone is unknown until `vm.sh up` tries it.

### CPU layout

| CPUs | cgroup | Runs |
|-|-|-|
| 0–1 | `system.slice`, `user.slice`, `init.scope` | OS, Docker daemon, sampler, IRQs, unbound kernel work; as at 2/2 |
| 2–5 | `bench.slice/bench-target.slice` | Every process of the target, `MemoryMax=4G`, no swap |
| 6–9 | `bench.slice/bench-generator.slice` | The generator, 4 GiB; identical to 2/2 |
| 10–11 | none | Idle during trials; the clock probe's all-busy phase loads them |

**Generator share.** `bench/run.mjs` is single-threaded, so its headroom is one core plus room for garbage collection and libuv threads. The generator CPU recorded so far, all on tier 1 and `dev` ([session tables](../../comparisons/ecommerce-store-rough/results/session-20261014T204435Z.md)), was 0.07–0.17 cores at 400–2,400 rps, at most 0.47 at 8,000 rps, and its dispatch lag was flagged from about 5,600 rps ([findings](../../comparisons/ecommerce-store-rough/findings.md#measurement-traps), trap 4). Verification fails a step above 0.8 of a core. `bench` rates are far lower: the reference saturated near 133 rps at 2/2 on tier 1 from a dropped cache. Four cores leave three spare beyond the one its thread can use, and more cores would not raise its single-thread ceiling. Keeping four makes the generator identical at both points. Its tier-2 figures from the running 2/2 session should confirm this.

**OS share.** Two cores, as at 2/2. `sample.sh` records host-wide CPU, so the 2/2 session shows whether CPUs 0–1 are busy. If they are, CPUs 10–11 join them (`HOUSEKEEPING_CPUS=0-1,10-11`), recorded with the run.

### What the scripts would need

Described, not implemented.

[`host-setup.sh`](host-setup.sh) already reads `HOUSEKEEPING_CPUS`, `TARGET_CPUS`, `GENERATOR_CPUS`, `TARGET_MEMORY` and `GENERATOR_MEMORY`, so `sudo HOUSEKEEPING_CPUS=0-1 TARGET_CPUS=2-5 GENERATOR_CPUS=6-9 TARGET_MEMORY=4G bash host-setup.sh` would build this layout today (`sudo` drops the caller's environment, so the values go on its command line). It needs:

1. A named point (`BUDGET_POINT=2c2g|4c4g`) that sets all five values together, so a session cannot mix 4 CPUs with 2 GiB.
2. Its CPU-count check derived from the layout, not fixed at 8.
3. A check that each slice's CPUs sit in one NUMA node (`/sys/devices/system/node/node*/cpulist`), failing otherwise.
4. The point written to `/var/lib/arch-bench`, for `conditions.sh` to record.

`probe-clock.sh`, `sample.sh` and `conditions.sh` read CPUs from the slices and need no change.

[`vm.sh`](vm.sh) already takes `MACHINE=c4-standard-24-lssd`, and its `c4-*` case applies the same SMT, turbo and PMU flags. It needs a `budget` label beside `session` for billing attribution, and a `MAX_RUN` default per point (see [Session time](#session-time-and-cost-at-44)). Parallel VMs and a baked image need more; see [Faster sessions](#faster-sessions).

The targets take their budget from variables that already exist: ecommerce-store `TARGET_CPUS=4 TARGET_MEMORY=4g HARPER_THREADS=4`, and this repo's comparison `TARGET_CPUS=4 TARGET_MEMORY_MIB=4096` plus the split below.

## Target sizing at 4 GiB

A container cannot see its slice's limits ([Host](README.md#host)), so every process is sized explicitly, at both points.

**Harper.** Its thread count is set (`HARPER_THREADS`), but its worker heaps and RocksDB block cache are sized from `process.constrainedMemory()`, the container's limit: an [open gap](ecommerce-store-gaps.md#open). Harper 5.3.2's rules give each worker an old-space limit of the larger of memory ÷ (10 + threads ÷ 4) and 512 MiB, and a block cache of 25% of memory, with a write buffer manager a third of that, charged to it. At 4 GiB and 4 threads that is 512 MiB per worker and 1 GiB of block cache. **Recommendation:** set the values the rules give now, explicitly, through `HARPER_SET_CONFIG`, and record them with the budget:

| Point | `threads.count` | `threads.maxHeapMemory` (MiB) | `storage.rocks.blockCacheSize` (bytes) |
|-|-|-|-|
| 2/2 | 2 | 512 | 536870912 (512 MiB) |
| 4/4 | 4 | 512 | 1073741824 (1 GiB) |

This leaves 2/2 unchanged, and a Harper release that changes its defaults can no longer change the sizing silently. The container keeps a memory limit equal to the budget, which verification requires. The heap figure is a ceiling, not a reservation: at 2/2 on tier 1, anonymous memory levelled at 973 MiB, block cache included. At 4/4, with a 1 GiB block cache and four workers, the estimate is 1.7–1.9 GiB.

**Fastify + Postgres + Redis.** `scripts/run.sh` derives every process setting from the memory split and the worker count. Scale both and keep the runbook's [shares](../../comparisons/ecommerce-store-rough/runbook-tier2.md#memory-sizing-in-the-target-slice): Postgres largest, because its working set is the one larger than memory.

| Container | 2/2 | 4/4 | 4/4 sizing, by `run.sh`'s rules |
|-|-|-|-|
| app | 512 MiB, 2 workers | 1,024 MiB, 4 workers | Node heap cap (1,024 − 192) ÷ 4 = 208 MiB per process |
| postgres | 1,280 MiB | 2,560 MiB | `shared_buffers` 640 MB, `effective_cache_size` 1,920 MB, `work_mem` 4 MB |
| redis | 256 MiB | 512 MiB | `maxmemory` 307 MB, `allkeys-lru` |

`APP_MEMORY_MIB=1024 PG_MEMORY_MIB=2560 REDIS_MEMORY_MIB=512 APP_WORKERS=4`. One worker per core, as at 2/2. Four workers with 8-connection pools hold 32 Postgres connections; `max_connections` 40 still covers them and the stats poll. `MEMORY_SPLIT=slice` stays the sensitivity. The expected `DATA-004` basis is Postgres against its own 2,560 MiB.

## `DATA-004` and warm-up at 4 GiB

### Does the dataset still exceed the budget?

Yes, by less:

| Target | On disk | Against its `DATA-004` basis at 2/2 | At 4/4 |
|-|-|-|-|
| Harper | 6.0 GB (5.6 GiB), measured | 2.8 × 2 GiB | 1.4 × 4 GiB |
| Postgres | 6–7 GB (5.6–6.5 GiB), estimated | 4.5–5.2 × 1,280 MiB | 2.2–2.6 × 2,560 MiB |

Page cache gets only part of the budget. For Harper at 4/4, about 2.2 GiB of page cache (after an estimated 1.8 GiB of anonymous memory) faces 5.6 GiB on disk, so the target should keep reading.

### How long the cache takes to fill

**Estimate, calibrated on one tier-1 soak of Harper at 2 GiB.** At 100 rps from a dropped cache, the target read 531 MiB from disk in 10 minutes, about 22 MiB a minute at the end. Its page cache reached 769 MiB, and its memory 1,774 MiB (87%). `DATA-004` needs `memory.peak` at 90% of the limit: 3,686 MiB at 4 GiB. With about 1.8 GiB anonymous, page cache must grow by about 1.1 GiB past the soak's 10-minute point.

- **Linear lower bound.** At the soak's final 22 MiB a minute: about 50 more minutes, so about 60 minutes at 100 rps.
- **Model.** Disk reads fall as the cache warms. A fit to the soak (about 270 MiB of fixed reads, then reads proportional to new keys under the workload's Zipf over 2,000,000 products) puts the fill at **440,000–520,000 requests from cold: 75–85 minutes at 100 rps, about 40 at 200 rps.** The same fit gives 13 minutes to 90% at 2 GiB, against 20 minutes of warm-up.
- **The current warm-up is not enough.** 120,000 requests leave Harper at an estimated 70% of 4 GiB. Verification would fail `DATA-004`, and the ladder would measure a cache still filling.
- **Still reading.** At the fill point, the model has Harper reading 10–15 MiB a minute at 100 rps. That is far above the verifier's 1 MiB per step, so the second half of `DATA-004` should hold.
- **Postgres is not modelled.** Hot keys are scrambled across the key space, so each 8 KiB heap page read for a hot row is mostly cold rows. Postgres plausibly reads more bytes per new key and fills sooner. The running 2/2 session's per-step Postgres memory and disk reads will show this.

### The warm-up has to be keyed on the budget point

`WARMUP` in ecommerce-store [`packages/spec/src/workload.ts`](https://github.com/HarperFast/ecommerce-store/blob/f47978bfc956f859aa2a0bc417a77ea50e12b25e/packages/spec/src/workload.ts#L140-L154) is keyed on dataset scale alone. `bench/run.mjs` picks it from the manifest's scale, and `scripts/verify-run-record.mjs` fails any other value. A second point needs a warm-up keyed on **(scale, budget point)**: the same volume and rate for every target at a point, free to differ between points. A higher rate keeps it short; it must be a rate every target sustains from a dropped cache without shedding, because a shed warm-up request warms nothing.

The ecommerce-store change, described, not made:

1. **`packages/spec/src/workload.ts`.** `WARMUP.bench` becomes a map by point: `2c2g` keeps 120,000 at 100 rps, and `4c4g` gets the calibrated value. `dev` stays scale-only. An unknown `bench` point has no default.
2. **`bench/run.mjs`.** It takes the point from the orchestrator (`--budget-point`, from `TARGET_CPUS` and `TARGET_MEMORY`), records it under the run record's harness settings, and picks the warm-up from it.
3. **`scripts/verify-run-record.mjs`.** It derives the expected warm-up from the budget the orchestrator recorded, `orchestrator.target.budget` and the applied memory limit, not from the harness's own claim, and fails an unknown point.
4. **`containers/run-benchmark.sh`.** It passes the point. This repo's `scripts/run.sh` does the same, and `scripts/session.sh`'s `TRIAL_MINUTES` default follows the point.
5. **Docs.** A dated decision in `docs/plan.md`, and the warm-up row in `bench/README.md`.

**Calibrating it.** The 2/2 value came from a 10-minute soak. The 4/4 value should come from a soak of every target at 4/4, from a dropped cache, at the candidate rate. It sets the request count so the slowest-filling target reaches 90% of its basis with the margin the same model gives 2/2, about 1.5 times. **Placeholder until then: 200 rps, the 2/2 rate per core, and 600,000–750,000 requests, about 50–60 minutes.** The 4/4 ladder is the same for every target. It may need a step above 1,600 rps; the 2/2 session will show whether the stack still has headroom there.

## Session time and cost at 4/4

**Estimates.** A trial is about 1.5 minutes of restore and cold start, the warm-up, about 8 minutes of ladder, and 1.5 minutes of checks. That is 50–70 minutes, against 30 at 2/2. Before trials: about 30 minutes to provision and qualify, 15 for code and data, and about 35 for seeding both targets on four target cores (unmeasured). Keep an hour for collection and teardown. That is about 2.3 hours outside trials.

| Warm-up at 200 rps | Trial | Trials in 8 h | Two targets × three trials | Session cost at $1.53/h |
|-|-|-|-|-|
| 40 min (480,000) | ~51 min | 6, no re-runs | ~7.4 h | ~$11 |
| 50 min (600,000) | ~61 min | 5 | ~8.4 h, `MAX_RUN=9h` | ~$13 |
| 60 min (720,000) | ~71 min | 4 | ~9.4 h, `MAX_RUN=10h` | ~$14.50 |

A trial costs $1.30–1.80, against about $0.50 at 2/2. The work around the trials (provisioning, code and data, seeding, collection: about 1.6 hours) costs about $2.40 per VM, against about $1.50 at 2/2. A forgotten VM costs at most `MAX_RUN` × $1.53: $12 for 8 hours, $15 for 10. The self-delete deadline can be raised for a 4/4 session (`MAX_RUN`), or the trials split across parallel VMs, below.

## Faster sessions

Options for later sessions, none built yet.

**(a) Parallel VMs, each a complete session.** Run N identical VMs. Each seeds, qualifies its clock, and interleaves every target, so "measure every target in one session" holds on each VM. Report a ratio per VM, judging each VM's trials against its own clock median; never pool raw numbers across VMs. Cost per trial is unchanged, plus the setup each VM repeats (about $1.50 at 2/2, $2.40 at 4/4), and wall-clock time falls by about N. The spread of per-VM ratios also measures host-to-host variance at no extra cost. Limits: the project's 300 C4 vCPUs allow 12 VMs of `-24-lssd`, and its 25,000 GB of C4 local SSD allows 15. The regional `IN_USE_ADDRESSES` quota, shown by `vm.sh preflight`, and zone capacity are unchecked. `vm.sh` needs a distinct `NAME` per VM, and `down` must check only its own session's resources: today it fails if any `arch-bench` VM remains.

**(b) A baked boot image.** Debian 13 with every package `host-setup.sh` installs, Docker Engine and Compose, perf and Node 24. It also holds the base images, pulled by digest and saved to the boot disk, because Docker's data root is on local SSD, which is empty at every boot. And it holds the LFS objects of the pinned dataset. It is only a delivery mechanism. The machine type and flags are the same, and `host-setup.sh` still runs at boot to build the RAID, the slices and the kernel settings, skipping installs already present. Every target is still seeded fresh each session ([decision 7](README.md#decisions)), and `prepare-dataset.mjs` still checks every table's SHA-256. `vm.sh` would take `IMAGE` in place of the `debian-13` family. The image name and ID go into the run conditions; `vm.sh describe` would read the boot disk's source image. Rebuild the image when any content changes: a package, a base-image digest, or the dataset. Storage is $0.05/GiB-month (Catalog API, 2026-10-15), under $1 a month for a 15 GiB image. Estimated saving, unverified: 10–15 minutes per VM, and the LFS bandwidth of each pull.

**(c) Seeding on all cores.** Seeding is not measured, so the databases could seed in a seed slice spanning CPUs 2–11, with each container's memory limit and process settings unchanged, then snapshot as now. Only CPU differs. Memory settings shape the on-disk result: RocksDB's write buffers and compactions decide its file layout, and Postgres's `maintenance_work_mem` affects index builds. Changing them could change what trials read. A seed that does not fit in the target's memory still fails at seeding, as now. The snapshot's provenance would record the seed placement. Estimated saving, **unverified**: Harper's seed took 1,116 s on two tier-1 cores. If seeding is CPU-bound in the target, ten cores might cut both targets' seeding from about 35 minutes to 15–20. The loaders may become the limit first.

## Budget

The project's budget is $500 a month from 2026-10-15 ([decision 2](README.md#decisions)). That is about 30 ten-hour 4/4 sessions a month at $1.53/h, or about 60 eight-hour 2/2 sessions at $0.97/h. The budget counts usage before credits, so it alerts on what the sessions cost, not on what the account pays.

## Sources

Read 2026-10-15: [general-purpose machine families](https://docs.cloud.google.com/compute/docs/general-purpose-machines) (C4 `-lssd` shapes, Titanium SSD counts, vNUMA nodes, Granite Rapids on every `-lssd` shape), [`gcloud billing budgets update`](https://docs.cloud.google.com/sdk/gcloud/reference/billing/budgets/update), and the Cloud Billing Catalog API for Compute Engine (service `6F81-5844-456A`): SKUs `4AA0-9497-B351` (C4 core), `E259-34D3-C50F` (C4 RAM), `E0C4-9777-003A` (C4 local SSD), `83FF-9C17-D184` (Hyperdisk Balanced capacity), `C054-7F72-A02E` (external IPv4) and `DAA2-253C-6680` (image storage). Harper 5.3.2's sizing rules from `server/threads/manageThreads.js` and `utility/rocksMemoryConfig.ts` at tag `v5.3.2`. Tier-1 calibration from ecommerce-store [`docs/plan.md`](https://github.com/HarperFast/ecommerce-store/blob/f47978bfc956f859aa2a0bc417a77ea50e12b25e/docs/plan.md#bench-scale-observations-on-dataset-050-2026-10-14) at `f47978b`.
