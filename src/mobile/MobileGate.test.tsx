// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MobileConnection } from "./mobileConnection";

// MobileGate imports `setAssetBase` straight from the tauriCoreShim
// module, which re-exports `@tauri-real/core` — a Vite alias only
// vite.mobile.config.ts defines. Mock it away so the test doesn't need
// that alias wired into the desktop vitest config.
const setAssetBaseMock = vi.fn();
vi.mock("../gateway/tauriCoreShim", () => ({
  setAssetBase: (...args: unknown[]) => setAssetBaseMock(...args),
}));

// Native runtime off: keeps ConnectScreen's nearby-desktop scan
// (useNearbyDesktops) disabled, so the test doesn't also need to stub
// `@tauri-apps/api/core`'s `invoke("discovery_scan")`.
vi.mock("../gateway/rustBridgeAdapter", () => ({
  isTauriRuntime: () => false,
  RustBridgeAdapter: class {},
}));

const gatewayConfigure = vi.fn();
const gatewayConnect = vi.fn();
const gatewaySubscribe = vi.fn((..._args: unknown[]) => () => {});
const gatewaySubscribeStatus = vi.fn((..._args: unknown[]) => () => {});
const gatewayGetStatus = vi.fn(() => "idle");
const gatewayGetHello = vi.fn(() => null);
const gatewayReconnectNow = vi.fn();
const gatewayDisconnect = vi.fn();
vi.mock("../gateway/transport", () => ({
  gateway: {
    configure: (...args: unknown[]) => gatewayConfigure(...args),
    connect: (...args: unknown[]) => gatewayConnect(...args),
    subscribe: (...args: unknown[]) => gatewaySubscribe(...args),
    subscribeStatus: (...args: unknown[]) => gatewaySubscribeStatus(...args),
    getStatus: () => gatewayGetStatus(),
    getHello: () => gatewayGetHello(),
    reconnectNow: (...args: unknown[]) => gatewayReconnectNow(...args),
    disconnect: (...args: unknown[]) => gatewayDisconnect(...args),
  },
}));

const loadConnectionMock = vi.fn<() => MobileConnection | null>(() => null);
const loadRememberedConnectionsMock = vi.fn<() => MobileConnection[]>(() => []);
const saveConnectionMock = vi.fn();
const clearConnectionMock = vi.fn();
vi.mock("./mobileConnection", () => ({
  loadConnection: () => loadConnectionMock(),
  loadRememberedConnections: () => loadRememberedConnectionsMock(),
  saveConnection: (...args: unknown[]) => saveConnectionMock(...args),
  clearConnection: (...args: unknown[]) => clearConnectionMock(...args),
  connectionUrl: (c: MobileConnection) =>
    `${c.fingerprint ? "wss" : "ws"}://${c.host}/ws`,
}));

// D5: App is loaded via a memoized `import("../App")`, not a static
// import — mocked here with an async factory so the module itself only
// resolves after a tick, exercising the Suspense boundary the gate wraps
// it in once phase === "connected".
vi.mock("../App", async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  return {
    default: function MockApp() {
      return <div data-testid="mock-app">mock app</div>;
    },
  };
});

import { MobileGate } from "./MobileGate";

const CONNECTION: MobileConnection = {
  host: "192.168.1.50:48213",
  token: "tok-1",
  name: "halcyon",
};

beforeEach(() => {
  vi.clearAllMocks();
  loadConnectionMock.mockReturnValue(null);
  loadRememberedConnectionsMock.mockReturnValue([]);
  gatewayGetStatus.mockReturnValue("idle");
});

afterEach(cleanup);

describe("MobileGate", () => {
  it("renders ConnectScreen when there's no saved connection", () => {
    render(<MobileGate />);

    expect(screen.getByPlaceholderText("192.168.1.10:48213")).toBeDefined();
    expect(screen.queryByTestId("mock-app")).toBeNull();
  });

  it("shows the connecting spinner while the saved-host handshake is pending", async () => {
    loadConnectionMock.mockReturnValue(CONNECTION);
    let resolveConnect!: (value: unknown) => void;
    gatewayConnect.mockReturnValue(
      new Promise((resolve) => {
        resolveConnect = resolve;
      }),
    );

    render(<MobileGate />);

    // Initial phase already reflects the saved connection, so the
    // spinner is up before any effect runs.
    expect(screen.getByText(/Connecting to 192\.168\.1\.50:48213/)).toBeDefined();

    // The mount effect's queued connect() call reaches gateway.connect()
    // and then suspends on our still-pending promise.
    await waitFor(() => expect(gatewayConnect).toHaveBeenCalled());
    expect(screen.getByText(/Connecting to 192\.168\.1\.50:48213/)).toBeDefined();
    expect(screen.queryByTestId("mock-app")).toBeNull();

    // Clean up the pending handshake so it doesn't leak into the next test.
    await act(async () => {
      resolveConnect(undefined);
      await Promise.resolve();
    });
  });

  it("mounts the (mocked) App once the handshake resolves", async () => {
    loadConnectionMock.mockReturnValue(CONNECTION);
    let resolveConnect!: (value: unknown) => void;
    gatewayConnect.mockReturnValue(
      new Promise((resolve) => {
        resolveConnect = resolve;
      }),
    );

    render(<MobileGate />);
    await waitFor(() => expect(gatewayConnect).toHaveBeenCalled());

    await act(async () => {
      resolveConnect(undefined);
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId("mock-app")).toBeDefined());
  });
});
