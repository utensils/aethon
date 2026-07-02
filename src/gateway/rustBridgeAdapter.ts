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
// The adapter calls the *real* Tauri runtime (not the aliased invoke),
// so this file must import from @tauri-apps/api directly — the mobile
// Vite alias does not rewrite these because they are only ever used from
// the shell's own commands, and the adapter is selected before the shim
// is active.

import type { SocketAdapter } from "./transport";

interface TauriInternals {
  invoke: (cmd: string, args?: unknown) => Promise<unknown>;
}
interface TauriEventApi {
  listen: (
    event: string,
    handler: (e: { payload: unknown }) => void,
  ) => Promise<() => void>;
}

function internals(): TauriInternals | undefined {
  return (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
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
  private readonly eventApi: TauriEventApi;

  constructor(fingerprint: string, eventApi: TauriEventApi) {
    this.fingerprint = fingerprint;
    this.eventApi = eventApi;
  }

  open(url: string): void {
    const runtime = internals();
    if (!runtime) {
      this.closeHandler();
      return;
    }
    void this.eventApi
      .listen("gateway-frame", (e) => {
        const frame = e.payload as GatewayFrame;
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
