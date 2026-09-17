# Assessment integration

Job seekers create an AI Work Assessment locally, review it, and check its schema and known privacy patterns in their browser before continuing to the Niceboard sign-up page. The checker sends no report data and does not attach a report to Niceboard. The report complements the resume; a valid schema does not verify a person's claims or establish a hiring recommendation.

The optional workshop submission remains separate: `share` publishes a structured profile; `keep` stores it privately. Raw transcripts stay local. A private latest submission unlists the owner, and leaving removes their assessments, activity counts and credential in one D1 transaction.

## Reproducible assets

`package.json` and `package-lock.json` pin Organized-AI/ai-work-assessment commit `da53082984e3d792ccf66cf717e8ea8bc1c2d213` (tag `v8.0.0-organized.1`, helper 8.0.0, prompt 8, schema 9). This is the MIT-licensed distribution; its copyright and license are in `THIRD_PARTY/ai-work-assessment-LICENSE`.

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
