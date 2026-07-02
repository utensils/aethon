// Companion (mobile) navigation. The bottom nav + the sessions screen
// route here. Screen switching is expressed as per-screen boolean flags
// under `/mobileNav` because the layout's `visible` binding only tests
// truthiness (no equality) — exactly one flag is true at a time.
//
// Registered by `type:` so an extension replacing `mobile-nav` /
// `mobile-sessions` keeps working. Inert on desktop: those component
// types never appear in the workstation layout.

import type { EventRouteHandler } from "./types";
import { restoreSessionFromSelection } from "./sessionRestore";

type Screen = "sessions" | "chat" | "terminal" | "files" | "git" | "settings";

function screenFlags(active: Screen): Record<string, unknown> {
  return {
    active,
    isSessions: active === "sessions",
    isChat: active === "chat",
    isTerminal: active === "terminal",
    isFiles: active === "files",
    isGit: active === "git",
    isSettings: active === "settings",
  };
}

function setScreen(
  ctx: Parameters<EventRouteHandler>[1],
  active: Screen,
): void {
  ctx.setState((prev) => {
    const next: Record<string, unknown> = {
      ...prev,
      mobileNav: screenFlags(active),
    };
    // The Settings overlay is state-driven; the nav "settings" tab opens
    // it and any other tab closes it, so it behaves like a screen.
    const settings = (prev.settings as Record<string, unknown>) ?? {};
    next.settings = { ...settings, open: active === "settings" };
    return next;
  });
}

const SCREENS: readonly Screen[] = [
  "sessions",
  "chat",
  "terminal",
  "files",
  "git",
  "settings",
];

function asScreen(value: unknown): Screen | undefined {
  return SCREENS.find((s) => s === value);
}

export const handleMobileNav: EventRouteHandler = ({ component, eventType, data }, ctx) => {
  if (component.type === "mobile-nav") {
    if (eventType === "mobile-nav") {
      // Validate, don't cast: events can arrive over the gateway, and an
      // unknown screen would zero every visibility flag (blank canvas).
      const screen = asScreen((data as { screen?: unknown } | undefined)?.screen);
      if (screen) setScreen(ctx, screen);
    }
    return true;
  }

  if (component.type === "mobile-sessions") {
    switch (eventType) {
      case "new-session":
        ctx.newTab();
        setScreen(ctx, "chat");
        return true;
      case "select-tab": {
        const tabId = (data as { tabId?: string } | undefined)?.tabId;
        if (tabId) ctx.activateTabAnywhere(tabId);
        setScreen(ctx, "chat");
        return true;
      }
      case "restore-session": {
        restoreSessionFromSelection(
          ctx,
          data as { sessionId?: string; cwd?: string; label?: string } | undefined,
        );
        setScreen(ctx, "chat");
        return true;
      }
    }
    return true;
  }

  if (component.type === "mobile-file-list") {
    if (eventType === "open-file") {
      const sel = data as { root?: string; path?: string } | undefined;
      if (sel?.root && sel.path) {
        ctx.setState((prev) => ({
          ...prev,
          mobileFileViewer: { open: true, root: sel.root, path: sel.path },
        }));
      }
    }
    return true;
  }

  if (component.type === "mobile-file-viewer") {
    if (eventType === "close") {
      ctx.setState((prev) => ({
        ...prev,
        mobileFileViewer: { open: false },
      }));
    }
    return true;
  }

  return false;
};
