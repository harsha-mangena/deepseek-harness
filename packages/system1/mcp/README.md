# @deepseek-ai/dsh-system1-mcp

MCP tool adapter with resilience and controlled mutations for System 1 (Jev-only).

## What it provides

- **McpAdapter**: adapts MCP tool definitions to System 1 catalog tools.
- **Circuit breaker**: per-tool; opens after N consecutive failures (default 3); half-opens after reset timeout (default 30s).
- **Timeouts**: per-call timeout (default 30s); abort propagation.
- **Controlled mutations**: write effects are adapted with explicit verification policy IDs; the adapter does not bypass policy.

## Design notes

- The MCP client owns reconnection (500ms initial, exponential backoff to 30s, 10 attempts). This adapter does not retry transport failures to avoid amplifying outages.
- Tool identification uses `operationRef` format `op:mcp:<name>:v1`.

## Known Limitations and Deferred Work

- Mutation audit logging (pre/post state hashes) is future work.
- Two-phase commit for mutations is not implemented.
