# Findings: ecommerce-store on tier 2, Harper reference vs Fastify + Postgres + Redis (step 0 for tier 2)

**Status:** exploratory, step 0 for [tier 2](../../README.md#environment-tiers). The first `bench` sessions on the GCP Linux host of [`environments/gcp`](../../environments/gcp/README.md), 2026-10-15 to 16. **Nothing here is a result, and nothing here may be published or quoted as one.** It records where a first tier-2 measurement lands, how large the effect looks, what the clock and memory evidence show, which traps appeared, and what the published comparison needs next. Tier-1 findings are in [findings.md](findings.md).

Every comparison below is between two whole applications on the same budget: the Harper reference application, and an application assembled from Fastify, Postgres and Redis. None of it describes Fastify, Postgres or Redis as projects. Where the assembled stack does better, the methodology says to publish it, investigate it, and first suspect the reference's own implementation; [Where the reference's time goes](#where-the-references-time-goes) starts that.

## Sessions

| | Session 1 | Session 2 |
|-|-|-|
| Question | Harper reference vs Fastify + Postgres + Redis | The reference's quote-read batching: the checkout against `dd3a5f5^` |
| Targets, rounds | `harper fpr`, 3 rounds alternating | `harper harper-unbatched`, 3 rounds alternating |
| Report | [session-20261015T222926Z.md](results/session-20261015T222926Z.md) | [session-20261015T231012Z.md](results/session-20261015T231012Z.md) |
| Host | `c4-standard-16-lssd`, `us-east5-a` | `c4-standard-16-lssd`, `us-east4-a` |
| Trials accepted | 6 of 6, none set aside | 6 of 6, none set aside |
| Clock probe | 3.899 / 3.897 GHz (target only / all busy), 0.1% spread | 3.897 / 3.897 GHz, 0.2% spread |
| application-architecture-benchmarks | `e4f5ed7` | `d340f68` (adds only the unbatched build fix) |

The two sessions ran at the same time on separate VMs in different regions, so they share no host. Each compares only its own targets: the methodology's "measure every target in one session". Nothing here divides a session-1 figure by a session-2 figure. The reference's checkout build ran in both: 131 to 148 rps at saturation in session 1, 137 to 148 in session 2, a spread within each session as large as any difference between them ([trial-to-trial variation](#trial-to-trial-variation)).

Common to both: ecommerce-store `main` at `f47978b` (Harper 5.3.2, dataset generator 0.5.0, `bench`: 2,000,000 products, 6,570,143 variants, 31,281,273 inventory rows, 5,000 promotions); Debian 13, kernel 6.12.111, Docker 29.9.1 with the systemd cgroup driver; `ALL_CORE_MAX`, architectural PMU, one thread per core; the target in `bench-target.slice` (CPUs 2-3, `MemoryMax=2G`, no swap), the generator in `bench-generator.slice` (CPUs 4-7) with a 4-CPU, 3 GiB container. Ladder 25, 50, 100, 200, 400, 800, 1,600 rps, 60 s steps, seeded Poisson arrivals, 50% quotes, 20 writes/s; the fixed `bench` warm-up of 120,000 requests at 100 rps before every ladder; every trial restored from the session's snapshot and cold-started on a dropped page cache. Base images are pinned by digest; image digests, commits and host conditions are in each trial's records.

## Where it lands

Session 1, three accepted trials per target, median [min-max] ([tables](results/session-20261015T222926Z.md)):

| | Harper reference | Fastify + Postgres + Redis |
|-|-|-|
| Highest offered rate served without shedding in every trial | 100 rps | 400 rps (at 800, one trial shed nothing, the others 75 and 5,441 arrivals) |
| Throughput at saturation (1,600 offered) | 142 [131-148] rps | 795 [736-819] rps |
| p99 at 100 rps | 280 [234-377] ms | 15.8 [14.9-18.1] ms |
| Target CPU per successful request at 100 rps | 13.6 [13.1-14.4] ms | 3.4 [3.3-3.9] ms |
| Ops per gigacycle at 100 rps | 19 [18-20] | 80 [70-83] |
| Ops per gigacycle at saturation | 19 [17-20] | 104 [96-107] |
| Effective clock at saturation | 3.887 GHz | 3.839 GHz |
| Cold start to first 200, page cache dropped | 4.16 [4.14-4.23] s | 2.55 [2.51-2.59] s |
| Target memory peak (budget 2,048 MiB) | 2,048 MiB | 1,709 MiB summed |

- **On `bench`, at 2 CPU / 2 GiB, the assembled application served about 5.5 times the requests per second of the Harper reference application, at about a quarter of the CPU per request.** Both saturated their two cores (1.94 to 1.99 cores). Their ranges of CPU per request and of ops per gigacycle do not overlap at any step. Cycles say the same as CPU time: 104 against 19 successful requests per gigacycle at saturation, all-core turbo, measured at 3.84 and 3.89 GHz.
- **The gap is far larger than on tier 1.** On `dev` the reference reached about 2,000 rps and the stack about 4,800 ([findings.md](findings.md#where-it-lands)), a factor of about 2.4. Near saturation, the reference's CPU per request rose about 20-fold from `dev` to `bench` (0.66 → 13.5 ms) and the stack's about 8-fold (0.33 → 2.5 ms; its tier-1 figure also left out about half a core of uncharged kernel time). The difference is in the quote; see below.
- **Kernel time no cgroup was charged for is about zero for both targets here** (-0.03 to -0.01 cores per step: sampling noise), against 0.5 to 0.6 cores for the stack on tier 1 ([trap 1](findings.md#measurement-traps)). On the Linux host no busy CPU time went unaccounted: the kernel's work for the bridge traffic between the stack's containers was charged to some cgroup, most likely the target's own, since it runs on the target's CPUs; which one was not measured. The tier-1 gap came from the VM, not the architecture.
- **The generator had headroom in every step of every trial:** dispatch-lag p99 at most 2.71 ms, generator CPU at most 0.08 of a core, process RSS at most 500 MiB. Its cgroup peak reached its 3 GiB limit, which is page cache from reading the dataset files to plan the workload, not process memory.
- **Correctness guards:** every `fpr` trial's coherence audit compared 6,884 cached responses (300 of the products the run wrote, in all 16 views, 99 it did not, and the 500 hottest carts' quotes) with the same responses computed from Postgres alone: all identical. The reference was verified by `verify-run-record.mjs` only; neither target has a ground-truth guard yet.

## Where the reference's time goes

Diagnostics on session 1's host after the session, not measurements: one request at a time on a freshly restored target, after a short warm-up of the hottest keys (`scripts/run.sh timing`, `scripts/promotion-probe.sh`; raw output kept with the session).

- **The quote's reads.** From each target's own `Server-Timing` for the 400 hottest carts, the reference's quote spent a median 19.1 ms in `data` and 0.3 ms in `compute`; the stack's 1.9 ms and 0.2 ms. Product aggregates for the hottest products took about 0.1 ms on both. On `dev` (tier 1, the same diagnostic) the reference's quote `data` phase was 1.1 ms against the stack's 0.6 ms.
- **The promotion candidates are a large part of it.** For a gold-tier customer and three categories, 619 of the 5,000 `bench` promotions pass both of `quote.js`'s indexed conditions (`tierKeys in [tier, *]`, `categoryKeys in [categories…, *]`); the tier condition alone matches 2,164 and the categories alone 1,478. Over the reference's REST interface, the two-condition search took a median 7 to 10 ms (by condition order, and ids or full rows), about what each single condition costs (6.9 and 8.9 ms with full rows) and about an eighth of a whole-table read (68 ms). The stack's query for the same values took 0.75 ms in Postgres: a bitmap scan of the category GIN index filtered by tier, 146 shared-buffer hits. In session 1's trials the stack's candidate query averaged 649 rows and 1.0 ms per quote (`pg_stat_statements`). `dev` has 160 promotions, which is why tier 1 never showed this.
- **What that suggests, for the Harper side to confirm:** the reference's search reads and filters every row matching one condition rather than intersecting the two indexes, and the quote's other reads (variants, products, inventory) cost more on `bench` than on `dev` as well: the REST timing of the search, which also includes HTTP and serializing 619 rows, is at most about half of the quote's 19 ms. Both are Harper engineering questions before they are comparison results. The [batching A/B](#quote-read-batching) tested one answer to the second, and it did not move the quote.

## DATA-004

Every trial of every target met `DATA-004`'s memory evidence on `bench`, the first time any target has ([plan](https://github.com/HarperFast/ecommerce-store/blob/f47978bfc956f859aa2a0bc417a77ea50e12b25e/docs/plan.md)). The verifier's `DATA-004 memory basis:` line for each trial:

| Session, trial | Basis | Peak against limit |
|-|-|-|
| 1, `harper` 20261015T222927Z, 20261015T235432Z, 20261016T002257Z | per cgroup: harper against its own 2048 MiB limit | 2,048 MiB (100%), reading from disk in every step |
| 1, `fpr` 20261015T225753Z, 20261015T232613Z, 20261016T005123Z | per cgroup: postgres against its own 1280 MiB limit | 1,280 MiB (100%), reading from disk in every step |
| 2, `harper` 20261015T231013Z, 20261016T003534Z, 20261016T010401Z | per cgroup: harper against its own 2048 MiB limit | 2,047 to 2,048 MiB, reading from disk in every step |
| 2, `harper-unbatched` 20261015T233839Z, 20261016T000704Z, 20261016T013227Z | per cgroup: harper against its own 2048 MiB limit | 2,045 to 2,048 MiB, reading from disk in every step |

- **The reference** held about 1.05 to 1.10 GiB of anonymous memory and 0.91 to 0.96 GiB of page cache at its limit (session 1, trial 1), and read 6 to 28 MiB from disk per step, with almost no refaults: the cold tail it reads is small, and what it rereads stays in its block cache or page cache.
- **The stack** filled Postgres's 1,280 MiB container and read 0.19 to 3.8 GB from disk per step, rising with the rate; Redis peaked at 183 to 185 MiB of 256 (72%) and the app at 246 to 247 MiB of 512 (48%), neither reading from disk. The basis is the one the runbook predicted.
- **The reference's memory sizes,** recorded from inside the running target after each trial (`harper-memory-<target>-<stamp>.json`): every trial, of every build, in both sessions resolved the same values from `process.constrainedMemory()` = 2,048 MiB with `threads.maxHeapMemory` and `storage.rocks.blockCacheSize` unset: 512 MiB of old space per worker (Harper's floor; 2,048 ÷ 10.5 would give 195), 16 MiB of young space, a 512 MiB RocksDB block cache and a 171 MiB write-buffer manager. Two workers' heap limits plus the block cache come to 1.5 GiB of a 2 GiB budget, before page cache and native memory. Nothing was changed mid-comparison; whether to configure them explicitly is still [open](../../environments/gcp/ecommerce-store-gaps.md#open).

## The cache-hit picture

The stack's counters, per step, median of three trials (`/__stats`, polled every 2 s):

| Offered rps | Entity cache hit | Aggregate cache hit | Redis keyspace hit | Redis evictions | Postgres buffer hit | Postgres blocks read | Disk reads |
|-|-|-|-|-|-|-|-|
| 25 | 47.5% | 4.0% | 23.8% | 0 | 93.5% | 11,729 | 191 MiB |
| 100 | 45.9% | 5.3% | 22.2% | 0 | 93.9% | 38,051 | 635 MiB |
| 400 | 52.8% | 12.7% | 26.7% | 0 | 94.6% | 126,112 | 2,116 MiB |
| 1,600 | 63.7% | 18.8% | 35.2% | 124,523 | 95.3% | 217,088 | 3,624 MiB |

- **The Redis hypothesis does not apply at `bench` scale.** A colleague observed that separated stacks look best when the whole dataset sits in Redis and responses are served pre-serialized, which is unrealistic; on `dev` the stack's entity cache hit 99.3 to 99.9% with 84% of aggregates served from Redis. On `bench`, with 153 MB of Redis against about 6 GB of tables, under the scrambled Zipf, entity hits were 46 to 64%, aggregate hits 3 to 19%, and Postgres served every inventory and promotion read and every cache miss, reading from disk in every step. Redis reached its `maxmemory` and evicted only in the highest step. The stack's advantage here is not a cache that holds everything.
- **The reference's product cache hit 2.7 to 9.0%,** similar to the stack's aggregate cache, as the same key stream would suggest.
- **What the stack still has:** a hit is served as stored bytes, and the quote's promotion candidates come from a two-index bitmap scan. Its advantages are listed in [findings.md](findings.md#advantages-each-side-has); the second is new on `bench`.

## The clock

- **Bounded and measured, as qualified.** Per-step effective frequency was 3.77 to 3.89 GHz across all trials of both sessions, and the same step varied by less than 0.5% across trials of one target. perf's CPU time agreed with the cgroups' within 2%.
- **The effective frequency rises with utilization,** from 3.77 GHz with the stack's target slice at 0.1 cores to 3.84 GHz at 2 cores, and from 3.875 to 3.887 GHz for the reference (whose least-loaded step used 0.5 cores). The probe measured busy cores only; presumably a core that wakes from idle spends part of each short run below the all-core clock.
- **The 2% drift rule misfired on that, and is restated.** Against the session median of every step (3.857 GHz), session 1's report marked the stack's steps at 25 to 200 rps with †: 2.0 to 2.3% low, though they were as steady across trials as any step. The rule compared a utilization effect with clock drift. It now compares each step with the same step across its target's trials, and each step at full budget (at least 95% of the CPU budget) with the session median of every such step ([environments/gcp decision 5](../../environments/gcp/README.md#decisions)). Both session reports are regenerated under it, and no step drifts: the largest deviation from a step's median is 0.47% in session 1 and 0.34% in session 2, and from the full-budget median 1.29% and 0.24%.
- **At full budget the two targets' clocks still differ by 1.3%.** The stack's steps there ran at 3.837 to 3.840 GHz on 1.97 to 1.99 cores, the reference's at 3.886 to 3.888 GHz on 1.94 to 1.96 cores. Utilization does not explain it, since the stack was the busier; its cause was not measured. It is within the threshold, but a larger gap of this kind would read as drift in the full-budget check.

## Trial-to-trial variation

Within one target, the throughput of the saturated steps varied by 10 to 20% between trials, at a constant measured clock, and tracked instructions per cycle:

| Target, session | Lowest trial | Highest trial |
|-|-|-|
| Fastify + Postgres + Redis, 1 | 718 rps at IPC 2.01 | 819 rps at IPC 2.24 |
| Reference, 1 | 131 rps at IPC 2.08 | 148 rps at IPC 2.16 |
| Reference, unbatched build, 2 | 129 rps at IPC 2.01 | 155 rps at IPC 2.22 |

The trials restored the same snapshot, ran the same images and received the same arrival times, at 3.84 GHz (the stack) or 3.88 to 3.89 GHz (the reference) in every saturated step. Work per cycle changed, not cycles per second. The likely cause is what a shared host does not partition: last-level cache and memory bandwidth with other tenants, which this shape's architectural PMU cannot observe ([environments/gcp](../../environments/gcp/README.md#the-clock-on-gcp)). Ops per gigacycle does not remove it, since it is a per-cycle measure. Against the 5.5-fold difference between the stacks it is noise; for an A/B of a few percent it is the whole signal.

## Quote-read batching

Session 2, three trials per build, alternating ([tables](results/session-20261015T231012Z.md)). `harper` is the checkout, whose quote sends each read as soon as its key is known; `harper-unbatched` is `dd3a5f5^`, which reads each cart line's variant and then its product in turn. Both restore the same snapshot and use the same Dockerfile, Harper 5.3.2 and memory sizes.

| Per trial, in run order | Checkout (overlapped reads) | `dd3a5f5^` (sequential reads) |
|-|-|-|
| Throughput, mean of the saturated steps | 137.4, 146.3, 148.0 rps | 129.0, 132.6, 154.8 rps |
| Target CPU per request, saturated steps | 14.2, 13.4, 13.2 ms | 15.0, 14.6, 12.6 ms |
| Ops per gigacycle, saturated steps | 18.2, 19.3, 19.5 | 17.2, 17.7, 20.4 |
| p99 at 100 rps | 270, 348, 245 ms | 507, 271, 248 ms |

- **Unresolved.** The medians favour the overlapped reads by 5 to 10% at the saturated steps, but the sequential build's last trial was the fastest of all six, so the ranges overlap and the methodology leaves the cell unresolved. On `dev` the overlapped reads cost 13% more CPU per quote ([plan](https://github.com/HarperFast/ecommerce-store/blob/f47978bfc956f859aa2a0bc417a77ea50e12b25e/docs/plan.md)); on `bench` no consistent cost or gain shows in three trials.
- **One request at a time, overlapping did not shorten a quote:** the `data` phase took a median 19.7 ms overlapped and 19.0 ms sequential (`run.sh timing`, after the session). The reference reads 6 to 28 MiB from disk per step, so there is little I/O wait to overlap; its quote time is mostly CPU (about 13 ms of target CPU per request under load).
- **What would decide it:** more trials per build, or a lower noise floor than the next section describes. An A/B of a few percent is below this host's trial-to-trial variation.

## Traps hit and what changed

The runbook's untested list ran for the first time. What broke, and the change made:

1. **Capacity and quota.** At 21:07 UTC no zone in us-central1 or us-east1 had `c4-standard-16-lssd`; us-east5-a did. At 22:30 neither us-east5, us-central1 nor us-east1 did, and us-east4-a did. us-west1 refused with a C4 vCPU quota of 0: the project's C4 quota is per region, set in us-central1, us-east1, us-east4, us-east5, us-south1, us-west3 and us-west4 among others. `vm.sh up` tries only one region, so the operator moved regions by hand ([environments/gcp](../../environments/gcp/README.md#instance) now records it). The list price is the same in all three regions used.
2. **The coherence audit did not scale.** It sampled 200 + 1/10 of the product table in 16 views each: 3.2 million comparisons on `bench`, still running after 30 minutes of the first shakedown. It now rebuilds the run's write stream from the run record with the harness's own `planWrites`, and audits the products written, most-written first, a stride of unwritten ones and the hottest carts: 6,884 comparisons in under a minute ([audit-coherence.mjs](scripts/audit-coherence.mjs)).
3. **A failing audit would have aborted the trial.** `run.sh` piped it through `tee` under `set -euo pipefail`, so a stale response, the failure it exists to catch, would have ended `run.sh` before the verdict, the trial-log line and the target's stop. It is now a fault that sets the trial aside.
4. **The unbatched build failed under Docker.** Docker's Compose 5.6.0 builds through Buildx 0.38 Bake, which refuses a Dockerfile outside both the build context and the compose project's directory: `harper-unbatched` builds the archived commit with the ecommerce-store checkout's Dockerfile. `run.sh` sets `BUILDX_BAKE_ENTITLEMENTS_FS=0` for the reference's build. ecommerce-store's own `TARGET_REF` build, reproduced on the same host, is unaffected: its compose project directory holds the Dockerfile.
5. **The reference's memory sizes were not recorded.** Added: `run.sh` reads them from inside the running target after every trial, with the inputs and the source lines of Harper's rules; the report prints them per trial with the `DATA-004` basis.
6. **Operator traps, no script change:** IAP ssh refused for about a minute after each VM was created; `pkill -f <pattern>` over `vm.sh ssh` matched the remote shell's own command line and ended the session; a `tmux` command with `$S` inside single quotes ran with it unset. Updating a checkout while a trial's `run.sh` runs is safe (git replaces files, the running shell keeps the old one), but trials in one session should run one commit, so code changes waited for session ends. The promotion probe first named its customer tier `TIER`, shadowing the session's `TIER=2`; fixed before it produced output.
7. **Within-session variation is larger than expected.** 10 to 20% between trials of one target at a constant clock ([above](#trial-to-trial-variation)). Alternating the order, as the procedure does, spreads it across targets; it does not shrink it.

Also confirmed for the first time, with no change needed: `compose.tier2.yaml` under Docker's Compose with `!reset`, a three-container target in `bench-target.slice`, container scope discovery from the host and the generator, `sudo systemd-run` of `sample.sh` per trial, the cycle join against real `perf stat --for-each-cgroup -x,` output (its column layout as inferred), the join in the generator container over a root-owned sample directory, loading `bench` into Postgres (2 min 56 s including keys, indexes and foreign keys; a 6.9 GB snapshot, restored in about 20 s), and the per-cgroup `DATA-004` judgement.

## Cost

| VM | Ran | Time | Cost at $0.97/h |
|-|-|-|-|
| `arch-bench-ethan`, us-east5-a | 21:12 to 01:26 UTC | 4 h 14 min | about $4.10 |
| `arch-bench-ethan-ab`, us-east4-a | 22:36 to 02:04 UTC | 3 h 28 min | about $3.40 |

About $7.50 in all. `vm.sh down` after each; after the second, it found no instance, disk, reserved address or router left in the project. Raw results are kept locally in `results/raw/20261015t2107/` and `results/raw/20261015t2230/` (not committed), each with its session's archive and SHA-256.

## What the published comparison needs next

1. **The reference's quote reads, investigated on the Harper side first** (methodology: a measured loss guides Harper engineering, then the comparison is re-run): whether Harper's search can intersect two indexed conditions, how the reference should look promotions up, and why its other quote reads cost more on `bench` than on `dev`. A CPU profile of one `bench` quote is the next diagnostic.
2. **Load ladders that locate each knee.** The geometric ladder put the reference's knee between 100 and 200 rps and the stack's between 400 and 800, in one step each. A second pass needs finer steps around each, and per-target ladders are acceptable as long as every target gets the same arrival process.
3. **Both implementations reviewed, steelman and adversarial**, per [step 5](../../README.md#5-review-the-implementation), with the promotion lookup first on both sides; and the still-missing ground-truth guard.
4. **The reference's memory configuration decided** (configured or derived), now that the derived values are on record.
5. **More trials, and a check on the noise floor.** Three per target separated the stacks by a wide margin, but not the batching A/B. One sole-tenant session (`environments/gcp` decision 4) would show whether the 10 to 20% trial-to-trial variation is other tenants or the targets themselves.
