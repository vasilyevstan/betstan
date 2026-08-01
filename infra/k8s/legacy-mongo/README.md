# Legacy Mongo rollback manifests

These seven manifests are rollback-only templates for
`consolidate-production-mongo-stan.sh`. Normal deployment must never apply this
directory.

Apply them only through the operator's `rollback` operation after exact journal
and rollback-readiness validation. Do not rename resources, change selectors,
or edit these templates independently of the operator's database/resource
allowlist and synthetic contract test.

Never use wildcard or directory-wide deletion against these resources. Normal
root application remains `kubectl apply -f infra/k8s`, which intentionally does
not recurse into this directory.

The active topology under `infra/k8s/` contains only the retained auth Mongo,
which hosts all eight logical databases after migration.
