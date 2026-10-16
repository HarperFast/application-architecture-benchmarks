# ecommerce-store on Fastify + PostgreSQL + Redis

An implementation of the [ecommerce-store](https://github.com/HarperFast/ecommerce-store) application specification (`SPEC.md` `0.2.0-draft`) on a separated stack: a Fastify HTTP service, PostgreSQL as the source of truth, and Redis as the cache. It is the first competing implementation for the Harper reference, built for the step-0 rough comparison in [`comparisons/ecommerce-store-rough`](../../comparisons/ecommerce-store-rough). Nothing produced from it is a published result; see the [methodology](../../README.md).

The specification, dataset, conformance suite and load harness live in the ecommerce-store repository and are used from a checkout of it, never copied here. The contract this implementation is built and checked against is ecommerce-store `main` at `f47978b` (`SPEC.md`, `packages/spec`, `e2e/`, `scripts/verify-coherence.mjs`, and the harness), where HarperFast/ecommerce-store#4 merged its harness measurement fixes and several reference behaviours; the commit used is recorded with every run (the measured `dev` sessions used #4's branch at `5c32151`; dataset generator 0.5.0).

## Versions

| Component | Version | Image / package |
|-|-|-|
| Node.js | 24.21.0 (Active LTS "Krypton") | `docker.io/library/node:24.21.0-slim` |
| Fastify | 5.12.5 | `fastify` |
| fast-json-stringify | 7.1.0 (the version Fastify 5.12.5 uses) | `fast-json-stringify` |
| PostgreSQL | 18.6 | `docker.io/library/postgres:18.6-trixie` |
| node-postgres | 8.23.1 | `pg`, `pg-copy-streams` 7.0.0 for the loader |
| Redis | 8.10.2 | `docker.io/library/redis:8.10.2-trixie` |
| node-redis | 6.3.0 | `redis` (the client Redis recommends for new projects; ioredis is in best-effort maintenance) |

All versions were the latest stable releases on 2026-10-12, checked against npm, nodejs.org and Docker Hub. The three base images are pinned by multi-arch index digest in `compose.yaml` (`x-base-images`), so tier 1 (arm64) and tier 2 (x86-64) run the same release and a later rebuild cannot change them. Node 26 is the Current line until its LTS promotion later in October 2026, so the Active LTS line is used, the same major the reference's container uses.

## Topology and budget

Three containers on one user-defined bridge network, plain HTTP, named volume for Postgres (never tmpfs). No compose healthchecks: a healthcheck execs a probe inside the container every interval, charged to the budget under measurement (the reference dropped its own for the same reason); readiness is probed from outside.

| Service | Process | Memory limit | Sized from the limit |
|-|-|-|-|
| `app` | Node primary + 2 Fastify workers (`node:cluster`), each with an 8-connection Postgres pool and one Redis connection | 512 MiB | Node heap capped at 160 MiB and semi-space set to 8 MiB per process |
| `postgres` | PostgreSQL 18 | 1,280 MiB | `shared_buffers` 320 MB, `effective_cache_size` 960 MB, `work_mem` 4 MB, `maintenance_work_mem` 64 MB |
| `redis` | Redis 8 | 256 MiB | `maxmemory` 153 MB |

The reference runs as one container at 2 CPU / 2 GiB. This stack spends the same 2 CPU / 2 GiB **summed across all three**. Memory is split per container (512 + 1,280 + 256 = 2,048 MiB), and every process is sized from its own container's limit explicitly, never from what it can see: on the tier-2 host a container cannot see its slice's limits, and on a Podman VM it sees the VM. `compose.yaml` takes the sizes as variables (defaults above); the comparison's `run.sh` derives them from any split (`APP_MEMORY_MIB`, `PG_MEMORY_MIB`, `REDIS_MEMORY_MIB`) and records them with every run. The `dev` sessions in the findings ran an earlier 640 / 1,024 / 384 split with 256 MB `shared_buffers` and `maxmemory`; the new split gives Postgres the most, because at `bench` scale its working set is the one larger than memory. CPU can be enforced two ways on tier 1, and the choice matters a great deal (see the [findings](../../comparisons/ecommerce-store-rough/findings.md)); on tier 2 the target slice's cpuset is the budget and no container has a CPU quota:

- **shared** (the default in the comparison): all three containers run under one cgroup slice capped at 2 CPU / 2 GiB, so CPU is one pool the three processes draw from, as the reference's threads draw from one container's quota. The slice is a podman pod created with `--share none --infra=false --cpus 2 --memory 2g`, used only for its cgroup; each container keeps its own network namespace on the bridge.
- **split**: per-container CPU quotas that sum to 2 (app 1.25, postgres 0.5, redis 0.25), chosen from the measured CPU shares at load (about 64% / 30% / 6%) rounded to leave Redis headroom. Static quotas throttle bursty processes even when their average is well under the quota.

Standalone, `compose.yaml` applies the split; `BUDGET_CGROUP_PARENT` points the three services at a shared slice.

## Run it

Requires Podman or Docker with Compose, and a checkout of ecommerce-store (the dev dataset is plain git; no LFS needed).

```bash
docker compose up -d --build postgres redis app   # the app retries until Postgres and Redis answer
DATASET_DIR=/path/to/ecommerce-store/dataset/dev docker compose run --rm loader
curl -s -X POST localhost:39926/cart/cart-000042/quote -H 'content-type: application/json' -d '{}'
curl -s 'localhost:39926/product/product-000001?tier=gold&region=us-east'
```

Conformance (from the ecommerce-store checkout, against the published port):

```bash
cd /path/to/ecommerce-store/e2e && BASE_URL=http://localhost:39926 npx playwright test
```

The loader verifies every file against `MANIFEST.json` (DATA-003) and streams the tables, gzipped or not, into `COPY`; then it adds keys, indexes and foreign keys, runs `VACUUM ANALYZE`, and flushes Redis. `--verify-only` stops after the checksums and `--encode-only` also streams every table through the encoder without a database, so a `bench` dataset can be checked on a machine that must not load it. `LOAD_MAINTENANCE_WORK_MEM` (default 256MB) sizes the index builds.

Unit tests for the pricing engine: `cd app && npm test`.

For the full lifecycle (snapshot restore, cold start, the measured ladder, per-container CPU accounting, the reference diff) use [`comparisons/ecommerce-store-rough`](../../comparisons/ecommerce-store-rough/README.md).

## Endpoints

| Route | |
|-|-|
| `POST /cart/:id/quote` | The quote (SPEC.md "POST /cart/:id/quote"). Never response-cached. |
| `GET /product/:id?tier=&region=` | The product aggregate, cached per product x tier x region. |
| `POST /admin/variant/:sku` `{basePrice}` | Price write; commits, invalidates, then responds with `invalidated`. |
| `POST /admin/inventory/:id` `{onHand}` | Inventory write; `id` is the dataset's `sku:locationId`. |
| `GET /health` | Postgres and Redis both answer. |
| `GET /__meta` | Loaded dataset manifest, component versions, configuration. |
| `GET /__audit/product/:id`, `POST /__audit/cart/:id/quote` | The same responses computed from Postgres alone, bypassing every cache. Used only by the coherence audit, never by the harness. |

Errors use SPEC's `ApiError` shape. Unknown cart or product: 404. Unknown SKU in a cart (QUOTE-002) or a cart naming an unknown customer: 400. On the product aggregate, a `tier` outside the normative table resolves as `standard` (SPEC.md "Resolved unit price") and is served under the `standard` cache key; a `region` with no fulfillment location is a 400. Both match the reference, and keep the cache key space bounded to values the write surface invalidates.

## Data model (DATA-001)

One table per logical entity; the source of truth is not pre-joined. Mapping from the wire model:

| Entity | Storage |
|-|-|
| `cart` | `cart(id, customer_id, lines jsonb)`. Lines stay embedded as the spec embeds them: a cart is read and cached as one unit and never queried by line. A normalized `cart_line` relation is the alternative and would make the read a join. |
| `customer` | `customer(id, tier, loyalty_balance bigint, region, tax_jurisdiction)` |
| `product` | `product(id, title, category_ids text[], weight, related_product_ids text[], review_count, review_average_centistars)`. `reviewRollup` is two columns. |
| `variant` | `variant(sku, product_id, options jsonb, base_price bigint, weight)`, fillfactor 90 so price updates are HOT. |
| `inventory` | `inventory(sku, location_id, on_hand)`, primary key `(sku, location_id) INCLUDE (on_hand)`, fillfactor 100 (`on_hand` is in the key, so its updates are never HOT and free space would go unused). The dataset's `id` (`sku:locationId`) is not stored; the write surface parses it. |
| `location`, `rate` | As in the dataset. |
| `promotion` | The eligibility arrays plus the dataset's indexable `tier_keys` / `category_keys` (`'*'` = unrestricted), each GIN-indexed. |

Money is `bigint` minor units, parsed to exact JavaScript integers (the parser refuses anything outside `Number.MAX_SAFE_INTEGER`); all pricing arithmetic is exact integer arithmetic (DATA-002). The database uses the C collation so ids compare bytewise, as JavaScript compares them.

Indexes: a primary key per table, `variant(product_id)` for the aggregate, the covering inventory key, and the two GIN indexes. Foreign keys for referential integrity (never on the hot path). Every hot statement is a named (prepared) statement; `pg_stat_statements` after each run confirms index scans only.

The loader verifies every file's sha256 and row count against `MANIFEST.json` before writing anything (DATA-003), loads with `COPY` into unindexed tables, builds keys and indexes afterwards in the same transaction, records the manifest in `dataset_manifest`, runs `VACUUM ANALYZE`, and flushes Redis. A gzipped dataset (`bench`) is verified and loaded straight from the `.gz` files.

## Caching (CACHE-001/002/003, OBS-002)

| Cache | Key | Filled | Invalidated |
|-|-|-|-|
| Entity cache | `e:{cart,customer,product,variant}:<id>` | cache-aside on miss: one round trip per wave for the values and their generations, misses batched into one `= ANY($1)` query | price write deletes the variant; carts, customers and products have no write surface |
| Product aggregate | `pdp:<product>:<tier>:<region>` | assembled on miss, serialized once, stored as bytes without holding up the response | price write: all 16 tier x region views of the product; inventory write: the 4 tier views of that location's region |
| Lookup tables | `location`, `rate` in each worker's memory | at startup, then re-read every 500 ms | bounded by expiry at half of `FRESH_MS`: no application path writes them, but they are writable in Postgres (the reference bounds its memos the same way) |

Not cached: inventory (the most write-hot entity, read from Postgres on every quote) and promotions (candidate collection stays part of the measured fan-out, one GIN-indexed query per quote, as in the reference). The candidate query has no `ORDER BY`, since the pricing engine orders promotions by id itself; on `bench` a quote has about 650 candidates. It returns rows: returning them as one `json_agg` row saved the app about half its decoding CPU, but building the JSON cost Postgres as much or more, so the total did not fall (measured on `bench`'s promotions, tier 1).

**Freshness mechanism (CACHE-002): explicit invalidation on write.** The write surface commits to Postgres, then invalidates in one Redis `MULTI/EXEC`, and only then responds, so a read issued after a write's response sees it. Expiry is only a backstop: 120 s for aggregates, matching the reference's `ProductView`, and an hour for entities, longer than a trial, so that on `bench` Redis's LRU bounds the entity cache at `maxmemory` rather than expiry holding it below. (At 300 s, expiry did: in the first tier-2 sessions Redis used 35 to 78 MiB of its 153 MB below the top step; [implementation review](../../comparisons/ecommerce-store-rough/implementation-review.md) P5.)

Plain cache-aside has a refill race that can leave a stale value in place until expiry. Every invalidation therefore also sets a fresh unique token on a generation:

- an entity fill reads the generation before reading Postgres, in the same round trip as the cached values, and stores only if it is unchanged (a Lua compare-and-set);
- an aggregate is stored together with the generations it was built under, and a read serves it only if they still match (fetched in the same round trip). Generations are per product (price) and per product x region (inventory), so a view's validity never depends on the write surface having deleted every key it affected.

A generation must outlive every value it guards: a fill that read an absent generation is stamped with the empty string, which would match again once the write's token was gone. Generations are therefore fields of one Redis hash per kind (`g:variant`, `g:pdp`), each field expiring on its own (`HSETEX`, two hours, longer than any cached value), with no expiry on the hash itself. Redis evicts under `volatile-lru` with `maxmemory` 153 MB: every cached value carries a TTL, so the LRU covers the whole cache, while the generation hashes and the hit counters are never evicted. Under `allkeys-lru`, an evicted generation could let a stale view pass until it expired (review E6). Redis has no persistence (`save ""`, no AOF). Responses carry `Server-Timing: cache;desc=hit|miss, data;dur, compute;dur, total;dur`; the quote always reports `miss`. Per-cache hit and miss counters are kept in the Redis hash `stats:cache`; `GET /__stats` returns them with Redis's keyspace hits, misses and evictions and Postgres's shared-buffer hits and reads, cumulatively, for the comparison to join to each step.

## Quote read path

```text
cart ──┬─> variants ──> products ──┐
       └─> customer ──┬────────────┴─> promotions (tier x categories)
                      └─> inventory (skus x the customer's region locations)
then pricing in JavaScript; shipping and tax from the in-memory rate table
```

Each read is issued as soon as its inputs exist, so inventory overlaps the product wave. A wave is one Redis `MGET` (or one Postgres query on misses), never one round trip per record; every record the specification names is still read.

The pricing engine (`app/src/pricing.js`) is written from SPEC.md, not copied from the reference. Cart-wide allocations compare largest remainders as exact integers. On the whole dev dataset it agrees with the reference on every quote and every product aggregate (see the findings).

## Where this stack does more, or less, work than the reference

Recorded as the methodology asks (advantages as well as costs):

- **Less:** a cached product aggregate is served as stored bytes with no deserialization or re-serialization. The quote's waves are batched into one round trip each and overlapped where the data dependencies allow; the reference reads each line's variant and product sequentially and each inventory row individually. These are choices the reference could also make.
- **More:** every read crosses a network boundary to Redis or Postgres and pays protocol encoding and decoding on both sides. Every write pays a Postgres commit (`synchronous_commit = on`, fsync on) plus a Redis round trip for invalidation. Three processes each hold their own memory and their own copy of hot data (Postgres buffers, Redis values, parsed objects in Node).
- **Different guarantees:** durability is Postgres defaults (every commit fsynced); the reference, on Harper 5.3.2's RocksDB storage, does not fsync an acknowledged write ([HarperFast/harper#3243](https://github.com/HarperFast/harper/issues/3243)), which SPEC requires of both, so it is disclosed as an advantage the reference has. Freshness is synchronous invalidation with the race closed, at least as strong as the reference's invalidate-plus-expiry. A quote does not read one consistent snapshot: it combines Redis values filled at different times with separate READ COMMITTED statements, where the reference reads inside one context. Cart, customer and product entities are cached for up to an hour with no invalidation path; SPEC has yet to rule whether CACHE-002 covers writes made outside the write surface, and if it does, those expiries drop to `FRESH_MS`. See the comparison's [implementation review](../../comparisons/ecommerce-store-rough/implementation-review.md) (E2, E4, E5).

## Configuration choices

- **Node:** 2 cluster workers, one per CPU of the budget; request logging disabled and log level `warn` (as in the reference); Fastify JSON schemas for validation and for response serialization (fast-json-stringify); a cached aggregate is sent as its stored string. Each process's heap is capped from the container (`--max-old-space-size`) and its young generation set from it too (`--max-semi-space-size`), because Node 24's V8 treats a 512 MiB container as a low-memory device and gives it a 1 MiB semi-space, its minimum (measured in this image). Above that class V8 uses a quarter of the limit for old space and a sixteenth of that per semi-space (16 MiB at 1 GiB, 32 MiB at 2 GiB, measured); the comparison's `run.sh` applies that rule to the app container, 8 MiB at 512 MiB, and records it. Node's documentation leaves the value to benchmarking. On `dev` at tier 1 (signal only, two rounds at 1,200 and 2,400 rps), 8 and 16 MiB cost the same app CPU per request, 3 to 6% less than 1 MiB, and 8 MiB used about 25 MiB less memory (an app peak of about 280 MiB of 512). `/__meta` reports the heap limit each worker resolved.
- **Postgres** (`postgres/postgresql.conf`, plus memory settings on the command line from `compose.yaml`): `shared_buffers` a quarter of the container (320 MB), `effective_cache_size` three quarters (960 MB), SSD planner costs (`random_page_cost` 1.1, `effective_io_concurrency` 200), parallel query and JIT off (sub-millisecond OLTP statements), durability defaults kept, `pg_stat_statements` on, `max_connections` 40 for 16 pooled connections.
- **Redis** (`redis/redis.conf`, `maxmemory` from `compose.yaml`): pure cache, `maxmemory` about 60% of the container (leaving fragmentation, client buffers and its binary's page cache, all charged to the container), `volatile-lru`: LRU, the documented recommendation for a power-law access pattern, over every key with an expiry, which is every cached value, and the documented choice when one instance also holds keys that must persist (the generations and counters). Lazy freeing on, no persistence, not published to the host.

## Known limitations

- `bench` has run only in the comparison's exploratory tier-2 sessions ([findings-tier2.md](../../comparisons/ecommerce-store-rough/findings-tier2.md)), before the tuning in the [implementation review](../../comparisons/ecommerce-store-rough/implementation-review.md) (P1b, P2, P5 to P7, E6).
- Promotions are read per quote, as in the reference. A production deployment might hold active promotions in memory with a short expiry; neither implementation does.
- `options` is `jsonb`, which does not preserve key order; the aggregate's `options` objects therefore list keys in a different order from the reference's. Cross-implementation key order is not part of the contract (QUOTE-008 is per implementation).
