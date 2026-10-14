#!/usr/bin/env bash
# host-setup.sh — turn a fresh Debian 13 tier-2 VM into a measurement host. Run as root, once.
#
# UNEXECUTED. Written 2026-10-12 before any tier-2 host existed. Every step prints what it
# did; read the output, and fix this file when reality disagrees with it.
#
#   sudo bash host-setup.sh
#
# What it sets up (README "Host"):
#   - Local SSD as an ext4 filesystem at /mnt/lssd holding Docker's data root. Never tmpfs.
#   - Docker Engine + Compose from Docker's signed apt repository, systemd cgroup driver, cgroup v2.
#   - CPU partition: housekeeping | target | generator, as systemd slices. Containers join a
#     slice through compose `cgroup_parent`, so a multi-container stack shares ONE budget.
#   - Unbound kernel work and movable IRQs on housekeeping CPUs; periodic jobs disabled.
#   - perf (PMU cycle counting), Node for host-side scripts, git + git-lfs.
set -euo pipefail

HOUSEKEEPING_CPUS="${HOUSEKEEPING_CPUS:-0-1}"
TARGET_CPUS="${TARGET_CPUS:-2-3}"           # the 2-CPU budget, shared by every process of a target
GENERATOR_CPUS="${GENERATOR_CPUS:-4-7}"     # outside the budget, with headroom
TARGET_MEMORY="${TARGET_MEMORY:-2G}"        # the 2 GiB budget, page cache included (cgroup v2)
GENERATOR_MEMORY="${GENERATOR_MEMORY:-4G}"
NODE_VERSION="${NODE_VERSION:-24.21.0}"     # host-side scripts only; containers pin their own
DATA=/mnt/lssd
LOGIN_USER="${SUDO_USER:-}"

say() { printf '\n==> %s\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }
cpus() { local r c; for r in ${1//,/ }; do for ((c = ${r%-*}; c <= ${r#*-}; c++)); do echo "$c"; done; done; }   # "0-1,4" -> 0 1 4
[ "$(id -u)" = 0 ] || die "run as root"

say "sanity"
[ "$(stat -fc %T /sys/fs/cgroup)" = cgroup2fs ] || die "cgroup v2 is required"
NCPU="$(nproc --all)"
[ "$NCPU" -ge 8 ] || die "$NCPU CPUs visible; the default layout needs 8 (0-1 housekeeping, 2-3 target, 4-7 generator)"
echo "cpus=$NCPU  online=$(cat /sys/devices/system/cpu/online)  kernel=$(uname -r)  arch=$(uname -m)"
# Expected on a VM: absent, because the guest has no P-state control. On bare metal, present
# or not, this decides whether the clock can be pinned at all (README "The clock").
echo "cpufreq: $(ls /sys/devices/system/cpu/cpu0/cpufreq 2>/dev/null | tr '\n' ' ')"

say "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git git-lfs jq tmux zstd xz-utils \
	linux-perf sysstat numactl stress-ng
# mdadm recommends a mail transport agent, which would add a resident daemon.
apt-get install -y --no-install-recommends mdadm
perf --version

say "local SSD -> ${DATA}"
if ! mountpoint -q "$DATA"; then
	SSDS=()
	for d in /dev/disk/by-id/google-local-nvme-ssd-*; do
		[ -e "$d" ] && [[ "$d" != *-part* ]] && SSDS+=("$d")
	done
	[ "${#SSDS[@]}" -gt 0 ] || die "no local SSD found; use an -lssd machine type (README 'Instance')"
	if [ "${#SSDS[@]}" -gt 1 ]; then
		mdadm --create /dev/md0 --level=0 --raid-devices="${#SSDS[@]}" "${SSDS[@]}" --run
		DEV=/dev/md0
	else
		DEV="${SSDS[0]}"
	fi
	mkfs.ext4 -F -m 0 "$DEV"
	mkdir -p "$DATA"
	mount -o defaults,noatime "$DEV" "$DATA"
fi
findmnt "$DATA"
# Checkouts and session output belong to the login user, so clones and results need no sudo.
mkdir -p "$DATA/src" "$DATA/out"
[ -n "$LOGIN_USER" ] && chown "$LOGIN_USER:" "$DATA/src" "$DATA/out"

say "docker engine (download.docker.com, signed)"
install -m 0755 -d /etc/apt/keyrings /etc/docker
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
	> /etc/apt/sources.list.d/docker.list
# Before the daemon first starts, so nothing lands on the boot disk.
cat > /etc/docker/daemon.json <<JSON
{
  "data-root": "${DATA}/docker",
  "exec-opts": ["native.cgroupdriver=systemd"],
  "log-driver": "local"
}
JSON
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
[ -n "$LOGIN_USER" ] && usermod -aG docker "$LOGIN_USER"
docker info --format 'docker {{.ServerVersion}} cgroup {{.CgroupVersion}}/{{.CgroupDriver}} root {{.DockerRootDir}}'

say "node ${NODE_VERSION} for host-side scripts (checksum-verified)"
case "$(uname -m)" in x86_64) NARCH=x64 ;; aarch64) NARCH=arm64 ;; *) die "arch $(uname -m)" ;; esac
TARBALL="node-v${NODE_VERSION}-linux-${NARCH}.tar.xz"
TMP="$(mktemp -d)"
curl -fsSL -o "$TMP/$TARBALL" "https://nodejs.org/dist/v${NODE_VERSION}/${TARBALL}"
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " ${TARBALL}\$" | (cd "$TMP" && sha256sum -c -)
tar -C /usr/local --strip-components=1 -xJf "$TMP/$TARBALL"
rm -rf "$TMP"
node --version

