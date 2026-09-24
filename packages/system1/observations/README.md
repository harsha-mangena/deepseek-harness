# @deepseek-ai/dsh-system1-observations

Observation synthesis and candidate menu generation for System 1 (Jev-only).

## What it provides

- **Observation synthesis**: provenance-labelled, bounded (32k chars), secret-filtered state strings for decision input. Secrets (API keys, bearer tokens, passwords, private keys) are redacted before reaching any provider.
- **Candidate menus**: flat menus of executable bundles from the tool catalog. Each candidate carries a precondition hash (SHA-256 of canonical JSON). An ESCALATE/NONE candidate is always reserved last; if pruning removed a plausible action, the provider abstains rather than forcing an inaccurate choice.
- **Hashing**: `hashObservations` for the `observationHash` field; `hashPreconditions` for candidate precondition integrity.

## Known Limitations and Deferred Work

- Candidate generation is currently a flat menu; hierarchical family shortlists with uncertainty propagation are a later optimization (per plan §7).
- Observation sources are currently tool results, session events, user input, and system messages. Richer provenance (e.g. MCP server identity) arrives with Phase 7.
