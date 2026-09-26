# @deepseek-ai/dsh-system1-jev

Jev decision provider for System 1: TypeSafe API adapter (Jev-only).

## What it provides

- **JevDecisionProvider**: calls `POST https://api.typesafe.ai/v1/systemone` with the shared state, pinned model, and a single choice question keyed by the input question family. The question uses the documented wire format (`instructions` + `criteria` mapping candidate IDs to labels). Authenticates via `Authorization: Bearer <API_KEY>` (key supplied by caller from Secure Vault; never logged). The constructor requires a pinned `jev-x.y.z` model ID and rejects mutable aliases such as `jev-latest`.
- **Response normalization**: reads the per-question answer from `answers.<questionId>` and validates it strictly: the answer type must match the requested `choice` question (a Noul answer to a Choice request is rejected as a type mismatch), the probability map must contain exactly the candidate IDs (unknown or missing keys are rejected), every value must be a finite number in [0,1], the values must sum to 1 within tolerance, and a present `confidence` must be a finite number in [0,1]. The selected candidate ID must be valid; raw probabilities, vendor confidence, and calibrated correctness remain distinct.
- **Retry policy**: one transport retry (per plan §8) for transient failures only — HTTP 429, 5xx, and network/timeout errors. Permanent failures are never retried: invalid credentials (401/403) make exactly one HTTP attempt, as do other 4xx rejections, malformed responses, and cancellations. Timeouts, rate limits, and auth failures map to structured `System1Error` codes.
- **Usage accounting**: parses input/output tokens (null-safe) for the cost ledger.

## Live smoke test

`src/live-smoke.ts` makes one real `Choice` call to the live TypeSafe API
through the production `JevDecisionProvider.decide()` path (transport,
strict normalization, model pinning), then prints the model
requested/resolved, selected ID, calibrated fields, and usage. It never logs
the API key.

```sh
# export TYPESAFE_API_KEY in the environment, then run:
pnpm --filter @deepseek-ai/dsh-system1-jev system1:live-smoke
```

`TYPESAFE_JEV_MODEL` optionally overrides the pinned model (default
`jev-1.13.0`). Without `TYPESAFE_API_KEY` the script exits 2 with
`skipped: no credentials` — a skip, not a failure. It never runs as part of
the default test suite; `tests/live-smoke.spec.ts` covers only the key-gated
skip behavior (no network calls).

## Known Limitations and Deferred Work

- All transport tests use mocked fetch; no live API calls are made in tests.
- Calibration fields (`calibratedCorrectness`, `calibrationVersion`) are null until Phase 4.
- Model pinning is enforced at construction: only explicit `jev-x.y.z` versions are accepted; mutable aliases are rejected.
