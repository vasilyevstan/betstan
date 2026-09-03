#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OCI_DIR="$ROOT_DIR/infra/oci"
WORK_DIR="$OCI_DIR/tests/.contract-work"

fail() {
  echo "OCI contract failure: $*" >&2
  exit 1
}

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/provenance"
trap 'rm -rf "$WORK_DIR"' EXIT

command -v ruby >/dev/null 2>&1 || fail "ruby is required"
command -v python3 >/dev/null 2>&1 || fail "python3 is required"
command -v jq >/dev/null 2>&1 || fail "jq is required"
command -v kubectl >/dev/null 2>&1 || fail "kubectl is required"

while IFS= read -r script; do
  bash -n "$script"
done < <(find "$OCI_DIR" -type f -name '*.sh' | sort)
PYTHONPYCACHEPREFIX="$WORK_DIR/pycache" \
  python3 -m py_compile "$OCI_DIR/agents/health-contract.py"
node --check "$OCI_DIR/agents/playwright.config.js"
node --check "$OCI_DIR/agents/oci-live-smoke.spec.js"
node --check "$OCI_DIR/agents/playwright-live-acceptance.config.js"
node --check "$OCI_DIR/agents/oci-live-acceptance.spec.js"
grep -Fq "'betstan-e2e-protected-v2'" "$OCI_DIR/agents/oci-live-smoke.spec.js" ||
  fail "OCI browser check does not reuse the dedicated E2E account"
grep -Fq 'process.env.LIVE_ACCEPTANCE_PASSWORD' \
  "$OCI_DIR/agents/oci-live-smoke.spec.js" ||
  fail "OCI browser check does not require the protected E2E credential"
grep -Fq 'password.length < 4 || password.length > 20' \
  "$OCI_DIR/agents/oci-live-smoke.spec.js" ||
  fail "OCI browser check does not enforce the signup password contract"
! grep -Fq "'test1234'" "$OCI_DIR/agents/oci-live-smoke.spec.js" ||
  fail "OCI browser check exposes the reusable account password"
! grep -Fq 'process.env.LIVE_ACCEPTANCE_PASSWORD ||' \
  "$OCI_DIR/agents/oci-live-smoke.spec.js" ||
  fail "OCI browser check still has a source credential fallback"
grep -Fq "page.request.post('/api/auth/login'" \
  "$OCI_DIR/agents/oci-live-smoke.spec.js" ||
  fail "OCI browser check does not resolve the reusable account by login"
grep -Fq "page.request.post('/api/auth/new'" \
  "$OCI_DIR/agents/oci-live-smoke.spec.js" ||
  fail "OCI browser check does not create the reusable account through the API"
grep -Fq "passwordInput.fill('')" \
  "$OCI_DIR/agents/oci-live-smoke.spec.js" ||
  fail "OCI browser check does not clear a failed UI-login password"
! grep -Fq "getByTitle('Create account').click()" \
  "$OCI_DIR/agents/oci-live-smoke.spec.js" ||
  fail "OCI browser check can still truncate the protected password in the signup form"
! grep -Eq 'Date\.now\(\)|Math\.random\(\)' \
  "$OCI_DIR/agents/oci-live-smoke.spec.js" ||
  fail "OCI browser check still creates per-run user identities"
grep -Fq "getByRole('link', { name: 'BetStan', exact: true })" \
  "$OCI_DIR/agents/oci-live-smoke.spec.js" ||
  fail "OCI browser check does not use the accessible BetStan brand"
if grep -Fq "locator('body')).toContainText('BetStan')" \
    "$OCI_DIR/agents/oci-live-smoke.spec.js"; then
  fail "OCI browser check still relies on image alt text appearing in body text"
fi
acceptance_spec="$OCI_DIR/agents/oci-live-acceptance.spec.js"
grep -Fq 'const publicContext = await browser.newContext({' "$acceptance_spec" &&
  grep -Fq 'baseURL: process.env.E2E_BASE_URL' "$acceptance_spec" ||
  fail "OCI live acceptance public context is not bound to the configured base URL"
grep -Fq "passwordInput.fill('')" "$acceptance_spec" ||
  fail "OCI live acceptance does not clear a failed UI-login password"
grep -Fq "new URL(response.url()).pathname === '/api/auth/login'" \
  "$acceptance_spec" ||
  fail "OCI live acceptance does not bind login to the exact API response"
grep -Fq '}, acceptanceEventIds);' "$acceptance_spec" ||
  fail "OCI live acceptance does not pass scoped event IDs into the browser context"
grep -Fq "publicContext.request.get('/api/backoffice')" "$acceptance_spec" &&
  grep -Fq 'expect(publicBackoffice.status()).toBe(401)' "$acceptance_spec" ||
  fail "OCI live acceptance does not prove anonymous backoffice reads fail closed"
grep -Fq 'const publicBackofficeLink = publicPage.getByTitle' "$acceptance_spec" &&
  grep -Fq 'await expect(publicBackofficeLink).toBeVisible()' "$acceptance_spec" &&
  grep -Fq 'Log in with an administrator account to use Backoffice.' "$acceptance_spec" ||
  fail "OCI live acceptance does not prove public Backoffice navigation remains available"
  grep -Fq "pathname === '/api/event/stream'" "$acceptance_spec" &&
    grep -Fq '!expectedStreamDisconnect' "$acceptance_spec" ||
    fail "OCI live acceptance treats expected long-lived SSE disconnects as API failures"
grep -Fq 'const LIVE_FIXTURE_KICKOFF_DELAY_SECONDS = 90;' "$acceptance_spec" &&
  [[ "$(grep -Fc 'kickoffDelaySeconds: LIVE_FIXTURE_KICKOFF_DELAY_SECONDS' "$acceptance_spec")" -eq 2 ]] ||
  fail "OCI live acceptance does not start both live fixtures together"
for countdown_contract in \
    "{ marketType: 'KICKOFF_TEAM', label: 'Kickoff Team' }" \
    "{ marketType: 'FIRST_MINUTE_GOAL', label: 'Goal in First Minute' }" \
    '...COUNTDOWN_MARKETS.map(({ marketType }) => marketType),' \
    'LIVE_MARKETS.length,' \
    'await expect(article.getByText(label, { exact: true })).toHaveCount(0);' \
    ').toEqual([...ALL_LIVE_MARKET_TYPES].sort());'; do
  grep -Fq "$countdown_contract" "$acceptance_spec" ||
    fail "OCI live acceptance omits countdown-market coverage: $countdown_contract"
done
if grep -Fq 'ALL_LIVE_MARKET_TYPES.length,' "$acceptance_spec"; then
  fail "OCI live acceptance still expects terminal countdown markets to remain visible after kickoff"
fi
for selection_contract in \
    'const RETRYABLE_LIVE_SELECTION_ERRORS = new Set([' \
    "'Live quote is stale'" \
    "'Market version mismatch'" \
    'const response = await responsePromise;' \
    'if (response.ok()) {' \
    'row.marketVersion === acceptedQuote.marketVersion' \
    'row.quoteVersion === acceptedQuote.quoteVersion' \
    'row.selectionId === acceptedQuote.selectionId' \
    'const MAX_LIVE_PLACEMENT_ATTEMPTS = 5;' \
    "expect(submittedLiveBet.declineReason).toBe('STALE_QUOTE');" \
    "submittedLiveBet.rows.some((row) => row.declineReason === 'STALE_QUOTE')," \
    'declinedLiveSlipIds.push(liveSlipId);' \
    ').toBe(`DRAFT:${liveSlipId}`);' \
    'expect(selectedBoards.LIVE.rows).toHaveLength(LIVE_MARKETS.length * 2);' \
    'await liveBoard.getByRole('\''button'\'', { name: '\''CLEAN'\'' }).click();' \
    'expect(liveBet.rows).toHaveLength(EXPECTED_LIVE_SETTLEMENT_ROWS);'; do
  grep -Fq "$selection_contract" "$acceptance_spec" ||
    fail "OCI live acceptance omits moving-quote selection contract: $selection_contract"
done
for phase in FIRST_HALF_STOPPAGE SECOND_HALF_STOPPAGE; do
  grep -Fq "'$phase'" "$acceptance_spec" ||
    fail "OCI live acceptance omits runtime phase $phase"
done
if grep -Fq "'STOPPAGE_TIME'" "$acceptance_spec"; then
  fail "OCI live acceptance asserts a phase that the runtime never emits"
fi

lessons="$OCI_DIR/LESSONS_LEARNED.md"
[[ -f "$lessons" ]] || fail "OCI lessons file is missing"
for lesson in \
    "approval wait is an active workflow state" \
    "OCI deletion and registry layer reclamation are asynchronous" \
    "target-loopback tunnel" \
    "No retained backup or old-OCI rollback exists" \
    "Mongo \`fsyncLock\` is process-local" \
    "application rollout does not prove that asynchronous RabbitMQ" \
    "Pre-commit public checks must be read-only" \
    "Never return a blind \`NO_GO\`" \
    "A workflow-dispatch URL is not job materialization" \
    "\`pull_request.edited\`" \
    "A late advisory verdict is stale until revalidated"; do
    grep -Fq "$lesson" "$lessons" ||
      fail "OCI lessons omit required recovery guidance: $lesson"
done
for agent in \
    betstan-migration-recovery \
    betstan-domain-ingress \
    betstan-azure-retirement; do
    agent_file="$ROOT_DIR/.github/agents/${agent}.agent.md"
    [[ -f "$agent_file" ]] || fail "required recovery agent is missing: $agent"
    grep -Fq "infra/oci/LESSONS_LEARNED.md" "$agent_file" ||
      fail "recovery agent does not read OCI lessons: $agent"
done
conductor_agent="$ROOT_DIR/.github/agents/betstan-conductor.agent.md"
agent_readme="$ROOT_DIR/.github/agents/README.md"
[[ -f "$conductor_agent" ]] || fail "required conductor agent is missing"
grep -Fq 'name: betstan-conductor' "$conductor_agent" ||
  fail "conductor agent frontmatter has the wrong name"
grep -Fq 'tools: [read, search, execute, edit, web]' "$conductor_agent" ||
  fail "conductor agent lacks governed self-blocker correction authority"
for conductor_contract in \
    'Do not tight-poll' \
    'blocking watcher such as `gh run watch` as notification transport' \
    'Its continued execution is not a progress signal' \
    'A user request for status or a suspicion that work is stuck is an immediate' \
    'Never become passive after launch' \
    'maximum wall-clock checkpoint' \
    'Reconstruct observation from the registry after interruption' \
    'A terminal unit without a confirmed downstream handoff is a stall' \
    'must never answer a detected stall with observation alone' \
    'Raw tool-call growth alone is not deliverable progress' \
    'critical-path scope freeze' \
    'Treat a pull request metadata edit as workflow-producing' \
    'Revalidate every late specialist result' \
    'A workflow dispatch URL is not job materialization' \
    'A jobless queued dispatch with zero jobs and zero pending approvals' \
    'zero completed turns after its first-response deadline' \
    'stop further investigation and return the bounded verdict' \
    'Continue dependency-safe work immediately' \
    'Do not extend a checkpoint without new underlying progress evidence' \
    'At the second missed checkpoint, escalate the same registered unit' \
    '`ORCHESTRATION_HEALTHY` is forbidden while a checkpoint is overdue' \
    '`ORCHESTRATION_COMPLETE` requires terminal evidence and accepted handoff' \
    'completed deploy job' \
    'waiting public-validation job is an approval-bound gate' \
    "defer that handoff behind the watcher's timeout" \
    'A running agent with recent tool activity is observable' \
    'Enforce its first-response deadline' \
    'A GitHub environment approval wait is active external work' \
    'inspect both jobs and `pending_deployments` immediately' \
    'have documented preauthorization, immediately return' \
    'After two missed checkpoints, return' \
    'a duplicate reviewer merely because the first is slow' \
    'terminal or explicitly cancelled and prove that concurrent side effects' \
    'Treat a completed first-attempt-only run failure as terminal, not stalled' \
    'If downstream provenance requires' \
    'never recommend rerunning that run' \
    'report `BLOCKED` rather than manufacture an empty' \
    'Never bypass a trusted publisher that rejects changes to its own' \
    'leaves a production maintenance fence, operation' \
    'health recovery precedes candidate replacement' \
    'terminal learning and documentation unit' \
    'one two-phase specialist work unit for' \
    'duration for the same workflow and job on a comparable runner' \
    'Never use name-based process discovery or termination' \
    'Conductor status is coordination evidence only'; do
  grep -Fq "$conductor_contract" "$conductor_agent" ||
    fail "conductor agent omits orchestration contract: $conductor_contract"
done
for self_blocker_contract in \
    '## Governed self-imposed-blocker recovery' \
    'external wait, passively wait, or repeatedly hand it off' \
    'governed correction under the original registered work ID' \
    'another agent or a duplicate policy page' \
    'focused safe fixture or dry-run' \
    'unresolved production risk: active or competing work' \
    'normal focused branch -> `dev` -> `master` path' \
    '`mutation_capable: true` only' \
    'challenge through the existing deployment-safety quality gate, not a new' \
    'Preserve rollback evidence and revalidate the' \
    'resume the original registered' \
    'Never bypass or edit live authority state ad hoc' \
    'Never weaken a gate merely to make progress'; do
  grep -Fq "$self_blocker_contract" "$conductor_agent" ||
    fail "conductor omits governed self-blocker contract: $self_blocker_contract"
done
grep -Fq 'Start `betstan-conductor` before every unit whose result can block, approve,' \
    "$agent_readme" ||
  fail "agent workflow does not require universal authority-bearing registration"
agent_readme_flat="$(tr '\n' ' ' <"$agent_readme")"
grep -Fq 'Two missed checkpoints require an explicit safe recovery' \
    <<<"$agent_readme_flat" ||
  fail "agent workflow lacks stalled-work escalation"
grep -Fq 'the conductor checks jobs plus `pending_deployments`' \
    <<<"$agent_readme_flat" ||
  fail "agent workflow can leave protected environment gates unattended"
grep -Fq 'A still-running `gh run watch` is notification transport, not evidence of progress' \
    <<<"$agent_readme_flat" ||
  fail "agent workflow can mistake a blocking watcher for progress"
grep -Fq 'A user asking for status or whether work is stuck triggers that checkpoint immediately' \
    <<<"$agent_readme_flat" ||
  fail "agent workflow does not force an immediate checkpoint on status requests"
grep -Fq 'A GitHub `waiting` state is an action trigger, not a polling state.' \
    "$conductor_agent" ||
  fail "conductor can leave an actionable protected gate in passive polling"
grep -Fq 'copilot-cli-run-approval-stan.sh --approve' "$conductor_agent" ||
  fail "conductor does not route eligible CLI-owned waiting gates to automatic approval"
grep -Fq 'remains proactive from before a registered job starts through its terminal evidence and accepted downstream handoff' \
    <<<"$agent_readme_flat" ||
  fail "agent workflow does not retain start-to-terminal conductor ownership"
grep -Fq 'Every event trigger is paired with a maximum wall-clock checkpoint' \
    <<<"$agent_readme_flat" ||
  fail "agent workflow permits an event-only indefinite wait"
grep -Fq 'completed unit with no confirmed next-owner handoff is itself a stall' \
    <<<"$agent_readme_flat" ||
  fail "agent workflow can stall between completion and handoff"
grep -Fq 'workflow dispatch URL is acceptance, not materialization' \
    <<<"$agent_readme_flat" ||
  fail "agent workflow can disable a manual workflow before job materialization"
grep -Fq 'Pull-request metadata edits are workflow-producing' \
    <<<"$agent_readme_flat" ||
  fail "agent workflow ignores pull-request edit triggers"
grep -Fq 'terminal documentation handoff' <<<"$agent_readme_flat" ||
  fail "agent workflow can complete before required durable learning"
grep -Fq 'At the second missed checkpoint it escalates the same unit' \
    <<<"$agent_readme_flat" ||
  fail "agent workflow can replace or indefinitely defer stalled work"
grep -Fq 'orchestration completes only when every registered unit has terminal evidence and an accepted handoff' \
    <<<"$agent_readme_flat" ||
  fail "agent workflow permits premature orchestration completion"
grep -Fq 'terminal job followed by a downstream `waiting` job with no executing step' \
    <<<"$agent_readme_flat" ||
  fail "agent workflow can miss a downstream protected-environment gate"
