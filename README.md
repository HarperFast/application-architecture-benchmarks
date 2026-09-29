# Harper Application Architecture Benchmarks

An open system for benchmarking Harper's collapsed stack application architecture against separated stack architecture and platforms.

The purpose of this being open source is so that the wider community, including the projects and companies we are comparing ourselves against, can openly provide feedback and contribute. Anyone may reference this work, and contributions are accepted.

**Primary Hypothesis**: is Harper's collapsed stack architecture holistically more efficient than generalized separated application architecture?

Generalized separated application architectures means that we aren't targeting just one technology or stack. These benchmarks set out to prove that Harper applications are more efficient than any combination of separated services.

The high-level plan is to implement a single application specification on Harper as well as across a matrix of other technologies. While the Harper implementation will remain the same, the competitive application may swap Postgres for MongoDB, Redis for Memcached, Fastify for Express, etc.

The hypothesis will be considered proven as long as Harper continues to outperform the various combinations of alternative software stacks.

Importantly, this work is not meant to isolate the performance of any singular technology. In many cases, lots of the services evaluated here could beat Harper in isolated testing scenarios. The point is we are analyzing the **holistic application experience**.

This repo is the living workspace for the benchmark work. No comparison results are published here. **All results are published in standalone snapshot repositories that reflect the exact state of the applications at the time of testing**. Those repos accept contributions too, but should be focussed on correcting minor details. Making large changes or major version upgrades should likely start here and then a new analysis should be conducted (and thus a new snapshot repo published). This organization keeps everything honest and historically referenceable.

## Application Scope

1. **Ecommerce**: The reference application is an enterprise-level ecommerce store. Benchmarking various "store sizes" is out of scope. Focus is on significantly sized workloads reflective of Harper's existing customer base.

2. **JavaScript**: Application logic should primarily run on JavaScript. Its fine if some aspects (such as the database or caching layer) are non-Node.js, but the core application logic (like any frontend or backend API pieces) should be Node.js compatible. Harper itself is strictly a Node.js compatible platform. There is little point to comparing to say a Python or .Net backend service if that audience would never build JavaScript on Harper regardless of the performance differences.

3. **Server-side work**: Benchmarks must focus on the parts of the system we actually control. Basically, any server-side work. Anything dominated by static asset delivery, browser rendering, or client-side JavaScript evaluation is out of scope since its out of the control of the tested systems.

### Specification

> Note: this will eventually be moved to a separate document likely alongside Harper's golden implementation.

An ecommerce store

#### P0

- `POST /cart/:id/quote` — read cart, then product and variant per line, then inventory per line and fulfillment location, then customer tier and loyalty balance, then eligible promos by tier, SKU, and category. Evaluate stacking, exclusivity, threshold, and BOGO rules in JavaScript, some of which trigger further reads. Then shipping rate by region and total weight, and tax by jurisdiction. Roughly four to five dependent waves, 60 to 150 record reads, and real pricing logic. Every response is unique to the cart.
- `GET /product/:id?tier=&region=` — the PDP aggregate, for the read-heavy leg. Product, variants, inventory, resolved price, review rollup, related items. Mostly cacheable, but varies by tier and region.

Eight tables, two endpoints, one seeded dataset, one load generator with a realistic cart-size distribution.

> Reasoning for this P0
> 
> An architectural difference only appears where the architecture does work. A request that reads one record and returns it mostly measures Node's HTTP and JSON layers, which every entry pays for equally. A request that fans out, waits on the result, fans out again, and then computes something is where crossing a process boundary incurs cost.
>
> The cart quote is also deliberately uncacheable at the response layer: every response is unique to its cart, so no entry can win by returning a stored response. Entity caches still do their normal job, which is the job real deployments give them.

#### Future Work

Storefront UI, auth flows, product listing pages, search, checkout commit, images, and realtime.

> Omitted for now to get preliminary methodology and implementations off the ground.

### Conformance

As part of Harper's golden implementation and a detailed specification document, there will exist automated conformance and verification tests. These will likely look like E2E tests so they are implementation agnostic. These should not be the only mechanism for evaluating an implementation for fairness and correctness, but is a required step.

As the application specification grows, we may extrapolate certain parts into a shared library that all implementations can use to minimize differences.

All implementations are built in their own recommended form. Avoid sandbagging by implementing things inefficiently or incorrectly. An assembled stack gets the indexes its database documentation calls for, a cache sized and exercised the way a real deployment would size it, and the configuration its vendor recommends. This is best effort; sometimes the most optimized solution is not well documented. This is why this work is open source. Anyone is welcome to improve implementations at any time.

## Comparison Heuristics

Comparisons should isolate what aspect they fix for a benchmark run.

All published work should be explicitly clear what it tested.

1. **Fixed-resources**: Every target gets the **same CPU and RAM**, summed across all of its processes, wherever they run. An architecture spread across three instances pays for all three out of the same budget as a single-process entry. Clocks are pinned. The primary metric is **throughput**; latency identifies where the system stops meeting its target. This track answers the architectural question and is the one that runs first.

