import { Select } from "aethon";
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
  <label style={{ display: "flex", flexDirection: "column", gap: 6, padding: 8 }}>
    <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>{label}</span>
    {children}
  </label>
);

/** The model picker — a selected value against the real model registry
 *  Aethon ships (Claude + Codex families). */
export const ModelPicker = () => (
  <Surface>
    <Field label="Model">
      <Select
        component={{
          id: "sel-model",
          type: "select",
          props: {
            value: "claude-opus-4-8",
            options: [
              { value: "claude-opus-4-8", label: "Claude Opus 4.8" },
              { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
              { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
              { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
            ],
          },
        }}
        state={{}}
        onEvent={noop}
      />
    </Field>
  </Surface>
);

/** Placeholder (nothing chosen yet) alongside a disabled field locked to a
 *  single provider — the two edge states a form has to render. */
export const PlaceholderAndDisabled = () => (
  <Surface>
    <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
      <Field label="Reasoning effort">
        <Select
          component={{
            id: "sel-placeholder",
            type: "select",
            props: {
              placeholder: "Choose an effort…",
              options: [
                { value: "minimal", label: "Minimal" },
                { value: "low", label: "Low" },
                { value: "medium", label: "Medium" },
                { value: "high", label: "High" },
              ],
            },
          }}
          state={{}}
          onEvent={noop}
        />
      </Field>
      <Field label="Provider (locked by workspace)">
        <Select
          component={{
            id: "sel-disabled",
            type: "select",
            props: {
              value: "anthropic",
              disabled: true,
              options: [
                { value: "anthropic", label: "Anthropic" },
                { value: "openai", label: "OpenAI" },
                { value: "ollama", label: "Ollama (local)" },
              ],
            },
          }}
          state={{}}
          onEvent={noop}
        />
      </Field>
    </div>
  </Surface>
);

/** Both the selected value and the option list resolve from the shared state
 *  object via `$ref` JSON Pointers — the core A2UI data-binding idiom. */
export const StateBound = () => (
  <Surface>
    <Field label="Auth profile">
      <Select
        component={{
          id: "sel-bound",
          type: "select",
          props: {
            value: { $ref: "/auth/active" },
            options: { $ref: "/auth/profiles" },
          },
        }}
        state={{
          auth: {
            active: "work",
            profiles: [
              { value: "work", label: "Work (OAuth)" },
              { value: "personal", label: "Personal (API key)" },
              { value: "ci", label: "CI bot (API key)" },
            ],
          },
        }}
        onEvent={noop}
      />
    </Field>
  </Surface>
);