grep -Fq 'A failed release run whose consumers require `run_attempt == 1` is terminal' \
    <<<"$agent_readme_flat" ||
  fail "agent workflow can rerun terminal first-attempt release evidence"
grep -Fq 'It never invents an empty commit or bypasses a trusted publisher' \
    <<<"$agent_readme_flat" ||
  fail "agent workflow can bypass trusted publication to replace a failed run"
grep -Fq 'treats that state as an active production incident' \
    <<<"$agent_readme_flat" ||
  fail "agent workflow can leave a failed release maintenance hold unattended"
ux_agent="$ROOT_DIR/.github/agents/betstan-ux-ui-expert.agent.md"
ux_wiki="$ROOT_DIR/docs/wiki/UI-UX-Consistency.md"
ux_home="$ROOT_DIR/docs/wiki/Home.md"
ux_release_wiki="$ROOT_DIR/docs/wiki/Release-Orchestration.md"
ux_backend_agent="$ROOT_DIR/.github/agents/betstan-backend-developer.agent.md"
ux_frontend_agent="$ROOT_DIR/.github/agents/betstan-frontend-developer.agent.md"
ux_critic_agent="$ROOT_DIR/.github/agents/betstan-validation-critic.agent.md"
ux_test_agent="$ROOT_DIR/.github/agents/betstan-test-engineer.agent.md"
ux_final_agent="$ROOT_DIR/.github/agents/betstan-final-validator.agent.md"
[[ -f "$ux_agent" ]] || fail "required UX/UI expert agent is missing"
[[ -f "$ux_wiki" ]] || fail "canonical UI/UX consistency wiki page is missing"
[[ -f "$ux_backend_agent" ]] || fail "backend developer agent is missing"
[[ -f "$ux_frontend_agent" ]] || fail "frontend developer agent is missing"
grep -Fq 'name: betstan-ux-ui-expert' "$ux_agent" ||
  fail "UX/UI expert frontmatter has the wrong name"
grep -Fq 'tools: [read, search]' "$ux_agent" ||
  fail "UX/UI expert does not remain read-only"
if grep -Eq '^tools:.*execute' "$ux_agent"; then
  fail "UX/UI expert exposes mutation-capable command execution"
fi
ux_agent_flat="$(tr '\n' ' ' <"$ux_agent")"
for ux_contract in \
    'Never infer usability from screenshots alone' \
    'all three UI variants and both themes' \
    'Preserve DOM, reading, and keyboard order' \
    'live updates do not steal focus' \
    'Establish a named design-consistency baseline' \
    'Produce one cross-route, state, variant, theme, and responsive-mode' \
    'consistency matrix. Compare hierarchy and typography' \
    'intentional product exception' \
    'required consistency fix' \
    'Do not require a new automated visual-regression matrix' \
    'Define measurable rendered acceptance criteria' \
    'When layout or geometry is affected or remains unresolved' \
    'When overflow or clipping is in scope or remains unresolved' \
    'For event-grid changes' \
    'For market-control changes' \
    'UX_REVIEW_PASSED' \
    'Hand implementation to the registered developer-gate owner for the affected paths' \
    '`betstan-backend-developer` for user-visible producer, formatter, ordering, or contract work' \
    'return the UX status to the registered developer-gate implementation owner'; do
  grep -Fq "$ux_contract" <<<"$ux_agent_flat" ||
    fail "UX/UI expert omits usability contract: $ux_contract"
done
for unconditional_rendered_gate in \
    '- Require bounding-box checks for sibling-card and child-control collisions' \
    '- Check `scrollWidth` against `clientWidth` for the document and affected'; do
  if grep -Fq -- "$unconditional_rendered_gate" "$ux_agent"; then
    fail "UX/UI expert makes rendered evidence unconditional: $unconditional_rendered_gate"
  fi
done
grep -Fq '`betstan-ux-ui-expert` is mandatory for every user-facing visual or interaction change' \
    <<<"$agent_readme_flat" ||
  fail "agent workflow does not require UX review for every user-facing change"
grep -Fq 'Register one two-phase specialist work unit' \
    <<<"$agent_readme_flat" ||
  fail "agent workflow duplicates or omits the two-phase UX specialist handoff"
grep -Fq 'Every user-facing change has one exact-head `UX_REVIEW_PASSED` result' \
    <<<"$agent_readme_flat" ||
  fail "agent workflow does not require exact-head UX consistency evidence"
grep -Fq 'Every change that alters what a user sees or how a user interacts requires' \
    "$ux_wiki" ||
  fail "UI/UX consistency wiki omits the mandatory trigger"
grep -Fq 'A user-facing change does not automatically require a new screenshot baseline' \
    "$ux_wiki" ||
  fail "UI/UX consistency wiki turns visual tests into a blanket gate"
grep -Fq '[[UI UX Consistency]]' "$ux_home" ||
  fail "wiki Home does not link the UI/UX consistency contract"
grep -Fq '`betstan-ux-ui-expert` is mandatory for every user-facing visual or' \
    "$ux_release_wiki" ||
  fail "release orchestration omits the mandatory UX handoff"
backend_agent_flat="$(tr '\n' ' ' <"$ux_backend_agent")"
grep -Fq 'include its `UX_REVIEW_PASSED` result when handing off to `betstan-validation-critic`' \
    <<<"$backend_agent_flat" ||
  fail "backend developer does not carry applicable UX evidence into the critic handoff"
frontend_agent_flat="$(tr '\n' ' ' <"$ux_frontend_agent")"
grep -Fq 'include its `UX_REVIEW_PASSED` result when handing off to `betstan-validation-critic`' \
    <<<"$frontend_agent_flat" ||
  fail "frontend developer does not carry UX evidence into the critic handoff"
grep -Fq 'Missing or stale UX evidence is an acceptance' \
    "$ux_critic_agent" ||
  fail "validation critic does not identify missing UX evidence"
grep -Fq 'gap. Do not replace the UX specialist with subjective style review' \
    "$ux_critic_agent" ||
  fail "validation critic does not fail missing UX evidence"
grep -Fq 'Do not add or require a screenshot/image-diff matrix' "$ux_test_agent" ||
  fail "test engineer turns user-facing work into a blanket visual-test gate"
test_agent_flat="$(tr '\n' ' ' <"$ux_test_agent")"
grep -Fq 'set or clear `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT` explicitly' \
    <<<"$test_agent_flat" ||
  fail "test engineer does not isolate first-attempt fixtures from ambient CI metadata"
grep -Fq '`betstan-ux-ui-expert: UX_REVIEW_PASSED` result' "$ux_final_agent" ||
  fail "final validator does not require exact-head UX evidence"
grep -Fq '### Product-wide UI/UX consistency' "$ROOT_DIR/LEARNINGS.md" ||
  fail "durable learning omits the product-wide UI/UX consistency contract"
for ux_reinforced_check in \
    'Cross-card baseline drift' \
    'Selection tokens versus event identity' \
    'Centered sibling market headings' \
    'Stable, non-volatile board order with exact ID preservation' \
    'Coupled-market plausibility' \
    'Publicly discoverable protected navigation in every UI variant' \
    'Single-live-card width and relative-height budget' \
    'Phantom auto-fill tracks' \
    'Equal-height market groups' \
    'Readable status words' \
    'Nested-board content fit in every card context' \
    'Section heading spans its product group'; do
  grep -Fq "$ux_reinforced_check" "$ux_agent" ||
    fail "UX/UI expert omits reinforced consistency check: $ux_reinforced_check"
done
grep -Fq 'For live-history and presentation-order changes, prove producer-attested' \
    "$ux_test_agent" ||
  fail "test engineer omits live-history/presentation-order coverage requirements"
grep -Fq 'For semantic-control and layout changes, prove accessible names remain' \
    "$ux_test_agent" ||
  fail "test engineer omits semantic-control/computed-geometry coverage requirements"
for critic_reinforced_check in \
    'False `Full timeline` completeness claims' \
    'Exact linked-incident deduplication' \
    'Equal-sequence monotonic history merges' \
    'Terminal result/`FULL_TIME` interleavings' \
    'Fail-dark terminal placeholders' \
    'Unresolved-auth retained `OFFLINE` data' \
    'Presentation ordering that changes selection identity' \
    'Hidden or icon-only protected navigation' \
    'Cross-card computed-geometry regressions'; do
  grep -Fq "$critic_reinforced_check" "$ux_critic_agent" ||
    fail "validation critic omits reinforced finding: $critic_reinforced_check"
done
grep -Fq 'When output changes public presentation ordering or exposes a' \
    "$ux_backend_agent" ||
  fail "backend developer omits public-ordering/completeness handoff evidence"
grep -Fq 'Keep terminal Event placeholders fail-dark' "$ux_backend_agent" ||
  fail "backend developer omits unresolved terminal placeholder safety"
grep -Fq 'Every terminal visibility writer and recovery path' "$ux_backend_agent" ||
  fail "backend developer omits atomic terminal recovery safety"
grep -Fq 'including one with pending `ONLINE` intent, remains `OFFLINE`' \
    <<<"$test_agent_flat" ||
  fail "test engineer omits fail-dark terminal placeholder coverage"
grep -Fq 'exact-ID-preservation evidence' \
    "$ux_frontend_agent" ||
  fail "frontend developer omits semantic-control-label/exact-ID handoff evidence"
grep -Fq '### Live timeline completeness and market alignment' "$ROOT_DIR/LEARNINGS.md" ||
  fail "durable learning omits the live timeline completeness and market alignment contract"
grep -Fq 'Superseded narrow-live-card rule' "$ROOT_DIR/LEARNINGS.md" ||
  fail "durable learning does not supersede the earlier narrow-live-card rule"
grep -Fq 'cross-card baseline drift: a sibling' "$ux_wiki" ||
  fail "UI/UX consistency wiki omits the cross-card baseline drift example"
grep -Fq 'phantom sparse-grid tracks' "$ux_wiki" ||
  fail "UI/UX consistency wiki omits the phantom sparse-grid tracks example"
ux_live_prod_wiki="$ROOT_DIR/docs/wiki/Live-Betting-Production.md"
[[ -f "$ux_live_prod_wiki" ]] || fail "live-betting production wiki is missing"
grep -Fq '## Timeline completeness and terminal safeguards' "$ux_live_prod_wiki" ||
  fail "live-betting production wiki omits the timeline completeness safeguards section"
grep -Fq 'is an optional, additive' "$ux_live_prod_wiki" ||
  fail "live-betting production wiki omits the producer attestation contract"
grep -Fq 'placeholder remains fail-dark' "$ux_live_prod_wiki" ||
  fail "live-betting production wiki omits unresolved terminal placeholder safety"
grep -Fq 'GITHUB_RUN_ATTEMPT' "$ROOT_DIR/infra/azure/agents/README.md" ||
  fail "Azure guidance omits first-attempt fixture isolation"
grep -Fq 'recent successful runs of the same' \
    "$ROOT_DIR/infra/oci/LESSONS_LEARNED.md" ||
  fail "OCI lessons omit recent successful duration evidence"
grep -Fq 'workflow and job on a comparable runner' \
    "$ROOT_DIR/infra/oci/LESSONS_LEARNED.md" ||
  fail "OCI lessons omit historical-duration-aware stall classification"
ghcr_fixture_head="$(sed -n '1,80p' "$OCI_DIR/tests/test-ghcr-contract.sh")"
grep -Fq '"GITHUB_RUN_ID=777"' <<<"$ghcr_fixture_head" ||
  fail "GHCR contract fixture does not isolate the run ID"
grep -Fq '"GITHUB_RUN_ATTEMPT=1"' <<<"$ghcr_fixture_head" ||
  fail "GHCR contract fixture inherits ambient workflow rerun metadata"
grep -Fq "A run waiting for environment approval is active, not hung" \
    "$ROOT_DIR/.github/agents/betstan-migration-recovery.agent.md" ||
    fail "migration recovery agent can misclassify approval waits"
grep -Fq "After \`cutover-committed\`, never retry from Azure" \
    "$ROOT_DIR/.github/agents/betstan-migration-recovery.agent.md" ||
    fail "migration recovery agent can roll back a committed cutover"
grep -Fq "controller-level HTTP mutation fence" \
    "$ROOT_DIR/.github/agents/betstan-migration-recovery.agent.md" ||
    fail "migration recovery agent does not preserve the restart-safe HTTP fence"
grep -Fq "remove the exact 17 application bindings" \
    "$ROOT_DIR/.github/agents/betstan-migration-recovery.agent.md" ||
    fail "migration recovery agent does not require the RabbitMQ routing fence"
grep -Fq "one bounded in-pod deletion loop" \
    "$ROOT_DIR/.github/agents/betstan-migration-recovery.agent.md" ||
    fail "migration recovery agent permits per-binding Bastion round trips"
grep -Fq "https://betstan.xyz" \
    "$ROOT_DIR/.github/agents/betstan-domain-ingress.agent.md" ||
    fail "domain ingress agent lacks the canonical host"
grep -Fq "A successful delete command alone is not" \
    "$ROOT_DIR/.github/agents/betstan-azure-retirement.agent.md" ||
    fail "Azure retirement agent trusts delete acceptance"
grep -Fq 'runtime_deploy_source_sha' \
    "$ROOT_DIR/.github/agents/betstan-azure-retirement.agent.md" ||
    fail "Azure retirement agent omits recovery deployment lineage"
grep -Fq 'never replace optimistic concurrency with a wildcard' \
    "$ROOT_DIR/.github/agents/betstan-azure-retirement.agent.md" ||
    fail "Azure retirement agent permits an unfenced AKS delete"
retirement_operator="$ROOT_DIR/infra/azure/agents/retire-production-stan.sh"
migration_success_contract="$OCI_DIR/scripts/migration-success-contract.sh"
[[ -x "$retirement_operator" ]] ||
  fail "checked-in Azure retirement operator is missing or not executable"
[[ -x "$migration_success_contract" ]] ||
  fail "shared migration-success contract is missing or not executable"
grep -Fq \
    'MODE=validate "$ROOT_DIR/infra/oci/scripts/migration-success-contract.sh"' \
    "$retirement_operator" ||
  fail "Azure retirement does not consume the shared migration-success contract"
for retirement_contract in \
    'oci-migration-success-provenance-${MIGRATION_RUN_ID}-${MIGRATION_RUN_ATTEMPT}' \
    'validate_initial_inventory "$INITIAL_INVENTORY_FILE"' \
    'az rest' \
    '--headers "If-Match=${CLUSTER_ETAG}"' \
    'wait_for_cluster_absence' \
    'validate_inventory_subset "$CURRENT_INVENTORY_FILE"' \
    'verify_subscription_absence' \
    'AZURE_RESOURCES_RETIRED cost_verification=pending_delayed_reporting'; do
    grep -Fq -- "$retirement_contract" "$retirement_operator" ||
      fail "Azure retirement operator omits contract: $retirement_contract"
done
! grep -Eq 'az (ad|role)|gh secret (delete|set)|oci |kubectl ' \
  "$retirement_operator" ||
  fail "Azure retirement operator crosses identity, OCI, or Kubernetes boundaries"

# shellcheck source=../scripts/lib.sh
source "$OCI_DIR/scripts/lib.sh"
[[ "$(oci_normalize_list_json "")" == '{"data":[]}' ]] ||
  fail "empty OCI array response was not normalized"
[[ "$(oci_normalize_list_json "" items)" == '{"data":{"items":[]}}' ]] ||
  fail "empty OCI items response was not normalized"
queue_fixture="$(
  printf '%s\n' \
    'name messages_ready messages_unacknowledged consumers' \
    'event_new_event 0 0 1' \
    'bet_place_bet 2 1 3'
)"
queue_rows="$(oci_rabbitmq_queue_rows <<<"$queue_fixture")" ||
  fail "RabbitMQ queue output with a header was rejected"
[[ "$(awk 'NF {count++} END {print count+0}' <<<"$queue_rows")" == "2" ]] ||
  fail "RabbitMQ header was counted as a queue"
[[ "$(awk '{sum += $2 + $3} END {print sum+0}' <<<"$queue_rows")" == "3" ]] ||
  fail "RabbitMQ normalized backlog differs"
[[ "$(awk '{sum += $4} END {print sum+0}' <<<"$queue_rows")" == "4" ]] ||
  fail "RabbitMQ normalized consumer count differs"
