import { Slider } from "aethon";
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

/** Sliders need a fixed-width track container or the range input collapses. */
const Field = ({
  label,
  children,
}: {
  label: string;
  children?: React.ReactNode;
}) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 8 }}>
    <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>{label}</span>
    <div style={{ width: 280 }}>{children}</div>
  </div>
);

/** Numeric settings from Settings → Appearance / Agent, each showing its live
 *  value so the readout and track are both visible. */
export const NumericSettings = () => (
  <Surface>
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Field label="UI scale">
        <Slider
          component={{
            id: "sl-scale",
            type: "slider",
            props: {
              value: 110,
              min: 80,
              max: 150,
              step: 5,
              showValue: true,
            },
          }}
          state={{}}
          onEvent={noop}
        />
      </Field>
      <Field label="Devshell cache TTL (hours)">
        <Slider
          component={{
            id: "sl-ttl",
            type: "slider",
            props: {
              value: 24,
              min: 1,
              max: 72,
              step: 1,
              showValue: true,
            },
          }}
          state={{}}
          onEvent={noop}
        />
      </Field>
    </div>
  </Surface>
);

/** A disabled track (setting locked by policy) next to an active one at the
 *  low end of its range. */
export const States = () => (
  <Surface>
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Field label="Context window budget (%)">
        <Slider
          component={{
            id: "sl-context",
            type: "slider",
            props: { value: 65, min: 0, max: 100, step: 5, showValue: true },
          }}
          state={{}}
          onEvent={noop}
        />
      </Field>
      <Field label="Speak-aloud volume (locked)">
        <Slider
          component={{
            id: "sl-disabled",
            type: "slider",
            props: {
              value: 30,
              min: 0,
              max: 100,
              step: 10,
              showValue: true,
              disabled: true,
            },
          }}
          state={{}}
          onEvent={noop}
        />
      </Field>
    </div>
  </Surface>
);

/** The value resolves from the shared state object via a `$ref` JSON Pointer —
 *  the core A2UI data-binding idiom for a live numeric setting. */
export const StateBound = () => (
  <Surface>
    <Field label="Idle-retire timeout (minutes)">
      <Slider
        component={{
          id: "sl-bound",
          type: "slider",
          props: {
            value: { $ref: "/agent/idleRetire" },
            min: 5,
            max: 60,
            step: 5,
            showValue: true,
          },
        }}
        state={{ agent: { idleRetire: 15 } }}
        onEvent={noop}
      />
    </Field>
  </Surface>
);
