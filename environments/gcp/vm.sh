#!/usr/bin/env bash
# vm.sh — create, reach, and delete the tier-2 benchmark VM on GCP.
#
# Ran 2026-10-14 (README "Qualification"): preflight, up, status, describe, ssh, push, pull, down.
# NAT mode and metal have not run; C4A ran 2026-10-15. Read `vm.sh up --dry-run` output before a real run.
#
#   vm.sh preflight                 auth, billing, quota, and org-policy checks (read only)
#   vm.sh up [--dry-run]            network + IAP rule (+ Cloud NAT if needed), then the VM
#   vm.sh status                    every VM carrying the arch-bench label, plus pending maintenance
#   vm.sh describe                  GCP-side instance settings for the run-conditions record
#   vm.sh ssh [-- command...]       IAP-tunnelled ssh
#   vm.sh push LOCAL [REMOTE]       copy a file to the VM (default: home directory)
#   vm.sh pull REMOTE LOCAL_DIR     copy a file from the VM
#   vm.sh down                      delete the VM (and Cloud NAT), then prove nothing billable is left
#
# Egress: the VM gets an ephemeral external IPv4 by default. If the organization policy
# constraints/compute.vmExternalIpAccess blocks that, `up` creates it with no external address
# and puts Cloud NAT on the dedicated network instead. NETWORK_MODE=external|nat overrides.
#
# Patterned on HarperFast/sharded-blob-test provisioning/gcp/fleet.sh: dedicated network, SSH
# only through IAP, no service account, labels on everything, teardown that rescans.
set -euo pipefail

PROJECT="${PROJECT:-harper-arch-bench}"
GCLOUD="${GCLOUD:-gcloud}"
# Keep these commands from ever acting on another project through a shared default config.
export CLOUDSDK_ACTIVE_CONFIG_NAME="${CLOUDSDK_ACTIVE_CONFIG_NAME:-arch-bench}"
ZONE="${ZONE:-us-central1-a}"                     # first choice; `up` falls back to the region's other zones
REGION="${ZONE%-*}"
MACHINE="${MACHINE:-c4-standard-16-lssd}"
FAMILY="$(echo "${MACHINE%%-*}" | tr 'a-z' 'A-Z')"   # c4-standard-16-lssd -> C4, as quotas name it
OWNER="${OWNER:-$(whoami | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9-')}"
NAME="${NAME:-arch-bench-${OWNER}}"
COMPARISON="${COMPARISON:-unspecified}"           # label value: lowercase, digits, - and _
SESSION="${SESSION:-$(date -u +%Y%m%dt%H%M)}"
# Dead-man switch: the VM deletes itself after this long even if nobody runs `down`.
# Local SSD and boot disk go with it, so pull results before it fires.
MAX_RUN="${MAX_RUN:-8h}"
NETWORK=arch-bench-net
FW_IAP=arch-bench-allow-iap
IAP_RANGE=35.235.240.0/20
ROUTER=arch-bench-router
NAT=arch-bench-nat
NETWORK_MODE="${NETWORK_MODE:-auto}"              # auto | external | nat
DRY_RUN=0

die() { echo "ERROR: $*" >&2; exit 1; }
run() { if [ "$DRY_RUN" = 1 ]; then printf '+'; printf ' %q' "$@"; echo; else "$@"; fi; }
G=("$GCLOUD" --project="$PROJECT" --quiet)

# Every gcloud session is short. Fail early with the fix instead of halfway through.
need_auth() {
	"$GCLOUD" auth print-access-token >/dev/null 2>&1 \
		|| die "gcloud credentials expired or missing. A human runs: gcloud auth login   (then re-run this command; every step is safe to repeat)"
}

# The VM lives wherever `up` found capacity. Every later command looks its zone up instead of
# assuming ZONE.
locate() {
	local z
	z="$("${G[@]}" compute instances list --filter="name=${NAME}" --format='value(zone.basename())' 2>/dev/null | head -1)"
	if [ -n "$z" ]; then ZONE="$z"; REGION="${ZONE%-*}"; fi
}