if oci_rabbitmq_queue_rows <<<'name messages_ready messages_unacknowledged consumers extra' >/dev/null; then
  fail "malformed RabbitMQ queue output was accepted"
fi
if oci_rabbitmq_queue_rows <<<$'name messages_ready messages_unacknowledged consumers\nname messages_ready messages_unacknowledged consumers' >/dev/null; then
  fail "duplicate RabbitMQ queue headers were accepted"
fi
[[ "$(oci_application_rabbitmq_queue_count)" == "22" ]] ||
  fail "current RabbitMQ application queue count omits live consumers"
grep -Fq 'zero_consumer_queues=' "$OCI_DIR/scripts/deploy.sh" ||
  fail "OCI deployment queue failure omits zero-consumer diagnostics"
grep -Fq 'queue_names=' "$OCI_DIR/scripts/deploy.sh" ||
  fail "OCI deployment queue failure omits observed queue names"
grep -Fq '"@${expected_digests[$service]}" ||' "$OCI_DIR/scripts/deploy.sh" ||
  fail "OCI deployment does not accept a CRI-reported immutable manifest digest"
grep -Fq 'image_id.endswith('\''@'\'' + manifest_digest)' \
  "$OCI_DIR/scripts/baseline-capture-stan.sh" ||
  fail "OCI baseline capture does not accept a CRI-reported immutable manifest digest"
for queue_probe in \
  "$OCI_DIR/scripts/baseline-capture-stan.sh" \
  "$OCI_DIR/scripts/rollback-readiness-stan.sh" \
  "$OCI_DIR/scripts/rollback-application-stan.sh" \
  "$ROOT_DIR/infra/azure/agents/live-betting-readiness-lib.sh"; do
  grep -Fq 'rabbitmqctl list_queues --quiet name messages_ready messages_unacknowledged consumers' \
    "$queue_probe" ||
    fail "RabbitMQ queue probe does not suppress non-tabular CLI output: $queue_probe"
done
for api_contract_probe in \
  "$OCI_DIR/scripts/baseline-capture-stan.sh" \
  "$OCI_DIR/scripts/rollback-readiness-stan.sh" \
  "$OCI_DIR/scripts/rollback-application-stan.sh" \
  "$ROOT_DIR/infra/azure/agents/baseline-capture-stan.sh" \
  "$ROOT_DIR/infra/azure/agents/rollback-application-stan.sh"; do
  grep -Fq '"/api/bet/stats|array"' "$api_contract_probe" ||
    fail "bet stats rollback contract is not array-shaped: $api_contract_probe"
done
redacted="$(
  printf '%s\n' \
    'Authorization: Bearer header-secret' \
    'token=query-secret' \
    'cookie: session=cookie-secret' \
    '-----BEGIN RSA PRIVATE KEY-----' \
    'private-key-body-secret' \
    '-----END RSA PRIVATE KEY-----' \
    'safe-tail' |
    oci_redact
)"
for secret in header-secret query-secret cookie-secret private-key-body-secret; do
  [[ "$redacted" != *"$secret"* ]] ||
    fail "OCI redaction leaked fixture secret: $secret"
done
[[ "$redacted" == *"[REDACTED_PRIVATE_KEY]"* ]] ||
  fail "OCI redaction omitted the private-key marker"
[[ "$redacted" == *"safe-tail"* ]] ||
  fail "OCI redaction removed content after the private-key block"
header_key="Author""ization"
header_value="header-fixture-value"
header_redacted="$(printf '%s: %s\n' "$header_key" "$header_value" | oci_redact)"
[[ "$header_redacted" != *"$header_value"* ]] ||
  fail "OCI redaction leaked a constructed header value"

ruby -ryaml - "$ROOT_DIR" <<'RUBY'
root = ARGV.fetch(0)
files = Dir.glob(File.join(root, "infra/oci/**/*.{yaml,yml}")) +
  Dir.glob(File.join(root, ".github/workflows/oci-*.yml"))
files.sort.each do |file|
  begin
    YAML.load_stream(File.read(file))
  rescue Psych::SyntaxError => error
    abort "#{file}: #{error.message}"
  end
end
puts "oci_yaml_parse=PASS files=#{files.length}"
RUBY

OFFLINE=1 \
OCI_RUNTIME_MODE=oke \
OCI_A1_OCPUS=2 \
OCI_A1_MEMORY_GB=12 \
OCI_NODE_SHAPE=VM.Standard.A1.Flex \
OCI_BOOT_VOLUME_GB=50 \
OCI_MONGO_VOLUME_GB=50 \
OCI_LB_MIN_MBPS=10 \
OCI_LB_MAX_MBPS=10 \
OCI_EXPECTED_MONTHLY_COST=0 \
OCI_REGISTRY_MAX_BYTES=500000000 \
OCI_MEMORY_MAX_PERCENT=70 \
OCI_DISK_MAX_PERCENT=70 \
  "$OCI_DIR/scripts/preflight.sh" --offline >/dev/null

services=(auth bet backoffice client event gamemaster moderation resulting slip)
index=1
for service in "${services[@]}"; do
  digit="$index"
  digest="$(printf '%064d' "$digit")"
  repository="ghcr.io/vasilyevstan/betstan-images"
  cat > "$WORK_DIR/provenance/${service}.env" <<ENV
service=${service}
schema=betstan.application-image-provenance.v1
registry_provider=ghcr
registry_host=ghcr.io
registry_tag_prefix=arm64
registry_tag_schema=v1
repository=${repository}
source_sha=1111111111111111111111111111111111111111
tag=${repository}:arm64-${service}-1111111111111111111111111111111111111111
digest=sha256:${digest}
platform_digest=sha256:${digest}
image_ref=${repository}@sha256:${digest}
platform=linux/arm64
build_run_id=fixture
build_run_attempt=1
build_workflow=oci-production-build
upstream_workflow=production-build
upstream_run_id=local
upstream_run_attempt=1
ENV
  index=$((index + 1))
done
PROVENANCE_DIR="$WORK_DIR/provenance" \
SOURCE_SHA=1111111111111111111111111111111111111111 \
OUTPUT_FILE="$WORK_DIR/images.tsv" \
VERIFY_REMOTE=0 BOOT_IMAGES=0 \
  "$OCI_DIR/scripts/verify-images.sh" >/dev/null
cat > "$WORK_DIR/infrastructure.env" <<'ENV'
source_sha=1111111111111111111111111111111111111111
OCI_MONGO_VOLUME_OCID=ocid1.volume.oc1.fixture.fixturevalue
ingress_ipv4=203.0.113.10
public_host=betstan.xyz
canonical_host=betstan.xyz
redirect_host=www.betstan.xyz
diagnostic_host=203.0.113.10.nip.io
ENV

IMAGE_PROVENANCE_FILE="$WORK_DIR/images.tsv" \
OCI_RUNTIME_MODE=oke \
INFRA_PROVENANCE_FILE="$WORK_DIR/infrastructure.env" \
OUTPUT_FILE="$WORK_DIR/rendered.yaml" \
WORK_DIR="$WORK_DIR/render-work" \
OCI_K8S_NAMESPACE=betstan-oci \
OCI_CANONICAL_HOST=betstan.xyz \
OCI_REDIRECT_HOST=www.betstan.xyz \
OCI_CERT_EMAIL=fixture@example.invalid \
  "$OCI_DIR/scripts/render-manifests.sh" >/dev/null

ruby -ryaml - "$WORK_DIR/rendered.yaml" <<'RUBY'
documents = YAML.load_stream(File.read(ARGV.fetch(0))).compact
by_kind = documents.group_by { |document| document["kind"] }
abort "nine application deployments plus RabbitMQ required" unless by_kind.fetch("Deployment").length == 10
abort "single Mongo StatefulSet required" unless by_kind.fetch("StatefulSet").map {
  |item| item.dig("metadata", "name")
} == ["gaming-auth-mongo-depl"]
abort "single Mongo PVC required" unless by_kind.fetch("PersistentVolumeClaim").length == 1
abort "Mongo PVC must start at 50Gi" unless by_kind["PersistentVolumeClaim"][0].dig(
  "spec", "resources", "requests", "storage"
) == "50Gi"
abort "single Mongo PV required" unless by_kind.fetch("PersistentVolume").length == 1
services = by_kind.fetch("Service")
abort "Mongo or RabbitMQ service became public" unless services.all? {
  |service| service.dig("spec", "type") == "ClusterIP"
}
images = (by_kind.fetch("Deployment") + by_kind.fetch("StatefulSet")).flat_map {
  |workload| workload.dig("spec", "template", "spec", "containers").map { |container| container["image"] }
}
abort "mutable image rendered" unless images.all? { |image| image.match?(/@sha256:[0-9a-f]{64}\z/) }
workloads = by_kind.fetch("Deployment") + by_kind.fetch("StatefulSet")
abort "ARM64 node selector missing" unless workloads.all? {
  |workload| workload.dig("spec", "template", "spec", "nodeSelector", "kubernetes.io/arch") == "arm64"
}
abort "resource requests/limits missing" unless workloads.all? {
  |workload| workload.dig("spec", "template", "spec", "containers").all? {
    |container| container.dig("resources", "requests") && container.dig("resources", "limits")
  }
}
backend_names = %w[
  gaming-auth-depl gaming-bet-depl gaming-backoffice-depl gaming-event-depl
  gaming-gamemaster-depl gaming-moderation-depl gaming-resulting-depl
  gaming-slip-depl
]
backends = by_kind.fetch("Deployment").select {
  |deployment| backend_names.include?(deployment.dig("metadata", "name"))
}
abort "eight backend deployments required" unless backends.length == 8
abort "backend numeric non-root identity differs" unless backends.all? {
  |deployment| deployment.dig(
    "spec", "template", "spec", "containers", 0, "securityContext"
  ).then {
    |context| context["runAsNonRoot"] == true &&
      context["runAsUser"] == 1000 && context["runAsGroup"] == 1000
  }
}
mongo = by_kind.fetch("StatefulSet").first
abort "base StatefulSet claim template survived OCI patch" if mongo.dig("spec", "volumeClaimTemplates")
abort "Mongo does not use the explicit 50Gi claim" unless mongo.dig(
  "spec", "template", "spec", "volumes", 0, "persistentVolumeClaim", "claimName"
) == "gaming-auth-mongo-data"
abort "legacy Mongo rendered" if File.read(ARGV.fetch(0)).include?("legacy-mongo")
abort "expected canonical and redirect OCI ingresses" unless by_kind.fetch("Ingress").length == 2
abort "expected canonical and diagnostic certificates" unless by_kind.fetch("Certificate").length == 2
event = by_kind.fetch("Deployment").find {
  |deployment| deployment.dig("metadata", "name") == "gaming-event-depl"
}
event_env = event.dig("spec", "template", "spec", "containers", 0, "env").to_h {
  |entry| [entry.fetch("name"), entry["value"]]
}
abort "event SSE connection cap differs" unless event_env["EVENT_PUBLIC_SSE_MAX_CONNECTIONS"] == "250"
ingress_hosts = by_kind.fetch("Ingress").flat_map {
  |ingress| ingress.fetch("spec").fetch("rules").map { |rule| rule.fetch("host") }
}.sort
abort "OCI ingress host set differs" unless ingress_hosts ==
  %w[203.0.113.10.nip.io betstan.xyz www.betstan.xyz]
canonical_certificate = by_kind.fetch("Certificate").find {
  |certificate| certificate.dig("metadata", "name") == "betstan-oci-canonical-tls"
}
abort "canonical certificate SAN set differs" unless canonical_certificate.dig(
  "spec", "dnsNames"
).sort == %w[betstan.xyz www.betstan.xyz]
redirect = by_kind.fetch("Ingress").find {
  |ingress| ingress.dig("metadata", "name") == "gaming-oci-www-redirect"
}
canonical_ingress = by_kind.fetch("Ingress").find {
  |ingress| ingress.dig("metadata", "name") == "gaming-oci-ingress"
}
canonical_annotations = canonical_ingress.dig("metadata", "annotations")
abort "OCI ingress must disable SSE proxy buffering" unless canonical_annotations[
  "nginx.ingress.kubernetes.io/proxy-buffering"
] == "off"
abort "OCI ingress SSE read timeout differs" unless canonical_annotations[
  "nginx.ingress.kubernetes.io/proxy-read-timeout"
] == "75"
abort "OCI ingress SSE send timeout differs" unless canonical_annotations[
  "nginx.ingress.kubernetes.io/proxy-send-timeout"
] == "75"
abort "www ingress must leave HTTP for the canonical redirect" unless redirect.dig(
  "metadata", "annotations", "nginx.ingress.kubernetes.io/ssl-redirect"
) == "false"
abort "www ingress contains an admission-rejected redirect variable" if redirect.dig(
  "metadata", "annotations"
).key?("nginx.ingress.kubernetes.io/permanent-redirect")
puts "oci_rendered_topology=PASS"
RUBY
grep -Fq "apply_documents 'Certificate:^betstan-oci-(canonical-)?tls$'" \
  "$OCI_DIR/scripts/deploy.sh" ||
  fail "OCI deployment does not apply both TLS Certificate resources"
grep -Fq "apply_documents 'Ingress:^gaming-oci-(ingress|www-redirect)$'" \
  "$OCI_DIR/scripts/deploy.sh" ||
  fail "OCI deployment does not apply canonical/diagnostic and www redirect ingresses"
grep -Fq 'services=(auth bet event moderation resulting slip backoffice client gamemaster)' \
  "$OCI_DIR/scripts/deploy.sh" ||
  fail "OCI deployment must roll out API dependencies before Client and Gamemaster"
grep -Fq 'certificate was not issued by Let' \
  "$OCI_DIR/agents/smoke-liveness-stan.sh" ||
  fail "OCI public smoke does not verify the served certificate issuer"
grep -Fq 'certificate expires within seven days' \
  "$OCI_DIR/agents/smoke-liveness-stan.sh" ||
  fail "OCI public smoke does not verify served certificate expiry"
grep -Fq 'mutating request bypassed the HTTP maintenance fence' \
  "$OCI_DIR/agents/smoke-liveness-stan.sh" ||
  fail "OCI public smoke cannot prove the cutover HTTP mutation fence"

OCI_RUNTIME_MODE=k3s \
OCI_K3S_NODE_NAME=betstan-k3s \
IMAGE_PROVENANCE_FILE="$WORK_DIR/images.tsv" \
INFRA_PROVENANCE_FILE="$WORK_DIR/infrastructure.env" \
OUTPUT_FILE="$WORK_DIR/rendered-k3s.yaml" \
WORK_DIR="$WORK_DIR/render-k3s-work" \
OCI_K8S_NAMESPACE=betstan-oci \
OCI_CANONICAL_HOST=betstan.xyz \
OCI_REDIRECT_HOST=www.betstan.xyz \
OCI_CERT_EMAIL=fixture@example.invalid \
  "$OCI_DIR/scripts/render-manifests.sh" >/dev/null
ruby -ryaml - "$WORK_DIR/rendered-k3s.yaml" <<'RUBY'
documents = YAML.load_stream(File.read(ARGV.fetch(0))).compact
volume = documents.find {
  |document| document["kind"] == "PersistentVolume" &&
    document.dig("metadata", "name") == "gaming-auth-mongo-data"
}
abort "k3s Mongo PV contains an OCI CSI source" if volume.dig("spec", "csi")
abort "k3s Mongo PV lacks the stable local path" unless volume.dig(
  "spec", "local", "path"
) == "/var/lib/betstan/mongo"
node_values = volume.dig(
  "spec", "nodeAffinity", "required", "nodeSelectorTerms", 0,
  "matchExpressions", 0, "values"
)
abort "k3s Mongo PV lacks exact node affinity" unless node_values == ["betstan-k3s"]
mongo = documents.find {
  |document| document["kind"] == "StatefulSet" &&
    document.dig("metadata", "name") == "gaming-auth-mongo-depl"
}
abort "k3s Mongo fsGroup differs" unless mongo.dig(
  "spec", "template", "spec", "securityContext", "fsGroup"
) == 999
puts "oci_k3s_rendered_topology=PASS"
RUBY

