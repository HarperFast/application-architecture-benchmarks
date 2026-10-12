# ecommerce-store on Fastify + PostgreSQL + Redis

An implementation of the [ecommerce-store](https://github.com/HarperFast/ecommerce-store) application specification (`SPEC.md` `0.2.0-draft`) on a separated stack: a Fastify HTTP service, PostgreSQL as the source of truth, and Redis as the cache. It is the first competing implementation for the Harper reference, built for the step-0 rough comparison in [`comparisons/ecommerce-store-rough`](../../comparisons/ecommerce-store-rough). Nothing produced from it is a published result; see the [methodology](../../README.md).

The specification, dataset, conformance suite and load harness live in the ecommerce-store repository and are used from a checkout of it, never copied here.

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

All versions were the latest stable releases on 2026-10-12, checked against npm, nodejs.org and Docker Hub. Node 26 is the Current line until its LTS promotion later in October 2026, so the Active LTS line is used, the same major the reference's container uses.

## Topology and budget

Three containers on one user-defined bridge network, plain HTTP, named volume for Postgres (never tmpfs):

| Service | Process | Memory limit |
|-|-|-|
| `app` | Node primary + 2 Fastify workers (`node:cluster`), each with an 8-connection Postgres pool and one Redis connection | 640 MiB |
| `postgres` | PostgreSQL 18 | 1024 MiB |
| `redis` | Redis 8, `maxmemory 256mb` | 384 MiB |

The reference runs as one container at 2 CPU / 2 GiB. This stack spends the same 2 CPU / 2 GiB **summed across all three**. Memory is split per container (640 + 1024 + 384 = 2048 MiB). CPU can be enforced two ways, and the choice matters a great deal (see the [findings](../../comparisons/ecommerce-store-rough/findings.md)):

- **shared** (the default in the comparison): all three containers run under one cgroup slice capped at 2 CPU / 2 GiB, so CPU is one pool the three processes draw from, as the reference's threads draw from one container's quota. The slice is a podman pod created with `--share none --infra=false --cpus 2 --memory 2g`, used only for its cgroup; each container keeps its own network namespace on the bridge.
- **split**: per-container CPU quotas that sum to 2 (app 1.25, postgres 0.5, redis 0.25), chosen from the measured CPU shares at load (about 64% / 30% / 6%) rounded to leave Redis headroom. Static quotas throttle bursty processes even when their average is well under the quota.

Standalone, `compose.yaml` applies the split; `BUDGET_CGROUP_PARENT` points the three services at a shared slice.

## Run it

Requires Podman or Docker with Compose, and a checkout of ecommerce-store (the dev dataset is plain git; no LFS needed).

```bash
docker compose up -d --build --wait postgres redis app
DATASET_DIR=/path/to/ecommerce-store/dataset/dev docker compose run --rm loader
curl -s -X POST localhost:39926/cart/cart-000042/quote -H 'content-type: application/json' -d '{}'
curl -s 'localhost:39926/product/product-000001?tier=gold&region=us-east'
```

Conformance (from the ecommerce-store checkout, against the published port):

```bash
cd /path/to/ecommerce-store/e2e && BASE_URL=http://localhost:39926 npx playwright test
```

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

Errors use SPEC's `ApiError` shape. Unknown cart or product: 404. Unknown SKU in a cart (QUOTE-002) or a cart naming an unknown customer: 400. An unknown `tier` prices as `standard` (SPEC.md "Resolved unit price"); an unknown `region` has no fulfillment locations and so no availability.

## Data model (DATA-001)

One table per logical entity; the source of truth is not pre-joined. Mapping from the wire model:

| Entity | Storage |
|-|-|
| `cart` | `cart(id, customer_id, lines jsonb)`. Lines stay embedded as the spec embeds them: a cart is read and cached as one unit and never queried by line. A normalized `cart_line` relation is the alternative and would make the read a join. |
| `customer` | `customer(id, tier, loyalty_balance bigint, region, tax_jurisdiction)` |
| `product` | `product(id, title, category_ids text[], weight, related_product_ids text[], review_count, review_average_centistars)`. `reviewRollup` is two columns. |
| `variant` | `variant(sku, product_id, options jsonb, base_price bigint, weight)`, fillfactor 90 so price updates are HOT. |
| `inventory` | `inventory(sku, location_id, on_hand)`, primary key `(sku, location_id) INCLUDE (on_hand)`. The dataset's `id` (`sku:locationId`) is not stored; the write surface parses it. |
| `location`, `rate` | As in the dataset. |
| `promotion` | The eligibility arrays plus the dataset's indexable `tier_keys` / `category_keys` (`'*'` = unrestricted), each GIN-indexed. |

Money is `bigint` minor units, parsed to exact JavaScript integers (the parser refuses anything outside `Number.MAX_SAFE_INTEGER`); all pricing arithmetic is exact integer arithmetic (DATA-002). The database uses the C collation so ids compare bytewise, as JavaScript compares them.

Indexes: a primary key per table, `variant(product_id)` for the aggregate, the covering inventory key, and the two GIN indexes. Foreign keys for referential integrity (never on the hot path). Every hot statement is a named (prepared) statement; `pg_stat_statements` after each run confirms index scans only.

The loader verifies every file's sha256 and row count against `MANIFEST.json` before writing anything (DATA-003), loads with `COPY` into unindexed tables, builds keys and indexes afterwards in the same transaction, records the manifest in `dataset_manifest`, runs `VACUUM ANALYZE`, and flushes Redis. A gzipped dataset (`bench`) is verified and loaded straight from the `.gz` files.

## Caching (CACHE-001/002/003, OBS-002)

| Cache | Key | Filled | Invalidated |
|-|-|-|-|
| Entity cache | `e:{cart,customer,product,variant}:<id>` | cache-aside on miss, one `MGET` per wave, misses batched into one `= ANY($1)` query | price write deletes the variant; carts, customers and products have no write surface |
| Product aggregate | `pdp:<product>:<tier>:<region>` | assembled on miss, serialized once, stored as bytes | price write: all 16 tier x region views of the product; inventory write: the 4 tier views of that location's region |
| Static tables | `location`, `rate` in each worker's memory | at startup | never written by any surface (the reference does the same) |

Not cached: inventory (the most write-hot entity, read from Postgres on every quote) and promotions (candidate collection stays part of the measured fan-out, one GIN-indexed query per quote, as in the reference).

**Freshness mechanism (CACHE-002): explicit invalidation on write.** The write surface commits to Postgres, then invalidates in one Redis `MULTI/EXEC`, and only then responds, so a read issued after a write's response sees it. Expiry (120 s for aggregates, matching the reference's `ProductView`, 300 s for entities) only bounds memory.

