#!/usr/bin/env bash
# Step-0 comparison orchestrator: the Harper reference vs Fastify + Postgres + Redis.
#
#   scripts/run.sh setup                  resolve ECOMMERCE_STORE_DIR, write .env (local test credentials)
#   scripts/run.sh load <fpr|harper>      seed the dev dataset and snapshot the loaded state (not measured)
#   scripts/run.sh conformance <target>   restore, start, run the ecommerce-store e2e suite from the host
#   scripts/run.sh diff                   restore both, compare every quote and product response
#   scripts/run.sh bench <target>         restore, cold start, warm-up + ladder with per-container CPU
#   scripts/run.sh audit                  fpr only: cached vs source-of-truth responses, after a run
#   scripts/run.sh coherence <target>     the reference's verify-coherence.mjs (readers racing writers)
#   scripts/run.sh stop                   stop every container in this project
#
# Targets: `fpr` (Fastify + Postgres + Redis) and `harper` (the reference, built from the
# ecommerce-store checkout, unmodified).
#
# Environment: SCALE (dev), RATES, DURATION, WARMUP, TRIALS, BUDGET (shared|split, fpr only),
# APP_CPUS/PG_CPUS/REDIS_CPUS for the split, WAIT_FOR_IDLE (seconds to wait for other projects'
# containers to go idle before a measurement; default 900).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
cd "$HERE"

if command -v podman >/dev/null 2>&1; then CLI=podman; elif command -v docker >/dev/null 2>&1; then CLI=docker; else
	echo "need podman or docker" >&2; exit 1
fi
PROJECT=aab-ecommerce-rough
COMPOSE=("$CLI" compose -f "$HERE/compose.yaml")
SNAP="$HERE/.snapshots"
RAW="$HERE/results/raw"
mkdir -p "$SNAP" "$RAW"

say() { printf '\n==> %s\n' "$*" >&2; }
compose() { "${COMPOSE[@]}" "$@" 2> >(grep -v -e 'external compose provider' -e '^\s*$' -e '^.\[0m$' >&2); }

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
	[ -f "$ECOMMERCE_STORE_DIR/bench/cgroups.mjs" ] || { echo "$ECOMMERCE_STORE_DIR predates the cgroup-accounting harness (harper-5.3); point ECOMMERCE_STORE_DIR at a checkout that has it" >&2; exit 1; }
	export SCALE="${SCALE:-dev}"
	[ "$SCALE" = dev ] || { echo "only SCALE=dev is wired up in this rough cut" >&2; exit 1; }
	export DATASET_DIR="$ECOMMERCE_STORE_DIR/dataset/$SCALE"
	export RESULTS_DIR="$RAW"
	export TARGET_CPUS="${TARGET_CPUS:-2}" TARGET_MEMORY_MIB="${TARGET_MEMORY_MIB:-2048}"
	export BUDGET="${BUDGET:-shared}"
	configure_budget
}

ctr() { echo "${PROJECT}-$1-1"; }

# The fpr budget. `split`: per-container CPU limits summing to TARGET_CPUS. `shared`: all three
# containers run under one cgroup slice capped at TARGET_CPUS / TARGET_MEMORY (a podman pod that
# shares no namespaces, used only for its cgroup), so CPU is one pool, as it is for the single
# Harper process; per-container memory limits apply in both modes.
configure_budget() {
	if [ "$BUDGET" = shared ]; then
		local pod="${PROJECT}-budget"
		if ! "$CLI" pod exists "$pod"; then
			"$CLI" pod create --name "$pod" --share none --infra=false --cpus "$TARGET_CPUS" --memory "${TARGET_MEMORY_MIB}m" >/dev/null
		fi
		BUDGET_CGROUP_PARENT="machine-libpod_pod_$("$CLI" pod inspect "$pod" --format '{{.ID}}').slice"
		export BUDGET_CGROUP_PARENT
		export APP_CPUS="$TARGET_CPUS" PG_CPUS="$TARGET_CPUS" REDIS_CPUS="$TARGET_CPUS"
	elif [ "$BUDGET" = split ]; then
		unset BUDGET_CGROUP_PARENT
		export APP_CPUS="${APP_CPUS:-1.25}" PG_CPUS="${PG_CPUS:-0.5}" REDIS_CPUS="${REDIS_CPUS:-0.25}"
		node -e "const s=$APP_CPUS+$PG_CPUS+$REDIS_CPUS; if (Math.abs(s-$TARGET_CPUS)>1e-9) { console.error('split sums to '+s+', budget is $TARGET_CPUS'); process.exit(1) }"
	else
		echo "BUDGET must be shared or split" >&2; exit 1
	fi
	export APP_MEMORY_MIB="${APP_MEMORY_MIB:-640}" PG_MEMORY_MIB="${PG_MEMORY_MIB:-1024}" REDIS_MEMORY_MIB="${REDIS_MEMORY_MIB:-384}"
	node -e "const m=$APP_MEMORY_MIB+$PG_MEMORY_MIB+$REDIS_MEMORY_MIB; if (m!==$TARGET_MEMORY_MIB) { console.error('memory split sums to '+m+' MiB, budget is $TARGET_MEMORY_MIB'); process.exit(1) }"
}

