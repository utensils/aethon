/** Shared fixture for handler tests. Builds a `BridgeMessageContext`
 *  whose every method/ref is a `vi.fn()` or a mutable container the
 *  test can introspect. Tests pass an optional override map to swap
 *  individual fields with custom mocks. */
import { vi, type Mock } from "vitest";
import type { MutableRefObject } from "react";
import { defaultLayoutSkill } from "../../skills/default-layout";
import { SkillRegistry } from "../../skills/SkillRegistry";
import { emptyProjectsState } from "../../projects";
import type { BridgeMessageContext, DiscoveredSession } from "./types";

const ref = <T,>(value: T): MutableRefObject<T> => ({ current: value });

export interface FixtureOverrides {
  state?: Record<string, unknown>;
  /** Recorder for setState calls — exposed alongside the mock so tests
   *  can assert on the reducer outputs after running them against a
   *  seeded prev. */
  setStateApply?: (prev: Record<string, unknown>) => Record<string, unknown>;
}

export interface HandlerFixture {
  ctx: BridgeMessageContext;
  /** The mocked Tauri `invoke` from the test setup module. Lifted onto
   *  the fixture so a single import in a test gets both ctx + invoke. */
  mocks: {
    setState: Mock;
    setLayout: Mock;
    updateTab: Mock;
    updateActiveTab: Mock;
    appendMessage: Mock;
    persistLocalChatMessage: Mock;
    appendOrAmendAgentText: Mock;
    setStatusFlags: Mock;
    pushNotification: Mock;
    dismissNotification: Mock;
    maybeFireCompletionNotification: Mock;
    hydrateThemes: Mock;
    hydrateExtensions: Mock;
    hydrateSlashCommands: Mock;
    hydrateKeybindings: Mock;
    hydrateEventRoutes: Mock;
    hydrateExtensionLayouts: Mock;
    hydrateFrontendModules: Mock;
    syncRecentSessionsToState: Mock;
    autoRestoreDiscoveredSessions: Mock;
    dispatchTerminalReplay: Mock;
    announceProjectToBridge: Mock;
    routeShellWrite: Mock;
    ackMutation: Mock;
    knownTabIds: Mock;
    scopedDiscoveredSessions: Mock;
    recentSessionItems: Mock;
  };
  /** Apply every queued setState reducer in order against the supplied
   *  seed. Returns the resulting state for assertion. */
  applySetState: (seed?: Record<string, unknown>) => Record<string, unknown>;
}

