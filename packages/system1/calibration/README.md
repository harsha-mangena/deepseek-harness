# @deepseek-ai/dsh-system1-calibration

Calibration and shadow evaluation for System 1 (Jev-only).

## What it provides

- **Isotonic calibration**: correctness-only, monotone non-decreasing mapping from vendor confidence to calibrated correctness probability. Uses Pool Adjacent Violators Algorithm over tied-score-pooled observations, so the fit never depends on the input order of tied samples. The fitted function is stepwise constant; no intercepts, slopes, or vendor internals are exposed. Versioned; no online updates. Each fit carries an optional `CalibrationIdentity` binding it to the model, prompt version, and question family it was approved for.
- **ShadowEvaluator**: runs a DecisionProvider in shadow mode, recording decisions alongside a baseline without affecting production. The whole pipeline is isolated: provider, baseline, and sink failures are reported through `onError` and never propagate to the caller. Provider failures are recorded as failed attempts (comparison `unknown`) so evaluation denominators stay complete; a missing baseline is recorded as `unknown`, never as agreement.

## Known Limitations and Deferred Work

- Calibration is trained offline on labeled (vendor_confidence, correct) pairs; the labeling pipeline is out of scope.
- Shadow records go to an injected sink; persistent storage and analysis dashboards are Phase 9.
- No online calibration updates (per plan §10, to avoid encoding vendor internals).