cmd_preflight() {
	need_auth
	echo "config:   $CLOUDSDK_ACTIVE_CONFIG_NAME  project: $PROJECT  zone: $ZONE  machine: $MACHINE"
	echo "account:  $("$GCLOUD" config get-value account 2>/dev/null)"
	echo "billing:  $("${G[@]}" billing projects describe "$PROJECT" --format='value(billingEnabled)')"
	echo "apis:"; "${G[@]}" services list --enabled --format='value(config.name)' | grep -E '^(compute|iap|cloudquotas)\.googleapis\.com$' || true
	echo "quota (${REGION}, ${FAMILY} family): vCPUs $(family_quota CPUS-PER-VM-FAMILY-per-project-region), local SSD GB $(family_quota LOCAL-SSD-TOTAL-GB-PER-VM-FAMILY-per-project-region)"
	echo "quota (${REGION}, metric,limit,usage):"
	"${G[@]}" compute regions describe "$REGION" --flatten=quotas \
		--format='csv[no-heading](quotas.metric,quotas.limit,quotas.usage)' | grep -E '^(CPUS|IN_USE_ADDRESSES),' || true
	echo "machine type available in ${ZONE}:"
	"${G[@]}" compute machine-types describe "$MACHINE" --zone="$ZONE" --format='value(name,guestCpus,memoryMb)' || echo "  NOT available in $ZONE"
	echo "external IPv4 (constraints/compute.vmExternalIpAccess): $(external_ip_policy)"
	echo "  allowed: the VM gets an ephemeral external IP. blocked: 'up' uses --no-address plus Cloud NAT. unknown: 'up' tries an external IP; rerun with NETWORK_MODE=nat if the create is refused."
	echo "other org policies (empty means not set on the project):"
	for c in constraints/compute.requireOsLogin constraints/iam.disableServiceAccountKeyCreation; do
		printf '  %s: ' "$c"; "${G[@]}" resource-manager org-policies describe "$c" --effective --format='value(listPolicy,booleanPolicy)' 2>/dev/null || echo '?'
	done
}

# Per-family quotas (C4 vCPUs, C4 local SSD) are not in `regions describe`; only the Cloud
# Quotas API has them. A region-specific entry wins over the family default. jq ships with macOS.
family_quota() { # family_quota <quotaId>
	curl -sf -H "Authorization: Bearer $("$GCLOUD" auth print-access-token)" -H "x-goog-user-project: $PROJECT" \
		"https://cloudquotas.googleapis.com/v1/projects/$PROJECT/locations/global/services/compute.googleapis.com/quotaInfos/$1" \
		| jq -r --arg r "$REGION" --arg f "$FAMILY" '[.dimensionsInfos[]
			| select((.dimensions.region // $r) == $r and (.dimensions.vm_family // $f) == $f)]
			| sort_by(.dimensions.region == null) | first | .details.value // "none"' \
		|| echo "? (enable cloudquotas.googleapis.com)"
}

# allowed | blocked | unknown. The constraint is a list of instances allowed an external IP:
# deny-all, or an allow-list (which cannot name a VM that does not exist yet), blocks this VM.
external_ip_policy() {
	local policy
	policy="$("${G[@]}" resource-manager org-policies describe constraints/compute.vmExternalIpAccess \
		--effective --format='json(listPolicy)' 2>/dev/null)" || { echo unknown; return; }
	case "$policy" in
		*'"allValues": "DENY"'*|*allowedValues*) echo blocked ;;
		*) echo allowed ;;
	esac
}

# Egress for apt, GitHub, Docker Hub, and nodejs.org without an external IP on the VM.
ensure_nat() {
	if ! "${G[@]}" compute routers describe "$ROUTER" --region="$REGION" >/dev/null 2>&1; then
		run "${G[@]}" compute routers create "$ROUTER" --network="$NETWORK" --region="$REGION"
	fi
	if ! "${G[@]}" compute routers nats describe "$NAT" --router="$ROUTER" --region="$REGION" >/dev/null 2>&1; then
		run "${G[@]}" compute routers nats create "$NAT" --router="$ROUTER" --region="$REGION" \
			--auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges
	fi
}

ensure_network() {
	if ! "${G[@]}" compute networks describe "$NETWORK" >/dev/null 2>&1; then
		run "${G[@]}" compute networks create "$NETWORK" --subnet-mode=auto
	fi
	# SSH reaches the VM only through IAP. No other ingress exists.
	if ! "${G[@]}" compute firewall-rules describe "$FW_IAP" >/dev/null 2>&1; then
		run "${G[@]}" compute firewall-rules create "$FW_IAP" --network="$NETWORK" \
			--allow=tcp:22 --source-ranges="$IAP_RANGE" --target-tags=arch-bench
	fi
}

