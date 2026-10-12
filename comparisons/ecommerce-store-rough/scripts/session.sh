#!/usr/bin/env bash
# One measurement session: every target, alternating, same ladder, same machine, back to back
# ("measure every target in one session"). Each trial restores its target's snapshot first.
#
# A trial in which any step saw another container on the machine busy (the wrapper's
# `contended` flag) is kept on disk but marked and re-run, up to MAX_ATTEMPTS times; the report
# uses uncontended trials only and says how many were discarded.
#
#   SESSION_TRIALS=3 SPLIT_TRIALS=2 scripts/session.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export RATES="${RATES:-400,800,1200,1600,2000,2400,3200,4000,4800,5600,6400,8000}"
export DURATION="${DURATION:-15}" WARMUP="${WARMUP:-10}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
log="results/raw/session-$stamp.log"
echo "session $stamp rates=$RATES duration=$DURATION warmup=$WARMUP" | tee "$log"

trial() { # <target> <budget>
	local target="$1" budget="$2" attempt summary
	for attempt in $(seq 1 "${MAX_ATTEMPTS:-3}"); do
		BUDGET="$budget" TRIALS=1 scripts/run.sh bench "$target" 2>&1 | tee -a "$log"
		summary="$(ls -t results/raw/summary-"$target"-*.json | head -1)"
		if node -e 'process.exit(require(process.argv[1]).steps.some((s) => s.cpu?.contended) ? 1 : 0)' "$PWD/$summary"; then
			return 0
		fi
		echo "CONTENDED trial (another container was busy): $(basename "$summary"); re-running" | tee -a "$log"
	done
	echo "giving up after ${MAX_ATTEMPTS:-3} contended attempts for $target" | tee -a "$log"
}

for t in $(seq 1 "${SESSION_TRIALS:-3}"); do
	trial fpr shared
	trial harper shared # BUDGET is ignored for the single-container reference
done
for t in $(seq 1 "${SPLIT_TRIALS:-0}"); do
	trial fpr split
done
scripts/run.sh stop >/dev/null 2>&1 || true
echo "session $stamp done" | tee -a "$log"
