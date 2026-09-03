# `@betstan/common`

`common/src/` is the canonical source for BetStan's shared TypeScript
contracts, middleware, RabbitMQ base classes, queue names, and status values.
It is a normal tracked directory in this repository, not a submodule or
gitlink.

The npm package is the immutable distribution artifact used by deployable
services. Those two authorities must not be confused:

- change and review the next package source in `common/`;
- build service images against the exact published `@betstan/common` version
  recorded in each service's `package.json` and `package-lock.json`;
- never make a service depend on `file:../common`, a workspace link, a
  symlink, or an unpacked developer directory.

The source tree may therefore be ahead of the package installed by services.
Always report both versions when reviewing a shared-contract change.

## Version ownership

npm versions are immutable. After a version has been published, bump
`common/package.json` and `common/package-lock.json` before making the first
source change for the next package candidate. Never leave changed source
claiming an already-published version: a local tarball would then have the same
name as a different registry artifact.

Use exact prerelease versions while compatibility is being proven. Publish a
prerelease under the `next` dist-tag; do not move `latest` until the stable
release is intentionally approved.

All backend consumers must use the same exact version without `^`, `~`,
`latest`, `next`, `file:`, or workspace ranges:

- `auth`
- `backoffice`
- `bet`
- `event`
- `gamemaster`
- `moderation`
- `resulting`
- `slip`

## Compatibility contract

Shared messages cross independently deployed services, so a source-compatible
TypeScript change is not sufficient by itself.

- Prefer additive optional fields. Old payloads and stored data must remain
  valid when the field is absent.
- Preserve every existing export and the exact runtime value of existing enum
  members. Do not rename, renumber, or reuse a wire value.
- Unknown additive JSON fields must be safe for old consumers to ignore.
- New consumers must define an explicit fallback for old producers and
  historical records.
- Keep message identity and ordering semantics stable. In live betting,
  `marketId + marketVersion` identifies settlement authority, while
  `quoteVersion` validates price freshness.
- Keep the legacy `APublisher.publish()` behavior stable. Confirmed persistent
  publication remains an explicit opt-in through `publishWithConfirm()`.
- Keep AMQP APIs structural through `IAmqpConnection`; services intentionally
  compile with compatible but not necessarily identical AMQP type packages.

A temporary service-local compatibility bridge may expose additive runtime
wire values while services remain pinned to an older published package. It
must not become a second source of truth: add the value to `common/src/` in the
same feature, keep the bridge narrow, and remove it when consumers move to the
published package that contains the value.

## Change and validation workflow

1. Read this file, the installed package declarations, every affected
   producer and consumer, and the exact service pins.
2. Update `common/src/` and `common/src/index.ts` together.
3. Add compile-time fixtures for old/new assignability and runtime tests for
   exports, enum values, publishers, listeners, and middleware as applicable.
4. Run from `common/`:

   ```bash
   npm ci
   npm test
   npm pack --json --pack-destination /absolute/private/artifact/directory
   ```

   If the shared npm cache has ownership problems, use a session-local
   `--cache` directory. Do not repair a shared cache with broad permission
   changes or deletion.
5. Inspect the packed file list and record the exact source commit, npm
   `shasum`, integrity value, and an independent SHA-256 of the tarball.
6. Test every affected service from a lock-exact `npm ci`. To test an
   unpublished tarball, unpack it and replace only that isolated copy's
   `node_modules/@betstan/common`. Do not use `npm install --no-save <tarball>`;
   npm may re-resolve unrelated TypeScript, Mongoose, or transitive
   dependencies and invalidate the comparison.
7. Exercise the rolling matrix: old producer/new consumer, new producer/old
   consumer, restart from historical data, and rollback to the prior package.
8. Publish only the reviewed tarball and only with explicit package-release
   authorization. Download the registry tarball afterward and require its
   SHA-256 to match the reviewed artifact.
9. Update all eight services to the exact published version in one coordinated
   change, refresh their lockfiles intentionally, run clean-registry
   `npm ci`, and execute the affected service and cross-service tests.

Publishing the package and repinning services are separate release steps.
Source existing in `common/` does not make an unpublished contract available
inside independently built service images.

## Review checklist

- `git ls-tree HEAD common` reports mode `040000`, never `160000`.
- No `.gitmodules` entry or nested `common/.git` exists.
- Source version identifies the next package candidate rather than colliding
  with immutable registry content.
- All eight service manifests and lockfiles use one exact published version.
- The packed artifact contains only the intended `build/**`, npm-required
  package metadata, and this README.
- Legacy runtime exports and enum values still match `1.0.54`.
- Immediate published-predecessor payloads remain assignable to the source
  candidate.
- Every affected service passes against the exact packed or published
  artifact without changing unrelated dependency resolution.
