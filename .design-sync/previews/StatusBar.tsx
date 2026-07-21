import { StatusBar } from "aethon";
import type * as React from "react";

/** Preview-only themed surface. StatusBar is a full-width chrome footer, so
 *  the surface stretches to 100% and mimics the shell base the real footer
 *  sits against (the DS harness forces the body white). */
const Surface = ({ children }: { children?: React.ReactNode }) => (
  <div
    style={{
      background: "var(--bg)",
      color: "var(--text)",
      fontFamily: "var(--font-ui)",
      width: "100%",
      padding: 16,
    }}
  >
    {children}
  </div>
);

const noop = () => {};

/**
 * StatusBar prop wiring mirrors workstation.a2ui.json:
 *   left    ← /status      (agent status: "ready" → renders "idle" center)
 *   center  ← /connection  (connection: "connected" → left label + tone)
 *   right   ← /model
 *   context ← /contextUsage (a ContextUsageState object)
 * plus a project chip derived from /sidebar/projects + /activeProjectId,
 * a change count from /vcs, and a devshell chip from /devshell.
 */

const sidebarProjects = [
  {
    id: "p-aethon",
    label: "aethon",
    active: true,
    tooltip: "aethon — ~/Projects/utensils/aethon",
    git: { branch: "main", dirty: true, ahead: 2, behind: 0 },
    workspaces: [{ id: "w-main", label: "main", branch: "main", active: true }],
  },
];

/** Idle footer — the resting state: connected, agent idle, model on the
 *  right, project chip (aethon · main with 3 changed files), a ready
 *  devshell chip, and a healthy ~36% context meter. */
export const Idle = () => (
  <Surface>
    <StatusBar
      component={{
        id: "sb-idle",
        type: "status",
        props: {
          left: { $ref: "/status" },
          center: { $ref: "/connection" },
          right: { $ref: "/model" },
          context: { $ref: "/contextUsage" },
          showProjectChip: true,
        },
      }}
      state={{
        status: "ready",
        connection: "connected",
        model: "claude-sonnet-5 · medium",
        activeTabId: "tab-1",
        messages: [],
        activeProjectId: "p-aethon",
        sidebar: { projects: sidebarProjects },
        vcs: { changes: { total: 3 } },
        devshell: {
          activeRoot: "/Users/j/aethon",
          entries: {
            "/Users/j/aethon": {
              kind: "flake",
              detectedKind: "flake",
              enabled: "auto",
              mode: "nix",
              state: "ready",
              varCount: 42,
              durationMs: 318,
            },
          },
        },
        contextUsage: {
          model: "claude-sonnet-5",
          status: "known",
          tokens: 71_400,
          contextWindow: 200_000,
          percent: 35.7,
          estimatedTokens: 71_400,
          estimatedPercent: 35.7,
          transientTokens: 0,
          autoCompactEnabled: true,
          reserveTokens: 20_000,
          compactAtTokens: 160_000,
          tokensUntilCompact: 88_600,
          estimatedTokensUntilCompact: 88_600,
        },
      }}
      onEvent={noop}
    />
  </Surface>
);

/** Agent-active footer — a turn is in flight, so the center region flips to
 *  the live activity label ("Writing response") with its is-agent-active
 *  styling, and the context meter has climbed into the warning band (~74%). */
export const AgentActive = () => (
  <Surface>
    <StatusBar
      component={{
        id: "sb-active",
        type: "status",
        props: {
          left: { $ref: "/status" },
          center: { $ref: "/connection" },
          right: { $ref: "/model" },
          context: { $ref: "/contextUsage" },
          showProjectChip: true,
        },
      }}
      state={{
        status: "running",
        connection: "connected",
        model: "claude-opus-4-8 · high",
        activeTabId: "tab-1",
        messages: [],
        agentActivityByTab: {
          "tab-1": {
            label: "Writing response",
            detail: "Streaming the answer",
            startedAt: 1_000,
            updatedAt: 2_000,
          },
        },
        activeProjectId: "p-aethon",
        sidebar: { projects: sidebarProjects },
        vcs: { changes: { total: 7 } },
        contextUsage: {
          model: "claude-opus-4-8",
          status: "known",
          tokens: 148_000,
          contextWindow: 200_000,
          percent: 74.0,
          estimatedTokens: 148_000,
          estimatedPercent: 74.0,
          transientTokens: 0,
          autoCompactEnabled: true,
          reserveTokens: 20_000,
          compactAtTokens: 170_000,
          tokensUntilCompact: 22_000,
          estimatedTokensUntilCompact: 22_000,
        },
      }}
      onEvent={noop}
    />
  </Surface>
);

/** Saturated footer — the provider reports the window full, so the context
 *  chip renders "ctx FULL" in its danger/saturated styling, and connection
 *  is still healthy. Shows the loud end of the context-meter range. */
export const ContextFull = () => (
  <Surface>
    <StatusBar
      component={{
        id: "sb-full",
        type: "status",
        props: {
          left: { $ref: "/status" },
          center: { $ref: "/connection" },
          right: { $ref: "/model" },
          context: { $ref: "/contextUsage" },
          showProjectChip: true,
        },
      }}
      state={{
        status: "ready",
        connection: "connected",
        model: "qwen2.5-coder:32b",
        activeTabId: "tab-1",
        messages: [],
        activeProjectId: "p-aethon",
        sidebar: { projects: sidebarProjects },
        vcs: { changes: { total: 0 } },
        contextUsage: {
          model: "qwen2.5-coder:32b",
          status: "known",
          tokens: 32_768,
          contextWindow: 32_768,
          percent: 100,
          estimatedTokens: 32_768,
          estimatedPercent: 100,
          transientTokens: 0,
          autoCompactEnabled: false,
          reserveTokens: 4_000,
          compactAtTokens: 32_768,
          tokensUntilCompact: 0,
          estimatedTokensUntilCompact: 0,
          saturatedByProvider: true,
          saturated: true,
        },
      }}
      onEvent={noop}
    />
  </Surface>
);
