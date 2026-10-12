#!/usr/bin/env bash
# Sample the macOS HOST while a trial runs. The podman VM's vCPUs are host threads scheduled on a
# mix of performance and efficiency cores; anything else busy on the host (another agent's job, a
# video call) slows the VM in ways no in-VM counter shows. One line every ~5 s:
#   epoch  host-busy-cores  non-VM-busy-cores  top non-VM processes
# where non-VM excludes the VM's own processes (krunkit, gvproxy) and this sampler.
#   scripts/host-load.sh <out-file>   (runs until killed)
set -u
out="$1"
cores=$(sysctl -n hw.ncpu)
parent=$PPID
while kill -0 "$parent" 2>/dev/null; do
	top -l 2 -s 1 -o cpu -n 25 -stats cpu,command 2>/dev/null | awk -v t="$(date +%s)" -v cores="$cores" '
		/^CPU usage/ { n++; if (n == 2) { idle = $(NF-1); sub(/%/, "", idle); busy = (100 - idle) / 100 * cores } next }
		n == 2 && $1 ~ /^[0-9.]+$/ {
			cmd = $2; for (i = 3; i <= NF; i++) cmd = cmd " " $i
			if (cmd ~ /^(krunkit|gvproxy|top)$/) next
			other += $1 / 100
			if ($1 >= 20) list = list (list ? "," : "") cmd "=" $1 "%"
		}
		END { printf "%s %.2f %.2f %s\n", t, busy, other, list }'
	sleep 3
done >> "$out"
