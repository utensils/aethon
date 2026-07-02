# Aethon iOS companion

The companion app pairs with a **running** Aethon desktop instance over the
LAN and reuses the same React A2UI frontend (`src/`), swapping Tauri's
in-process IPC for a WebSocket to the desktop's remote gateway. It is a thin
client — the desktop stays the executor of everything.

## Layout

- `apps/mobile/src-tauri/` — the thin `aethon-mobile` Tauri crate. Its own
  standalone workspace, so the desktop crate's iOS-incompatible deps
  (portable-pty, cpal, candle, tray, updater sidecar) never enter the build.
  It wires the native plugins the mobile UI uses (notifications, opener) and
  the `gateway_*` commands that own the pinned WebSocket.
- `src/gateway/` — the transport + shims that the mobile Vite build aliases in
  place of `@tauri-apps/api/{core,event}`.
- `src/mobile/` — the mobile entry (`mainMobile.tsx`), connect gate, and
  (later phases) the mobile layout + composites.
- `vite.mobile.config.ts` / `index.mobile.html` — the mobile build, emitting
  `dist-mobile/`.

## Toolchain

The Nix devshell provides the Rust toolchain **and** the iOS targets
(`aarch64-apple-ios`, `aarch64-apple-ios-sim`) on Darwin — see `flake.nix`.
Xcode and CocoaPods stay **outside** Nix (Tauri's iOS tooling shells out to
`xcodebuild`, and the flake already pins `CC=/usr/bin/cc` to use the real
Xcode SDK):

```sh
xcode-select --install      # or a full Xcode from the App Store
brew install cocoapods      # only if a plugin needs CocoaPods over SPM
```

## Dev loops

**Browser (the workhorse).** The shim makes the whole app browser-debuggable
against a desktop instance running with `[server] allow_insecure_ws = true`:

```sh
bun run dev:mobile
# then open http://localhost:1430/?gateway=ws://<desktop-host>:<port>&token=<device-token>
```

Pair once from the desktop (Settings → Remote Devices) to mint a device token,
or use `cli/aethonRemote.ts pair <code>`.

**Simulator / device.**

```sh
cd apps/mobile
bun install                 # first time — installs @tauri-apps/cli
bun run ios:init            # generates gen/apple (commit it)
bun run ios:dev             # simulator; add --host for a physical device
```

`gen/apple/` is committed so CLI upgrades don't silently regenerate it; pin
`@tauri-apps/cli` in `apps/mobile/package.json`.

## CI

`src/gateway` + `src/mobile` are covered by the root `tsc -b`, ESLint, and
vitest. `bun run build:mobile` catches bundle breakage. On a macOS runner,
`cargo check --manifest-path apps/mobile/src-tauri/Cargo.toml --target
aarch64-apple-ios-sim` compiles the shell without signing. Signed IPA /
TestFlight builds stay local/manual.

## Security

Production traffic is `wss://` with the desktop's self-signed cert pinned by
SHA-256 (the fingerprint in the pairing QR). WKWebView's App Transport
Security would block a self-signed `wss://` opened from JS and offers no
pinning hook, so the socket is opened natively in `gateway.rs`
(`tokio-tungstenite` + a custom rustls verifier) — raw sockets are outside
ATS's scope. The plaintext `ws://` path exists only for the dev loop and is
honored only in debug desktop builds.
