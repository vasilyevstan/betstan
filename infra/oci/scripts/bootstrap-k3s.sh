#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-install}"
ENV_FILE="${OCI_K3S_BOOTSTRAP_ENV_FILE:-/etc/betstan-k3s.env}"
STATE_DIR="${OCI_K3S_STATE_DIR:-/var/lib/betstan}"
STATE_FILE="$STATE_DIR/k3s-bootstrap.env"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

validate_contract() {
  [[ "${OCI_K3S_VERSION:-}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+\+k3s[0-9]+$ ]] ||
    die "OCI_K3S_VERSION must be a pinned k3s release"
  [[ "${OCI_K3S_BINARY_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] ||
    die "OCI_K3S_BINARY_SHA256 must be a lowercase SHA256"
}

render_cloud_init() {
  validate_contract
  local payload
  payload="$(base64 < "$0" | tr -d '\n')"
  cat <<YAML
#cloud-config
package_update: false
write_files:
  - path: /usr/local/sbin/betstan-bootstrap-k3s
    owner: root:root
    permissions: '0755'
    encoding: b64
    content: ${payload}
  - path: /etc/betstan-k3s.env
    owner: root:root
    permissions: '0600'
    content: |
      OCI_K3S_VERSION=${OCI_K3S_VERSION}
      OCI_K3S_BINARY_SHA256=${OCI_K3S_BINARY_SHA256}
runcmd:
  - ["/usr/local/sbin/betstan-bootstrap-k3s", "install"]
YAML
}

write_state() {
  local status="$1"
  local detail="${2:-none}"
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  {
    printf 'status=%q\n' "$status"
    printf 'detail=%q\n' "$detail"
    printf 'k3s_version=%q\n' "${OCI_K3S_VERSION:-unknown}"
    printf 'k3s_binary_sha256=%q\n' "${OCI_K3S_BINARY_SHA256:-unknown}"
  } > "$STATE_FILE"
  chmod 600 "$STATE_FILE"
}

install_k3s() {
  [[ "$(id -u)" == "0" ]] || die "k3s bootstrap must run as root"
  [[ -f "$ENV_FILE" ]] || die "k3s bootstrap environment is missing"
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  validate_contract
  [[ "$(uname -m)" == "aarch64" ]] || die "k3s bootstrap requires ARM64"

  exec > >(tee -a /var/log/betstan-k3s-bootstrap.log) 2>&1
  trap 'write_state FAILED line-$LINENO' ERR
  write_state RUNNING

  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl open-iscsi
  systemctl enable --now iscsid
  if command -v ufw >/dev/null 2>&1; then
    ufw --force disable
  fi

  cat > /etc/sysctl.d/90-betstan-k3s.conf <<'SYSCTL'
net.ipv4.ip_forward = 1
net.bridge.bridge-nf-call-iptables = 1
net.bridge.bridge-nf-call-ip6tables = 1
SYSCTL
  modprobe br_netfilter
  sysctl --system >/dev/null

  local download_dir binary actual
  download_dir="$(mktemp -d)"
  trap 'rm -rf -- "$download_dir"' EXIT
  binary="$download_dir/k3s-arm64"
  curl \
    --fail --location --silent --show-error \
    --proto '=https' --tlsv1.2 \
    --retry 5 --retry-all-errors \
    "https://github.com/k3s-io/k3s/releases/download/${OCI_K3S_VERSION}/k3s-arm64" \
    --output "$binary"
  actual="$(sha256_file "$binary")"
  [[ "$actual" == "$OCI_K3S_BINARY_SHA256" ]] ||
    die "downloaded k3s binary checksum mismatch"
  install -o root -g root -m 0755 "$binary" /usr/local/bin/k3s

  mkdir -p /etc/rancher/k3s
  chmod 700 /etc/rancher/k3s
  local instance_ocid
  instance_ocid="$(
    curl \
      --fail --silent --show-error \
      --retry 5 --retry-all-errors \
      -H 'Authorization: Bearer Oracle' \
      http://169.254.169.254/opc/v2/instance/id
  )"
  [[ "$instance_ocid" == ocid1.instance.* ]] ||
    die "OCI instance metadata returned an invalid instance OCID"
  cat > /etc/rancher/k3s/config.yaml <<'K3S'
disable:
  - local-storage
  - servicelb
  - traefik
write-kubeconfig-mode: "0600"
secrets-encryption: true
node-name: "betstan-k3s"
node-label:
  - "betstan.io/runtime=k3s"
  - "node.kubernetes.io/instance-type=VM.Standard.A1.Flex"
kubelet-arg:
  - "eviction-hard=memory.available<256Mi,nodefs.available<10%,nodefs.inodesFree<5%"
  - "provider-id=oci://__OCI_INSTANCE_OCID__"
K3S
  sed -i "s#__OCI_INSTANCE_OCID__#${instance_ocid}#" /etc/rancher/k3s/config.yaml
  chmod 600 /etc/rancher/k3s/config.yaml

  cat > /etc/systemd/system/k3s.service <<'SYSTEMD'
[Unit]
Description=Lightweight Kubernetes
Documentation=https://k3s.io
Wants=network-online.target
After=network-online.target

[Service]
Type=notify
EnvironmentFile=-/etc/default/%N
KillMode=process
Delegate=yes
LimitNOFILE=1048576
LimitNPROC=infinity
LimitCORE=infinity
TasksMax=infinity
TimeoutStartSec=0
Restart=always
RestartSec=5s
ExecStart=/usr/local/bin/k3s server

[Install]
WantedBy=multi-user.target
SYSTEMD

  systemctl daemon-reload
  systemctl enable --now k3s

  local attempt
  for attempt in $(seq 1 120); do
    if /usr/local/bin/k3s kubectl get --raw=/readyz >/dev/null 2>&1; then
      write_state READY
      printf 'k3s_bootstrap=PASS version=%s\n' "$OCI_K3S_VERSION"
      return
    fi
    sleep 5
  done
  die "k3s API did not become ready"
}

case "$MODE" in
  render-cloud-init)
    render_cloud_init
    ;;
  install)
    install_k3s
    ;;
  *)
    die "usage: bootstrap-k3s.sh [render-cloud-init|install]"
    ;;
esac
