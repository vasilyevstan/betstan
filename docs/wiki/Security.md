# Security

## Security model

BetStan is a public web application with a browser-facing edge, authenticated
player workflows, an intentionally public Backoffice, internal services, a
message broker, persistent data, and a protected delivery pipeline.

Security is divided into five boundaries:

1. browser and public HTTP edge;
2. identity and session trust;
3. service-to-service data and message integrity;
4. runtime network and secret isolation;
5. source, build, and deployment provenance.

## Identity and sessions

- Passwords are derived with `scrypt` and a random per-password salt.
- Login creates a signed JWT carried in the application session cookie.
- Backend middleware verifies the JWT before attaching a current user.
- User-scoped slips and bet history are queried by the verified user ID.
- Session freshness and role changes are rechecked by Auth for privileged
  acceptance-only operations.
- Client-side visibility is never treated as an authorization boundary.

The shared JWT signing material is supplied from protected runtime secrets and
is not stored in source or documentation.

## Public Backoffice boundary

Backoffice is intentionally public in the current product. Anonymous,
ordinary, roleless, and administrator sessions reach the same catalog and
event controls.

This means its safety model is not "hide the button" or "trust a role claim."
Instead, the service applies:

- strict input shape and length bounds;
- explicit validation of event identifiers, times, visibility, and scores;
- rejection of blank or malformed scores;
- atomic one-time terminal result writes;
- idempotent retries and conflict detection;
- durable publication markers and broker confirmation;
- replay after restart;
- explicit public response serialization;
- `Cache-Control: no-store`.

The separate administrator role is retained for narrow production-acceptance
access to explicitly scoped offline synthetic events. That path is
server-verified against current Auth state.

## Betting integrity

- Live and pre-match rows cannot be mixed in one submitted slip.
- The server validates event phase, market status, market version, quote
  version, quote expiry, and selection identity.
- A board revision and fingerprint bind placement to the board the user saw.
- A placement attempt ID makes retries idempotent and exposes conflicting
  reuse.
- Settlement is driven by authoritative event and market outcomes, not client
  state.
- Sequence and terminal guards prevent stale updates from reopening or
  rewriting completed outcomes.

## Message and data integrity

- Critical publishers wait for RabbitMQ confirmation.
- Mutation state and pending-publication state are persisted together.
- Consumers are duplicate-safe and persist before acknowledging.
- Services park valid out-of-order updates and replay them after the parent
  record appears.
- Each service owns a separate logical database even though production shares
  one MongoDB runtime.
- Backward-compatible optional fields allow old and new service versions to
  overlap safely during rollout.

## Runtime security

- Public traffic enters through TLS termination and ingress routing.
- MongoDB and RabbitMQ are internal-only services.
- The runtime pulls immutable application images by digest.
- Application images are publicly readable from GHCR, so the cluster does not
  need a long-lived registry credential.
- Cloud, cluster, signing, and deployment credentials are stored in protected
  GitHub secrets or environment-scoped controls.
- Imported cluster configuration is treated as untrusted input and reduced to
  the minimum required connection material before use.

## Software supply chain

- Production code reaches `master` only through the reviewed `dev` promotion
  path.
- Trusted checks bind review evidence to the exact pull-request head and merge
  snapshot.
- Builds and deployments use exact source SHAs and immutable image digests.
- A failed first-attempt release cannot become trusted by rerunning it when
  downstream provenance requires the first attempt.
- Deployment validates the digest actually running in each workload, not only
  a successful rollout command.
- Rollback uses a previously captured, matching baseline and runs readiness
  checks before mutation.

## Secure engineering controls

- Authentication changes require the auth/security specialist.
- Shared contract changes require a service-boundary compatibility review.
- User-facing changes require the UX/UI specialist and rendered evidence when
  geometry or interaction is material.
- Infrastructure changes run syntax, manifest, secret-pattern, routing,
  provenance, and rollback contract tests.
- Production acceptance checks public behavior, APIs, live updates,
  settlement, logs, queues, and workload health.

See [[Quality Gates]] and [[Agents]] for the complete review model.

## Public documentation policy

This wiki is public. It should make the design understandable without turning
operational safeguards into a bypass guide.

| Safe to publish | Keep private |
|---|---|
| Product behavior and supported user journeys | Passwords, tokens, cookies, private keys, kubeconfigs, or secret values |
| Service responsibilities and logical data ownership | Cloud account, tenant, resource, cluster, or private network identifiers |
| Logical message names and high-level data flow | Private approval records, authority files, dispatch payloads, or recovery state |
| Security properties and trust boundaries | Exact emergency commands or step-by-step control-bypass procedures |
| Test categories, coverage thresholds, and release phases | Live infrastructure addresses, internal-only endpoints, or unredacted logs |
| General failure lessons and safe design patterns | Operational timing windows, queue thresholds, or incident details that aid abuse |
| Public repository paths and reviewed source links | Local session paths, user-specific filesystem paths, or private artifacts |

Examples and diagrams must use synthetic labels. Screenshots must not contain
tokens, cookies, headers, private logs, personal information, or terminal
output with credentials.

## Related pages

- [[Architecture]]
- [[Infrastructure]]
- [[Quality Gates]]
- [[Release Orchestration]]
- [[Engineering Learnings]]
