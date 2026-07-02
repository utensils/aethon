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
brew install cocoapods      # required — the Tauri iOS CLI shells out to pod
```

Cross-compiling the crate's C deps (ring, …) needs Apple's **unwrapped**
clang: the Nix cc-wrapper injects `-mmacos-version-min`, which clang rejects
alongside the simulator's `-mios-simulator-version-min`. Xcode's "Build Rust
Code" script phase spawns cargo with a sanitized environment, so shell
exports can't fix this — `apps/mobile/src-tauri/.cargo/config.toml` pins
`CC_<ios-triple>=/usr/bin/clang` via cargo's `[env]` table, which travels
with the crate regardless of who invokes cargo.

## Dev loops

**Browser (the workhorse).** The shim makes the whole app browser-debuggable
against a desktop instance running with `[server] allow_insecure_ws = true`:

```sh
bun run dev:mobile
# then open http://localhost:1430/?gateway=ws://<desktop-host>:<port>&token=<device-token>
```

Pair once from the desktop (Settings → Remote Devices) to mint a device token,
or use `cli/aethonRemote.ts pair <code>`.

**Simulator / device.** Use the devshell helpers (they wrap
`scripts/ios.sh`, which puts Homebrew tools on PATH, scaffolds `gen/apple`
on first run, and hands off to the Tauri CLI):

```sh
ios-dev                     # dev loop in the Simulator (defaults to
                            # iPhone 17 Pro; AETHON_IOS_DEVICE overrides)
ios-run                     # install + launch the last ios-build output
                            # (static bundle — no dev server, no Xcode)
ios-build                   # unsigned simulator .app (the no-arg default)
ios-device                  # signed device build, installed + launched on
                            # the connected iPhone via devicectl
                            # (AETHON_IOS_UDID overrides the device pick)
ios-dev --host              # dev loop on a physical device over LAN
```

Device signing comes from `DEVELOPMENT_TEAM` + `CODE_SIGN_STYLE: Automatic`
in `gen/apple/project.yml` (mirrored in `tauri.conf.json`
`bundle.iOS.developmentTeam` for future regens); `ios-device` passes
`-allowProvisioningUpdates` through to xcodebuild so the profile mints
itself. If provisioning still fails on a fresh machine, run `ios-dev
--open` once and press Run in Xcode (keep the CLI running — a bare
xcodebuild dies at the Build Rust Code phase with "Connection refused").

Only one `ios-dev` session can run at a time: the xcodebuild "Build Rust
Code" phase dials back into the CLI's options server, so a second
session — or building from Xcode without the CLI running — fails with
`failed to read CLI options … Connection refused`.

The raw path (`cd apps/mobile && bun run ios:dev`) still works but doesn't
set up the Homebrew PATH for `pod`.

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
