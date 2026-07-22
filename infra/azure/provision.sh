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

# ---------------------------------------------------------------------------
# Configuration — change these if you want a different region / sizes
# ---------------------------------------------------------------------------
RESOURCE_GROUP="betstan-rg"
LOCATION="eastus"
CLUSTER_NAME="betstan-aks"
NODE_COUNT=2
NODE_VM_SIZE="Standard_B2s"   # 2 vCPU / 4 GB — cost-effective for a start
ACR_NAME=""                    # leave empty — we use Docker Hub instead of ACR
SUBSCRIPTION_ID=""             # leave empty — auto-detected from current login
APP_NAME="betstan-github-sp"   # Azure AD service principal name

echo ""
echo "=================================================="
echo " betstan.xyz — AKS Provisioning Script"
echo "=================================================="
echo ""

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
echo "[2/9] Creating resource group '$RESOURCE_GROUP' in '$LOCATION'..."
az group create \
  --name "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --output none
echo "  Done."

# ---------------------------------------------------------------------------
# 3. Create AKS cluster
# ---------------------------------------------------------------------------
echo ""
echo "[3/9] Creating AKS cluster '$CLUSTER_NAME' (this takes ~5 minutes)..."
az aks create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$CLUSTER_NAME" \
  --node-count "$NODE_COUNT" \
  --node-vm-size "$NODE_VM_SIZE" \
  --enable-managed-identity \
  --generate-ssh-keys \
  --output none
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

# ---------------------------------------------------------------------------
# 5. Install Nginx Ingress Controller via Helm
# ---------------------------------------------------------------------------
echo ""
echo "[5/9] Installing Nginx Ingress Controller..."
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --set controller.service.annotations."service\.beta\.kubernetes\.io/azure-load-balancer-health-probe-request-path"="/healthz" \
  --wait
echo "  Done."

# ---------------------------------------------------------------------------
# 6. Install cert-manager via Helm
# ---------------------------------------------------------------------------
echo ""
echo "[6/9] Installing cert-manager..."
helm repo add jetstack https://charts.jetstack.io
helm repo update
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set installCRDs=true \
  --wait
echo "  Done."

# ---------------------------------------------------------------------------
# 7. Create jwt-secret in the default namespace
# ---------------------------------------------------------------------------
echo ""
echo "[7/9] Creating jwt-secret Kubernetes Secret..."
if kubectl get secret jwt-secret --namespace default &>/dev/null; then
  echo "  jwt-secret already exists — skipping."
else
  # Prompt for the JWT key value
  echo ""
  read -r -s -p "  Enter a JWT secret key (min 32 chars, input hidden): " JWT_KEY_VALUE
  echo ""
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
SP_JSON=$(az ad sp create-for-rbac \
  --name "$APP_NAME" \
  --role contributor \
  --scopes "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP" \
  --sdk-auth)
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
