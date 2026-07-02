import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GatewayOfflineError,
  GatewayTransport,
  setJitterSource,
  type SocketAdapter,
} from "./transport";

/** Scriptable in-memory socket: records frames the transport sends and
 *  lets the test push server frames back. */
class FakeSocket implements SocketAdapter {
  sent: string[] = [];
  private messageHandler: (text: string) => void = () => {};
  private openHandler: () => void = () => {};
  private closeHandler: () => void = () => {};
  opened = 0;

  open(): void {
    this.opened += 1;
    // Simulate async connect.
    queueMicrotask(() => this.openHandler());
  }
  send(text: string): void {
    this.sent.push(text);
  }
  close(): void {
    this.closeHandler();
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

  // Test helpers.
  serverSend(frame: object): void {
    this.messageHandler(JSON.stringify(frame));
  }
  helloOk(): void {
    this.serverSend({
      t: "hello_ok",
      protocol: 1,
      host: { displayName: "test", fingerprint: "f" },
      deviceId: "dev-1",
      appVersion: "0.1",
    });
  }
  drop(): void {
    this.closeHandler();
  }
  lastSent(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1]) as Record<string, unknown>;
  }
  sentTypes(): string[] {
    return this.sent.map((s) => (JSON.parse(s) as { t: string }).t);
  }
  /** Id of the nth invoke frame the transport has sent. */
  lastSentInvokeId(index: number): string {
    const invokes = this.sent
      .map((s) => JSON.parse(s) as { t: string; id?: string })
      .filter((f) => f.t === "invoke");
    return invokes[index]?.id ?? "";
  }
}

function makeTransport(socket: FakeSocket): GatewayTransport {
  const t = new GatewayTransport();
  t.configure({ url: "ws://localhost/ws", token: "tok", adapter: socket });
  return t;
}

