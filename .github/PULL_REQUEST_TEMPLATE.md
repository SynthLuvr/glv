## What

<!-- One or two sentences: what changed? -->

## Why

<!-- The motivation. Link the issue this closes, if there is one. -->

## Screenshots

<!-- Required for anything a user can see — views, styles, client
scripts, generated markup: before/after shots when reworking existing
UI, one shot of the new surface when introducing UI. Drag the images
into this description so they upload as permanent
https://github.com/user-attachments/assets/... URLs; never commit
image files to the tree. Delete this section for refactors, tests,
CI, and tooling changes with no user-visible surface. -->

## Checklist

- [ ] `pnpm build` and `pnpm lint` pass locally
- [ ] New or changed behavior ships with an integration test that would
  fail without the change (`.integration.test.ts` in `src/goose/tests/`
  or `src/claude/tests/`)
- [ ] Assertions go through the running server over
  `http://localhost:<port>` via the integration harness — no function
  mocks
