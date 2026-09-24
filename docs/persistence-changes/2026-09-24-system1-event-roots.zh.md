---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-24-system1-event-roots

[English](2026-09-24-system1-event-roots.md) | 中文

## 概述

确认 `dsh-system1-workflow` 包新增的 11 个 System 1 会话事件根（`system1/admission`、`system1/route`、`system1/candidates`、`system1/decision`、`system1/budget-reservation`、`system1/execution-intent`、`system1/execution-settlement`、`system1/verification`、`system1/handoff`、`system1/context-selection`、`system1/terminal`）。success 终态在类型层面要求 `verifiedBy` 证据，使无证据的成功不可表示。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-24-system1-event-roots
baseline: false
changes:
  - root: "event:system1/admission"
    previous: null
    after: "d421fdfbbdb19bc6aad5751c6715a9f2a15dc5d4a4e256b3ba8a995c390815f9"
    decision: same-version
  - root: "event:system1/budget-reservation"
    previous: null
    after: "44ea7df5490e9b89cd53bd4bdd04af895816ecffd75548b0db3937fe7cf67338"
    decision: same-version
  - root: "event:system1/candidates"
    previous: null
    after: "3c8a66163bb8e1131eb66c3669c86d22c552829089c6404c530db56632aaea14"
    decision: same-version
  - root: "event:system1/context-selection"
    previous: null
    after: "6190cd91b9649914c3944f7e361ef17255a13f84f34ad069ee080b2e54d28b99"
    decision: same-version
  - root: "event:system1/decision"
    previous: null
    after: "1c3ed3ec2eca299eda3eb5250c09d2534e3654d9e6860cf8bb6115b7a409a54c"
    decision: same-version
  - root: "event:system1/execution-intent"
    previous: null
    after: "dffffbc13f1766ad939d83aeabd6a11fcf8f77f5999033394a66012fe7f2173e"
    decision: same-version
  - root: "event:system1/execution-settlement"
    previous: null
    after: "be723df9bd03134dbc369651f5ed47fadb776916f41b57b4dd34642c84ea8cb5"
    decision: same-version
  - root: "event:system1/handoff"
    previous: null
    after: "35485b6fc535a6b5cbb1acbe13f38250bc2179209533dc87cf17b0c2b8059d30"
    decision: same-version
  - root: "event:system1/route"
    previous: null
    after: "e77827dc478858ee0b1e2c5af78368a66c748b68b2daf95b1f1c6fe6edc9a4e7"
    decision: same-version
  - root: "event:system1/terminal"
    previous: null
    after: "8f9af3d7969d7982731a13cb4f49115a52b1597e1b72494eed8725cdafb0c26d"
    decision: same-version
  - root: "event:system1/verification"
    previous: null
    after: "0930d5b4a051b1c3ce2757b9a4ae7f447a5f8a8b93e5da055ec9c9bbb0515a85"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新增 11 个会话事件根（`system1/admission` 至 `system1/terminal`），暂无读取方；现有读取方在协调器发出事件之前看不到新事件，旧会话中也不存在。载荷 JSON 可序列化且成员读取时必需，读取方遇到即得全部字段。会话格式版本不变：这是加法式词表扩展，而非 schema 迁移。

<a id="verification"></a>
## 验证

`gen-persistence-catalog` 已从当前树重新生成目录、schema JSON 与 known-event-types；`--check` 报告所有产物为最新。本确认就位后 `persistence-changes --check` 通过。包测试断言追加后变异无法污染日志，且 success 终态类型要求 `verifiedBy`。

<a id="dev-note"></a>
## 开发备注

无。
