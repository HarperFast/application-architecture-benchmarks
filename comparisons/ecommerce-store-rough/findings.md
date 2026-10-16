# Findings: ecommerce-store, Harper reference vs Fastify + Postgres + Redis (step 0)

**Status:** rough benchmark, step 0 of the [procedure](../../README.md#0-rough-benchmark-first). Tier 1 (containers in a podman VM on a macOS laptop). Dataset `dev`, which fits in memory and is never a benchmark target. **Nothing here is a result, and nothing here may be published or quoted as one.** It records where a first measurement lands, how large the effect looks, which traps appeared, and how the real comparison should be framed.

Dates: 2026-10-12, re-run 2026-10-14; tier-2 orchestration 2026-10-15, pinned to ecommerce-store `main` at `f47978b`, where `harper-5.3` (HarperFast/ecommerce-store#4) merged ([Tier-2 readiness](#tier-2-readiness)). Contract, harness and reference for the measured sessions: ecommerce-store branch `harper-5.3` at `5c32151` (SPEC.md `0.2.0-draft`, dataset generator `0.5.0`, seed `harper-ecommerce-store-v1`, Harper 5.3.2). Generator 0.5.0 changes only the carts and replaces the access distribution with a scrambled discrete Zipf; the harness at `5c32151` reaches every key, plans its writes from the read distribution, records page cache and disk reads per step, and the orchestration drops the page cache before every cold start. The first session, on `1f4a350` and generator 0.4.0, is kept and marked superseded ([tables](results/session-20261012T193328Z.md)). Runs taken before that with ecommerce-store `main`'s harness are superseded too: that harness dispatched open-loop arrivals one interval late, counted completions after the step window, could not account a containerized target's CPU, and aimed most writes at products the reads never touch. They are mentioned below only where they taught something.

## Where it lands

On `dev` generator 0.5.0, at 2 CPU / 2 GiB per target, three alternating trials each, no contended steps ([session tables](results/session-20261014T204435Z.md)):

- The Fastify + Postgres + Redis stack served every offered step through 4,800 rps without shedding in any trial (at 5,600 rps one of three trials shed 1,813 arrivals; at 6,400 two of three shed), its three containers using 1.0 to 1.1 cores between them at 4,000 to 4,800 rps. Its median p99 was 5.3 to 10.3 ms at every step through 4,800 rps; individual trials spiked to 73 to 122 ms at 1,600, 2,000 and 4,000 rps.
- The Harper reference served every step through 2,000 rps without shedding in all but one trial (one of three shed 515 arrivals at 1,600 rps), and every trial shed from 2,400 rps. Its median p99 was 44 ms at 400 rps, 167 ms at 800, 233 ms at 2,000 and 363 ms at 2,400; it was CFS-throttled 0.8 s per step at 800 rps and 1.5 to 2.3 s at 2,000 to 2,400 rps, and it saturated its 2 CPUs at about 2,600 to 3,100 rps.
- Target CPU per successful request at 2,400 rps: 0.66 ms for the reference, 0.33 ms charged to the stack's containers; but the stack also caused about 0.4 to 0.5 core more VM kernel time per step that no cgroup was charged for (see trap 1). Counted in, per-request CPU is much closer than the cgroup figures say.
- Cold start to first 200, with the page cache dropped first: 1.15 s [1.08 to 1.19] for the stack (three processes started together), 2.07 s [2.03 to 2.25] for the reference.
- Quote-only and product-only runs ([tables](results/session-decomposition-20261014T211559Z.md), one trial each) put most of the CPU difference in the quote path: the reference used 0.80 to 0.85 ms of CPU per quote and saturated at about 2,350 quotes/s; the stack used 0.30 to 0.44 ms per quote in its containers (plus uncharged kernel time) and had not saturated at 4,000 quotes/s. Product aggregates are cheap on both (0.07 to 0.37 ms per request), but the reference shed product-only load at 4,800 rps while using 0.94 cores, so its product path is not CPU-bound there.

### What moved from generator 0.4.0, and why

| Median across trials | Stack 0.4.0 → 0.5.0 | Reference 0.4.0 → 0.5.0 |
|-|-|-|
| No shedding in any trial at or below | 5,600 → 4,800 rps | 2,400 → 1,200 rps |
| p99 at 800 / 2,400 rps | 4.6 / 4.7 → 6.1 / 6.2 ms | 7.2 / 164 → 167 / 363 ms |
| Target CPU per request at 2,400 rps | 0.32 → 0.33 ms | 0.59 → 0.66 ms |
| Cold start to first 200 | 0.87 → 1.15 s | 1.68 → 2.07 s |
| Target memory peak | 395 to 405 → 550 to 562 MiB | 557 to 577 → 710 to 718 MiB |

- **Cold start and memory moved because of the page-cache drop.** The restore used to leave the target's files in the VM's page cache, charged to no target; now the target reads them back itself, so its cold start is slower and its page cache is counted in its memory. Without the drop, one [diagnostic trial](results/session-diagnostics-20261014T212525Z.md) each cold-started in 0.95 s (stack) and 1.59 s (reference). The stack's anonymous memory did not change (at the last step of one trial: app 201 MiB, Redis 42, Postgres 40); the growth is page cache for binaries and data files (app 101, Redis 38, Postgres 100 MiB). The reference held 506 MiB anonymous and 179 MiB of page cache.
- **The reference's tail latency moved with the write stream.** One diagnostic trial each, same ladder ([tables](results/session-diagnostics-20261014T212525Z.md)): with writes off, the reference's p99 was 6.5 and 6.2 ms at 400 and 800 rps; with writes on and no page-cache drop, 94 and 49 ms. The stack's p99 stayed at 4 to 11 ms in both. On `dev`, generator 0.5.0 spreads reads and writes across more of the hot products: the hottest product's share of draws falls from about 32% under the 0.4.0 power law to 7.8%. The likely cause is more of the reference's cached views being invalidated and refilled at once; that is a hypothesis for the Harper side to confirm.
- **Shedding moved slightly earlier for the stack** (5,600 → 4,800 rps), with its CPU per request unchanged. The generator flags its own dispatch lag in one trial at 5,600 rps and in two trials at each step from 6,400, so those steps sit near the generator's ceiling.

The quote-path gap is not yet an architecture finding. The reference reads each cart line's variant and then its product sequentially, and each inventory row individually; the stack batches every wave into one round trip and overlaps independent waves. That is an implementation choice the reference could adopt. Per the methodology, a separated stack beating Harper is published as measured and investigated; the first investigation is to give the reference the same batching and re-measure, at `bench` scale, on a Linux host. ecommerce-store `dd3a5f5` has since batched the reference's quote reads; every session here predates it, and the tier-2 session can run both builds (`harper` and `harper-unbatched`).

## What was built

- [`implementations/fastify-postgres-redis`](../../implementations/fastify-postgres-redis): the application, containerized; its README covers the data model mapping, caching mechanism and configuration.
- This directory: an orchestrator that runs both targets in one compose project, one at a time, through the ecommerce-store harness (unmodified), plus what the harness lacks for a multi-container target on a shared laptop: a shared-budget cgroup slice, per-step contention detection (other containers, VM services, the macOS host), machine-wide CPU including CPU no cgroup is charged for, a differential correctness check against the reference, and a cache-coherence audit.

## Versions

| | Version |
|-|-|
| Harper (reference) | 5.3.2, built by ecommerce-store `harper-5.3`'s `containers/Dockerfile` (`node:24-slim`) |
| Node.js | 24.21.0 (Active LTS), `node:24.21.0-slim` |
| Fastify | 5.12.5 (fast-json-stringify 7.1.0) |
| PostgreSQL | 18.6, `postgres:18.6-trixie`; node-postgres 8.23.1 |
| Redis | 8.10.2, `redis:8.10.2-trixie`; node-redis 6.3.0 |
| Load generator | ecommerce-store `harper-5.3` `bench/run.mjs` at `5c32151`, every key reachable, 32 keep-alive connections, 2 CPU / 1 GiB outside the target budget |
| Conformance suite | ecommerce-store `harper-5.3` `e2e/` at `5c32151`, Playwright 1.63.0 |
| Runtime | Podman 6.0.2, libkrun VM (6 vCPU, 7.45 GiB, kernel 7.1.3 aarch64, cgroup v2, crun) on an Apple M3 Pro (6 performance + 6 efficiency cores) |

## Resource budget and split

Both targets get 2 CPU / 2 GiB. The reference spends it in one container with 2 Harper threads. The stack spends it across three containers. Every `dev` session above split memory per container as app 640 MiB, Postgres 1024 MiB, Redis 384 MiB. For tier 2 the split is app 512, Postgres 1,280, Redis 256 MiB, and every process is sized from its own container's limit explicitly, because a container cannot see its slice's limits (the tier-2 qualification measured this) and on a Podman VM it sees the VM:

| Container | Limit | Sizing |
|-|-|-|
| app | 512 MiB | 2 workers, Node heap capped at 160 MiB per process (primary and each worker); measured peak about 320 MiB on `dev`, page cache of the Node binary and modules included |
| postgres | 1,280 MiB | `shared_buffers` 320 MB (a quarter), `effective_cache_size` 960 MB (three quarters), `work_mem` 4 MB at 40 connections at most, `maintenance_work_mem` 64 MB (the loader raises its own) |
| redis | 256 MiB | `maxmemory` 153 MB (about 60%), `allkeys-lru`, no persistence |

Postgres gets the largest share because at `bench` scale its working set is the one larger than memory, and every quote reads inventory and promotions from it whatever Redis holds; Redis holds the hot head of a skewed key distribution. `scripts/run.sh` derives the sizing from whatever split it is given and records both in every run. The 512 / 1,280 / 256 split has run only in the local test of the tier-2 path, not in a measured session.

CPU was enforced two ways on tier 1:

- **shared** (primary): all three containers under one cgroup slice limited to 2 CPU / 2 GiB, which is the most literal reading of "summed across all of its processes" and matches how the reference's threads share one container quota. A podman pod created with `--share none --infra=false --cpus 2 --memory 2g` provides the slice without changing the podman machine; the services name it as `cgroup_parent` and keep their own network namespaces. This matches the tier-2 placement ecommerce-store `harper-5.3` sketches (`compose.tier2.yaml`, a target slice).
- **split** (sensitivity): per-container CFS quotas of app 1.25, Postgres 0.5, Redis 0.25 CPU, from the measured shares under load.

On generator 0.5.0 (two split trials) the two are close through 5,600 rps: at 800, 1,200, 1,600, 2,400 and 4,800 rps one of the two split trials spiked to 29 to 81 ms p99, as single shared trials did at 1,600, 2,000 and 4,000 rps. From 6,400 rps the split throttled Postgres (1.7 s per step at 6,400, 0.4 to 9.1 s at 8,000), and both split trials shed at 6,400. On generator 0.4.0 the split matched the shared slice through 6,400 rps. On `main`'s burstier harness it had driven p99 to about 270 ms at 1,600 to 3,200 rps while the shared slice stayed near 7 ms: static quotas penalize bursty components, and how much depends on the arrival pattern.

Peak memory at `dev` generator 0.5.0, the target's own page cache included: the stack 550 to 562 MiB in total (app 316 to 321, Postgres 150 to 153, Redis 82 to 83), the reference 710 to 718 MiB. On 0.4.0, before the page-cache drop, the restore's cache was charged to no target and the peaks were about 400 and 557 to 577 MiB.

## Configuration choices

In short (reasons in the implementation README):

- Two Fastify workers under `node:cluster`; JSON schemas for validation and serialization; a cached aggregate is sent as its stored bytes; request logging off, log level `warn`, as in the reference.
- Postgres: one table per entity; a primary key per table, `variant(product_id)`, a covering `inventory (sku, location_id) INCLUDE (on_hand)` key, GIN indexes on the promotion eligibility keys, foreign keys; named prepared statements; C collation; `shared_buffers` a quarter of the container; SSD planner costs; JIT and parallel query off; fsync and `synchronous_commit` on. Whether the reference fsyncs each acknowledged write is unverified: Harper 5.3.2 on RocksDB does not read `storage.writeAsync`, which applies to LMDB ([implementation review](implementation-review.md), E2).
- Redis: a pure cache (`allkeys-lru`, no persistence) holding an entity cache (cart, customer, product, variant) and the product-aggregate cache. Inventory and promotions are read from Postgres on every quote, as in the reference. Location and rate lookups are held per worker and re-read every 500 ms, as the reference now does (CACHE-002).
- Freshness is explicit invalidation on write, completed before the write responds, with generation tokens that close the cache-aside refill race. Expiry (120 s aggregates, 300 s entities) only bounds memory. After each 0.5.0 trial: entity cache hit rates 99.3 to 99.9%, product-aggregate hit rate 84%, no evictions, and no sequential scans except on the 8-row and 22-row lookup tables and 80 on the 160-row promotion table, where the planner prefers a scan.
- No compose healthchecks (they exec inside the container and charge the measured budget); readiness is probed from outside with the reference's `wait-ready.mjs`.

## Correctness

- **Conformance** (`e2e/` at `f47978b`, unchanged since `5c32151`; dataset 0.5.0): 24 of 24 tests on both targets, re-run at `f47978b` on 2026-10-15 ([fpr](results/conformance-fpr-dataset-0.5.0.json), [harper](results/conformance-harper-dataset-0.5.0.json)); also 24 of 24 on 0.4.0 ([fpr](results/conformance-fpr-dataset-0.4.0.json), [harper](results/conformance-harper-dataset-0.4.0.json)). DATA-001/003/005 are properties of the dataset and the loader (the loader verifies every file's sha256 and row count before writing and records the manifest); DATA-004 is not met by `dev` by design.
- **`verify-coherence.mjs`** (concurrent readers and price writers, then every view must show the last price within FRESH_MS): passes on both, on both datasets ([fpr](results/coherence-fpr-dataset-0.5.0.txt), [harper](results/coherence-harper-dataset-0.5.0.txt); 0.4.0: [fpr](results/coherence-fpr-dataset-0.4.0.txt), [harper](results/coherence-harper-dataset-0.4.0.txt)).
- **Differential check** ([0.5.0](results/diff-reference-dataset-0.5.0.json), [0.4.0](results/diff-reference-dataset-0.4.0.json)): every quote (2,000 carts), every product x 5 tiers (the four in the table plus one outside it) x 4 regions, and the 404 and 400 cases, compared response by response on freshly restored data: **42,004 of 42,004 equal** on each dataset. The pricing engine here was written from SPEC.md, not copied. Agreement between two independent implementations is evidence, not ground truth; the plan's independently computed expected values are still needed.
- **Coherence audit** after every measured trial of the stack, on both datasets: 6,720 cached responses, weighted to the hot set the workload wrote to, byte-identical to the same responses computed from Postgres alone.
- **`verify-run-record.mjs --dev`**: passes for every complete mixed and product-only ladder. It fails the three ladders the generator did not finish (METHOD), quote-only runs on WRITE-003 (no product reads, so no cache status), and the write-free diagnostics on WRITE-001, each by construction.

## Measurement traps

1. **Kernel CPU no cgroup is charged for.** Machine-wide busy time from `/proc/stat` minus every cgroup's usage was about 0.50 to 0.63 cores per step for the stack and 0.10 to 0.14 for the reference at the same offered rates (1,600 rps and up, generator 0.5.0; 0.54 to 0.66 and 0.11 to 0.13 on 0.4.0). That is mostly network processing between the stack's three containers over the bridge, done in interrupt and kernel-thread context. It appears in no per-container figure, and a cgroup budget does not limit it, so the separated stack effectively runs with more than its 2 CPUs. The real comparison must account it, and should decide whether a budget can be fair without it.
2. **Static per-container quotas penalize bursty processes** (see the budget section); how much depends on the arrival pattern, so a split result must state the generator it ran under.
3. **The reference is throttled below its quota too.** At 800 rps on generator 0.5.0 its average CPU was 0.8 cores of 2, yet it was CFS-throttled for 0.5 to 1.2 s per step and p99 rose accordingly: worker threads, GC and storage threads burst past 2 cores within a 100 ms period. Average utilization does not show whether a budget binds.
4. **The single-process generator is the next ceiling.** From 5,600 rps the harness flags its own dispatch lag in some trials, and in 3 of 10 stack ladders across the two sessions (2 of 5 on 0.4.0, 1 of 5 on 0.5.0) the generator container was OOM-killed at 1 GiB (kernel memcg OOM log) at the end of the ladder, during or just after the 8,000 rps step: it re-serializes every retained sample after each step. Several generators would need distinct request and write seeds, which the harness does not expose.
5. **`podman stats` reports lifetime-average CPU**, so an idle check built on it is wrong; replaced with cgroup samples three seconds apart.
6. **A shared machine needs per-step contention detection.** Another project's benchmarks started mid-trial repeatedly. The wrapper measures every other container (including ones that start and exit inside a step, via machine.slice totals) and the VM's services per step; contended steps are excluded. Host load outside the VM (a video call, a Bluetooth daemon at one core, another agent's jobs) is recorded too; it slows the VM's vCPUs invisibly from inside.
7. **The harness's per-target CPU used to be blind to containers** (`ps` inside the generator): fixed in HarperFast/ecommerce-store#4 (`harper-5.3`, merged as `f47978b`) with `--target-cgroups`, which this comparison uses.
8. **Seeding Harper through the operations API does not invalidate its derived cache.** One snapshot was taken after a readiness probe had filled a product view from earlier state; the view survived the restore and was served, stale, several minutes later, past its 120 s expiration, until the differential check caught it. The load now starts from an empty volume and probes a path that touches no cache. Why the expiration did not apply after restore is worth a look on the Harper side.
9. **Low-load latency is not a floor.** On `main`'s harness the stack's p50 was 7.8 ms at 200 rps against 3 ms at 1,600, partly the VM's idle and wake-up behaviour; on the corrected harness the stack's p50 is 2.7 ms at 400 rps and 2.6 ms at 2,000.
10. **Harper 5.2.12 returned 500s under concurrent cold fills** (`Database closed during transaction ... for ProductView`, 26 to 35 of 40,000 aggregates); none on 5.3.2.
11. **A restore warms the page cache for free.** Restoring a snapshot from a helper container leaves the target's files in the VM's page cache, charged to no target, so the first runs measured cold start and memory on data the target never read itself. Both targets now start after the cache is dropped, which raised cold start (stack 0.95 → 1.15 s, reference 1.59 → 2.07 s, one no-drop trial each against the session medians) and moved the page cache into the targets' memory figures.
12. **Disk is the tier-1 constraint for `bench`.** Every restore grows the Podman VM's disk image, which returns freed blocks only to `fstrim`, and the raw run records retained for every sample come to 3.6 GB for these two sessions. `bench` is never run locally; see [Tier-2 readiness](#tier-2-readiness).

## Harness gaps for multi-process targets

| Gap | Needed |
|-|-|
| Budget enforcement | one parent cgroup per target (slice or pod), plus a decision about kernel time outside every cgroup |
| CPU accounting | per-container figures exist since #4; add the budget slice, machine-wide busy time, generator container, and other containers per step (`bench-wrapper.mjs` is a working version) |
| Contention | per-step detection and exclusion, not an idle check at the start |
| Generator | memory headroom at high rates (stream samples to disk instead of re-serializing them), and multi-process generation with per-process seeds |
| Ground truth | published expected values; meanwhile a differential run against a second implementation, and a cache-bypass audit hook per target |
| Invalidation fan-out | a defined unit: the reference reports 16 view keys per price write, this stack 17 (views plus its variant entity) |
| Run-record checks | WRITE-003 cannot pass a quote-only run; decomposition runs need their own expectations |

## Specification defects and ambiguities

Everything in SPEC.md was implementable on Fastify + Postgres + Redis. These are places where a second implementation had to reverse-engineer the reference or choose; all still hold at `f47978b`, whose SPEC.md is unchanged since `5c32151` (that change only states the access distribution):

1. **Contract that lives outside SPEC.md:** the write surface (`POST /admin/variant/:sku {basePrice}`, `POST /admin/inventory/:id {onHand}` with `id` = `sku:locationId`, and an `invalidated` count the suite asserts); the `Server-Timing` grammar (`cache;desc=hit|miss`, `data`, `compute`, `total`); the quote's `currency`, `region`, `taxJurisdiction`, `totalWeight`, `tier` and `loyaltyBalance` (SPEC.md does name `shortfall`, in QUOTE-003 and QUOTE-010); unknown `region` returning 400 and an unknown `tier` sharing the `standard` cache key (in the reference and suite only).
2. **The suite is stricter than CACHE-002:** CACHE-002 allows freshness by expiry within FRESH_MS; the CACHE-002 test requires the first read after a write to be a miss.
3. **Attribution of cart-wide promotions:** steps 2 and 3 attribute exclusive and threshold promotions to "every line [they were] eligible for"; QUOTE-012 says exactly the promotions that "produced a discount for that line". They disagree for an eligible line whose proportional share rounds to zero; both implementations attribute only lines with a non-zero share.
4. **Merged lines in the response:** lines merge by SKU before evaluation, but whether the response itemizes merged or original lines, and how shortfall works for a repeated SKU, is unspecified. The reference itemizes original lines and allocates inventory to each independently; this stack merges first. Latent: the dataset never repeats a SKU in a cart.
5. **"Evaluation of which triggers further reads"** (wave 4): in neither implementation does promotion evaluation trigger further reads.
6. **"60 to 150 record reads":** with the dataset's cart sizes (mostly 1 to 5 lines) a typical quote reads about 10 to 30 records.
7. **Lookup tables and CACHE-002:** both implementations now bound their location and rate memos at 500 ms; the specification could say whether tables no application path writes are in scope.
8. Fixed in #4, listed for completeness: BOGO thresholds (step 6), float tie-breaks in largest-remainder allocation, silent zero shipping or tax on a missing rate, tier lookup through the prototype chain, product compute timing (OBS-001).

## Advantages each side has

- **The stack** batches each quote wave into one round trip and overlaps independent waves; serves a cached aggregate as stored bytes; and, on this machine, gets uncharged kernel CPU for its inter-container traffic.
- **The stack's Redis holds the whole `dev` dataset.** After each `dev` trial its entity cache hit rate was 99.3 to 99.9% with no evictions, and 84% of product aggregates were served from Redis as pre-serialized bytes, so on `dev` Postgres served little beyond inventory, promotions and writes. That is an advantage `dev` gives the stack and `bench` should not: at `bench` scale Redis has 153 MB against about 6 GB of tables, holds only the head of the access distribution, and evicts. Nothing preloads it: the loader flushes it, it has no persistence, every trial starts it empty, and only the harness's warm-up fills it, as it fills the reference's caches. To show how much each layer served, the stack exposes cumulative counters at `/__stats`, which the wrapper polls every 2 s (a few reads inside the target's budget) and joins to each step: entity and aggregate cache hit rates, Redis keyspace hits, misses and evictions, Postgres shared-buffer hits and blocks read. The harness's per-container disk reads separate a Postgres buffer miss served from the page cache from one that went to disk.
- **The reference** pays no network hop, no protocol encode or decode and no second copy of hot data for any read; its cache is in-process and invalidation is a local call. The stack pays a bridge round trip and encoding on both sides for every Redis and Postgres access, a Postgres commit with fsync plus a Redis round trip per write, and three processes' memory.
- **Durability:** fsync on for both by default; commit-acknowledgement semantics of the reference's write surface were not examined and should be before tier 2.

## Tier-2 readiness

The first two tier-2 sessions ran on 2026-10-15 and 16; what they found is in [findings-tier2.md](findings-tier2.md). `bench` is never run locally. The orchestration for a tier-2 session follows ecommerce-store `main` at `f47978b`, whose harness fixes the warm-up per scale, runs 60 s steps with seeded Poisson arrivals on `bench`, joins the host's cycle samples to each step (`bench/cycles.mjs`), builds the reference from another commit (`TARGET_REF`, with `TARGET_IMAGE` naming this project's images), and verifies tier-2 placement, cycles, pinned base images and DATA-004's memory evidence per cgroup. It is in place and tested on `dev` with tier-1 placement: [runbook-tier2.md](runbook-tier2.md) is the procedure, and it lists what only the Linux host can test.

- **Placement.** [`compose.tier2.yaml`](compose.tier2.yaml) puts every target container, of either target, in `bench-target.slice` (CPUs 2-3, `MemoryMax=2G`) with no CPU quota, and the generator and loaders in `bench-generator.slice`, as ecommerce-store's own override does for the reference. Memory limits stay per container (above).
- **Restore.** Each target's volume is archived once per session after seeding, with a clean shutdown first. Before every trial the volume is emptied and the archive extracted into it, the host's page cache is dropped, and every process of the target starts at once. Redis has no persistence, so it starts empty in every trial.
- **Loading `bench`.** The loader verifies every file against `MANIFEST.json` and streams the gzipped tables into `COPY`; locally on `bench`, without loading, verification took 6 s and encoding 45 s. The tables come to about 6 GB (inventory 3.9, variant 1.3, product 0.6, cart 0.1, customer 0.07, scaled from `dev` bytes per row), so the volume needs about 7 GB and its uncompressed snapshot as much again. The load itself, Postgres writing on two cores in its 1,280 MiB container, is estimated at 10 to 20 minutes and is untested.
- **Session.** [`scripts/session.sh`](scripts/session.sh) alternates `harper` and `fpr` (and optionally the reference's unbatched build, `harper-unbatched`, built from `dd3a5f5^` with ecommerce-store's own build variables) round by round, with the harness's fixed `bench` warm-up and 60 s steps. Each trial runs environments/gcp's `sample.sh` around it, joins its cycles into the run record with ecommerce-store's `bench/cycles.mjs`, runs `verify-run-record.mjs`, and is set aside and re-run if verification, the cycle join or a maintenance event fails it. Every raw record is kept.
- **DATA-004's memory evidence, per cgroup.** On `bench`, `verify-run-record.mjs` judges each target cgroup against its own memory limit, and the summed peaks against the recorded budget when a target has several cgroups. The evidence holds when one of them is pressed (its `memory.peak`, page cache included, at 90% of the limit or more) and still reading (at least 1 MiB of disk reads or a page-cache refault in every measured step), and the verifier prints the `DATA-004 memory basis:` that met it; `run.sh` copies that line into each trial's console and the session's trial log. For this stack the expected basis is Postgres against its own 1,280 MiB. An earlier version summed the peaks against 2 GiB alone, which a per-container split could fail with Postgres full: the app (about 320 MiB of 512) and Redis (about 200 of 256) kept the sum near 88%. `MEMORY_SPLIT=slice` removes the per-container limits so the slice's 2 GiB is the only one; it is a sensitivity, not the default.

## What the real comparison should look like

1. Tier 2, `bench` dataset. `dev` measures HTTP, serialization and in-memory lookups; DATA-004 requires a working set beyond memory, where Postgres I/O, cache hit rates and the ranking can all change. The first tier-2 sessions ran exploratory, step 0 for tier 2 ([findings-tier2.md](findings-tier2.md)), and every trial met `DATA-004`.
2. Each target's budget as one parent cgroup, kernel time outside every cgroup measured and accounted, the static split as a stated sensitivity.
3. A generator that is not the bottleneck at the stack's knee, validated against the current one at low rates.
4. Both implementations reviewed first, steelman and adversarial, including giving the reference's quote path the same batching, so the comparison measures architecture rather than one implementation's read pattern.
5. The write surface and the test-only contract details moved into SPEC.md, the invalidation unit defined, expected values published as data.
6. CPU per request per component, cold, warm and hot, contention and kernel time per step, every sample retained, as this directory does locally.
7. Claims framed as architecture against architecture ("the Harper reference application vs an assembled Fastify + Postgres + Redis application on the same 2 CPU / 2 GiB"), never about Fastify, Postgres or Redis themselves.
