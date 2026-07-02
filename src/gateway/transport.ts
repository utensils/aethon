// Network transport for the mobile/companion surface. Replaces Tauri's
// in-process `invoke`/`listen` with a WebSocket to a paired desktop
// instance (wire protocol v1 — see src-tauri/src/server/remote/).
//
// Two socket backends sit behind one `SocketAdapter`:
//   - DirectWebSocketAdapter: a plain browser WebSocket. Used for the
//     browser dev loop and e2e; the desktop must run with
//     `[server] allow_insecure_ws = true` so it serves ws:// without a
//     cert the browser can't pin.
//   - RustBridgeAdapter: routes frames through the mobile shell's
//     `gateway_*` commands + `gateway-frame` event, so the real socket
//     (wss:// with a pinned self-signed cert) is opened in Rust, where
//     ATS doesn't apply. Selected at runtime when running in Tauri.
//
// The transport owns correlation, reconnect-with-backoff, and
// ref-counted resubscription. Requests fail fast when disconnected — a
// silent offline queue could double-send a turn into the agent.

export type GatewayStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export interface HelloOk {
  protocol: number;
  host: { displayName: string; fingerprint: string };
  deviceId: string;
  appVersion: string;
}

export interface GatewayConfig {
  url: string;
  token: string;
  /** Override the socket backend; defaults to Rust-bridge in Tauri,
   *  direct WebSocket otherwise. */
  adapter?: SocketAdapter;
  /** Client app version reported in the hello frame. */
  appVersion?: string;
}

/** Abstract socket: send text frames, receive text frames, observe
 *  open/close. The transport never touches a raw WebSocket directly. */
export interface SocketAdapter {
  open(url: string): void;
  send(text: string): void;
  close(): void;
  onMessage(handler: (text: string) => void): void;
  onOpen(handler: () => void): void;
  onClose(handler: () => void): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Serialized invoke frame, kept for rate-limited re-sends. */
  frame: string;
  /** Rate-limited re-send count so far. */
  attempts: number;
}

type EventHandler = (payload: unknown) => void;
type StatusListener = (status: GatewayStatus) => void;

const DEFAULT_TIMEOUT_MS = 30_000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 30_000;
/** Client-side invoke budget per rolling second. Deliberate headroom
 *  under the server's 40/s fixed window (`allow_invoke` in ws.rs) —
 *  the two windows don't align, so 32 absorbs the phase offset. Boot
 *  fires a burst of invokes well past 40; without pacing the excess
 *  came back "rate limited" and startup data was silently dropped. */
const CLIENT_RATE_MAX = 32;
const CLIENT_RATE_WINDOW_MS = 1_000;
/** Rate-limited retry: the server rejects BEFORE `relay.invoke` runs,
 *  so the command never executed and a same-id re-send is safe — even
 *  for non-idempotent commands like send_message. */
const RATE_RETRY_BASE_MS = 250;
const RATE_RETRY_MAX_ATTEMPTS = 3;
/** How long a connection must survive before the reconnect backoff
 *  resets. Resetting on hello_ok alone let a server-side slow-consumer
 *  kick loop reconnect at the minimum delay forever (connect → kicked
 *  seconds later → connect …), hammering a host that is already
 *  overloaded. */
const BACKOFF_STABLE_MS = 15_000;

export class GatewayOfflineError extends Error {
  constructor(cmd: string) {
    super(`gateway offline: ${cmd}`);
    this.name = "GatewayOfflineError";
  }
}

