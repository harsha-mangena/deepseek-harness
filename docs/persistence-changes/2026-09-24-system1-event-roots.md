---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-24-system1-event-roots

English | [中文](2026-09-24-system1-event-roots.zh.md)

## Summary

Acknowledges the eleven new System 1 session event roots added by the `dsh-system1-workflow` package (`system1/admission`, `system1/route`, `system1/candidates`, `system1/decision`, `system1/budget-reservation`, `system1/execution-intent`, `system1/execution-settlement`, `system1/verification`, `system1/handoff`, `system1/context-selection`, `system1/terminal`). The success terminal requires `verifiedBy` evidence at the type level, making an unevidenced success unrepresentable.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Adds eleven new session event roots (`system1/admission` through `system1/terminal`) with no reader yet; existing readers see no new events until a coordinator emits them, and old sessions contain none. Payloads are JSON-serializable with required-on-read members, so a reader that encounters one always finds every field. The session format version is unchanged: this is an additive vocabulary extension, not a schema migration.

<a id="verification"></a>
## Verification

`gen-persistence-catalog` regenerated the catalog, schema JSON, and known-event-types from the current tree; `--check` reports all artifacts up to date. `persistence-changes --check` passes with this acknowledgement in place. Package tests assert post-append mutation cannot corrupt the log and that the success terminal type requires `verifiedBy`.

<a id="dev-note"></a>
## Dev Note

None.
