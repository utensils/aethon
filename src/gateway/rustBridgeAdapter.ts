// Socket backend that routes frames through the mobile shell's Rust
// gateway, so the real wss:// socket — with a pinned self-signed cert —
// is opened natively (tokio-tungstenite + rustls), bypassing WKWebView's
// App Transport Security, which would otherwise block a self-signed cert
// and offers no JS pinning API.
//
// Contract with `apps/mobile/src-tauri` (the `gateway_*` commands +
// `gateway-frame` event):
//   invoke("gateway_connect", { url, fingerprint }) -> ()  // opens the socket
//   invoke("gateway_send", { text }) -> ()                 // one text frame up
//   invoke("gateway_close") -> ()
//   event "gateway-frame" { kind: "open" | "message" | "close", text? }
//
// Uses the *real* Tauri runtime: `@tauri-real/event` (a dedicated
// tsconfig path + mobile Vite alias) resolves to the genuine event
// module rather than the gateway-routing shim, and invoke goes straight
// to `window.__TAURI_INTERNALS__` so it never loops through the shim.

import { listen } from "@tauri-real/event";

import type { SocketAdapter } from "./transport";

interface TauriInternals {
  invoke: (cmd: string, args?: unknown) => Promise<unknown>;
}

function internals(): TauriInternals | undefined {
  return (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
}

/** True when a Tauri runtime is present (mobile shell); false in a
 *  plain browser (dev loop), where the direct WebSocket adapter is used
 *  instead. */
export function isTauriRuntime(): boolean {
  return internals() !== undefined;
}

interface GatewayFrame {
  kind: "open" | "message" | "close";
  text?: string;
}

export class RustBridgeAdapter implements SocketAdapter {
  private messageHandler: (text: string) => void = () => {};
  private openHandler: () => void = () => {};
  private closeHandler: () => void = () => {};
  private unlisten: (() => void) | null = null;
  private readonly fingerprint: string;

  constructor(fingerprint: string) {
    this.fingerprint = fingerprint;
  }

  open(url: string): void {
    const runtime = internals();
    if (!runtime) {
      this.closeHandler();
      return;
    }
    void listen<GatewayFrame>("gateway-frame", (e) => {
      const frame = e.payload;
      if (frame.kind === "open") this.openHandler();
      else if (frame.kind === "message" && frame.text) this.messageHandler(frame.text);
      else if (frame.kind === "close") this.closeHandler();
    })
      .then((fn) => {
        this.unlisten = fn;
        return runtime.invoke("gateway_connect", { url, fingerprint: this.fingerprint });
      })
      .catch(() => this.closeHandler());
  }

  send(text: string): void {
    void internals()?.invoke("gateway_send", { text });
  }

  close(): void {
    this.unlisten?.();
    this.unlisten = null;
    void internals()?.invoke("gateway_close");
  }

  onMessage(handler: (text: string) => void): void {
    this.messageHandler = handler;
  }
  onOpen(handler: () => void): void {
    this.openHandler = handler;
  }
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }
}
