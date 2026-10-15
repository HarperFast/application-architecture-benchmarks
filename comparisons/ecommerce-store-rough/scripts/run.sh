#!/usr/bin/env bash
# Comparison orchestrator: the Harper reference vs Fastify + Postgres + Redis, on tier 1 (a local
# Podman machine, `dev` only) or tier 2 (the GCP Linux host of environments/gcp, `dev` or `bench`).
#
#   scripts/run.sh setup                  resolve ECOMMERCE_STORE_DIR, write .env (local test credentials)
#   scripts/run.sh build <target>         build the target's image (load and session.sh do this too)
#   scripts/run.sh load <fpr|harper>      seed the dataset and snapshot the loaded state (not measured)
#   scripts/run.sh conformance <target>   restore, start, run the ecommerce-store e2e suite from the host
#   scripts/run.sh diff                   restore both, compare every quote and product response
#   scripts/run.sh bench <target>         one trial: restore, drop the page cache, cold start, warm-up +
#                                         ladder with per-container CPU, verify, join cycles (tier 2)
#   scripts/run.sh audit                  fpr only: cached vs source-of-truth responses, after a run
#   scripts/run.sh coherence <target>     the reference's verify-coherence.mjs (readers racing writers)
#   scripts/run.sh stop                   stop every container in this project
#
# Targets: `fpr` (Fastify + Postgres + Redis), `harper` (the reference, built from the
# ecommerce-store checkout, unmodified) and `harper-unbatched` (the reference built from
# HARPER_UNBATCHED_REF, default dd3a5f5^, the commit before its quote reads were batched; it
# restores harper's snapshot).
#
# Environment:
#   TIER               1 (default; Podman machine) or 2 (Linux host with bench.slice, see environments/gcp)
#   SCALE              dev (default) or bench (TIER=2 only)
#   RATES DURATION     the ladder and seconds per step; the warm-up is the harness's fixed WARMUP per scale
#   TRIALS QUOTE_SHARE WRITE_RATE BENCH_ARGS   trials, request mix (0.5), write stream (20/s), extra harness flags
#   BUDGET             tier 1: shared (one podman-pod slice, default) | split (per-container CPU quotas);
#                      tier 2: slice (bench-target.slice, always)
#   MEMORY_SPLIT       split (default: per-container memory limits summing to the budget) | slice
#                      (tier 2: the slice's 2 GiB is the only limit; processes still sized from the split)
#   APP_MEMORY_MIB PG_MEMORY_MIB REDIS_MEMORY_MIB   the memory split (512 / 1280 / 256)
#   PRE_START_HOOK     command run between a restore and the measured start (default: drop the page cache)
#   SAMPLE_SH CONDITIONS_SH   tier 2: environments/gcp/sample.sh and conditions.sh, run around each trial
#   HARNESS_DATASET_HOST      the expanded dataset the generator reads (default: dataset/dev, or
#                             .work/dataset/bench prepared by ecommerce-store scripts/prepare-dataset.mjs)
#   WAIT_FOR_IDLE      tier 1: seconds to wait for other projects' containers to go idle (900)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
cd "$HERE"

export TIER="${TIER:-1}"
if [ "$TIER" = 2 ] && command -v docker >/dev/null 2>&1 && docker version >/dev/null 2>&1; then CLI=docker
elif command -v podman >/dev/null 2>&1; then CLI=podman
elif command -v docker >/dev/null 2>&1; then CLI=docker
else echo "need podman or docker" >&2; exit 1
fi
PROJECT=aab-ecommerce-rough
COMPOSE=("$CLI" compose -f "$HERE/compose.yaml")
# Tier 2 places every target container in bench-target.slice and the generator and loaders in
# bench-generator.slice (environments/gcp/host-setup.sh creates both).
if [ "$TIER" = 2 ]; then COMPOSE+=(-f "$HERE/compose.tier2.yaml"); fi
SNAP="$HERE/.snapshots"
RAW="$HERE/results/raw"
mkdir -p "$SNAP" "$RAW"

say() { printf '\n==> %s\n' "$*" >&2; }
compose() { "${COMPOSE[@]}" "$@" 2> >(grep -v -e 'external compose provider' -e '^\s*$' -e '^.\[0m$' >&2); }
# Restore and snapshot helpers run in the target slice on tier 2, as ecommerce-store's do (they
# use `compose run harper`): only stopped targets are there then, and the page cache a restore
# fills is charged inside the budget, then dropped before the cold start.
HELPER_PLACEMENT=()
if [ "$TIER" = 2 ]; then HELPER_PLACEMENT=(--cgroup-parent bench-target.slice); fi

