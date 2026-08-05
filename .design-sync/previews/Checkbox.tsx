import { Checkbox } from "aethon";
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

const Column = ({ children }: { children?: React.ReactNode }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 8 }}>
    {children}
  </div>
);

/** A settings panel column: the toggles a user flips in Settings → Voice /
 *  Updater, mixing checked and unchecked states. */
export const SettingsToggles = () => (
  <Surface>
    <Column>
      <Checkbox
        component={{
          id: "cb-speak",
          type: "checkbox",
          props: { label: "Speak agent replies aloud", value: true },
        }}
        state={{}}
        onEvent={noop}
      />
      <Checkbox
        component={{
          id: "cb-continuous",
          type: "checkbox",
          props: { label: "Continuous conversation mode", value: false },
        }}
        state={{}}
        onEvent={noop}
      />
      <Checkbox
        component={{
          id: "cb-nightly",
          type: "checkbox",
          props: { label: "Auto-update on the nightly channel", value: false },
        }}
        state={{}}
        onEvent={noop}
      />
      <Checkbox
        component={{
          id: "cb-devshell",
          type: "checkbox",
          props: { label: "Wrap shells in the Nix devshell", value: true },
        }}
        state={{}}
        onEvent={noop}
      />
    </Column>
  </Surface>
);

/** A checked / unchecked / disabled sweep so the box, label, and dimmed
 *  disabled state are all visible side by side. */
export const States = () => (
  <Surface>
    <Column>
      <Checkbox
        component={{
          id: "cb-on",
          type: "checkbox",
          props: { label: "Restore window layout on launch", value: true },
        }}
        state={{}}
        onEvent={noop}
      />
      <Checkbox
        component={{
          id: "cb-off",
          type: "checkbox",
          props: { label: "Confirm before deleting a workspace", value: false },
        }}
        state={{}}
        onEvent={noop}
      />
      <Checkbox
        component={{
          id: "cb-disabled",
          type: "checkbox",
          props: {
            label: "Share terminal output with the agent (locked by policy)",
            value: false,
            disabled: true,
          },
        }}
        state={{}}
        onEvent={noop}
      />
    </Column>
  </Surface>
);

/** The checked value resolves from the shared state object via a `$ref`
 *  JSON Pointer — the core A2UI data-binding idiom for a live setting. */
export const StateBound = () => (
  <Surface>
    <Column>
      <Checkbox
        component={{
          id: "cb-bound",
          type: "checkbox",
          props: {
            label: "Trust this workspace (read-write, no prompts)",
            value: { $ref: "/settings/trusted" },
          },
        }}
        state={{ settings: { trusted: true } }}
        onEvent={noop}
      />
    </Column>
  </Surface>
);