export function buildHandlerFixture(
  overrides: FixtureOverrides = {},
): HandlerFixture {
  const initialState = overrides.state ?? {};
  const stateRef = ref<Record<string, unknown>>(initialState);
  const registry = new SkillRegistry();
  registry.register(defaultLayoutSkill);

  // setState applies the reducer against stateRef so side-effects inside
  // the reducer body run the same way they would in the live React app.
  // The mock still records every call so tests can introspect the
  // original argument.
  const setState = vi.fn((arg: unknown) => {
    if (typeof arg === "function") {
      stateRef.current = (arg as (
        p: Record<string, unknown>,
      ) => Record<string, unknown>)(stateRef.current);
    } else {
      stateRef.current = arg as Record<string, unknown>;
    }
  });
  const setLayout = vi.fn();
  const updateTab = vi.fn();
  const updateActiveTab = vi.fn();
  const appendMessage = vi.fn();
  const persistLocalChatMessage = vi.fn();
  const appendOrAmendAgentText = vi.fn();
  const setStatusFlags = vi.fn();
  const pushNotification = vi.fn();
  const dismissNotification = vi.fn();
  const maybeFireCompletionNotification = vi.fn(() => Promise.resolve());
  const hydrateThemes = vi.fn();
  const hydrateExtensions = vi.fn();
  const hydrateSlashCommands = vi.fn();
  const hydrateKeybindings = vi.fn();
  const hydrateEventRoutes = vi.fn();
  const hydrateExtensionLayouts = vi.fn();
  const hydrateFrontendModules = vi.fn();
  const syncRecentSessionsToState = vi.fn();
  const autoRestoreDiscoveredSessions = vi.fn();
  const dispatchTerminalReplay = vi.fn();
  const announceProjectToBridge = vi.fn();
  const routeShellWrite = vi.fn(() => Promise.resolve({ ok: true as const }));
  const ackMutation = vi.fn();
  const knownTabIds = vi.fn(() => new Set<string>(["default"]));
  const scopedDiscoveredSessions = vi.fn(
    (d: DiscoveredSession[]) => d,
  );
  const recentSessionItems = vi.fn(() => []);

  const ctx: BridgeMessageContext = {
    setState,
    setLayout,
    stateRef,
    registry,
    piDefaultModelRef: ref(""),
    allDiscoveredSessionsRef: ref<DiscoveredSession[]>([]),
    projectsRef: ref(emptyProjectsState()),
    projectsLoadedRef: ref(false),
    activeResponseIdRef: ref<string | null>(null),
    hangWarnTimersRef: ref(new Map()),
    hangWarnActiveRef: ref(new Set()),
    turnStartedAtRef: ref(new Map()),
    lastExtensionStateKeysRef: ref(new Set()),
    pendingTabOpens: ref(new Map()),

    updateTab,
    updateActiveTab,
    dispatchTerminalReplay,
    autoRestoreDiscoveredSessions,

    hydrateThemes,
    hydrateExtensions,
    hydrateSlashCommands,
    hydrateKeybindings,
    hydrateEventRoutes,
    hydrateExtensionLayouts,
    hydrateFrontendModules,

    announceProjectToBridge,

    appendMessage,
    persistLocalChatMessage,
    appendOrAmendAgentText,
    setStatusFlags,

    pushNotification,
    dismissNotification,
    maybeFireCompletionNotification,

    knownTabIds,
    scopedDiscoveredSessions,
    recentSessionItems,
    syncRecentSessionsToState,

    routeShellWrite,

    ackMutation,
    hangWarnNotifId: (tabId: string) => `ae-hang-warn:${tabId}`,
    hangWarnMs: 30_000,
    bootLayout: { components: [{ id: "root", type: "container" }] },
  };

  // Replays every queued setState call against the supplied seed (or the
  // current stateRef when omitted) and returns the resulting state. Most
  // tests can read stateRef.current directly because setState now mutates
  // it; this is the escape hatch for tests that want to apply against a
  // different seed than the one the fixture was built with.
  const applySetState = (seed?: Record<string, unknown>) => {
    if (seed === undefined) return stateRef.current;
    let cur = { ...seed };
    for (const call of setState.mock.calls) {
      const arg = call[0];
      if (typeof arg === "function") {
        cur = (arg as (p: Record<string, unknown>) => Record<string, unknown>)(cur);
      } else {
        cur = arg as Record<string, unknown>;
      }
    }
    return cur;
  };

  return {
    ctx,
    mocks: {
      setState,
      setLayout,
      updateTab,
      updateActiveTab,
      appendMessage,
      persistLocalChatMessage,
      appendOrAmendAgentText,
      setStatusFlags,
      pushNotification,
      dismissNotification,
      maybeFireCompletionNotification,
      hydrateThemes,
      hydrateExtensions,
      hydrateSlashCommands,
      hydrateKeybindings,
      hydrateEventRoutes,
      hydrateExtensionLayouts,
      hydrateFrontendModules,
      syncRecentSessionsToState,
      autoRestoreDiscoveredSessions,
      dispatchTerminalReplay,
      announceProjectToBridge,
      routeShellWrite,
      ackMutation,
      knownTabIds,
      scopedDiscoveredSessions,
      recentSessionItems,
    },
    applySetState,
  };
}