kustomization="$OCI_DIR/k8s/base/kustomization.yaml"
for manifest in \
  auth-depl.yaml bet-depl.yaml backoffice-depl.yaml client-depl.yaml \
  event-depl.yaml gamemaster-depl.yaml moderation-depl.yaml \
  resulting-depl.yaml slip-depl.yaml rabbitmq-depl.yaml auth-mongo-depl.yaml; do
  grep -Fq "infra/k8s/$manifest" "$kustomization" ||
    fail "explicit manifest missing from Kustomize allowlist: $manifest"
done
if grep -Eq 'legacy-mongo|resources:[[:space:]]*$' "$kustomization" &&
  grep -Fq 'legacy-mongo' "$kustomization"; then
  fail "legacy Mongo appears in Kustomize allowlist"
fi
grep -R -n -E 'find[[:space:]]+.*infra/k8s|kubectl apply -[fR][[:space:]]+infra/k8s([[:space:]]|$)' \
  "$OCI_DIR" "$ROOT_DIR/.github/workflows/oci-"*.yml >/dev/null 2>&1 &&
  fail "OCI path recursively applies infra/k8s"

load_balancer_declarations="$(
  grep -R -h -E '^[[:space:]]*type:[[:space:]]*LoadBalancer[[:space:]]*$' \
    "$OCI_DIR" | wc -l | tr -d ' '
)"
[[ "$load_balancer_declarations" == "1" ]] ||
  fail "OCI assets must declare exactly one LoadBalancer service"
grep -Fq 'oci.oraclecloud.com/load-balancer-type: "lb"' "$OCI_DIR/helm/ingress-nginx-values.yaml"
grep -Fq 'oci-load-balancer-security-list-management-mode: "None"' "$OCI_DIR/helm/ingress-nginx-values.yaml"
for ingress_values in \
  "$OCI_DIR/helm/ingress-nginx-values.yaml" \
  "$OCI_DIR/helm/ingress-nginx-k3s-values.yaml"; do
  grep -Fq 'tag: v1.15.1' "$ingress_values" ||
    fail "ingress-nginx does not support strict ACME challenge paths"
  grep -Fq 'digest: sha256:594ceea76b01c592858f803f9ff4d2cb40542cae2060410b2c95f75907d659e1' \
    "$ingress_values" ||
    fail "ingress-nginx digest differs from the reviewed multi-architecture image"
  ! grep -Eq "strict-validate-path-type:[[:space:]]*['\"]?false" "$ingress_values" ||
    fail "ingress-nginx strict path validation was disabled"
  grep -Fq 'if ($host = "www.betstan.xyz") {' "$ingress_values" ||
    fail "ingress-nginx lacks the exact www redirect host guard"
  grep -Fq 'return 308 https://betstan.xyz$request_uri;' "$ingress_values" ||
    fail "ingress-nginx does not preserve the www request URI in its HTTPS redirect"
done
mongo_target_digest=sha256:e0ce8c35124d4a9f9785532d1f268f39e9728ffa1cb38f46fa482436424c4bd3
for mongo_target_file in \
  "$OCI_DIR/k8s/base/kustomization.yaml" \
  "$OCI_DIR/scripts/verify-images.sh" \
  "$OCI_DIR/agents/health-check-stan.sh"; do
  grep -Fq "$mongo_target_digest" "$mongo_target_file" ||
    fail "Mongo target identity differs from the requested immutable index: $mongo_target_file"
done
mongo_upgrade="$OCI_DIR/scripts/upgrade-mongo.sh"
grep -Fq 'MONGO_TRANSITION_VERSION=8.0.29' "$mongo_upgrade" ||
  fail "Mongo upgrade omits the reviewed 8.0 transition release"
grep -Fq 'MONGO_TARGET_VERSION=8.2.12' "$mongo_upgrade" ||
  fail "Mongo upgrade omits the exact Azure-compatible target release"
grep -Fq 'MONGO_TARGET_ARM64_MANIFEST=sha256:21ca0269db1ebbd1c59f5cbc04928d7e3f6ab6186d7ceafc8fa489c0486525b4' \
  "$mongo_upgrade" ||
  fail "Mongo upgrade omits the exact ARM64 target manifest"
grep -Fq 'sha256:21ca0269db1ebbd1c59f5cbc04928d7e3f6ab6186d7ceafc8fa489c0486525b4' \
  "$OCI_DIR/agents/health-check-stan.sh" ||
  fail "Mongo health omits the exact ARM64 target manifest"
grep -Fq "setFeatureCompatibilityVersion:'\${requested}'" "$mongo_upgrade" ||
  fail "Mongo upgrade does not advance FCV explicitly"
grep -Fq '"$SCRIPT_DIR/upgrade-mongo.sh" prepare' "$OCI_DIR/scripts/deploy.sh" ||
  fail "OCI deployment does not prepare the staged Mongo upgrade"
grep -Fq '"$SCRIPT_DIR/upgrade-mongo.sh" finalize' "$OCI_DIR/scripts/deploy.sh" ||
  fail "OCI deployment does not finalize the staged Mongo upgrade"
grep -Fq '"$SCRIPT_DIR/upgrade-mongo.sh" resume' "$OCI_DIR/scripts/deploy.sh" ||
  fail "OCI deployment does not reopen ingress after staged Mongo maintenance"
grep -Fq 'restore_deploy_access_on_exit()' "$OCI_DIR/scripts/deploy.sh" ||
  fail "OCI deployment does not recover public access after a staged failure"
grep -Fq 'apply_cleanup_documents()' "$OCI_DIR/scripts/deploy.sh" ||
  fail "OCI deployment cleanup cannot preserve the original deploy failure"
grep -Fq 'for service in auth backoffice client; do' "$OCI_DIR/scripts/deploy.sh" ||
  fail "OCI deployment failure cleanup does not restore safe reader services"
grep -Fq 'mongo_upgrade_recovery_required=true' "$OCI_DIR/scripts/deploy.sh" ||
  fail "OCI deployment does not arm staged failure recovery before Mongo preparation"
grep -Fq 'readOnly: true' "$mongo_upgrade" ||
  fail "Mongo fresh-storage inspection is not read-only"
grep -Fq "trap 'cleanup 143' TERM" "$mongo_upgrade" ||
  fail "Mongo upgrade can report a terminated command as successful"
grep -Fq 'exit 41' "$mongo_upgrade" ||
  fail "Mongo fresh-storage inspection does not fail closed on enumeration errors"
python3 - "$OCI_DIR/scripts/deploy.sh" <<'PY'
import sys

text = open(sys.argv[1], encoding="utf-8").read()
armed = text.index("mongo_upgrade_recovery_required=true")
prepare = text.index('"$SCRIPT_DIR/upgrade-mongo.sh" prepare')
apply_target = text.index("apply_documents 'StatefulSet:^gaming-auth-mongo-depl$'", prepare)
finalize = text.index('"$SCRIPT_DIR/upgrade-mongo.sh" finalize', apply_target)
provenance = text.index('} > "$OUTPUT_DIR/provenance.txt"', finalize)
resume = text.index('"$SCRIPT_DIR/upgrade-mongo.sh" resume', provenance)
disarmed = text.index("mongo_upgrade_recovery_required=false", resume)
rendered_removed = text.index('rm -f "$RENDERED_FILE"', disarmed)
completed = text.index('oci_log "oci_deploy=PASS', rendered_removed)
if not armed < prepare < apply_target < finalize < provenance < resume < disarmed < rendered_removed < completed:
    raise SystemExit("Mongo maintenance/deploy ordering differs")
PY
grep -Fq "printf 'registry_repository=%s\\n' \"\$application_registry_repository\"" \
  "$OCI_DIR/scripts/deploy.sh" ||
  fail "OCI deployment provenance does not preserve the validated GHCR repository"
grep -Fq "printf 'source_ref=%s\\n' \"\${GITHUB_REF:-refs/heads/master}\"" \
  "$OCI_DIR/scripts/deploy.sh" ||
  fail "OCI deployment provenance does not bind activation to master"
grep -Fq "printf 'run_attempt=%s\\n' \"\${GITHUB_RUN_ATTEMPT:-1}\"" \
  "$OCI_DIR/scripts/deploy.sh" ||
  fail "OCI deployment provenance does not expose the canonical activation attempt"
grep -Fq 'sha256:6033d0c2f4e9eb49dda9623067a96d317bc7b550513bd18532fbd3cd9a941c1b' \
  "$OCI_DIR/agents/health-check-stan.sh" ||
  fail "RabbitMQ health identity differs from the requested immutable index"
grep -Fq 'shape-flex-min: "10"' "$OCI_DIR/helm/ingress-nginx-values.yaml"
grep -Fq 'shape-flex-max: "10"' "$OCI_DIR/helm/ingress-nginx-values.yaml"

for dockerfile in "$OCI_DIR/build/Dockerfile.backend" "$OCI_DIR/build/Dockerfile.client"; do
  while IFS= read -r base_image; do
    [[ "$base_image" == \$* || "$base_image" =~ @sha256:[0-9a-f]{64}$ ]] ||
      fail "OCI Dockerfile contains an unpinned base image: $dockerfile"
  done < <(
    awk '
      toupper($1) == "FROM" {
        image = 2
        if ($image ~ /^--platform=/) {
          image += 1
        }
        print $image
      }
    ' "$dockerfile"
  )
  grep -Eq '^ARG [A-Z_]+_IMAGE=[^[:space:]]+@sha256:[0-9a-f]{64}$' "$dockerfile" ||
    fail "OCI Dockerfile image ARG is not digest-pinned: $dockerfile"
  grep -Fq 'FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build' "$dockerfile" ||
    fail "OCI Dockerfile must compile architecture-independent assets on BUILDPLATFORM: $dockerfile"
done
verify_images="$OCI_DIR/scripts/verify-images.sh"
build_images="$OCI_DIR/scripts/build-images.sh"
reuse_images="$OCI_DIR/scripts/reuse-images.sh"
compare_image_inputs="$OCI_DIR/scripts/compare-image-inputs.sh"
grep -Fq 'repository="$(application_registry_repository)"' \
  "$build_images" ||
  fail "GHCR builds must use the single approved public package"
grep -Fq 'application_registry_tag "$service" "$SOURCE_SHA"' "$build_images" ||
  fail "GHCR tags must bind ARM64 service and exact source SHA"
grep -Fq -- '--prefer-index=false' "$reuse_images" ||
  fail "unchanged OCI images are not reused by immutable digest"
grep -Fq 'oci_(die|log|require_command|require_vars|prepare_private_dir)' \
  "$compare_image_inputs" ||
  fail "OCI image input comparison omits the transitive build library contract"
grep -Fq 'untracked helper dependency' "$compare_image_inputs" ||
  fail "OCI image input comparison does not enforce a closed helper dependency set"
inventory="$OCI_DIR/scripts/inventory.sh"
registry_pruner="$OCI_DIR/scripts/prune-registry-generation.sh"
grep -Fq '[$prefix + "_images"]' "$inventory" ||
  fail "legacy OCI retirement inventory must name the former application repository"
grep -Fq 'ocir_application_repository_absent' "$inventory" ||
  fail "GHCR inventory does not require former OCIR application repository absence"
grep -Fq 'validated_build_evidence' "$inventory" ||
  fail "GHCR inventory does not require public build validation evidence"
grep -Fq 'REGISTRY_IMAGES_PER_GENERATION=9' "$inventory" ||
  fail "OCI inventory must require complete nine-image generations"
grep -Fq 'REGISTRY_MAX_GENERATIONS=3' "$inventory" ||
  fail "OCI inventory must retain at most two rollback generations"
grep -Fq '(.image_count % $registry_images_per_generation) != 0' "$inventory" ||
  fail "OCI inventory must reject partial image generations"
grep -Fq 'oci artifacts container image list' "$inventory" ||
  fail "OCI inventory must inspect exact image tags and digests"
grep -Fq '"repository-name": ."repository-name"' "$inventory" ||
  fail "OCI inventory must bound registry metadata before jq argument use"
grep -Fq 'incomplete_tag_generation_count' "$inventory" ||
  fail "OCI inventory must reject incomplete service tag generations"
grep -Fq 'digest_service_conflict_count' "$inventory" ||
  fail "OCI inventory must reject cross-service digest identities"
grep -Fq 'MAX_TARGET_GENERATIONS=10' "$registry_pruner" ||
  fail "registry pruning must bound the explicit obsolete generation set"
grep -Fq 'EXPECTED_PROTECTED_PROVENANCE_ROWS=27' "$registry_pruner" ||
  fail "registry pruning must bind three canonical protected source generations"
grep -Fq 'protected_image_count % IMAGES_PER_GENERATION == 0' \
  "$registry_pruner" ||
  fail "registry pruning must retain only complete unique protected generations"
grep -Fq 'obsolete generations overlap a protected generation' "$registry_pruner" ||
  fail "registry pruning does not reject protected digest overlap"
grep -Fq 'registry contains an unknown, missing, or unexpected image generation' \
  "$registry_pruner" ||
  fail "registry pruning does not fail closed on unknown images"
grep -Fq 'read_provenance_repository "$PROTECTED_IMAGES_FILE"' "$registry_pruner" ||
  fail "registry pruning does not derive one exact protected repository"
grep -Fq 'TRUSTED_TARGET_IMAGES_FILE' "$registry_pruner" ||
  fail "registry pruning does not cross-check successful obsolete builds"
grep -Fq 'TRUSTED_PROTECTED_IMAGES_FILE' "$registry_pruner" ||
  fail "registry pruning does not cross-check canonical protected source tags"
grep -Fq 'validate_alias_generations' "$registry_pruner" ||
  fail "registry pruning does not validate complete image alias generations"
grep -Fq 'registry_image_id_set' "$registry_pruner" ||
  fail "registry pruning does not separate unique image IDs from tag aliases"
grep -Fq 'before-aliases.tsv' "$registry_pruner" ||
  fail "registry pruning does not retain pre-delete alias evidence"
grep -Fq 'registry aliases changed after validation and before deletion' \
  "$registry_pruner" ||
  fail "registry pruning does not revalidate its alias snapshot before deletion"
grep -Fq 'registry accounting changed after validation and before deletion' \
  "$registry_pruner" ||
  fail "registry pruning does not revalidate accounting before deletion"
grep -Fq -- '--argjson expected_images "$expected_images_before"' \
  "$registry_pruner" ||
  fail "registry pruning does not reconcile provider accounting with unique images"
grep -Fq 'the exact protected image OCID set changed during pruning' \
  "$registry_pruner" ||
  fail "registry pruning does not preserve the exact protected image OCID set"
grep -Fq 'protected_image_ids_sha256' "$registry_pruner" ||
  fail "registry pruning does not bind protected image OCIDs into evidence"
grep -Fq 'PRUNE_MODE must be validate or apply' "$registry_pruner" ||
  fail "registry pruning does not separate read-only validation from apply"
grep -Fq 'live registry or trusted provenance changed since validation' \
  "$registry_pruner" ||
  fail "registry pruning does not require the exact validated live snapshot"
grep -Fq 'registry_aliases_sha256' "$registry_pruner" ||
  fail "registry pruning does not bind the complete alias inventory"
grep -Fq 'request_provenance_sha256' "$registry_pruner" ||
  fail "registry pruning does not bind exact build and deployment run IDs"
grep -Fq 'OCI registry pruning did not reach the exact protected digest set' \
  "$registry_pruner" ||
  fail "registry pruning does not wait for asynchronous deletion"
grep -Fq '.layers_size_bytes <= $max_bytes' "$registry_pruner" ||
  fail "registry pruning does not wait for bounded registry accounting"
grep -Fq 'docker run -d --platform linux/arm64 --name "$container"' "$verify_images" ||
  fail "OCI application boot verification must run the ARM64 images"
grep -Fq -- '-e AUTH_SERVICE_URL=http://auth:3000' "$verify_images" ||
  fail "OCI application boot verification omits the required internal auth endpoint"
if grep -Eq -- '--platform linux/arm64 --name "\$(mongo|rabbit)"' "$verify_images"; then
  fail "OCI build verification dependencies must use the runner native platform"
fi
grep -Fq 'docker exec --user rabbitmq "$rabbit" rabbitmq-diagnostics -q ping' "$verify_images" ||
  fail "RabbitMQ readiness verification must run as the image user"