2. **Fixed-cost**: Targets are matched on spend rather than hardware, because vendor tiers are otherwise incomparable. The primary metric is **delivered latency**. Deployment region, tier, autoscaling, and pricing are all live variables here, which is exactly why they are excluded from the fixed-resource track.

The tracks are related. Higher throughput on fixed hardware means fewer machines for the same request rate, which lowers cost or lets the same budget cover more geography, which reduces the network latency a user experiences.

### Local first, but be fair

Every comparison starts **locally**, with all targets containerized on one machine under a fixed CPU budget. Local runs are cheap, reproducible, and isolate architectural differences well. They support claims about request-path hop count, server time, CPU per request, and where an entry falls over under load. They do not support delivered-latency or hosted-tier claims.

Once a local run produces a signal, we may proceed to a **deployed** analysis. Both data sets are kept. Where a component cannot run locally, or its local build does not represent the hosted product, that is documented and follow-up work uses the live comparison only. For example, local Supabase uses different PostgREST versions, no connection pooler, no shared-CPU neighbours. Its local numbers do not carry to production and thus should be omitted from a final results report.

### Measurement rules

> Many of these rules comes from automated agentic runs and analysis from early and continue experiments. They are generalized for future analysis to be more efficient in their data gathering procedures.

- **Pin the CPU clock and record it with every result**: A machine that falls from 3.5 GHz to 0.85 GHz once its turbo budget expires can change ops per CPU-second by a dramatic amount on identical work. Pinning has proven to be more consistent. Report efficiency as ops per CPU-**gigacycle**, not CPU-second, and re-run any rep whose clock drifts. Shared-tenant cloud CPUs have the same failure mode with less visibility, so a published number carries its clock.
- **Guard every target against silent misconfiguration**: A misconfigured system usually produces a plausible number rather than an obvious failure. In one vector run, a pgvector operator mismatch silently became a sequential scan, a Qdrant setting left it on brute-force search reporting full recall at every parameter, and an index answered queries before it finished building. A throughput-only benchmark reports all three as results. Every target should carry a ground-truth correctness check that catches this, and those checks stay in the harness.
- **Measure every target in one session**: pgvector's own numbers moved 18% between sessions on identical hardware. Cross-session ratios are not sound.
- **Run a load ladder**: A single saturating concurrency produces no inflection point. The reportable result is "sustains N more requests per second before p99 crosses threshold T," which requires the ladder to be in the harness from the start.
- **Account for CPU per target, not just in total**: In one stack run, the HTTP framework alone used 40.3 of 60.8 CPU-seconds, the database 17.0, the cache 3.5. Without that breakdown there is no way to tell whether an advantage is architectural or hidden behind a cost both sides pay. This is also why collecting results over multiple separated application configurations is important for accurate results. We don't care about a single technologies performance, instead we care about Harper's holistic performance difference.
- **Use an open load model**: Constant arrival rate, one target per run. Never drive two targets from one closed loop; the slower one throttles the load offered to the faster one.
- **Report distributions, not medians alone**: Raw per-request samples across repeated trials, with the range shown. Overlapping trial ranges mean the cell is unresolved, not a win. Every sample is retained so proper intervals can be applied later without re-running.
- **Record exact run conditions**: versions, clocks, instance types, dataset shape, measured cache-hit rates, worker counts. Record shape matters — small records mostly measure the HTTP and JSON layers rather than the datastore, compressing the very difference being measured.
- **Report each entry's advantages, not only its losses**: Where an architecture lets an entry skip work another must do, that is stated. The disclosure is what makes the wins credible.
- **Never use tmpfs**: It distorts file I/O enough to invalidate storage comparisons.

The harness implementing clock pinning, cycle-normalized efficiency, per-target CPU accounting, cache-hit measurement, and correctness guards is shared across comparisons rather than rebuilt per entry.

### Implementations

Implementations should be built directly in this repo in standalone directories named to match the specific service/framework/platform. You may have multiple copies for different active major versions of things. Each one of these directories doesn't have to implement the entire application spec; just some distinct part.

A comparison will then combine these implementations into one stack for benchmarking. The comparison itself will exist in its own directory too. It will eventually be copied into its own snapshot repo, so consider this more of a temporary workspace. Within this repo, try not to copy implementations; instead use file paths to reference things.

Not a strict specification yet, but consider using some top-level folders like `implementations` and `comparisons`. More natural organization will come in time. The Harper implementation will live externally from this repo.

## Reporting results

Results are to be published as measured. **A result is never omitted after the fact.**

Three outcomes are distinct:

- **Measure loss**: should be published as measured. It also becomes engineering work for Harper to improve itself, and the comparison re-runs once that work lands. A benchmark that forces the platform to improve before it can be published has done its job.
- **Capability gap**: some functionality an entry does not implement belongs in a capability matrix with no performance number in either direction. A latency figure against an absent feature measures nothing.
- **Non-equivalent semantics**: is not a result at all. If two entries offer different guarantees, the cell is invalid rather than close. It is fixed to match or scoped out with the reason stated. Equal latency under a weaker guarantee is not a tie.