# --- configuration -------------------------------------------------------------------------------
setup() {
	if [ ! -f .env ]; then
		local es="${ECOMMERCE_STORE_DIR:-}"
		if [ -z "$es" ]; then
			# The sibling checkout of the main worktree (works from a linked worktree too).
			es="$(cd "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)/../.." && pwd)/ecommerce-store"
		fi
		[ -f "$es/SPEC.md" ] || { echo "ecommerce-store checkout not found at $es; set ECOMMERCE_STORE_DIR" >&2; exit 1; }
		umask 077
		{
			echo "ECOMMERCE_STORE_DIR=$es"
			echo "HDB_ADMIN_USERNAME=benchadmin"
			# Local test credential for a Harper container reachable only on this machine.
			echo "HDB_ADMIN_PASSWORD=$(node -e "console.log(require('node:crypto').randomBytes(18).toString('base64url'))")"
		} > .env
		say "wrote .env (ECOMMERCE_STORE_DIR=$es)"
	fi
	local override="${ECOMMERCE_STORE_DIR:-}"
	set -a; . ./.env; set +a
	if [ -n "$override" ]; then export ECOMMERCE_STORE_DIR="$override"; fi
	[ -f "$ECOMMERCE_STORE_DIR/bench/cycles.mjs" ] || { echo "$ECOMMERCE_STORE_DIR predates ecommerce-store #4's harness (main from f47978b); point ECOMMERCE_STORE_DIR at a checkout that has it" >&2; exit 1; }
	# The harness and verify-run-record import @ecommerce-store/spec from the checkout's workspace.
	[ -e "$ECOMMERCE_STORE_DIR/node_modules/@ecommerce-store/spec" ] || { echo "the ecommerce-store workspace is not installed: run npm install --ignore-scripts --no-audit --no-fund in $ECOMMERCE_STORE_DIR" >&2; exit 1; }
	export SCALE="${SCALE:-dev}"
	case "$SCALE" in
		dev) ;;
		# As the reference's orchestrator: on a local machine a bench run's DATA-004 evidence and
		# CPU figures cannot be trusted, and the dataset does not fit a laptop's disk with margin.
		bench) [ "$TIER" = 2 ] || { echo "SCALE=bench runs only on tier 2 (TIER=2); local runs use SCALE=dev" >&2; exit 1; } ;;
		*) echo "SCALE must be dev or bench" >&2; exit 1 ;;
	esac
	# The loader reads the committed dataset (bench gzipped, verified and streamed as is); the
	# generator reads an expanded copy, as the reference's harness does.
	export DATASET_DIR="$ECOMMERCE_STORE_DIR/dataset/$SCALE"
	if [ "$SCALE" = dev ]; then
		HARNESS_DATASET_HOST="${HARNESS_DATASET_HOST:-$ECOMMERCE_STORE_DIR/dataset/dev}"
	else
		HARNESS_DATASET_HOST="${HARNESS_DATASET_HOST:-$ECOMMERCE_STORE_DIR/.work/dataset/bench}"
	fi
	[ -f "$HARNESS_DATASET_HOST/MANIFEST.json" ] || { echo "no expanded dataset at $HARNESS_DATASET_HOST (run ecommerce-store scripts/prepare-dataset.mjs --scale $SCALE)" >&2; exit 1; }
	case "$HARNESS_DATASET_HOST" in
		"$ECOMMERCE_STORE_DIR"/*) export HARNESS_DATASET="/work/${HARNESS_DATASET_HOST#"$ECOMMERCE_STORE_DIR"/}" ;;
		*) echo "HARNESS_DATASET_HOST must be inside ECOMMERCE_STORE_DIR (it reaches the generator through that mount)" >&2; exit 1 ;;
	esac
	export HARNESS_DATASET_HOST
	# Snapshots are named by target, scale and dataset generator version, so a regenerated dataset
	# writes a new snapshot beside the old one (as the reference's orchestrator does).
	DATASET_GENERATOR="$(node -p "require('$DATASET_DIR/MANIFEST.json').generatorVersion")"
	export DATASET_GENERATOR
	# Tier 2's local SSD has room for an uncompressed snapshot, which restores far faster than a
	# gzipped one at bench scale; tier 1 is short of disk.
	export SNAPSHOT_COMPRESS="${SNAPSHOT_COMPRESS:-$([ "$TIER" = 2 ] && echo 0 || echo 1)}"
	# A restore runs in its own container, so the restored files sit in the page cache charged to
	# no target. Drop it between the restore and the measured start, for every target, as the
	# reference's orchestrator does (its PRE_START_HOOK). On a Podman machine this also cools every
	# other container on the machine.
	if [ -z "${PRE_START_HOOK+set}" ]; then
		if [ "$CLI" = podman ] && podman machine inspect >/dev/null 2>&1; then
			PRE_START_HOOK="podman machine ssh 'sync; echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null'"
		elif [ "$(uname -s)" = Linux ]; then
			PRE_START_HOOK="sync; echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null"
		fi
	fi
	export PRE_START_HOOK="${PRE_START_HOOK:-}"
	export RESULTS_DIR="$RAW"
	export TARGET_CPUS="${TARGET_CPUS:-2}" TARGET_MEMORY_MIB="${TARGET_MEMORY_MIB:-2048}"
	export BUDGET="${BUDGET:-$([ "$TIER" = 2 ] && echo slice || echo shared)}"
	configure_budget
	# Steps of at least 60 s on bench: tier-2 cycle samples are 250 ms apart, so a 15 s step could
	# misattribute up to ~3% of its cycles at its boundaries (ecommerce-store PUBLISHED_RUN).
	export DURATION="${DURATION:-$([ "$SCALE" = bench ] && echo 60 || echo 15)}"
	# Every image, as compose resolves it (pinned by digest), for the run record and the helpers.
	IMAGES="$(compose --profile harper --profile tools config --format json | node -e '
		let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
			const { services } = JSON.parse(s);
			const args = services.harper?.build?.args ?? {};
			console.log(JSON.stringify({
				postgres: services.postgres.image, redis: services.redis.image, node: services.app.build?.args?.NODE_IMAGE ?? null,
				generator: services.bench.image, harperNode: args.NODE_IMAGE ?? null, harperNodeSlim: args.NODE_SLIM_IMAGE ?? null,
			}));
		});')"
	export IMAGES
	HELPER_IMAGE="$(node -p "JSON.parse(process.argv[1]).postgres" "$IMAGES")"
	NODE_HELPER_IMAGE="$(node -p "JSON.parse(process.argv[1]).generator" "$IMAGES")"
}

ctr() { echo "${PROJECT}-$1-1"; }

# The fpr budget and the sizing of every process in it.
#
# CPU. Tier 1 `shared`: all three containers under one cgroup slice capped at TARGET_CPUS /
# TARGET_MEMORY (a podman pod that shares no namespaces, used only for its cgroup), so CPU is one
# pool, as it is for the single Harper process. Tier 1 `split`: per-container CPU quotas summing to
# TARGET_CPUS (a sensitivity). Tier 2 `slice`: bench-target.slice holds the budget (cores 2-3,
# 2 GiB) for every target, and compose.tier2.yaml places the containers in it.
#
# Memory. Per-container limits summing to the budget (MEMORY_SPLIT=split), and every process sized
# from its own container's limit, explicitly: a container cannot see its slice's limits on tier 2,
# and on a Podman machine it sees the VM.
configure_budget() {
	case "$TIER:$BUDGET" in
		1:shared)
			local pod="${PROJECT}-budget"
			if ! "$CLI" pod exists "$pod"; then
				"$CLI" pod create --name "$pod" --share none --infra=false --cpus "$TARGET_CPUS" --memory "${TARGET_MEMORY_MIB}m" >/dev/null
			fi
			BUDGET_CGROUP_PARENT="machine-libpod_pod_$("$CLI" pod inspect "$pod" --format '{{.ID}}').slice"
			export BUDGET_CGROUP_PARENT BUDGET_CGROUP="/machine.slice/$BUDGET_CGROUP_PARENT"
			export APP_CPUS="$TARGET_CPUS" PG_CPUS="$TARGET_CPUS" REDIS_CPUS="$TARGET_CPUS" ;;
		1:split)
			unset BUDGET_CGROUP_PARENT; export BUDGET_CGROUP=""
			export APP_CPUS="${APP_CPUS:-1.25}" PG_CPUS="${PG_CPUS:-0.5}" REDIS_CPUS="${REDIS_CPUS:-0.25}"
			node -e "const s=$APP_CPUS+$PG_CPUS+$REDIS_CPUS; if (Math.abs(s-$TARGET_CPUS)>1e-9) { console.error('split sums to '+s+', budget is $TARGET_CPUS'); process.exit(1) }" ;;
		2:slice)
			# compose.tier2.yaml sets cgroup_parent and removes every target container's CPU quota:
			# the slice's cpuset is the budget, and a quota would add CFS throttling.
			unset BUDGET_CGROUP_PARENT; export BUDGET_CGROUP="/bench.slice/bench-target.slice"
			export APP_CPUS=none PG_CPUS=none REDIS_CPUS=none ;;
		*) echo "BUDGET must be shared or split on tier 1, slice on tier 2" >&2; exit 1 ;;
	esac
	export MEMORY_SPLIT="${MEMORY_SPLIT:-split}"
	export APP_MEMORY_MIB="${APP_MEMORY_MIB:-512}" PG_MEMORY_MIB="${PG_MEMORY_MIB:-1280}" REDIS_MEMORY_MIB="${REDIS_MEMORY_MIB:-256}"
	node -e "const m=$APP_MEMORY_MIB+$PG_MEMORY_MIB+$REDIS_MEMORY_MIB; if (m!==$TARGET_MEMORY_MIB) { console.error('memory split sums to '+m+' MiB, budget is $TARGET_MEMORY_MIB'); process.exit(1) }"
	export APP_WORKERS="${APP_WORKERS:-2}"
	# Node: the primary and each worker get the same heap cap; about 190 MiB of the container is
	# left for the primary, buffers and the page cache of the Node binary and modules.
	export NODE_HEAP_MIB="${NODE_HEAP_MIB:-$(( (APP_MEMORY_MIB - 192) / APP_WORKERS ))}"
	# Postgres: the manual's starting points, against the container.
	export PG_SHARED_BUFFERS="${PG_SHARED_BUFFERS:-$(( PG_MEMORY_MIB / 4 ))MB}"
	export PG_EFFECTIVE_CACHE_SIZE="${PG_EFFECTIVE_CACHE_SIZE:-$(( PG_MEMORY_MIB * 3 / 4 ))MB}"
	# Redis: about 60% of the container, leaving fragmentation, buffers and its binary's page cache.
	export REDIS_MAXMEMORY_MB="${REDIS_MAXMEMORY_MB:-$(( REDIS_MEMORY_MIB * 3 / 5 ))}"
	if [ "$MEMORY_SPLIT" = slice ]; then
		[ "$TIER" = 2 ] || { echo "MEMORY_SPLIT=slice needs the tier-2 slice to hold the total" >&2; exit 1; }
		# The slice's MemoryMax is the only limit; each container may use what the others leave,
		# as processes on one machine would. The processes are still sized from the split.
		export APP_MEMORY_LIMIT_MIB="$TARGET_MEMORY_MIB" PG_MEMORY_LIMIT_MIB="$TARGET_MEMORY_MIB" REDIS_MEMORY_LIMIT_MIB="$TARGET_MEMORY_MIB"
	else
		export APP_MEMORY_LIMIT_MIB="$APP_MEMORY_MIB" PG_MEMORY_LIMIT_MIB="$PG_MEMORY_MIB" REDIS_MEMORY_LIMIT_MIB="$REDIS_MEMORY_MIB"
	fi
}

base_of() { case "$1" in harper-unbatched) echo harper ;; *) echo "$1" ;; esac; }
snapshot_of() { echo "$(base_of "$1")-$SCALE-dataset-$DATASET_GENERATOR.tar$([ "$SNAPSHOT_COMPRESS" = 1 ] && echo .gz)"; }
services_of() { if [ "$1" = fpr ]; then echo "postgres redis app"; else echo "harper"; fi; }
profile_of() { if [ "$1" != fpr ]; then echo "--profile harper"; fi; }
port_of() { if [ "$1" = fpr ]; then echo "${APP_HOST_PORT:-39926}"; else echo "${HARPER_HOST_PORT:-39936}"; fi; }
url_in_network() { if [ "$1" = fpr ]; then echo "http://app:3000"; else echo "http://harper:9926"; fi; }
volume_of() { if [ "$1" = fpr ]; then echo "${PROJECT}_pg-data"; else echo "${PROJECT}_harper-data"; fi; }
all_targets() { echo "fpr harper"; }

# The build of the reference a trial runs, through ecommerce-store's own build variables
# (containers/compose.yaml: TARGET_IMAGE, TARGET_IMAGE_TAG, TARGET_CONTEXT, TARGET_DOCKERFILE;
# run-benchmark.sh sets them from TARGET_REF the same way). TARGET_IMAGE gives this project's
# images their own name: image names are global to the host, so a build here never replaces the
# image ecommerce-store's own orchestrator uses on the same machine. harper is the checkout. harper-unbatched is the commit
# HARPER_UNBATCHED_REF names (default dd3a5f5^, the build before quote batching), extracted with
# git archive into .targets/ here and built with the checkout's Dockerfile, so the two builds
# differ only in application code and both images stay built. It restores harper's snapshot, so
# its schema must be the checkout's.
select_variant() {
	export TARGET_IMAGE=aab-harper-reference TARGET_DOCKERFILE="$ECOMMERCE_STORE_DIR/containers/Dockerfile"
	if [ "$1" != harper-unbatched ]; then
		export TARGET_CONTEXT="$ECOMMERCE_STORE_DIR" TARGET_IMAGE_TAG=checkout TARGET_COMMIT="$(git -C "$ECOMMERCE_STORE_DIR" rev-parse HEAD)"
		return
	fi
	grep -q 'TARGET_IMAGE_TAG' "$ECOMMERCE_STORE_DIR/containers/compose.yaml" \
		|| { echo "harper-unbatched needs an ecommerce-store checkout whose compose builds from TARGET_CONTEXT (main from f47978b)" >&2; exit 1; }
	local ref="${HARPER_UNBATCHED_REF:-dd3a5f5^}" commit
	commit="$(git -C "$ECOMMERCE_STORE_DIR" rev-parse --verify --quiet "${ref}^{commit}")" || { echo "HARPER_UNBATCHED_REF $ref is not a commit in $ECOMMERCE_STORE_DIR" >&2; exit 1; }
	git -C "$ECOMMERCE_STORE_DIR" diff --quiet "$commit" HEAD -- schemas \
		|| { echo "$ref has a different schema from the checkout; it cannot restore harper's snapshot" >&2; exit 1; }
	export TARGET_CONTEXT="$HERE/.targets/$commit" TARGET_IMAGE_TAG="${commit:0:12}" TARGET_COMMIT="$commit"
	if [ ! -d "$TARGET_CONTEXT" ]; then
		rm -rf "$TARGET_CONTEXT.partial" && mkdir -p "$TARGET_CONTEXT.partial"
		# The dataset is loaded from the checkout, never built in.
		git -C "$ECOMMERCE_STORE_DIR" archive "$commit" -- . ':(exclude)dataset' | tar -x -C "$TARGET_CONTEXT.partial"
		mv "$TARGET_CONTEXT.partial" "$TARGET_CONTEXT"
	fi
}

build_target() {
	select_variant "$1"
	if [ "$1" = fpr ]; then compose build app; else compose --profile harper build harper; fi
}

stop_target() {
	# shellcheck disable=SC2046
	compose $(profile_of "$1") stop $(services_of "$1") >/dev/null 2>&1 || true
}

# A container's cgroup v2 directory, relative to the cgroup root.
cgroup_of() {
	if [ "$CLI" = podman ]; then
		"$CLI" inspect --format '{{.State.CgroupPath}}' "$1"
	else
		local id; id="$("$CLI" inspect --format '{{.Id}}' "$1")"
		find /sys/fs/cgroup -maxdepth 5 -type d -name "docker-$id.scope" 2>/dev/null | head -1 | sed 's|^/sys/fs/cgroup||'
	fi
}

# --- seed + snapshot (not measured) --------------------------------------------------------------
load() {
	local target="$1"
	for t in $(all_targets); do stop_target "$t"; done
	select_variant "$target"
	build_target "$target"
	if [ "$target" = fpr ]; then
		compose up -d postgres redis
		# Retries until Postgres and Redis answer; verifies every file against MANIFEST.json first.
		compose run --rm loader
	else
		# Seed onto an EMPTY volume. The loader writes through the operations API, which does not
		# invalidate Harper's derived ProductView; a view left from earlier state (or filled by a
		# readiness probe before the load) would survive into the snapshot. That happened once.
		"$CLI" run --rm ${HELPER_PLACEMENT[@]+"${HELPER_PLACEMENT[@]}"} -v "$(volume_of harper):/data" "$HELPER_IMAGE" find /data -mindepth 1 -delete
		compose --profile harper up -d harper
		# Probe a path that touches no cache: an empty target answers 404, any status below 500 is up.
		node "$ECOMMERCE_STORE_DIR/containers/wait-ready.mjs" --accept any --url "http://localhost:$(port_of harper)/" >/dev/null
		compose run --rm harper-loader
	fi
	say "snapshotting $target"
	stop_target "$target"
	"$CLI" run --rm ${HELPER_PLACEMENT[@]+"${HELPER_PLACEMENT[@]}"} -v "$(volume_of "$target"):/data:ro" -v "$SNAP:/snap" "$HELPER_IMAGE" \
		tar -C /data "-c$([ "$SNAPSHOT_COMPRESS" = 1 ] && echo z)f" "/snap/$(snapshot_of "$target")" .
	ls -la "$SNAP/$(snapshot_of "$target")" >&2
}

restore() {
	local target="$1"
	[ -f "$SNAP/$(snapshot_of "$target")" ] || { echo "no $(snapshot_of "$target"); run: scripts/run.sh load $(base_of "$target")" >&2; exit 1; }
	stop_target "$target"
	"$CLI" run --rm ${HELPER_PLACEMENT[@]+"${HELPER_PLACEMENT[@]}"} -v "$(volume_of "$target"):/data" -v "$SNAP:/snap:ro" "$HELPER_IMAGE" \
		sh -c 'find /data -mindepth 1 -delete && tar -C /data -xf "/snap/$0"' "$(snapshot_of "$target")"
}

# Create (or re-create, if the budget or variant changed) the target's containers without starting
# them, drop the page cache, then start every process at once and time the first successful product
# response: the cold start.
cold_start() {
	local target="$1" port t0 probe
	select_variant "$target"
	port="$(port_of "$target")"
	probe="http://localhost:$port/product/product-000000?tier=standard&region=us-east"
	# shellcheck disable=SC2046
	compose $(profile_of "$target") up --no-start $(services_of "$target") >/dev/null
	local ctrs=()
	for s in $(services_of "$target"); do ctrs+=("$(ctr "$s")"); done
	export PAGE_CACHE_DROPPED_AT=""
	if [ -n "$PRE_START_HOOK" ]; then bash -c "$PRE_START_HOOK"; PAGE_CACHE_DROPPED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ); fi
	t0=$(node -e 'console.log(Date.now())')
	"$CLI" start "${ctrs[@]}" >/dev/null
	# The reference orchestrator's probe, from outside the target (no process charged to its
	# budget): every 25 ms, milliseconds from t0 to the first accepted response.
	COLD_MS=$(node "$ECOMMERCE_STORE_DIR/containers/wait-ready.mjs" --accept ok --since "$t0" --timeout 600000 --url "$probe")
	say "$target cold start: first 200 after ${COLD_MS}ms"
}

# Tier 1 only: wait until no container outside this project is busy, so a measurement is not
# taken under contention from another workload on the same machine. Uses instantaneous cgroup
# counters (scripts/busy.mjs): `podman stats` reports lifetime-average CPU. Tier 2 is a dedicated
# VM whose housekeeping runs on its own CPUs; there, other running containers are only recorded.
busy_others() {
	local groups="{" sep="" id name path
	while read -r id name; do
		case "$name" in "$PROJECT"-*) continue ;; esac
		path=$(cgroup_of "$id" 2>/dev/null) || continue
		[ -n "$path" ] || continue
		groups="$groups$sep\"$name\":\"$path\""; sep=","
	done < <("$CLI" ps --no-trunc --format '{{.ID}} {{.Names}}')
	groups="$groups}"
	[ "$groups" = "{}" ] && return 0
	if [ "$TIER" = 2 ]; then
		echo "$groups" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Object.keys(JSON.parse(s)).map(n=>n+"=running").join(",")))'
		return 0
	fi
	"$CLI" run --rm -e CGROUPS="$groups" -v /sys/fs/cgroup:/host/cgroup:ro -v "$HERE/scripts:/cmp:ro" \
		"$NODE_HELPER_IMAGE" node /cmp/busy.mjs
}

wait_for_idle() {
	local deadline=$(( $(date +%s) + ${WAIT_FOR_IDLE:-900} )) busy
	while :; do
		busy="$(busy_others)"
		[ -z "$busy" ] && break
		if [ "$TIER" = 2 ]; then say "other containers running on this host (recorded): $busy"; break; fi
		if [ "$(date +%s)" -gt "$deadline" ]; then say "other containers still busy ($busy); proceeding, recorded as contention"; break; fi
		say "waiting for other workloads to go idle: $busy"
		sleep 20
	done
	CONTENTION="$busy"
}

conditions_json() {
	local target="$1" stamp="$2"
	local file="$RAW/conditions-$target-$stamp.json"
	local images="" applied_memory=0 parents=""
	for s in $(services_of "$target"); do
		images="$images $("$CLI" inspect --format '{{.Config.Image}}@{{.Image}}' "$(ctr "$s")")"
		applied_memory=$(( applied_memory + $("$CLI" inspect --format '{{.HostConfig.Memory}}' "$(ctr "$s")") ))
		parents="$parents $("$CLI" inspect --format '{{.HostConfig.CgroupParent}}' "$(ctr "$s")")"
	done
	# What the target may use in total: the sum of its containers' limits, or the budget if that is
	# smaller (MEMORY_SPLIT=slice gives each container the whole slice). verify-run-record reads it.
	local budget_bytes=$(( TARGET_MEMORY_MIB * 1024 * 1024 ))
	if [ "$applied_memory" -gt "$budget_bytes" ]; then applied_memory=$budget_bytes; fi
	local info; info="$("$CLI" info --format json 2>/dev/null || echo '{}')"
	local target_dirty=0 harness_dirty=0 aab_dirty=0
	[ -n "$(git -C "$REPO" status --porcelain)" ] && aab_dirty=1
	[ -n "$(git -C "$ECOMMERCE_STORE_DIR" status --porcelain)" ] && harness_dirty=1
	case "$target" in fpr) target_dirty=$aab_dirty ;; harper) target_dirty=$harness_dirty ;; esac
	node -e '
		const [file, target, stamp, cold, contention, images, budget, aabCommit, aabDirty, esCommit, esDirty, info, appliedMemory, snapshot, parents, targetCommit, targetDirty] = process.argv.slice(1);
		const env = process.env;
		const i = JSON.parse(info || "{}");
		const pinned = JSON.parse(env.IMAGES);
		// Podman and Docker report the host differently.
		const machine = i.host
			? { cpus: i.host.cpus, memTotal: i.host.memTotal, kernel: i.host.kernel, arch: i.host.arch, distribution: i.host.distribution, runtime: "podman " + i.version?.Version, cgroups: i.host.cgroupVersion, ociRuntime: i.host.ociRuntime?.name }
			: { cpus: i.NCPU, memTotal: i.MemTotal, kernel: i.KernelVersion, arch: i.Architecture, distribution: i.OperatingSystem, runtime: "docker " + i.ServerVersion, cgroups: i.CgroupVersion, cgroupDriver: i.CgroupDriver };
		const distinctParents = [...new Set(parents.trim().split(/\s+/).filter(Boolean))];
		const fpr = target === "fpr";
		const out = {
			tier: +env.TIER,
			stamp, target,
			coldStart: { ms: +cold, probe: "host, published port, ecommerce-store containers/wait-ready.mjs (25 ms), every target process started at once" },
			// Read by ecommerce-store verify-run-record.mjs: the page-cache drop before the cold start,
			// and what the runtime applied to the target (memory summed over its containers; the
			// cgroup parent they share, or every distinct one if they differ).
			preStartHook: env.PRE_START_HOOK || null,
			pageCacheDroppedAt: env.PAGE_CACHE_DROPPED_AT || null,
			target: {
				applied: { memoryBytes: +appliedMemory, cgroupParent: distinctParents.join(",") || null },
				baseImages: fpr ? { postgres: pinned.postgres, redis: pinned.redis, node: pinned.node } : { "node:24": pinned.harperNode, "node:24-slim": pinned.harperNodeSlim },
				build: fpr ? null : { commit: targetCommit, imageTag: env.TARGET_IMAGE_TAG, source: target === "harper-unbatched" ? "git archive of " + (env.HARPER_UNBATCHED_REF || "dd3a5f5^") : "checkout" },
				image: fpr ? null : { name: env.TARGET_IMAGE, tag: env.TARGET_IMAGE_TAG },
			},
			generator: { image: pinned.generator, cpus: env.BENCH_CPUS || (env.TIER === "2" ? "4" : "2"), memory: env.BENCH_MEMORY || (env.TIER === "2" ? "3g" : "1g") },
			snapshot: { file: snapshot, datasetGenerator: env.DATASET_GENERATOR, compressed: env.SNAPSHOT_COMPRESS === "1" },
			code: {
				target: { commit: targetCommit, dirty: targetDirty === "1" },
				benchmarksRepo: { commit: aabCommit, dirty: aabDirty === "1" },
				ecommerceStore: { commit: esCommit, dirty: esDirty === "1" },
			},
			images: images.trim().split(/\s+/),
			budget: fpr
				? { mode: budget, memorySplit: env.MEMORY_SPLIT, targetCpus: +env.TARGET_CPUS, targetMemoryMiB: +env.TARGET_MEMORY_MIB,
				    cgroup: env.BUDGET_CGROUP || null,
				    cpus: { app: env.APP_CPUS, postgres: env.PG_CPUS, redis: env.REDIS_CPUS },
				    memoryMiB: { app: +env.APP_MEMORY_MIB, postgres: +env.PG_MEMORY_MIB, redis: +env.REDIS_MEMORY_MIB },
				    memoryLimitMiB: { app: +env.APP_MEMORY_LIMIT_MIB, postgres: +env.PG_MEMORY_LIMIT_MIB, redis: +env.REDIS_MEMORY_LIMIT_MIB },
				    sizing: { workers: +env.APP_WORKERS, nodeHeapMiB: +env.NODE_HEAP_MIB, pgSharedBuffers: env.PG_SHARED_BUFFERS, pgEffectiveCacheSize: env.PG_EFFECTIVE_CACHE_SIZE, pgWorkMem: env.PG_WORK_MEM || "4MB", redisMaxmemoryMB: +env.REDIS_MAXMEMORY_MB } }
				: { mode: "single container", cgroup: env.TIER === "2" ? "/bench.slice/bench-target.slice" : null, targetCpus: +env.TARGET_CPUS, targetMemoryMiB: +env.TARGET_MEMORY_MIB, harperThreads: +(env.HARPER_THREADS || 2) },
			lifecycle: { coldStartFirst200Ms: +cold, restoredFromSnapshot: true },
			networking: "user-defined bridge (compose), plain HTTP; generator in a separate container on the same bridge",
			machine,
			contentionAtStart: { otherContainers: contention || null },
			caveats: env.TIER === "2"
				? ["Tier 2, first session: exploratory (step 0 for tier 2), not a publishable result. Clock bounded (ALL_CORE_MAX) and measured per step by sample.sh and the cycle join, never pinned."]
				: ["Tier 1 (containers in a macOS podman VM): signal, not results. CPU clock not pinned; no cycle-normalized figure exists.", "dev dataset: fits in memory; never a benchmark target (DATA-004)."],
		};
		require("node:fs").writeFileSync(file, JSON.stringify(out, null, 2));
	' "$file" "$target" "$stamp" "$COLD_MS" "$CONTENTION" "$images" "$BUDGET" \
		"$(git -C "$REPO" rev-parse HEAD)" "$aab_dirty" "$(git -C "$ECOMMERCE_STORE_DIR" rev-parse HEAD)" "$harness_dirty" \
		"$info" "$applied_memory" "$(snapshot_of "$target")" "$parents" "$(target_commit "$target")" "$target_dirty"
	echo "$file"
}

# The commit of the target's application code: this repository for fpr, the ecommerce-store
# checkout for harper, HARPER_UNBATCHED_REF for harper-unbatched.
target_commit() {
	case "$1" in
		fpr) git -C "$REPO" rev-parse HEAD ;;
		*) select_variant "$1"; echo "$TARGET_COMMIT" ;;
	esac
}

post_run_stats() {
	local target="$1" stamp="$2"
	local file="$RAW/post-$target-$stamp.json"
	if [ "$target" = fpr ]; then
		{
			echo '{"meta":'; curl -s "http://localhost:$(port_of fpr)/__meta"
			echo ',"stats":'; curl -s "http://localhost:$(port_of fpr)/__stats"
			echo ',"redisInfo":'; "$CLI" exec "$(ctr redis)" redis-cli INFO | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o={};for(const l of s.split(/\r?\n/)){const m=/^([a-z_0-9]+):(.*)$/.exec(l);if(m)o[m[1]]=m[2]}console.log(JSON.stringify(o))})'
			echo ',"pgStatements":'; "$CLI" exec "$(ctr postgres)" psql -U store -d store -At -c "SELECT coalesce(json_agg(t),'[]') FROM (SELECT left(regexp_replace(query, '\s+', ' ', 'g'), 120) AS query, calls, round(mean_exec_time::numeric, 4) AS mean_ms, round(total_exec_time::numeric, 1) AS total_ms, rows, shared_blks_hit, shared_blks_read FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 15) t"
			echo ',"pgTables":'; "$CLI" exec "$(ctr postgres)" psql -U store -d store -At -c "SELECT json_agg(t) FROM (SELECT relname, seq_scan, seq_tup_read, idx_scan, n_tup_upd, n_tup_hot_upd, n_dead_tup, heap_blks_read, heap_blks_hit FROM pg_stat_user_tables JOIN pg_statio_user_tables USING (relid, schemaname, relname) ORDER BY relname) t"
			echo '}'
		} > "$file"
	else
		echo '{}' > "$file"
	fi
	echo "$file"
}

# Harper sizes each worker's heap and its RocksDB block cache from process.constrainedMemory()
# unless threads.maxHeapMemory and storage.rocks.blockCacheSize are configured, and the reference
# configures neither (environments/gcp/ecommerce-store-gaps.md, "Open"). Record what they resolved
# to in this trial, from inside the running target after the ladder: the inputs, any configured
# overrides, the sizes Harper's rules give, and the source lines those rules were read from, so a
# Harper release that changes them shows in the record.
HARPER_MEMORY_JS='
import { readFileSync } from "node:fs";
import { totalmem } from "node:os";
const MB = 2 ** 20;
const dist = "/usr/local/lib/node_modules/harper/dist";
const rules = (file, re) => { try { return readFileSync(`${dist}/${file}`, "utf8").split("\n").map((l, i) => [i + 1, l.trim()]).filter(([, l]) => re.test(l)).map(([n, l]) => `${file}:${n}: ${l}`); } catch (e) { return [`${file}: ${e.message}`]; } };
const auth = "Basic " + Buffer.from(`${process.env.HDB_ADMIN_USERNAME}:${process.env.HDB_ADMIN_PASSWORD}`).toString("base64");
const op = async (body) => { try { const r = await fetch("http://localhost:9925/", { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify(body) }); return await r.json(); } catch (e) { return { error: e.message }; } };
const config = await op({ operation: "get_configuration" });
const info = await op({ operation: "system_information", attributes: ["threads", "memory"] });
const constrained = process.constrainedMemory?.();
const total = totalmem();
const threads = config.threads?.count ?? null;
const heap = config.threads?.maxHeapMemory ?? null;
const cache = config.storage?.rocks?.blockCacheSize ?? null;
const wbm = config.storage?.rocks?.writeBufferManagerSize ?? null;
// As Harper 5.3.2 computes them: server/threads/manageThreads.js startWorker (old space per worker,
// "||" on constrainedMemory) and utility/rocksMemoryConfig.js via resources/databases.js ("??").
const heapMiB = heap ?? Math.max(Math.floor(Math.min(constrained || total, total, 20000 * MB) / MB / (10 + (threads || 1) / 4)), 512);
const cacheBytes = Math.floor(typeof cache === "number" && cache > 0 ? cache : Math.min(constrained ?? Infinity, total) * 0.25);
console.log(JSON.stringify({
	harperVersion: process.env.HARPER_VERSION,
	inputs: { constrainedMemoryBytes: constrained, totalmemBytes: total, cgroupMemoryMax: readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim(), threads },
	configured: { "threads.maxHeapMemory": heap, "storage.rocks.blockCacheSize": cache, "storage.rocks.writeBufferManagerSize": wbm },
	resolved: {
		workerMaxOldGenerationMiB: heapMiB, workerMaxYoungGenerationMiB: Math.min(Math.max(heapMiB >> 6, 16), 64),
		rocksBlockCacheBytes: cacheBytes, rocksWriteBufferManagerBytes: Math.floor(typeof wbm === "number" ? wbm : cacheBytes / 3),
	},
	reported: { threads: info.threads ?? info, memory: info.memory ?? null },
	rules: [...rules("server/threads/manageThreads.js", /availableMemory|maxOldMemory =|maxYoungMemory =|THREADS_MAXHEAPMEMORY\)/), ...rules("utility/rocksMemoryConfig.js", /availableMemory \* 0\.25|blockCacheSize \/ 3/), ...rules("resources/databases.js", /availableMemory: /)],
}, null, 2));
'
harper_memory() {
	local file="$RAW/harper-memory-$1-$2.json"
	"$CLI" exec "$(ctr harper)" node --input-type=module -e "$HARPER_MEMORY_JS" > "$file" 2>&1 || say "Harper memory sizing not recorded (not fatal): $file"
}

# One trial of one target. Leaves the run record, the wrapper's summary, the conditions, the
# verification, the console and (tier 2) the host samples, host conditions and cycle join in
# results/raw, all named by target and stamp. Nothing is deleted.
bench() {
	local target="$1" stamp
	# Targets share a budget (one podman pod slice, or bench-target.slice): none other may be resident.
	for t in $(all_targets); do stop_target "$t"; done
	select_variant "$target"
	local trial=1
	while [ "$trial" -le "${TRIALS:-1}" ]; do
		stamp="$(date -u +%Y%m%dT%H%M%SZ)"
		say "trial $trial/$TRIALS for $target (tier $TIER, $SCALE, budget: $([ "$target" = fpr ] && echo "$BUDGET, memory $MEMORY_SPLIT" || echo 'single container'))"
		restore "$target"
		wait_for_idle
		local host_sampler="" samples=""
		if [ "$(uname -s)" = Darwin ]; then "$HERE/scripts/host-load.sh" "$RAW/host-$target-$stamp.txt" & host_sampler=$!; fi
		# Tier 2: environments/gcp/sample.sh around the trial, from before the cold start to after
		# the last step (cycles per slice every 250 ms; cgroup CPU and memory, host CPU and
		# maintenance events every second). A system unit, so it runs on the housekeeping CPUs.
		if [ -n "${SAMPLE_SH:-}" ]; then
			samples="$RAW/samples-$target-$stamp"
			sudo systemd-run --collect --unit="arch-bench-sampler-$stamp" bash "$SAMPLE_SH" "$samples" >/dev/null
			sleep 2 # perf attaches before the cold start
		fi
		cold_start "$target"
		if [ "$target" = fpr ]; then
			"$CLI" exec "$(ctr postgres)" psql -U store -d store -qAt -c "SELECT pg_stat_statements_reset()" -c "SELECT pg_stat_reset()" >/dev/null
		fi
		local cgroups="{" sep=""
		for s in $(services_of "$target"); do cgroups="$cgroups$sep\"$s\":\"$(cgroup_of "$(ctr "$s")")\""; sep=","; done
		cgroups="$cgroups}"
		local budget_cgroup=""
		if [ "$target" = fpr ]; then budget_cgroup="$BUDGET_CGROUP"; fi
		local conditions; conditions="$(conditions_json "$target" "$stamp")"
		# The harness accounts the target's CPU itself from these cgroups (one per container).
		local target_cgroups="" sep2=""
		for s in $(services_of "$target"); do target_cgroups="$target_cgroups$sep2$s=$("$CLI" inspect --format '{{.Id}}' "$(ctr "$s")")"; sep2=","; done
		local stats_url=""
		if [ "$target" = fpr ]; then stats_url="http://app:3000/__stats"; fi
		local harness_dirty=0; [ -n "$(git -C "$ECOMMERCE_STORE_DIR" status --porcelain)" ] && harness_dirty=1
		# shellcheck disable=SC2086
		compose run --rm -e TARGET="$target" -e TIER="$TIER" -e CGROUPS="$cgroups" -e BUDGET_CGROUP="$budget_cgroup" -e STATS_URL="$stats_url" \
			-e CODE_COMMIT="$(target_commit "$target")" -e CODE_DIRTY="$(node -p "require('$conditions').code.target.dirty ? 1 : 0")" \
			-e HARNESS_COMMIT="$(git -C "$ECOMMERCE_STORE_DIR" rev-parse HEAD)" -e HARNESS_DIRTY="$harness_dirty" \
			-e CONDITIONS="/results/$(basename "$conditions")" -e RUN_CONDITIONS="$(cat "$conditions")" bench -- \
			--url "$(url_in_network "$target")" --dataset "$HARNESS_DATASET" --target-cgroups "$target_cgroups" \
			--rates "${RATES:-100,200,400,600,800,1000,1200}" --duration "$DURATION" \
			--quote-share "${QUOTE_SHARE:-0.5}" --write-rate "${WRITE_RATE:-20}" \
			--out /results --cold-ms "$COLD_MS" ${BENCH_ARGS:-} | tee "$RAW/console-$target-$stamp.txt" || true
		if [ -n "$host_sampler" ]; then kill "$host_sampler" 2>/dev/null || true; fi
		local record; record="$(grep -oE 'run-[0-9TZ-]+\.json' "$RAW/console-$target-$stamp.txt" | tail -1 || true)"
		local verdict=ok basis=""
		fault() { if [ "$verdict" = ok ]; then verdict="$1"; else verdict="$verdict; $1"; fi; }
		# Tier 2: ecommerce-store's cycle join (bench/cycles.mjs) adds gigacycles, effective clock and
		# ops per gigacycle to every step of the record, as its own orchestrator does with SAMPLES_DIR.
		# It runs before the sampler stops, so it can wait for perf to write past the last step. In
		# the generator container: the record belongs to the user that container runs as.
		if [ -n "$samples" ] && [ -n "$record" ]; then
			compose run --rm --no-deps --entrypoint node -v "$samples:/samples:ro" bench \
				bench/cycles.mjs --samples /samples --write "/results/$record" > "$RAW/cycles-$target-$stamp.txt" 2>&1 \
				|| fault "cycle join failed"
		fi
		if [ -n "$samples" ]; then sudo systemctl stop "arch-bench-sampler-$stamp" || true; fi
		post_run_stats "$target" "$stamp" >/dev/null
		if [ "$target" != fpr ]; then harper_memory "$target" "$stamp"; fi
		if [ -z "$record" ]; then
			fault "no run record"
		else
			# The reference's run-level checks (on dev, DATA-004 is expected to fail; --dev says so).
			(cd "$ECOMMERCE_STORE_DIR" && node scripts/verify-run-record.mjs $([ "$SCALE" = dev ] && echo --dev) "$RAW/$record") > "$RAW/verify-$target-$stamp.txt" 2>&1 \
				|| fault "verification failed"
			# Which cgroup and limit DATA-004's memory evidence rested on, or that none met it.
			basis="$(grep -m1 -o 'DATA-004 memory basis: .*' "$RAW/verify-$target-$stamp.txt" || echo 'DATA-004 memory basis: not printed')"
			echo "$basis" | tee -a "$RAW/console-$target-$stamp.txt" >&2
			# A live migration or pending maintenance during the trial voids it (environments/gcp).
			if [ -n "$samples" ] && grep -qE ',(MIGRATE|TERMINATE)' "$samples/maintenance.log" 2>/dev/null; then
				fault "host maintenance event"
			fi
		fi
		# Tier 2: environments/gcp/conditions.sh after the trial: container state and image digests.
		if [ -n "${CONDITIONS_SH:-}" ]; then
			sudo bash "$CONDITIONS_SH" "$RAW/hostconditions-$target-$stamp" "$REPO" "$ECOMMERCE_STORE_DIR" >/dev/null 2>&1 || say "conditions.sh failed (recorded, not fatal)"
		fi
		# A stale response voids the trial like a failed verification. `|| fault`, not a bare pipe:
		# under set -e a failing audit would end run.sh before the verdict and the target's stop.
		if [ "$target" = fpr ]; then audit "${record:+$RAW/$record}" | tee -a "$RAW/console-$target-$stamp.txt" || fault "coherence audit failed"; fi
		# Targets share bench-target.slice on tier 2: never leave one resident inside the next one's budget.
		stop_target "$target"
		say "trial $target $stamp: $verdict"
		echo "trial: $target $stamp record=${record:-none} verdict=$verdict" | tee -a "$RAW/trials.log"
		echo "  $target $stamp ${basis:-DATA-004 memory basis: no record}" >> "$RAW/trials.log"
		trial=$((trial + 1))
	done
}

conformance() {
	local target="$1" stamp out
	stamp="$(date -u +%Y%m%dT%H%M%SZ)"
	out="$HERE/results/conformance-$target-dataset-$DATASET_GENERATOR.json"
	restore "$target"
	cold_start "$target"
	say "conformance suite against $target"
	(cd "$ECOMMERCE_STORE_DIR/e2e" && BASE_URL="http://localhost:$(port_of "$target")" PLAYWRIGHT_JSON_OUTPUT_NAME="$out.tmp" \
		npx playwright test --output="$REPO/.claude/tmp/e2e-$target" --reporter=list,json) || true
	node "$HERE/scripts/conformance-report.mjs" "$out.tmp" "$target" "$(git -C "$ECOMMERCE_STORE_DIR" rev-parse HEAD)" > "$out"
	rm -f "$out.tmp"
	cat "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.target+": "+r.passed+" passed, "+r.failed+" failed, "+r.skipped+" skipped")})'
	# The suite writes to the catalog; leave the target in its loaded state.
	restore "$target"
}

diff_reference() {
	say "restoring both targets and starting them side by side (correctness only, not a measurement)"
	restore fpr; restore harper
	cold_start fpr; cold_start harper
	node "$HERE/scripts/diff-reference.mjs" --a "http://localhost:$(port_of harper)" --b "http://localhost:$(port_of fpr)" \
		--dataset "$HARNESS_DATASET_HOST" --out "$HERE/results/diff-reference-dataset-$DATASET_GENERATOR.json"
	stop_target harper
}

# The reference's stack-neutral coherence check: concurrent readers and price writers, then
# every view must carry the last price written within FRESH_MS. Mutates prices: restores after.
coherence() {
	local target="$1"
	local out="$HERE/results/coherence-$target-dataset-$DATASET_GENERATOR.txt"
	restore "$target"
	cold_start "$target"
	say "verify-coherence against $target"
	(cd "$ECOMMERCE_STORE_DIR" && node scripts/verify-coherence.mjs --url "http://localhost:$(port_of "$target")") 2>&1 | tee "$out" || true
	echo "ecommerce-store $(git -C "$ECOMMERCE_STORE_DIR" rev-parse HEAD)" >> "$out"
	restore "$target"
}

audit() {
	say "coherence audit: cached responses vs responses computed from Postgres alone"
	sleep 2 # writes have stopped; FRESH_MS is 1000
	# The run record, when there is one, names the write stream the audit rebuilds.
	node "$HERE/scripts/audit-coherence.mjs" --url "http://localhost:$(port_of fpr)" --dataset "$HARNESS_DATASET_HOST" \
		--ecommerce-store "$ECOMMERCE_STORE_DIR" ${1:+--record "$1"}
}

cmd="${1:-}"; shift || true
case "$cmd" in
	setup) setup ;;
	build) setup; build_target "${1:?target}" ;;
	load) setup; load "${1:?target}" ;;
	conformance) setup; conformance "${1:?target}" ;;
	diff) setup; diff_reference ;;
	bench) setup; TRIALS="${TRIALS:-1}"; bench "${1:?target}" ;;
	audit) setup; audit ;;
	coherence) setup; coherence "${1:?target}" ;;
	stop) setup; for t in $(all_targets); do stop_target "$t"; done ;;
	*) awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"; exit 1 ;;
esac
