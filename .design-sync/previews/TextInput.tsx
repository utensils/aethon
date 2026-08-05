import { TextInput } from "aethon";
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

const Field = ({
  label,
  children,
}: {
  label: string;
  children?: React.ReactNode;
}) => (
  <div style={{ display: "grid", gap: 6, maxWidth: 360 }}>
    <span style={{ fontSize: "0.8125rem", fontWeight: 650 }}>{label}</span>
    {children}
  </div>
);

/** Filled value + empty placeholder — the two everyday states. */
export const Filled = () => (
  <Surface>
    <div style={{ display: "grid", gap: 16, padding: 8 }}>
      <Field label="Branch name">
        <TextInput
          component={{
            id: "ti-branch",
            type: "text-input",
            props: {
              value: "fix/scroll-spy-remount",
              placeholder: "feature/…",
            },
          }}
          state={{}}
          onEvent={noop}
        />
      </Field>
      <Field label="Workspace name">
        <TextInput
          component={{
            id: "ti-empty",
            type: "text-input",
            props: { placeholder: "e.g. aethon-nightly" },
          }}
          state={{}}
          onEvent={noop}
        />
      </Field>
    </div>
  </Surface>
);

/** Disabled — locked while an agent turn is in flight. */
export const Disabled = () => (
  <Surface>
    <div style={{ padding: 8 }}>
      <Field label="Base branch (locked)">
        <TextInput
          component={{
            id: "ti-disabled",
            type: "text-input",
            props: { value: "main", disabled: true },
          }}
          state={{}}
          onEvent={noop}
        />
      </Field>
    </div>
  </Surface>
);

/** Value resolved from the shared state object via a `$ref` JSON Pointer —
 *  the core A2UI data-binding idiom. */
export const StateBound = () => (
  <Surface>
    <div style={{ padding: 8 }}>
      <Field label="Session title">
        <TextInput
          component={{
            id: "ti-bound",
            type: "text-input",
            props: {
              value: { $ref: "/draft/title" },
              placeholder: "Untitled session",
            },
          }}
          state={{ draft: { title: "Migrate window-state schema to v2" } }}
          onEvent={noop}
        />
      </Field>
    </div>
  </Surface>
);