services_of() { if [ "$1" = fpr ]; then echo "postgres redis app"; else echo "harper"; fi; }
profile_of() { if [ "$1" = harper ]; then echo "--profile harper"; fi; }
port_of() { if [ "$1" = fpr ]; then echo "${APP_HOST_PORT:-39926}"; else echo "${HARPER_HOST_PORT:-39936}"; fi; }
url_in_network() { if [ "$1" = fpr ]; then echo "http://app:3000"; else echo "http://harper:9926"; fi; }
volume_of() { if [ "$1" = fpr ]; then echo "${PROJECT}_pg-data"; else echo "${PROJECT}_harper-data"; fi; }
mount_of() { if [ "$1" = fpr ]; then echo "/var/lib/postgresql"; else echo "/data"; fi; }

stop_target() {
	# shellcheck disable=SC2046
	compose $(profile_of "$1") stop $(services_of "$1") >/dev/null 2>&1 || true
}

# --- seed + snapshot (not measured) --------------------------------------------------------------
load() {
	local target="$1"
	stop_target fpr; stop_target harper
	if [ "$target" = fpr ]; then
		compose build app
		compose up -d postgres redis
		compose run --rm loader # retries until Postgres and Redis answer
	else
		compose --profile harper build harper
		# Seed onto an EMPTY volume. The loader writes through the operations API, which does not
		# invalidate Harper's derived ProductView; a view left from earlier state (or filled by a
		# readiness probe before the load) would survive into the snapshot. That happened once.
		"$CLI" run --rm -v "$(volume_of harper):/data" docker.io/library/postgres:18.6-trixie find /data -mindepth 1 -delete
		compose --profile harper up -d harper
		# Probe a path that touches no cache: an empty target answers 404, any status below 500 is up.
		node "$ECOMMERCE_STORE_DIR/containers/wait-ready.mjs" --accept any --url "http://localhost:$(port_of harper)/" >/dev/null
		compose run --rm harper-loader
	fi
	say "snapshotting $target"
	stop_target "$target"
	"$CLI" run --rm -v "$(volume_of "$target"):/data:ro" -v "$SNAP:/snap" docker.io/library/postgres:18.6-trixie \
		tar -C /data -czf "/snap/$target-$SCALE.tar.gz" .
	ls -la "$SNAP/$target-$SCALE.tar.gz" >&2
}

restore() {
	local target="$1"
	[ -f "$SNAP/$target-$SCALE.tar.gz" ] || { echo "no snapshot for $target; run: scripts/run.sh load $target" >&2; exit 1; }
	stop_target "$target"
	"$CLI" run --rm -v "$(volume_of "$target"):/data" -v "$SNAP:/snap:ro" docker.io/library/postgres:18.6-trixie \
		sh -c 'find /data -mindepth 1 -delete && tar -C /data -xzf "/snap/$0-$1.tar.gz"' "$target" "$SCALE"
}

