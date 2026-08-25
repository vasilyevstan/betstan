#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

KUBECONFIG="${KUBECONFIG:-}"
EXPECTED_K3S_SERVER="${EXPECTED_K3S_SERVER:-}"

[[ -n "$KUBECONFIG" && -f "$KUBECONFIG" && ! -L "$KUBECONFIG" ]] ||
  oci_die "KUBECONFIG must be a regular, non-symlink file"
[[ "$EXPECTED_K3S_SERVER" =~ ^https://127\.0\.0\.1:[1-9][0-9]{0,4}$ ]] ||
  oci_die "EXPECTED_K3S_SERVER must be a loopback HTTPS endpoint"
oci_require_command kubectl
oci_require_command jq

if grep -Eiq \
  '^[[:space:]]*"?(exec|auth-provider|token|tokenFile|username|password|client-certificate|client-key|certificate-authority|proxy-url)"?[[:space:]]*:' \
  "$KUBECONFIG"; then
  oci_die "remote kubeconfig contains executable, credential-provider, token, proxy, or external-file directives"
fi

raw_json="${KUBECONFIG}.raw.$$"
normalized_json="${KUBECONFIG}.normalized.$$"
cleanup() {
  rm -f -- "$raw_json" "$normalized_json"
}
trap cleanup EXIT

kubectl config view \
  --kubeconfig "$KUBECONFIG" \
  --raw \
  --minify \
  -o json >"$raw_json"

jq -e --arg expected_server "$EXPECTED_K3S_SERVER" '
  def only($allowed):
    ((keys_unsorted - $allowed) | length) == 0;
  def inline_data:
    type == "string" and
    length > 0 and
    test("^[A-Za-z0-9+/]+={0,2}$");
  type == "object" and
  only(["apiVersion", "clusters", "contexts", "current-context", "kind", "preferences", "users"]) and
  .apiVersion == "v1" and
  .kind == "Config" and
  (.clusters | type == "array" and length == 1) and
  (.contexts | type == "array" and length == 1) and
  (.users | type == "array" and length == 1) and
  (."current-context" | type == "string" and length > 0) and
  .contexts[0].name == ."current-context" and
  (.clusters[0] | only(["cluster", "name"])) and
  (.clusters[0].name | type == "string" and length > 0) and
  (.clusters[0].cluster | only(["certificate-authority-data", "server"])) and
  .clusters[0].cluster.server == $expected_server and
  (.clusters[0].cluster."certificate-authority-data" | inline_data) and
  (.contexts[0] | only(["context", "name"])) and
  (.contexts[0].context | only(["cluster", "namespace", "user"])) and
  .contexts[0].context.cluster == .clusters[0].name and
  .contexts[0].context.user == .users[0].name and
  ((.contexts[0].context.namespace // "") | type == "string") and
  (.users[0] | only(["name", "user"])) and
  (.users[0].name | type == "string" and length > 0) and
  (.users[0].user | only(["client-certificate-data", "client-key-data"])) and
  (.users[0].user."client-certificate-data" | inline_data) and
  (.users[0].user."client-key-data" | inline_data)
' "$raw_json" >/dev/null ||
  oci_die "remote kubeconfig is not the expected inline-certificate, loopback-only k3s configuration"

jq --arg expected_server "$EXPECTED_K3S_SERVER" '{
  apiVersion: "v1",
  kind: "Config",
  preferences: {},
  clusters: [{
    name: .clusters[0].name,
    cluster: {
      "certificate-authority-data": .clusters[0].cluster."certificate-authority-data",
      server: $expected_server
    }
  }],
  contexts: [{
    name: .contexts[0].name,
    context: ({
      cluster: .contexts[0].context.cluster,
      user: .contexts[0].context.user
    } + if ((.contexts[0].context.namespace // "") | length) > 0
      then {namespace: .contexts[0].context.namespace}
      else {}
      end)
  }],
  "current-context": ."current-context",
  users: [{
    name: .users[0].name,
    user: {
      "client-certificate-data": .users[0].user."client-certificate-data",
      "client-key-data": .users[0].user."client-key-data"
    }
  }]
}' "$raw_json" >"$normalized_json"

chmod 600 "$normalized_json"
mv "$normalized_json" "$KUBECONFIG"
oci_log "k3s_kubeconfig_validation=PASS server=$EXPECTED_K3S_SERVER"
