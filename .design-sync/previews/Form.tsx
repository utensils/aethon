import { DatePicker, Form, FormField, TextInput } from "aethon";
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

/** "New scheduled agent" — the canonical multi-field form: name, branch,
 *  run date, and prompt, with a primary submit button. */
export const NewScheduledAgent = () => (
  <Surface>
    <div style={{ maxWidth: 420, padding: 8 }}>
      <Form
        component={{
          id: "form-new",
          type: "form",
          props: { submitLabel: "Schedule agent", gap: 14 },
        }}
        state={{}}
        onEvent={noop}
        renderChildren={() => (
          <>
            <FormField
              component={{
                id: "form-new-name",
                type: "form-field",
                props: {
                  label: "Task name",
                  description: "Shown in the sessions sidebar.",
                  required: true,
                },
              }}
              state={{}}
              onEvent={noop}
              renderChildren={() => (
                <TextInput
                  component={{
                    id: "form-new-name-input",
                    type: "text-input",
                    props: { value: "Nightly dependency bump", name: "name" },
                  }}
                  state={{}}
                  onEvent={noop}
                />
              )}
            />
            <FormField
              component={{
                id: "form-new-branch",
                type: "form-field",
                props: {
                  label: "Branch",
                  description: "Worktree created from main.",
                },
              }}
              state={{}}
              onEvent={noop}
              renderChildren={() => (
                <TextInput
                  component={{
                    id: "form-new-branch-input",
                    type: "text-input",
                    props: { value: "chore/nightly-deps", name: "branch" },
                  }}
                  state={{}}
                  onEvent={noop}
                />
              )}
            />
            <FormField
              component={{
                id: "form-new-date",
                type: "form-field",
                props: { label: "Run on" },
              }}
              state={{}}
              onEvent={noop}
              renderChildren={() => (
                <DatePicker
                  component={{
                    id: "form-new-date-input",
                    type: "date-picker",
                    props: { value: "2026-07-24", min: "2026-07-20", name: "runOn" },
                  }}
                  state={{}}
                  onEvent={noop}
                />
              )}
            />
            <FormField
              component={{
                id: "form-new-prompt",
                type: "form-field",
                props: {
                  label: "Prompt",
                  description: "The opening turn sent to the agent.",
                  required: true,
                },
              }}
              state={{}}
              onEvent={noop}
              renderChildren={() => (
                <TextInput
                  component={{
                    id: "form-new-prompt-input",
                    type: "text-input",
                    props: {
                      value: "Update all bun + cargo deps and run the full check gate.",
                      name: "prompt",
                    },
                  }}
                  state={{}}
                  onEvent={noop}
                />
              )}
            />
          </>
        )}
      />
    </div>
  </Surface>
);

/** Disabled — the whole form dims and the submit button is inert while a
 *  schedule is being saved. */
export const Submitting = () => (
  <Surface>
    <div style={{ maxWidth: 420, padding: 8 }}>
      <Form
        component={{
          id: "form-disabled",
          type: "form",
          props: { submitLabel: "Saving…", disabled: true, gap: 14 },
        }}
        state={{}}
        onEvent={noop}
        renderChildren={() => (
          <>
            <FormField
              component={{
                id: "form-disabled-name",
                type: "form-field",
                props: { label: "Task name", required: true },
              }}
              state={{}}
              onEvent={noop}
              renderChildren={() => (
                <TextInput
                  component={{
                    id: "form-disabled-name-input",
                    type: "text-input",
                    props: { value: "Nightly dependency bump", name: "name" },
                  }}
                  state={{}}
                  onEvent={noop}
                />
              )}
            />
            <FormField
              component={{
                id: "form-disabled-branch",
                type: "form-field",
                props: { label: "Branch" },
              }}
              state={{}}
              onEvent={noop}
              renderChildren={() => (
                <TextInput
                  component={{
                    id: "form-disabled-branch-input",
                    type: "text-input",
                    props: { value: "chore/nightly-deps", name: "branch" },
                  }}
                  state={{}}
                  onEvent={noop}
                />
              )}
            />
          </>
        )}
      />
    </div>
  </Surface>
);
