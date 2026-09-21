# Engram integration boundary

The user selected **Organized AI workflow with an Engram integration point**. The application remains Organized AI. Engram (formerly Thundercat) is an optional GTM connector provider, not a sponsor target inferred from the supplied deck.

Official public documentation inspected on September 17, 2026:

- https://docs.thundercat.io/guides/mcp — remote MCP setup and workspace scoping.
- https://docs.thundercat.io/guides/skills — activate and launch workspace GTM flows.
- https://thundercat.io/ — product site linking to the Engram documentation.

The confidential user-provided deck was read for context. Its confidential content, commercial figures and named prospects are not included in this repository or outreach.

## Connect later

In Engram, connect the desired tools for the Organized AI brand, then open **Connectors → MCP Access** (sometimes labeled **Manage API keys**). Create a client-specific key and use the URL/configuration shown by that workspace. The documented production URL shape is `https://engram-chat.onrender.com/mcp/connectors`, using streamable HTTP and a bearer key. Prefer the actual workspace URL when it differs. Store credentials in the client's secret/environment settings, never in the handoff file or repository.

Discover the actual connector tool schemas after authentication. The public docs describe connector capabilities, not a stable set of tool names or a generic workflow-run REST API. Do not invent those names or treat this document as a working authenticated connection.

## Handoff contract

`engram-handoff.json` uses schema `organized-ai-engram-handoff/v1` and mode `review-only`. Each account has a stable ID, company name, website, next action, known sponsorship-route count, listing count and blockers. It sorts the research queue by employer-confirmed opening count, missing sponsorship route, then listing count; `high` means a current employer-confirmed opening still needs a sponsorship route. `priority_reasons` makes that ordering inspectable. Candidates, assessment links, evidence, recipient addresses and message bodies stay local.

An Engram research run can return ordinary reviewed-contact records compatible with `gtm/core.mjs`: company ID, public route, role/function, purpose, source URL, source excerpt, check time and verification status. New results should begin `published-route-needs-review`; only after review should they use `employer-published-role-and-route-reviewed`. Merge these into the local input, then regenerate the review. Do not auto-promote tool output into send authorization.

Suggested research-only instruction:

> Research the accounts in this handoff for Organized AI event sponsorship. Find employer-published partnership, marketing or founder routes and current career-page openings. Keep sources and observation dates. Return research for review. Do not send, import contacts, create CRM records, enroll sequences, or upload candidate/private work evidence.

The next connection test should only authenticate and list available tools. No live Engram credential was used for this feature, and no account data was uploaded.