describe("gateway transport", () => {
  beforeEach(() => {
    setJitterSource(() => 0.2); // deterministic backoff
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends hello on open and resolves connect on hello_ok", async () => {
    const socket = new FakeSocket();
    const t = makeTransport(socket);
    const connected = t.connect();
    await Promise.resolve(); // let the open microtask run
    expect(socket.lastSent()).toMatchObject({ t: "hello", token: "tok" });
    socket.helloOk();
    const hello = await connected;
    expect(hello.deviceId).toBe("dev-1");
    expect(t.getStatus()).toBe("connected");
  });

  it("correlates invoke results by id", async () => {
    const socket = new FakeSocket();
    const t = makeTransport(socket);
    const connected = t.connect();
    await Promise.resolve();
    socket.helloOk();
    await connected;

    const p1 = t.request("host_info");
    const p2 = t.request("read_state", { name: "projects" });
    const id1 = socket.lastSentInvokeId(0);
    const id2 = socket.lastSentInvokeId(1);
    // Answer out of order.
    socket.serverSend({ t: "result", id: id2, ok: true, data: { name: "projects" } });
    socket.serverSend({ t: "result", id: id1, ok: true, data: { host: "x" } });
    await expect(p1).resolves.toEqual({ host: "x" });
    await expect(p2).resolves.toEqual({ name: "projects" });
  });

  it("rejects a request when disconnected (fail fast, no queue)", async () => {
    const socket = new FakeSocket();
    const t = makeTransport(socket);
    await expect(t.request("host_info")).rejects.toBeInstanceOf(GatewayOfflineError);
  });

  it("rejects on error results and times out stragglers", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const t = makeTransport(socket);
    const connected = t.connect();
    await vi.advanceTimersByTimeAsync(0);
    socket.helloOk();
    await connected;

    const bad = t.request("write_state");
    // Attach the rejection handler before triggering it, so the
    // rejection is never momentarily unhandled under fake timers.
    const badAssertion = expect(bad).rejects.toThrow("denied: nope");
    const badId = socket.lastSentInvokeId(0);
    socket.serverSend({ t: "result", id: badId, ok: false, error: "denied: nope" });
    await badAssertion;

    const straggler = t.request("host_info", {}, { timeoutMs: 1000 });
    const stragglerAssertion = expect(straggler).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(1000);
    await stragglerAssertion;
  });

  it("delivers subscribed events and stops after unsubscribe", async () => {
    const socket = new FakeSocket();
    const t = makeTransport(socket);
    const connected = t.connect();
    await Promise.resolve();
    socket.helloOk();
    await connected;

    const seen: unknown[] = [];
    const unsub = t.subscribe("agent-response", (payload) => seen.push(payload));
    expect(socket.lastSent()).toMatchObject({ t: "sub", topics: ["agent-response"] });
    socket.serverSend({ t: "event", topic: "agent-response", seq: 1, payload: "hi" });
    socket.serverSend({ t: "event", topic: "other", seq: 1, payload: "nope" });
    expect(seen).toEqual(["hi"]);

    unsub();
    expect(socket.lastSent()).toMatchObject({ t: "unsub", topics: ["agent-response"] });
    socket.serverSend({ t: "event", topic: "agent-response", seq: 2, payload: "after" });
    expect(seen).toEqual(["hi"]);
  });

  it("resubscribes and fires onReconnect after a drop", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const t = makeTransport(socket);
    const connected = t.connect();
    await vi.advanceTimersByTimeAsync(0);
    socket.helloOk();
    await connected;

    t.subscribe("agent-response", () => {});
    const reconnected = vi.fn();
    t.onReconnect(reconnected);

    socket.drop();
    expect(t.getStatus()).toBe("disconnected");
    // Backoff (500ms * 0.2 jitter-adjusted) then reopen.
    await vi.advanceTimersByTimeAsync(600);
    expect(socket.opened).toBe(2);
    await vi.advanceTimersByTimeAsync(0);
    socket.helloOk();
    await Promise.resolve();

    expect(t.getStatus()).toBe("connected");
    expect(reconnected).toHaveBeenCalled();
    // The single batched resub carries the still-active topic.
    const subFrame = socket.sent
      .map((s) => JSON.parse(s) as { t: string; topics?: string[] })
      .reverse()
      .find((f) => f.t === "sub");
    expect(subFrame?.topics).toContain("agent-response");
  });

  it("rejects an in-flight connect() on disconnect()", async () => {
    const socket = new FakeSocket();
    const t = makeTransport(socket);
    const connected = t.connect();
    const assertion = expect(connected).rejects.toThrow("disconnected");
    // Never send hello_ok; disconnect while the handshake is pending.
    t.disconnect();
    await assertion;
    expect(t.getStatus()).toBe("idle");
  });

  it("keeps escalating backoff when connections die young (slow-consumer kick loop)", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const t = makeTransport(socket);
    const connected = t.connect();
    await vi.advanceTimersByTimeAsync(0);
    socket.helloOk();
    await connected;

    // Kicked right after connecting — inside the stability window, so
    // hello_ok must NOT have reset the backoff. Pre-fix this looped a
    // kicked client back into an overloaded host every ~500ms forever.
    socket.drop();
    await vi.advanceTimersByTimeAsync(500); // first retry: 500ms base
    expect(socket.opened).toBe(2);
    await vi.advanceTimersByTimeAsync(0);
    socket.helloOk();
    socket.drop(); // kicked again, still young
    await vi.advanceTimersByTimeAsync(600);
    expect(socket.opened).toBe(2); // escalated to 1000ms — not due yet
    await vi.advanceTimersByTimeAsync(500);
    expect(socket.opened).toBe(3);
  });

  it("resets backoff once a connection survives the stability window", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const t = makeTransport(socket);
    const connected = t.connect();
    await vi.advanceTimersByTimeAsync(0);
    socket.helloOk();
    await connected;

    // Escalate the backoff with one young death…
    socket.drop();
    await vi.advanceTimersByTimeAsync(500);
    expect(socket.opened).toBe(2);
    await vi.advanceTimersByTimeAsync(0);
    socket.helloOk();
    // …then stay connected through the stability window.
    await vi.advanceTimersByTimeAsync(15_000);
    socket.drop();
    // Backoff is back at the 500ms minimum, not the escalated 1000ms.
    await vi.advanceTimersByTimeAsync(500);
    expect(socket.opened).toBe(3);
  });

  it("does not reconnect after an auth-failed bye", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const t = makeTransport(socket);
    const connected = t.connect();
    const rejectAssertion = expect(connected).rejects.toThrow("auth-failed");
    await vi.advanceTimersByTimeAsync(0);
    socket.serverSend({ t: "bye", reason: "auth-failed" });
    await rejectAssertion;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.opened).toBe(1); // never retried
  });
});

