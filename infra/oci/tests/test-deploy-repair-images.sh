#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$tmp_dir"
}
trap cleanup EXIT

services=(auth bet event moderation resulting slip backoffice client gamemaster)
baseline="$tmp_dir/baseline.tsv"
target="$tmp_dir/target.tsv"
state="$tmp_dir/state.tsv"
log="$tmp_dir/kubectl.log"
mock_bin="$tmp_dir/bin"
mkdir -p "$mock_bin"
: > "$baseline"
: > "$target"
: > "$state"
: > "$log"

for index in "${!services[@]}"; do
  service="${services[$index]}"
  baseline_digest="$(printf 'sha256:%064x' "$((index + 1))")"
  target_digest="$(printf 'sha256:%064x' "$((index + 101))")"
  repository=ghcr.io/vasilyevstan/betstan-images
  baseline_ref="$repository@$baseline_digest"
  target_ref="$repository@$target_digest"
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$service" "$repository" "$baseline_ref" "$baseline_digest" "$baseline_digest" \
    >> "$baseline"
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$service" "$repository" "$target_ref" "$target_digest" "$target_digest" \
    >> "$target"
  printf '%s\t%s\n' "$service" "$baseline_ref" >> "$state"
done

cat > "$mock_bin/kubectl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
: "${MOCK_STATE:?}"
: "${MOCK_LOG:?}"
printf '%s\n' "$*" >> "$MOCK_LOG"

service_from_deployment() {
  local value="${1#deployment/}"
  value="${value#gaming-}"
  printf '%s\n' "${value%-depl}"
}

case "$1:$2" in
  get:deployment)
    service="$(service_from_deployment "$3")"
    image="$(awk -F '\t' -v service="$service" '$1 == service {print $2}' "$MOCK_STATE")"
    [ -n "$image" ]
    printf '{"spec":{"template":{"spec":{"containers":[{"name":"gaming-%s","image":"%s"}]}}}}\n' \
      "$service" "$image"
    ;;
  set:image)
    service="$(service_from_deployment "$3")"
    assignment="$4"
    image="${assignment#*=}"
    tmp="${MOCK_STATE}.tmp"
    awk -F '\t' -v service="$service" -v image="$image" \
      'BEGIN { OFS="\t" } $1 == service { $2=image } { print }' \
      "$MOCK_STATE" > "$tmp"
    mv -- "$tmp" "$MOCK_STATE"
    ;;
  rollout:status)
    ;;
  *)
    echo "unexpected kubectl command: $*" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$mock_bin/kubectl"

run_operator() {
  PATH="$mock_bin:$PATH" \
  MOCK_STATE="$state" \
  MOCK_LOG="$log" \
  OCI_K8S_NAMESPACE=betstan-oci \
  MODE="$1" \
  TARGET_IMAGES_FILE="$2" \
  BASELINE_IMAGES_FILE="$3" \
  OUTPUT_DIR="$4" \
    "$ROOT_DIR/infra/oci/scripts/deploy-repair-images.sh"
}

run_operator deploy "$target" "$baseline" "$tmp_dir/deploy"
[ "$(grep -c '^set image deployment/gaming-' "$log")" = "9" ]
[ "$(grep -c '^rollout status deployment/gaming-' "$log")" = "9" ]
while IFS=$'\t' read -r service _repository image_ref _digest _platform; do
  grep -Fxq "$service"$'\t'"$image_ref" "$state"
done < "$target"

: > "$log"
run_operator compensate "$baseline" "$target" "$tmp_dir/compensate"
[ "$(grep -c '^set image deployment/gaming-' "$log")" = "9" ]
while IFS=$'\t' read -r service _repository image_ref _digest _platform; do
  grep -Fxq "$service"$'\t'"$image_ref" "$state"
done < "$baseline"

: > "$log"
unknown="ghcr.io/vasilyevstan/betstan-images@sha256:$(printf '%064x' 999)"
awk -F '\t' -v image="$unknown" \
  'BEGIN { OFS="\t" } $1 == "slip" { $2=image } { print }' \
  "$state" > "$state.tmp"
mv -- "$state.tmp" "$state"
if run_operator deploy "$target" "$baseline" "$tmp_dir/drift" >/dev/null 2>&1; then
  echo "repair deployment unexpectedly accepted live image drift" >&2
  exit 1
fi
if grep -q '^set image ' "$log"; then
  echo "repair deployment mutated before completing baseline preflight" >&2
  exit 1
fi

if grep -Eq 'apply|delete|patch|secret|statefulset|service/' "$log"; then
  echo "repair deployment used a forbidden Kubernetes mutation" >&2
  exit 1
fi

echo "deploy_repair_images_tests=PASS"
