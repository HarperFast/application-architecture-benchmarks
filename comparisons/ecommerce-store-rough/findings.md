# Findings: ecommerce-store, Harper reference vs Fastify + Postgres + Redis (step 0)

**Status:** rough benchmark, step 0 of the [procedure](../../README.md#0-rough-benchmark-first). Tier 1 (containers in a podman VM on a macOS laptop). Dataset `dev`, which fits in memory and is never a benchmark target. **Nothing here is a result, and nothing here may be published or quoted as one.** It records where a first measurement lands, how large the effect looks, which traps appeared, and how the real comparison should be framed.

Date: 2026-10-12. Contract, harness and reference: ecommerce-store branch `harper-5.3` at `1f4a350` (SPEC.md `0.2.0-draft`, dataset generator `0.4.0`, seed `harper-ecommerce-store-v1`, Harper 5.3.2). Runs taken earlier the same day with ecommerce-store `main`'s harness are superseded: that harness dispatched open-loop arrivals one interval late, counted completions after the step window, could not account a containerized target's CPU, and aimed most writes at products the reads never touch. They are mentioned below only where they taught something.

## Where it lands

On `dev`, at 2 CPU / 2 GiB per target, three alternating trials each, no contended steps ([session tables](results/session-20261012T193328Z.md)):

- The Fastify + Postgres + Redis stack served every offered step through 5,600 rps without shedding in any trial (at 6,400 rps one of three trials shed 387 arrivals), its three containers using 1.0 to 1.2 cores between them; the median p99 across trials stayed in single-digit milliseconds at every step through 4,800 rps except 3,200 rps (52 ms), and individual trials spiked to 40 to 75 ms at 1,600 and 3,200 rps.
- The Harper reference served every step through 2,400 rps without shedding, but its p99 rose to about 90 ms at 2,000 and 160 ms at 2,400 rps with CFS throttling, and it saturated its 2 CPUs at about 3,200 to 3,350 rps.
- Target CPU per successful request at moderate load: about 0.6 ms for the reference, about 0.3 to 0.35 ms charged to the stack's containers, but the stack also caused about 0.5 core more VM kernel time per step that no cgroup was charged for (see trap 1). Counted in, per-request CPU is much closer than the cgroup figures say.
- Cold start to first 200: 0.87 s [0.83 to 0.94] for the stack (three processes started together), 1.68 s [1.63 to 1.69] for the reference.
- Quote-only and product-only runs ([tables](results/session-decomposition-20261012T200604Z.md)) put most of the difference in the quote path: the reference used about 0.8 ms of CPU per quote and saturated near 2,000 to 2,400 quotes/s; the stack used about 0.3 to 0.4 ms per quote in its containers (plus uncharged kernel time) and had not saturated at 4,000 quotes/s. Product aggregates are cheap on both (0.1 to 0.3 ms per request).

The quote-path gap is not yet an architecture finding. The reference reads each cart line's variant and then its product sequentially, and each inventory row individually; the stack batches every wave into one round trip and overlaps independent waves. That is an implementation choice the reference could adopt. Per the methodology, a separated stack beating Harper is published as measured and investigated; the first investigation is to give the reference the same batching and re-measure, at `bench` scale, on a Linux host.

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
| Load generator | ecommerce-store `harper-5.3` `bench/run.mjs`, 32 keep-alive connections, 2 CPU / 1 GiB outside the target budget |
| Conformance suite | ecommerce-store `harper-5.3` `e2e/`, Playwright 1.63.0 |
| Runtime | Podman 6.0.2, libkrun VM (6 vCPU, 7.45 GiB, kernel 7.1.3 aarch64, cgroup v2, crun) on an Apple M3 Pro (6 performance + 6 efficiency cores) |

## Resource budget and split

Both targets get 2 CPU / 2 GiB. The reference spends it in one container with 2 Harper threads. The stack spends it across three containers; memory is split per container (app 640 MiB, Postgres 1024 MiB, Redis 384 MiB). CPU was enforced two ways:

- **shared** (primary): all three containers under one cgroup slice limited to 2 CPU / 2 GiB, which is the most literal reading of "summed across all of its processes" and matches how the reference's threads share one container quota. A podman pod created with `--share none --infra=false --cpus 2 --memory 2g` provides the slice without changing the podman machine; the services name it as `cgroup_parent` and keep their own network namespaces. This matches the tier-2 placement ecommerce-store `harper-5.3` sketches (`compose.tier2.yaml`, a target slice).
- **split** (sensitivity): per-container CFS quotas of app 1.25, Postgres 0.5, Redis 0.25 CPU, from the measured shares under load.

On the corrected harness the two behave nearly identically through 6,400 rps; at 8,000 rps the split throttled Postgres for 0.7 to 6.4 s per step and shed in one trial. On `main`'s burstier harness, the split had driven p99 to about 270 ms at 1,600 to 3,200 rps while the shared slice stayed near 7 ms: static quotas penalize bursty components, and how much depends on the arrival pattern.

Peak memory at `dev`: the stack about 400 MiB in total (app 200 to 212, Postgres 80, Redis 42), the reference about 560 to 580 MiB.

## Configuration choices

In short (reasons in the implementation README):

- Two Fastify workers under `node:cluster`; JSON schemas for validation and serialization; a cached aggregate is sent as its stored bytes; request logging off, log level `warn`, as in the reference.
- Postgres: one table per entity; a primary key per table, `variant(product_id)`, a covering `inventory (sku, location_id) INCLUDE (on_hand)` key, GIN indexes on the promotion eligibility keys, foreign keys; named prepared statements; C collation; `shared_buffers` a quarter of the container; SSD planner costs; JIT and parallel query off; fsync and `synchronous_commit` on (Harper's `storage.writeAsync` also defaults to fsync on).
- Redis: a pure cache (`allkeys-lru`, no persistence) holding an entity cache (cart, customer, product, variant) and the product-aggregate cache. Inventory and promotions are read from Postgres on every quote, as in the reference. Location and rate lookups are held per worker and re-read every 500 ms, as the reference now does (CACHE-002).
- Freshness is explicit invalidation on write, completed before the write responds, with generation tokens that close the cache-aside refill race. Expiry (120 s aggregates, 300 s entities) only bounds memory. After the session: entity cache hit rates 99.3 to 99.8%, product-aggregate hit rate 84%, no evictions, no sequential scans on any table larger than the 8-row and 22-row lookups.
- No compose healthchecks (they exec inside the container and charge the measured budget); readiness is probed from outside with the reference's `wait-ready.mjs`.

## Correctness

- **Conformance** (`harper-5.3` `e2e/`): 24 of 24 tests on both targets ([fpr](results/conformance-fpr.json), [harper](results/conformance-harper.json)). DATA-001/003/005 are properties of the dataset and the loader (the loader verifies every file's sha256 and row count before writing and records the manifest); DATA-004 is not met by `dev` by design.
- **`verify-coherence.mjs`** (concurrent readers and price writers, then every view must show the last price within FRESH_MS): passes on both ([fpr](results/coherence-fpr.txt), [harper](results/coherence-harper.txt)).
- **Differential check** ([diff-reference.json](results/diff-reference.json)): every quote (2,000 carts), every product x 5 tiers (the four in the table plus one outside it) x 4 regions, and the 404 and 400 cases, compared response by response on freshly restored data: **42,004 of 42,004 equal**. The pricing engine here was written from SPEC.md, not copied. Agreement between two independent implementations is evidence, not ground truth; the plan's independently computed expected values are still needed.
- **Coherence audit** after every measured trial of the stack: 6,720 cached responses, weighted to the hot set the workload wrote to, byte-identical to the same responses computed from Postgres alone.
- **`verify-run-record.mjs --dev`**: passes for every complete ladder. The two ladders the generator did not finish fail it (METHOD), and quote-only runs fail WRITE-003 by construction (no product reads, so no cache status).

## Measurement traps

1. **Kernel CPU no cgroup is charged for.** Machine-wide busy time from `/proc/stat` minus every cgroup's usage was about 0.55 to 0.65 cores per step for the stack and 0.12 for the reference at the same offered rates. That is mostly network processing between the stack's three containers over the bridge, done in interrupt and kernel-thread context. It appears in no per-container figure, and a cgroup budget does not limit it, so the separated stack effectively runs with more than its 2 CPUs. The real comparison must account it, and should decide whether a budget can be fair without it.
2. **Static per-container quotas penalize bursty processes** (see the budget section); how much depends on the arrival pattern, so a split result must state the generator it ran under.
3. **The reference is throttled below its quota too.** At 2,000 rps its average CPU was 1.1 cores of 2, yet it was CFS-throttled for 0.2 to 0.7 s per step and p99 rose accordingly: worker threads, GC and storage threads burst past 2 cores within a 100 ms period. Average utilization does not show whether a budget binds.
4. **The single-process generator is the next ceiling.** At 5,600 to 8,000 rps the harness flags dispatch lag in some steps, and in 2 of 5 stack ladders the generator container was OOM-killed at 1 GiB (kernel memcg OOM log) during the last step: it re-serializes every retained sample after each step. Several generators would need distinct request and write seeds, which the harness does not expose.
5. **`podman stats` reports lifetime-average CPU**, so an idle check built on it is wrong; replaced with cgroup samples three seconds apart.
6. **A shared machine needs per-step contention detection.** Another project's benchmarks started mid-trial repeatedly. The wrapper measures every other container (including ones that start and exit inside a step, via machine.slice totals) and the VM's services per step; contended steps are excluded. Host load outside the VM (a video call, a Bluetooth daemon at one core, another agent's jobs) is recorded too; it slows the VM's vCPUs invisibly from inside.
7. **The harness's per-target CPU used to be blind to containers** (`ps` inside the generator): fixed on `harper-5.3` with `--target-cgroups`, which this comparison uses.
8. **Seeding Harper through the operations API does not invalidate its derived cache.** One snapshot was taken after a readiness probe had filled a product view from earlier state; the view survived the restore and was served, stale, several minutes later, past its 120 s expiration, until the differential check caught it. The load now starts from an empty volume and probes a path that touches no cache. Why the expiration did not apply after restore is worth a look on the Harper side.
9. **Latency at low load is a VM artifact**: p50 at 400 rps is no better than at 2,000 rps on either target.
10. **Harper 5.2.12 returned 500s under concurrent cold fills** (`Database closed during transaction ... for ProductView`, 26 to 35 of 40,000 aggregates); none on 5.3.2.

## Harness gaps for multi-process targets

| Gap | Needed |
|-|-|
| Budget enforcement | one parent cgroup per target (slice or pod), plus a decision about kernel time outside every cgroup |
| CPU accounting | per-container figures exist on `harper-5.3`; add the budget slice, machine-wide busy time, generator container, and other containers per step (`bench-wrapper.mjs` is a working version) |
| Contention | per-step detection and exclusion, not an idle check at the start |
| Generator | memory headroom at high rates (stream samples to disk instead of re-serializing them), and multi-process generation with per-process seeds |
| Ground truth | published expected values; meanwhile a differential run against a second implementation, and a cache-bypass audit hook per target |
| Invalidation fan-out | a defined unit: the reference reports 16 view keys per price write, this stack 17 (views plus its variant entity) |
| Run-record checks | WRITE-003 cannot pass a quote-only run; decomposition runs need their own expectations |

## Specification defects and ambiguities

Everything in SPEC.md was implementable on Fastify + Postgres + Redis. These are places where a second implementation had to reverse-engineer the reference or choose:

1. **Contract that lives outside SPEC.md:** the write surface (`POST /admin/variant/:sku {basePrice}`, `POST /admin/inventory/:id {onHand}` with `id` = `sku:locationId`, and an `invalidated` count the suite asserts); the `Server-Timing` grammar (`cache;desc=hit|miss`, `data`, `compute`, `total`); the quote's `currency`, `region`, `taxJurisdiction`, `totalWeight`, `tier` and `loyaltyBalance`, and `QuoteLine.shortfall` (in `model.ts` now); unknown `region` returning 400 and an unknown `tier` sharing the `standard` cache key (in the reference and suite only).
2. **The suite is stricter than CACHE-002:** CACHE-002 allows freshness by expiry within FRESH_MS; the CACHE-002 test requires the first read after a write to be a miss.
3. **Attribution of cart-wide promotions:** steps 2 and 3 attribute exclusive and threshold promotions to "every line [they were] eligible for"; QUOTE-012 says exactly the promotions that "produced a discount for that line". They disagree for an eligible line whose proportional share rounds to zero; both implementations attribute only lines with a non-zero share.
4. **Merged lines in the response:** lines merge by SKU before evaluation, but whether the response itemizes merged or original lines, and how shortfall works for a repeated SKU, is unspecified. The reference itemizes original lines and allocates inventory to each independently; this stack merges first. Latent: the dataset never repeats a SKU in a cart.
5. **"Evaluation of which triggers further reads"** (wave 4): in neither implementation does promotion evaluation trigger further reads.
6. **"60 to 150 record reads":** with the dataset's cart sizes (mostly 1 to 5 lines) a typical quote reads about 10 to 30 records.
7. **Lookup tables and CACHE-002:** both implementations now bound their location and rate memos at 500 ms; the specification could say whether tables no application path writes are in scope.
8. Fixed on `harper-5.3`, listed for completeness: BOGO thresholds (step 6), float tie-breaks in largest-remainder allocation, silent zero shipping or tax on a missing rate, tier lookup through the prototype chain, product compute timing (OBS-001).

## Advantages each side has

- **The stack** batches each quote wave into one round trip and overlaps independent waves; serves a cached aggregate as stored bytes; and, on this machine, gets uncharged kernel CPU for its inter-container traffic.
- **The reference** pays no network hop, no protocol encode or decode and no second copy of hot data for any read; its cache is in-process and invalidation is a local call. The stack pays a bridge round trip and encoding on both sides for every Redis and Postgres access, a Postgres commit with fsync plus a Redis round trip per write, and three processes' memory.
- **Durability:** fsync on for both by default; commit-acknowledgement semantics of the reference's write surface were not examined and should be before tier 2.

## What the real comparison should look like

1. Tier 2, `bench` dataset. `dev` measures HTTP, serialization and in-memory lookups; DATA-004 requires a working set beyond memory, where Postgres I/O, cache hit rates and the ranking can all change. The stack's loader already streams the gzipped `bench` files.
2. Each target's budget as one parent cgroup, kernel time outside every cgroup measured and accounted, the static split as a stated sensitivity.
3. A generator that is not the bottleneck at the stack's knee, validated against the current one at low rates.
4. Both implementations reviewed first, steelman and adversarial, including giving the reference's quote path the same batching, so the comparison measures architecture rather than one implementation's read pattern.
5. The write surface and the test-only contract details moved into SPEC.md, the invalidation unit defined, expected values published as data.
6. CPU per request per component, cold, warm and hot, contention and kernel time per step, every sample retained, as this directory does locally.
7. Claims framed as architecture against architecture ("the Harper reference application vs an assembled Fastify + Postgres + Redis application on the same 2 CPU / 2 GiB"), never about Fastify, Postgres or Redis themselves.
