# @deepseek-ai/dsh-system1-observability

Observability for System 1: metrics, evaluation, and regression gates (Jev-only).

## What it provides

- **MetricsCollector**: records metric samples with labels; computes means and counts.
- **EvaluationRunner**: runs scenarios against actual selections; checks calibrated correctness thresholds.
- **RegressionGateChecker**: validates metric means against min/max thresholds for promotion gates.

## Known Limitations and Deferred Work

- Metrics are in-memory only; persistent storage/export is future work.
- No distributed tracing integration yet.
