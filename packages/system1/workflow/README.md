---
description: "System 1 coordinator: custom AgentRegistry runtime root with a kill-switched Cordis plugin (Jev-only), for users and maintainers choosing or debugging the System 1 integration."
kind: "package-reference"
---

# @deepseek-ai/dsh-system1-workflow

English | [中文](README.zh.md)

## Summary

This package hosts the System 1 coordinator inside DeepSeek Harness. It registers already-constructed coordinator agents as custom `AgentRegistry` runtime roots and never replaces the standard DeepSeek agent factory, so the two paths share one registry and one session event log. The plugin runs under a kill switch (`off` by default): while off, coordinator creation is refused and the standard path is untouched. All System 1 state changes append typed `system1/*` session events, and every tool call the coordinator makes enters through the public guarded `ToolRuntime.execute` entry point.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in `cordis.yml` to enable coordinator creation. The defaults below define the operating posture; the generated configuration catalog is the exhaustive source for every field.

```yaml
- name: '@deepseek-ai/dsh-system1-workflow'
  config:
    mode: 'off'
    provider: 'jev'
```

| Field | Default | Meaning |
|---|---|---|
| `mode` | `'off'` | Operating posture: `off` refuses coordinator creation, `shadow` evaluates without acting, `enforce` acts on decisions |
| `provider` | `'jev'` | Decision provider; only `jev` (TypeSafe hosted API) is supported |
| `model` | — | Jev model name; omitted lets Jev resolve its pinned default at call time |

### Creating a coordinator

Call `ctx.system1Workflows.create(session, driver)` with a session and a driver. The coordinator id equals the session id, so the registry's collision checks keep one coordinator per session. The returned handle is handed out only after `agent/created` has been delivered; a veto or collision rejects there and unwinds everything created so far. Full teardown (`handle.dispose()`) cancels and drains the driver, unwinds the coordinator's owned Cordis effects in reverse order, then unregisters the agent.

### What can go wrong

Creating while `mode` is `off` throws. Creating for a session that already has a coordinator throws a collision error. A driver that rejects on abort is contained; a driver that rejects for any other reason is recorded on the coordinator and does not take down the plugin.

## Understand the implementation

### Design decisions

The coordinator is a custom runtime root, not a factory product: `AgentRegistry` has one factory slot and System 1 never takes it. Registrations are effects — the coordinator registers through the plugin Cordis context and the plugin owns every disposer's unwind. Lifecycle events dispatch through the sanctioned `agentEvents(ctx, agent)` seam on the plugin context, so they stay visible at the application root. The initiator is captured when the coordinator wakes and restored for the driver's lifetime, so guarded tools and delegated work see the coordinator as the initiator. Session event payloads are JSON-serializable with no explicit `undefined`, and `system1/terminal` success requires `verifiedBy` evidence at the type level.

### Source map

- `src/types.ts` — public config and coordinator contracts (types only).
- `src/events.ts` — the `system1/*` session event vocabulary and `SessionEventMap` augmentation.
- `src/inbox.ts` — the coordinator's real `Inbox` implementation.
- `src/coordinator-agent.ts` — `System1CoordinatorAgent`, the custom runtime root.
- `src/plugin.ts` — `System1Workflows` service: kill-switched creation, lifecycle ownership, lookup.
- `src/index.ts` — public surface.

## Further Exploration

- [System 1 runtime integration ADR](../../../docs/system1/adr-runtime-integration.md) — the integration decisions: coexistence, lifecycle ownership, initiator propagation, guarded tools, session event invariants, MCP findings.
- [System 1 Phase 0 baseline](../../../docs/system1/baseline.md) — the frozen Phase 0 evidence: lifecycle probes, guarded-tool probes, hazard fixtures.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-system1-workflow) — every accepted config field and its source declaration.
- [Generated persistence catalog](../../../docs/persistence-catalog.md) — the persisted `system1/*` session event types.

-----

<a id="model-experience"></a>
## Model Experience

### Coordinator lifecycle (no model-visible contribution)

#### What the model sees

Nothing. The coordinator's session events (`system1/admission` through `system1/terminal`) are log-only audit records, excluded from derived message history like other lifecycle boundaries. No prompt section, tool schema, or message content comes from this package.

#### Token effect

No tokens are added to model requests.

#### KV Cache effect

No request bytes change, so cached prefixes are unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what this package can and cannot do; they are current package constraints.

- **No decision provider** — the coordinator exposes a driver slot; with nothing behind it deciding, `shadow` and `enforce` postures currently have no routing effect.
- **Off by default** — `mode: 'off'` refuses coordinator creation; the plugin is inert until configured otherwise.
- **Jev only** — the provider union admits `jev` alone; browser and local backends are out of scope by design.
- **One coordinator per session** — the coordinator id equals the session id and the registry rejects a second registration for the same session.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: undecided directions and open questions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and the package code.

#### Driver slot and provider boundary

The coordinator's driver slot is an explicit contract (run to completion, honor abort). The provider boundary is Jev-only by design: browser and local backends are out of scope. These two decisions keep the Model Experience section above accurate — the coordinator contributes no model-visible content — and keep the no-contribution posture verifiable.
</details>
