---
description: "System 1 协调器：带 kill-switch 的 Cordis 插件中的自定义 AgentRegistry 运行时根（仅 Jev），面向选择或调试 System 1 集成的用户与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-system1-workflow

[English](README.md) | 中文

## 摘要

本包在 DeepSeek Harness 内部承载 System 1 协调器。它将已构造好的协调器 agent 作为自定义 `AgentRegistry` 运行时根注册，永不替换标准 DeepSeek agent 工厂，因此两条路径共享一个注册表和一个会话事件日志。插件运行于 kill switch 之下（默认 `off`）：关闭时拒绝创建协调器，标准路径不受影响。所有 System 1 状态变更都追加类型化的 `system1/*` 会话事件，协调器发起的每一次工具调用都经由公共的受保护 `ToolRuntime.execute` 入口。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发注记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 `cordis.yml` 中挂载本插件以启用协调器创建。以下默认值定义运行姿态；生成的配置目录是每个字段的权威来源。

```yaml
- name: '@deepseek-ai/dsh-system1-workflow'
  config:
    mode: 'off'
    provider: 'jev'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | `'off'` | 运行姿态：`off` 拒绝创建协调器，`shadow` 评估但不行动，`enforce` 按决策行动 |
| `provider` | `'jev'` | 决策 provider；仅支持 `jev`（TypeSafe 托管 API） |
| `model` | — | Jev 模型名；省略则由 Jev 在调用时解析其固定默认 |

### 创建协调器

使用会话与驱动调用 `ctx.system1Workflows.create(session, driver)`。协调器 id 等于会话 id，因此注册表的冲突检查保证每个会话一个协调器。返回的句柄仅在 `agent/created` 送达后交出；否决或冲突在此处拒绝，并回滚已创建的一切。完整拆卸（`handle.dispose()`）取消并排空驱动，按注册逆序拆解协调器自有的 Cordis 效应，然后从注册表注销 agent。

### 可能出错的地方

`mode` 为 `off` 时创建会抛错。为已有协调器的会话创建会抛冲突错误。驱动在中止时拒绝会被受控处理；驱动因其他原因拒绝会被记录在协调器上，不会拖垮插件。

## 理解实现

### 设计决策

协调器是自定义运行时根，而非工厂产物：`AgentRegistry` 只有一个工厂槽位，System 1 永不占用。注册即效应——协调器经由插件 Cordis 上下文注册，插件拥有每个释放器的拆解。生命周期事件经由规范的 `agentEvents(ctx, agent)` 接缝在插件上下文上派发，因此在应用根保持可见。发起者在协调器唤醒时捕获，并在驱动存续期内恢复，因此受保护工具与委派工作看到的发起者是协调器。会话事件载荷 JSON 可序列化且无显式 `undefined`，`system1/terminal` 的 success 在类型层面要求 `verifiedBy` 证据。

### 源码地图

- `src/types.ts` — 公共配置与协调器契约（仅类型）。
- `src/events.ts` — `system1/*` 会话事件词表与 `SessionEventMap` 增强。
- `src/inbox.ts` — 协调器的真实 `Inbox` 实现。
- `src/coordinator-agent.ts` — `System1CoordinatorAgent`，自定义运行时根。
- `src/plugin.ts` — `System1Workflows` 服务：kill-switch 创建、生命周期归属、查找。
- `src/index.ts` — 公共面。

## 深入探索

- [System 1 运行时集成 ADR](../../../docs/system1/adr-runtime-integration.zh.md) — 集成决策：共存、生命周期归属、发起者传播、受保护工具、会话事件不变量、MCP 发现。
- [System 1 Phase 0 基线](../../../docs/system1/baseline.zh.md) — 冻结的 Phase 0 证据：生命周期探针、受保护工具探针、危害夹具。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-system1-workflow) — 每个可接受配置字段及其源码声明。
- [生成的持久化目录](../../../docs/persistence-catalog.zh.md) — 持久化的 `system1/*` 会话事件类型。

-----

<a id="model-experience"></a>
## 模型体验

### 协调器生命周期（无模型可见贡献）

#### 模型看到什么

无。协调器的会话事件（`system1/admission` 至 `system1/terminal`）是仅日志的审计记录，如同其他生命周期边界一样被排除在派生消息历史之外。本包不产生任何提示词章节、工具 schema 或消息内容。

#### Token 效应

模型请求不增加任何 token。

#### KV 缓存效应

请求字节不变，因此缓存前缀不受影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制描述本包能做什么、不能做什么；它们是当前包约束。

- **尚无决策 provider** — 协调器暴露驱动槽位；在没有决策实现的当前状态下，`shadow` 与 `enforce` 姿态没有路由效果。
- **默认关闭** — `mode: 'off'` 拒绝创建协调器；插件在另行配置前处于惰性状态。
- **仅 Jev** — provider 联合类型仅接纳 `jev`；浏览器与本地后端按设计不在范围内。
- **每会话一个协调器** — 协调器 id 等于会话 id，注册表拒绝同一会话的第二次注册。

<a id="dev-note"></a>
### 开发注记

<details>
<summary>面向维护者的工作上下文 — 点击展开</summary>

本开发注记是面向维护者的工作上下文：未定的方向与开放问题。它明确非权威——已交付行为与限制见上文各节与包代码。

#### 驱动槽位与 provider 边界

协调器的驱动槽位是显式契约（运行至完成、遵守 abort）。provider 边界按设计仅限 Jev：浏览器与本地后端不在范围内。这两个决策使上文的模型体验章节保持准确——协调器不贡献模型可见内容——并使无贡献姿态可验证。
</details>
