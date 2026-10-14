# Tier 2: a Linux host on GCP

How to run a [stack comparison](../../README.md#stack-comparisons) on a dedicated Linux VM on Google Cloud: the same containers, budgets, and harness as [tier 1](../../README.md#environment-tiers), on a host where cgroup limits, per-target CPU accounting, and the clock can be trusted enough to publish.

> **Status, 2026-10-14: C4 qualified; no target has run.** One session on `c4-standard-16-lssd` ran every script here and fixed what broke ([Qualification](#qualification-2026-10-14)). The slices hold, cycles count per cgroup under GCP's virtual PMU, and the clock held at 3.898 GHz within 0.3%. No benchmark target has run on tier 2 yet, and the C4A probe, the Cloud NAT path, and bare metal are untested. [Decisions](#decisions) records the choices made before that session, and [known gaps](#known-gaps) lists what the harness still has to gain.

| File | Runs on | Purpose |
|-|-|-|
| [`vm.sh`](vm.sh) | operator machine | Preflight, create, describe, reach, and delete the VM |
| [`host-setup.sh`](host-setup.sh) | VM, as root, once (safe to repeat) | Local SSD, Docker, perf, Node, and the CPU and memory partition |
| [`probe-clock.sh`](probe-clock.sh) | VM, as root | Proves cycles are countable and measures how steady the clock is |
| [`sample.sh`](sample.sh) | VM, as root, whole session | Cycles per target every 250 ms; CPU, memory, steal, and maintenance events every second |
| [`conditions.sh`](conditions.sh) | VM, as root | Raw snapshot of host run conditions |
| [`ecommerce-store-gaps.md`](ecommerce-store-gaps.md) | | What the Harper reference harness needs before its first tier-2 run |
| [`qualification/`](qualification) | | Raw probe output and instance settings from each qualification session |

## The clock on GCP

The measurement rules ask for a pinned clock. **On a GCP VM the clock cannot be pinned.** Compute Engine gives customers no control over P-states. The guest does load `intel_pstate`, in passive mode with a single P-state at the nominal 2.3 GHz that C4 on Granite Rapids reports "for compatibility" (its documented base is 2.8 GHz and its all-core turbo 3.9 GHz). On 2026-10-14, setting `no_turbo`, `max_perf_pct=50`, or the powersave governor each left a busy core at 3.898 GHz. The CPU model string says 2.3 GHz and `/proc/cpuinfo` shows a counter-derived snapshot (3.86–3.88 GHz observed); neither is a clock record. Left at its default, an instance runs at "unrestricted frequency": cores boost above all-core turbo when the socket has headroom, and the socket's headroom depends on other tenants.

Two documented C4 features get close enough to produce the efficiency figure honestly:

- **Bounded.** `--turbo-mode=ALL_CORE_MAX` (C4 and C4N only) disables single-core boost and limits vCPUs to the sustainable all-core turbo frequency, which Google offers "for more consistent CPU performance". It is a ceiling the provider enforces, not a guarantee of a floor.
- **Measured.** `--performance-monitoring-unit=architectural` (C4, C4A, M4, A4X; no charge) exposes unhalted core cycles, reference cycles, and instructions retired to the guest. `perf stat` in cgroup mode then counts the cycles each target actually consumed, so gigacycles are counted rather than inferred from CPU-seconds multiplied by an assumed frequency.

Both hold on `c4-standard-16-lssd`. In two probe runs on 2026-10-14, the target CPUs ran at a median 3.895–3.898 GHz, with only the target busy and with every CPU busy, and varied 0.1–0.3% across 110 one-second samples per phase. Cycles counted per cgroup gave the same frequency as cycles counted per CPU, and no counter was multiplexed.

On tier 2, **ops per CPU-gigacycle = successful requests in a step ÷ (cycles counted in the target's cgroup during that step ÷ 10⁹)**. Effective frequency, cycles divided by the target's CPU time, is recorded for every step of every target. A trial whose effective frequency leaves the session median by more than the drift threshold (2%, or three times the spread the session's clock probe measured, whichever is larger) is re-run, which is the rule's "re-run any rep whose clock drifts" with a measured clock instead of a pinned one. A published figure says "all-core turbo, measured at N GHz", never "pinned". This is the [clock rule](../../README.md#measurement-rules) as it applies where the clock cannot be pinned.

What a shared host leaves uncontrolled: other tenants share the socket's L3 cache, memory bandwidth, and power budget. Whole cores (SMT off) remove sibling-thread sharing, and ALL_CORE_MAX removes most of the frequency coupling to neighbours. Nothing on a shared VM removes cache and memory-bandwidth contention, and it cannot be observed either, because last-level cache events need the enhanced PMU, which only 144- and 288-vCPU C4 shapes offer. The mitigation is procedural: every target in one session, trials interleaved so slow drift lands on all of them, and trial ranges reported.

| Option | Clock | Neighbours | On-demand, us-central1 | Use |
|-|-|-|-|-|
| **C4 VM**, ALL_CORE_MAX, PMU, SMT off | Bounded and measured: 3.898 GHz, 0.3% spread (2026-10-14) | Share L3 and memory bandwidth | $0.97/h for `c4-standard-16-lssd` | Every session (recommended) |
| C4A VM (Axion, arm64), PMU | Measured. Google says Arm processors run at all-core turbo, but documents no frequency for Axion | Same | $0.97/h for `c4a-standard-16-lssd` (16 cores, 4 × 375 GiB SSD) | One probe session for comparison; not the default |
| Sole-tenant node, `c4-node-192-384` | As C4 VM (not verified on sole tenancy) | None | ~$9/h for the whole node | One verification session at most; never the default |
| Bare metal, `c4-standard-288-lssd-metal` | Possibly pinnable: whether the OS gets P-state control on GCP bare metal is undocumented | None | ~$18/h plus SSD | One verification session at most; never the default. The only option that might allow pinning, to be checked on first boot |
| N2, C3, C2, and other series without a guest PMU | Neither bounded nor observable | Shared | | Not usable for an efficiency figure; `vm.sh` refuses them |

## Instance

### Recommended

`c4-standard-16-lssd` in us-central1, created by [`vm.sh up`](vm.sh) with:

- `--threads-per-core=1`: SMT off, so each visible CPU is a whole core and the 2-CPU budget means two cores, as it does on tier 1's Apple silicon. The VM shows 8 CPUs; billing stays at 16 vCPUs.
- `--turbo-mode=ALL_CORE_MAX` and `--performance-monitoring-unit=architectural`, for the clock as above.
- The `-lssd` shape, for two reasons. Every C4 `-lssd` shape runs on Granite Rapids (Xeon 6985P-C), so the CPU platform follows from the machine type rather than from placement luck; smaller non-`lssd` C4 shapes run on Emerald Rapids. And it carries Titanium SSD (local NVMe, 2 × 375 GiB), which keeps network-attached disk quotas from becoming the bottleneck for a dataset that does not fit in the target's memory.
- Debian 13 (kernel 6.12, cgroup v2), matching the existing `sharded-blob-test` provisioning. Hyperdisk Balanced boot disk: C4 does not support Persistent Disk, so `--boot-disk-type=pd-ssd` as used there fails on C4.
- `--maintenance-policy=MIGRATE`. C4 gives seven days' notice of host maintenance; `vm.sh status` shows it, and a session does not start with maintenance pending. A live migration during a trial voids that trial; `sample.sh` logs it.
- `--max-run-duration=8h --instance-termination-action=DELETE`: the VM deletes itself even if nobody runs `vm.sh down`.
- `--no-service-account --no-scopes`, a dedicated network, and SSH only through IAP.
- Egress through an ephemeral external IPv4 address; the only inbound path is SSH through IAP. If the organization policy `constraints/compute.vmExternalIpAccess` blocks external addresses, which `vm.sh preflight` reports, `vm.sh up` creates the VM with `--no-address` and puts Cloud NAT (`arch-bench-router`, `arch-bench-nat`) on `arch-bench-net`, and `vm.sh down` removes it again. `NETWORK_MODE=external` or `nat` overrides the detection. The measured path is the same either way: target and generator talk over the compose bridge, not through the VM's network interface.

The region is a cost and availability choice with no effect on the measurement, since nothing crosses a WAN. The zone is whichever has capacity: on 2026-10-14, `us-central1-a` and `-b` had no `c4-standard-16-lssd` capacity and `-c` did. `vm.sh up` tries `ZONE` (default `us-central1-a`) and then the region's other zones, and every other subcommand looks up the VM's zone itself.

### CPU layout

Eight whole cores, partitioned by systemd slices that [`host-setup.sh`](host-setup.sh) creates:

| CPUs | cgroup | Runs |
|-|-|-|
| 0–1 | `system.slice`, `user.slice`, `init.scope` | OS, Docker daemon, sshd, guest agent, the sampler, movable IRQs, unbound kernel work |
| 2–3 | `bench.slice/bench-target.slice` | Every process of the target under test, with `MemoryMax=2G` and no swap |
| 4–7 | `bench.slice/bench-generator.slice` | The load generator, outside the budget, with headroom |

A container joins a slice through compose `cgroup_parent`. Any container that does not lands in `system.slice` and is confined to the housekeeping CPUs, so a misplaced container shows up as a broken run rather than as stolen budget. `c4-standard-16-lssd` is a single NUMA node, which `conditions.sh` records with `numactl -H`. If another shape has two, keep each slice's CPUs and memory on one node.

### Why not a separate VM for the generator

The rules allow the generator on the same machine provided it sits outside the target's budget, and same-machine is the default here. It keeps the network path identical to tier 1 (a compose bridge), costs one VM instead of two, and avoids GCP network jitter entering every latency sample. Its cost is that the generator shares the socket's cache and memory bandwidth with the target; that is the same for every target in a session, and the generator's load is small at the request rates measured so far. A separate VM in a compact placement policy is the right check if a reviewer suspects interference, not the default.

## Project and spend

One dedicated project holds every tier-2 session, so spend is attributable and nothing else lives beside the VMs. Any staff member can create a project and link it to the company billing account, which carries credits. Commands for the person setting it up, once (run 2026-10-14; `gcloud auth login` first):

```bash
PROJECT=harper-arch-bench
gcloud projects create "$PROJECT" --organization="$ORG_ID"   # directly under the organization: see Decisions
gcloud billing projects link "$PROJECT" --billing-account="$BILLING_ACCOUNT"
gcloud services enable compute.googleapis.com iap.googleapis.com billingbudgets.googleapis.com cloudquotas.googleapis.com --project="$PROJECT"
gcloud config configurations create arch-bench --no-activate
gcloud config set account "$(gcloud config get-value account)" --configuration=arch-bench   # vm.sh runs in this configuration
gcloud config set project "$PROJECT" --configuration=arch-bench
gcloud config set compute/zone us-central1-a --configuration=arch-bench
gcloud billing budgets create --billing-project="$PROJECT" --billing-account="$BILLING_ACCOUNT" --display-name="arch-bench" \
  --filter-projects="projects/$PROJECT" --budget-amount=100USD --credit-types-treatment=exclude-all-credits \
  --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0 \
  --threshold-rule=percent=1.0,basis=forecasted-spend
```

`--billing-project` is required: the Budgets API needs a quota project, and without one the command fails with a misleading permission error. Credits are excluded so the alerts track usage, not the remainder after credits, which on a credit-funded account can stay at zero. Alerts go to the billing account's administrators and users by default. A project owner can create a budget for that project without billing-account permissions; if `gcloud billing budgets create` refuses, the console's Billing page can. Budgets alert, they do not cap. Billing-account-wide cost-anomaly and daily-spend alerts are managed centrally on top of this.

Spend hygiene:

- `vm.sh` uses the `arch-bench` gcloud configuration, never the shell's default, so it cannot act on another project.
- Every VM carries labels `arch-bench`, `comparison`, `session`, and `owner`, which reach the billing export.
- One VM per session, deleted at the end of the session. `vm.sh down` deletes it, deletes Cloud NAT if the session used it, and then fails loudly if any instance, disk, reserved address, or router remains. The network and IAP firewall rule cost nothing and stay.
- The self-delete deadline caps a forgotten VM at eight hours. Pull results before it fires: local SSD and the boot disk are deleted with the VM.
- No Spot VMs for measured sessions: a preemption mid-session breaks the one-session rule.
- `vm.sh preflight` shows the machine family's CPU and local SSD quota, which only the Cloud Quotas API reports. The new project started with 300 C4 vCPUs and 25,000 GB of C4 local SSD in us-central1.

Estimated cost per session. Google's Cloud Billing Catalog, read 2026-10-14, prices `c4-standard-16-lssd` in us-central1 at $0.955/h on demand: 16 C4 cores at $0.03465/h (billed with SMT off too), 60 GiB at $0.003938/GiB-h, and 2 × 375 GiB of Titanium SSD at $0.16/GiB-month. With the boot disk and external address it is $0.97/h; plan on $1/h:

| Session | Duration | Cost |
|-|-|-|
| Clock qualification only (2026-10-14: 24 min including re-runs) | ~30 min | < $1 ($0.39 measured) |
| One target, three trials (shakedown) | ~1.5 h | ~$1.50 |
| Two targets, five interleaved trials each | ~3–4 h | ~$4 |
| Forgotten VM, capped by the deadline | 8 h | ~$8 |
| Bare-metal verification session | ~4 h | ~$80 |

Disk, the external IPv4 address, and egress are each well under a cent an hour; results are tens of megabytes and the dataset pull is ingress. In the Cloud NAT fallback, NAT adds its gateway charge and per-gigabyte data processing on the few gigabytes of packages, images, and dataset a session pulls: cents per session.

## Auth for a CLI-driven agent

An agent drives GCP through `gcloud`, not the console, and the organization's sessions are short, so credentials expire mid-work. The procedure is built so that expiry costs a re-run, never a run:

- Only a human logs in: `gcloud auth login` opens a browser. In Claude Code that is the user typing `! gcloud auth login`. An agent never stores credentials, never creates service-account keys, and never automates the browser flow.
- Every `vm.sh` subcommand checks credentials first and stops with the fix if they are stale. Every step is idempotent, so the answer to an expired session is to log in and repeat the command.
- Long work runs on the VM inside `tmux`, never inside an ssh session held open from the operator machine. The agent checks on it with short ssh calls. An expired session therefore stops the agent from looking, not the trial from running.
- Teardown does not depend on anyone's session either: the self-delete deadline fires regardless.
- No Application Default Credentials and no service account on the VM: the VM never calls a Google API, and the repositories it clones are public.

The benchmark maintainer who creates the project owns it and is its only member to start; others are added on request. Who holds access is recorded in internal documentation, not here. An operator needs Compute Admin and IAP-secured Tunnel User on the project (`roles/compute.admin`, `roles/iap.tunnelResourceAccessor`); the owner has both.

## Host

[`host-setup.sh`](host-setup.sh) does the following, once per VM.

- **Disk.** Titanium SSD as ext4 (RAID 0 when there are two devices), mounted at `/mnt/lssd` with `noatime`, holding Docker's data root. A real filesystem on NVMe, never tmpfs. Every target in a session uses the same filesystem.
- **Container runtime.** Docker Engine and the Compose plugin from Docker's signed apt repository, with the systemd cgroup driver on cgroup v2. Podman would also work, since compose `cgroup_parent` and the slices are runtime-neutral, but `run-benchmark.sh` prefers `docker` when both exist and Docker is the shorter path on Linux. Versions are recorded.
- **The budget.** `bench-target.slice` gets CPUs 2–3 and `MemoryMax=2G` with no swap, and every container of the target joins it. That is what "the same CPU and RAM, summed across all of its processes" means mechanically: the kernel enforces one cpuset and one memory limit over the whole stack, and the stack decides how to divide them, as it would on a real two-core, two-gigabyte machine. Per-container CPU quotas inside the slice are discouraged: they impose a split the architecture did not choose and add CFS throttling, which `sample.sh` records as `throttled_usec` if a target uses them anyway. Memory limits inside the slice are the target's own tuning, and each implementation still has to configure its processes (Postgres `shared_buffers`, Redis `maxmemory`, Node heap) to fit, as its vendor recommends.
- **A container cannot see the budget.** Its cgroup namespace starts at its own scope, below the slice that holds the limits. Measured in a `node:24-slim` container in the target slice: `nproc` and `os.availableParallelism()` report 2, but `os.cpus()` lists all 8 CPUs and `process.constrainedMemory()` reports no limit. Anything that sizes itself from memory or CPU count has to be configured explicitly, for every target alike, and the configuration recorded.
- **Page cache is budget.** On cgroup v2, file pages count against the cgroup that first read them, so a target's cache competes inside its 2 GiB. Pages read by anything outside the slice do not, which is why the page cache is dropped before every cold start (see [trials](#5-trials)).
- **The generator.** `bench-generator.slice` gets CPUs 4–7 and 4 GiB. The generator's own CPU is recorded per step, and a step where it saturates is discarded. `bench/run.mjs` is single-threaded, so the headroom that matters is one core's worth, not four.
- **Kernel noise off the measured CPUs.** OS services, the Docker daemon, unbound kernel workqueues (writeback), and every movable IRQ are confined to CPUs 0–1; `irqbalance` and periodic apt, man-db, sysstat, and trim timers are disabled. NVMe queue IRQs are kernel-managed, one queue per CPU, so a target's disk completions land on its own CPUs; the script lists them rather than hiding them. The NMI watchdog is off (`kernel.nmi_watchdog=0`), because it would hold a PMU counter on every CPU that cycle counting needs; the Debian 13 cloud kernel already boots with it off.
- **Networking.** Every target and the generator on one user-defined compose bridge, plain HTTP, as on tier 1. Containers of a multi-container stack talk over the same bridge, which is the cost a separated stack really pays, at less than a real network would charge. Bridge, MTU, and the iptables backend are recorded.
- **Tools.** `perf` (Debian's `linux-perf`), `stress-ng`, `sysstat`, `numactl`, git and Git LFS, and Node 24 from nodejs.org, checksum-verified, for scripts that run on the host. Swap and transparent huge pages keep distro defaults and are recorded; if a target's documentation calls for host settings, they apply to every target in the session and are recorded.

What CPU accounting covers: perf counts cycles of target tasks in user and kernel mode on target CPUs. Kernel work done on a target's behalf elsewhere (asynchronous writeback, softirq processing on the sender's CPU) is charged to no target. It is the same mechanism for every target, and `sample.sh` records host-wide CPU so the unattributed share is visible rather than assumed small.

## What a target must provide

Tier 2 is target-neutral. Any implementation, the Harper reference or an assembled stack such as Fastify + Postgres + Redis, runs here if it provides:

1. **Placement.** Every service of the target sets `cgroup_parent: bench-target.slice`; the generator sets `cgroup_parent: bench-generator.slice`. Delivered as a compose override layered on the target's compose file, so tier 1 stays unchanged and the checkout stays clean.
2. **A seed and a snapshot.** Load the pinned dataset (not measured), archive the loaded state, and restore it before every trial, for every stateful service of the target.
3. **A clean stop.** Every container of the target stopped at the end of a trial. Targets share `bench-target.slice`, so an idle target left resident would hold memory inside the next target's budget.
4. **A cold-start probe from outside the target**, so the probe neither spends the target's budget nor adds its own spawn time.
5. **A run record with absolute step times**, so per-step cycles and CPU can be joined from `sample.sh` output.
6. **The same harness as everyone else**: the same generator, ladder, warm-up, write stream, and correctness guards.

## Session procedure

Every comparison follows this order. `$S` is the session directory on the VM, and `$RUNS` is where the comparison keeps raw results on the operator machine.

### 1. Provision

```bash
export PROJECT=harper-arch-bench COMPARISON=<name> SESSION=$(date -u +%Y%m%dt%H%M) RUNS=<local raw-results dir>
environments/gcp/vm.sh preflight
environments/gcp/vm.sh up --dry-run          # read every flag
environments/gcp/vm.sh up
environments/gcp/vm.sh status                # no upcoming maintenance, or wait
for f in host-setup.sh probe-clock.sh sample.sh conditions.sh; do environments/gcp/vm.sh push "environments/gcp/$f"; done   # the first push creates an ssh key; IAP may retry once while sshd starts
environments/gcp/vm.sh ssh -- sudo bash host-setup.sh
mkdir -p "$RUNS/$SESSION" && environments/gcp/vm.sh describe > "$RUNS/$SESSION/instance.json"
```

From here on, work happens on the VM: `vm.sh ssh` (a fresh login, so the docker group applies), then `tmux new -s bench`, then `export SESSION=<the same value>`.

### 2. Qualify the clock

```bash
S=/mnt/lssd/out/$SESSION; mkdir -p $S   # host-setup.sh gives /mnt/lssd/out and /mnt/lssd/src to the login user
sudo bash ~/probe-clock.sh $S/probe
```

About three minutes, every session. It fails the session if cycles cannot be counted, globally or per cgroup, or if a worker's allowed CPUs differ from its slice. It reports effective frequency on the target CPUs with only the target busy and with every CPU busy. The first session on a machine type is the real qualification: the spread across intervals and the agreement between the two medians are what justify "bounded and measured" for every result produced on that type. The probe prints the session's drift threshold (2%, or three times the larger spread it measured) and fails if the two medians differ by more than that.

### 3. Code and data

Repositories are public and checked out at pinned commits, so the VM holds no credentials. `git archive` would not carry Git LFS content.

```bash
git clone https://github.com/HarperFast/ecommerce-store /mnt/lssd/src/ecommerce-store
cd /mnt/lssd/src/ecommerce-store && git checkout <commit> && git lfs install --local && git lfs pull
node scripts/prepare-dataset.mjs --scale bench   # expands ~4.3 GB and verifies every table's SHA-256 against MANIFEST.json
git clone https://github.com/HarperFast/application-architecture-benchmarks /mnt/lssd/src/application-architecture-benchmarks
git -C /mnt/lssd/src/application-architecture-benchmarks checkout <commit>
```

One expanded, verified copy of the dataset serves every target in the session. The LFS pull is about 320 MB and counts against the organization's LFS bandwidth.

Snapshots are made on the tier-2 host, per session. A tier-1 snapshot is never reused here: tier 1 runs arm64 containers on macOS, and the C4 host is x86-64. Snapshots are not reused across sessions either: every session re-seeds every target, which costs about 20 minutes and $0.35 per target and removes any question of where a snapshot came from.

### 4. Seed, snapshot, start recording

For each target: build, seed, snapshot, stop. Not measured. Then record the session's conditions and start the sampler, which runs until the last trial ends.

For the Harper reference implementation, once [gap 1](ecommerce-store-gaps.md#1-no-way-to-place-the-target-in-the-target-slice) is closed (`COMPOSE_EXTRA` is the suggested name, not an existing option):

```bash
cd /mnt/lssd/src/ecommerce-store
cp containers/.env.example containers/.env   # set HDB_ADMIN_PASSWORD to a new random value: a test credential that never leaves this VM
SCALE=bench TRIALS=0 COMPOSE_EXTRA=compose.tier2.yaml ./containers/run-benchmark.sh   # build, seed, snapshot; TRIALS=0 measures nothing
docker compose -p harper-ecommerce-bench stop
```

Then, once for the session:

```bash
sudo bash ~/conditions.sh $S/conditions /mnt/lssd/src/*
sudo systemd-run --collect --unit=arch-bench-sampler bash ~/sample.sh $S/samples   # --collect: a stopped unit unloads, so the name can be reused
```

### 5. Trials

Targets are interleaved and the order alternates (A B, B A, A B, …), so drift over the session lands on every target. Each trial, for each target:

1. Stop every container of the other targets.
2. Restore the target's snapshot.
3. Drop the page cache: `sync; echo 3 | sudo tee /proc/sys/vm/drop_caches`. "Cold" then means cold for every target, and no target reads pages charged outside its budget.
4. Cold start, warm-up, ladder, through the target's orchestrator.
5. `sudo bash ~/conditions.sh $S/trial-<n>-<target>` for container state and image digests.
6. Validate the run record (for ecommerce-store, `scripts/verify-run-record.mjs`), and check `samples/maintenance.log` and, once the [join](#known-gaps) exists, each step's effective frequency. A trial that fails any of them is re-run in the same session, and the failure is kept.

For the Harper reference implementation, steps 2 to 4 are one call, `SCALE=bench SKIP_LOAD=1 TRIALS=1 COMPOSE_EXTRA=compose.tier2.yaml ./containers/run-benchmark.sh`, and step 3 has to happen inside it, between the stop and the start of the measured restart ([gap 3](ecommerce-store-gaps.md#3-cold-start-runs-on-a-warm-page-cache-and-inside-the-targets-budget)). Follow it with `docker compose -p harper-ecommerce-bench stop`.

### 6. Collect and tear down

```bash
sudo systemctl stop arch-bench-sampler
# copy every target's results volume into the session directory, e.g. for ecommerce-store:
docker run --rm -v harper-ecommerce-bench_bench-results:/r:ro -v $S:/out node:24-slim cp -r /r /out/bench-results
tar -C /mnt/lssd/out -cf - $SESSION | zstd > ~/$SESSION.tar.zst
```

Then from the operator machine:

```bash
environments/gcp/vm.sh pull "$SESSION.tar.zst" "$RUNS/$SESSION"
environments/gcp/vm.sh down
```

Every raw sample is kept with the comparison. Nothing on the VM survives `down`.

## Run conditions record

`vm.sh describe`, `probe-clock.sh`, `conditions.sh`, and `sample.sh` capture these. A published result carries all of them.

- **Provider and instance:** GCP, region and zone, machine type, CPU platform and model, turbo mode, threads per core, PMU type, maintenance policy, image and kernel, maintenance events during the session, steal time.
- **Clock:** the session's probe summary; effective frequency and counted gigacycles per step per target; the drift threshold and every trial re-run because of it.
- **Placement:** CPUs of each slice, memory limit, swap, any per-container limits inside the target slice, throttling counters, IRQ and workqueue placement, transparent huge pages, sysctls.
- **Containers and network:** Docker and Compose versions, cgroup driver, networking mode, MTU, image digest of every container including the generator.
- **Storage:** Titanium SSD device count and RAID level, filesystem and mount options, Docker data root, boot disk type.
- **Software:** commit and dirty flag of every repository, platform and engine versions, worker and connection counts, harness settings (ladder, step duration, warm-up, write rate, quote share, in-flight ceiling).
- **Dataset:** manifest SHA-256, scale and seed, LFS object ids, snapshot provenance.
- **Lifecycle:** trial order, page-cache drop times, cold-start time, warm-up result.
- **Generator:** CPU load and dispatch lag per step, shed arrivals, generator slice CPU.
- **Measured behaviour:** cache-hit rates, write failures, invalidations.

## Qualification, 2026-10-14

The first session ran every script on `c4-standard-16-lssd` in `us-central1-c`, with Debian 13, kernel 6.12.111 (cloud), Docker 29.9.1, and perf 6.12.111. It took 24 minutes of VM time, about $0.39. No benchmark target ran; a synthetic load stood in for one. Raw probe output, the instance's GCP-side settings, and the synthetic load are in [`qualification/2026-10-14-c4-standard-16-lssd`](qualification/2026-10-14-c4-standard-16-lssd).

| Check | Result |
|-|-|
| Instance | Intel Xeon 6985P-C (Granite Rapids), `ALL_CORE_MAX`, architectural PMU, one thread per core, 2 × 375 GiB Titanium SSD as RAID 0, one NUMA node |
| `host-setup.sh` | About 5 minutes; a second run on the same VM also exits 0 |
| Slices | `system.slice`, `user.slice`, and `init.scope` on CPUs 0–1, including dockerd, containerd, sshd, and the guest agent. A container with `--cgroup-parent=bench-target.slice` runs on 2–3 and sees `nproc` 2; one without it lands in `system.slice` on 0–1 |
| Memory budget | Allocating past 2 GiB in the target slice is OOM-killed (exit 137); the slice's `memory.peak` is exactly 2 GiB |
| Clock, two probe runs | Median 3.898 and 3.898 GHz with only the target busy, 3.898 and 3.895 GHz with every CPU busy; spread 0.1–0.3%; drift threshold 2% |
| Cycles per cgroup | 61.7 billion cycles over 15.8 s of task-clock in an 8 s window: 3.897 GHz at 1.98 CPUs, matching the per-CPU count; no multiplexing |
| Guest P-state controls | `no_turbo=1`, `max_perf_pct=50`, and the powersave governor each left a busy core at 3.898 GHz |
| `sample.sh` | Three containers at 0.5 and 1.0 CPU in the target slice and 0.25 in the generator slice, for 52 s. Target slice: 78.16 s of perf task-clock against 78.41 s of cgroup `cpu.stat`, at 3.892 GHz. Per container: 0.50, 1.00, and 0.25 CPUs. `maintenance.log` recorded `NONE` |
| `conditions.sh` | Complete; git reads the login user's checkout as root |
| Teardown | `vm.sh down` left no instance, disk, address, or router |

What the session corrected, besides the bugs found by reading the scripts first:

- **Capacity.** Two of four zones had no `c4-standard-16-lssd`; `vm.sh up` now tries the region's other zones.
- **Quota and budget.** Per-family quota is only in the Cloud Quotas API. The budget command needs `--billing-project`, and counts usage net of credits unless told otherwise.
- **The sampler.** `systemctl stop` marked it failed: the trap's `kill` of an already-stopped perf ended it with status 1 under `set -e`. A failed transient unit then blocked restarting it under the same name, so it now runs with `--collect`. No data was lost: perf's last row was within one 250 ms interval of the stop.
- **IRQ report.** It read where each IRQ last fired rather than where it is allowed to, so IRQs that never fire looked unmoved.
- **The clock text.** The guest has a cpufreq driver and `/proc/cpuinfo` reports a live estimate; neither can move or record the clock.

## Known gaps

- **Untested:** the C4A probe session ([decision 6](#decisions)), the Cloud NAT path, bare metal, a live migration during a session, and any real target.
- **No join yet.** Nothing turns `sample.sh` output and a run record into per-step gigacycles, effective frequency, and per-component CPU. It needs absolute step times in the run record first, then a small script, which belongs with the shared harness. The qualification's one-off join of a synthetic load shows the data supports it.
- **No comparison-level orchestrator.** Interleaving targets, restoring, dropping caches, and stopping the other target is a loop that belongs in the comparison's directory once a second target exists. Until then it is the steps under [trials](#5-trials).
- **The Harper reference harness** needs placement, accounting, and lifecycle changes before its first tier-2 run. Placement is blocking: without it, the target lands in `system.slice` on the housekeeping CPUs. See [`ecommerce-store-gaps.md`](ecommerce-store-gaps.md).

## Decisions

Made 2026-10-12, before the first session.

1. **Project:** `harper-arch-bench`, created 2026-10-14 directly under the Harper organization, with no folder: staff cannot list folders, and the organization's other projects sit at its root. An organization admin can move it into a folder later without affecting it.
2. **Budget:** $100 a month, with alerts at 50%, 90%, and 100% of actual spend and at 100% of forecast.
3. **Clock rule:** "all-core turbo, measured" satisfies it where the clock cannot be pinned. The top-level README's tier-2 paragraph and first [measurement rule](../../README.md#measurement-rules) say so: pin where the host allows it; otherwise bound it, count cycles per target, record the effective frequency, and publish "all-core turbo, measured at N GHz", never "pinned".
4. **Bare metal and sole tenancy:** one verification session at most, to find out whether bare metal gives the OS frequency control and how far its results differ from the VM's. Never the default.
5. **Drift threshold:** 2% from the session median, or three times the session probe's measured spread, whichever is larger.
6. **Architecture:** C4 (x86-64) is the default. One probe session on C4A (`MACHINE=c4a-standard-16-lssd vm.sh up`, then `host-setup.sh` and `probe-clock.sh`; the default layout uses 8 of its 16 cores) compares its clock behaviour. C4A does not become the default without a further decision.
7. **Snapshots:** no reuse across sessions; every session re-seeds every target.
8. **Access and egress:** the benchmark maintainer who creates the project owns it and is its only member to start; others are added on request. VMs get an external IPv4 address by default. Where `constraints/compute.vmExternalIpAccess` blocks that, the fallback is `--no-address` plus Cloud NAT on `arch-bench-net`, which `vm.sh` supports but has not run: the organization allowed external addresses on 2026-10-14.

## Sources

Google Cloud documentation, read 2026-10-12: [CPU platforms](https://docs.cloud.google.com/compute/docs/cpu-platforms) (frequencies, ALL_CORE_MAX, no P-state control), [general-purpose machine families](https://docs.cloud.google.com/compute/docs/general-purpose-machines) (C4 shapes, Granite Rapids on `-lssd`, Hyperdisk only, live migration), [PMU overview](https://docs.cloud.google.com/compute/docs/pmu-overview) and [enabling the PMU](https://docs.cloud.google.com/compute/docs/enable-pmu-in-vms), [threads per core](https://docs.cloud.google.com/compute/docs/instances/set-threads-per-core), [limiting VM runtime](https://docs.cloud.google.com/compute/docs/instances/limit-vm-runtime), [sole-tenant nodes](https://docs.cloud.google.com/compute/docs/nodes/sole-tenant-nodes), [`gcloud compute instances create`](https://docs.cloud.google.com/sdk/gcloud/reference/compute/instances/create), and [`gcloud billing budgets create`](https://docs.cloud.google.com/sdk/gcloud/reference/billing/budgets/create). C4 and C4A prices from the Cloud Billing Catalog API (Compute Engine, service `6F81-5844-456A`), read 2026-10-14; bare-metal and sole-tenant prices from [sparecores](https://sparecores.com/server/gcp/c4-standard-16-lssd), [Holori](https://calculator.holori.com/gcp/vm/c4-standard-16-lssd/us-central1), and [gcloud-compute.com](https://gcloud-compute.com/c4-standard-288-lssd-metal.html), October 2026. Provisioning patterns from [`HarperFast/sharded-blob-test`](https://github.com/HarperFast/sharded-blob-test/tree/main/provisioning/gcp).
