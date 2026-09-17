# Assessment integration

Job seekers create and review an AI Work Assessment locally, then optionally publish a standalone link and create an employer-visible Niceboard account with separate explicit consent. Local validation sends no report data. Public sharing sends only the structured assessment; it excludes raw sessions and account credentials. A valid schema does not independently verify claims or establish a hiring recommendation.

Public links use `/p/<random-id>`, work without login, and stay immutable. Candidates receive a private management link before publication dispatch; removal erases the report and reserves the old URL so it cannot be reused. Search indexing is disabled, but anyone with the link can view or save the report.

Automatic signup is feature gated and currently disabled pending Niceboard credential setup and live contract verification. Direct Niceboard signup remains available. When enabled, signup requires employer-visibility and terms consent, reserves an idempotent receipt before creation, verifies the resulting account, and appends only an owned link for the exact submitted report. Uncertain outcomes are never retried as new accounts. Opportunity suggestions cite delivered-work evidence and job text; they are preliminary overlaps, not eligibility decisions.

The optional workshop submission remains separate: `share` publishes a structured profile; `keep` stores it privately. Raw transcripts are not submitted to Organized AI; model-provider data settings still apply during assessment generation. A private latest submission unlists the owner, and leaving removes their assessments, activity counts and credential in one D1 transaction.

## Reproducible assets

`package.json` and `package-lock.json` pin Organized-AI/ai-work-assessment commit `040b197732b12048b3a8287c053759742b968e64` (tag `v8.0.1-organized.1`, helper 8.0.1, prompt 8, schema 9). This is the MIT-licensed distribution; its copyright and license are in `THIRD_PARTY/ai-work-assessment-LICENSE`.

From this directory with Node 22.18 or later:

```sh
npm ci --ignore-scripts
npm run assessment:sync
npm run assessment:check
npm test
npm run typecheck
python3 -m unittest discover -s ../test -v
```

The sync command regenerates both validators, the test fixture, license, and the clearly labeled synthetic `public/example.html`. Do not edit these generated assets by hand. The sample is generated from the upstream fictional fixture and is never submitted to a live candidate directory.

Multi-environment collection produces reviewed local evidence bundles. The source filter runs before synthesis reads their text, writes a new private directory for each selection, and preserves the originals. When some sources are omitted, global caveats may also be withheld; the filtered bundle explicitly discloses this and retains selected source/session limitations. No model should interpret missing evidence as missing ability.

## Verification and deployment

Tests use synthetic fixtures and an in-memory SQLite adapter for the production queries. They cover schema intake, privacy patterns including escaped credentials, actual request size, workshop-scoped identity, visibility changes, source filtering, and rollback on deletion failure. Live checks must not publish test profiles or read real candidate session histories.

Deploy the root tokens asset Worker and this leaderboard Worker together after checks pass. The current Python script must expose `--submit`; verify `/tokens.py`, `/prompt-config.js`, `/assessment-flow.js`, `/validate-profile.js`, `/filter-bundles.mjs`, `/example`, and the Niceboard entry link after deployment. Luma outreach is a separate final step and is paused.

## Public-link rollout

Apply migration 005 for public sharing. Migration 004 is required only before enabling candidate signup. Configure `NICEBOARD_API_BASE` and keep `CANDIDATE_SIGNUP_ENABLED=false` until the `NICEBOARD_API_KEY` Worker secret is provisioned and the real create/get contract is verified. Public links work independently of that credential. Never store management tokens in public artifacts.
