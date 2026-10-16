#!/usr/bin/env bash
# One measurement session: every target, interleaved, same ladder, same machine, back to back
# ("measure every target in one session"). Rounds alternate the order (A B, B A, A B, ...), so
# drift over the session lands on every target. Every trial restores its target's snapshot, drops
# the page cache, and cold-starts the target (scripts/run.sh bench).
#
# A trial is re-run, up to MAX_ATTEMPTS times, when it fails any of: verify-run-record, the cycle
# join (tier 2), a host maintenance event (tier 2), a page-cache drop that left the target slice
# full (tier 2), or another container competing for the target's CPUs during a step. The failed attempt is kept on disk and listed in the session log;
# scripts/report.mjs uses the passing attempts and says how many were set aside.
#
#   TIER=1: SESSION_TRIALS=3 SPLIT_TRIALS=0 scripts/session.sh                      (dev only)
#   TIER=2: TIER=2 SCALE=bench SAMPLE_SH=~/sample.sh CONDITIONS_SH=~/conditions.sh scripts/session.sh
#
#   TARGETS          space-separated, in round-one order (default "harper fpr"; add
#                    harper-unbatched for the quote-batching A/B)
#   SESSION_TRIALS   rounds (3)
#   MAX_ATTEMPTS     attempts per trial, re-runs included (3)
#   SESSION_MINUTES  stop starting trials once fewer than TRIAL_MINUTES remain of this many
#                    minutes from the session's start (unset: no limit). On tier 2, the time left
#                    before the VM's self-delete, less collection and teardown.
#   TRIAL_MINUTES    the longest a trial is expected to take (bench 35, dev 3)
#   SPLIT_TRIALS     tier 1 only: extra fpr trials with per-container CPU quotas (0)
#   RATES DURATION   default per scale; see below. WARMUP is the harness's, fixed per scale.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export TIER="${TIER:-1}" SCALE="${SCALE:-dev}"
if [ "$SCALE" = bench ]; then
	# A geometric ladder: neither target's bench capacity is known yet, and the reference's falls
	# an order of magnitude below its dev capacity. 60 s steps (ecommerce-store PUBLISHED_RUN).
	export RATES="${RATES:-25,50,100,200,400,800,1600}" DURATION="${DURATION:-60}"
else
	export RATES="${RATES:-400,800,1200,1600,2000,2400,3200,4000,4800,5600,6400,8000}" DURATION="${DURATION:-15}"
fi
TARGETS="${TARGETS:-harper fpr}"
TRIAL_MINUTES="${TRIAL_MINUTES:-$([ "$SCALE" = bench ] && echo 35 || echo 3)}"
started="$(date +%s)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p results/raw
log="results/raw/session-$stamp.log"
echo "session $stamp tier=$TIER scale=$SCALE targets=[$TARGETS] rates=$RATES duration=$DURATION quoteShare=${QUOTE_SHARE:-0.5} writeRate=${WRITE_RATE:-20} benchArgs=${BENCH_ARGS:-}" | tee "$log"

# Build every target first, so no trial pays for a build and every trial of a target runs the
# same image.
for target in $TARGETS; do scripts/run.sh build "$target" 2>&1 | tail -2 | tee -a "$log"; done

# True while another trial fits in SESSION_MINUTES.
time_left() {
	[ -z "${SESSION_MINUTES:-}" ] && return 0
	[ $(( ($(date +%s) - started) / 60 + TRIAL_MINUTES )) -le "$SESSION_MINUTES" ]
}

trial() { # <target> [budget]
	local target="$1" budget="${2:-}" attempt=1 line verdict
	while [ "$attempt" -le "${MAX_ATTEMPTS:-3}" ]; do
		if ! time_left; then
			echo "out of time: not starting $target (SESSION_MINUTES=$SESSION_MINUTES, TRIAL_MINUTES=$TRIAL_MINUTES)" | tee -a "$log"
			return 0
		fi
		BUDGET="$budget" TRIALS=1 scripts/run.sh bench "$target" 2>&1 | tee -a "$log"
		line="$(grep '^trial: ' "$log" | tail -1)"
		verdict="${line##*verdict=}"
		record="$(echo "$line" | sed -E 's/.* record=([^ ]+) .*/\1/')"
		summary="results/raw/summary-$target-${record#run-}"
		if [ ! -f "$summary" ]; then
			summary=""
			[ "$verdict" = ok ] && verdict="no summary"
		elif ! node -e 'process.exit(require(process.argv[1]).steps.some((s) => s.machine?.contended) ? 1 : 0)' "$PWD/$summary"; then
			if [ "$verdict" = ok ]; then verdict=contended; else verdict="$verdict; contended"; fi
		fi
		if [ "$verdict" = ok ]; then
			echo "accepted: $target $(basename "${summary:-none}")" | tee -a "$log"
			return 0
		fi
		echo "set aside: $target $(basename "${summary:-none}") ($verdict); attempt $attempt of ${MAX_ATTEMPTS:-3}" | tee -a "$log"
		attempt=$((attempt + 1))
	done
	echo "giving up on this trial of $target after ${MAX_ATTEMPTS:-3} attempts" | tee -a "$log"
}

round=1
while [ "$round" -le "${SESSION_TRIALS:-3}" ]; do
	order="$TARGETS"
	# Even rounds run the targets in reverse order.
	if [ $((round % 2)) -eq 0 ]; then order="$(echo "$TARGETS" | tr ' ' '\n' | sed '1!G;h;$!d' | tr '\n' ' ')"; fi
	echo "round $round: $order" | tee -a "$log"
	for target in $order; do trial "$target"; done
	round=$((round + 1))
done
# (BSD seq counts down from 1 to 0, so counted loops here are while loops.)
split=1
while [ "$TIER" = 1 ] && [ "$split" -le "${SPLIT_TRIALS:-0}" ]; do trial fpr split; split=$((split + 1)); done
scripts/run.sh stop >/dev/null 2>&1 || true
echo "session $stamp done" | tee -a "$log"
echo "report: node scripts/report.mjs $log > results/session-$stamp.md"
