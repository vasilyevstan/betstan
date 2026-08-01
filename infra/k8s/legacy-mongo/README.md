# Legacy Mongo rollback manifests

These seven manifests are rollback-only templates for
`consolidate-production-mongo-stan.sh`. Normal deployment must never apply this
directory.

The active topology under `infra/k8s/` contains only the retained auth Mongo,
which hosts all eight logical databases after migration.
