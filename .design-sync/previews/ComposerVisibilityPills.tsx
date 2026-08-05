import { ComposerVisibilityPills } from "aethon";
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

/**
 * The pills take `{ state, tabId, onEvent }` directly (a BuiltinComponentProps
 * subset — no A2UI envelope). Effective visibility comes from the shared
 * `resolveVisibility(state, tabId)`: a per-tab `visibilityOverrides.<category>`
 * wins, else the global `/transcriptVisibility` mirror. Plan mode reads from
 * the active agent tab's `planMode`. We build a tabs fixture and point `tabId`
 * at it so the closed pill row (Plan mode / Thinking / Tool calls + the "…"
 * caret) renders in a real state — the popover is interaction-only and stays
 * closed here.
 */

/** Customized session: plan mode on, a per-session Thinking override to "off"
 *  (hide), tool calls following the global default (on). */
export const CustomizedSession = () => (
  <Surface>
    <div style={{ maxWidth: 460 }}>
      <ComposerVisibilityPills
        state={{
          tabs: [
            {
              id: "tab-agent",
              kind: "agent",
              planMode: true,
              visibilityOverrides: { thinking: "hide" },
              hardEnforceProjectRoot: false,
            },
          ],
          transcriptVisibility: { thinking: "show", toolCalls: "show" },
          guardrails: { hardEnforceProjectRoot: false },
        }}
        tabId="tab-agent"
        onEvent={noop}
      />
    </div>
  </Surface>
);

/** Default session: no per-session overrides, plan mode off — every pill
 *  follows the global defaults (Thinking on, Tool calls off). */
export const DefaultSession = () => (
  <Surface>
    <div style={{ maxWidth: 460 }}>
      <ComposerVisibilityPills
        state={{
          tabs: [
            {
              id: "tab-agent",
              kind: "agent",
              planMode: false,
            },
          ],
          transcriptVisibility: { thinking: "show", toolCalls: "group-turn" },
          guardrails: { hardEnforceProjectRoot: false },
        }}
        tabId="tab-agent"
        onEvent={noop}
      />
    </div>
  </Surface>
);
