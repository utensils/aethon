// Aliased in place of `@tauri-apps/api/core` for the mobile build (see
// vite.mobile.config.ts). Re-exports the real module wholesale — plugins
// like @tauri-apps/plugin-notification import `addPluginListener`,
// `Channel`, etc. — but overrides `invoke` and `convertFileSrc` so those
// two route per `commandPolicy`: native plugins to the real Tauri
// runtime, desktop-only commands to local stubs, everything else to the
// gateway transport.
//
// The `@tauri-real/core` specifier (a dedicated tsconfig path + Vite
// alias) resolves to the genuine module, so this re-export doesn't loop
// back onto the shim.

export * from "@tauri-real/core";

import { routeFor, stubResult } from "./commandPolicy";
import { gateway } from "./transport";

interface TauriInternals {
  invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
}

function internals(): TauriInternals | undefined {
  return (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
}

/** Same shape as `@tauri-apps/api/core`'s `invoke`, but transport-aware.
 *  Shadows the re-exported `invoke` above. */
export function invoke<T = unknown>(
  cmd: string,
  args: Record<string, unknown> = {},
  _options?: unknown,
): Promise<T> {
  switch (routeFor(cmd)) {
    case "local": {
      const runtime = internals();
      if (!runtime) return Promise.reject(new Error(`no Tauri runtime for ${cmd}`));
      return runtime.invoke(cmd, args) as Promise<T>;
    }
    case "stub":
      return Promise.resolve(stubResult(cmd) as T);
    case "gateway":
      return gateway.request<T>(cmd, args);
  }
}

/** Base URL for the gateway's authenticated asset endpoint, derived from
 *  the ws(s):// transport URL. Set when the transport is configured. */
let assetBase: { httpBase: string; token: string } | null = null;
export function setAssetBase(wsUrl: string, token: string): void {
  const httpBase = wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
  assetBase = { httpBase, token };
}

/** Mobile replacement for Tauri's `convertFileSrc`: a desktop-local path
 *  becomes an authenticated HTTP URL served by the gateway's /asset
 *  endpoint (the desktop reads it through the same jailed path). Shadows
 *  the re-exported `convertFileSrc`. */
export function convertFileSrc(filePath: string, _protocol = "asset"): string {
  if (!assetBase) return filePath;
  const params = new URLSearchParams({ path: filePath, token: assetBase.token });
  return `${assetBase.httpBase}/asset?${params.toString()}`;
}
