// Sessions screen — the mobile stand-in for the desktop sidebar. Lists
// the open agent tabs and recent sessions from the same state slices the
// sidebar reads (`/tabs`, `/recentSessions`), and taps route through the
// mobileNav handler to activate / restore and switch to the chat screen.

import type { BuiltinComponentProps } from "../../components/A2UIRenderer";

interface TabLike {
  id: string;
  kind?: string;
  label?: string;
  cwd?: string;
}
interface RecentLike {
  id: string;
  label: string;
  cwd?: string;
  lastModified?: string;
}

function baseName(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd;
}

export function MobileSessions({ state, onEvent }: BuiltinComponentProps) {
  const tabs = (Array.isArray(state.tabs) ? state.tabs : []) as TabLike[];
  const agentTabs = tabs.filter((t) => (t.kind ?? "agent") === "agent");
  const recent = (
    Array.isArray(state.recentSessions) ? state.recentSessions : []
  ) as RecentLike[];
  const openIds = new Set(agentTabs.map((t) => t.id));
  const recentUnopened = recent.filter((r) => !openIds.has(r.id));

  return (
    <div className="ae-mobile-sessions">
      <button
        type="button"
        className="ae-mobile-new-session"
        onClick={() => onEvent("new-session")}
      >
        + New session
      </button>

      {agentTabs.length > 0 ? (
        <section className="ae-mobile-session-group">
          <h2 className="ae-mobile-session-heading">Open</h2>
          {agentTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className="ae-mobile-session-row"
              onClick={() => onEvent("select-tab", { tabId: tab.id })}
            >
              <span className="ae-mobile-session-name">
                {tab.label || "Session"}
              </span>
              {baseName(tab.cwd) ? (
                <span className="ae-mobile-session-cwd">{baseName(tab.cwd)}</span>
              ) : null}
            </button>
          ))}
        </section>
      ) : null}

      {recentUnopened.length > 0 ? (
        <section className="ae-mobile-session-group">
          <h2 className="ae-mobile-session-heading">Recent</h2>
          {recentUnopened.map((session) => (
            <button
              key={session.id}
              type="button"
              className="ae-mobile-session-row"
              onClick={() =>
                onEvent("restore-session", {
                  sessionId: session.id,
                  cwd: session.cwd,
                  label: session.label,
                })
              }
            >
              <span className="ae-mobile-session-name">
                {session.label || "Session"}
              </span>
              {baseName(session.cwd) ? (
                <span className="ae-mobile-session-cwd">
                  {baseName(session.cwd)}
                </span>
              ) : null}
            </button>
          ))}
        </section>
      ) : null}

      {agentTabs.length === 0 && recentUnopened.length === 0 ? (
        <p className="ae-mobile-session-empty">
          No sessions yet. Start one to begin.
        </p>
      ) : null}
    </div>
  );
}
