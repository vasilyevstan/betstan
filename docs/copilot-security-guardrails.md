# Copilot Security Guardrails

This repository allows Copilot-assisted work. These rules keep automation useful and safe for a public repository.

## 1. Never commit sensitive information

Do **not** commit any of the following:

- API keys, tokens, passwords, cookies, session IDs
- kubeconfigs, private certificates, private keys, SSH keys
- cloud credentials, connection strings, signing secrets
- internal-only URLs, private hostnames, or customer-identifying data

If sensitive data appears in local output, logs, screenshots, or examples, redact it before commit.

## 2. Safe logs, screenshots, and examples

- Do not paste full production logs in commits or docs.
- Use synthetic/sample values in examples.
- Avoid including auth headers, bearer tokens, secret query params, or private IPs.
- Keep screenshots limited to UI states; avoid exposing secrets in dev tools or terminals.

## 3. Copilot setup workflow rules

- Keep `.github/workflows/copilot-setup-steps.yml` deterministic and minimal.
- Use least privileges (for now: `contents: read`).
- Store secrets only in GitHub environment/repository secrets, never inline in YAML.
- Keep setup focused on tool/dependency bootstrap (no secret-bearing deployment steps).

## 4. Pre-push hygiene checklist

Before pushing:

1. Confirm file scope: only intended files are staged.
2. Run a quick secret check on staged changes (tokens/keys/password patterns).
3. Verify no sensitive content in newly added docs/assets.
4. Confirm the destination branch follows `CONTRIBUTING.md`: normal work targets `dev`; only `dev` may target `master`.
5. Push only after all above checks pass.

Never commit or push directly to `master`. Production promotion and emergency workflow dispatches require explicit approval for the exact SHA and complete production workflow set.

## 5. Incident handling

If sensitive data is committed by mistake:

1. Stop and notify maintainers immediately.
2. Revoke/rotate exposed secrets first.
3. Remove the data from repository history using approved maintainer workflow.
4. Document the incident and prevention update in this guardrail doc.
