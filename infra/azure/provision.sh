#!/usr/bin/env bash
# =============================================================================
# provision.sh — One-shot Azure AKS provisioning for betstan.xyz
#
# Prerequisites:
#   - Azure CLI installed  (https://docs.microsoft.com/cli/azure/install-azure-cli)
#   - kubectl installed    (https://kubernetes.io/docs/tasks/tools/)
#   - helm installed       (https://helm.sh/docs/intro/install/)
#
# Usage:
#   chmod +x infra/azure/provision.sh
#   az login                      # log in as stanvas@gmail.com
#   ./infra/azure/provision.sh
#
# At the end of the script you will be shown the values for the
# GitHub Actions secrets you must set in the repo.
# =============================================================================

set -euo pipefail

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: Required command '$cmd' is not installed or not in PATH." >&2
    exit 1
  fi
}

log_error() {
  echo "ERROR: $*" >&2
}

pick_cheapest_viable_vm_size() {
  local location="$1"
  local min_vcpus="$2"
  local min_memory_gb="$3"

  local candidates
  candidates=$(az vm list-sizes \
    --location "$location" \
    --query "[].{name:name,vcpus:numberOfCores,memoryMb:memoryInMB}" \
    -o tsv 2>/dev/null || true)

  if [[ -z "$candidates" ]]; then
    return 1
  fi

  # Prefer burstable B-series for cost, then choose the smallest resources
  # that satisfy the minimum app capacity.
  local ordered_name
  ordered_name=$(awk -v min_vcpus="$min_vcpus" -v min_memory="$min_memory_gb" '
    {
      name=$1; vcpus=$2; memory=$3 / 1024;
      if (vcpus >= min_vcpus && memory >= min_memory && name ~ /^Standard_(B|A|D)/) {
        # Prefer well-known x64 burstable B-series sizes first.
        if (name ~ /^Standard_B[0-9]+(s|ms|m)$/) {
          print "0\t" vcpus "\t" memory "\t" name;
        } else {
          print "1\t" vcpus "\t" memory "\t" name;
        }
      }
    }
  ' <<<"$candidates" | sort -k1,1n -k2,2n -k3,3n -k4,4 | head -n 1 | awk '{print $4}')

  if [[ -z "$ordered_name" ]]; then
    return 1
  fi

  echo "$ordered_name"
  return 0
}

ensure_k8s_api_reachable() {
  local resource_group="$1"
  local cluster_name="$2"

  local private_cluster
  local private_fqdn
  local public_fqdn
  private_cluster=$(az aks show \
    --resource-group "$resource_group" \
    --name "$cluster_name" \
    --query "apiServerAccessProfile.enablePrivateCluster" \
    -o tsv 2>/dev/null || echo "false")
  private_fqdn=$(az aks show \
    --resource-group "$resource_group" \
    --name "$cluster_name" \
    --query "privateFqdn" \
    -o tsv 2>/dev/null || true)
  public_fqdn=$(az aks show \
    --resource-group "$resource_group" \
    --name "$cluster_name" \
    --query "fqdn" \
    -o tsv 2>/dev/null || true)

  local probe_err
  probe_err=$(kubectl get --raw='/readyz' --request-timeout=15s 2>&1)
  if [[ $? -eq 0 ]]; then
    return 0
  fi

  log_error "Cannot reach AKS Kubernetes API."
  if [[ "$private_cluster" == "true" ]]; then
    echo "  Cluster is PRIVATE."
    echo "  privateFqdn: ${private_fqdn:-<not set>}"
    echo "  You must run this script from a network with access to the AKS private endpoint and private DNS."
    echo "  Typical options:"
    echo "    1) Connect to VPN/ExpressRoute linked to the AKS VNet."
    echo "    2) Run from an Azure VM inside the same VNet."
  else
    echo "  Cluster is PUBLIC."
    echo "  fqdn: ${public_fqdn:-<not set>}"
    echo "  Verify local DNS/network and retry."
  fi
  if [[ -n "$probe_err" ]]; then
    echo "  kubectl error: $probe_err"
  fi
  return 1
}

# ---------------------------------------------------------------------------
# Configuration — change these if you want a different region / sizes
# ---------------------------------------------------------------------------
RESOURCE_GROUP="${RESOURCE_GROUP:-betstan-rg}"
LOCATION="${LOCATION:-eastus}"
CLUSTER_NAME="${CLUSTER_NAME:-betstan-aks}"
NODE_COUNT="${NODE_COUNT:-1}"                # default to lowest-cost single node
NODE_VM_SIZE="${NODE_VM_SIZE:-}"             # if empty, auto-pick cheapest viable size
APP_NAME="${APP_NAME:-betstan-github-sp}"    # Azure AD service principal name
MIN_NODE_VCPUS="${MIN_NODE_VCPUS:-2}"
MIN_NODE_MEMORY_GB="${MIN_NODE_MEMORY_GB:-4}"
RESOURCE_GROUP_LOCATION="${RESOURCE_GROUP_LOCATION:-$LOCATION}"

echo ""
echo "=================================================="
echo " betstan.xyz — AKS Provisioning Script"
echo "=================================================="
echo ""

# ---------------------------------------------------------------------------
# 0. Verify required tools exist
# ---------------------------------------------------------------------------
require_cmd az
require_cmd kubectl
require_cmd helm

# ---------------------------------------------------------------------------
# 1. Verify login & pick subscription
# ---------------------------------------------------------------------------
echo "[1/9] Verifying Azure login..."
CURRENT_USER=$(az account show --query "user.name" -o tsv 2>/dev/null || true)
if [[ -z "$CURRENT_USER" ]]; then
  echo "  Not logged in. Running 'az login'..."
  az login
fi
echo "  Logged in as: $(az account show --query 'user.name' -o tsv)"

SUBSCRIPTION_ID=$(az account show --query "id" -o tsv)
echo "  Subscription ID: $SUBSCRIPTION_ID"

# ---------------------------------------------------------------------------
# 2. Create Resource Group
# ---------------------------------------------------------------------------
echo ""
echo "[2/9] Creating resource group '$RESOURCE_GROUP' in '$RESOURCE_GROUP_LOCATION'..."
if az group exists --name "$RESOURCE_GROUP" --output tsv | grep -q "true"; then
  EXISTING_RG_LOCATION=$(az group show --name "$RESOURCE_GROUP" --query "location" -o tsv)
  if [[ "$EXISTING_RG_LOCATION" != "$RESOURCE_GROUP_LOCATION" ]]; then
    echo "  Resource group already exists in '$EXISTING_RG_LOCATION' (not '$RESOURCE_GROUP_LOCATION')."
    echo "  Reusing existing resource group location."
    RESOURCE_GROUP_LOCATION="$EXISTING_RG_LOCATION"
  else
    echo "  Resource group already exists — skipping create."
  fi
else
  az group create \
    --name "$RESOURCE_GROUP" \
    --location "$RESOURCE_GROUP_LOCATION" \
    --output none
fi
echo "  Done."
echo "  AKS cluster location target: $LOCATION"

if [[ -z "$NODE_VM_SIZE" ]]; then
  AUTO_VM_SIZE=$(pick_cheapest_viable_vm_size "$LOCATION" "$MIN_NODE_VCPUS" "$MIN_NODE_MEMORY_GB" || true)
  if [[ -z "$AUTO_VM_SIZE" ]]; then
    log_error "Could not auto-select a viable VM size in '$LOCATION'. Set NODE_VM_SIZE explicitly."
    exit 1
  fi
  NODE_VM_SIZE="$AUTO_VM_SIZE"
  echo "  Auto-selected node VM size: $NODE_VM_SIZE (minimum ${MIN_NODE_VCPUS} vCPU / ${MIN_NODE_MEMORY_GB} GB)"
else
  echo "  Using override node VM size: $NODE_VM_SIZE"
fi
echo "  Node count: $NODE_COUNT"

# ---------------------------------------------------------------------------
# 3. Create AKS cluster
# ---------------------------------------------------------------------------
echo ""
echo "[3/9] Creating AKS cluster '$CLUSTER_NAME' (this takes ~5 minutes)..."
if az aks show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$CLUSTER_NAME" >/dev/null 2>&1; then
  CLUSTER_STATE=$(az aks show \
    --resource-group "$RESOURCE_GROUP" \
    --name "$CLUSTER_NAME" \
    --query "provisioningState" \
    -o tsv)
  if [[ "$CLUSTER_STATE" != "Succeeded" ]]; then
    log_error "AKS cluster exists but provisioning state is '$CLUSTER_STATE' (expected 'Succeeded')."
    echo "  If you want to recreate it, run:"
    echo "  az aks delete --resource-group \"$RESOURCE_GROUP\" --name \"$CLUSTER_NAME\" --yes --no-wait"
    echo "  Then run this script again."
    exit 1
  fi
  echo "  AKS cluster already exists — skipping create."
else
  az aks create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$CLUSTER_NAME" \
    --location "$LOCATION" \
    --node-count "$NODE_COUNT" \
    --node-vm-size "$NODE_VM_SIZE" \
    --enable-managed-identity \
    --generate-ssh-keys \
    --output none
fi
echo "  Done."

# ---------------------------------------------------------------------------
# 4. Get AKS credentials (sets kubectl context)
# ---------------------------------------------------------------------------
echo ""
echo "[4/9] Fetching AKS credentials..."
az aks get-credentials \
  --resource-group "$RESOURCE_GROUP" \
  --name "$CLUSTER_NAME" \
  --overwrite-existing
echo "  kubectl context set to: $(kubectl config current-context)"
ensure_k8s_api_reachable "$RESOURCE_GROUP" "$CLUSTER_NAME"
echo "  Kubernetes API is reachable."

# ---------------------------------------------------------------------------
# 5. Install Nginx Ingress Controller via Helm
# ---------------------------------------------------------------------------
echo ""
echo "[5/9] Installing Nginx Ingress Controller..."
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx --force-update
helm repo update
if ! helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --set controller.service.annotations."service\.beta\.kubernetes\.io/azure-load-balancer-health-probe-request-path"="/healthz" \
  --wait \
  --timeout 15m; then
  log_error "Failed to install/upgrade ingress-nginx."
  helm --namespace ingress-nginx status ingress-nginx || true
  exit 1
fi
echo "  Done."

# ---------------------------------------------------------------------------
# 6. Install cert-manager via Helm
# ---------------------------------------------------------------------------
echo ""
echo "[6/9] Installing cert-manager..."
helm repo add jetstack https://charts.jetstack.io --force-update
helm repo update
if ! helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set installCRDs=true \
  --wait \
  --timeout 15m; then
  log_error "Failed to install/upgrade cert-manager."
  helm --namespace cert-manager status cert-manager || true
  exit 1
fi
echo "  Done."

# ---------------------------------------------------------------------------
# 7. Create jwt-secret in the default namespace
# ---------------------------------------------------------------------------
echo ""
echo "[7/9] Creating jwt-secret Kubernetes Secret..."
if kubectl get secret jwt-secret --namespace default &>/dev/null; then
  echo "  jwt-secret already exists — skipping."
else
  # Use JWT_KEY env var for automation; otherwise prompt interactively.
  JWT_KEY_VALUE="${JWT_KEY:-}"
  if [[ -z "$JWT_KEY_VALUE" ]]; then
    if [[ -t 0 ]]; then
      echo ""
      read -r -s -p "  Enter a JWT secret key (min 32 chars, input hidden): " JWT_KEY_VALUE
      echo ""
    else
      log_error "JWT_KEY environment variable is required in non-interactive mode."
      exit 1
    fi
  fi
  if [[ ${#JWT_KEY_VALUE} -lt 32 ]]; then
    echo "  ERROR: JWT key must be at least 32 characters." >&2
    exit 1
  fi
  kubectl create secret generic jwt-secret \
    --from-literal=JWT_KEY="$JWT_KEY_VALUE" \
    --namespace default
  echo "  jwt-secret created."
fi

# ---------------------------------------------------------------------------
# 8. Create Azure Service Principal for GitHub Actions
# ---------------------------------------------------------------------------
echo ""
echo "[8/9] Creating service principal '$APP_NAME' for GitHub Actions..."
SP_SCOPE="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP"
EXISTING_SP_APP_ID=$(az ad sp list \
  --display-name "$APP_NAME" \
  --query '[0].appId' \
  -o tsv 2>/dev/null || true)

if [[ -n "$EXISTING_SP_APP_ID" ]]; then
  echo "  Service principal already exists — resetting credentials."
  EXISTING_ASSIGNMENT_ID=$(az role assignment list \
    --assignee "$EXISTING_SP_APP_ID" \
    --scope "$SP_SCOPE" \
    --query "[?roleDefinitionName=='Contributor'] | [0].id" \
    -o tsv 2>/dev/null || true)

  if [[ -z "$EXISTING_ASSIGNMENT_ID" ]]; then
    az role assignment create \
      --assignee "$EXISTING_SP_APP_ID" \
      --role contributor \
      --scope "$SP_SCOPE" \
      --output none
  fi

  SP_JSON=$(az ad sp credential reset \
    --id "$EXISTING_SP_APP_ID" \
    --query "{clientId: appId, clientSecret: password, subscriptionId: '$SUBSCRIPTION_ID', tenantId: tenant}" \
    -o json)
else
  SP_JSON=$(az ad sp create-for-rbac \
    --name "$APP_NAME" \
    --role contributor \
    --scopes "$SP_SCOPE" \
    --sdk-auth)
fi
echo "  Service principal created."

# ---------------------------------------------------------------------------
# 9. Print GitHub Secrets summary
# ---------------------------------------------------------------------------
INGRESS_IP=""
echo ""
echo "[9/9] Waiting for Nginx Ingress LoadBalancer IP (may take 1–2 minutes)..."
for i in {1..24}; do
  INGRESS_IP=$(kubectl get svc ingress-nginx-controller \
    --namespace ingress-nginx \
    -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
  if [[ -n "$INGRESS_IP" ]]; then
    break
  fi
  echo "  Still waiting... ($((i * 5))s)"
  sleep 5
done

echo ""
echo "=================================================="
echo " PROVISIONING COMPLETE"
echo "=================================================="
echo ""
echo "▶ Set the following GitHub Actions secrets in:"
echo "  https://github.com/vasilyevstan/betstan/settings/secrets/actions"
echo ""
echo "  Secret name            Value"
echo "  ─────────────────────────────────────────────"
echo "  AZURE_CREDENTIALS      (see JSON block below)"
echo "  RESOURCE_GROUP         $RESOURCE_GROUP"
echo "  CLUSTER_NAME           $CLUSTER_NAME"
echo "  DOCKERHUB_USERNAME     stanvasilyev"
echo "  DOCKERHUB_TOKEN        <your Docker Hub access token>"
echo "  JWT_KEY                <the JWT key you entered above>"
echo ""
echo "  AZURE_CREDENTIALS JSON:"
echo "────────────────────────────────────────────────"
echo "$SP_JSON"
echo "────────────────────────────────────────────────"
echo ""
if [[ -n "$INGRESS_IP" ]]; then
  echo "▶ GoDaddy DNS — add this A record:"
  echo "  Type: A"
  echo "  Name: www"
  echo "  Value: $INGRESS_IP"
  echo "  TTL:  600"
  echo ""
  echo "  GoDaddy DNS Manager:"
  echo "  https://dcc.godaddy.com/manage/betstan.xyz/dns"
else
  echo "▶ Could not detect Ingress IP automatically."
  echo "  Run this command after a few minutes to get it:"
  echo "  kubectl get svc ingress-nginx-controller -n ingress-nginx"
  echo "  Then add an A record in GoDaddy: www → <that IP>"
fi
echo ""
echo "After setting secrets, push any commit to master to trigger the full"
echo "build + deploy pipeline. HTTPS will activate automatically once DNS"
echo "propagates (usually within 10 minutes)."
echo ""
