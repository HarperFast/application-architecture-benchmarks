#!/usr/bin/env bash
# One measurement session: every target, alternating, same ladder, same machine, back to back
# ("measure every target in one session"). Each trial restores its target's snapshot first.
#
#   SESSION_TRIALS=3 SPLIT_TRIALS=2 scripts/session.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export RATES="${RATES:-400,800,1200,1600,2000,2400,3200,4000,4800,5600,6400}"
export DURATION="${DURATION:-15}" WARMUP="${WARMUP:-10}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
log="results/raw/session-$stamp.log"
echo "session $stamp rates=$RATES duration=$DURATION warmup=$WARMUP" | tee "$log"
for trial in $(seq 1 "${SESSION_TRIALS:-3}"); do
	BUDGET=shared TRIALS=1 scripts/run.sh bench fpr 2>&1 | tee -a "$log"
	TRIALS=1 scripts/run.sh bench harper 2>&1 | tee -a "$log"
done
for trial in $(seq 1 "${SPLIT_TRIALS:-0}"); do
	BUDGET=split TRIALS=1 scripts/run.sh bench fpr 2>&1 | tee -a "$log"
done
scripts/run.sh stop >/dev/null 2>&1 || true
echo "session $stamp done" | tee -a "$log"
