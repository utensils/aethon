// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectsDashboard } from "./projects-dashboard";
import type { A2UIComponent } from "../../../types/a2ui";
import type * as ConfigModule from "../../../config";
import { ExtensionRegistry } from "../../ExtensionRegistry";
import { ExtensionRegistryProvider } from "../../ExtensionRegistryProvider";
import { TaskLauncher } from "./task-launcher";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn((command: string) => {
    if (command === "read_config") {
      return Promise.resolve({
        ui: {},
        agent: {},
        shell: {},
        shortcuts: {},
        voice: {},
        updates: {},
        devshell: {},
        startup: { autoApprove: false },
        guardrails: {},
      });
    }
    return Promise.resolve(null);
  }),
}));

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("../../../config", async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModule>();
  return {
    ...actual,
    clearConfigCache: vi.fn(),
  };
});

function dashboard(props: Record<string, unknown>): A2UIComponent {
  return {
    id: "projects-dashboard",
    type: "projects-dashboard",
    props,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
});

describe("ProjectsDashboard", () => {
  it("renders a host-level task launcher with project selection", () => {
    const registry = new ExtensionRegistry();
    registry.register({
      name: "test-dashboard-components",
      components: {
        "task-launcher": TaskLauncher,
        "project-card": () => <div />,
        "subagents-config": () => <div>local subagents</div>,
      },
    });
    render(
      <ExtensionRegistryProvider registry={registry}>
        <ProjectsDashboard
          component={dashboard({
            projects: [
              { id: "p1", label: "aethon", path: "/repo/aethon" },
              { id: "p2", label: "koban", path: "/repo/koban" },
            ],
            recentSessions: [{ id: "local-session", label: "Ping" }],
            extraCards: [],
          })}
          state={{}}
          onEvent={() => {}}
        />
      </ExtensionRegistryProvider>,
    );

    expect(screen.getByLabelText("Task prompt")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Project" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Project" }).textContent,
    ).toContain("host");
    expect(screen.queryByRole("button", { name: "Workspace" })).toBeNull();
  });

  it("routes the host-level task launcher through the extension registry", () => {
    const registry = new ExtensionRegistry();
    registry.register({
      name: "test-task-launcher-override",
      components: {
        "task-launcher": ({ component }) => (
          <div data-testid="host-launcher-override">
            {String(component.props?.showProjectSelector)}
          </div>
        ),
        "project-card": () => <div />,
        "subagents-config": () => <div />,
      },
    });

    render(
      <ExtensionRegistryProvider registry={registry}>
        <ProjectsDashboard
          component={dashboard({
            projects: [
              { id: "p1", label: "aethon", path: "/repo/aethon" },
              { id: "p2", label: "koban", path: "/repo/koban" },
            ],
            recentSessions: [],
            extraCards: [],
          })}
          state={{}}
          onEvent={() => {}}
        />
      </ExtensionRegistryProvider>,
    );

    expect(screen.getByTestId("host-launcher-override").textContent).toBe(
      "true",
    );
  });

  it("hides the local open-project action on remote host overview", () => {
    const registry = new ExtensionRegistry();
    registry.register({
      name: "test-dashboard-components",
      components: {
        "task-launcher": TaskLauncher,
        "project-card": () => <div />,
        "subagents-config": () => <div />,
      },
    });

    render(
      <ExtensionRegistryProvider registry={registry}>
        <ProjectsDashboard
          component={dashboard({
            host: {
              id: "remote:fp",
              hostname: "bender.local",
              displayName: "bender",
              isLocal: false,
            },
            projects: [
              {
                id: "remote:fp::project::aethon",
                label: "aethon",
                path: "/remote/aethon",
              },
            ],
            recentSessions: [],
            extraCards: [],
          })}
          state={{}}
          onEvent={() => {}}
        />
      </ExtensionRegistryProvider>,
    );

    expect(screen.queryByRole("button", { name: "Open Project…" })).toBeNull();
    expect(screen.getByRole("button", { name: "New Tab" })).toBeTruthy();
    expect(screen.queryByText("Recent sessions")).toBeNull();
    expect(screen.queryByText("Ping")).toBeNull();
    expect(screen.queryByText("local subagents")).toBeNull();
  });

  it("renders paired remote host connection details on host overview", () => {
    const registry = new ExtensionRegistry();
    registry.register({
      name: "test-dashboard-components",
      components: {
        "task-launcher": TaskLauncher,
        "project-card": () => <div />,
        "subagents-config": () => <div />,
      },
    });

    render(
      <ExtensionRegistryProvider registry={registry}>
        <ProjectsDashboard
          component={dashboard({
            host: {
              id: "remote:fp",
              hostId: "local:bender",
              hostname: "bender.local",
              displayName: "bender",
              isLocal: false,
              paired: true,
              connected: false,
              discovered: true,
              createdAt: 1_700_000_000_000,
              lastSeen: 1_700_000_060_000,
              fingerprint: "abcdef1234567890",
              candidates: ["bender.local:4242", "192.168.1.44:4242"],
            },
            projects: [
              {
                id: "remote:fp::project::aethon",
                label: "aethon",
                path: "/remote/aethon",
              },
            ],
            recentSessions: [],
            extraCards: [],
          })}
          state={{}}
          onEvent={() => {}}
        />
      </ExtensionRegistryProvider>,
    );

    expect(screen.getByText("Remote host")).toBeTruthy();
    expect(screen.getByText("Paired")).toBeTruthy();
    expect(screen.getByText("Reachable on LAN")).toBeTruthy();
    expect(screen.getByText("Primary connection candidates")).toBeTruthy();
    expect(screen.getByText("bender.local:4242")).toBeTruthy();
    expect(screen.getByText("192.168.1.44:4242")).toBeTruthy();
    expect(screen.getByText("Host ID")).toBeTruthy();
    expect(screen.getByText("local:bender")).toBeTruthy();
    expect(screen.getByText("abcdef1234567890")).toBeTruthy();
  });

  it("keeps noisy IPv6 candidates collapsed behind raw details", () => {
    const registry = new ExtensionRegistry();
    registry.register({
      name: "test-dashboard-components",
      components: {
        "task-launcher": TaskLauncher,
        "project-card": () => <div />,
        "subagents-config": () => <div />,
      },
    });

    const { container } = render(
      <ExtensionRegistryProvider registry={registry}>
        <ProjectsDashboard
          component={dashboard({
            host: {
              id: "remote:fp",
              hostId: "local:bender",
              hostname: "bender.local",
              displayName: "bender",
              isLocal: false,
              paired: true,
              createdAt: 1_700_000_000_000,
              lastSeen: 1_700_000_060_000,
              fingerprint: "abcdef1234567890",
              candidates: [
                "aethon-fp.local:1111",
                "192.168.1.44:1111",
                "[fe80::1]:1111",
                "aethon-fp.local:2222",
                "192.168.1.44:2222",
                "[fe80::1]:2222",
              ],
            },
            projects: [],
            recentSessions: [],
            extraCards: [],
          })}
          state={{}}
          onEvent={() => {}}
        />
      </ExtensionRegistryProvider>,
    );

    const primary = container.querySelector(".a2ui-host-candidates--primary");
    expect(primary).toBeTruthy();
    expect(
      within(primary as HTMLElement).getByText("aethon-fp.local:2222"),
    ).toBeTruthy();
    expect(
      within(primary as HTMLElement).getByText("192.168.1.44:2222"),
    ).toBeTruthy();
    expect(
      within(primary as HTMLElement).queryByText("aethon-fp.local:1111"),
    ).toBeNull();
    expect(
      within(primary as HTMLElement).queryByText("[fe80::1]:2222"),
    ).toBeNull();
    expect(screen.getByText("Show 4 raw alternate candidates")).toBeTruthy();
  });

  it("copies host candidates when clicked", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const registry = new ExtensionRegistry();
    registry.register({
      name: "test-dashboard-components",
      components: {
        "task-launcher": TaskLauncher,
        "project-card": () => <div />,
        "subagents-config": () => <div />,
      },
    });

    render(
      <ExtensionRegistryProvider registry={registry}>
        <ProjectsDashboard
          component={dashboard({
            host: {
              id: "remote:fp",
              hostId: "local:bender",
              hostname: "bender.local",
              displayName: "bender",
              isLocal: false,
              paired: true,
              candidates: ["bender.local:4242"],
            },
            projects: [],
            recentSessions: [],
            extraCards: [],
          })}
          state={{}}
          onEvent={() => {}}
        />
      </ExtensionRegistryProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "bender.local:4242" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("bender.local:4242");
      expect(screen.getByText("Copied")).toBeTruthy();
    });
  });

  it("clears pending copied-candidate timers on unmount", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const registry = new ExtensionRegistry();
    registry.register({
      name: "test-dashboard-components",
      components: {
        "task-launcher": TaskLauncher,
        "project-card": () => <div />,
        "subagents-config": () => <div />,
      },
    });

    const { unmount } = render(
      <ExtensionRegistryProvider registry={registry}>
        <ProjectsDashboard
          component={dashboard({
            host: {
              id: "remote:fp",
              hostId: "local:bender",
              hostname: "bender.local",
              displayName: "bender",
              isLocal: false,
              paired: true,
              candidates: ["bender.local:4242"],
            },
            projects: [],
            recentSessions: [],
            extraCards: [],
          })}
          state={{}}
          onEvent={() => {}}
        />
      </ExtensionRegistryProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "bender.local:4242" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("explains when remote projects are still syncing", () => {
    const registry = new ExtensionRegistry();
    registry.register({
      name: "test-dashboard-components",
      components: {
        "task-launcher": TaskLauncher,
        "project-card": () => <div />,
        "subagents-config": () => <div />,
      },
    });

    render(
      <ExtensionRegistryProvider registry={registry}>
        <ProjectsDashboard
          component={dashboard({
            host: {
              id: "remote:fp",
              hostname: "bender.local",
              displayName: "bender",
              isLocal: false,
              paired: true,
              connected: true,
              projectStatus: { state: "syncing", updatedAt: 1 },
            },
            projects: [],
            recentSessions: [],
            extraCards: [],
          })}
          state={{}}
          onEvent={() => {}}
        />
      </ExtensionRegistryProvider>,
    );

    expect(screen.getByText("Syncing")).toBeTruthy();
    expect(screen.getByText("Loading remote projects")).toBeTruthy();
    expect(screen.getByText("Syncing remote projects")).toBeTruthy();
  });

  it("explains remote project snapshot failures", () => {
    const registry = new ExtensionRegistry();
    registry.register({
      name: "test-dashboard-components",
      components: {
        "task-launcher": TaskLauncher,
        "project-card": () => <div />,
        "subagents-config": () => <div />,
      },
    });

    render(
      <ExtensionRegistryProvider registry={registry}>
        <ProjectsDashboard
          component={dashboard({
            host: {
              id: "remote:fp",
              hostname: "bender.local",
              displayName: "bender",
              isLocal: false,
              paired: true,
              connected: true,
              projectStatus: {
                state: "error",
                error: "connect timeout wss://bender.local/ws",
                updatedAt: 1,
              },
            },
            projects: [],
            recentSessions: [],
            extraCards: [],
          })}
          state={{}}
          onEvent={() => {}}
        />
      </ExtensionRegistryProvider>,
    );

    expect(screen.getByText("Sync failed")).toBeTruthy();
    expect(screen.getByText("Remote project sync failed")).toBeTruthy();
    expect(screen.getByText("Remote projects unavailable")).toBeTruthy();
    expect(
      screen.getByText("connect timeout wss://bender.local/ws"),
    ).toBeTruthy();
  });

  it("shows recently seen remote hosts distinctly from stale paired hosts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-08T17:00:00Z"));
    const registry = new ExtensionRegistry();
    registry.register({
      name: "test-dashboard-components",
      components: {
        "task-launcher": TaskLauncher,
        "project-card": () => <div />,
        "subagents-config": () => <div />,
      },
    });

    render(
      <ExtensionRegistryProvider registry={registry}>
        <ProjectsDashboard
          component={dashboard({
            host: {
              id: "remote:fp",
              hostId: "local:bender",
              hostname: "bender.local",
              displayName: "bender",
              isLocal: false,
              paired: true,
              connected: false,
              discovered: false,
              createdAt: Date.parse("2026-07-02T20:30:00Z"),
              lastSeen: Date.parse("2026-07-08T16:59:30Z"),
              fingerprint: "abcdef1234567890",
              candidates: ["bender.local:4242"],
            },
            projects: [],
            recentSessions: [],
            extraCards: [],
          })}
          state={{}}
          onEvent={() => {}}
        />
      </ExtensionRegistryProvider>,
    );

    expect(screen.getByText("Recently seen on LAN")).toBeTruthy();
    expect(screen.queryByText("Not currently advertised")).toBeNull();
  });

  it("writes host-level startup auto-approve to global config", async () => {
    const registry = new ExtensionRegistry();
    registry.register({
      name: "test-dashboard-components",
      components: {
        "task-launcher": TaskLauncher,
        "project-card": () => <div />,
        "subagents-config": () => <div />,
      },
    });

    render(
      <ExtensionRegistryProvider registry={registry}>
        <ProjectsDashboard
          component={dashboard({
            host: {
              id: "local:halcyon",
              hostname: "halcyon",
              displayName: "halcyon",
              isLocal: true,
            },
            projects: [{ id: "p1", label: "aethon", path: "/repo/aethon" }],
            recentSessions: [],
            extraCards: [],
          })}
          state={{}}
          onEvent={() => {}}
        />
      </ExtensionRegistryProvider>,
    );

    const checkbox = screen.getByRole("checkbox", {
      name: /auto-approve startup commands on this host/i,
    });
    await waitFor(() => expect(checkbox.hasAttribute("disabled")).toBe(false));

    fireEvent.click(checkbox);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "write_config",
        expect.objectContaining({
          config: expect.objectContaining({
            startup: expect.objectContaining({ autoApprove: true }),
          }),
        }),
      ),
    );
    expect(checkbox).toHaveProperty("checked", true);
    const policy = checkbox.closest(".a2ui-project-dashboard-startup-policy");
    expect(policy).toBeTruthy();
    expect(
      policy?.querySelector(".a2ui-project-dashboard-startup-hint"),
    ).toBeTruthy();
  });
});
