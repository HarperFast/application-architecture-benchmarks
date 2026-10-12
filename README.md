# Harper Application Architecture Benchmarks

An open project comparing Harper's collapsed application stack with separated stacks and managed platforms. Anyone may reference this work, give feedback, or contribute, including the projects and companies being compared.

**Primary hypothesis:** Harper's collapsed stack architecture is more efficient overall than a generalized separated application architecture.

The hypothesis covers any combination of separated services, not one chosen competitor. We implement the same application specification on Harper and a matrix of other technologies. The Harper implementation stays the same while other stacks may swap Postgres for MongoDB, Redis for Memcached, Fastify for Express, and so on.

Each added stack tests whether the hypothesis holds. If a stack beats Harper, the hypothesis is false for that workload. Publish the result, investigate the cause, and restate the hypothesis to match the evidence. See [Reporting results](#reporting-results).

These comparisons measure the whole application. Individual services may beat Harper in isolated tests; that is a different question.

This repo is the working area. **Comparison results are published only in standalone snapshot repositories containing the exact application state tested.** Those repos accept minor corrections. Large changes or major version upgrades should generally start here, followed by a new analysis and snapshot, so past results remain traceable.

## Claims, and doing no harm

Most technologies measured here are community-maintained open source projects. That governs how we describe results.

Architecture claims compare Harper with an assembled stack: “Harper sustains N% more requests per second than a separated architecture on the same resources.” Claims such as “Harper is X times faster than Y framework” are prohibited. Several frameworks in the matrix are also supported ways to build on Harper; attacking them would contradict that support and harm their communities.

Claims naming a company come from platform as a service comparisons, which measure commercial products.

If a result makes an open source project look bad, first assume we configured it wrong. Keeping the work public lets the projects being measured help correct it.

## Terminology

- **Harper Core**: the platform itself: runtime, storage, and APIs. Source: [`harperfast/harper`](https://github.com/harperfast/harper); npm package: `harper`.
- **Application**: a complete implementation of the [application specification](https://github.com/HarperFast/ecommerce-store/blob/main/SPEC.md). One process on Harper; several on a separated architecture.
- **Stack**: the technologies used to build an application, such as Fastify + Postgres + Redis. Harper is a stack of one.
- **Platform as a service**: a hosted, managed offering, such as Fabric, Supabase, MongoDB Atlas, or Redis Cloud.
- **Comparison**: a benchmark run comparing a Harper application with one or more applications built on other stacks.

## Application Scope

1. **Ecommerce**: an enterprise store sized to reflect Harper's existing customers. The catalog has one fixed enterprise scale; varying store size is out of scope so comparisons measure architecture rather than dataset differences. See the [dataset requirements](https://github.com/HarperFast/ecommerce-store/blob/main/SPEC.md#invariants).
2. **JavaScript**: application logic should primarily use JavaScript and be Node.js compatible, including frontend and backend API code. Databases and caches may use other runtimes. Harper is strictly Node.js compatible; comparing Python or .NET backends would target developers unlikely to adopt Harper regardless of performance.
3. **Server-side work**: measure work the tested systems control. Workloads dominated by static asset delivery, browser rendering, or client-side JavaScript are out of scope.

### Specification

The stack-neutral application contract lives in [`ecommerce-store/SPEC.md`](https://github.com/HarperFast/ecommerce-store/blob/main/SPEC.md). It defines the endpoints, data model, dataset, caching, background writes, and observability requirements for every implementation.

The same repository holds the [Harper reference implementation](https://github.com/HarperFast/ecommerce-store), [project status and blockers](https://github.com/HarperFast/ecommerce-store/blob/main/docs/plan.md), and [deferred application work](https://github.com/HarperFast/ecommerce-store/blob/main/docs/future-work.md). This README defines the benchmark methodology and claim rules.

### Conformance

Every implementation must pass the [conformance suite](https://github.com/HarperFast/ecommerce-store/tree/main/e2e) and meet the specification's [conformance and review gate](https://github.com/HarperFast/ecommerce-store/blob/main/SPEC.md#conformance). Passing tests is required but does not by itself establish fairness or correctness. As the specification grows, shared libraries may reduce differences between implementations.

Build each implementation as its stack recommends. Use documented database indexes, realistically sized and exercised caches, and vendor-recommended configuration. Do not handicap a stack with inefficient or incorrect code. Optimization guidance is sometimes incomplete, so this is a best-effort requirement and improvements are welcome at any time.

## Comparison Heuristics

State what each comparison holds fixed and what it tests. There are two kinds.

### Stack comparisons

Compare a Harper application with one assembled from technologies such as Fastify, Postgres, Redis, MongoDB, and Memcached. Give every target the **same total CPU and RAM**, summed across all its processes and instances. Pin CPU clocks. **Throughput** is the primary metric; latency determines when a target stops meeting its service target.

Stack comparisons test the primary hypothesis under tightly controlled conditions. They need only a single Linux VM for the run and are our most defensible measurement. Because they involve open source projects directly, they carry the strictest claim rules.

### Platform as a service comparisons

Compare Harper Fabric with Supabase, MongoDB Atlas, Redis Cloud, or similar offerings. Match **spend**, since vendor hardware tiers are not directly comparable. **Delivered latency** is the primary metric: what latency does a customer get for that price?

These comparisons support claims naming a company. They require deployment, a budget, and a stack comparison to build on.

### Sequence

Run stack comparisons first; the first published round includes only those. Autoscaling, instance tiers, and regions add too many variables to defend at once. Later platform comparisons use the same specification and harness, plus findings from earlier [environment tiers](#environment-tiers), in production.

Higher throughput on fixed hardware means fewer machines for the same request rate. That can reduce cost or let the same budget serve more regions, reducing users' network latency.

A deployed run is not always needed to estimate cost. Price measured throughput and its known resource budget using published list rates to calculate cost per request. This answers a cost question but does not replace a delivered-latency comparison.

### Environment tiers

Move through up to three tiers in order. Each costs more and removes limitations of the previous tier. **Containerize every target in every tier**, including the [rough benchmark](#0-rough-benchmark-first). Mixing native and containerized targets introduces networking and I/O differences unrelated to architecture.

**Tier 1 — containers on a local machine.** Run all targets on one developer machine with fixed CPU and memory budgets. Use this inexpensive, reproducible setup to build the harness, debug implementations, and explore where architectures win or lose.

Local numbers are not publishable results. On macOS, limits apply to the container VM's share of resources, the VM adds a network boundary, and the CPU clock cannot be pinned, so ops per CPU-gigacycle cannot be reported. Linux laptops also remain in tier 1: thermal management makes them unsuitable for controlled measurements.

**Tier 2 — a Linux host on GCP.** Use the same containers, budgets, and harness on a dedicated Linux VM. Stack comparisons become publishable here: cgroup limits apply to real hardware, clocks can be pinned, and per-target CPU accounting is trustworthy. This is the only tier where all [Measurement rules](#measurement-rules) can be met.

Use a plain VM, not Fabric. Fabric suits Harper but handicaps Postgres. It belongs in tier 3 as the product being tested.

Provision through the CLI in a dedicated project so spend is attributable, and tear instances down after each run. Include reproducible provisioning steps with the comparison; keep private access and billing details in separate internal documentation. GCP is a convenience choice; Linode or another provider is equally valid. Record the provider with the run.

**Tier 3 — a platform as a service.** Compare Fabric with Supabase, MongoDB Atlas, Redis Cloud, or similar offerings. This tier is optional because tiers 1 and 2 suffice for a publishable stack comparison, but it is expected for most comparisons and is the only tier supporting claims naming a company. See [Platform as a service comparisons](#platform-as-a-service-comparisons).

Containerize all targets identically, including Harper, and record the networking mode. Host versus bridged networking alone can cause more latency difference than the architecture being measured.

Retain data from every tier. Document components that cannot run in an earlier tier or whose local build differs from the hosted product; use only the later tier for follow-up work on those components. For example, local Supabase has different PostgREST versions, no connection pooler, and no shared-CPU neighbours. Its local numbers do not represent production and should be omitted from final reports.

### Run lifecycle

Use the same phases, in order, for every target. Loading affects what is resident when measurement starts.

1. **Seed**: load the versioned dataset; this phase is not measured. Bulk loading hundreds of thousands of records is a one-off operation, not customer-facing application behavior.
2. **Cold start**: start the target and measure time to first successful response.
3. **Warm-up**: apply a fixed workload with identical volume and key distribution for all targets. This is not a tuning allowance for each target.
4. **Measure**: collect the reported run.

Cold, warm, and hot measurements are distinct and all are worth reporting. Hot numbers alone hide the time needed to become useful after deployment or scale-out.

Restore the dataset before every trial. Writes from earlier trials must not change what later trials measure.

### Measurement rules

These rules include lessons from early and ongoing automated benchmark runs.

- **Pin and record CPU clocks.** A drop from 3.5 GHz to 0.85 GHz after turbo expires can greatly change ops per CPU-second for identical work. Pinning has proved more consistent. Report ops per CPU-**gigacycle**, not CPU-second; repeat any trial with clock drift. If clocks cannot be pinned, as in a macOS container VM, this figure cannot be reported and the run stays in [tier 1](#environment-tiers). Shared-tenant cloud CPUs have the same risk with less visibility, so every published number must include its clock.
- **Check for silent misconfiguration.** Keep ground-truth correctness checks for every target in the harness. Plausible throughput can hide errors: in one vector run, a pgvector operator mismatch caused a sequential scan, a Qdrant setting left it using brute force with full recall at every parameter, and an index served queries before it finished building. Throughput alone would miss all three.
- **Measure every target in one session.** pgvector measurements moved 18% between sessions on identical hardware. Cross-session ratios are unsound.
- **Run a load ladder.** Include it in the harness from the start. A single saturating concurrency cannot locate the inflection point needed to report “sustains N more requests per second before p99 crosses threshold T.”
- **Account for CPU per target and component.** In one run, the HTTP framework used 40.3 of 60.8 CPU-seconds, the database 17.0, and the cache 3.5. A total alone cannot distinguish an architectural advantage from costs both stacks share. Test multiple separated-stack configurations to assess Harper's whole-application difference rather than one technology's performance.
- **Use an open load model.** Apply a constant arrival rate to one target per run. Never drive two targets from one closed loop: the slower target would throttle load to the faster one.
- **Verify generator headroom.** Record the load generator's CPU use and headroom with every result; discard saturated-generator runs. If it shares a machine with targets, keep it outside their resource budgets.
- **Report distributions.** Retain raw per-request samples across repeated trials and show the range, not just medians. Overlapping trial ranges leave a comparison cell unresolved. Keeping every sample allows proper intervals later without another run.
- **Record exact conditions.** Include versions, clocks, instance types, dataset shape, measured cache-hit rates, and worker counts. Small records mostly measure HTTP and JSON overhead, which can obscure datastore differences.
- **Disclose advantages.** State when an architecture lets one implementation skip work another must do. Report each implementation's advantages as well as its losses.
- **Never use tmpfs.** Its effect on file I/O invalidates storage comparisons.

Share the harness for clock pinning, cycle-normalized efficiency, per-target CPU accounting, cache-hit measurement, and correctness guards across comparisons.

### Implementations

Keep implementations in standalone directories in this repo, named for their service, framework, or platform. Multiple copies for active major versions are allowed. Each directory may implement only a distinct part of the specification.

A comparison combines these into a stack in its own directory. Reference implementation paths instead of copying them within this repo. The comparison directory is a temporary workspace that will later be copied into a snapshot repository.

Top-level `implementations` and `comparisons` folders are suggested, not required; the layout can evolve.

The Harper implementation lives in [`ecommerce-store`](https://github.com/HarperFast/ecommerce-store). It demonstrates efficient Harper application development, carries the conformance suite defining the specification, and is tested and independently benchmarked against every significant Harper release. Reference it from comparisons rather than copying it here.

## Other benchmarks

Component benchmarks also belong here. They compare a piece of Harper Core with its direct equivalent, such as a vector index or storage engine. Run them continuously to guide optimization and establish where Harper stands.

All measurement rules apply, especially correctness guards. Match semantics for the domain: approximate indexes must be compared at matched recall, since searching less of the graph can make any such index faster. Throughput without achieved recall is not a valid comparison.

Component results may be published independently, but cannot replace an architecture comparison or support an architecture claim.

Harper Core's own [performance benchmarks](https://github.com/HarperFast/harper/tree/main/benchmarks) stay in `harperfast/harper`. Harper versus an earlier Harper belongs there; Harper versus another technology belongs here.

## Reporting results

Publish results as measured. **Never omit a result after the fact.**

- **Measured loss**: publish it. Use it to guide Harper engineering work, then re-run the comparison when improvements land. Finding a needed improvement is useful benchmark work.
- **Capability gap**: record missing functionality in a capability matrix, with no performance number in either direction. An absent feature cannot be timed.
- **Non-equivalent semantics**: mark the cell invalid. Match the guarantees or exclude the cell with an explanation. Equal latency with weaker guarantees is not a tie.

Publish each comparison as a dated snapshot with the tested versions and source. Accept minor corrections; major changes generally require a new analysis and publication.

- **Reproduce**: document every run's conditions and steps. Automate deployment where possible and document every required manual setup step.
- **Submit**: open a pull request adding an implementation in its own directory. Outside implementations that pass conformance and follow the measurement rules receive the same publication terms as any other.
- **Challenge**: open an issue here or in the relevant snapshot repo describing the suspected flaw and how to demonstrate it. Fix confirmed methodology or implementation flaws and re-run affected results.

We welcome improvements to assembled stacks. Finding a configuration mistake before publication is better than retracting a result later.

## Procedure

### 0. Rough benchmark first

Build and measure a rough version before writing a plan. Agent time costs less than human-verified planning; expect about a day and no direct spend.

Give the agent a general description of the comparison, let it choose an approach, and correct it as it works. Avoid prescribing the setup before exploring it.

Do not publish rough results. Write findings: the outcome, effect size, measurement traps, and how to frame the full benchmark. This pass often finds problems planning missed.

Work in this repo on a new worktree and branch, in a new directory. Reuse, modify, or update existing implementations, or create ones that loosely match the specification. Strict verification is unnecessary at this stage. Write the findings, commit, and present them to the user.

Containerize every target locally from the first run. This reduces variance and lets the harness move unchanged to the Linux host.

### 1. Define the comparison

Use the rough findings to specify the exact stack. Rename the directory or create one, and start `plan.md` with the systems to combine. If a similar stack exists, distinguish the name with versions, quarters, or dates.

### 2. Plan it

Complete `plan.md` with implementation steps, component names and versions, deployment steps, expected metrics, project structure, and key tooling. Quote the reference application's specification and incorporate the rough findings. Decide which implementations to reuse, update, or create.

Keep the plan short. Most work is agent-driven and can be corrected during implementation; avoid unnecessary detail.

### 3. Review the plan

Review manually for current versions, a sound approach, and unnecessary complexity. Then cross-review with several models using different personas and revise. Finally, get at least one other person's review based on their own reading of the plan or reviews, rather than forwarded agent output.

### 4. Implement

Use mostly autonomous agents, require tests, and build the MVP first. Supply the agreed plan, reference application, and verification suite up front.

Follow the [environment tiers](#environment-tiers): local containers, the GCP Linux host, then a platform as a service if included. Document actual provisioning and deployment steps as you go.

### 5. Review the implementation

Check the implementation against the plan for bugs and inefficiencies. Use agent personas where helpful. This stage checks correctness; do not benchmark yet. Passing conformance is necessary, but the implementation must also use its stack well.

Make two passes. First, look for the strongest version of the stack and ways to improve its performance. Then explicitly request an adversarial review, with the agent acting as a maintainer or engineer of the competing technology and looking for mistakes. Agents tend to agree by default; the adversarial pass supplements the favorable review and catches different problems.

### 6. Benchmark and analyze

Follow the measurement rules and tier order. Use local containers to debug the harness and implementations. Report numbers from the Linux host and, if included, the later platform tier.

Run all targets the same way in the same fresh session, including reference implementations with independent benchmarks. Their existing benchmarks are a starting point, not a substitute for that run. Keep the comparison focused.

### 7. Review the benchmarks

Cross-review with several models, including adversarial reviewers. Review manually too, and re-run where needed: a bad benchmark is worse than none.

### 8. Publish

Freeze a dated snapshot with pinned versions and full reproduction documentation. Link it from the [results index](#results-index). For a significant re-run, fork and start again rather than editing the published snapshot.

## Results index

Each comparison lives in its own snapshot repository, linked below.

### Predating this methodology

| Comparison | Composition | Kind | Date | Source |
|-|-|-|-|-|
| Next.js v16 full stack app | Vercel | Platform as a service | June 2026 | https://github.com/HarperFast/harper-vs-vercel-benchmark |
| Event pipeline | Kafka + Redis + Postgres + Debezium + Kafka Streams | Stack | May 2026 | https://github.com/HarperFast/kafka-v-harper-perf-test |
| Microservices | MongoDB | Stack | December 2025 | https://github.com/HarperFast/harper-vs-microservices-perf-test |

These are listed for completeness; they predate this methodology and are not comparable to results produced under it.

### New comparisons following this methodology

No comparisons published yet.

## Discoverability

Before considering a comparison finished, make it discoverable to readers and models:

- Link each published comparison from `llms.txt`, `llms-full.txt`, and the docs.
- `docs.harperdb.io` is canonical for both files. Webflow prevents `harper.fast` from hosting `llms-full.txt`; use `https://docs.harperdb.io/llms-full.txt` for the full file and `harper.fast/llms.txt` as the entry point.