say "CPU partition: housekeeping ${HOUSEKEEPING_CPUS} | target ${TARGET_CPUS} | generator ${GENERATOR_CPUS}"
# Everything the OS runs (dockerd, containerd, sshd, journald, guest agent, the sampler) stays
# on housekeeping CPUs. set-property persists under /etc/systemd/system.control.
for unit in system.slice user.slice init.scope; do
	systemctl set-property "$unit" AllowedCPUs="$HOUSEKEEPING_CPUS" || echo "WARN: could not confine $unit"
done
# Hierarchy is encoded by dashes: bench-target.slice lives at /sys/fs/cgroup/bench.slice/bench-target.slice.
cat > /etc/systemd/system/bench.slice <<UNIT
[Slice]
AllowedCPUs=${TARGET_CPUS},${GENERATOR_CPUS}
UNIT
cat > /etc/systemd/system/bench-target.slice <<UNIT
[Unit]
Description=Benchmark target: the whole stack under test shares this budget
[Slice]
AllowedCPUs=${TARGET_CPUS}
MemoryMax=${TARGET_MEMORY}
MemorySwapMax=0
CPUAccounting=yes
MemoryAccounting=yes
IOAccounting=yes
UNIT
cat > /etc/systemd/system/bench-generator.slice <<UNIT
[Unit]
Description=Load generator, outside the target budget
[Slice]
AllowedCPUs=${GENERATOR_CPUS}
MemoryMax=${GENERATOR_MEMORY}
MemorySwapMax=0
CPUAccounting=yes
MemoryAccounting=yes
UNIT
systemctl daemon-reload
systemctl start bench-target.slice bench-generator.slice
for s in bench.slice/bench-target.slice bench.slice/bench-generator.slice; do
	echo "$s cpus=$(cat /sys/fs/cgroup/$s/cpuset.cpus.effective) mem.max=$(cat /sys/fs/cgroup/$s/memory.max)"
done

say "kernel housekeeping off the measured CPUs"
# Unbound workqueues (writeback and friends) run where this mask allows. It takes a hex mask, not a CPU list (0-1 is 3).
mask=0; for c in $(cpus "$HOUSEKEEPING_CPUS"); do mask=$((mask | 1 << c)); done
printf '%x\n' "$mask" > /sys/devices/virtual/workqueue/cpumask || echo "workqueue cpumask not settable"
echo "workqueue cpumask=$(cat /sys/devices/virtual/workqueue/cpumask)"
systemctl disable --now irqbalance 2>/dev/null || true
for irq in /proc/irq/[0-9]*; do
	# Managed IRQs (NVMe queues) refuse this; they are spread per CPU by design. Recorded, not hidden.
	echo "$HOUSEKEEPING_CPUS" > "$irq/smp_affinity_list" 2>/dev/null || true
done
# effective_affinity_list is where an IRQ is delivered now, usually a single CPU of the allowed set.
echo "IRQs delivered outside housekeeping CPUs ${HOUSEKEEPING_CPUS} (managed or unmovable):"
hk=" $(cpus "$HOUSEKEEPING_CPUS" | tr '\n' ' ')"
for irq in /proc/irq/[0-9]*; do
	eff="$(cat "$irq/effective_affinity_list" 2>/dev/null)" || continue
	for c in $(cpus "$eff"); do
		[[ "$hk" == *" $c "* ]] && continue
		printf '  irq %s on %s: %s\n' "${irq##*/}" "$eff" "$(find "$irq" -mindepth 1 -maxdepth 1 -type d -printf '%f ')"
		break
	done
done
# The hard-lockup detector holds a PMU counter on every CPU; perf needs them all for cycle counting.
echo 'kernel.nmi_watchdog = 0' > /etc/sysctl.d/90-arch-bench.conf
sysctl -q -p /etc/sysctl.d/90-arch-bench.conf || echo "WARN: nmi_watchdog not settable"
echo "nmi_watchdog=$(cat /proc/sys/kernel/nmi_watchdog)"
# Periodic jobs that would otherwise wake up mid-trial. One at a time: systemctl stops at a missing unit.
for unit in apt-daily.timer apt-daily-upgrade.timer man-db.timer e2scrub_all.timer fstrim.timer \
	sysstat-collect.timer sysstat-summary.timer unattended-upgrades.service; do
	systemctl disable --now "$unit" 2>/dev/null && echo "disabled $unit" || true
done

say "swap and THP (recorded; distro defaults kept unless a target's documentation requires otherwise)"
swapon --show || true
echo "THP enabled=$(cat /sys/kernel/mm/transparent_hugepage/enabled) defrag=$(cat /sys/kernel/mm/transparent_hugepage/defrag)"

mkdir -p /var/lib/arch-bench
date -u +%FT%TZ > /var/lib/arch-bench/host-setup.done
say "done. Log out and back in for docker group membership, then run probe-clock.sh."
