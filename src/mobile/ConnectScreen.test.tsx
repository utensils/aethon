// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// Native runtime on: exercises the scan/nearby chrome. The barcode
// plugin never loads in tests — ScanOverlay is only mounted after a
// button press we don't make here.
vi.mock("../gateway/rustBridgeAdapter", () => ({
  isTauriRuntime: () => true,
}));

import { ConnectScreen } from "./ConnectScreen";

const DESKTOP = {
  id: "remote:ff",
  name: "halcyon",
  host: "192.168.1.142:48213",
  hostname: "halcyon.local",
  port: 48213,
  fingerprint: "ff".repeat(32),
  version: "0.11.2",
};

beforeEach(() => {
  invokeMock.mockReset();
  // useNearbyDesktops polls discovery_scan on mount.
  invokeMock.mockImplementation((cmd: string) =>
    cmd === "discovery_scan"
      ? Promise.resolve([DESKTOP])
      : Promise.reject(new Error(`unexpected ${cmd}`)),
  );
});

afterEach(cleanup);

describe("ConnectScreen", () => {
  it("keeps the manual path working unchanged", () => {
    const onConnect = vi.fn();
    render(<ConnectScreen initial={null} error={null} onConnect={onConnect} />);

    fireEvent.change(screen.getByPlaceholderText("192.168.1.10:48213"), {
      target: { value: "10.0.0.5:9000" },
    });
    fireEvent.change(screen.getByPlaceholderText("paste from pairing"), {
      target: { value: "tok-manual" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(onConnect).toHaveBeenCalledWith({
      host: "10.0.0.5:9000",
      token: "tok-manual",
      fingerprint: undefined,
    });
  });

  it("pairs a nearby desktop via the 8-digit code", async () => {
    const onConnect = vi.fn();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "discovery_scan") return Promise.resolve([DESKTOP]);
      if (cmd === "gateway_pair") {
        return Promise.resolve({
          deviceId: "dev-1",
          deviceToken: "tok-paired",
          hostDisplayName: "halcyon",
          hostFingerprint: DESKTOP.fingerprint,
        });
      }
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });

    render(<ConnectScreen initial={null} error={null} onConnect={onConnect} />);
    await waitFor(() => expect(screen.getByText("halcyon")).toBeDefined());

    fireEvent.click(screen.getByText("halcyon"));
    fireEvent.change(screen.getByPlaceholderText("8-digit code"), {
      target: { value: "12345678" },
    });

    await waitFor(() =>
      expect(onConnect).toHaveBeenCalledWith({
        host: "192.168.1.142:48213",
        token: "tok-paired",
        fingerprint: DESKTOP.fingerprint,
        name: "halcyon",
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith("gateway_pair", {
      host: "192.168.1.142:48213",
      fingerprint: DESKTOP.fingerprint,
      code: "12345678",
      deviceName: "iPhone",
    });
  });

  it("surfaces the expiry message when the pairing window lapsed", async () => {
    const onConnect = vi.fn();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "discovery_scan") return Promise.resolve([DESKTOP]);
      // Tauri invoke rejects with a plain string on the wire; Error
      // keeps eslint happy and classifyPairError unwraps .message.
      return Promise.reject(new Error("pair:410:pairing window expired"));
    });

    render(<ConnectScreen initial={null} error={null} onConnect={onConnect} />);
    await waitFor(() => expect(screen.getByText("halcyon")).toBeDefined());

    fireEvent.click(screen.getByText("halcyon"));
    fireEvent.change(screen.getByPlaceholderText("8-digit code"), {
      target: { value: "12345678" },
    });

    await waitFor(() => expect(screen.getByText(/Pairing window expired/)).toBeDefined());
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("offers remembered paired hosts for reconnect", () => {
    const onConnect = vi.fn();
    render(
      <ConnectScreen
        initial={null}
        remembered={[
          {
            host: "halcyon.local:48213",
            token: "tok-remembered",
            fingerprint: DESKTOP.fingerprint,
            name: "halcyon",
          },
        ]}
        error={null}
        onConnect={onConnect}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /halcyon/ }));

    expect(onConnect).toHaveBeenCalledWith({
      host: "halcyon.local:48213",
      token: "tok-remembered",
      fingerprint: DESKTOP.fingerprint,
      name: "halcyon",
    });
  });
});