Every published comparison is a dated snapshot identifying the versions it compared, with the source that produced it. Minor corrections are accepted, but major changes likely require a new analysis and publication.

- **Reproduce**: Every run documents its conditions and its steps. Deployment is automated where possible; where a platform has to be set up by hand, every step is written down.
- **Submit**: Outside entries are accepted. An entry that passes conformance and follows the measurement rules is published on the same terms as any other.
- **Challenge**: A published result can be disputed. A challenge that identifies a real methodology or implementation flaw is fixed and the affected results re-run.

## Procedure

The doc up to this point defines most of the procedure at a high level. This section breaks things down into more specific steps with extra details.

### 0. Rough benchmark first

Before writing a plan, build and measure a rough version. Agent time is cheaper than human-verified planning time, so test the idea before specifying it. A rough cut costs about a day and no direct spend.

Keep the prompt general. Describe the comparison, let the agent choose an approach, correct it as it goes. Over-specifying the setup up front sends it down the wrong path.

Nothing from a rough cut is published. Its output is a findings document: where the result lands, how large the effect is, which measurement traps appeared, and how the real benchmark should be framed. Rough cuts routinely surface problems no plan anticipated.

The agent should do work in this repo directly at this stage. Create a worktree and branch. Create a new directory. Use existing implementations, modify or update them as needed. Create new ones that loosely match the spec; strict verification is unnecessary. Write the output file, commit, and present work to the user.

### 1. Define the comparison

From the rough draft, clarify and define the intended stack exactly. Modify the directory name or create a new one, and start a `plan.md` document that clearly defines exactly what systems are to be combined for the official comparison. If a similar stack already exists you may include version numbers or quarters or dates in the name to keep it unique.

### 2. Plan it

Now fill in the rest of `plan.md`: implementation steps with specific component names and versions, deployment steps, expected metrics, project structure, key tooling. Quote the reference application's specification. Fold in what the rough cut found.

This is where you can start deciding if it should use an existing implementation, modify/update one, or create new things.

Simplicity is key here. Do not let your agent hallucinate a lengthy document. Just like in the rough benchmark prompt; simplicity is better than over specification. Most of the procedure is agentic and you can always correct things live as you iterate.

### 3. Review the plan

Review manually first — versions current, approach valid, nothing overcomplicated. Then cross-review with several models using different personas, and iterate. Then have at least one other person review it, with feedback based on reading the plan or the review themselves rather than forwarding agent output.

### 4. Implement

Use agents, mostly autonomously, with tests required and the work staged MVP-first. Unlike step 0, implementation receives the plan, the reference application, and the verification suite up front, because it is executing an agreed design rather than exploring.

Run locally first, then deploy. Document actual deployment steps as you go.

### 5. Review the implementation

Review against the plan for bugs and inefficiencies; agentic personas are especially useful here. No benchmarking yet; this stage is correctness only. Passing conformance is necessary but not sufficient — the entry must also use its stack well.

Consider using "adversarial" agent personas. Tell the agent thats reviewing to pretend to be a maintainer of or employee of the competitive technology / platform company. Agents tend to be affirmative by default; we want it to challenge our work here.

### 6. Benchmark and analyze

Run under the measurement rules. Local first, deployed second. Every target runs the same way, including reference implementations that carry their own independent benchmarks; those are a starting point, never a substitute for a fresh run in the same session.

Keep it simple and focussed.

### 7. Review the benchmarks

Cross-review with several models, some adversarial. Re-run where needed. Review manually as well — a bad benchmark is worse than no benchmark.

### 8. Publish

Freeze the comparison as a dated snapshot with pinned versions and full reproduction documentation. Link it from the results board. For a significant re-run, fork and start again rather than editing a published snapshot.

## Results

### Predating this methodology

| Comparison | Composition | Track | Date | Source |
|-|-|-|-|-|
| Next.js v16 full stack app | Vercel | Fixed-cost | June 2026 | https://github.com/HarperFast/harper-vs-vercel-benchmark |
| Event pipeline | Kafka + Redis + Postgres + Debezium + Kafka Streams | Fixed-resource | May 2026 | https://github.com/HarperFast/kafka-v-harper-perf-test |
| Microservices | MongoDB | Fixed-resource | December 2025 | https://github.com/HarperFast/harper-vs-microservices-perf-test |

Entries predating this methodology are listed for completeness and are not comparable to results produced under it.

### New comparisons following this methodology

> Coming soon!

## Discoverability

A comparison is not finished until it can be found by people and by the models they now ask.

- Link each published comparison from `llms.txt` / `llms-full.txt` and the docs.
- `docs.harperdb.io` is canonical for both files. `harper.fast` is a Webflow site and cannot host `llms-full.txt`, so use `https://docs.harperdb.io/llms-full.txt` for the full file and treat `harper.fast/llms.txt` as the entry point.