cmd_up() {
	[ "${1:-}" = "--dry-run" ] && DRY_RUN=1
	[ "$DRY_RUN" = 1 ] || need_auth
	if [ "$DRY_RUN" = 0 ]; then
		local where
		where="$("${G[@]}" compute instances list --filter="name=${NAME}" --format='value(zone.basename())')"
		[ -z "$where" ] || die "$NAME already exists in $where. Use it, or run 'vm.sh down' if it is yours."
	fi
	# Machine-series specific flags. See README "Instance": these are what make the clock
	# bounded and measurable, and what turn 2 vCPUs into 2 whole cores.
	local cpu_flags=() image_family maintenance=MIGRATE
	case "$MACHINE" in
		c4-*-metal)
			# Bare metal: no hypervisor, so SMT, turbo, and the PMU are the OS's to manage (see
			# host-setup.sh). Metal shapes terminate rather than migrate on host maintenance.
			image_family=debian-13; maintenance=TERMINATE ;;
		c4-*)
			cpu_flags=(--threads-per-core=1 --turbo-mode=ALL_CORE_MAX --performance-monitoring-unit=architectural)
			image_family=debian-13 ;;
		c4a-*)
			# Arm: one core per vCPU already; ALL_CORE_MAX is not offered.
			cpu_flags=(--performance-monitoring-unit=architectural)
			image_family=debian-13-arm64 ;;
		*) die "$MACHINE: only C4 and C4A expose the PMU; no other series can produce a gigacycle figure" ;;
	esac
	ensure_network

	local mode="$NETWORK_MODE" nic="network=${NETWORK},nic-type=GVNIC"
	if [ "$mode" = auto ]; then
		mode=external
		[ "$DRY_RUN" = 0 ] && [ "$(external_ip_policy)" = blocked ] && mode=nat
	fi
	case "$mode" in
		external) ;;
		nat) ensure_nat; nic+=",no-address" ;;
		*) die "NETWORK_MODE=$NETWORK_MODE: use auto, external, or nat" ;;
	esac
	echo "egress: $mode$( [ "$DRY_RUN" = 1 ] && [ "$NETWORK_MODE" = auto ] && echo ' (dry run does not read the org policy; vm.sh preflight does)')"

	# C4 -lssd capacity runs out per zone: on 2026-10-14, us-central1-a and -b refused this shape
	# and -c had it. Try ZONE, then every other zone of the region that offers the machine type.
	local zones="$ZONE" z out created=""
	[ "$DRY_RUN" = 1 ] || zones+=" $("${G[@]}" compute machine-types list --filter="name=${MACHINE} AND zone~^${REGION}-" \
		--format='value(zone)' | { grep -vx "$ZONE" || true; } | sort | tr '\n' ' ')"
	for z in $zones; do
		if out="$(create "$z" 2>&1)"; then echo "$out"; ZONE="$z"; created=1; break; fi
		echo "$out" >&2
		grep -qE 'stockout|ZONE_RESOURCE_POOL_EXHAUSTED' <<<"$out" || die "create failed in $z, and not for lack of capacity"
		echo "no ${MACHINE} capacity in ${z}; trying the next zone" >&2
	done
	[ "$DRY_RUN" = 1 ] && { echo "dry run: without capacity in ${ZONE}, up tries the region's other zones"; return; }
	[ -n "$created" ] || die "no ${MACHINE} capacity in any zone of ${REGION}; try later or set ZONE to another region's zone"

	echo
	echo "created in ${ZONE}. next: vm.sh push environments/gcp/host-setup.sh && vm.sh ssh -- sudo bash host-setup.sh"
	echo "this VM deletes itself ${MAX_RUN} after boot. Pull results before then."
}