export class GatewayTransport {
  private config: GatewayConfig | null = null;
  private adapter: SocketAdapter | null = null;
  private status: GatewayStatus = "idle";
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private subscriptions = new Map<string, Set<EventHandler>>();
  private statusListeners = new Set<StatusListener>();
  private reconnectHooks = new Set<() => void>();
  private helloResolve: ((hello: HelloOk) => void) | null = null;
  private helloReject: ((err: Error) => void) | null = null;
  private lastHello: HelloOk | null = null;
  private backoffMs = BACKOFF_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private wantConnected = false;
  /** Socket generation. Each openSocket() supersedes every previous
   *  socket: callbacks captured by older generations are ignored, so a
   *  half-open or half-dead socket can't double-deliver events or kill
   *  a fresh connection with its own close. */
  private generation = 0;
  /** FIFO of invoke frames awaiting a rate-budget slot. Only the
   *  physical send is paced — `request()` semantics (fail fast when
   *  offline, timeout from call time) are unchanged. sub/unsub/hello
   *  frames bypass the queue; only invoke frames are rate-limited
   *  server-side. Entries carry their id so a request that timed out
   *  while queued is dropped at drain time instead of executing after
   *  its caller already saw the failure. */
  private sendQueue: Array<{ id: string; frame: string }> = [];
  /** Send timestamps inside the rolling rate window. */
  private sentAt: number[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimers = new Set<ReturnType<typeof setTimeout>>();

  configure(config: GatewayConfig): void {
    this.config = config;
  }

  getStatus(): GatewayStatus {
    return this.status;
  }

  getHello(): HelloOk | null {
    return this.lastHello;
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Register a callback that runs after each successful (re)connect —
   *  the mobile gate re-invokes `start_agent` here to re-hydrate. */
  onReconnect(hook: () => void): () => void {
    this.reconnectHooks.add(hook);
    return () => this.reconnectHooks.delete(hook);
  }

  /** Open the socket and resolve once the hello handshake is accepted. */
  connect(): Promise<HelloOk> {
    if (!this.config) throw new Error("gateway not configured");
    this.wantConnected = true;
    return new Promise<HelloOk>((resolve, reject) => {
      this.helloResolve = resolve;
      this.helloReject = reject;
      this.openSocket();
    });
  }

  disconnect(): void {
    this.wantConnected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    // Deterministic even when the adapter's close event is async.
    this.clearRatePacing();
    // Reject an in-flight connect() so its awaiter doesn't hang forever,
    // and so a later reconnect can't resolve this abandoned attempt.
    if (this.helloReject) {
      this.helloReject(new Error("gateway disconnected"));
      this.helloReject = null;
      this.helloResolve = null;
    }
    this.adapter?.close();
    this.setStatus("idle");
  }

  request<T = unknown>(
    cmd: string,
    args: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.status !== "connected" || !this.adapter) {
      return Promise.reject(new GatewayOfflineError(cmd));
    }
    const id = `i-${this.nextId++}`;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway request timed out: ${cmd}`));
      }, timeoutMs);
      const frame = JSON.stringify({ t: "invoke", id, cmd, args });
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        frame,
        attempts: 0,
      });
      this.enqueueInvoke(id, frame);
    });
  }

  /** Send an invoke frame through the client-side rate budget: send
   *  immediately when under budget (the common case — zero added
   *  latency), otherwise queue FIFO and drain when the window frees. */
  private enqueueInvoke(id: string, frame: string): void {
    this.sendQueue.push({ id, frame });
    this.drainSendQueue();
  }

  private drainSendQueue(): void {
    if (this.status !== "connected" || !this.adapter) return;
    const now = Date.now();
    while (
      this.sentAt.length > 0 &&
      this.sentAt[0] <= now - CLIENT_RATE_WINDOW_MS
    ) {
      this.sentAt.shift();
    }
    while (this.sendQueue.length > 0 && this.sentAt.length < CLIENT_RATE_MAX) {
      const next = this.sendQueue.shift();
      if (next === undefined) break;
      // Timed out (or rejected at close) while queued — never send:
      // a non-idempotent command must not execute after its caller
      // already received the failure.
      if (!this.pending.has(next.id)) continue;
      this.sentAt.push(now);
      this.adapter.send(next.frame);
    }
    if (this.sendQueue.length > 0 && this.drainTimer === null) {
      const wait = Math.max(
        this.sentAt[0] + CLIENT_RATE_WINDOW_MS - now,
        10,
      );
      this.drainTimer = setTimeout(() => {
        this.drainTimer = null;
        this.drainSendQueue();
      }, wait);
    }
  }

  /** Drop all rate-pacing state. Runs on every close/disconnect so a
   *  stale drain or retry timer can never write into a superseded
   *  socket (the zombie-socket class of bug). */
  private clearRatePacing(): void {
    this.sendQueue.length = 0;
    this.sentAt.length = 0;
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
  }

  subscribe(topic: string, handler: EventHandler): () => void {
    let handlers = this.subscriptions.get(topic);
    const isFirst = !handlers || handlers.size === 0;
    if (!handlers) {
      handlers = new Set();
      this.subscriptions.set(topic, handlers);
    }
    handlers.add(handler);
    if (isFirst && this.status === "connected") {
      this.adapter?.send(JSON.stringify({ t: "sub", topics: [topic] }));
    }
    return () => {
      const set = this.subscriptions.get(topic);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) {
        this.subscriptions.delete(topic);
        if (this.status === "connected") {
          this.adapter?.send(JSON.stringify({ t: "unsub", topics: [topic] }));
        }
      }
    };
  }

  private openSocket(): void {
    if (!this.config) return;
    // Supersede any previous socket BEFORE wiring the new one. Without
    // this, a stacked reconnect left the old socket's handlers attached
    // — every event frame was then delivered once per zombie socket
    // (the mobile text-duplication bug), and the zombie's eventual
    // close event tore down the healthy connection.
    //
    // A reused adapter instance (RustBridgeAdapter) is NOT closed here:
    // its open() already replaces the frame listener, and the native
    // gateway_connect supersedes the old socket. Racing an async
    // gateway_close against the follow-up gateway_connect could tear
    // down the fresh connection instead of the stale one.
    const gen = ++this.generation;
    const adapter = this.config.adapter ?? defaultAdapter();
    if (this.adapter && this.adapter !== adapter) this.adapter.close();
    this.adapter = adapter;
    this.setStatus(this.lastHello ? "reconnecting" : "connecting");

    adapter.onOpen(() => {
      if (gen !== this.generation) return;
      adapter.send(
        JSON.stringify({
          t: "hello",
          protocol: 1,
          token: this.config?.token ?? "",
          deviceId: "companion",
          appVersion: this.config?.appVersion ?? "companion",
        }),
      );
    });
    adapter.onMessage((text) => {
      if (gen !== this.generation) return;
      this.handleFrame(text);
    });
    adapter.onClose(() => {
      if (gen !== this.generation) return;
      this.handleClose();
    });
    adapter.open(this.config.url);
  }

  private handleFrame(text: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (frame.t) {
      case "hello_ok": {
        const hello = frame as unknown as HelloOk;
        this.lastHello = hello;
        // Backoff resets only once the link proves stable — see
        // BACKOFF_STABLE_MS.
        if (this.stableTimer) clearTimeout(this.stableTimer);
        this.stableTimer = setTimeout(() => {
          this.stableTimer = null;
          this.backoffMs = BACKOFF_MIN_MS;
        }, BACKOFF_STABLE_MS);
        this.setStatus("connected");
        this.resubscribeAll();
        this.helloResolve?.(hello);
        this.helloResolve = null;
        this.helloReject = null;
        for (const hook of this.reconnectHooks) hook();
        break;
      }
      case "result": {
        const id = frame.id as string;
        const entry = this.pending.get(id);
        if (!entry) break;
        if (!frame.ok) {
          const message = String(frame.error ?? "invoke failed");
          if (
            message.startsWith("rate limited") &&
            entry.attempts < RATE_RETRY_MAX_ATTEMPTS
          ) {
            // The server rejected BEFORE executing — re-send the same
            // frame (same id; the server doesn't track ids) after a
            // short backoff. The request's own timeout keeps running
            // as the overall cap; close rejects it like any pending.
            entry.attempts += 1;
            const timer = setTimeout(() => {
              this.retryTimers.delete(timer);
              if (this.pending.has(id)) this.enqueueInvoke(id, entry.frame);
            }, RATE_RETRY_BASE_MS * entry.attempts);
            this.retryTimers.add(timer);
            break;
          }
        }
        this.pending.delete(id);
        clearTimeout(entry.timer);
        if (frame.ok) entry.resolve(frame.data);
        else entry.reject(new Error((frame.error as string) ?? "invoke failed"));
        break;
      }
      case "event": {
        const topic = frame.topic as string;
        const handlers = this.subscriptions.get(topic);
        if (handlers) for (const handler of handlers) handler(frame.payload);
        break;
      }
      case "bye": {
        const reason = String(frame.reason ?? "closed");
        // Auth/protocol failures are terminal — don't spin reconnecting.
        if (reason === "auth-failed" || reason === "protocol-unsupported") {
          this.wantConnected = false;
          this.helloReject?.(new Error(`gateway rejected: ${reason}`));
          this.helloReject = null;
          this.helloResolve = null;
        }
        this.adapter?.close();
        break;
      }
    }
  }

  private handleClose(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    this.clearRatePacing();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("gateway connection closed"));
    }
    this.pending.clear();
    if (!this.wantConnected) {
      this.setStatus("idle");
      return;
    }
    this.setStatus("disconnected");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const jitter = 0.8 + fractionalJitter();
    const delay = Math.min(this.backoffMs * jitter, BACKOFF_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wantConnected) this.openSocket();
    }, delay);
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
  }

  /** Prompt an immediate reconnect (e.g. on app foreground) instead of
   *  waiting out the backoff. */
  reconnectNow(): void {
    if (!this.wantConnected || this.status === "connected") return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.backoffMs = BACKOFF_MIN_MS;
    this.openSocket();
  }

  private resubscribeAll(): void {
    const topics = [...this.subscriptions.keys()];
    if (topics.length > 0) this.adapter?.send(JSON.stringify({ t: "sub", topics }));
  }

  private setStatus(status: GatewayStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

/** Deterministic-friendly jitter source. Overridable in tests; falls
 *  back to Math.random in the browser. */
let jitterSource: () => number = () => Math.random() * 0.4;
export function setJitterSource(fn: () => number): void {
  jitterSource = fn;
}
function fractionalJitter(): number {
  return jitterSource();
}

/** Browser WebSocket backend. */
export class DirectWebSocketAdapter implements SocketAdapter {
  private ws: WebSocket | null = null;
  private messageHandler: (text: string) => void = () => {};
  private openHandler: () => void = () => {};
  private closeHandler: () => void = () => {};

  open(url: string): void {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("open", () => this.openHandler());
    this.ws.addEventListener("message", (ev) => this.messageHandler(String(ev.data)));
    this.ws.addEventListener("close", () => this.closeHandler());
    this.ws.addEventListener("error", () => this.ws?.close());
  }
  send(text: string): void {
    this.ws?.send(text);
  }
  close(): void {
    this.ws?.close();
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

function defaultAdapter(): SocketAdapter {
  return new DirectWebSocketAdapter();
}

/** The process-wide transport the shims talk to. */
export const gateway = new GatewayTransport();
