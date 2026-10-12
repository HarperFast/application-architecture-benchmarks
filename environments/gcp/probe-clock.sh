#!/usr/bin/env bash
# probe-clock.sh — qualify an instance type: can it count cycles, and does its clock hold?
#
# UNEXECUTED. Written 2026-10-12 before any tier-2 host existed.
#
#   sudo bash probe-clock.sh [OUT_DIR] [SECONDS]
#
# Run once per machine type (and again whenever Google changes the platform), after
# host-setup.sh. It saturates the target CPUs alone, then every CPU, and reports the effective
# frequency (counted cycles / busy time) per CPU per second. Keep the output: it is the
# evidence behind "bounded and measured" for every result produced on this instance type.
#
# What a pass looks like (README "The clock"): cycles are countable, the spread across all
# intervals is within the drift threshold, and the target-only and all-busy medians agree.
# On C4 with ALL_CORE_MAX on Granite Rapids, Google's documented all-core turbo is 3.9 GHz.
set -euo pipefail

OUT="${1:-/mnt/lssd/out/probe-$(date -u +%Y%m%dT%H%M%SZ)}"
SECS="${2:-60}"
TARGET_CPUS="$(cat /sys/fs/cgroup/bench.slice/bench-target.slice/cpuset.cpus.effective)"
GENERATOR_CPUS="$(cat /sys/fs/cgroup/bench.slice/bench-generator.slice/cpuset.cpus.effective)"
FAIL=()
count() { awk -F, '{for(i=1;i<=NF;i++){split($i,r,"-"); n+=(r[2]==""?1:r[2]-r[1]+1)}} END{print n}' <<<"$1"; }
mkdir -p "$OUT"

{
	echo "== platform"
	lscpu | grep -E 'Model name|^CPU\(s\)|Thread|Core|Socket|NUMA|Hypervisor'
	curl -sf -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/cpu-platform && echo
	echo "== PMU as the kernel sees it"
	dmesg | grep -iE 'Performance Events|PMU' | head -5 || echo "(no PMU lines in dmesg)"
	echo "== cpufreq (absent on a VM; on bare metal, this is what pinning would use)"
	ls /sys/devices/system/cpu/cpu0/cpufreq 2>/dev/null || echo "absent"
	echo "== guest-reported MHz (NOT the clock: a fixed compatibility value on C4)"
	grep -m1 'cpu MHz' /proc/cpuinfo
} | tee "$OUT/platform.txt"

# One busy worker per CPU in a slice. Runs inside the slice, so it also proves the slice's
# cpuset holds: Cpus_allowed_list of a worker must equal the slice's CPUs.
burn() { # burn <slice> <cpus>
	systemd-run --quiet --scope --slice="$1" stress-ng --cpu "$(count "$2")" --cpu-method int64 --timeout "${SECS}s" >/dev/null &
}
load_target_only() { burn bench-target.slice "$TARGET_CPUS"; }
load_all() { burn bench-target.slice "$TARGET_CPUS"; burn bench-generator.slice "$GENERATOR_CPUS"; burn user.slice "$(cat /sys/fs/cgroup/user.slice/cpuset.cpus.effective)"; }

probe() { # probe <name> <load function>: start the load, count cycles on the target CPUs only
	"$2"
	sleep 2
	local pid allowed=""
	for pid in $(pgrep stress-ng); do
		grep -q bench-target.slice "/proc/$pid/cgroup" 2>/dev/null || continue
		allowed="$(awk '/Cpus_allowed_list/{print $2}' "/proc/$pid/status")"; break
	done
	echo "$1: target worker allowed CPUs $allowed (slice: $TARGET_CPUS)"
	[ "$allowed" = "$TARGET_CPUS" ] || FAIL+=("$1: target worker allowed on $allowed, slice says $TARGET_CPUS")
	perf stat -x, -I 1000 -A -C "$TARGET_CPUS" -e cycles,cpu-clock -o "$OUT/$1.csv" -- sleep "$((SECS - 5))"
	wait
}

probe target-only load_target_only
probe all-busy load_all

# The same cycles counted per cgroup, the way sample.sh counts them during a run. Must be
# non-zero and agree with the per-CPU figures above, or the PMU does not virtualize cgroup mode.
echo "== cgroup-mode counting check"
SECS=12 load_target_only
perf stat -a -e cycles,task-clock --for-each-cgroup bench.slice/bench-target.slice -- sleep 8 2>&1 | tee "$OUT/cgroup-mode.txt"
wait
grep -qE 'not counted|not supported' "$OUT/cgroup-mode.txt" && FAIL+=("cgroup-mode cycles not counted")

# mawk (Debian's default awk) has no asort, so the sort is sort(1).
summarize() { # summarize <csv>: effective GHz = counted cycles / busy time, per CPU per second
	awk -F, '
		/^#/ || NF < 5 || $3 !~ /^[0-9.]+$/ { next }
		$5 ~ /cycles/    { cyc[$1 FS $2] = $3 }
		$5 ~ /cpu-clock/ { ms[$1 FS $2] = $3 }
		END { for (k in cyc) if (ms[k] > 0) printf "%.4f\n", cyc[k] / (ms[k] * 1e6) }' "$1" \
	| sort -n | awk -v name="$(basename "$1" .csv)" '
		{ g[++n] = $1 }
		END {
			if (!n) { printf "%-12s no countable cycles: PMU not enabled or not virtualized\n", name; exit }
			m = g[int((n + 1) / 2)]
			printf "%-12s n=%d  min=%.3f  p50=%.3f  max=%.3f GHz  spread=%.1f%% of median\n", name, n, g[1], m, g[n], 100 * (g[n] - g[1]) / m
		}'
}
echo "== effective GHz on target CPUs ($TARGET_CPUS)"
{ summarize "$OUT/target-only.csv"; summarize "$OUT/all-busy.csv"; } | tee "$OUT/summary.txt"
grep -q 'no countable cycles' "$OUT/summary.txt" && FAIL+=("per-CPU cycles not counted")
echo "probe output: $OUT"
# Pass/fail covers only what can fail mechanically. Whether the spread is small enough is
# judged against the drift threshold, by a person, the first time a machine type is used.
if [ "${#FAIL[@]}" -gt 0 ]; then printf 'PROBE FAILED: %s\n' "${FAIL[@]}" | tee -a "$OUT/summary.txt"; exit 1; fi
echo "probe passed: cycles countable per CPU and per cgroup; slices hold" | tee -a "$OUT/summary.txt"
