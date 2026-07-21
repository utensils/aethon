# Building with Aethon components

## The A2UI envelope — every component's API

Aethon components do NOT take direct props. Each one takes an A2UI
envelope plus shared state and an event callback:

```jsx
const { Button, Card, TextInput } = window.Aethon;
const noop = () => {};

<Button
  component={{ id: "save", type: "button",
    props: { label: "Deploy agent", variant: "primary" } }}
  state={{}}
  onEvent={(eventType, data) => {/* handle "click" */}}
/>
```

- `id` must be unique per tree; `type` is the component's kebab-case A2UI
  type (`"text-input"`, `"date-picker"`, `"form-field"`, `"empty-state"`,
  `"status"` for StatusBar, else the lowercase name). Each component's
  `.d.ts` spells out its exact `props` payload — read it before use.
- Any prop typed `string|{$ref}` may be a JSON Pointer into `state`:
  `props: { label: { $ref: "/cta/label" } }` + `state={{ cta: { label: "Continue" } }}`.
- Card, Container, Form, FormField compose nested content ONLY via
  `renderChildren={() => <>...</>}` — a JSX `children` prop is ignored.
  Layout instead calls `renderChild(childNode)` per A2UI child.
- Exceptions taking plain props: `Chevron {expanded, size}`,
  `AeMarkInline {size, radius}`, `AeWordmark {height}`.

## Surface + theme setup

The stylesheet closure styles `body` with the active theme
(`background: var(--bg); color: var(--text); font-family: var(--font-ui)`)
— dark by default. Themes switch via an attribute on the root element:
`<html data-theme="ember">`. Available: `ember`, `paper`, `daylight`,
`mist`, `nocturne`, `aether`, `brink`, `signature` (omit for the default
dark theme). No provider component exists or is needed.

## Styling idiom: CSS custom properties, never invented classes

Style your own layout glue with inline styles or new classes that consume
the tokens — do not invent `ae-*`/`a2ui-*` class names (those belong to
shipped chrome). Core vocabulary (all in `styles.css` →
`_ds_bundle.css`):

- Surfaces: `--bg`, `--bg-elev`, `--bg-input`, `--bg-hover`,
  `--bg-active`, `--bg-selected`, `--card-bg`, `--card-border`
- Text: `--text`, `--text-secondary`, `--text-dim`, `--btn-text`
- Accent + state: `--accent`, `--accent-soft`, `--accent-hover-tint`,
  `--error`, `--success`, `--focus-ring`
- Borders: `--border`, `--border-strong`, `--border-hover`
- Type: `--font-ui` (Geist), `--font-mono` (Geist Mono); scale
  `--text-2xs`…`--text-xl`; semantic roles `--type-body-*`,
  `--type-title-*`, `--type-caption-*` (prefer roles over raw scale)

Fonts (Geist, Geist Sans/Mono, Inter, JetBrains Mono, Playfair Display)
ship in `fonts/` — never link external font hosts.

## Where the truth lives

- `styles.css` → `_ds_bundle.css`: full token + theme + chrome CSS.
- `components/<group>/<Name>/<Name>.d.ts`: the exact props contract.
- `components/<group>/<Name>/<Name>.prompt.md`: usage + examples.
- `guidelines/DESIGN.md` and `guidelines/docs/aethon-agent/components.md`:
  the A2UI component model and design language.

## Idiomatic example

```jsx
const { Card, Button } = window.Aethon;
<div style={{ background: "var(--bg)", color: "var(--text)",
              fontFamily: "var(--font-ui)", padding: 16 }}>
  <Card
    component={{ id: "run", type: "card",
      props: { title: "claude-opus-4-8", description: "migrate window-state schema — running, 12m 03s" } }}
    state={{}} onEvent={() => {}}
    renderChildren={() => (
      <div style={{ display: "flex", gap: 12 }}>
        <Button component={{ id: "view", type: "button",
          props: { label: "View", variant: "secondary" } }} state={{}} onEvent={() => {}} />
        <Button component={{ id: "stop", type: "button",
          props: { label: "Stop", variant: "ghost" } }} state={{}} onEvent={() => {}} />
      </div>
    )}
  />
</div>
```
