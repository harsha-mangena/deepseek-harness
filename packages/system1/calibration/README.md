# @deepseek-ai/dsh-system1-calibration

Calibration and shadow evaluation for System 1 (Jev-only).

## What it provides

- **Isotonic calibration**: correctness-only, monotone non-decreasing mapping from vendor confidence to calibrated correctness probability. Uses Pool Adjacent Violators Algorithm. The fitted function is stepwise constant; no intercepts, slopes, or vendor internals are exposed. Versioned; no online updates.
- **ShadowEvaluator**: runs a DecisionProvider in shadow mode, recording decisions alongside a baseline without affecting production. Disagreements are logged for analysis. Shadow failures are swallowed (not propagated).

## Known Limitations and Deferred Work

- Calibration is trained offline on labeled (vendor_confidence, correct) pairs; the labeling pipeline is out of scope.
- Shadow records go to an injected sink; persistent storage and analysis dashboards are Phase 9.
- No online calibration updates (per plan §10, to avoid encoding vendor internals).
