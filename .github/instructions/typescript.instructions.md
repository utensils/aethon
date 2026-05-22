---
applyTo: "**/*.ts,**/*.tsx"
---

# TypeScript / React review focus

## Strict-mode contract

`tsconfig.json` enables `strict` + `verbatimModuleSyntax` +
`erasableSyntaxOnly`. Flag any of:

- `any` introduced where a real type exists (use `unknown` + a guard
  if the shape is genuinely unknown).
- Type-only imports written without `import type { ... }`.
- Non-null assertions (`!`) on values that aren't truly invariant —
  prefer narrowing.
- `as` casts that paper over a wrong type instead of fixing it.

## React 19 patterns

- This codebase uses **React 19**. Function components only — no
  classes, no legacy lifecycle hooks.
- Hooks rules: never conditionally call, never call outside component
  bodies, exhaustive-deps respected. The handful of
  `eslint-disable react-hooks/...` lines that exist have per-line
  rationales; flag any new disable without one.
- `useEffect` for genuine side-effects, not data derivation. Derived
  values go in `useMemo` or plain destructuring.
- State writes during render → infinite loop → block PR.

## A2UI rendering rules

- New UI **never** lives as hardcoded JSX in `App.tsx`. It either:
  - extends `src/skills/default-layout/workstation.a2ui.json`, or
  - registers a component on a `SkillRegistry` (then is referenced by
    `type` from JSON).
- Components that read state must use `$ref` JSON Pointers
  (`{"value": {"$ref": "/draft"}}`) — not direct `state.draft`.
- The 19 primitives (`text`, `heading`, `button`, `text-input`, …) in
  `src/components/builtins.tsx` are **not** overridable from skills.

## Event routing

- New event handlers go in `src/eventRoutes/<name>.ts` with a
  happy-path vitest and a registration entry in
  `eventRoutes/index.ts::BUILTIN_ROUTE_TABLE`.
- **Key chrome composites by `type:<componentType>`, not `id:`** — so
  custom layouts with renamed instances stay routable.
- Returning `true` from a handler suppresses the bridge-forward;
  returning `false` forwards to the agent. Make sure the choice is
  intentional.

## Agent bridge (`agent/**`)

- Wire-format is **JSON-lines over stdio**; one JSON object per line,
  no embedded newlines. Any new message type must be added to the
  dispatcher table in `agent/dispatcher.ts` with an explicit case.
- Provider config flows through env vars (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, …) — never read from a config file in the bridge.
- Mutations return `Promise<MutationResult>`; new APIs that mutate
  state must honour the mutation-ack handshake.

## Tests

- Vitest. Every `agent/*.ts` module has a colocated `*.test.ts`.
- Tests touching React components render via the helpers in
  `src/test/setup.ts`.
- Mocks for Tauri `invoke` live in `src/persist.ts` (the file already
  no-ops outside Tauri); reuse that pattern instead of adding new
  mock infrastructure.