create() { # create <zone>; reads cpu_flags, image_family, maintenance, nic from cmd_up
	run "${G[@]}" compute instances create "$NAME" \
		--zone="$1" \
		--machine-type="$MACHINE" \
		"${cpu_flags[@]}" \
		--image-family="$image_family" --image-project=debian-cloud \
		--boot-disk-type=hyperdisk-balanced --boot-disk-size=50GB \
		--network-interface="$nic" \
		--tags=arch-bench \
		--labels="arch-bench=${NAME},comparison=${COMPARISON},session=${SESSION},owner=${OWNER}" \
		--no-service-account --no-scopes \
		--maintenance-policy="$maintenance" \
		--max-run-duration="$MAX_RUN" --instance-termination-action=DELETE
}

cmd_status() {
	need_auth; locate
	"${G[@]}" compute instances list --filter='labels.arch-bench:*' \
		--format='table(name,zone.basename(),machineType.basename(),status,labels.session,labels.comparison,resourceStatus.scheduling.terminationTimestamp:label=SELF_DELETE_AT)'
	# C4 gives 7 days' notice of host maintenance. A live migration during a trial invalidates it.
	local m
	m="$("${G[@]}" compute instances describe "$NAME" --zone="$ZONE" --format='value(resourceStatus.upcomingMaintenance)' 2>/dev/null)" \
		&& echo "upcoming maintenance for ${NAME}: ${m:-none}"
	return 0
}

# The instance's GCP-side configuration, for the run-conditions record: machine type, CPU
# platform, turbo mode, threads per core, PMU type, maintenance policy, disks. The guest
# cannot see most of this. Metadata (startup scripts, ssh keys) is left out.
cmd_describe() {
	need_auth; locate
	"${G[@]}" compute instances describe "$NAME" --zone="$ZONE" \
		--format='json(name,zone,machineType,cpuPlatform,minCpuPlatform,advancedMachineFeatures,scheduling,disks[].type,disks[].diskSizeGb,disks[].interface,labels,networkInterfaces[].nicType,creationTimestamp,lastStartTimestamp)'
}

cmd_ssh() {
	need_auth; locate
	[ "${1:-}" = "--" ] && shift
	# --quiet: the first call creates ~/.ssh/google_compute_engine without a passphrase prompt,
	# which an agent's shell cannot answer.
	"${G[@]}" compute ssh "$NAME" --zone="$ZONE" --tunnel-through-iap -- "$@"
}

cmd_push() {
	need_auth; locate
	"${G[@]}" compute scp --zone="$ZONE" --tunnel-through-iap "$1" "${NAME}:${2:-}"
}

cmd_pull() {
	need_auth; locate
	mkdir -p "$2"
	"${G[@]}" compute scp --zone="$ZONE" --tunnel-through-iap "${NAME}:$1" "$2/"
}

cmd_down() {
	need_auth; locate
	if "${G[@]}" compute instances describe "$NAME" --zone="$ZONE" >/dev/null 2>&1; then
		"${G[@]}" compute instances delete "$NAME" --zone="$ZONE"
	else
		echo "$NAME not found in $ZONE"
	fi
	# Prove it: nothing labelled for this project's benchmarks may still bill.
	local left
	left="$("${G[@]}" compute instances list --filter='labels.arch-bench:*' --format='value(name)')"
	# Cloud NAT (NAT mode only) goes once no benchmark VM needs it; deleting the router removes it.
	if [ -z "$left" ] && "${G[@]}" compute routers describe "$ROUTER" --region="$REGION" >/dev/null 2>&1; then
		"${G[@]}" compute routers delete "$ROUTER" --region="$REGION"
	fi
	left+="$("${G[@]}" compute disks list --filter='labels.arch-bench:* OR name~^arch-bench-' --format='value(name)')"
	left+="$("${G[@]}" compute addresses list --format='value(name)')"
	left+="$("${G[@]}" compute routers list --format='value(name)')"
	[ -z "$left" ] || die "still present, delete by hand after checking it is yours: $left"
	echo "down: 0 instances, 0 disks, 0 reserved addresses, 0 routers. The network and IAP rule are free and stay."
}

sub="${1:-}"; shift || true
case "$sub" in
	preflight) cmd_preflight ;;
	up) cmd_up "$@" ;;
	status) cmd_status ;;
	describe) cmd_describe ;;
	ssh) cmd_ssh "$@" ;;
	push) cmd_push "$@" ;;
	pull) cmd_pull "$@" ;;
	down) cmd_down ;;
	*) sed -n '2,14p' "$0"; exit 1 ;;
esac