Plain cache-aside has a refill race that can leave a stale value in place until expiry. Every invalidation therefore also sets a fresh unique token on a generation key:

- an entity fill reads the generation before reading Postgres and stores only if it is unchanged (a Lua compare-and-set);
- an aggregate is stored together with the generations it was built under, and a read serves it only if they still match (fetched in the same `MGET`). Generations are per product (price) and per product x region (inventory), so a view cached under a tier or region outside the dataset's vocabulary is invalidated too, which deleting known keys alone could not do.

Redis has no persistence (`save ""`, no AOF); `allkeys-lru` with `maxmemory 256mb`. Responses carry `Server-Timing: cache;desc=hit|miss, data;dur, compute;dur, total;dur`; the quote always reports `miss`. Per-cache hit and miss counters are kept in the Redis hash `stats:cache`.

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
- **Different guarantees:** none known. Durability is Postgres defaults; freshness is synchronous invalidation with the race closed, which is at least as strong as the reference's invalidate-plus-expiry.

## Configuration choices

- **Node:** 2 cluster workers, one per CPU of the budget; request logging disabled and log level `warn` (as in the reference); Fastify JSON schemas for validation and for response serialization (fast-json-stringify); a cached aggregate is sent as its stored string.
- **Postgres** (`postgres/postgresql.conf`): `shared_buffers` 256 MB (a quarter of the container), `effective_cache_size` 768 MB, SSD planner costs (`random_page_cost` 1.1, `effective_io_concurrency` 200), parallel query and JIT off (sub-millisecond OLTP statements), durability defaults kept, `pg_stat_statements` on, `max_connections` 40 for 16 pooled connections.
- **Redis** (`redis/redis.conf`): pure cache, `allkeys-lru` (the documented recommendation for a power-law access pattern), lazy freeing on, no persistence, not published to the host.

## Known limitations

- Only the `dev` dataset has been run. The configuration targets `bench` (the loader streams gzipped files; Postgres and Redis are sized against their container limits) but a `bench` load and ladder have not been attempted.
- Promotions are read per quote, as in the reference. A production deployment might hold active promotions in memory with a short expiry; neither implementation does.
- `options` is `jsonb`, which does not preserve key order; the aggregate's `options` objects therefore list keys in a different order from the reference's. Cross-implementation key order is not part of the contract (QUOTE-008 is per implementation).