grep -R -n -E 'image:[[:space:]]+[^[:space:]#]+:(latest|main|master|dev)([[:space:]#]|$)' \
  "$OCI_DIR" "$ROOT_DIR/.github/workflows/oci-"*.yml >/dev/null 2>&1 &&
  fail "OCI path contains a mutable image tag"

grep -R -n -E '\baz\b|AKS|azure\.com|AZURE_' \
  "$OCI_DIR/agents" \
  --exclude='test-health-contract-stan.sh' \
  --exclude='oci-live-smoke.spec.js' >/dev/null 2>&1 &&
  fail "OCI health agents contain an Azure dependency"
for script in "$OCI_DIR/scripts"/*.sh; do
  case "$(basename "$script")" in
    migrate-from-azure.sh | migration-success-contract.sh | recover-azure-migration.sh)
      continue
      ;;
  esac
  grep -Eiq '\baz\b|AKS|AZURE_|azure\.com' "$script" &&
    fail "non-migration OCI script contains an Azure dependency: $script"
done
for workflow in "$ROOT_DIR/.github/workflows"/oci-*.yml; do
  case "$(basename "$workflow")" in
    oci-migrate.yml | oci-migration-recovery.yml)
      continue
      ;;
  esac
  grep -Eq 'AZURE_|azure/login|azure/aks-set-context' "$workflow" &&
    fail "Azure credential/reference exists outside OCI migration: $workflow"
done

build_workflow="$ROOT_DIR/.github/workflows/oci-production-build.yml"
capacity_workflow="$ROOT_DIR/.github/workflows/oci-capacity-acquire.yml"
infra_workflow="$ROOT_DIR/.github/workflows/oci-infrastructure.yml"
data_workflow="$ROOT_DIR/.github/workflows/oci-live-data-rollout.yml"
deploy_workflow="$ROOT_DIR/.github/workflows/oci-production-deploy.yml"
migrate_workflow="$ROOT_DIR/.github/workflows/oci-migrate.yml"
activation_workflow="$ROOT_DIR/.github/workflows/oci-live-betting-activate.yml"
disable_workflow="$ROOT_DIR/.github/workflows/oci-live-betting-disable.yml"
recovery_workflow="$ROOT_DIR/.github/workflows/oci-migration-recovery.yml"
ghcr_recovery_workflow="$ROOT_DIR/.github/workflows/oci-ghcr-cache-recovery.yml"
validate_workflow="$ROOT_DIR/.github/workflows/oci-validate.yml"
grep -Fq 'OCI_IMAGE_PREFIX: ${{ vars.OCI_IMAGE_PREFIX }}' "$deploy_workflow" ||
  fail "OCI deployment validation omits the image-prefix inventory contract"
cli_installer="$OCI_DIR/scripts/install-cli.sh"
deployment_safety_agent="$ROOT_DIR/.github/agents/betstan-deployment-safety.agent.md"
common_readme="$ROOT_DIR/common/README.md"
run_exclusivity_script="$ROOT_DIR/infra/azure/agents/production-run-exclusivity-stan.sh"
authority_helper="$ROOT_DIR/infra/azure/agents/copilot_cli_authority_stan.py"
pr_merge_safety="$ROOT_DIR/infra/azure/agents/pr-merge-safety-stan.sh"
cli_dispatcher="$ROOT_DIR/infra/azure/agents/copilot-cli-dispatch-stan.sh"
run_approver="$ROOT_DIR/infra/azure/agents/copilot-cli-run-approval-stan.sh"
pr_template="$ROOT_DIR/.github/pull_request_template.md"
azure_deploy_workflow="$ROOT_DIR/.github/workflows/production-deploy.yml"
oci_live_readiness="$OCI_DIR/agents/live-betting-readiness-stan.sh"

[[ "$(git -C "$ROOT_DIR" ls-tree HEAD common | awk '{print $1}')" = "040000" ]] ||
  fail "common source is not a normal tracked directory"
if [[ -f "$ROOT_DIR/.gitmodules" ]] &&
   grep -Eq '^[[:space:]]*path[[:space:]]*=[[:space:]]*common/?[[:space:]]*$' \
     "$ROOT_DIR/.gitmodules"; then
  fail "common source is configured as a submodule"
fi
[[ -f "$common_readme" ]] || fail "common package ownership guide is missing"
grep -Fq 'canonical source for BetStan' "$common_readme" ||
  fail "common guide omits source authority"
grep -Fq 'npm versions are immutable' "$common_readme" ||
  fail "common guide omits immutable package versioning"
grep -Fq 'Do not use `npm install --no-save <tarball>`' "$common_readme" ||
  fail "common guide omits lock-exact tarball validation"

grep -Fq 'read every cited path from that same tree' "$deployment_safety_agent"
grep -Fq 'never infer topology safety from a count' "$deployment_safety_agent"
grep -Fq 'dispatch URL proves event acceptance, not job materialization' \
  "$deployment_safety_agent"
grep -Fq 'Treat PR title/body changes as workflow-producing' \
  "$deployment_safety_agent"
grep -Fq 'through the checked-in bounded supersession or unmaterialized classifier' \
  "$deployment_safety_agent" ||
  fail "deployment safety omits bounded provider-ghost classification"
grep -Fq 'immediately run the checked-in supersession classifier' \
  "$conductor_agent" ||
  fail "conductor does not recover superseded provider-ghost stalls"
for recovery_contract in \
    'reason=unmaterialized' \
    'same repository regardless of control SHA' \
    'never reset master to the poisoned SHA' \
    'A cancellation `409` is corroborative journal evidence only' \
    'retire-unmaterialized-claim'; do
  grep -Fq "$recovery_contract" "$deployment_safety_agent" ||
    fail "deployment safety omits unmaterialized recovery contract: $recovery_contract"
done
for prospective_contract in \
    'Only `pr-merge-safety-stan.sh` may request the prospective-master bootstrap' \
    'same-repository `dev` -> `master` PR whose base SHA' \
    'normal dispatch or approval remains bound to actual master and blocking' \
    'It never uses `EXCLUDE_RUN_ID` or generic disabled classification' \
    'claimed/inflight authority fence remains unresolved'; do
  grep -Fq "$prospective_contract" "$deployment_safety_agent" ||
    fail "deployment safety omits prospective-master bootstrap contract: $prospective_contract"
done
for compare_contract in \
    'capacity requires one later exact success' \
    'live data requires later dry-run, backfill, and slip-index successes' \
    'activation requires one later exact activation success' \
    'reject any proposal to remove live-data' \
    'Fetch Compare evidence with `--paginate` and a compact SHA-only projection' \
    'complete unique ordered commit list to end at the requested head' \
    'c6c113b49a36518b7b106aa1406998a4abca10a0' \
    'complete nonterminal production-run inventory'; do
  grep -Fq "$compare_contract" "$deployment_safety_agent" ||
    fail "deployment safety omits compact Compare recovery contract: $compare_contract"
done
for recovery_contract in \
    'reason=unmaterialized' \
    'regardless of control SHA' \
    'runs must never receive human or CLI environment approval' \
    'rebuild the exact-SHA chain'; do
  grep -Fq "$recovery_contract" "$conductor_agent" ||
    fail "conductor omits unmaterialized recovery contract: $recovery_contract"
done
for prospective_contract in \
    'For the narrow current-master unmaterialized promotion deadlock' \
    'may pass only the exact PR number to the checked-in' \
    'A raw prospective SHA is never authority' \
    'approval, authority-fence, and every other active-run decision remain bound' \
    '`EXCLUDE_RUN_ID` and generic disabled handling are never'; do
  grep -Fq "$prospective_contract" "$conductor_agent" ||
    fail "conductor omits prospective-master bootstrap contract: $prospective_contract"
done
for inventory_contract in \
    'A recovered original blocker is not completion' \
    'nonterminal production-run inventory' \
    'zero unexplained blockers'; do
  grep -Fq "$inventory_contract" "$conductor_agent" ||
    fail "conductor omits recovered-blocker inventory contract: $inventory_contract"
done
for recovery_contract in \
    'Promotion cannot silently clear the fence' \
    'retire-unmaterialized-claim' \
    'never reset master to the poisoned SHA' \
    'zero exact count/list jobs and artifacts'; do
  grep -Fq "$recovery_contract" "$ROOT_DIR/LEARNINGS.md" ||
    fail "learnings omit unmaterialized recovery contract: $recovery_contract"
done
for self_blocker_learning in \
    'not automatically an external safety wait' \
    'branch -> `dev` -> `master`' \
    'independent deployment-safety challenge' \
    'post-promotion exact-SHA revalidation before automatic resumption' \
    'Never weaken a gate to make progress or edit live authority state ad hoc'; do
  grep -Fq "$self_blocker_learning" "$ROOT_DIR/LEARNINGS.md" ||
    fail "learnings omit governed self-blocker recovery: $self_blocker_learning"
done
for prospective_learning in \
    'A current-master ghost can block the guard promotion' \
    'exclusivity must independently prove an OPEN CLI-managed' \
    'allowlisted queued unmaterialized ghost, never for normal dispatch' \
    'approval, another active run, or the repository-global claimed/inflight' \
    '`EXCLUDE_RUN_ID` and generic disabled handling cannot'; do
  grep -Fq "$prospective_learning" "$ROOT_DIR/LEARNINGS.md" ||
    fail "learnings omit prospective-master bootstrap: $prospective_learning"
done
grep -Fq 'GitHub compare responses do not expose `head_commit`' \
  "$ROOT_DIR/LEARNINGS.md" ||
  fail "learnings omit GitHub compare head binding"
for compare_learning in \
    'Raw paginated Compare responses can exceed the private evidence-size bound' \
    'SHA-only projection' \
    'c6c113b49a36518b7b106aa1406998a4abca10a0' \
    'Keep workflow-specific supersession successor chains' \
    'supersession as a substitute for their successor chains' \
    'reconcile the entire nonterminal run inventory'; do
  grep -Fq "$compare_learning" "$ROOT_DIR/LEARNINGS.md" ||
    fail "learnings omit compact Compare recovery guidance: $compare_learning"
done
grep -Fq 'classify-unmaterialized-run' "$run_exclusivity_script" ||
  fail "production exclusivity does not invoke unmaterialized classification"
grep -Fq 'retire-unmaterialized-claim' "$authority_helper" ||
  fail "authority helper does not expose unmaterialized retirement"
grep -Fq 'verify_prospective_promotion' "$run_exclusivity_script" ||
  fail "production exclusivity does not verify prospective promotion evidence"
grep -Fq 'fetch_complete_compare' "$run_exclusivity_script" ||
  fail "production exclusivity does not normalize complete Compare evidence"
grep -Fq -- '--paginate --jq "$COMPARE_JQ"' "$run_exclusivity_script" ||
  fail "production exclusivity does not fetch compact paginated Compare evidence"
grep -Fq 'HISTORICAL_MUTATION_PROFILES' "$authority_helper" ||
  fail "authority helper omits blob-bound historical mutation profiles"
grep -Fq 'LIVE_DATA_HISTORICAL_PROFILE_TOKENS' "$authority_helper" ||
  fail "authority helper does not retain the explicit historical token profile"
if grep -Fq 'LIVE_DATA_HISTORICAL_PROFILE_OMISSIONS' "$authority_helper"; then
  fail "authority helper derives historical tokens from mutable omissions"
fi
grep -Fq 'PROSPECTIVE_PROMOTION_PR="$PR_NUMBER"' "$pr_merge_safety" ||
  fail "merge safety does not pass the exact prospective promotion PR"
grep -Fq 'EXCLUDE_RUN_ID="" PROSPECTIVE_PROMOTION_PR="$PR_NUMBER"' \
  "$pr_merge_safety" ||
  fail "merge safety does not clear exclusion state before prospective bootstrap"
grep -Fq 'EXCLUDE_RUN_ID="" PROSPECTIVE_PROMOTION_PR=""' \
  "$cli_dispatcher" ||
  fail "normal dispatcher can inherit exclusion or prospective context"
grep -Fq 'EXCLUDE_RUN_ID="$RUN_ID" PROSPECTIVE_PROMOTION_PR=""' \
  "$run_approver" ||
  fail "normal approver does not retain only its exact self-run exclusion"
if grep -Fq 'PROSPECTIVE_MASTER_SHA' "$run_exclusivity_script"; then
  fail "production exclusivity trusts a raw prospective SHA environment value"
fi
if grep -Fq 'head_commit' "$run_exclusivity_script" "$authority_helper"; then
  fail "compare validation relies on a nonexistent head_commit field"
fi
[[ -f "$pr_template" ]] || fail "pull request evidence template is missing"
for heading in \
    '## Why this change exists' \
    '## Exact source and ancestry' \
    '## Scope and compatibility' \
    '## User-facing consistency' \
    '## Validation' \
    '## Release and rollback' \
    '## Exceptions and remaining work'; do
  grep -Fq "$heading" "$pr_template" ||
    fail "pull request template omits required evidence heading: $heading"
done
grep -Fq 'UX specialist baseline status and final exact-head status/SHA' \
  "$pr_template" ||
  fail "pull request template omits exact-head UX evidence"
grep -Fq 'Every pull request that changes what a user sees or how a user interacts must' \
  "$ROOT_DIR/CONTRIBUTING.md" ||
  fail "contributor policy omits mandatory UX review"
grep -Fq './infra/azure/agents/shared-mongo-topology-guard-stan.sh' \
  "$azure_deploy_workflow"
grep -Fq 'export REQUIRED_MONGO_TOPOLOGY_MODE=shared' "$oci_live_readiness"
grep -Fq 'export NAMESPACE="${NAMESPACE:-${OCI_K8S_NAMESPACE:-betstan-oci}}"' \
  "$oci_live_readiness" ||
  fail "OCI live readiness defaults to a namespace other than betstan-oci"
grep -Fq 'export EXPECTED_SHARED_MONGO_PVC=gaming-auth-mongo-data' \
  "$oci_live_readiness"
grep -Fq 'export SHARED_MONGO_MIGRATION_EVIDENCE_CONFIGMAP=betstan-oci-migration-journal' \
  "$oci_live_readiness"
if grep -Eiq 'at least (eight|8) Mongo PVC' \
  "$deployment_safety_agent" "$azure_deploy_workflow" "$deploy_workflow"; then
  fail "current production safety sources retain the retired eight-PVC gate"
fi

grep -Fq 'workflow_run:' "$build_workflow"
grep -Fq 'workflows: ["production-build", "ghcr-package-management"]' "$build_workflow"
grep -Fq 'github.event.workflow_run.head_sha' "$build_workflow"
grep -Fq 'environment:' "$build_workflow"
grep -Fq 'name: oci-build' "$build_workflow"
grep -Fq 'docker login ghcr.io' "$build_workflow"
grep -Fq 'packages: write' "$build_workflow"
grep -Fq 'Require a pre-existing public GHCR package' "$build_workflow"
grep -Fq 'ANONYMOUS_PULL=1' "$build_workflow"
grep -Fq 'exact GHCR tag already exists; refusing overwrite' "$OCI_DIR/scripts/build-images.sh"
grep -Fq 'OCI_REUSE_SOURCE_SHA' "$build_workflow"
grep -Fq 'OCI_REUSE_BUILD_RUN_ID' "$build_workflow"
grep -Fq 'compare-image-inputs.sh' "$build_workflow"
grep -Fq 'reuse-images.sh' "$build_workflow"
grep -Fq 'for reuse_attempt in 1 2 3' "$build_workflow"
grep -Fq 'repair-build-evidence.env' "$build_workflow"
grep -Fq 'REPAIR_EXISTING_TAGS: ${{ steps.trust.outputs.repair_mode }}' "$build_workflow"
grep -Fq 'Reusable build has inconsistent normal/repair trigger lineage.' "$build_workflow"
grep -Fq 'oci-build $REUSE_SOURCE_SHA repair-$reuse_trigger_run_id' "$build_workflow"
grep -Fq 'existing GHCR exact tag differs from the rebuilt ARM64 platform' \
  "$OCI_DIR/scripts/build-images.sh"
grep -Fq 'push-by-digest=true' "$OCI_DIR/scripts/build-images.sh"
grep -Fq 'group: oci-build-${{ github.event.workflow_run.head_sha }}' "$build_workflow"
! grep -Eq 'OCI_CLI_|OCI_CI_PRIVATE_KEY_PEM' "$build_workflow" ||
  fail "OCI build workflow receives an API signing key"
for workflow in "$deploy_workflow" "$migrate_workflow"; do
  grep -Fq \
    'APPLICATION_REGISTRY_EVIDENCE_FILE: artifacts/infrastructure/application-registry-evidence.env' \
    "$workflow" ||
    fail "GHCR health validation lacks finalized public-package evidence: $workflow"
done
grep -Fq 'NF != 5 { exit 1 }' "$disable_workflow" ||
  fail "live disable does not accept five-column GHCR image provenance"
grep -Fq '$5 !~ /^sha256:[0-9a-f]{64}$/ { exit 1 }' "$disable_workflow" ||
  fail "live disable does not validate the GHCR platform digest"
for workflow in "$activation_workflow" "$disable_workflow"; do
  grep -Fq 'OCI_COMPARTMENT_OCID: ${{ vars.OCI_COMPARTMENT_OCID }}' \
    "$workflow" ||
    fail "k3s live control lacks its OCI compartment: $workflow"
  grep -Fq "steps.k3s_access.outcome == 'success'" "$workflow" ||
    fail "live-control fail-safe mutation can run without k3s access: $workflow"
  grep -Fq "steps.oci_cli.outcome == 'success'" "$workflow" ||
    fail "live-control Bastion cleanup can run before OCI CLI install: $workflow"
done
[[ "$(grep -Fc 'node dist/scripts/SetUserRole.js' "$activation_workflow")" == "2" ]] ||
  fail "live activation must grant and revoke through the compiled auth role command"
grep -Fq "always() && steps.account.outcome == 'success'" "$activation_workflow" ||
  fail "live activation account cleanup does not run after acceptance failure"
grep -Fq 'LIVE_ACCEPTANCE_USERNAME: betstan-e2e-protected-v2' \
  "$activation_workflow" ||
  fail "live activation does not reuse the dedicated E2E account"
[[ "$(grep -Fc \
  'LIVE_ACCEPTANCE_PASSWORD: ${{ secrets.LIVE_ACCEPTANCE_PASSWORD }}' \
  "$activation_workflow")" == "4" ]] ||
  fail "live activation does not scope the protected E2E credential to four steps"
! grep -Fq 'node dist/scripts/DeleteUser.js' "$activation_workflow" ||
  fail "live activation still deletes the reusable E2E account"
for workflow in \
  "$deploy_workflow" "$migrate_workflow" "$ghcr_recovery_workflow"; do
  [[ "$(grep -Fc \
    'LIVE_ACCEPTANCE_PASSWORD: ${{ secrets.LIVE_ACCEPTANCE_PASSWORD }}' \
    "$workflow")" == "1" ]] ||
    fail "OCI browser validation lacks the protected E2E credential: $workflow"
done
for script in \
  "$OCI_DIR/agents/validation-loop-stan.sh" \
  "$OCI_DIR/agents/health-check-stan.sh"; do
  grep -Fq 'unset LIVE_ACCEPTANCE_PASSWORD' "$script" ||
    fail "OCI browser validation leaks the E2E credential to unrelated commands: $script"
done
if ! python3 - "$activation_workflow" <<'PY'
import re
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text()
node_setup = text.split(
    "- name: Install browser acceptance dependencies", 1
)[1].split("- name: Install locked client and Chromium", 1)[0]
if re.search(r"^\s+cache(?:-dependency-path)?:", node_setup, re.MULTILINE):
    raise SystemExit(
        "live activation cannot cache npm before deleting its isolated HOME"
    )

account = text.split(
    "- name: Resolve reusable validation account", 1
)[1].split("- name: Grant and verify reusable administrator role", 1)[0]
if account.index('"$BASE_URL/api/auth/login"') > account.index(
    '"$BASE_URL/api/auth/new"'
):
    raise SystemExit("live activation does not attempt reusable login first")
if "openssl rand" in account:
    raise SystemExit("live activation still generates a per-run password")
for literal in (
    'username="$LIVE_ACCEPTANCE_USERNAME"',
    'password="$LIVE_ACCEPTANCE_PASSWORD"',
    '[ -n "$password" ]',
    '[ "${#password}" -ge 4 ]',
    '[ "${#password}" -le 20 ]',
    '[ "$status" = "200" ]',
    '[ "$status" = "201" ]',
):
    if literal not in account:
        raise SystemExit(
            f"live activation account resolution is missing: {literal}"
        )

cleanup = text.split(
    "- name: Revoke and clean reusable validation account", 1
)[1]
for literal in (
    'EXPECTED_AUTH_USER_COUNT=1',
    'ALLOWED_BET_KINDS=LIVE,PRE_MATCH',
    'MAX_ACTIVE_SLIPS=2',
    "./infra/oci/scripts/cleanup-live-acceptance-slips-stan.sh",
    '.id == $user_id and .email == $username and .role == "USER"',
):
    if literal not in cleanup:
        raise SystemExit(f"live activation cleanup is missing: {literal}")

for endpoint, expected_status in (
    ('"$BASE_URL/api/backoffice/result"', "401"),
    ('"$BASE_URL/api/auth/login"', "200"),
):
    tail = cleanup.split(endpoint, 1)[1]
    match = re.search(
        r'\[ "\$status" = "([0-9]{3})" \] \|\| cleanup_failed=1',
        tail,
    )
    if match is None or match.group(1) != expected_status:
        raise SystemExit(
            f"{endpoint} must be followed by status {expected_status}"
        )
PY
then
  fail "live activation reusable-account lifecycle contract failed"
fi
! grep -Fq 'npm run role:set' "$activation_workflow" ||
  fail "live activation still invokes a development-only auth role command"
grep -Fq '"src/**/*.ts"' "$OCI_DIR/build/tsconfig.production.json" ||
  fail "OCI production compilation excludes the auth role command"
