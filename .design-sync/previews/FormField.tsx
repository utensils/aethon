import { FormField, TextInput } from "aethon";
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

/** Label + description wrapping a TextInput — the standard field composition. */
export const WithDescription = () => (
  <Surface>
    <div style={{ maxWidth: 360, padding: 8 }}>
      <FormField
        component={{
          id: "ff-name",
          type: "form-field",
          props: {
            label: "Workspace name",
            description: "Used for the git worktree directory and tab label.",
            required: true,
          },
        }}
        state={{}}
        onEvent={noop}
        renderChildren={() => (
          <TextInput
            component={{
              id: "ff-name-input",
              type: "text-input",
              props: { value: "aethon-nightly", name: "workspace" },
            }}
            state={{}}
            onEvent={noop}
          />
        )}
      />
    </div>
  </Surface>
);

/** Error state — the description is replaced by the validation message. */
export const WithError = () => (
  <Surface>
    <div style={{ maxWidth: 360, padding: 8 }}>
      <FormField
        component={{
          id: "ff-branch",
          type: "form-field",
          props: {
            label: "Branch name",
            description: "Created from the base branch.",
            error: "A branch named “main” already exists.",
            required: true,
          },
        }}
        state={{}}
        onEvent={noop}
        renderChildren={() => (
          <TextInput
            component={{
              id: "ff-branch-input",
              type: "text-input",
              props: { value: "main", name: "branch" },
            }}
            state={{}}
            onEvent={noop}
          />
        )}
      />
    </div>
  </Surface>
);

/** Label resolved from state via `$ref`, wrapping a placeholder input. */
export const StateBound = () => (
  <Surface>
    <div style={{ maxWidth: 360, padding: 8 }}>
      <FormField
        component={{
          id: "ff-bound",
          type: "form-field",
          props: {
            label: { $ref: "/field/label" },
            description: "Sent to the agent as the opening turn.",
          },
        }}
        state={{ field: { label: "Task prompt" } }}
        onEvent={noop}
        renderChildren={() => (
          <TextInput
            component={{
              id: "ff-bound-input",
              type: "text-input",
              props: {
                placeholder: "Describe what the agent should do…",
                name: "prompt",
              },
            }}
            state={{}}
            onEvent={noop}
          />
        )}
      />
    </div>
  </Surface>
);
