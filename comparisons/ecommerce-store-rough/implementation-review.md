# Implementation review before the next tier-2 run

**Date:** 2026-10-16. **Scope:** [procedure step 5](../../README.md#5-review-the-implementation), done after the first tier-2 sessions ([findings-tier2.md](findings-tier2.md)) rather than before them, because those sessions showed where to look. Four read-only reviews ran in parallel:

- a steelman of the Harper reference, from a Harper Core engineer's view, against Harper 5.3.2's published source;
- a steelman and adversarial review of Fastify + Postgres + Redis, from its maintainers' view;
- an equivalence audit of both, looking for work either side skips;
- an audit of the harness and measurement.

All four were Claude. The methodology also asks for other model families ([step 3](../../README.md#3-review-the-plan), [step 7](../../README.md#7-review-the-benchmarks)); that pass is still owed. Each finding below says whether it was **verified** here against the code or data, or is the **reviewer's** claim, not re-checked.

## The short answer

- **It is not the writes, and not the harness.** A fit of CPU against rate gives the reference 11.3 to 11.5 ms of CPU per read request and 0.21 to 0.22 cores of fixed load, which includes the 20 writes/s. With free writes it would reach about 150 rps instead of about 143. The harness review found the load, budget and accounting identical for both targets, down to scheduled arrival times.
- **It is mostly an engine path the reference's quote hits on every request** (H1). In Harper 5.3.2, an `in` condition on an indexed attribute is a full scan of that index through a filter. Under async iteration it yields one event-loop turn per index entry, and AND does not intersect two such conditions. A `bench` quote therefore walks 5,000 promotion index entries one turn at a time, walks the other 5,000 synchronously, and loads about 619 records. `dev` has 160 promotions, so tier 1 never showed it.
- **The second candidate is the product-cache miss path,** which was never timed (H2). About 95% of product reads miss. Each miss assembles about 13 to 15 reads and writes a `ProductView` record to storage, which the stack does in memory in Redis.
- **The stack has headroom too.** Holding promotions in memory, sizing the V8 young generation and rebalancing its memory split are worth an estimated +20 to 40% (P1 to P3). Fixing the reference alone will narrow the gap, not settle it.
- **The application code is equivalent on `bench`,** but the dataset makes every `bench` quote stop at an exclusive promotion (E1). So the pricing phases most likely to differ were never exercised there.
- **How to state the result:** 4.0 to 4.2× efficiency at a matched rate of 100 rps, 5.5 to 5.6× throughput at saturation, and 5.0× with the writes counted as served operations (M1, M2).

## Harper reference and engine

| Id | Finding | Kind | Status | Action |
|-|-|-|-|-|
| H1 | `in` on an indexed attribute is a full index scan through a filter (`resources/search.ts`, `case 'in'`: "Phase 1: route through filter — index-merge optimization is a Phase 2 follow-up", `needFullScan = true`). Under async iteration every entry resolves through `new Promise(… setImmediate …)` ("we intentionally yield the event turn so that scanning queries do not hog resources"). The AND's second condition becomes an id set built by a synchronous `searchByIndex`, a second full walk. `quote.js` iterates with `for await`. Each promotion has exactly one tier key and one category key, so each index holds 5,000 entries. The reviewer's local microbenchmark, on a Mac: 64 ms of wall time and 10 to 13 ms of CPU per 5,000-entry scan at concurrency 1, against 0.4 ms without the yields. | engine | verified in source; the cost figures are the reviewer's | Upstream: [HarperFast/harper#3240](https://github.com/HarperFast/harper/issues/3240) (`in` as a union of bounded ranges) and [#3241](https://github.com/HarperFast/harper/issues/3241) (one yield per row in every async scan). Reference workarounds within SPEC: (a) an OR group of `equals` probes on the narrower dimension, about 1,450 entries with no per-entry yield; (b) an indexed computed `tierKey\|categoryKey` attribute probed with an OR of `equals`, about 619 entries; (c) a per-worker promotion index refreshed within `FRESH_MS`, which is a maintainer decision to disclose (see P1). Under investigation in ecommerce-store. |
| H2 | Product-cache misses are untimed. The hit rate is 2.7 to 9%; each miss reads the product, its variants, inventory and related products, then writes the `ProductView` row (`@table(expiration: 120)`, a stored table; Harper's audit log defaults to on). Only hits (0.1 ms) were timed. | reference code, engine | reviewer | A per-wave `Server-Timing` split that includes `cache;desc=miss`, and a CPU profile at saturation. Candidate change: `audit: false` on `ProductView`, if invalidation does not depend on the audit log (unverified). |
| H3 | Heap and block-cache sizes are derived from the 2 GiB limit: 512 MiB of old space per worker (the floor), a 16 MiB young space, a 512 MiB block cache and a 171 MiB write-buffer manager charged to it. | configuration | verified (recorded every trial) | Set `threads.maxHeapMemory` and `storage.rocks.blockCacheSize` explicitly and A/B a larger block cache. Small or unknown effect. |
| H4 | The record cache is a `WeakLRUCache` with no options, with one default expirer shared by every table in a worker. `storage.caching` is read only on the LMDB path: RocksDB stores open with `cache: true` hard-coded, so the option is ignored and there is no size setting. | engine | verified in source | Upstream: [HarperFast/harper#3242](https://github.com/HarperFast/harper/issues/3242). |
| H5 | The reference left 2 to 3% of its cpuset idle at saturation (1.94 to 1.96 cores, against 1.97 to 1.99 for the stack). | configuration | verified in the session tables | A `HARPER_THREADS=3` sensitivity. |
| H6 | The reference had not plateaued by the end of the warm-up: CPU rose 7 to 10% and memory was still climbing at 1,957 to 1,964 MiB, while the stack was flat after about 4 minutes. CPU per request at 100 rps and at saturation is similar (13.6 against 13.8 ms), so the effect is small. | lifecycle | reviewer | Repeat the 100 rps step at the end of the ladder, or extend the warm-up until CPU per request stops rising. |

## Fastify + Postgres + Redis

| Id | Finding | Status | Action and expected effect |
|-|-|-|-|
| P1 | The promotion candidate query is about 45 to 58% of Postgres's CPU (126,781 calls, 649 rows per call, 74% of shared-buffer hits). The app also spends about 0.5 ms per quote parsing those rows. On `bench` every returned row is a real candidate: no promotion is SKU-restricted, and each has one tier and one category. `ORDER BY id` duplicates the sort `pricing.js` does. | verified (dataset, `db.js:77`, `pricing.js:151`); CPU shares are the reviewer's | (a) Hold the 5,000 promotions in each worker, re-read within `FRESH_MS` as `location` and `rate` already are: +20 to 30% throughput (estimate). This pairs with H1(c): decide it for both sides, or neither, and disclose it. (b) Short of that, drop `ORDER BY id` and return one `json_agg` row: +5 to 10%. |
| P2 | The V8 young generation is probably sized from the 512 MiB container and left near its minimum. `--max-old-space-size` does not set it; the reference's workers got 16 MiB. | reviewer, inference | Confirm in the container (`v8.getHeapSpaceStatistics()`), then add `--max-semi-space-size=16`: app CPU −5 to 20% (estimate). |
| P3 | The memory split strands about 340 MiB: the app peaked at 247 of 512 MiB and Redis at 185 of 256, while Postgres sat at 1,280 of 1,280 and refaulted 245k to 442k pages a step. | verified (verify lines) | `MEMORY_SPLIT=slice`, or app 320 / Postgres 1,472 / Redis 256: +2 to 5% (estimate). |
| P4 | Disk bytes read were about 2.1× Postgres's block reads in every step, consistent with large readahead on the RAID 0 array. `read_ahead_kb` is not recorded. | reviewer, inference | Record `read_ahead_kb` in `conditions.sh`; run a sensitivity applied to both targets. |
| P5 | Redis TTLs, not memory, bound the cache below the top step: 503,604 keys expired against 97,786 evicted, and Redis used 35 to 78 MiB of its 153 MB through 400 rps. | reviewer | Let `allkeys-lru` bound the entities; change the 120 s view TTL only on both sides. |
| P6 | Avoidable Redis round trips: a second MGET for generations on each entity miss wave, and a separate MGET plus an awaited store on a view miss. | reviewer | Fold them together: CPU −1 to 3%. |
| P7 | Inventory `fillfactor 90` buys nothing, because `INCLUDE (on_hand)` rules out HOT updates; its primary key is about 1.7 GB. | reviewer | `fillfactor 100`; optionally smaller key types. |

Disclose for the stack: same-host bridge round trips of tens of microseconds, and no TLS, replica or pooler hop. The tuned changes above are each stack's own recommended practice and belong in the next run, not after it.

## Equivalence of the two applications

An offline differential loaded both applications' real pricing and assembly modules into one process, with in-memory stand-ins for each datastore's documented query semantics. It reproduced the live `dev` result: 2,000 of 2,000 quotes and 40,000 of 40,000 views equal. On `bench`: **300,000 of 300,000 quotes and 100,000 of 100,000 product views equal** (every 400th product in 5 tiers and 4 regions). That is the reviewer's run, not repeated here. It does not exercise the real Harper search, the real Postgres GIN index, caches, concurrency or writes.

| Id | Finding | Favours | Status | Action |
|-|-|-|-|-|
| E1 | **Every `bench` quote stops at the exclusive step.** `bench` has 168 exclusive promotions, none tier-restricted, and every one of the 13 categories has an exclusive with no threshold. An applicable exclusive excludes every other promotion, so threshold, BOGO, stackable and the 60% cap applied in no `bench` quote. `dev` has 4 exclusives, and most of its quotes reach the other phases. | neither today, since both fetch and classify every candidate | verified (dataset counts) | A dataset decision: bound exclusives per category and regenerate. That changes every number produced from it, so it is the maintainer's call. Meanwhile, compare candidate sets directly for every distinct (tier, categories) key: 85,310 on `bench`. |
| E2 | **Write durability differs.** Postgres fsyncs every commit. Harper 5.3.2 on RocksDB does not: under `strace`, 250 acknowledged writes produced one `writev` each to the transaction log and no `fsync`, `fdatasync` or `sync_file_range`. `storage.writeAsync`, documented as defaulting to fsync, is read only on the LMDB path. No setting makes RocksDB commits durable. Filed as [HarperFast/harper#3243](https://github.com/HarperFast/harper/issues/3243). | reference | verified (measured on `dev`, 2026-10-16) | Decided: SPEC.md requires fsync on acknowledge for both. Until #3243 is fixed the reference cannot meet it, so disclose it as an advantage the reference has. At 20 writes/s it is small. |
| E3 | The reference persists its cache: every `ProductView` fill and invalidation is a storage write. The stack's cache is an in-memory Redis with no persistence. | stack | reviewer | Disclose it as an architectural difference, and measure it under H2. |
| E4 | The stack's quote does not read one consistent snapshot: Redis values filled at different times, plus separate READ COMMITTED statements. The reference reads inside one context. SPEC requires only determinism for one dataset state. The implementation README said "Different guarantees: none known"; it now lists this one. | stack | reviewer | A SPEC ruling on snapshot reads. |
| E5 | The stack caches cart, customer and product entities for up to 300 s with no invalidation path, while both sides bound the location and rate memos at 500 ms because those tables are writable. The reference caches no entities on the quote path. | stack | reviewer | A SPEC ruling: either CACHE-002 covers writes outside the write surface, and those TTLs drop to `FRESH_MS`, or the 500 ms rationale goes. |
| E6 | Under `allkeys-lru`, a generation key can be evicted, after which a stale view would pass its check until it expires. Evictions happened only at 1,600 rps. | stack, low probability | reviewer | Keep generation keys out of eviction. |
| E7 | `diff-reference.mjs` cannot run on `bench` as written: it reads uncompressed files and enumerates 40 million product requests. | | reviewer | Add gzip input and sampling; run it on the host against both live targets. |

## Harness and measurement

The harness review found the load identical: scheduled arrival times match to 0.000 ms, warm-ups match with 0 shed, and the pool, ceiling, timeouts, write routing and budget are the same, with no CPU throttling. perf and cgroup CPU agree to 0.975 to 1.000. Its corrections are about how the result is stated:

| Id | Finding | Status | Action |
|-|-|-|-|
| M1 | Saturation throughput (5.5 to 5.6×) is larger than matched-rate efficiency: 4.0× in CPU per request and 4.2× in ops per gigacycle at 100 rps. The stack beat its own linear fit by 15 to 18% at high rates; its IPC and aggregate hit rate rose with the rate served. The reference fell 7% short of its fit. | verified for the ratios (session tables) | Report matched-rate efficiency beside capacity, and capacity at a p99 target from a finer ladder. |
| M2 | The 20 writes/s are left out of "ops". Counting them gives 5.0× throughput and 5.1× ops per gigacycle. | reviewer | Report both; run a write-rate sensitivity at 0, 20 and 40 per second. |
| M3 | Pairing trials, the ratio ranges from 4.97 to 6.25×. | verified (per-trial values) | State the range. |
| M4 | `DATA-004` passes weakly for the reference: it read 6 to 28 MiB a step against a 1 MiB threshold, with almost no refaults, while the stack read 0.2 to 3.8 GB. The reference's memory peak includes about 1 GiB of page cache. | verified (session tables) | Make the threshold meaningful (bytes read relative to the working set), and say in the findings how little the reference read. |
| M5 | The page-cache drop is verified only as a configured hook. `cgroups.csv` shows the target slice falling to 0 to 2 MiB at every drop. | reviewer | Have the verifier check the slice's memory around the drop. |
| M6 | Only the stack's caches are audited for coherence. | verified | Run `verify-coherence.mjs` on `bench` for both targets. |

## Before the next big run

1. **Find and fix the reference's cost, upstream and in the reference** (H1, H2): the per-wave `Server-Timing` and the promotion-lookup workaround are under way in ecommerce-store. A CPU profile of a saturated `bench` step follows, before and after.
2. **Decide the paired questions** with whoever owns each side: promotions held in memory on both sides or neither (H1c, P1a), and the SPEC rulings on CACHE-002 scope, snapshot reads and durability (E2, E4, E5).
3. **Decide the dataset** (E1): bound exclusives and regenerate, or accept exclusive-only quotes and say so.
4. **Apply the stack's own recommended tuning** (P1b to P7), and record each change.
5. **Harness:** a finer ladder around each knee, matched-rate and writes-included figures, a write-rate sensitivity, a warm-up plateau check, a `bench` differential and coherence checks for both targets (M1, M2, M4, M6, E7, H6).
6. **A cross-model review** of this document and the changed code, with other model families, then one short diagnostic session on the GCP host, then the re-run.