grep -Fq 'COPY --from=build --chown=node:node /app/dist ./dist' \
  "$OCI_DIR/build/Dockerfile.backend" ||
  fail "OCI runtime images do not contain compiled service commands"
grep -Fq "steps.oci_cli.outcome == 'success'" "$data_workflow" ||
  fail "live-data Bastion cleanup can run before OCI CLI install"

grep -Fq 'schedule:' "$capacity_workflow"
grep -Fq 'cron: "*/5 * * * *"' "$capacity_workflow"
grep -Fq 'workflow_dispatch:' "$capacity_workflow"
grep -Fq 'github.run_attempt == 1' "$capacity_workflow"
grep -Fq "vars.OCI_CAPACITY_CATCHER_ENABLED == 'true'" "$capacity_workflow"
grep -Fq "github.event_name == 'workflow_dispatch'" "$capacity_workflow"
grep -Fq "inputs.approved_sha != ''" "$capacity_workflow"
grep -Fq 'group: oci-control-plane' "$capacity_workflow"
grep -Fq 'name: oci-capacity-acquire' "$capacity_workflow"
grep -Fq 'OCI_CAPACITY_PRIVATE_KEY_PEM' "$capacity_workflow"
! grep -Eq 'OCI_CI_PRIVATE_KEY_PEM|OCI_REGISTRY_|OCI_JWT_|AZURE_|azure/' \
  "$capacity_workflow" ||
  fail "capacity workflow receives credentials outside its dedicated identity"

for workflow in "$infra_workflow" "$data_workflow" "$deploy_workflow" "$migrate_workflow"; do
  grep -Fq 'workflow_dispatch:' "$workflow"
  grep -Fq 'github.run_attempt == 1' "$workflow"
  grep -Fq 'group: oci-control-plane' "$workflow"
done
for workflow in "$infra_workflow" "$data_workflow" "$deploy_workflow"; do
  [[ "$(grep -Fc \
    'OCI_K3S_SSH_PRIVATE_KEY: ${{ secrets.OCI_K3S_SSH_PRIVATE_KEY }}' \
    "$workflow")" == "1" ]] ||
    fail "target SSH private key must be scoped to one k3s access step: $(basename "$workflow")"
done
[[ "$(grep -Fc \
  'OCI_K3S_SSH_PRIVATE_KEY: ${{ secrets.OCI_K3S_SSH_PRIVATE_KEY }}' \
  "$migrate_workflow")" == "2" ]] ||
  fail "migration SSH key must be scoped to migration and finalization access steps"
! grep -Fq 'OCI_K3S_SSH_PRIVATE_KEY' "$capacity_workflow" ||
  fail "capacity acquisition must receive only the target SSH public key"
grep -Fq 'OCI_K3S_RETAIN_TARGET_SSH: "true"' "$infra_workflow" ||
  fail "infrastructure finalization does not retain target SSH within its access step"
grep -Fq 'unset OCI_K3S_SSH_PRIVATE_KEY' "$infra_workflow" ||
  fail "infrastructure finalization does not clear the target SSH secret before use"
! grep -Fq 'OCI_K3S_RETAIN_TARGET_SSH' "$data_workflow" "$deploy_workflow" "$migrate_workflow" ||
  fail "deployment or migration retains target SSH key material after API forwarding"
for workflow in "$deploy_workflow" "$migrate_workflow"; do
  public_job_line="$(grep -n -m1 '^  public-validate:' "$workflow" | cut -d: -f1)"
  next_job_line="$(awk -v start="$public_job_line" '
    NR > start && /^  [A-Za-z0-9_-]+:/ {print NR; exit}
  ' "$workflow"  )"
  [[ -n "$next_job_line" ]] || next_job_line=$(( $(wc -l <"$workflow") + 1 ))
  public_secrets="$(
    sed -n "${public_job_line},$((next_job_line - 1))p" "$workflow" |
      awk '
        /secrets\./ &&
        !/LIVE_ACCEPTANCE_PASSWORD:.*secrets\.LIVE_ACCEPTANCE_PASSWORD/ {
          count += 1
        }
        END { print count + 0 }
      '
  )"
  public_cloud_credentials="$(
    sed -n "${public_job_line},$((next_job_line - 1))p" "$workflow" |
      grep -Ec \
        'OCI_CLI_|OCI_CI_PRIVATE_KEY|AZURE_CONFIG|azure/login|aks-set-context|configure-kubectl-oke' ||
      true
  )"
  [[ -n "$public_job_line" && "$public_secrets" == "0" &&
      "$public_cloud_credentials" == "0" ]] ||
    fail "public validation receives cloud or unreviewed credentials: $(basename "$workflow")"
  grep -Fq 'persist-credentials: false' "$workflow" ||
    fail "public validation checkout persists a GitHub credential: $(basename "$workflow")"
  grep -Fq 'OCI_CLUSTER_CHECKS_ALREADY_PASSED: "1"' "$workflow" ||
    fail "public validation is not isolated from cluster checks: $(basename "$workflow")"
  grep -Fq 'OCI_PUBLIC_CHECKS_ALREADY_PASSED: "1"' "$workflow" ||
    fail "protected validation still executes package code: $(basename "$workflow")"
  grep -Fq 'OCI_E2E_ALREADY_PASSED: "1"' "$workflow" ||
    fail "protected validation still executes browser code: $(basename "$workflow")"
done
deploy_public_job_line="$(
  grep -n -m1 '^  public-validate:' "$deploy_workflow" | cut -d: -f1
)"
deploy_dependency_line="$(
  grep -n -m1 'name: Install browser validation dependencies' \
    "$deploy_workflow" | cut -d: -f1
)"
[[ "$deploy_dependency_line" -gt "$deploy_public_job_line" ]] ||
  fail "deployment browser validation is not in its cloud-credential-free public job"
migration_public_job_line="$(
  grep -n -m1 '^  public-validate:' "$migrate_workflow" | cut -d: -f1
)"
migration_finalize_job_line="$(
  grep -n -m1 '^  finalize:' "$migrate_workflow" | cut -d: -f1
)"
migration_post_job_line="$(
  grep -n -m1 '^  post-commit-validate:' "$migrate_workflow" | cut -d: -f1
)"
migration_dependency_line="$(
  grep -n -m1 'name: Install browser validation dependencies' \
    "$migrate_workflow" | cut -d: -f1
)"
[[ -n "$migration_post_job_line" &&
    "$migration_public_job_line" -lt "$migration_finalize_job_line" &&
    "$migration_finalize_job_line" -lt "$migration_post_job_line" &&
    "$migration_dependency_line" -gt "$migration_post_job_line" ]] ||
  fail "migration browser validation is not isolated after finalization"
migration_post_secrets="$(
  sed -n "${migration_post_job_line},\$p" "$migrate_workflow" |
    awk '
      /secrets\./ &&
      !/LIVE_ACCEPTANCE_PASSWORD:.*secrets\.LIVE_ACCEPTANCE_PASSWORD/ {
        count += 1
      }
      END { print count + 0 }
    '
)"
migration_post_cloud_credentials="$(
  sed -n "${migration_post_job_line},\$p" "$migrate_workflow" |
    grep -Ec \
      'OCI_CLI_|OCI_CI_PRIVATE_KEY|AZURE_CONFIG|azure/login|aks-set-context|configure-kubectl-oke' ||
    true
)"
[[ "$migration_post_secrets" == "0" &&
    "$migration_post_cloud_credentials" == "0" ]] ||
  fail "post-commit browser validation receives cloud or unreviewed credentials"
grep -Fq 'name: oci-infrastructure' "$infra_workflow"
grep -Fq 'PROVISION OCI ZERO COST' "$infra_workflow"
! grep -Fq -- '- prune-registry' "$infra_workflow" ||
  fail "retired OCIR prune phase remains dispatchable"
grep -Fq 'PRUNE OBSOLETE OCI IMAGE GENERATION' "$infra_workflow"
! grep -Fq -- '- validate-registry' "$infra_workflow" ||
  fail "retired OCIR validation phase remains dispatchable"
grep -Fq 'VALIDATE OCI IMAGE GENERATIONS' "$infra_workflow"
grep -A3 -F 'prune-registry:' "$infra_workflow" |
  grep -Fq "if: \${{ inputs.phase == 'retired-ocir-registry-controls' }}" ||
  fail "legacy OCIR registry job is not hard-disabled"
grep -Fq 'validation_run_id:' "$infra_workflow"
grep -Fq 'validated-registry/before-summary.json' "$infra_workflow"
grep -Fq 'betstan.oci-registry-prune-request.v1' "$infra_workflow"
grep -Fq 'validated-registry/request-provenance.json' "$infra_workflow"
grep -Fq "(inputs.phase == 'prepare' || inputs.phase == 'finalize')" \
  "$infra_workflow" ||
  fail "read-only registry validation can enter the provisioning job"
grep -Fq 'prune-registry-generation.sh' "$infra_workflow"
grep -Fq 'obsolete_generations:' "$infra_workflow"
grep -Fq 'length <= 10' "$infra_workflow"
grep -Fq '(.conclusion == "success" or .conclusion == "failure")' \
  "$infra_workflow"
grep -Fq 'oci-image-provenance-${obsolete_sha}-${obsolete_run_id}-1' \
  "$infra_workflow"
grep -Fq 'target-source-shas.txt' "$infra_workflow"
grep -Fq 'trusted-target-images.tsv' "$infra_workflow"
grep -Fq 'trusted-protected-images.tsv' "$infra_workflow"
grep -Fq '.unique_image_ids == .unique_images' "$infra_workflow"
grep -Fq '.protected_image_ids_sha256 ==' "$infra_workflow"
grep -Fq 'oci-image-provenance-${FALLBACK_SHA}-${FALLBACK_BUILD_RUN_ID}-1' \
  "$infra_workflow"
grep -Fq 'oci-deploy-provenance-${DEPLOYED_RUN_ID}-1' "$infra_workflow"
registry_checkout_line="$(
  grep -n -m1 'Checkout exact current master' "$infra_workflow" | cut -d: -f1
)"
registry_evidence_line="$(
  grep -n -m1 'Initialize registry prune evidence' "$infra_workflow" | cut -d: -f1
)"
[[ -n "$registry_checkout_line" && -n "$registry_evidence_line" &&
    "$registry_checkout_line" -lt "$registry_evidence_line" ]] ||
  fail "registry prune evidence is initialized before checkout cleanup"