describe("invoke rate pacing + rate-limited retry", () => {
  async function connectTransport(
    socket: FakeSocket,
  ): Promise<GatewayTransport> {
    const t = makeTransport(socket);
    const connected = t.connect();
    await Promise.resolve();
    socket.helloOk();
    await connected;
    return t;
  }

  function sentInvokes(socket: FakeSocket): Array<{ id: string; cmd: string }> {
    return socket.sent
      .map((s) => JSON.parse(s) as { t: string; id: string; cmd: string })
      .filter((f) => f.t === "invoke");
  }

  beforeEach(() => {
    setJitterSource(() => 0.2);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("paces a burst to the client budget and drains FIFO", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const t = await connectTransport(socket);

    for (let i = 0; i < 50; i++) {
      void t.request(`cmd_${i}`).catch(() => {});
    }
    const immediate = sentInvokes(socket);
    expect(immediate).toHaveLength(32);
    expect(immediate[0].cmd).toBe("cmd_0");
    expect(immediate[31].cmd).toBe("cmd_31");

    // The rest drain once the rolling window frees up, still in order.
    await vi.advanceTimersByTimeAsync(1_100);
    const all = sentInvokes(socket);
    expect(all).toHaveLength(50);
    expect(all[49].cmd).toBe("cmd_49");
  });

  it("re-sends the same frame after a rate-limited result and resolves on success", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const t = await connectTransport(socket);

    const p = t.request("git_status", { root: "/r" });
    const id = socket.lastSentInvokeId(0);
    socket.serverSend({
      t: "result",
      id,
      ok: false,
      error: "rate limited: too many requests, retry shortly",
    });
    await vi.advanceTimersByTimeAsync(260);

    const invokes = sentInvokes(socket);
    expect(invokes).toHaveLength(2);
    // Same id — the server rejected before executing, so a re-send is
    // a fresh attempt, not a duplicate.
    expect(invokes[1].id).toBe(id);
    expect(invokes[1].cmd).toBe("git_status");

    socket.serverSend({ t: "result", id, ok: true, data: { branch: "main" } });
    await expect(p).resolves.toEqual({ branch: "main" });
  });

  it("gives up after exhausting rate-limit retries", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const t = await connectTransport(socket);

    const p = t.request("git_status");
    const settled = p.catch((err: Error) => err);
    const id = socket.lastSentInvokeId(0);
    for (const advance of [260, 520, 780]) {
      socket.serverSend({ t: "result", id, ok: false, error: "rate limited: x" });
      await vi.advanceTimersByTimeAsync(advance);
    }
    expect(sentInvokes(socket)).toHaveLength(4);
    // Fourth rejection: attempts exhausted — surfaces the error.
    socket.serverSend({ t: "result", id, ok: false, error: "rate limited: x" });
    const err = await settled;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("rate limited");
  });

  it("non-rate-limit errors reject immediately without a re-send", async () => {
    const socket = new FakeSocket();
    const t = await connectTransport(socket);

    const p = t.request("git_status");
    const id = socket.lastSentInvokeId(0);
    socket.serverSend({ t: "result", id, ok: false, error: "boom" });
    await expect(p).rejects.toThrow("boom");
    expect(sentInvokes(socket)).toHaveLength(1);
  });

  it("clears the queue on close: nothing leaks into the next connection", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const t = await connectTransport(socket);

    const outcomes: Array<Promise<unknown>> = [];
    for (let i = 0; i < 40; i++) {
      outcomes.push(t.request(`cmd_${i}`).catch((err: Error) => err.message));
    }
    expect(sentInvokes(socket)).toHaveLength(32);

    // Connection drops with 8 frames still queued.
    socket.close();
    for (const outcome of outcomes.slice(32)) {
      await expect(outcome).resolves.toBe("gateway connection closed");
    }

    // Reconnect (same adapter instance). The queued frames must NOT be
    // replayed into the fresh socket.
    await vi.advanceTimersByTimeAsync(2_000);
    socket.helloOk();
    expect(t.getStatus()).toBe("connected");
    expect(sentInvokes(socket)).toHaveLength(32);
  });
});
