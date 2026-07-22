#!/usr/bin/env bash
set -euo pipefail

# Purpose: compare ingress external IP with public DNS answer.
# Usage:
#   DOMAIN=www.betstan.xyz ./infra/azure/agents/dns-check-stan.sh

DOMAIN="${DOMAIN:-www.betstan.xyz}"
INGRESS_NAMESPACE="${INGRESS_NAMESPACE:-ingress-nginx}"
INGRESS_SERVICE="${INGRESS_SERVICE:-ingress-nginx-controller}"

INGRESS_IP="$(kubectl get svc "$INGRESS_SERVICE" -n "$INGRESS_NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].ip}')"

if command -v dig >/dev/null 2>&1; then
  DNS_IP="$(dig +short "$DOMAIN" A | head -n 1)"
elif command -v nslookup >/dev/null 2>&1; then
  DNS_IP="$(nslookup "$DOMAIN" 2>/dev/null | awk '/^Address: / {print $2}' | tail -n 1)"
else
  echo "ERROR: neither dig nor nslookup is installed." >&2
  exit 1
fi

echo "domain=$DOMAIN"
echo "dns_ip=${DNS_IP:-<none>}"
echo "ingress_ip=${INGRESS_IP:-<none>}"

if [[ -z "${DNS_IP:-}" || -z "${INGRESS_IP:-}" ]]; then
  echo "status=INCOMPLETE"
  exit 2
fi

if [[ "$DNS_IP" == "$INGRESS_IP" ]]; then
  echo "status=MATCH"
  exit 0
fi

echo "status=MISMATCH"
exit 3

