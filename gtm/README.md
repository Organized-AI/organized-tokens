# Sponsor introductions → evidence-backed hiring conversations

This feature prepares a private company-by-company campaign review. It starts with an Organized AI event sponsorship invitation, then prepares a separate hiring follow-up. A candidate-specific follow-up requires consented, work-backed assessment evidence and a recent employer-confirmed job source. Otherwise the follow-up is a general job-board invitation.

**Test-only. No messages are sent.** These scripts do not send emails, enroll sequences, import contacts, create accounts, or submit applications. The HTML's copy buttons only copy draft text. Keep output local: it contains contact research and consented assessment summaries.

## Run

Requires Node 24 (or a Node version supporting TypeScript stripping), no new dependencies.

```sh
npm run gtm:test
npm run gtm:prepare -- --config /absolute/path/campaign.json --out /absolute/path/private-review
```

The config uses paths relative to itself:

```json
{
  "campaign": {
    "id": "organized-ai-sponsor-pilot",
    "event_series": "Organized AI’s Austin AI workshops and hackathons",
    "sender_name": "Jordaaan",
    "sponsor_url": "https://sponsor.organizedai.vip/",
    "job_board_url": "https://jobs.organizedai.vip/",
    "assessment_url": "https://assessment.organizedai.vip/example"
  },
  "companies": "employers.json",
  "roles": "roles.json",
  "contacts": "reviewed-contacts.json",
  "findings": "hiring-source-discrepancies.json",
  "suppressed": "suppressed.json",
  "candidates": [{"profile": "candidate-profile.json", "consent": "candidate-consent.json"}]
}
```

`contacts`, `findings`, `suppressed`, and `candidates` are optional. Existing inventory and reviewed-contact JSON from the GTM workspace are accepted directly. Output includes `campaign-review.html`, `campaign-review.json`, and `engram-handoff.json`, written owner-only. Re-running replaces the snapshots; it does not schedule or dispatch anything.

## Evidence and consent

Candidate profiles pass the existing strict assessment/privacy validation. Candidate consent must separately include:

```json
{
  "matching": true,
  "public_link_in_drafts": true,
  "profile_sha256": "CANONICAL_DIGEST_FROM_THE_FUNCTION_BELOW",
  "public_url": "https://assessment.organizedai.vip/p/CANDIDATES_REAL_PUBLIC_ID",
  "source": "Reference to the candidate's actual consent record",
  "recorded_at": "2026-09-17T12:00:00Z",
  "revoked": false
}
```

Compute the digest using `digest(profile)` exported from `gtm/core.mjs`; it uses a stable, normalized representation so importing the same assessment does not invalidate consent. Do not invent a consent record. Profile edits require consent for the new evidence. This local manifest is an operator-provided record, not cryptographic proof of consent or public-link ownership. Before any future send, verify the public link still exists, belongs to the candidate and represents the reviewed report.

Only established capabilities tied to cited completed work can produce matches. Directed/delegated execution is retained as context, not penalized. Reasons show role excerpts, evidence IDs, linked work, delivery state, authorship and verification mode. These are work-topic suggestions requiring human review, not an eligibility verdict or proof of every required skill. Unmatched specialist requirements, location restrictions, experience and compensation still need review.

## Job sources

```sh
npm run gtm:collect-jobs -- --config public-sources.json --out current-employer-roles.json
```

```json
{
  "sources": [
    {"kind": "greenhouse", "board": "EMPLOYER_BOARD_TOKEN", "company_id": "COMPANY_ID", "company_name": "Company"},
    {"kind": "lever", "board": "EMPLOYER_BOARD_TOKEN", "company_id": "COMPANY_ID", "company_name": "Company"},
    {"kind": "career-jsonld", "file": "captured-careers.html", "source_url": "https://example.com/careers", "company_id": "COMPANY_ID", "company_name": "Company", "collected_at": "2026-09-17T12:00:00Z"},
    {"kind": "import", "provider": "linkedin", "file": "authorized-job-export.json"}
  ]
}
```

The operator must establish that the configured ATS board belongs to the specified company. Greenhouse and Lever adapters issue read-only requests to fixed public hosts, record capture time/source URL/body hash, and fail on unexpected or incomplete responses. No authenticated records are fetched. Career-page JSON-LD parsing works on a saved HTML capture and does not assume a successful page load proves availability. Indeed and LinkedIn are supported as normalized imports from permitted exports/collection; this feature does not implement login scraping or bypass access restrictions.

Role records require `id`, `company_id`, `title`, HTTPS `source_url`, `description` (or `description_html`), and `collected_at`. Include `apply_url`, location and expiry when available. Imported board listings remain unconfirmed. A role can support a candidate-specific draft only with `availability: "employer-confirmed"`, `availability_checked_at`, and `availability_source_url`, with both capture and availability check within seven days. Past expiry, future timestamps and recorded closure findings prevent an active claim. Refresh this evidence again before future delivery.

The collector fails the batch rather than silently replacing a previous complete snapshot with a partial result. Keep its receipts beside the output. Employer feed adapters have fixture-backed contract tests; live provider verification is a separate step.

## Contact routing and sequence

Only fresh employer-published, reviewed contact routes enter the review. Partnership, founder and general routing contacts can be used for sponsorship review; recruiting contacts remain in the hiring lane. Neither source review nor a public email address is recipient approval. Missing contacts create research tasks. Exact duplicate company identities are flagged for reconciliation; aliases and parent/subsidiary relationships still require review.

The two draft stages retain distinct IDs and interests. Follow-up requires a recorded first send, no opt-out or negative response, a reviewed recipient, current role/consent evidence, and approved copy. Suppression inputs accept `{ "company_id": "..." }` or `{ "value": "email-or-profile-url" }`. Company suppression removes all drafts/matches; a suppressed route is removed case-insensitively. There is deliberately no automatic timing or sending in this release.

## Engram integration point

See [ENGRAM.md](ENGRAM.md). The handoff is a provider-independent research queue with account IDs, company URLs, next actions and blockers. It excludes candidate identities, profile evidence, contact addresses and draft bodies. Generating it does not upload it anywhere. Connectors can enrich accounts and return source-backed results; local review/consent rules remain authoritative.

## Luma boundary

Luma's current documented send operation sends invitations to a specific event. It is not a general sponsor-email sequence API. Sponsorship/hiring drafts need an appropriate separately authorized messaging channel; Luma can supply event context and approved event invitations later. This release does not call Luma, send messages, import contacts or create an event.
