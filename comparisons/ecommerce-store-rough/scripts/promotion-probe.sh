#!/usr/bin/env bash
# Diagnostic, not a measurement: what the quote's promotion candidate lookup costs each target on
# the loaded dataset, for one customer tier and three categories.
#
#   scripts/promotion-probe.sh [tier] [category...]  > results/raw/promotion-probe-<stamp>.txt
#
# The reference: its REST interface (the tables are exported), timed per request from the host,
# for both conditions ANDed as quote.js asks (tierKeys in [tier, *] and categoryKeys in
# [categories..., *]), each condition alone, and the whole table; full rows and ids only. fpr:
# EXPLAIN (ANALYZE, BUFFERS) of its own candidate query with the same values. Each target is
# restored, cold-started, probed and stopped in turn; nothing else runs.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
CUSTOMER_TIER="${1:-gold}"; shift || true
if [ $# -gt 0 ]; then CATS=("$@"); else CATS=(apparel-shirts electronics-audio home-kitchen); fi
REPS="${REPS:-20}"
set -a; . ./.env; set +a

median_ms() { # median_ms <url>: median of REPS request times in ms, and the row count
	local url="$1" times=() rows
	rows="$(curl -sf -u "$HDB_ADMIN_USERNAME:$HDB_ADMIN_PASSWORD" -H 'accept: application/json' -g "$url" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).length))')"
	for _ in $(seq 1 "$REPS"); do
		times+=("$(curl -sf -u "$HDB_ADMIN_USERNAME:$HDB_ADMIN_PASSWORD" -H 'accept: application/json' -g "$url" -o /dev/null -w '%{time_total}')")
	done
	printf '%s\n' "${times[@]}" | sort -n | awk -v rows="$rows" '{t[NR]=$1} END {printf "%6d rows  median %.2f ms  min %.2f ms\n", rows, t[int((NR+1)/2)]*1000, t[1]*1000}'
}

echo "tier=$CUSTOMER_TIER categories=${CATS[*]} reps=$REPS"
scripts/run.sh start harper >/dev/null
base="http://localhost:${HARPER_HOST_PORT:-39936}/Promotion/"
tiers="(tierKeys=$CUSTOMER_TIER|tierKeys=*)"
cats="($(printf 'categoryKeys=%s|' "${CATS[@]}")categoryKeys=*)"
# One untimed pass over the table first, so the first timed condition does not pay for loading it.
curl -sf -u "$HDB_ADMIN_USERNAME:$HDB_ADMIN_PASSWORD" -g "$base?select(id)" -o /dev/null
for select in '' '&select(id)'; do
	echo "== reference, ${select:-full rows}"
	printf '  tier AND categories (quote.js)  '; median_ms "$base?$tiers&$cats$select"
	printf '  categories AND tier (reversed)  '; median_ms "$base?$cats&$tiers$select"
	printf '  tier alone                      '; median_ms "$base?$tiers$select"
	printf '  categories alone                '; median_ms "$base?$cats$select"
	printf '  whole table                     '; median_ms "$base?${select#&}"
done
scripts/run.sh stop >/dev/null 2>&1

scripts/run.sh start fpr >/dev/null
CLI="$(command -v docker >/dev/null && docker version >/dev/null 2>&1 && echo docker || echo podman)"
arr() { local IFS=,; echo "{$*}"; }
echo "== fpr: EXPLAIN (ANALYZE, BUFFERS), second execution"
for _ in 1 2; do
	out="$("$CLI" exec aab-ecommerce-rough-postgres-1 psql -U store -d store -At -c "EXPLAIN (ANALYZE, BUFFERS) SELECT id, kind, tiers, skus, category_ids, threshold_minor, amount_minor, amount_basis_points FROM promotion WHERE tier_keys && '$(arr "$CUSTOMER_TIER" '*')'::text[] AND category_keys && '$(arr "${CATS[@]}" '*')'::text[]")"
done
echo "$out" | sed 's/^/  /'
scripts/run.sh stop >/dev/null 2>&1