# Create (or re-create, if the budget changed) the target's containers without starting them, then
# start every process at once and time the first successful product response: the cold start.
cold_start() {
	local target="$1" port t0 probe
	port="$(port_of "$target")"
	probe="http://localhost:$port/product/product-000000?tier=standard&region=us-east"
	# shellcheck disable=SC2046
	compose $(profile_of "$target") up --no-start $(services_of "$target") >/dev/null
	local ctrs=()
	for s in $(services_of "$target"); do ctrs+=("$(ctr "$s")"); done
	t0=$(node -e 'console.log(Date.now())')
	"$CLI" start "${ctrs[@]}" >/dev/null
	# The reference orchestrator's probe, from outside the target (no process charged to its
	# budget): every 25 ms, milliseconds from t0 to the first accepted response.
	COLD_ANY_MS=""
	COLD_MS=$(node "$ECOMMERCE_STORE_DIR/containers/wait-ready.mjs" --accept ok --since "$t0" --timeout 180000 --url "$probe")
	say "$target cold start: first 200 after ${COLD_MS}ms"
}

# Wait until no container outside this project is busy, so a measurement is not taken under
# contention from another workload on the same machine. Records what it saw. Uses instantaneous
# cgroup counters (scripts/busy.mjs): `podman stats` reports lifetime-average CPU.
busy_others() {
	local groups="{" sep="" id name path
	while read -r id name; do
		case "$name" in "$PROJECT"-*) continue ;; esac
		path=$("$CLI" inspect --format '{{.State.CgroupPath}}' "$id" 2>/dev/null) || continue
		[ -n "$path" ] || continue
		groups="$groups$sep\"$name\":\"$path\""; sep=","
	done < <("$CLI" ps --no-trunc --format '{{.ID}} {{.Names}}')
	groups="$groups}"
	[ "$groups" = "{}" ] && return 0
	"$CLI" run --rm -e CGROUPS="$groups" -v /sys/fs/cgroup:/host/cgroup:ro -v "$HERE/scripts:/cmp:ro" \
		docker.io/library/node:24.21.0-slim node /cmp/busy.mjs
}

wait_for_idle() {
	local deadline=$(( $(date +%s) + ${WAIT_FOR_IDLE:-900} )) busy
	while :; do
		busy="$(busy_others)"
		[ -z "$busy" ] && break
		if [ "$(date +%s)" -gt "$deadline" ]; then say "other containers still busy ($busy); proceeding, recorded as contention"; break; fi
		say "waiting for other workloads to go idle: $busy"
		sleep 20
	done
	CONTENTION="$busy"
}

