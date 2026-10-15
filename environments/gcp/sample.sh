#!/usr/bin/env bash
# sample.sh — host-side recorder for a tier-2 session: cycles, CPU, memory, steal, maintenance.
#
# Ran 2026-10-14 on c4-standard-16-lssd (README "Qualification").
#
#   sudo systemd-run --collect --unit=arch-bench-sampler bash sample.sh /mnt/lssd/out/<session>/samples
#   ...run trials...
#   sudo systemctl stop arch-bench-sampler
#
# Runs as a system service, so it stays on the housekeeping CPUs. Every row carries a wall-clock
# epoch in milliseconds; per-step figures come from joining these rows to each step's start and
# end time in the run record (ecommerce-store's bench/cycles.mjs does this for perf.csv).
#
# Output:
#   perf.csv          cycles, instructions, task-clock per 250 ms for each bench slice
#                     (perf -I time is seconds since perf.start-epoch-ms)
#   cgroups.csv       epoch_ms,cgroup,usage_usec,user_usec,system_usec,nr_throttled,throttled_usec,memory_current,oom_kill
#   host.csv          epoch_ms,user,nice,system,idle,iowait,irq,softirq,steal  (/proc/stat jiffies, all CPUs)
#   containers.csv    epoch_ms,scope,name,image  (first sighting of each container scope)
#   maintenance.log   epoch_ms,value  (GCE maintenance-event; anything but NONE during a trial voids it)
#
# Per-target cycles are counted at slice level: every process of the target, summed. A
# component's share inside a multi-container target is its usage_usec share of the slice; all
# of them run on the same CPUs at the same clock, which is what makes that split sound.
set -euo pipefail

OUT="${1:?usage: sample.sh OUT_DIR}"
SLICES="bench.slice/bench-target.slice,bench.slice/bench-generator.slice"
CG=/sys/fs/cgroup
MD=http://metadata.google.internal/computeMetadata/v1/instance/maintenance-event
mkdir -p "$OUT"
ms() { date +%s%3N; }

ms > "$OUT/perf.start-epoch-ms"
# 250 ms intervals: a step boundary falls inside an interval, and at 15 s steps a 1 s interval
# would misattribute up to ~7% of a step's cycles. cpu.stat below is cumulative, so it can be
# interpolated at a boundary and needs no finer sampling.
perf stat -a -x, -I 250 -e cycles,instructions,task-clock --for-each-cgroup "$SLICES" -o "$OUT/perf.csv" &
PERF=$!
# `systemctl stop` signals perf too, so it may be gone already: under set -e a failing kill
# would end the trap with status 1 and mark the unit failed.
trap 'kill "$PERF" 2>/dev/null || true; wait "$PERF" 2>/dev/null || true; exit 0' INT TERM EXIT

echo "epoch_ms,cgroup,usage_usec,user_usec,system_usec,nr_throttled,throttled_usec,memory_current,oom_kill" > "$OUT/cgroups.csv"
echo "epoch_ms,user,nice,system,idle,iowait,irq,softirq,steal" > "$OUT/host.csv"
echo "epoch_ms,scope,name,image" > "$OUT/containers.csv"
declare -A seen=()
last_md=""
tick=0

while :; do
	now="$(ms)"
	# Every cgroup under the bench slices: the slices themselves and each container scope.
	while IFS= read -r dir; do
		rel="${dir#"$CG"/}"
		cpu="$(awk '{v[$1]=$2} END{printf "%s,%s,%s,%s,%s", v["usage_usec"], v["user_usec"], v["system_usec"], v["nr_throttled"], v["throttled_usec"]}' "$dir/cpu.stat" 2>/dev/null)" || continue
		mem="$(cat "$dir/memory.current" 2>/dev/null || echo)"
		oom="$(awk '$1=="oom_kill"{print $2}' "$dir/memory.events" 2>/dev/null || echo)"
		echo "$now,$rel,$cpu,$mem,$oom"
		case "$rel" in
			*/docker-*.scope)
				if [ -z "${seen[$rel]:-}" ]; then
					seen[$rel]=1
					id="${rel##*/docker-}"; id="${id%.scope}"
					docker inspect --format "$now,$rel,{{.Name}},{{.Config.Image}}" "$id" >> "$OUT/containers.csv" 2>/dev/null || true
				fi ;;
		esac
	done < <(find "$CG/bench.slice" -name cpu.stat -printf '%h\n' 2>/dev/null) >> "$OUT/cgroups.csv"

	awk -v t="$now" '$1=="cpu"{print t","$2","$3","$4","$5","$6","$7","$8","$9}' /proc/stat >> "$OUT/host.csv"

	# Live migration or pending maintenance: poll every 5 s, log changes only.
	if [ $((tick % 5)) -eq 0 ]; then
		md="$(curl -sf -m 2 -H 'Metadata-Flavor: Google' "$MD" || echo UNKNOWN)"
		[ "$md" = "$last_md" ] || { echo "$now,$md" >> "$OUT/maintenance.log"; last_md="$md"; }
	fi
	tick=$((tick + 1))
	sleep 1
done
