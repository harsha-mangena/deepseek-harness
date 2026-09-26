# @deepseek-ai/dsh-system1-observations

Observation synthesis and candidate menu generation for System 1 (Jev-only).

## What it provides

- **Observation synthesis**: provenance-labelled, bounded (32k chars), secret-filtered state strings for decision input. The 32k bound applies to the final rendered payload, including provenance labels, separators, and the truncation marker; budgets count Unicode characters and truncation never splits a surrogate pair.
- **Secret filtering**: structured redaction of JSON payloads (sensitive keys such as `api_key`, `password`, `secret`, `token`, and spelling variants, in nested objects, arrays, and JSON embedded in strings) plus a text-pattern fallback for free-form logs (quoted pairs, `Authorization: Bearer` headers, values on following lines). This is defense in depth only: callers must still minimize the fields they serialize before handing text to this package, since no filter can make arbitrary tool output safe to exfiltrate.
- **Candidate menus**: flat menus of executable bundles from the tool catalog. Each candidate carries a precondition hash (SHA-256 of canonical JSON). An ESCALATE/NONE candidate is always reserved last; if pruning removed a plausible action, the provider abstains rather than forcing an inaccurate choice.
- **Hashing**: `hashObservations` for the `observationHash` field; `hashPreconditions` for candidate precondition integrity.

## Known Limitations and Deferred Work

- Candidate generation is currently a flat menu; hierarchical family shortlists with uncertainty propagation are a later optimization (per plan §7).
- Observation sources are currently tool results, session events, user input, and system messages. Richer provenance (e.g. MCP server identity) arrives with Phase 7.
