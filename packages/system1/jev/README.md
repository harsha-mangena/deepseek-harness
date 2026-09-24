# @deepseek-ai/dsh-system1-jev

Jev decision provider for System 1: TypeSafe API adapter (Jev-only).

## What it provides

- **JevDecisionProvider**: calls `POST https://api.typesafe.ai/v1/systemone` with the shared state, pinned model, and keyed choice questions. Authenticates via `Authorization: Bearer <API_KEY>` (key supplied by caller from Secure Vault; never logged).
- **Response normalization**: maps choice, score, and noul responses to `NormalizedDecision`. The selected candidate ID must be valid; raw probabilities, vendor confidence, and calibrated correctness remain distinct. Noul maps to `escalate-none` with `reasonCode: 'uncertain'`.
- **Retry policy**: one transport retry (per plan §8); no retries for cancellations or malformed responses. Timeouts, rate limits (429), and auth failures (401/403) map to structured `System1Error` codes.
- **Usage accounting**: parses input/output tokens (null-safe) for the cost ledger.

## Known Limitations and Deferred Work

- All transport tests use mocked fetch; no live API calls are made in tests.
- Calibration fields (`calibratedCorrectness`, `calibrationVersion`) are null until Phase 4.
- Model pinning is enforced at construction; mutable alias detection is a deployment concern.
