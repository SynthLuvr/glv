# Proposal: per-job model selection for scheduled runs

Status: proposed (2026-09-03) Author: goose agent session Scope:
`src/glv/` (shared) + goose-only UI surface

## Problem

The New Session form has a per-run model picker (goose flavor), but a
scheduled run always fires with the agent’s default model. `POST /cron`
actively rejects a non-default picker selection (“Scheduled runs always
use goose’s default model”), and the `cronJobs` config schema has no way
to express a model. A nightly sweep that should run on a cheap model
while interactive sessions use an expensive one cannot be expressed.

## Goals

1.  A scheduled job can pin a specific model (provider + model pair);
    every fire starts its session with that model.
2.  The web UI’s schedule form gets its own model picker — same
    catalogue, same lazy-loading behaviour as the New Session picker —
    plus display on the card, the confirmation, and the edit form.
3.  The config file stays the source of truth: two new optional keys on
    each `cronJobs` entry, hand-editable, validated at boot and on live
    reload.
4.  Flavors whose agent cannot take a model (claude) are unaffected: no
    picker, and a model-pinned job fails validation with the job named
    rather than silently running on the default.

## Non-goals

- Re-resolving the model against the agent’s config at fire time. The
  value is resolved and validated at save time (identical to
  `POST /sessions`); if the provider disappears later, the agent itself
  errors the run, exactly like an interactive session would.
- Changing follow-up/resume behaviour: a pinned model applies to the
  sessions a job starts, not to resumes of those sessions.

## Design

### Config schema (`src/glv/config.ts`)

Two optional keys, both-or-neither:

``` json
{
  "name": "nightly-review",
  "schedule": "0 3 * * *",
  "prompt": "Summarize today's commits and flag risks",
  "workingDir": "/home/you/project",
  "modelProvider": "zai",
  "model": "glm-5.3"
}
```

Why two plain keys instead of the picker’s `provider:model` form value:
the file should be self-describing and match `ModelSelection`
(`{ provider, model }`) — the packed spelling is a UI convention, not a
storage format. Validation (below) enforces both-or-neither and
non-empty strings (`string>0`).

### Scheduler (`src/glv/cron.ts`)

- `ResolvedJob` carries `modelProvider`/`model` through; `runFire`
  composes them into a `ModelSelection` and passes it to
  `launcher.startNew(workingDir, prompt, model)` — the parameter the
  launchers already accept for the HTTP create flow. The scheduler stays
  flavor-agnostic: no `ModelSource` dependency, no fire-time resolution.
- `validateJob` gains two checks, so a bad hand edit fails serve startup
  (and rejects a live reload) with the job named, matching the existing
  philosophy for bad schedules/timezones/dirs:
  1.  `modelProvider` and `model` must be set together.
  2.  A pinned model requires a flavor that supports model selection
      (new `SchedulerDeps.supportsModels`, wired from
      `opts.models !== undefined` in serve — a capability check, not a
      config-state check, so it cannot go stale).
- Boot-time and fire logs keep their shape; nothing else changes.

### Routes (`src/glv/server/routes/cron.tsx`)

- `POST /cron`: the “always uses the default model” rejection is
  replaced by the sessions flow’s resolution — `ctx.models?.resolve()`
  against a fresh config read; unresolvable → 422 with the same “no
  longer available” copy. Resolved pairs persist as
  `modelProvider`/`model`; the default (empty value) persists neither
  key.
- `PUT /cron/:name`: same resolution for the edit form’s select. When
  the flavor exposes the picker, the submitted value overwrites (empty
  clears) the stored pair; when it does not, any existing pair survives
  the edit — the established “unexposed fields survive” rule (timezone,
  enabled).
- `GET /cron/new` and `GET /cron/:name/edit` render the picker slot only
  when the flavor supports models (`hasModelPicker`, exported from
  render.tsx).

### UI (`src/glv/views/schedule.tsx`, `views/new-session.tsx`)

- The save form and edit form embed the same lazy `ModelPickerSlot` the
  New Session form uses (`/sessions/model-picker` fragment): resolving
  the catalogue can spawn the agent binary, so the inline form must
  render instantly and swap the select in after. A rejected submit’s
  selection survives the re-render via the fragment’s `submitted` query
  param.
- The save form stops including the New Session form’s
  `select[name=model_provider]` (it was only included to reject it) and
  includes its own.
- Card + confirmation show `provider / model` when pinned; nothing
  renders for the default, keeping cards unchanged for existing jobs.
- The mode note under the form says “pick a model, or leave it at
  {agent}’s default” when the picker is present.

### Shared encoding (`src/glv/models.ts`)

The `provider:model` encode/decode currently local to
`src/goose/models.ts` moves to the shared `glv/models.ts`
(`encodeModelValue`/`decodeModelValue`) so the cron edit form can
rebuild the picker’s submitted value from a stored job
(`jobModelValue`). Shared logic belongs in `src/glv/` per the
one-location rule.

## Testing

- Shared `cron-ui.suite.ts` (runs for goose and claude): the “rejects a
  non-default model” test becomes “rejects a model the agent cannot
  resolve” (422, “no longer available”) — both fixtures reject any
  submitted model because neither has providers configured.
- Shared `cron.suite.ts`: serve refuses to start for a job with only one
  of the two model keys, naming the job.
- New goose-only `src/goose/tests/cron-model.integration.test.ts` (real
  server + mock goose + browser):
  - create a job with a model from the form’s own picker in a browser;
    config file gains `modelProvider`/`model`; confirmation and card
    show the model;
  - an every-second job fires sessions whose argv carries
    `--provider zai --model glm-5.3` (captured by the mock), and
    clearing the model via PUT makes later fires drop the flags;
  - unknown provider/model → 422; edit form preselects the stored model;
    a job stored without a model fires without model flags;
  - hand-written config with a model pair fires with the flags (config
    is the source of truth, not the form).

## Documentation

README “Scheduled runs (cron)” gains the two keys, the picker, and the
claude caveat.
