// Bottom tab bar for the companion. Emits `mobile-nav {screen}` on tap;
// the mobileNav event route flips the per-screen visibility flags the
// layout gates on. Highlight follows `/mobileNav/active`.

import type { BuiltinComponentProps } from "../../components/A2UIRenderer";

interface NavItem {
  screen: string;
  label: string;
  glyph: string;
}

const ITEMS: NavItem[] = [
  { screen: "sessions", label: "Sessions", glyph: "☰" },
  { screen: "chat", label: "Chat", glyph: "◆" },
  { screen: "terminal", label: "Terminal", glyph: "❯_" },
  { screen: "files", label: "Files", glyph: "▤" },
  { screen: "git", label: "Git", glyph: "⑃" },
  { screen: "settings", label: "Settings", glyph: "⚙" },
];

export function MobileNav({ state, onEvent }: BuiltinComponentProps) {
  const active =
    ((state.mobileNav as { active?: string } | undefined)?.active) ?? "sessions";
  return (
    <nav className="ae-mobile-nav" aria-label="Sections">
      {ITEMS.map((item) => (
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
