# @deepseek-ai/dsh-system1-mcp

MCP tool adapter with resilience and controlled mutations for System 1 (Jev-only).

## What it provides

- **McpAdapter**: adapts MCP tool definitions to System 1 catalog tools.
- **Controlled execution**: every dispatch runs pre-dispatch checks in order —
  caller cancellation, MCP identity, verification policy for mutating effects,
  authoritative operation registration (unknown or stale operationRefs are rejected
  with zero executor calls), candidate-metadata binding (effect and verification
  policy must match the adapted tool), then argument validation against the tool's
  JSON inputSchema. The executor receives the bound server/tool/catalog target.
- **Circuit breaker**: per tool identity; opens after N consecutive failures (default 3);
  half-opens after reset timeout (default 30s) with exactly one concurrent trial.
- **Timeouts**: per-call timeout (default 30s); abort propagation.
- **Controlled mutations**: write/external effects require an explicit verification policy ID;
  a failed mutating call reports an unknown outcome instead of claiming exactly-once.

## Design notes

- The MCP client owns reconnection (500ms initial, exponential backoff to 30s, 10 attempts). This adapter does not retry transport failures to avoid amplifying outages.
- Tool identification uses namespaced `operationRef` format `op:mcp:<name>:<catalogVersion>`
  or `op:mcp:<serverId>:<name>:<catalogVersion>`; the tool identity is `mcp:<name>`
  or `mcp:<serverId>:<name>`. Omitting `serverId`/`catalogVersion` in `adaptTool`
  keeps the legacy `mcp:<name>` / `op:mcp:<name>:v1` shape. Circuits are keyed by
  the namespaced identity, so same-named tools on different servers do not share breakers.
- Argument validation supports a documented JSON Schema subset (`type`, `properties`,
  `required`, `additionalProperties` as boolean or schema, `items`, `enum`, `const`,
  plus annotation keywords). Type-specific keywords apply by instance type even when
  the schema omits `type` (for example, `properties` still constrains an object instance).
  Anything else fails closed: `adaptTool` rejects the tool definition rather than
  silently skipping validation at dispatch.
- No exactly-once: an interrupted or failed mutating call may have taken effect.
  The adapter reports `EXECUTION_UNKNOWN` and the caller must reconcile before retrying.
  Effect certainty is derived from the dispatch phase and the candidate's effect, not
  from the error class: any failure after a mutating dispatch — including a typed
  transport error — reports unknown.

## Known Limitations and Deferred Work

- Mutation audit logging (pre/post state hashes) is future work.
- Two-phase commit for mutations is not implemented.
- The executor is injected by the host; wiring a real scoped ToolRuntime adapter is Phase C work.
- Unknown-outcome reconciliation after an interrupted write belongs to the caller (Phase D).
