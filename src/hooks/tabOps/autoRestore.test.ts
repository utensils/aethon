import { describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";
import { useAutoRestoreDiscoveredSessions } from "./autoRestore";
import { makeEmptyTab } from "../../types/tab";

const ref = <T>(value: T): MutableRefObject<T> => ({ current: value });

describe("autoRestoreDiscoveredSessions", () => {
  it("does not reopen discovered sessions the user explicitly closed", () => {
    const newTab = vi.fn();
    const pushNotification = vi.fn();
    const autoRestore = useAutoRestoreDiscoveredSessions({
      stateRef: ref({
        tabs: [],
        closedSessionIds: ["closed-session"],
      }),
      autoRestoredSessionIdsRef: ref(new Set<string>()),
      pushNotification,
      newTab,
    });

    autoRestore(
      [
        {
          tabId: "closed-session",
          lastModified: 2,
          firstUserMessage: "Closed should stay closed",
        },
        {
          tabId: "open-session",
          lastModified: 1,
          firstUserMessage: "Restore me",
          cwd: "/repo/app",
        },
      ],
      new Set(),
    );

    expect(newTab).toHaveBeenCalledTimes(1);
    expect(newTab).toHaveBeenCalledWith("open-session", "Restore me", {
      restoredSession: true,
      cwd: "/repo/app",
    });
    expect(pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Restored 1 session" }),
    );
  });

  it("does not restore sessions whose cwd no longer exists", () => {
    const newTab = vi.fn();
    const autoRestore = useAutoRestoreDiscoveredSessions({
      stateRef: ref({ tabs: [], closedSessionIds: [] }),
      autoRestoredSessionIdsRef: ref(new Set<string>()),
      pushNotification: vi.fn(),
      newTab,
    });

    autoRestore(
      [
        {
          tabId: "stale-workspace",
          lastModified: 1,
          firstUserMessage: "Please work on issue...",
          cwd: "/deleted/workspace",
          cwdExists: false,
        },
        {
          tabId: "valid-session",
          lastModified: 2,
          firstUserMessage: "Hello",
          cwd: "/valid/path",
          cwdExists: true,
        },
      ],
      new Set(),
    );

    expect(newTab).toHaveBeenCalledTimes(1);
    expect(newTab).toHaveBeenCalledWith("valid-session", "Hello", {
      restoredSession: true,
      cwd: "/valid/path",
    });
  });

  it("does not restore already-open local tabs", () => {
    const newTab = vi.fn();
    const autoRestore = useAutoRestoreDiscoveredSessions({
      stateRef: ref({
        tabs: [makeEmptyTab("local-session", "Local")],
        closedSessionIds: [],
      }),
      autoRestoredSessionIdsRef: ref(new Set<string>()),
      pushNotification: vi.fn(),
      newTab,
    });

    autoRestore(
      [
        {
          tabId: "local-session",
          lastModified: 1,
          firstUserMessage: "already open",
        },
      ],
      new Set(),
    );

    expect(newTab).not.toHaveBeenCalled();
  });
});
