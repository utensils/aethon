#!/usr/bin/env bun
//! Smoke client for the Aethon remote gateway (the iOS companion's
//! transport). Doubles as executable documentation of wire protocol v1:
//! `pair` redeems a code for a device token; `chat` opens the WebSocket,
//! authenticates, sends a turn, and streams the agent-response frames.
//!
//! Uses the plaintext `ws://` transport, which the desktop exposes only
//! when `[server] allow_insecure_ws = true` (dev loop). The production
//! iOS client speaks `wss://` with the pinned cert fingerprint from the
//! QR payload; that pinning needs a native TLS stack, so it lives in the
//! mobile shell, not here.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

interface RemoteFrameResult {
  t: "result";
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}
interface RemoteFrameEvent {
  t: "event";
  topic: string;
  seq: number;
  payload: unknown;
}
interface RemoteFrameHello {
  t: "hello_ok";
  protocol: number;
  host: { displayName: string; fingerprint: string };
  deviceId: string;
  appVersion: string;
}
interface RemoteFrameBye {
  t: "bye";
  reason: string;
}
type ServerFrame = RemoteFrameResult | RemoteFrameEvent | RemoteFrameHello | RemoteFrameBye;

interface Options {
  host: string;
  token?: string;
  json: boolean;
}

const TOKEN_FILE = join(homedir(), ".aethon", "remote", "cli-token.json");

function loadSavedToken(host: string): string | undefined {
  try {
    const saved = JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as Record<string, string>;
    return saved[host];
  } catch {
    return undefined;
  }
}

function saveToken(host: string, token: string): void {
  let saved: Record<string, string> = {};
  try {
    saved = JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as Record<string, string>;
  } catch {
    // First token — the file doesn't exist yet.
  }
  saved[host] = token;
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  writeFileSync(TOKEN_FILE, JSON.stringify(saved, null, 2), { mode: 0o600 });
}

/** Redeem an 8-digit pairing code (shown on the desktop) for a durable
 *  device token, and cache it under the host key. */
async function pair(host: string, code: string): Promise<void> {
  const res = await fetch(`http://${host}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, deviceName: "aethonRemote CLI", platform: "cli" }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`pair failed (${res.status}): ${body.error ?? res.statusText}`);
  }
  const body = (await res.json()) as { deviceId: string; deviceToken: string };
  saveToken(host, body.deviceToken);
  console.log(`paired as ${body.deviceId}; token cached in ${TOKEN_FILE}`);
}

/** Minimal correlated WebSocket client for the gateway. */
class RemoteClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private eventHandlers: ((frame: RemoteFrameEvent) => void)[] = [];
  private ready: Promise<RemoteFrameHello>;

  constructor(host: string, token: string) {
    this.ws = new WebSocket(`ws://${host}/ws`);
    this.ready = new Promise<RemoteFrameHello>((resolve, reject) => {
      this.ws.addEventListener("open", () => {
        this.ws.send(JSON.stringify({ t: "hello", protocol: 1, token, deviceId: "cli", appVersion: "cli" }));
      });
      this.ws.addEventListener("error", () => reject(new Error("websocket error")));
      this.ws.addEventListener("close", () => {
        for (const { reject: rej } of this.pending.values()) rej(new Error("connection closed"));
        this.pending.clear();
      });
      this.ws.addEventListener("message", (ev) => {
        const frame = JSON.parse(String(ev.data)) as ServerFrame;
        if (frame.t === "hello_ok") {
          resolve(frame);
        } else if (frame.t === "bye") {
          reject(new Error(`gateway closed: ${frame.reason}`));
        } else if (frame.t === "result") {
          const entry = this.pending.get(frame.id);
          if (entry) {
            this.pending.delete(frame.id);
            if (frame.ok) entry.resolve(frame.data);
            else entry.reject(new Error(frame.error ?? "invoke failed"));
          }
        } else if (frame.t === "event") {
          for (const handler of this.eventHandlers) handler(frame);
        }
      });
    });
  }

  whenReady(): Promise<RemoteFrameHello> {
    return this.ready;
  }

  onEvent(handler: (frame: RemoteFrameEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  invoke<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = `i-${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ t: "invoke", id, cmd, args }));
    });
  }

  subscribe(topics: string[]): void {
    this.ws.send(JSON.stringify({ t: "sub", topics }));
  }

  close(): void {
    this.ws.close();
  }
}

/** Parse the JSON-string payload of an agent-response event into a
 *  bridge message; the gateway forwards it verbatim. */
function bridgeMessage(frame: RemoteFrameEvent): Record<string, unknown> | undefined {
  if (typeof frame.payload !== "string") return undefined;
  try {
    return JSON.parse(frame.payload) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function chat(opts: Options, message: string): Promise<void> {
  const token = opts.token ?? loadSavedToken(opts.host);
  if (!token) throw new Error(`no token for ${opts.host}; run: aethonRemote --host ${opts.host} pair <code>`);
  const client = new RemoteClient(opts.host, token);
  const hello = await client.whenReady();
  if (!opts.json) console.error(`connected to ${hello.host.displayName} (aethon ${hello.appVersion})`);

  const done = new Promise<void>((resolve) => {
    client.onEvent((frame) => {
      if (frame.topic !== "agent-response") return;
      const msg = bridgeMessage(frame);
      if (!msg) return;
      if (opts.json) {
        console.log(JSON.stringify(msg));
      } else if (msg.type === "response_delta" && msg.channel !== "thinking") {
        if (typeof msg.content === "string") process.stdout.write(msg.content);
      }
      if (msg.type === "response_end") resolve();
    });
  });

  client.subscribe(["agent-response"]);
  await client.invoke("start_agent");
  await client.invoke("send_message", { request: { message } });
  await done;
  if (!opts.json) process.stdout.write("\n");
  client.close();
}

async function status(opts: Options): Promise<void> {
  const token = opts.token ?? loadSavedToken(opts.host);
  if (!token) throw new Error(`no token for ${opts.host}; pair first`);
  const client = new RemoteClient(opts.host, token);
  await client.whenReady();
  const info = await client.invoke("remote_status");
  console.log(JSON.stringify(info, null, 2));
  client.close();
}

function parseArgs(argv: string[]): { opts: Options; cmd: string; rest: string[] } {
  const opts: Options = { host: "127.0.0.1:0", json: false };
  const rest: string[] = [];
  let cmd = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") opts.host = argv[++i];
    else if (a === "--token") opts.token = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (!cmd) cmd = a;
    else rest.push(a);
  }
  return { opts, cmd, rest };
}

async function main(): Promise<void> {
  const { opts, cmd, rest } = parseArgs(process.argv.slice(2));
  if (opts.host === "127.0.0.1:0") {
    console.error("usage: aethonRemote --host <host:port> <pair <code> | chat <message> | status> [--json]");
    process.exit(2);
  }
  switch (cmd) {
    case "pair":
      await pair(opts.host, rest[0]);
      break;
    case "chat":
      await chat(opts, rest.join(" "));
      break;
    case "status":
      await status(opts);
      break;
    default:
      console.error(`unknown command: ${cmd || "(none)"}`);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
