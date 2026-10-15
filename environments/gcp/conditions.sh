#!/usr/bin/env bash
# conditions.sh — snapshot the host-side run conditions for a tier-2 session or trial.
#
# Ran 2026-10-14 on c4-standard-16-lssd (README "Qualification").
#
#   sudo bash conditions.sh OUT_DIR [REPO_DIR...]
#
# Run at session start and again after each trial (container state and image digests change).
# Raw command output, one file per item, so nothing is lost to a schema decided too early. The
# instance's GCP-side settings (turbo mode, threads per core, PMU) are not visible from inside
# the guest; capture those from the operator side with `vm.sh describe`.
set -uo pipefail

OUT="${1:?usage: conditions.sh OUT_DIR [REPO_DIR...]}"; shift
mkdir -p "$OUT"
x() { local name="$1"; shift; { echo "\$ $*"; "$@"; } > "$OUT/$name.txt" 2>&1; }

date -u +%FT%TZ > "$OUT/captured-at.txt"
# Instance metadata without attributes (ssh keys), guest attributes (host keys), credentials,
# service accounts, or addresses. Empty on a 2026-10 C4 VM, but this record is published.
curl -sf -H 'Metadata-Flavor: Google' 'http://metadata.google.internal/computeMetadata/v1/instance/?recursive=true' \
	| jq 'del(.attributes, .guestAttributes, .credentials, .gceWorkloadCertificates, .partnerAttributes, .serviceAccounts, .networkInterfaces)' \
	> "$OUT/gce-instance.json"

x os            cat /etc/os-release
x kernel        uname -a
x cmdline       cat /proc/cmdline
x lscpu         lscpu
x lscpu-e       lscpu -e
x numa          numactl -H
x clocksource   cat /sys/devices/system/clocksource/clocksource0/current_clocksource
x cpufreq       sh -c 'grep -s . /sys/devices/system/cpu/cpu*/cpufreq/scaling_* /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_* /sys/devices/system/cpu/intel_pstate/*'
x memory        sh -c 'free -m; swapon --show'
x thp           sh -c 'grep . /sys/kernel/mm/transparent_hugepage/enabled /sys/kernel/mm/transparent_hugepage/defrag'
x sysctl        sysctl -a
x disks         sh -c 'lsblk -o NAME,SIZE,TYPE,MODEL,ROTA,SCHED,FSTYPE,MOUNTPOINT; findmnt /mnt/lssd; cat /proc/mdstat'
x docker        sh -c 'docker version; docker info; docker compose version'
x perf          perf --version
x node          node --version
x slices        systemctl show bench.slice bench-target.slice bench-generator.slice system.slice user.slice init.scope \
	-p Id,AllowedCPUs,MemoryMax,MemorySwapMax,CPUQuotaPerSecUSec
x cgroups       sh -c 'for d in /sys/fs/cgroup/bench.slice /sys/fs/cgroup/bench.slice/*/; do echo "$d cpus=$(cat $d/cpuset.cpus.effective) mems=$(cat $d/cpuset.mems.effective) memory.max=$(cat $d/memory.max) swap.max=$(cat $d/memory.swap.max 2>/dev/null)"; done'
x workqueue     cat /sys/devices/virtual/workqueue/cpumask
x interrupts    cat /proc/interrupts
x images        docker image ls --digests --no-trunc
x networks      sh -c 'docker network inspect $(docker network ls -q)'
# Containers that exist now: their cgroup parent, CPU and memory limits, network mode, image digest.
ids="$(docker ps -aq)"
[ -n "$ids" ] && x containers docker inspect $ids

for repo in "$@"; do
	name="repo-$(basename "$repo")"
	# Run as root on the login user's checkout: git refuses that ("dubious ownership") unless told
	# the directory is safe. Command-line config reaches git-lfs's own git calls too.
	x "$name" sh -c "cd '$repo' && g() { git -c safe.directory='*' \"\$@\"; } && g remote get-url origin && g rev-parse HEAD && g status --porcelain && g lfs ls-files -l"
	for m in "$repo"/dataset/*/MANIFEST.json; do
		[ -f "$m" ] && sha256sum "$m" >> "$OUT/dataset-manifests.txt"
	done
done
echo "conditions: $OUT"
