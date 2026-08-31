#!/usr/bin/env sh
set -eu

output=/var/run/betstan-monitor/mongo.json
temporary="${output}.tmp"

while true; do
  observed_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  if [ -z "${MONGO_MONITOR_USERNAME:-}" ] || [ -z "${MONGO_MONITOR_PASSWORD:-}" ]; then
    printf '{"observed_at":"%s","ready":false,"status":"credentials-unavailable"}\n' \
      "$observed_at" >"$temporary"
  elif result="$(
    mongosh \
      --quiet \
      --host "${MONGO_MONITOR_HOST:-gaming-shared-mongo-srv:27017}" \
      --authenticationDatabase admin \
      --username "$MONGO_MONITOR_USERNAME" \
      --password "$MONGO_MONITOR_PASSWORD" \
      --eval '
        const build=db.adminCommand({buildInfo:1});
        const fcv=db.adminCommand({getParameter:1,featureCompatibilityVersion:1});
        const databases=db.adminCommand({listDatabases:1,nameOnly:true,authorizedDatabases:true});
        if (build.ok !== 1 || fcv.ok !== 1 || databases.ok !== 1) {
          quit(2);
        }
        print(JSON.stringify({
          ready:true,
          status:"ok",
          version:build.version,
          fcv:fcv.featureCompatibilityVersion.version,
          database_count:databases.databases.length
        }));
      ' 2>/dev/null
  )"; then
    printf '{"observed_at":"%s",' "$observed_at" >"$temporary"
    printf '%s' "$result" | sed 's/^{//' >>"$temporary"
    printf '\n' >>"$temporary"
  else
    printf '{"observed_at":"%s","ready":false,"status":"unavailable"}\n' \
      "$observed_at" >"$temporary"
  fi
  chmod 600 "$temporary"
  mv "$temporary" "$output"
  sleep 30
done
