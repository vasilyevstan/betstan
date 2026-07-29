#!/usr/bin/env bash
set -euo pipefail

# Purpose: compare ingress external IP with public DNS answer and diagnose common GoDaddy record issues.
# Usage:
#   DOMAIN=www.betstan.xyz ./infra/azure/agents/dns-check-stan.sh

DOMAIN="${DOMAIN:-www.betstan.xyz}"
INGRESS_NAMESPACE="${INGRESS_NAMESPACE:-ingress-nginx}"
INGRESS_SERVICE="${INGRESS_SERVICE:-ingress-nginx-controller}"
ROOT_DOMAIN="${ROOT_DOMAIN:-${DOMAIN#www.}}"

INGRESS_IP="$(kubectl get svc "$INGRESS_SERVICE" -n "$INGRESS_NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].ip}')"

if command -v dig >/dev/null 2>&1; then
  DNS_IP="$(dig +short "$DOMAIN" A | awk '/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/{print; exit}')"
elif command -v nslookup >/dev/null 2>&1; then
  DNS_IP="$(nslookup "$DOMAIN" 2>/dev/null | awk '/^Address: / && $2 ~ /^[0-9]+\./ {print $2}' | tail -n 1)"
else
  echo "ERROR: neither dig nor nslookup is installed." >&2
  exit 1
fi

echo "domain=$DOMAIN"
echo "dns_ip=${DNS_IP:-<none>}"
echo "ingress_ip=${INGRESS_IP:-<none>}"

if command -v dig >/dev/null 2>&1; then
  CNAME_VALUE="$(dig +short "$DOMAIN" CNAME | head -n1 | sed 's/\.$//')"
else
  CNAME_VALUE=""
fi
echo "cname_for_domain=${CNAME_VALUE:-<none>}"

if [[ -z "${DNS_IP:-}" || -z "${INGRESS_IP:-}" ]]; then
  echo "status=INCOMPLETE"
  echo "GoDaddy fix checklist:"
  echo "1) Ensure there is no CNAME record for host 'www'. Delete CNAME first."
  echo "2) Add A record with Host='www' and Points to='${INGRESS_IP:-<INGRESS_IPV4>}'"
  echo "3) 'Points to' must be plain IPv4 only (no http://, no hostname, no spaces)."
  echo "4) TTL can be default (e.g. 1 hour)."
  echo "5) Verify with: dig +short ${DOMAIN} A"
  exit 2
fi

if [[ "$DNS_IP" == "$INGRESS_IP" ]]; then
  echo "status=MATCH"
  exit 0
fi

echo "status=MISMATCH"
if [[ -n "${CNAME_VALUE:-}" ]]; then
  echo "Detected CNAME for ${DOMAIN}: ${CNAME_VALUE}"
  echo "GoDaddy does not allow A and CNAME with same host. Delete CNAME for 'www' first."
fi
echo "Expected A record:"
echo "Type=A Host=www Points to=${INGRESS_IP}"
echo "Verification commands:"
echo "  dig +short ${DOMAIN} A"
echo "  nslookup ${DOMAIN}"
exit 3
