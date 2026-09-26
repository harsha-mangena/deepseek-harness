# System 1 profile (`dsh --profile system1`)

This package ships the **supported** `dsh` profile for the System 1
production composition, and proves it boots through the real Loader.

## Layout

- `profiles/system1/package.json` — the profile manifest read by `dsh`.
  It declares no bundles (`dsh.profile.bundles: []`), so profile load never
  needs bundle resolution; the whole composition comes from the patch layer.
- `profiles/system1/cordis.patch.yml` — the only composition patch. It
  inserts a single Loader entry, `system1-workflow`
  (`@deepseek-ai/dsh-system1-workflow`) with `{ mode: 'enforce', provider: 'jev' }`.
  This is the one supported System 1 production composition; the header in
  the patch file names the routes that stay disabled (mutation,
  multi-process, distributed, browser, Laya/local) until independently
  certified.
- `tests/profile-composition.spec.ts` — the real Loader composition test
  (below).

## Running the supported profile

```sh
dsh --profile system1
```

Profile discovery reads `$DSH_HOME/profiles/system1/` (created by
`dsh profile add system1 --source <path>`), applies the patch layer over an
empty Loader entry tree, and boots the composed entries. The enforced System 1
coordinator sits in front of the ordinary DeepSeek creation path: when the
coordinator cannot verify an outcome it escalates through
`handoffToDeepSeek` into a real standard DeepSeek child, not a stub handler.

## The composition test

`tests/profile-composition.spec.ts` exercises the shipped profile files as
they are on disk — it does not inline a copy of the patch:

1. **Profile load.** The test copies `profiles/system1/` into a temporary
   `$DSH_HOME`, then calls the real `loadProfile('dsh', 'system1',
   <repo root>/package.json, tmpHome)` and the real
   `composeEntries([profile.patches])` from `@deepseek-ai/dsh-app-boot`.
   It asserts the composed tree contains exactly the supported entry:
   id `system1-workflow`, name
   `@deepseek-ai/dsh-system1-workflow`, and config `{ mode: 'enforce',
   provider: 'jev' }`.
2. **Real Loader boot.** The composed entries boot through the real Loader
   with the real `Include` plugin. The only fixture is the module-location
   shim used by the sibling composition test: the entry's package name is
   replaced with a temporary `.mjs` file URL so Node resolves the
   *workspace source* of the workflow plugin (stale `lib/` builds and the
   package name are never trusted), while the entry's id, config, and patch
   order stay exactly as composed.
3. **Verified turn.** With the workflow plugin's coordinator driven by the
   real read-only driver, a tool turn completes and the test asserts the
   durable `system1/terminal` record: outcome `success` with nonempty
   `verifiedBy` evidence.
4. **Fallback turn.** A low-confidence decision forces escalation. The
   driver's handoff calls the real `handoffToDeepSeek`, which creates a
   **real standard DeepSeek child** via the coordinator's own registered
   AgentLoop factory (`coordinator.ctx.agents.create`), runs the real child
   loop, reserves and settles a real budget from a real `CoordinationStore`
   ledger, and disposes the child. The test asserts the fallback-labeled
   terminal (`escalated`, summary starting with
   `DeepSeek fallback completed;`, empty `verifiedBy`) — it is *not* labeled
   a System 1-verified success.

Run it with:

```sh
env -u NODE_USE_ENV_PROXY ./node_modules/.bin/vitest run packages/system1/profile/
```

Typecheck with:

```sh
./node_modules/.bin/tsc --noEmit -p packages/system1/profile/tsconfig.json
```

## Model experience

A model driving this profile should know:

- There is exactly one supported composition. Do not invent other profiles
  or entries; `system1-workflow` with Jev in enforce mode is the whole
  supported surface.
- The Jev provider is the only model boundary; mutation, multi-process,
  distributed, browser, and Laya/local routes are disabled.
- Escalation is a first-class path: low confidence or decision failures
  hand off to a standard DeepSeek child with a reserved budget, and the
  terminal record says so (`escalated`, no verification claims).

## Known limitations

- **Keyless fixture evidence only.** The test stubs the Jev network/model
  generation boundary with deterministic in-process adapter output and
  host-recorded token telemetry. This proves the composition is wired and
  behaves correctly, not that it works against live Jev. Live Jev validation
  with an API key remains a separate, ungated step.
- **Not production certification.** Nothing here certifies deployment,
  calibration, or load/chaos behavior. The profile is the supported
  composition; "supported" means "this is the composition we stand behind",
  not "this is certified for production traffic".
- **No browser or Laya paths.** Those stay disabled until independently
  certified, per the user's standing scope.
