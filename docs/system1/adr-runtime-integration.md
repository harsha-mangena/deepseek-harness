---
description: "Phase 0 runtime-integration decisions: custom registered Agent coexistence, lifecycle ownership, initiator propagation, guarded tools, session event invariants, MCP findings."
---

# System 1 runtime integration ADR

English | [中文](adr-runtime-integration.zh.md)

## Context

System 1 must run inside DeepSeek Harness without disturbing the standard DeepSeek path. The harness owns one `AgentRegistry` with a single factory slot (`setFactory`), a Cordis plugin lifecycle, a guarded tool runtime, and an append-only session event log. This record captures the integration decisions that keep System 1 a well-behaved guest.

## Decision 1: coexist as a custom registered runtime root

System 1 registers already-constructed `System1CoordinatorAgent` instances through `AgentRegistry.register()` and never calls `setFactory()`. The standard DeepSeek path keeps its single factory; System 1 coordinators live beside it as custom runtime roots with ids equal to their session ids, so the registry's collision checks keep the two paths from ever sharing an agent. The plugin's `create()` only hands out a handle after `agent/created` has been delivered; a veto or collision rejects there and unwinds everything created so far, leaving no residue.

## Decision 2: the plugin owns coordinator lifecycle end to end

Each coordinator handle owns a strict teardown order: cancel and drain the driver, unwind the coordinator's owned Cordis effects in reverse registration order, then unregister the agent from the registry. Session detachment stays with the session store; the handle never closes a session it did not open. The plugin runs under a kill switch: while `mode` is `off`, coordinator creation is refused and the standard path is untouched. Lifecycle events dispatch through the sanctioned `agentEvents(ctx, agent)` seam on the plugin context, so they stay visible at the application root.

## Decision 3: capture and restore the initiator around driver work

The coordinator captures the ambient initiator when it wakes and restores it for the driver's lifetime through `agents.withInitiator()`. Guarded tools and delegated work therefore see the System 1 coordinator as the initiator, not whatever happened to be ambient when the driver ran. The probe suite pins this propagation.

## Decision 4: guarded tools enter through the public executor only

Every System 1 tool call goes through the public `ToolRuntime.execute(ToolExecutionInput)` with a caller-owned `AbortSignal`, and every guard decision is enforced in the operation that makes it via the real `tools/pre-execute` waterfall — never through listener ordering or a side channel. The three Phase 0 probes pin this: a denying guard stops the tool body, an allowing guard permits execution, a caller abort cancels execution. MCP tools need no special path: `packages/mcp/mcp-client` publishes them as ordinary tool definitions into the same registry, so the guard waterfall covers them uniformly.

## Decision 5: session events are the durable contract

All System 1 state changes append typed events to the session log through `SessionEventMap` declaration merging, with members required-on-read and payloads JSON-serializable (no explicit `undefined`). `Session.append()` validates and snapshots lossless canonical JSON before committing, and the probes assert post-append mutation cannot corrupt the log. The event vocabulary (`system1/admission` through `system1/terminal`) is the audit trail; the success terminal additionally requires `verifiedBy` evidence at the type level, making an unevidenced success unrepresentable.

## Decision 6: MCP findings

The installed MCP client (`packages/mcp/mcp-client`) is a namespace plugin injecting `tools`, with stdio and streamable-HTTP transports and an automatic reconnect policy (enabled by default, 500 ms initial delay doubling to a 30 s ceiling, 10 consecutive attempts per outage). Because MCP tools surface as ordinary tool definitions in the tool registry, System 1's guarded-tool entry point and budget accounting apply to them without a dedicated MCP integration. Reconnect behavior stays with the MCP client; System 1 only observes the tool calls that result.

## Consequences

These decisions keep System 1 additive: removing the plugin leaves the standard path byte-identical, and the kill switch makes the plugin inert without uninstalling it. The cost is indirection — coordinators are registered roots rather than factory products, so anything that assumes "every agent comes from the factory" must learn about custom roots. The session log carries the full System 1 audit trail, which grows it; context selection owns pruning.
