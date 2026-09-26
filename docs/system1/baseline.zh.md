---
description: "Phase 0 运行时集成基线：Jev provider 存在之前的 System 1 生命周期、受保护工具与危害回归夹具。"
---

# System 1 Phase 0 基线

[English](baseline.md) | 中文

## 摘要

本基线冻结了 DeepSeek Harness 中 System 1 的 Phase 0 集成面：协调器生命周期、受保护工具入口、会话事件词表以及两个危害回归夹具。捕获于 2026-09-24。以下所有测量均来自针对工作区源码的离线探针；未发起任何 Jev 网络调用，也不声称任何在线验证。

## 生命周期探针

`packages/system1/workflow/tests/lifecycle-probe.spec.ts` 中的 11 个契约探针将协调器作为自定义 `AgentRegistry` 运行时根进行演练：`off` 模式下的 kill-switch 拒绝、与唯一 DeepSeek 工厂的共存、id/会话冲突边界、`agent/created` 否决回滚、状态转换与生命周期事件、取消与收件箱清空、发起者传播、应用根生命周期可见性、会话事件快照完整性、拆卸顺序（驱动排空、自有效应、注销）以及非中止驱动失败的受控处理。

2026-09-24 结果：在 Phase 0 沙盒（`/tmp/sys1-sandbox`）中针对工作区源码，11 通过，0 失败。仓库原生执行待依赖安装完成后进行。

## 受保护工具探针

`packages/system1/workflow/tests/guarded-tool-probe.spec.ts` 中的 3 个探针以生产调用方使用的方式精确演练受保护工具入口：真实 `Context`、真实 `ToolRuntime`、真实 `SystemPrompt`、携带调用方自有 `AbortSignal` 的 `ToolRuntime.execute(ToolExecutionInput)`，以及真实的 `tools/pre-execute` 守卫瀑布。探针断言：拒绝的守卫阻止工具体执行、允许的守卫放行执行、调用方中止取消执行。

2026-09-24 结果：在 Phase 0 沙盒中，3 通过，0 失败。本基线范围不含策略引擎；探针固定的是入口，而非任何策略。

## 危害回归夹具

离线 SystemOneHarness 研究中的两个参考控制器危害被记录为可运行的本地契约。`packages/system1/workflow/tests/fixtures/false-guard-blocks.json` 固定了“任意必需守卫返回 false 必须阻止其候选项”的规则；`packages/system1/workflow/tests/fixtures/repeated-finish-unmet-goal.json` 固定了“目标未达成时重复 FINISH 永不成功”的规则。`system1/terminal` 的 success 分支在类型层面要求 `verifiedBy` 证据，因此无证据的成功不可表示。

两个夹具都在 `packages/system1/workflow/tests/regression-fixtures.spec.ts` 中经由真实 `Session` 往返。2026-09-24 结果：在 Phase 0 沙盒中，5 通过，0 失败。

## 本基线的范围限制

本基线测量协调器生命周期、受保护工具入口与两个危害夹具。Jev 调用延迟、决策准确率、校准以及真实模型下的预算消耗不在本基线范围内：尚无 provider 可供测量。基线轨迹即探针自身的会话事件轨迹，记录于沙盒中。

## 如何复现

安装依赖（`pnpm install`），然后用仓库原生运行器执行聚焦套件：`pnpm exec vitest run packages/system1/workflow/tests/lifecycle-probe.spec.ts packages/system1/workflow/tests/guarded-tool-probe.spec.ts packages/system1/workflow/tests/regression-fixtures.spec.ts`。上述沙盒证据使用了相同源码与一次性别名映射；在 Phase 0 认证前必须原生重跑。