grep -Fq 'name: oci-migration' "$data_workflow"
grep -Fq 'DRY RUN LIVE DATA EXACT SHA' "$data_workflow"
grep -Fq 'APPLY LIVE BACKFILLS EXACT SHA' "$data_workflow"
grep -Fq 'APPLY LIVE SLIP INDEX EXACT SHA' "$data_workflow"
grep -Fq 'shared-mongo-operation-lock-stan.sh acquire' "$data_workflow"
grep -Fq 'shared-mongo-operation-lock-stan.sh release' "$data_workflow"
grep -Fq 'verify-live-betting-data-evidence-stan.sh' "$data_workflow"
grep -Fq 'name: oci-production' "$deploy_workflow"
grep -Fq 'DEPLOY OCI EXACT SHA' "$deploy_workflow"
grep -Fq "steps.oci_cli.outcome == 'success'" "$deploy_workflow" ||
  fail "deployment can run Bastion cleanup before the OCI CLI is installed"
grep -Fq 'data_run_id:' "$deploy_workflow"
grep -Fq 'baseline_recovery_run_id:' "$deploy_workflow"
grep -Fq 'baseline_recovery_source_sha:' "$deploy_workflow"
grep -Fq 'git cat-file -e "${recovery_control_sha}^{commit}"' \
  "$deploy_workflow" ||
  fail "deployment does not validate the historical recovery control commit"
grep -Fq 'git merge-base --is-ancestor "$recovery_control_sha" "$SOURCE_SHA"' \
  "$deploy_workflow" ||
  fail "deployment rejects a trusted historical recovery created by an ancestor master"
! grep -Fq '[ "$recovery_control_sha" = "$SOURCE_SHA" ]' "$deploy_workflow" ||
  fail "deployment incorrectly requires historical recovery to run at candidate master"
grep -Fq 'EXPECTED_PHASE=apply-slip-index' "$deploy_workflow"
grep -Fq 'EXPECTED_BASELINE_RECOVERY_RUN_ID="$BASELINE_RECOVERY_RUN_ID"' \
  "$deploy_workflow"
grep -Fq 'EXPECTED_BASELINE_RECOVERY_SOURCE_SHA="$BASELINE_RECOVERY_SOURCE_SHA"' \
  "$deploy_workflow"
grep -Fq 'name: oci-migration' "$migrate_workflow"
grep -Fq 'REPLACE OCI DATA FROM AZURE' "$migrate_workflow"
grep -Fq 'replace_oci_data:' "$migrate_workflow"
grep -Fq 'inputs.replace_oci_data == true' "$migrate_workflow"
grep -Fq 'build_run_id:' "$migrate_workflow"
grep -Fq 'redirect_url: ${{ steps.provenance.outputs.redirect_url }}' "$migrate_workflow"
grep -Fq 'diagnostic_url: ${{ steps.provenance.outputs.diagnostic_url }}' "$migrate_workflow"
grep -Fq 'OCI_REDIRECT_URL:' "$migrate_workflow"
grep -Fq 'OCI_DIAGNOSTIC_URL:' "$migrate_workflow"
grep -Fq '[ "$OCI_PUBLIC_URL" = "https://betstan.xyz" ]' "$migrate_workflow"
grep -Fq '[ "$OCI_REDIRECT_URL" = "https://www.betstan.xyz" ]' "$migrate_workflow"
grep -Fq '[[ "$OCI_DIAGNOSTIC_URL" =~ ^https://[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\.nip\.io$ ]]' \
  "$migrate_workflow"
grep -Fq 'name: oci-migration-success-provenance-${{ github.run_id }}-${{ github.run_attempt }}' \
  "$migrate_workflow"
grep -Fq 'path: artifacts/oci-migration-success/migration-summary.env' "$migrate_workflow"
grep -Fq 'MODE=emit ./infra/oci/scripts/migration-success-contract.sh' \
  "$migrate_workflow" ||
  fail "OCI migration does not emit through the shared migration-success contract"
grep -Fq 'schema=betstan.oci-migration-success.v1' "$migrate_workflow"
grep -Fq 'terminal_phase=DEPLOYED_HEALTHY' "$migrate_workflow"
grep -Fq 'terminal_status=DEPLOYED_HEALTHY' "$migrate_workflow"
grep -Fq 'journal_heartbeat_epoch=' "$migrate_workflow"
grep -Fq 'fencing_generation=' "$migrate_workflow"
grep -Fq 'artifact_run_binding=${run_id}-${run_attempt}' "$migrate_workflow"
grep -Fq 'destructive_boundary_crossed=true' "$migrate_workflow"
grep -Fq 'database_count=8' "$migrate_workflow"
grep -Fq 'logical_source_target_parity=true' "$migrate_workflow"
grep -Fq 'oci_reopened_healthy=true' "$migrate_workflow"
grep -Fq 'azure_writers_frozen=true' "$migrate_workflow"
grep -Fq 'azure_cluster_stopped_deallocated=true' "$migrate_workflow"
public_job_line="$(grep -n -m1 '^  public-validate:' "$migrate_workflow" | cut -d: -f1)"
terminal_summary_line="$(
  grep -n -m1 'terminal_status=DEPLOYED_HEALTHY' "$migrate_workflow" |
    cut -d: -f1
)"
[[ "$terminal_summary_line" -gt "$public_job_line" ]] ||
  fail "terminal migration success provenance is emitted before public validation"
grep -Fq 'OCI_MIGRATION_AZURE_CREDENTIALS' "$migrate_workflow"
grep -Fq 'OCI_MIGRATION_AGE_IDENTITY' "$migrate_workflow"
grep -Fq 'az aks start' "$migrate_workflow"
grep -Fq 'az aks stop' "$migrate_workflow"
[[ "$(grep -Fc 'type == "array" and' "$migrate_workflow")" -ge 3 ]] ||
  fail "Azure stop paths do not safely accept an empty VMSS instance set"
! grep -Fq 'length >= 1 and' "$migrate_workflow" ||
  fail "Azure stop paths incorrectly require a retained VMSS instance"
[[ "$(grep -Fc 'install -m 600 -- "$KUBE_CONFIG_PATH" "$AZURE_KUBECONFIG"' \
  "$migrate_workflow")" -eq 2 ]] ||
  fail "Azure action kubeconfigs are not materialized at both isolated paths"
[[ "$(grep -Fc 'exit "$cleanup_status"' "$migrate_workflow")" -eq 2 ]] ||
  fail "unexpected kubeconfig paths can bypass credential cleanup"
[[ "$(grep -Fc 'Stopped|Deallocated)' "$migrate_workflow")" -ge 4 ]] ||
  fail "migration does not accept both Azure stopped-state representations"
grep -Fq '[ "$provisioning" = "Failed" ]' "$migrate_workflow" ||
  fail "migration cannot restart the exact failed/deallocated source"
[[ "$(grep -Ec "steps\\.(final_)?oci_cli\\.outcome == 'success'" \
  "$migrate_workflow")" -eq 2 ]] ||
  fail "migration can run Bastion cleanup before an OCI CLI is installed"
! grep -Eq 'az aks (create|update|delete)|az aks nodepool' "$migrate_workflow" ||
  fail "migration workflow can create, resize, or delete Azure compute"
grep -Fq 'if: always()' "$infra_workflow"
grep -Fq 'if: always()' "$deploy_workflow"
grep -Fq 'if: always()' "$migrate_workflow"

grep -Fq 'name: oci-migration-recovery' "$recovery_workflow"
grep -Fq 'workflows: ["oci-migrate"]' "$recovery_workflow"
grep -Fq 'cron: "*/15 * * * *"' "$recovery_workflow"
grep -Fq 'workflow_dispatch:' "$recovery_workflow"
grep -Fq "vars.OCI_MIGRATION_RECOVERY_ENABLED == 'true'" "$recovery_workflow"
grep -Fq "vars.OCI_MIGRATION_RECOVERY_ENABLED || 'false'" "$recovery_workflow"
grep -Fq 'OCI_MIGRATION_RECOVERY_ARM_UNTIL_EPOCH' "$recovery_workflow"
grep -Fq '86400' "$recovery_workflow"
grep -Fq 'name: azure-migration-recovery' "$recovery_workflow"
grep -Fq 'AZURE_MIGRATION_RECOVERY_CREDENTIALS' "$recovery_workflow"
grep -Fq 'group: azure-migration-recovery' "$recovery_workflow"
grep -Fq 'cancel-in-progress: true' "$recovery_workflow"
grep -Fq 'actions: write' "$recovery_workflow"
grep -Fq 'az aks stop' "$recovery_workflow"
[[ "$(grep -Fc 'Stopped|Deallocated)' "$recovery_workflow")" -ge 2 ]] ||
  fail "recovery does not accept both Azure stopped-state representations"
grep -Fq '[ "$provisioning" = "Failed" ]' "$recovery_workflow" ||
  fail "recovery rejects a safely deallocated failed AKS control plane"
! grep -Eq \
  'OCI_MIGRATION_AZURE_CREDENTIALS|OCI_CI_PRIVATE_KEY_PEM|OCI_K3S_SSH_PRIVATE_KEY|OCI_MIGRATION_AGE_IDENTITY' \
  "$recovery_workflow" ||
  fail "stop-only recovery receives migration or OCI credentials"
! grep -Eq 'az aks (start|create|update|delete)|az aks nodepool' "$recovery_workflow" ||
  fail "stop-only recovery can start, create, resize, or delete Azure compute"

grep -Fq 'pull_request:' "$validate_workflow"
! grep -Eq 'workflow_dispatch:|workflow_run:|^[[:space:]]+push:' "$validate_workflow" ||
  fail "oci-validate must remain PR-only"
! grep -Eq 'secrets\.|OCI_CLI_' "$validate_workflow" ||
  fail "oci-validate must not access credentials"

for workflow in "$infra_workflow" "$deploy_workflow" "$migrate_workflow"; do
  for variable in OCI_CLI_USER OCI_CLI_TENANCY OCI_CLI_FINGERPRINT OCI_CLI_KEY_CONTENT OCI_CLI_REGION; do
    grep -Fq "$variable:" "$workflow" ||
      fail "official OCI CLI mapping missing from $(basename "$workflow"): $variable"
  done
done
for variable in OCI_CLI_USER OCI_CLI_TENANCY OCI_CLI_FINGERPRINT OCI_CLI_KEY_CONTENT OCI_CLI_REGION; do
  grep -Fq "$variable:" "$capacity_workflow" ||
    fail "official OCI CLI mapping missing from oci-capacity-acquire.yml: $variable"
done
grep -Fq 'echo "$RUNNER_TEMP/oci-capacity-home/.local/bin" >> "$GITHUB_PATH"' \
  "$capacity_workflow" ||
  fail "capacity workflow does not expose the isolated OCI CLI installation on PATH"
for workflow in "$infra_workflow" "$deploy_workflow" "$migrate_workflow"; do
  grep -Fq 'echo "$RUNNER_TEMP/oci-home/.local/bin" >> "$GITHUB_PATH"' "$workflow" ||
    fail "isolated OCI CLI installation is not on PATH in $(basename "$workflow")"
done
for workflow in "$capacity_workflow" "$infra_workflow" "$deploy_workflow" "$migrate_workflow"; do
  grep -Fq './infra/oci/scripts/install-cli.sh' "$workflow" ||
    fail "pinned OCI CLI installer missing from $(basename "$workflow")"
  ! grep -Fq 'oracle-actions/run-oci-cli-command' "$workflow" ||
    fail "opaque OCI CLI action remains in $(basename "$workflow")"
done
grep -Fq '"oci-cli==${OCI_CLI_VERSION}"' "$cli_installer" ||
  fail "OCI CLI package installation is not pinned to OCI_CLI_VERSION"
grep -Fq 'python3 -m pip install' "$cli_installer" ||
  fail "OCI CLI installer does not use the runner's explicit Python 3"
! grep -R --include='*.sh' -F -- '--network-security-group-id' "$OCI_DIR/scripts" >/dev/null ||
  fail "OCI scripts use the unsupported NSG rule argument --network-security-group-id"
grep -Fq -- '--nsg-id "$nsg_id"' "$OCI_DIR/scripts/provision.sh" ||
  fail "OCI network reconciliation does not use the supported NSG rule argument"
! grep -Eq 'AZURE_|azure/' "$infra_workflow" "$deploy_workflow" ||
  fail "Azure credentials leaked into OCI infrastructure/deployment"

while IFS= read -r use; do
  [[ "$use" =~ @[0-9a-f]{40}$ ]] ||
    fail "third-party action is not pinned to a full commit SHA: $use"
done < <(
  sed -n -E 's/^[[:space:]]*uses:[[:space:]]*([^[:space:]#]+).*/\1/p' \
    "$ROOT_DIR/.github/workflows"/oci-*.yml
)

grep -Fq 'OCI_A1_OCPUS=2' "$OCI_DIR/config/free-tier.env.example"
grep -Fq 'OCI_CLI_VERSION=3.90.0' "$OCI_DIR/config/free-tier.env.example"
grep -Fq 'OCI_A1_MEMORY_GB=12' "$OCI_DIR/config/free-tier.env.example"
grep -Fq 'OCI_A1_MEMORY_PROFILES=12' "$OCI_DIR/config/free-tier.env.example"
grep -Fq 'OCI_RUNTIME_MODE=oke' "$OCI_DIR/config/free-tier.env.example"
grep -Fq 'OCI_K3S_VERSION=v1.34.9+k3s1' "$OCI_DIR/config/free-tier.env.example"
grep -Fq 'OCI_K3S_BINARY_SHA256=c782d6bb71eb2eb30f034aaddabb480294f9fdae5a7bca49ac5e3e0f66b96ea5' \
  "$OCI_DIR/config/free-tier.env.example"
grep -Fq 'OCI_MONGO_VOLUME_GB=50' "$OCI_DIR/config/free-tier.env.example"
grep -Fq 'OCI_EXPECTED_MONTHLY_COST=0' "$OCI_DIR/config/free-tier.env.example"
grep -Fq 'OCI_REGISTRY_MAX_BYTES=500000000' "$OCI_DIR/config/free-tier.env.example"
grep -Fq 'OCI_INGRESS_NGINX_CHART_SHA256=3eff0bd18151d6e6b1c441463410571443dda1ac78292cb189346628de784f0c' \
  "$OCI_DIR/config/free-tier.env.example"
grep -Fq 'OCI_CERT_MANAGER_CHART_SHA256=c27101f3f3e2349fb4a9e704316105bf7b52ad73b8c8257d3498ef7f2f6a4adc' \
  "$OCI_DIR/config/free-tier.env.example"
grep -Fq 'VM.Standard.A1.Flex' "$OCI_DIR/scripts/provision.sh"
grep -Fq -- '--type BASIC_CLUSTER' "$OCI_DIR/scripts/provision.sh"
grep -Fq 'compute-capacity-report create' "$OCI_DIR/scripts/preflight.sh"
grep -Fq 'compute compute-capacity-report create' "$OCI_DIR/scripts/capacity-report.sh"
grep -Fq 'oci compute instance launch' "$OCI_DIR/scripts/acquire-a1.sh"
! grep -Fq -- '--fault-domain' "$OCI_DIR/scripts/acquire-a1.sh" ||
  fail "capacity acquisition must let OCI choose the fault domain"
if grep -R -n -E 'nat-gateway create|--type ENHANCED_CLUSTER|VM\.Standard\.(E|D|B|X|GPU)' \
  "$OCI_DIR/scripts" >/dev/null 2>&1; then
  fail "OCI scripts contain a paid infrastructure fallback"
fi

