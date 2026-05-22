---
applyTo: "**/*.test.ts,**/*.test.tsx,**/tests.rs"
---

# Test review focus

## Test layout

- TS / TSX tests live colocated with the module under test
  (`agent/foo.ts` ↔ `agent/foo.test.ts`).
- Rust tests live in `#[cfg(test)] mod tests` blocks inside the
  module they cover (mostly `src-tauri/src/helpers.rs`).
- New code that touches an existing module should add cases to the
  existing test file rather than creating a parallel `foo.spec.ts`
  alongside `foo.test.ts`.

## Vitest expectations

- Tests are run via `bunx vitest run` (no watch mode in CI).
- `src/test/setup.ts` provides the rendering helpers; reuse it.
- Mock Tauri `invoke` through the existing `src/persist.ts` no-op
  fallback — don't add a new mock layer.
- Single-file run: `bunx vitest run path/to/file.test.ts`.
- Single-name run: `bunx vitest run -t "test name pattern"`.

## Coverage signal, not goal

Coverage runs under `bunx vitest run --coverage` (v8 backend).
We don't enforce a percentage gate — review by **whether
behavioural branches are tested**, not by hitting an arbitrary
percentage. A high coverage number that only exercises the happy
path is worse than a smaller number with edge cases.

## Patterns to flag

- Tests that only assert the function "doesn't throw" without
  asserting an output.
- Tests that re-implement the function under test as the expected
  value — they pass on bugs.
- Snapshot tests for anything not actually a stable rendered
  representation. Prefer explicit `expect` assertions.
- `it.skip` / `describe.skip` without a comment explaining when
  the skip should be removed.
- Mocks that fake the very thing the test is supposed to verify
  (e.g. mocking the IPC bridge in a test that's claiming to test
  IPC behaviour).

## Determinism

Tests must not depend on:

- Wall-clock time without explicit fake timers (`vi.useFakeTimers`).
- Network or external services.
- The current working directory beyond `process.cwd()` set in
  `vitest.config.ts`.
- A specific test ordering — every test must pass in isolation.

## Rust tests

- Pure helpers go under `helpers.rs` with their own `#[cfg(test)] mod tests`.
- Tauri-command-shaped functions that orchestrate state need
  integration coverage via the JS-side `aethon-debug` skill, not
  Rust unit tests — flag PRs that mock half the Tauri runtime to
  unit-test a command.