conditions_json() {
	local target="$1" stamp="$2"
	local file="$RAW/conditions-$target-$stamp.json"
	local others; others=$("$CLI" stats --no-stream --format json 2>/dev/null || echo '[]')
	local images=""
	for s in $(services_of "$target"); do images="$images $("$CLI" inspect --format '{{.ImageName}}@{{.Image}}' "$(ctr "$s")")"; done
	node -e '
		const [file, target, stamp, cold, coldAny, contention, others, images, budget, aabCommit, aabDirty, esCommit, esDirty, machine] = process.argv.slice(1);
		const env = process.env;
		const out = {
			tier: 1,
			stamp, target,
			coldStart: { ms: +cold, firstNon5xxMs: coldAny ? +coldAny : null, probe: "host, published port, ecommerce-store containers/wait-ready.mjs (25 ms), every target process started at once" },
			code: {
				benchmarksRepo: { commit: aabCommit, dirty: aabDirty === "1" },
				ecommerceStore: { commit: esCommit, dirty: esDirty === "1" },
			},
			images: images.trim().split(/\s+/),
			budget: target === "fpr"
				? { mode: budget, targetCpus: +env.TARGET_CPUS, targetMemoryMiB: +env.TARGET_MEMORY_MIB, cgroupParent: env.BUDGET_CGROUP_PARENT || null,
				    cpus: { app: +env.APP_CPUS, postgres: +env.PG_CPUS, redis: +env.REDIS_CPUS },
				    memoryMiB: { app: +env.APP_MEMORY_MIB, postgres: +env.PG_MEMORY_MIB, redis: +env.REDIS_MEMORY_MIB } }
				: { mode: "single container", targetCpus: +(env.TARGET_CPUS), targetMemoryMiB: +env.TARGET_MEMORY_MIB, harperThreads: +(env.HARPER_THREADS || 2) },
			lifecycle: { coldStartFirst200Ms: +cold, coldStartFirstNon5xxMs: coldAny ? +coldAny : null, restoredFromSnapshot: true },
			networking: "user-defined bridge (compose), plain HTTP; generator in a separate container on the same bridge",
			machine: JSON.parse(machine),
			contentionAtStart: { busyOtherContainers: contention || null, allContainers: JSON.parse(others).map(r => ({ name: r.name, cpu: r.cpu_percent, mem: r.mem_usage })) },
			caveats: [
				"Tier 1 (containers in a macOS podman VM): signal, not results. CPU clock not pinned; no cycle-normalized figure exists.",
				"dev dataset: fits in memory; never a benchmark target (DATA-004).",
			],
		};
		require("node:fs").writeFileSync(file, JSON.stringify(out, null, 2));
	' "$file" "$target" "$stamp" "$COLD_MS" "$COLD_ANY_MS" "$CONTENTION" "$others" "$images" "$BUDGET" \
		"$(git -C "$REPO" rev-parse HEAD)" "$([ -n "$(git -C "$REPO" status --porcelain)" ] && echo 1 || echo 0)" \
		"$(git -C "$ECOMMERCE_STORE_DIR" rev-parse HEAD)" "$([ -n "$(git -C "$ECOMMERCE_STORE_DIR" status --porcelain)" ] && echo 1 || echo 0)" \
		"$("$CLI" info --format json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s);console.log(JSON.stringify({cpus:i.host.cpus,memTotal:i.host.memTotal,kernel:i.host.kernel,arch:i.host.arch,os:i.host.os,distribution:i.host.distribution,podman:i.version.Version,cgroups:i.host.cgroupVersion,runtime:i.host.ociRuntime?.name}))})')"
	echo "$file"
}

post_run_stats() {
	local target="$1" stamp="$2"
	local file="$RAW/post-$target-$stamp.json"
	if [ "$target" = fpr ]; then
		{
			echo '{"meta":'; curl -s "http://localhost:$(port_of fpr)/__meta"
			echo ',"redisCacheCounters":'; "$CLI" exec "$(ctr redis)" redis-cli --json HGETALL stats:cache
			echo ',"redisInfo":'; "$CLI" exec "$(ctr redis)" redis-cli INFO | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o={};for(const l of s.split(/\r?\n/)){const m=/^([a-z_0-9]+):(.*)$/.exec(l);if(m)o[m[1]]=m[2]}console.log(JSON.stringify(o))})'
			echo ',"pgStatements":'; "$CLI" exec "$(ctr postgres)" psql -U store -d store -At -c "SELECT coalesce(json_agg(t),'[]') FROM (SELECT left(regexp_replace(query, '\s+', ' ', 'g'), 120) AS query, calls, round(mean_exec_time::numeric, 4) AS mean_ms, round(total_exec_time::numeric, 1) AS total_ms, rows, shared_blks_hit, shared_blks_read FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 15) t"
			echo ',"pgTables":'; "$CLI" exec "$(ctr postgres)" psql -U store -d store -At -c "SELECT json_agg(t) FROM (SELECT relname, seq_scan, seq_tup_read, idx_scan, n_tup_upd, n_tup_hot_upd, n_dead_tup FROM pg_stat_user_tables ORDER BY relname) t"
			echo '}'
		} > "$file"
	else
		echo '{}' > "$file"
	fi
	echo "$file"
}

