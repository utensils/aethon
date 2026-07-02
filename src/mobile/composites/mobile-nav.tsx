// Bottom tab bar for the companion. Emits `mobile-nav {screen}` on tap;
// the mobileNav event route flips the per-screen visibility flags the
// layout gates on. Highlight follows `/mobileNav/active`.

import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import type { CSSProperties } from "react";

interface NavItem {
  screen: string;
  label: string;
  glyph: string;
  needsProject?: boolean;
  needsSession?: boolean;
}

const ITEMS: readonly NavItem[] = [
  { screen: "projects", label: "Projects", glyph: "▦" },
  { screen: "sessions", label: "Sessions", glyph: "☰" },
  { screen: "chat", label: "Chat", glyph: "◆", needsSession: true },
  { screen: "files", label: "Files", glyph: "▤", needsProject: true },
  { screen: "terminal", label: "Terminal", glyph: "❯_", needsProject: true },
  { screen: "git", label: "Git", glyph: "⑃", needsProject: true },
];

interface TabLike {
  id?: string;
  kind?: string;
}

function hasProjectContext(state: Record<string, unknown>): boolean {
  const project = state.project as { id?: unknown; path?: unknown } | null | undefined;
  return (
    typeof state.activeProjectId === "string" ||
    typeof project?.id === "string" ||
    typeof project?.path === "string"
  );
}

function hasSessionContext(state: Record<string, unknown>): boolean {
  const tabs = (Array.isArray(state.tabs) ? state.tabs : []) as TabLike[];
  const activeTabId =
    typeof state.activeTabId === "string" ? state.activeTabId : undefined;
  return tabs.some(
    (tab) => (tab.kind ?? "agent") === "agent" && (!activeTabId || tab.id === activeTabId),
  );
}

export function MobileNav({ state, onEvent }: BuiltinComponentProps) {
  const active =
    ((state.mobileNav as { active?: string } | undefined)?.active) ?? "sessions";
  const hasProject = hasProjectContext(state);
  const hasSession = hasSessionContext(state) || hasProject;
  const items = ITEMS.filter((item) => {
    if (item.needsProject) return hasProject;
    if (item.needsSession) return hasSession;
    return true;
  });

  return (
    <nav
      className="ae-mobile-nav"
      aria-label="Sections"
      style={{ "--ae-mobile-nav-count": items.length } as CSSProperties}
    >
      {items.map((item) => (
        <button
          key={item.screen}
          type="button"
          className={`ae-mobile-nav-item${active === item.screen ? " ae-mobile-nav-item--active" : ""}`}
          aria-current={active === item.screen ? "page" : undefined}
          onClick={() => onEvent("mobile-nav", { screen: item.screen })}
        >
          <span className="ae-mobile-nav-glyph" aria-hidden>
            {item.glyph}
          </span>
          <span className="ae-mobile-nav-label">{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
