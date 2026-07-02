// Pairing flows for the companion: parse the desktop's QR payload,
// redeem a code via the mobile shell's `gateway_pair` command, and turn
// the outcome into a `MobileConnection`.
//
// Error handling mirrors pair.rs's string contract: `net:<detail>` for
// transport failures (worth trying the next candidate host) and
// `pair:<status>:<message>` for server verdicts (terminal — the code was
// wrong, consumed, or the window lapsed; retrying another host would
// only burn the 5-attempt budget).

import { invoke } from "@tauri-apps/api/core";

import type { MobileConnection } from "./mobileConnection";

/** The JSON the desktop encodes in its pairing QR (pairing.rs). */
export interface QrPairingPayload {
  v: 1;
  name: string;
  hosts: string[];
  port: number;
  fp: string;
  code: string;
}

/** What `gateway_pair` resolves with (pair.rs `PairOutcome`). */
export interface PairOutcome {
  deviceId: string;
  deviceToken: string;
  hostDisplayName: string;
  hostFingerprint: string;
}

/** Classified pairing failure. `kind: "net"` failures are worth trying
 *  the next candidate host; `kind: "pair"` verdicts are terminal. */
export class PairFailure extends Error {
  readonly kind: "net" | "pair";
  readonly status?: number;

  constructor(kind: "net" | "pair", message: string, status?: number) {
    super(message);
    this.name = "PairFailure";
    this.kind = kind;
    this.status = status;
  }
}

export const DEFAULT_DEVICE_NAME = "iPhone";

export function parseQrPayload(text: string): QrPairingPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (p.v !== 1) return null;
  if (typeof p.code !== "string" || !/^\d{8}$/.test(p.code)) return null;
  if (typeof p.port !== "number" || !Number.isInteger(p.port) || p.port <= 0) return null;
  if (typeof p.fp !== "string") return null;
  const hosts = Array.isArray(p.hosts) ? p.hosts.filter((h) => typeof h === "string") : [];
  if (hosts.length === 0) return null;
  return {
    v: 1,
    name: typeof p.name === "string" ? p.name : "",
    hosts,
    port: p.port,
    fp: p.fp,
    code: p.code,
  };
}

/** Decode pair.rs's error strings; anything unrecognized counts as a
 *  network-ish failure so host iteration keeps going. */
export function classifyPairError(raw: unknown): PairFailure {
  if (raw instanceof PairFailure) return raw;
  const text = typeof raw === "string" ? raw : raw instanceof Error ? raw.message : String(raw);
  const pairMatch = /^pair:(\d{3}):(.*)$/s.exec(text);
  if (pairMatch) {
    return new PairFailure("pair", pairMatch[2], Number(pairMatch[1]));
  }
  return new PairFailure("net", text.replace(/^net:/, ""));
}

/** Human message for a pairing failure, with the 120s-window expiry
 *  spelled out — it's the error every first-time user will hit. */
export function pairErrorMessage(error: PairFailure): string {
  if (error.kind === "pair" && (error.status === 410 || error.status === 404)) {
    return "Pairing window expired — start pairing again on the desktop (Settings → Remote Devices).";
  }
  if (error.kind === "pair") return `Pairing failed: ${error.message}`;
  return `Could not reach the desktop: ${error.message}`;
}

/** Redeem the code against every candidate host CONCURRENTLY and take
 *  the first success. The QR's hosts[] can contain unreachable
 *  interfaces (a Tailscale IP when the phone isn't on the tailnet, VPN
 *  utuns, …) — tried serially each one burns its full 5s timeout before
 *  the LAN address gets a turn. Racing is safe for the scanned-QR flow:
 *  the code is known-correct and single-use, so at most one request
 *  redeems it; stragglers get a harmless "pairing not active".
 *
 *  Callers with a HAND-TYPED code should pass a single host (the nearby
 *  flow does): a wrong code fanned out to N hosts would burn N of the
 *  window's 5 attempts at once. */
export function pairWithHosts(opts: {
  hosts: string[];
  port: number;
  fingerprint: string;
  code: string;
  deviceName?: string;
  /** Test seam; defaults to the shim invoke. */
  invokeFn?: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
}): Promise<{ connection: MobileConnection; outcome: PairOutcome }> {
  const invokeFn = opts.invokeFn ?? invoke;
  const deviceName = opts.deviceName ?? DEFAULT_DEVICE_NAME;
  const hosts = opts.hosts.map((c) => (c.includes(":") ? c : `${c}:${opts.port}`));
  if (hosts.length === 0) {
    return Promise.reject(new PairFailure("net", "no candidate hosts"));
  }
  return new Promise((resolve, reject) => {
    let pending = hosts.length;
    let settled = false;
    let best: PairFailure | null = null;
    for (const host of hosts) {
      invokeFn("gateway_pair", {
        host,
        fingerprint: opts.fingerprint,
        code: opts.code,
        deviceName,
      }).then(
        (raw) => {
          if (settled) return;
          settled = true;
          const outcome = raw as PairOutcome;
          resolve({
            connection: {
              host,
              token: outcome.deviceToken,
              fingerprint: opts.fingerprint || undefined,
              name: outcome.hostDisplayName || undefined,
            },
            outcome,
          });
        },
        (err: unknown) => {
          const failure = classifyPairError(err);
          // When everything fails, a server verdict (wrong code,
          // expired window) explains more than transport noise.
          if (!best || (failure.kind === "pair" && best.kind === "net")) {
            best = failure;
          }
          pending -= 1;
          if (pending === 0 && !settled) {
            settled = true;
            reject(best);
          }
        },
      );
    }
  });
}