bench() {
	local target="$1" other stamp
	other=$([ "$target" = fpr ] && echo harper || echo fpr)
	stop_target "$other"
	for trial in $(seq 1 "${TRIALS:-1}"); do
		stamp="$(date -u +%Y%m%dT%H%M%SZ)"
		say "trial $trial/$TRIALS for $target (budget: $([ "$target" = fpr ] && echo "$BUDGET" || echo 'single container'))"
		restore "$target"
		wait_for_idle
		"$HERE/scripts/host-load.sh" "$RAW/host-$target-$stamp.txt" & local host_sampler=$!
		cold_start "$target"
		if [ "$target" = fpr ]; then
			"$CLI" exec "$(ctr postgres)" psql -U store -d store -qAt -c "SELECT pg_stat_statements_reset()" -c "SELECT pg_stat_reset()" >/dev/null
		fi
		local cgroups="{" sep=""
		for s in $(services_of "$target"); do cgroups="$cgroups$sep\"$s\":\"$("$CLI" inspect --format '{{.State.CgroupPath}}' "$(ctr "$s")")\""; sep=","; done
		cgroups="$cgroups}"
		local budget_cgroup=""
		if [ "$target" = fpr ] && [ "$BUDGET" = shared ]; then budget_cgroup="/machine.slice/$BUDGET_CGROUP_PARENT"; fi
		local conditions; conditions="$(conditions_json "$target" "$stamp")"
		# The harness accounts the target's CPU itself from these cgroups (one per container).
		local target_cgroups="" sep2=""
		for s in $(services_of "$target"); do target_cgroups="$target_cgroups$sep2$s=$("$CLI" inspect --format '{{.Id}}' "$(ctr "$s")")"; sep2=","; done
		compose run --rm -e TARGET="$target" -e CGROUPS="$cgroups" -e BUDGET_CGROUP="$budget_cgroup" \
			-e CODE_COMMIT="$(git -C "$ECOMMERCE_STORE_DIR" rev-parse HEAD)" -e CODE_DIRTY="$([ -n "$(git -C "$ECOMMERCE_STORE_DIR" status --porcelain)" ] && echo 1 || echo 0)" \
			-e CONDITIONS="/results/$(basename "$conditions")" -e RUN_CONDITIONS="$(cat "$conditions")" bench -- \
			--url "$(url_in_network "$target")" --dataset "/work/dataset/$SCALE" --target-cgroups "$target_cgroups" \
			--rates "${RATES:-100,200,400,600,800,1000,1200}" --duration "${DURATION:-15}" --warmup "${WARMUP:-10}" \
			--out /results --cold-ms "$COLD_MS" | tee "$RAW/console-$target-$stamp.txt"
		kill "$host_sampler" 2>/dev/null || true
		post_run_stats "$target" "$stamp" >/dev/null
		# The reference's run-level checks (DATA-004 is expected to fail on dev; --dev says so).
		local record; record="$(grep -oE 'run-[0-9TZ-]+\.json' "$RAW/console-$target-$stamp.txt" | tail -1)"
		(cd "$ECOMMERCE_STORE_DIR" && node scripts/verify-run-record.mjs --dev "$RAW/$record") > "$RAW/verify-$target-$stamp.txt" 2>&1 \
			&& say "run record verified" || say "run record verification FAILED: $RAW/verify-$target-$stamp.txt"
		if [ "$target" = fpr ]; then audit | tee -a "$RAW/console-$target-$stamp.txt"; fi
	done
}

conformance() {
	local target="$1" stamp out
	stamp="$(date -u +%Y%m%dT%H%M%SZ)"
	out="$HERE/results/conformance-$target.json"
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
		--dataset "$DATASET_DIR" --out "$HERE/results/diff-reference.json"
	stop_target harper
}

# The reference's stack-neutral coherence check: concurrent readers and price writers, then
# every view must carry the last price written within FRESH_MS. Mutates prices: restores after.
coherence() {
	local target="$1"
	local out="$HERE/results/coherence-$target.txt"
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
	node "$HERE/scripts/audit-coherence.mjs" --url "http://localhost:$(port_of fpr)" --dataset "$DATASET_DIR"
}

cmd="${1:-}"; shift || true
case "$cmd" in
	setup) setup ;;
	load) setup; load "${1:?target}" ;;
	conformance) setup; conformance "${1:?target}" ;;
	diff) setup; diff_reference ;;
	bench) setup; TRIALS="${TRIALS:-1}"; bench "${1:?target}" ;;
	audit) setup; audit ;;
	coherence) setup; coherence "${1:?target}" ;;
	stop) setup; stop_target fpr; stop_target harper ;;
	*) sed -n '2,20p' "$0"; exit 1 ;;
esac
