import { Button } from "aethon";
import type * as React from "react";

/** Preview-only themed surface: the app shell styles `body` with
 *  --bg/--text/--font-ui (chrome base.css), and real designs inherit that
 *  via the styles.css closure — the DS preview harness overrides body to
 *  white, so cards re-create the shell surface locally. */
const Surface = ({ children }: { children?: React.ReactNode }) => (
  <div
    style={{
      background: "var(--bg)",
      color: "var(--text)",
      fontFamily: "var(--font-ui)",
      padding: 16,
      borderRadius: 8,
    }}
  >
    {children}
  </div>
);

const noop = () => {};

export const Variants = () => (
  <Surface>
  <div style={{ display: "flex", gap: 12, alignItems: "center", padding: 8 }}>
    <Button
      component={{
        id: "b-primary",
        type: "button",
        props: { label: "Deploy agent", variant: "primary" },
      }}
      state={{}}
      onEvent={noop}
    />
    <Button
      component={{
        id: "b-secondary",
        type: "button",
        props: { label: "View logs", variant: "secondary" },
      }}
      state={{}}
      onEvent={noop}
    />
    <Button
      component={{
        id: "b-ghost",
        type: "button",
        props: { label: "Dismiss", variant: "ghost" },
      }}
      state={{}}
      onEvent={noop}
    />
  </div>
  </Surface>
);

export const Disabled = () => (
  <Surface>
  <div style={{ display: "flex", gap: 12, alignItems: "center", padding: 8 }}>
    <Button
      component={{
        id: "b-disabled-primary",
        type: "button",
        props: { label: "Deploy agent", variant: "primary", disabled: true },
      }}
      state={{}}
      onEvent={noop}
    />
    <Button
      component={{
        id: "b-disabled-secondary",
        type: "button",
        props: { label: "View logs", variant: "secondary", disabled: true },
      }}
      state={{}}
      onEvent={noop}
    />
  </div>
  </Surface>
);

/** Labels resolve from the shared state object via `$ref` JSON Pointers —
 *  the core A2UI data-binding idiom. */
export const StateBound = () => (
  <Surface>
  <div style={{ display: "flex", gap: 12, alignItems: "center", padding: 8 }}>
    <Button
      component={{
        id: "b-bound",
        type: "button",
        props: { label: { $ref: "/cta/label" }, variant: "primary" },
      }}
      state={{ cta: { label: "Continue to workspace" } }}
      onEvent={noop}
    />
  </div>
  </Surface>
);
