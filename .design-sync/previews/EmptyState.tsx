import { EmptyState } from "aethon";
import type * as React from "react";

/** Preview-only themed surface: the app shell styles `body` with
 *  --bg/--text/--font-ui (chrome base.css), and real designs inherit that
 *  via the styles.css closure — the DS preview harness overrides body to
 *  white, so surfaces re-create the shell base locally. EmptyState is a
 *  full-canvas welcome screen, so the surface is sized like the canvas
 *  slot (100% wide, tall min-height) rather than a compact card. */
const Surface = ({ children }: { children?: React.ReactNode }) => (
  <div
    style={{
      background: "var(--bg)",
      color: "var(--text)",
      fontFamily: "var(--font-ui)",
      width: "100%",
      minHeight: 460,
      display: "flex",
    }}
  >
    {children}
  </div>
);

const noop = () => {};

/** The canonical welcome canvas: hero mark, title/subtitle, primary +
 *  secondary actions, recent projects (one active), recent sessions, and
 *  keyboard-shortcut tips — everything a returning user lands on when all
 *  tabs are closed. */
export const Welcome = () => (
  <Surface>
    <EmptyState
      component={{
        id: "es-welcome",
        type: "empty-state",
        props: {
          title: "Welcome to Aethon",
          subtitle:
            "All tabs are closed. Start a new session or reopen a recent one.",
          primaryButtonLabel: "New session",
          secondaryButtonLabel: "Open project…",
          recentProjects: [
            {
              id: "p-aethon",
              label: "aethon",
              path: "~/Projects/utensils/aethon",
              active: true,
            },
            {
              id: "p-claudette",
              label: "claudette",
              path: "~/Projects/utensils/claudette",
            },
            {
              id: "p-dotfiles",
              label: "dotfiles",
              path: "~/Projects/nix/dotfiles",
            },
          ],
          recentSessions: [
            {
              id: "s-1",
              label: "migrate window-state schema to v1",
              lastModified: "12 minutes ago",
              cwd: "~/Projects/utensils/aethon",
            },
            {
              id: "s-2",
              label: "review copilot findings on #493",
              lastModified: "2 hours ago",
              cwd: "~/Projects/utensils/aethon",
            },
            {
              id: "s-3",
              label: "wire release-please app token",
              lastModified: "yesterday",
              cwd: "~/Projects/utensils/claudette",
            },
          ],
          tips: [
            "Press ⌘T to open a new agent tab, ⌘⇧T for a shell tab",
            "Toggle the terminal panel with Ctrl+`",
            "Type @<subagent> in the composer to delegate a task",
          ],
        },
      }}
      state={{}}
      onEvent={noop}
    />
  </Surface>
);

/** A first-run / minimal variant — no recents yet, just the hero, a single
 *  primary action, and a couple of orientation tips. Shows the layout
 *  holding up when the recent-projects / recent-sessions blocks are absent. */
export const FirstRun = () => (
  <Surface>
    <EmptyState
      component={{
        id: "es-firstrun",
        type: "empty-state",
        props: {
          title: "Nothing open yet",
          subtitle: "Open a project directory to point your first session at it.",
          primaryButtonLabel: "New session",
          secondaryButtonLabel: "Open project…",
          tips: [
            "Aethon inherits the active project's cwd for every new tab",
            "Press ⌘K to open the command palette",
          ],
        },
      }}
      state={{}}
      onEvent={noop}
    />
  </Surface>
);

/** State-bound variant — title/subtitle and the recent-projects list resolve
 *  from the shared state object through `$ref` JSON Pointers, the core A2UI
 *  data-binding idiom, rather than being passed inline. */
export const StateBound = () => (
  <Surface>
    <EmptyState
      component={{
        id: "es-bound",
        type: "empty-state",
        props: {
          title: { $ref: "/welcome/title" },
          subtitle: { $ref: "/welcome/subtitle" },
          primaryButtonLabel: "New session",
          secondaryButtonLabel: "Open project…",
          recentProjects: { $ref: "/recentProjects" },
          tips: ["Press ⌘T for a new tab", "Ctrl+` toggles the terminal"],
        },
      }}
      state={{
        welcome: {
          title: "Pick up where you left off",
          subtitle: "Your recent projects are one click away.",
        },
        recentProjects: [
          {
            id: "p-aethon",
            label: "aethon",
            path: "~/Projects/utensils/aethon",
            active: true,
          },
          {
            id: "p-website",
            label: "website",
            path: "~/Projects/www/site",
          },
        ],
      }}
      onEvent={noop}
    />
  </Surface>
);
