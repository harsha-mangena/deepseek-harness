---
description: "Phase 0 运行时集成决策：自定义注册 Agent 共存、生命周期归属、发起者传播、受保护工具、会话事件不变量、MCP 发现。"
---

# System 1 运行时集成 ADR

[English](adr-runtime-integration.md) | 中文

## 背景

System 1 必须在 DeepSeek Harness 内部运行，且不扰动标准 DeepSeek 路径。Harness 拥有一个带单个工厂槽位（`setFactory`）的 `AgentRegistry`、Cordis 插件生命周期、受保护的工具运行时，以及仅追加的会话事件日志。本记录捕获使 System 1 成为守规客人的集成决策。

## 决策 1：作为自定义注册运行时根共存

System 1 通过 `AgentRegistry.register()` 注册已构造好的 `System1CoordinatorAgent` 实例，永不调用 `setFactory()`。标准 DeepSeek 路径保留其唯一工厂；System 1 协调器作为自定义运行时根与其并存，id 等于其会话 id，因此注册表的冲突检查使两条路径永不共享 agent。插件的 `create()` 仅在 `agent/created` 送达后才交出句柄；否决或冲突在此处拒绝，并回滚已创建的一切，不留残留。

## 决策 2：插件端到端拥有协调器生命周期

每个协调器句柄拥有严格的拆卸顺序：取消并排空驱动，按注册逆序拆解协调器自有的 Cordis 效应，然后从注册表注销 agent。会话分离归会话存储所有；句柄永不关闭非其打开的会话。插件运行于 kill switch 之下：`mode` 为 `off` 时拒绝创建协调器，标准路径不受影响。生命周期事件经由规范的 `agentEvents(ctx, agent)` 接缝在插件上下文上派发，因此在应用根保持可见。

## 决策 3：在驱动工作前后捕获并恢复发起者

协调器在唤醒时捕获环境发起者，并通过 `agents.withInitiator()` 在驱动存续期内恢复它。因此受保护工具与委派工作看到的发起者是 System 1 协调器，而非驱动运行时碰巧的环境值。探针套件固定了该传播行为。

## 决策 4：受保护工具仅经由公共执行器进入

每一次 System 1 工具调用都经由公共 `ToolRuntime.execute(ToolExecutionInput)` 并携带调用方自有的 `AbortSignal`；每个守卫决策都在做出它的操作中经由真实的 `tools/pre-execute` 瀑布执行——永不依赖监听器顺序或旁路。Phase 0 的三个探针固定了这一点：拒绝的守卫阻止工具体执行，允许的守卫放行执行，调用方中止取消执行。MCP 工具无需特殊路径：`packages/mcp/mcp-client` 将它们作为普通工具定义发布到同一注册表，因此守卫瀑布对其统一覆盖。

## 决策 5：会话事件是持久化契约

所有 System 1 状态变更都通过 `SessionEventMap` 声明合并向会话日志追加类型化事件，成员按读取时必需，载荷 JSON 可序列化（无显式 `undefined`）。`Session.append()` 在提交前验证并快照无损规范 JSON，探针断言追加后变异无法污染日志。事件词表（`system1/admission` 至 `system1/terminal`）是审计轨迹；success 终态还在类型层面要求 `verifiedBy` 证据，使无证据的成功不可表示。

## 决策 6：MCP 发现

已安装的 MCP 客户端（`packages/mcp/mcp-client`）是注入 `tools` 的命名空间插件，支持 stdio 与 streamable-HTTP 传输，具备自动重连策略（默认启用，初始 500 ms 翻倍至 30 s 上限，每次中断 10 次连续尝试）。由于 MCP 工具以普通工具定义的形态出现在工具注册表中，System 1 的受保护工具入口与预算记账无需专用 MCP 集成即可覆盖它们。重连行为归 MCP 客户端所有；System 1 仅观察由此产生的工具调用。

## 后果

这些决策使 System 1 保持可加性：移除插件后标准路径字节级一致，kill switch 使插件在不卸载的情况下惰性化。代价是间接层——协调器是注册根而非工厂产物，任何假设“所有 agent 都来自工厂”的代码都必须认识自定义根。会话日志承载完整的 System 1 审计轨迹，因而会增长；上下文选择拥有剪枝权。
