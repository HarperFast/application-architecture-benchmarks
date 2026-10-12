# Harper Application Architecture Benchmarks

An open system for benchmarking Harper's collapsed stack application architecture against separated stack architecture and platforms.

The purpose of this being open source is so that the wider community, including the projects and companies we are comparing ourselves against, can openly provide feedback and contribute. Anyone may reference this work, and contributions are accepted.

**Primary Hypothesis**: Harper's collapsed stack architecture is holistically more efficient than a generalized separated application architecture.

Generalized separated application architectures means that we aren't targeting just one technology or stack. These benchmarks set out to prove that Harper applications are more efficient than any combination of separated services.

The high-level plan is to implement a single application specification on Harper as well as across a matrix of other technologies. While the Harper implementation will remain the same, the competitive application may swap Postgres for MongoDB, Redis for Memcached, Fastify for Express, etc.

Every stack added to the matrix is an attempt to break the hypothesis, not to confirm it. It holds while Harper keeps outperforming the combinations tested, and a stack that beats Harper falsifies it for that workload. When that happens the result is published as measured, the cause is investigated, and the hypothesis is restated to match what was actually measured. See [Reporting results](#reporting-results).

Importantly, this work is not meant to isolate the performance of any singular technology. In many cases, lots of the services evaluated here could beat Harper in isolated testing scenarios. The point is we are analyzing the **holistic application experience**.

This repo is the living workspace for the benchmark work. No comparison results are published here. **All results are published in standalone snapshot repositories that reflect the exact state of the applications at the time of testing**. Those repos accept contributions too, but should be focussed on correcting minor details. Making large changes or major version upgrades should likely start here and then a new analysis should be conducted (and thus a new snapshot repo published). This organization keeps everything honest and historically referenceable.

## Claims, and doing no harm

Most of the technologies measured here are open source projects maintained by communities, not products sold by competitors. That distinction governs how every result is described.

Results are about architectures, never about a project. A published claim compares Harper to an assembled stack — "Harper sustains N% more requests per second than a separated architecture on the same resources" — and never takes the form "Harper is X times faster than Y framework". Claims of that second kind are vetoed. Several of the frameworks in this matrix are supported ways to build on Harper, so a claim against them would be both self-contradictory and hostile to people who have done us no harm.

Competitive claims that name a company are legitimate, and they come from platform as a service comparisons, where the thing being measured is a commercial product rather than a community project.

Where a benchmark makes an open source project look bad, the first assumption is that we configured it wrong. That is much of why this repo is public and why contributions are accepted from the projects being measured.

## Terminology

These words are used precisely throughout this document.

- **Harper Core**: the Harper platform itself (runtime, storage, and APIs). Source at [`harperfast/harper`](github.com/harperfast/harper) and published as `harper` on npm.
- **Application**: a complete implementation of the [specification below](#specification). Built on Harper it is one process; built on a separated architecture it is several processes.
- **Stack**: the set of technologies an application is assembled from. Fastify + Postgres + Redis is a stack. Harper is a stack of one.
- **Platform as a service**: a hosted, managed offering. Fabric is one. So are Supabase, MongoDB Atlas, and Redis Cloud.
- **Comparison**: one benchmark run pitting a Harper application against one or more applications built on other stacks.

## Application Scope

1. **Ecommerce**: The reference application is an enterprise-level ecommerce store, sized to reflect Harper's existing customer base. Sweeping "store size" as a variable is out of scope; the catalog is fixed at one enterprise scale so that a comparison measures the architecture rather than the dataset. See [Dataset](#dataset).

2. **JavaScript**: Application logic should primarily run on JavaScript. It's fine if some aspects (such as the database or caching layer) are non-Node.js, but the core application logic (like any frontend or backend API pieces) should be Node.js compatible. Harper itself is strictly a Node.js compatible platform. There is little point to comparing to say a Python or .Net backend service if that audience would never build JavaScript on Harper regardless of the performance differences.

3. **Server-side work**: Benchmarks must focus on the parts of the system we actually control. Basically, any server-side work. Anything dominated by static asset delivery, browser rendering, or client-side JavaScript evaluation is out of scope since it's out of the control of the tested systems.

### Specification

> Note: this will eventually be moved to a separate document likely alongside Harper's golden implementation.

The specification is defined by endpoint, in priority order.

#### P0

- `POST /cart/:id/quote` — read cart, then product and variant per line, then inventory per line and fulfillment location, then customer tier and loyalty balance, then eligible promos by tier, SKU, and category. Evaluate stacking, exclusivity, threshold, and BOGO rules in JavaScript, some of which trigger further reads. Then shipping rate by region and total weight, and tax by jurisdiction. Roughly four to five dependent waves, 60 to 150 record reads, and real pricing logic. Every response is unique to the cart.
- `GET /product/:id?tier=&region=` — the PDP aggregate, for the read-heavy leg. Product, variants, inventory, resolved price, review rollup, related items. Mostly cacheable, but varies by tier and region.
- **Background writes** — a steady, low-rate stream of inventory and price updates against the same records the read path touches. This is not an endpoint under test and its own latency is not a headline metric. It exists so that caches have to stay coherent with their source of truth.

Eight tables, two endpoints, one background writer, one seeded dataset, one load generator with a realistic cart-size distribution.

> Reasoning for this P0
> 
> An architectural difference only appears where the architecture does work. A request that reads one record and returns it mostly measures Node's HTTP and JSON layers, which every implementation pays for equally. A request that fans out, waits on the result, fans out again, and then computes something is where crossing a process boundary incurs cost.
>
> The cart quote is also deliberately uncacheable at the response layer: every response is unique to its cart, so no implementation can win by returning a stored response. Entity caches still do their normal job, which is the job real deployments give them.
>
> The background writes exist for the same reason. A read-only workload lets a separated stack's cache fill once and never invalidate, which is not a cache any real store operates. A steady write stream makes cache coherence a cost the architecture has to actually pay, and keeping data consistent across processes is one of the places a collapsed architecture should show an advantage.

#### Dataset

The dataset is generated once and kept under version control. Every implementation loads the exact same data, so there is no potential variance.

There is one size: large, reflective of a real Harper customer's catalog. There is no smaller in-memory variant. A dataset that fits entirely in cache is not representative of Harper's normal customer workloads.

#### Future Work

Storefront UI, auth flows, product listing pages, search, checkout commit, images, and realtime.

> Omitted for now to get preliminary methodology and implementations off the ground.

### Conformance

As part of Harper's golden implementation and a detailed specification document, there will exist automated conformance and verification tests. These will likely look like E2E tests so they are implementation agnostic. These should not be the only mechanism for evaluating an implementation for fairness and correctness, but they are a required step.

As the application specification grows, we may extrapolate certain parts into a shared library that all implementations can use to minimize differences.

All implementations are built in their own recommended form. Avoid sandbagging by implementing things inefficiently or incorrectly. An assembled stack gets the indexes its database documentation calls for, a cache sized and exercised the way a real deployment would size it, and the configuration its vendor recommends. This is best effort; sometimes the most optimized solution is not well documented. This is why this work is open source. Anyone is welcome to improve implementations at any time.

## Comparison Heuristics

Comparisons should isolate what aspect they fix for a benchmark run. All published work should be explicitly clear about what it tested.

There are two kinds of comparisons.

### Stack comparisons

An application built on Harper against an application assembled from other technologies: Fastify, Postgres, Redis, MongoDB, Memcached, and so on. Every target gets the **same CPU and RAM**, summed across all of its processes, wherever they run. An architecture spread across three instances pays for all three out of the same budget as a single-process application. Clocks are pinned. The primary metric is **throughput**; latency identifies where a system stops meeting its target.

This is where the primary hypothesis is tested. It is the most tightly constrained and defensible measurement available to us, and it is cheap — a single Linux VM for the duration of a run. It is also the only kind of comparison that involves open source projects directly, so it carries the strictest rules about how results are described.

### Platform as a service comparisons

Harper Fabric against Supabase, MongoDB Atlas, Redis Cloud, and similar. Targets are matched on **spend** rather than hardware, because vendor tiers are otherwise incomparable. The primary metric is **delivered latency**, because latency for a dollar figure is what a customer is actually buying.

This is where competitive claims that name a company come from. It requires deployment, a budget, and a stack comparison to build on.

### Sequence

Stack comparisons run first, and the first round of published work is stack comparisons only. Once autoscaling, instance tiers, and regions are live variables there is too much to defend at once. A platform as a service comparison takes the same application specification, the same harness, and the findings from the earlier [environment tiers](#environment-tiers), and levels them up to production.

The two are linked by efficiency. Higher throughput on fixed hardware means fewer machines for the same request rate. That lowers cost, or it lets the same budget cover more geography, which reduces the network latency a user experiences.

That link also means cost does not always require a deployed run. Measured throughput against a known resource budget can be priced with published list rates to produce a cost-per-request figure. It is not a substitute for a delivered-latency comparison, but it answers the economic question without introducing the variables that make one hard to defend.

### Environment tiers

Every comparison moves through up to three environments, in order. Each one removes a caveat the one before it carried, and each one costs more to run. Nothing in any tier runs natively on a host — every target is containerized everywhere, including during the [rough benchmark](#0-rough-benchmark-first). A native process and a containerized one do not pay the same networking and I/O costs, and mixing the two produces a difference that has nothing to do with architecture.

**Tier 1 — containers on a local machine.** All targets containerized on one developer machine under a fixed CPU and memory budget. Cheap, reproducible, and fast to iterate on. This tier is where the harness gets built, where implementations get debugged, and where we learn which workloads an architecture wins or loses at.

It produces signal, not results. On macOS the container runtime is a virtual machine: CPU and memory limits are enforced against the VM's share rather than the host's, the VM boundary sits in the network path, and the CPU clock can be neither pinned nor counted, so no ops-per-CPU-gigacycle figure exists at all. The caveats are large enough that local numbers are not published as results. That holds on a Linux laptop too — a machine under thermal management is not a measurement environment.

**Tier 2 — a Linux host on GCP.** The same containers, the same budgets, the same harness, on a dedicated Linux VM. This is where stack comparisons become publishable: cgroup limits are enforced against real hardware, the clock is bounded at all-core turbo and measured with per-target cycle counts, and per-target CPU accounting is trustworthy. Everything in [Measurement rules](#measurement-rules) is satisfiable here and only here.

The instance is a plain VM, not Fabric. Fabric is a good environment for Harper and a poor one for Postgres, and a stack comparison that handicaps one side is not a comparison. Fabric belongs in tier 3, where it is the product under test rather than the substrate.

Any staff member can create a GCP project and link it to the company billing account, which carries credits. [`HarperFast/sharded-blob-test`](https://github.com/HarperFast/sharded-blob-test/tree/main/provisioning/gcp) has existing GCP provisioning worth reusing. Provision through the CLI, keep the work in a project scoped to it so spend is attributable, and tear instances down after a run rather than leaving them parked. GCP is a convenience choice rather than a methodological one — Linode or another provider would serve equally well — so the provider is recorded with the run. The procedure, the recommended instance, and what the clock can and cannot do on GCP are in [`environments/gcp`](environments/gcp/README.md).

**Tier 3 — a platform as a service.** Fabric against Supabase, MongoDB Atlas, Redis Cloud, and similar. Optional, in that tiers 1 and 2 already produce a complete and publishable stack comparison, but expected for most comparisons, because this is the only tier that produces competitive claims naming a company. See [Platform as a service comparisons](#platform-as-a-service-comparisons).

Containerization is itself a measurement choice, not a neutral wrapper. Container networking costs real latency, and a target running host networking against one running bridged is not a fair comparison — that difference alone can be larger than the architectural difference being measured. Every target is containerized identically, Harper included, and the networking mode is recorded with the run.

Data from every tier is kept. Where a component cannot run in an earlier tier, or its build there does not represent the hosted product, that is documented and follow-up work uses the later tier only. For example, local Supabase uses different PostgREST versions, no connection pooler, no shared-CPU neighbours. Its local numbers do not carry to production and thus should be omitted from a final results report.

### Run lifecycle

Every target moves through the same phases in the same order. How a system is loaded determines what is resident when measurement starts, so this cannot vary between targets.

1. **Seed**: load the versioned dataset. Not measured. Bulk loading hundreds of thousands of records is a one-off operation, not application behaviour a customer experiences.
2. **Cold start**: start the target and measure time to first successful response.
3. **Warm-up**: drive a fixed warm-up workload, identical in volume and key distribution for every target. This is not a per-target tuning budget.
4. **Measure**: the reported run.

Cold, warm, and hot are three different numbers and all three are worth reporting. Only reporting the hot number hides how long a system takes to become useful, which matters for anything that redeploys or scales out.

Because the workload includes writes, state does not survive between trials. Every trial starts from a restored dataset so that the third trial is not measuring a catalog the first two already mutated.

### Measurement rules

> Many of these rules come from automated agentic runs and analysis during early and ongoing experiments. They are generalized for future analysis to be more efficient in their data gathering procedures.

- **Pin the CPU clock where the host allows it, otherwise bound and measure it, and record it with every result**: A machine that falls from 3.5 GHz to 0.85 GHz once its turbo budget expires can change ops per CPU-second by a dramatic amount on identical work. Pinning has proven to be more consistent. Report efficiency as ops per CPU-**gigacycle**, not CPU-second, and re-run any rep whose clock drifts. Where the clock cannot be pinned, as on a GCP VM, bound it (all-core turbo, with single-core boost disabled) and count each target's cycles with hardware performance counters, so gigacycles are measured rather than inferred from an assumed frequency. Record the effective frequency per step, and publish the figure as "all-core turbo, measured at N GHz", never as pinned. An environment where the clock can be neither pinned nor counted, such as a container runtime inside a macOS VM, cannot produce this figure at all, which is why those runs stay in [tier 1](#environment-tiers). Shared-tenant cloud CPUs have the same failure mode with less visibility, so a published number carries its clock.
- **Guard every target against silent misconfiguration**: A misconfigured system usually produces a plausible number rather than an obvious failure. In one vector run, a pgvector operator mismatch silently became a sequential scan, a Qdrant setting left it on brute-force search reporting full recall at every parameter, and an index answered queries before it finished building. A throughput-only benchmark reports all three as results. Every target should carry a ground-truth correctness check that catches this, and those checks stay in the harness.
- **Measure every target in one session**: pgvector's own numbers moved 18% between sessions on identical hardware. Cross-session ratios are not sound.
- **Run a load ladder**: A single saturating concurrency produces no inflection point. The reportable result is "sustains N more requests per second before p99 crosses threshold T," which requires the ladder to be in the harness from the start.
- **Account for CPU per target, not just in total**: In one stack run, the HTTP framework alone used 40.3 of 60.8 CPU-seconds, the database 17.0, the cache 3.5. Without that breakdown there is no way to tell whether an advantage is architectural or hidden behind a cost both sides pay. This is also why collecting results over multiple separated application configurations is important for accurate results. We don't care about a single technology's performance, instead we care about Harper's holistic performance difference.
- **Use an open load model**: Constant arrival rate, one target per run. Never drive two targets from one closed loop; the slower one throttles the load offered to the faster one.
- **Prove the load generator is not the bottleneck**: The generator's own CPU and its headroom are recorded alongside every result, and a run where it saturates is discarded rather than reported. If it shares a machine with the targets it must sit outside their resource budget, otherwise the generator is quietly spending the budget the architecture is being measured on.
- **Report distributions, not medians alone**: Raw per-request samples across repeated trials, with the range shown. Overlapping trial ranges mean the cell is unresolved, not a win. Every sample is retained so proper intervals can be applied later without re-running.
- **Record exact run conditions**: versions, clocks, instance types, dataset shape, measured cache-hit rates, worker counts. Record shape matters — small records mostly measure the HTTP and JSON layers rather than the datastore, compressing the very difference being measured.
- **Report each implementation's advantages, not only its losses**: Where an architecture lets an implementation skip work another must do, that is stated. The disclosure is what makes the wins credible.
- **Never use tmpfs**: It distorts file I/O enough to invalidate storage comparisons.

The harness implementing clock pinning or cycle counting, cycle-normalized efficiency, per-target CPU accounting, cache-hit measurement, and correctness guards is shared across comparisons rather than rebuilt for each one.

### Implementations

Implementations should be built directly in this repo in standalone directories named to match the specific service/framework/platform. You may have multiple copies for different active major versions of things. Each one of these directories doesn't have to implement the entire application spec; just some distinct part.

A comparison will then combine these implementations into one stack for benchmarking. The comparison itself will exist in its own directory too. It will eventually be copied into its own snapshot repo, so consider this more of a temporary workspace. Within this repo, try not to copy implementations; instead use file paths to reference things.

Not a strict specification yet, but consider using some top-level folders like `implementations` and `comparisons`. More natural organization will come in time.

The Harper implementation is the exception, and lives in its own repository rather than here. It is more than a benchmark target: it is the reference for how to build an efficient Harper application, it carries the conformance suite that defines the specification, and it is tested and independently benchmarked against every significant Harper release. Comparisons in this repo reference it rather than keeping a copy.

## Other benchmarks

Architecture comparisons are the reason this repo exists, but they are not the only benchmarking worth keeping here.

Component benchmarks measure one piece of Harper Core against its direct equivalent: a vector index against another vector index, a storage engine against another storage engine. These are engineering work first. They run continuously, they inform what gets optimized, and they are how we know where Harper actually stands rather than where we assume it stands.

They belong here, with two conditions. The measurement rules above apply in full, especially the correctness guards. And equivalence has to suit the domain — an approximate index is compared at matched recall, because any approximate index can be made arbitrarily fast by searching less of the graph, and throughput quoted without the recall it achieved is marketing rather than measurement.

A component benchmark can be published on its own merits. It is not a substitute for an architecture comparison, and a component result never becomes an architecture claim.

Separately, Harper Core carries its own performance benchmarks in the [`benchmarks`](https://github.com/HarperFast/harper/tree/main/benchmarks) directory of `harperfast/harper`. Those measure Harper against itself as it changes, and they stay there. The dividing line is what a benchmark is measured against: Harper against a previous Harper belongs in that repo, Harper against anything else belongs here.

## Reporting results

Results are to be published as measured. **A result is never omitted after the fact.**

Three outcomes are distinct:

- **Measured loss**: should be published as measured. It also becomes engineering work for Harper to improve itself, and the comparison re-runs once that work lands. A benchmark that forces the platform to improve before it can be published has done its job.
- **Capability gap**: some functionality an implementation does not include belongs in a capability matrix with no performance number in either direction. A latency figure against an absent feature measures nothing.
- **Non-equivalent semantics**: is not a result at all. If two implementations offer different guarantees, the cell is invalid rather than close. It is fixed to match or scoped out with the reason stated. Equal latency under a weaker guarantee is not a tie.

Every published comparison is a dated snapshot identifying the versions it compared, with the source that produced it. Minor corrections are accepted, but major changes likely require a new analysis and publication.

- **Reproduce**: Every run documents its conditions and its steps. Deployment is automated where possible; where a platform has to be set up by hand, every step is written down.
- **Submit**: Outside implementations are accepted. An implementation that passes conformance and follows the measurement rules is published on the same terms as any other. Open a pull request against this repo adding the implementation under its own directory.
- **Challenge**: A published result can be disputed. A challenge that identifies a real methodology or implementation flaw is fixed and the affected results re-run. Open an issue on this repo, or on the snapshot repo the result was published in, describing what you believe is wrong and how to demonstrate it.

We would rather find out we configured something badly than publish a number we have to retract. A submission that makes an assembled stack faster is a contribution, not an attack, and it is treated that way.

## Procedure

The doc up to this point defines most of the procedure at a high level. This section breaks things down into more specific steps with extra details.

### 0. Rough benchmark first

Before writing a plan, build and measure a rough version. Agent time is cheaper than human-verified planning time, so test the idea before specifying it. A rough cut costs about a day and no direct spend.

Keep the prompt general. Describe the comparison, let the agent choose an approach, correct it as it goes. Over-specifying the setup up front sends it down the wrong path.

Nothing from a rough cut is published. Its output is a findings document: where the result lands, how large the effect is, which measurement traps appeared, and how the real benchmark should be framed. Rough cuts routinely surface problems no plan anticipated.

The agent should do work in this repo directly at this stage. Create a worktree and branch. Create a new directory. Use existing implementations, modify or update them as needed. Create new ones that loosely match the spec; strict verification is unnecessary. Write the output file, commit, and present work to the user.

Run every target in a container, on the local machine, even at this stage. Rough does not mean native — containerizing from the first run keeps the variance down and means the harness built here carries forward to the Linux host unchanged.

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

Work through the [environment tiers](#environment-tiers) in order: containers locally, then the GCP Linux host, then a platform as a service if the comparison goes that far. Document actual provisioning and deployment steps as you go.

### 5. Review the implementation

Review against the plan for bugs and inefficiencies; agentic personas are especially useful here. No benchmarking yet; this stage is correctness only. Passing conformance is necessary but not sufficient — the implementation must also use its stack well.

Review from both directions. One pass steelmans the implementation: is this genuinely the best version of this stack, and what would make it faster? Another pass is adversarial, with the agent playing a maintainer of or engineer at the competitive technology, looking for what we got wrong. Agents tend to be affirmative by default, so the adversarial pass has to be asked for explicitly. It supplements the favorable review rather than replacing it, and the two together catch different things.

### 6. Benchmark and analyze

Run under the measurement rules, in tier order. Local container runs are for shaking out the harness and the implementations; the numbers that get reported come from the Linux host, and the platform as a service tier after that. Every target runs the same way, including reference implementations that carry their own independent benchmarks; those are a starting point, never a substitute for a fresh run in the same session.

Keep it simple and focussed.

### 7. Review the benchmarks

Cross-review with several models, some adversarial. Re-run where needed. Review manually as well — a bad benchmark is worse than no benchmark.

### 8. Publish

Freeze the comparison as a dated snapshot with pinned versions and full reproduction documentation. Link it from the [results index](#results-index). For a significant re-run, fork and start again rather than editing a published snapshot.

## Results index

An index, not a home. Every comparison lives in its own snapshot repository; this table points at them.

### Predating this methodology

| Comparison | Composition | Kind | Date | Source |
|-|-|-|-|-|
| Next.js v16 full stack app | Vercel | Platform as a service | June 2026 | https://github.com/HarperFast/harper-vs-vercel-benchmark |
| Event pipeline | Kafka + Redis + Postgres + Debezium + Kafka Streams | Stack | May 2026 | https://github.com/HarperFast/kafka-v-harper-perf-test |
| Microservices | MongoDB | Stack | December 2025 | https://github.com/HarperFast/harper-vs-microservices-perf-test |

These predate this methodology. They are listed for completeness and are not comparable to results produced under it.

### New comparisons following this methodology

> Coming soon!

## Discoverability

A comparison is not finished until it can be found by people and by the models they now ask.

- Link each published comparison from `llms.txt` / `llms-full.txt` and the docs.
- `docs.harperdb.io` is canonical for both files. `harper.fast` is a Webflow site and cannot host `llms-full.txt`, so use `https://docs.harperdb.io/llms-full.txt` for the full file and treat `harper.fast/llms.txt` as the entry point.