validate_production_build_deployment_safety_contract() {
  local workflow_file="$1"
  ruby - "$workflow_file" <<'RUBY'
require "yaml"

workflow_file = ARGV.fetch(0)
workflow_text = File.read(workflow_file)
expected_checkout = "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683"
approved_action_refs = {
  "actions/checkout" => "11bd71901bbe5b1630ceea73d27597364c9af683",
  "actions/setup-node" => "49933ea5288caeca8642d1e84afbd3f7d6820020",
  "actions/cache" => "0400d5f644dc74513175e3cd8d07132dd4860809",
  "docker/setup-buildx-action" => "e468171a9de216ec08956ac3ada2f0791b6bd435",
  "docker/login-action" => "184bdaa0721073962dff0199f1fb9940f07167d1",
  "docker/build-push-action" => "ca052bb54ab0790a636c9b5f226502c73d547a25",
  "actions/upload-artifact" => "ea165f8d65b6e75b540449e92b4886f43607fa02",
}.freeze
expected_syntax_targets = [
  "infra/azure/agents/deploy-validation-loop-stan.sh",
  "infra/azure/agents/live-betting-readiness-lib.sh",
  "infra/azure/agents/live-betting-readiness-stan.sh",
  "infra/azure/agents/live-betting-readiness-test-lib.sh",
  "infra/azure/agents/pre-commit-infra-check-stan.sh",
  "infra/azure/agents/test-deploy-validation-loop-stan.sh",
  "infra/azure/agents/test-deployment-safety-ci-stan.sh",
  "infra/azure/agents/test-live-betting-readiness-stan.sh",
  "infra/azure/agents/test-live-betting-rollback-readiness-stan.sh",
  "infra/azure/agents/test-production-rollback-stan.sh",
  "infra/oci/agents/deploy-validation-loop-stan.sh",
  "infra/oci/agents/live-betting-readiness-stan.sh",
  "infra/oci/scripts/deploy.sh",
  "infra/oci/scripts/live-data-maintenance-stan.sh",
  "infra/oci/scripts/live-betting-control-stan.sh",
  "infra/oci/scripts/revalidate-live-activation-stan.sh",
  "infra/oci/scripts/live-betting-data-rollout-stan.sh",
  "infra/oci/scripts/shared-mongo-operation-lock-stan.sh",
  "infra/oci/scripts/verify-live-betting-data-evidence-stan.sh",
  "infra/oci/tests/test-deploy-validation-loop-stan.sh",
  "infra/oci/tests/test-live-data-maintenance-stan.sh",
  "infra/oci/tests/test-live-betting-control-stan.sh",
  "infra/oci/tests/test-revalidate-live-activation-stan.sh",
  "infra/oci/tests/test-live-betting-data-rollout-stan.sh",
  "infra/oci/tests/test-live-betting-readiness-stan.sh",
  "infra/oci/tests/rollback-live-readiness-contract.sh",
  "infra/oci/tests/rollback-contract.sh",
]
expected_exec_targets = [
  "./infra/azure/agents/pre-commit-infra-check-stan.sh",
  "./infra/azure/agents/test-deployment-safety-ci-stan.sh",
  "./infra/azure/agents/test-deploy-validation-loop-stan.sh",
  "./infra/azure/agents/test-live-betting-readiness-stan.sh",
  "./infra/azure/agents/test-live-betting-rollback-readiness-stan.sh",
  "./infra/azure/agents/test-production-rollback-stan.sh",
  "./infra/oci/tests/test-deploy-validation-loop-stan.sh",
  "./infra/oci/tests/test-live-data-maintenance-stan.sh",
  "./infra/oci/tests/test-live-betting-control-stan.sh",
  "./infra/oci/tests/test-revalidate-live-activation-stan.sh",
  "./infra/oci/tests/test-live-betting-data-rollout-stan.sh",
  "./infra/oci/tests/test-live-betting-readiness-stan.sh",
  "./infra/oci/tests/rollback-live-readiness-contract.sh",
  "./infra/oci/tests/rollback-contract.sh",
]
expected_yaml_targets = [
  ".github/workflows/production-build.yml",
  ".github/workflows/production-deploy.yml",
  ".github/workflows/oci-live-betting-activate.yml",
  ".github/workflows/oci-live-betting-disable.yml",
  ".github/workflows/oci-live-data-rollout.yml",
  ".github/workflows/oci-production-deploy.yml",
]

def flatten_strings(value, output = [])
  case value
  when String
    output << value
  when Array
    value.each { |item| flatten_strings(item, output) }
  when Hash
    value.each do |key, item|
      flatten_strings(key, output)
      flatten_strings(item, output)
    end
  end
  output
end

def writable_permissions?(value)
  case value
  when String
    value.include?("write")
  when Hash
    value.any? { |_key, item| writable_permissions?(item) }
  else
    false
  end
end

def deep_stringify_workflow_keys(value)
  case value
  when Hash
    value.each_with_object({}) do |(key, item), output|
      normalized_key = key == true ? "on" : key.to_s
      output[normalized_key] = deep_stringify_workflow_keys(item)
    end
  when Array
    value.map { |item| deep_stringify_workflow_keys(item) }
  else
    value
  end
end

def load_workflow_document(text)
  deep_stringify_workflow_keys(YAML.load_stream(text).first)
end

def parse_action_uses(workflow_text)
  entries = []
  workflow_text.each_line.with_index(1) do |line, line_number|
    next unless line =~ /^\s*uses:\s*([^\s#]+)/

    entries << {
      "line" => line_number,
      "use" => Regexp.last_match(1),
    }
  end
  entries
end

def validate_action_pins(workflow_text, approved_action_refs)
  errors = []
  seen_repositories = []

  parse_action_uses(workflow_text).each do |entry|
    line_number = entry.fetch("line")
    use = entry.fetch("use")
    match = use.match(/\A(?<repository>[^@\s]+)@(?<ref>[^\s]+)\z/)

    unless match
      errors << "production-build uses entry at line #{line_number} does not pin an action ref: #{use}"
      next
    end

    repository = match[:repository]
    ref = match[:ref]
    seen_repositories << repository

    expected_ref = approved_action_refs[repository]
    unless expected_ref
      errors << "production-build uses entry at line #{line_number} references an unreviewed third-party action: #{repository}"
      next
    end

    unless ref.match?(/\A[0-9a-f]{40}\z/)
      errors << "production-build uses entry at line #{line_number} is not pinned to a full 40-character lowercase hex commit SHA: #{use}"
      next
    end

    next if ref == expected_ref

    errors << "production-build uses entry at line #{line_number} is pinned to #{repository}@#{ref}, expected #{repository}@#{expected_ref}"
  end

  missing_repositories = approved_action_refs.keys - seen_repositories.uniq
  unexpected_repositories = seen_repositories.uniq - approved_action_refs.keys
  if missing_repositories.any? || unexpected_repositories.any?
    fragments = []
    fragments << "missing reviewed actions: #{missing_repositories.join(', ')}" if missing_repositories.any?
    fragments << "unexpected actions: #{unexpected_repositories.sort.join(', ')}" if unexpected_repositories.any?
    errors << "production-build action inventory changed (#{fragments.join('; ')})"
  end

  errors
end

def normalize_run(run)
  ruby_block = run.match(/ruby -ryaml -e '\n(?<body>.*?)\n\s*'/m)
  normalized_run = if ruby_block
    run.sub(ruby_block[0], "RUBY_PRODUCTION_WORKFLOW_PARSE\n")
  else
    run
  end
  tokens = normalized_run.lines.map { |line| line.strip }.reject(&:empty?)
  [tokens, ruby_block&.named_captures&.fetch("body", nil)]
end

def validate_workflow(
  workflow_text,
  expected_checkout:,
  approved_action_refs:,
  expected_syntax_targets:,
  expected_exec_targets:,
  expected_yaml_targets:
)
  errors = []
  document = load_workflow_document(workflow_text)
  jobs = document["jobs"] || {}

  permissions = document["permissions"]
  errors << "production-build permissions must stay read-only" unless permissions == { "contents" => "read" }
  errors << "production-build must not request writable permissions" if writable_permissions?(permissions)
  errors.concat(validate_action_pins(workflow_text, approved_action_refs))

  safety_job = jobs["deployment-safety-contracts"]
  unless safety_job.is_a?(Hash)
    errors << "deployment-safety-contracts job is missing"
    return errors
  end
  errors << "deployment-safety-contracts must stay on ubuntu-latest" unless safety_job["runs-on"] == "ubuntu-latest"
  errors << "deployment-safety-contracts must not declare job env" if safety_job.key?("env")
  errors << "deployment-safety-contracts must not declare job permissions" if safety_job.key?("permissions")

  safety_job_strings = flatten_strings(safety_job)
  if safety_job_strings.any? { |value| value.include?("secrets.") || value.include?("${{ secrets.") }
    errors << "deployment-safety-contracts must not receive production credentials"
  end
  if safety_job_strings.any? { |value| value.match?(/\b(OCI_CLI_|OCI_CI_|AZURE_|KUBECONFIG|GITHUB_TOKEN|DOCKERHUB_)\b/) }
    errors << "deployment-safety-contracts references production-capable credentials"
  end
  if safety_job_strings.any? { |value| value.include?("${{ vars.") }
    errors << "deployment-safety-contracts must not rely on mutable workflow vars"
  end

  steps = safety_job["steps"]
  unless steps.is_a?(Array) && steps.length == 2
    errors << "deployment-safety-contracts must keep exactly two steps"
    return errors
  end

  checkout_step = steps[0] || {}
  validate_step = steps[1] || {}
  errors << "deployment-safety-contracts checkout action is no longer pinned" unless checkout_step["uses"] == expected_checkout
  errors << "deployment-safety-contracts checkout step changed shape" unless checkout_step.keys.sort == %w[name uses]
  errors << "deployment-safety-contracts validation step changed shape" unless validate_step.keys.sort == %w[name run]

  tokens, yaml_block = normalize_run(validate_step["run"].to_s)
  syntax_targets = []
  exec_targets = []
  unexpected_tokens = []

  tokens.each do |token|
    case token
    when "RUBY_PRODUCTION_WORKFLOW_PARSE"
      next
    when /\Abash -n (.+)\z/
      syntax_targets << Regexp.last_match(1)
    when /\A\.\//
      exec_targets << token
    else
      unexpected_tokens << token
    end
  end

  errors << "deployment-safety-contracts contains unexpected commands: #{unexpected_tokens.join(', ')}" unless unexpected_tokens.empty?
  errors << "deployment-safety-contracts syntax checks changed" unless syntax_targets == expected_syntax_targets
  errors << "deployment-safety-contracts fixture executions changed" unless exec_targets == expected_exec_targets

  run_text = validate_step["run"].to_s
  if (forbidden_command = run_text.each_line.map(&:strip).reject(&:empty?).find { |line| line.match?(/\b(kubectl|gh|curl)\b/) })
    errors << "deployment-safety-contracts contains a production-capable command: #{forbidden_command}"
  end
  if (dangerous_local = exec_targets.find { |target| target.match?(%r{\A\./infra/(?:azure|oci)/(?:agents|scripts)/(?!(?:pre-commit-infra-check|test-).+\.sh\z).+}) })
    errors << "deployment-safety-contracts invokes a non-fixture local command: #{dangerous_local}"
  end

  unless yaml_block &&
         yaml_block.include?("YAML.load_stream(File.read(file))") &&
         expected_yaml_targets.all? { |target| yaml_block.include?(target) }
    errors << "deployment-safety-contracts workflow YAML parse block changed"
  end

  pr_job = jobs["pr-quality-gates"] || {}
  errors << "pr-quality-gates must depend on deployment-safety-contracts" unless Array(pr_job["needs"]).include?("deployment-safety-contracts")
  pr_gate_step = Array(pr_job["steps"]).find { |step| step["name"] == "Require every validation gate" } || {}
  pr_gate_env = pr_gate_step["env"] || {}
  unless pr_gate_env["DEPLOYMENT_SAFETY_RESULT"] == "${{ needs.deployment-safety-contracts.result }}"
    errors << "pr-quality-gates lost deployment-safety result wiring"
  end
  unless pr_gate_step["run"].to_s.include?('$DEPLOYMENT_SAFETY_RESULT')
    errors << "pr-quality-gates no longer checks deployment-safety result"
  end

  build_job = jobs["build"] || {}
  errors << "build must depend on deployment-safety-contracts" unless Array(build_job["needs"]).include?("deployment-safety-contracts")
  unless build_job["if"].to_s.include?("needs.deployment-safety-contracts.result == 'success'")
    errors << "build no longer blocks on deployment-safety failure"
  end

  errors
end

def mutate_once(text, needle, replacement)
  mutated = text.sub(needle, replacement)
  raise "fixture mutation failed for #{needle.inspect}" if mutated == text
  mutated
end

errors = validate_workflow(
  workflow_text,
  expected_checkout: expected_checkout,
  approved_action_refs: approved_action_refs,
  expected_syntax_targets: expected_syntax_targets,
  expected_exec_targets: expected_exec_targets,
  expected_yaml_targets: expected_yaml_targets,
)
abort(errors.join("\n")) unless errors.empty?

negative_cases = {
  "missing-fixture-test" => [
    mutate_once(
      workflow_text,
      "          ./infra/oci/tests/rollback-contract.sh\n",
      ""
    ),
    "deployment-safety-contracts fixture executions changed",
  ],
  "production-capable-command" => [
    mutate_once(
      workflow_text,
      "          ./infra/azure/agents/pre-commit-infra-check-stan.sh\n",
      "          kubectl get deployments -n default\n          ./infra/azure/agents/pre-commit-infra-check-stan.sh\n"
    ),
    "deployment-safety-contracts contains a production-capable command",
  ],
  "writable-permissions" => [
    mutate_once(
      workflow_text,
      "permissions:\n  contents: read",
      "permissions:\n  contents: write"
    ),
    "production-build permissions must stay read-only",
  ],
  "floating-major-tag" => [
    mutate_once(
      workflow_text,
      "actions/cache@0400d5f644dc74513175e3cd8d07132dd4860809",
      "actions/cache@v4"
    ),
    "is not pinned to a full 40-character lowercase hex commit SHA",
  ],
  "short-sha" => [
    mutate_once(
      workflow_text,
      "docker/login-action@184bdaa0721073962dff0199f1fb9940f07167d1",
      "docker/login-action@184bdaa0721073962dff0199f1fb9940f07167d"
    ),
    "is not pinned to a full 40-character lowercase hex commit SHA",
  ],
  "uppercase-nonhex" => [
    mutate_once(
      workflow_text,
      "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      "actions/setup-node@49933EA5288CAECA8642D1E84AFBD3F7D6820020"
    ),
    "is not pinned to a full 40-character lowercase hex commit SHA",
  ],
  "wrong-full-sha" => [
    mutate_once(
      workflow_text,
      "docker/build-push-action@ca052bb54ab0790a636c9b5f226502c73d547a25",
      "docker/build-push-action@0000000000000000000000000000000000000000"
    ),
    "expected docker/build-push-action@ca052bb54ab0790a636c9b5f226502c73d547a25",
  ],
  "unknown-action" => [
    mutate_once(
      workflow_text,
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
      "acme/unknown-action@ea165f8d65b6e75b540449e92b4886f43607fa02"
    ),
    "references an unreviewed third-party action",
  ],
  "ungated-build" => [
    mutate_once(
      workflow_text,
      "      needs.deployment-safety-contracts.result == 'success' &&\n",
      ""
    ),
    "build no longer blocks on deployment-safety failure",
  ],
}

negative_cases.each do |name, (candidate, expected_error)|
  candidate_errors = validate_workflow(
    candidate,
    expected_checkout: expected_checkout,
    approved_action_refs: approved_action_refs,
    expected_syntax_targets: expected_syntax_targets,
    expected_exec_targets: expected_exec_targets,
    expected_yaml_targets: expected_yaml_targets,
  )
  if candidate_errors.empty?
    abort("#{name} fixture unexpectedly passed")
  end
  next if candidate_errors.any? { |error| error.include?(expected_error) }

  abort("#{name} fixture failed for the wrong reason: #{candidate_errors.join(' | ')}")
end

puts "production_build_deployment_safety_contract=PASS cases=#{negative_cases.length + 1}"
RUBY
}

validate_production_build_deployment_safety_contract \
  "$ROOT_DIR/.github/workflows/production-build.yml"

if [[ "${BETSTAN_CONTRACT_ORCHESTRATED:-0}" != "1" ]]; then
  "$OCI_DIR/tests/test-migration-success-contract.sh"
  "$OCI_DIR/tests/test-capacity-contract.sh"
  "$OCI_DIR/tests/test-image-reuse-contract.sh"
  "$OCI_DIR/tests/test-k3s-runtime-contract.sh"
  "$OCI_DIR/tests/test-registry-prune-contract.sh"
  "$OCI_DIR/tests/test-migration-recovery-contract.sh"
  "$OCI_DIR/tests/test-mongo-upgrade.sh"
  "$OCI_DIR/agents/test-health-contract-stan.sh"
  "$ROOT_DIR/infra/azure/agents/test-retire-production-reentrant-stan.sh"
  "$ROOT_DIR/infra/azure/agents/test-retire-migration-identities-stan.sh"
  "$ROOT_DIR/infra/azure/agents/test-audit-oci-primary-retirement-stan.sh"
fi

echo "oci_offline_contract=PASS"
