{
  description = "Aethon — Pi with a face. Agent-driven desktop shell with A2UI.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";

    devshell.url = "github:numtide/devshell";
    devshell.inputs.nixpkgs.follows = "nixpkgs";

    treefmt-nix.url = "github:numtide/treefmt-nix";
    treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";

    rust-overlay.url = "github:oxalica/rust-overlay";
    rust-overlay.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
        inputs.devshell.flakeModule
        inputs.treefmt-nix.flakeModule
      ];

      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      flake.overlays.default =
        final: _prev:
        let
          system = final.stdenv.hostPlatform.system;
        in
        if builtins.hasAttr system inputs.self.packages then
          {
            aethon = inputs.self.packages.${system}.default;
          }
        else
          { };

      perSystem =
        {
          system,
          lib,
          config,
          ...
        }:
        let
          pkgs = import inputs.nixpkgs {
            localSystem = system;
            overlays = [ inputs.rust-overlay.overlays.default ];
          };

          # Pinned: 1.95.0 stable currently fails to compile `icu_provider`
          # 2.2.0, `regex-automata` 0.4.14, and `objc2` (transitive deps of
          # tauri 2.10). Holding at 1.92 until upstream catches up.
          rustToolchain = pkgs.rust-bin.stable."1.92.0".default.override {
            extensions = [
              "rust-src"
              "rustfmt"
              "clippy"
              "rust-analyzer"
            ];
            # iOS targets for the companion app (apps/mobile). Only added
            # on Darwin — the toolchain can carry them but Xcode + a Mac
            # host are needed to actually link/run, so Linux builders skip
            # the extra download. See docs/mobile.md.
            targets = lib.optionals pkgs.stdenv.isDarwin [
              "aarch64-apple-ios"
              "aarch64-apple-ios-sim"
            ];
          };

          rustPlatform = pkgs.makeRustPlatform {
            cargo = rustToolchain;
            rustc = rustToolchain;
          };

          cargoTargetEnv = lib.toUpper (
            builtins.replaceStrings [ "-" ] [ "_" ] pkgs.stdenv.hostPlatform.config
          );

          cargoTauriHook = pkgs.cargo-tauri.hook.override {
            cargo = rustToolchain;
          };

          packageJson = builtins.fromJSON (builtins.readFile ./package.json);

          source = lib.cleanSourceWith {
            src = ./.;
            filter =
              path: type:
              let
                name = baseNameOf path;
                rel = lib.removePrefix "${toString ./.}/" (toString path);
              in
              !(
                (
                  type == "directory"
                  && builtins.elem rel [
                    ".aethon"
                    ".claude"
                    ".direnv"
                    ".git"
                    ".playwright-mcp"
                    "coverage"
                    "dist"
                    "node_modules"
                    "src-tauri/binaries"
                    "target"
                  ]
                )
                || name == "result"
                || lib.hasPrefix "result-" name
              );
          };

          # Linux: full webkit2gtk + GTK closure for Tauri's webview. Listed
          # explicitly because numtide/devshell doesn't run nixpkgs'
          # pkg-config setup hook, so transitive .pc deps need to be on
          # PKG_CONFIG_PATH manually (see env block below).
          linuxBuildInputs = lib.optionals pkgs.stdenv.isLinux [
            pkgs.webkitgtk_4_1
            pkgs.gtk3
            pkgs.cairo
            pkgs.pango
            pkgs.harfbuzz
            pkgs.atk
            pkgs.gdk-pixbuf
            pkgs.libsoup_3
            pkgs.gst_all_1.gstreamer
            pkgs.gst_all_1.gst-plugins-base
            pkgs.glib
            pkgs.glib-networking
            pkgs.dbus
            pkgs.zlib
            pkgs.alsa-lib
            pkgs.openssl
            pkgs.libayatana-appindicator
            pkgs.gsettings-desktop-schemas
          ];

          linuxGSettingsSchemaDirs = lib.optionals pkgs.stdenv.isLinux [
            "${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}"
            "${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}"
          ];

          # macOS gets libiconv from the SDK at link time (libiconv.2.tbd
          # under $SDKROOT/usr/lib), which produces a binary that loads
          # /usr/lib/libiconv.2.dylib at runtime — the path every notarized
          # Mac app uses. Pulling in pkgs.libiconv used to bake a
          # /nix/store/... install_name into the bundle, which then failed
          # dyld's Team ID check on any non-builder Mac.
          darwinBuildInputs = [ ];
        in
        {
          _module.args.pkgs = pkgs;

          packages = rec {
            aethon = rustPlatform.buildRustPackage (finalAttrs: {
              pname = "aethon";
              inherit (packageJson) version;

              src = source;

              cargoRoot = "src-tauri";
              buildAndTestSubdir = finalAttrs.cargoRoot;

              cargoLock.lockFile = ./src-tauri/Cargo.lock;

              postPatch = ''
                substituteInPlace src-tauri/tauri.conf.json \
                  --replace-fail '"createUpdaterArtifacts": true' '"createUpdaterArtifacts": false'
              '';

              npmRoot = ".";
              npmDeps = pkgs.fetchNpmDeps {
                name = "${finalAttrs.pname}-${finalAttrs.version}-npm-deps";
                inherit (finalAttrs) src;
                hash = "sha256-0hGGYfMAoCgxdpvP3+rMD6Br9htZFC2bKHVEHpthoyM=";
              };

              nativeBuildInputs = [
                pkgs.bun
                cargoTauriHook
                pkgs.nodejs
                pkgs.npmHooks.npmConfigHook
              ]
              ++ lib.optionals pkgs.stdenv.isLinux [
                pkgs.pkg-config
                pkgs.wrapGAppsHook3
              ]
              ++ lib.optionals pkgs.stdenv.isDarwin [
                pkgs.makeBinaryWrapper
              ];

              buildInputs = linuxBuildInputs ++ darwinBuildInputs;

              tauriBuildFlags = lib.optionals pkgs.stdenv.isDarwin [
                "--no-sign"
              ];

              postInstall = lib.optionalString pkgs.stdenv.isDarwin ''
                mkdir -p "$out/bin"
                makeWrapper "$out/Applications/Aethon.app/Contents/MacOS/aethon" "$out/bin/aethon"
              '';

              meta = {
                description = "Pi with a face - agent-driven desktop shell with A2UI";
                homepage = "https://github.com/utensils/aethon";
                license = lib.licenses.mit;
                mainProgram = "aethon";
                platforms = lib.platforms.linux ++ lib.platforms.darwin;
              };
            });

            default = aethon;
          };

          devshells.default = {
            name = "aethon";

            motd = ''
              {202}aethon{reset} — agent-driven desktop shell ({bold}${system}{reset})
              $(type menu &>/dev/null && menu)
            '';

            packages = [
              rustToolchain
              pkgs.bun
              # node + pnpm power the `understand-dashboard` helper: the
              # understand-anything plugin's Vite dashboard runs on node, and
              # pnpm installs/builds its packages on a cold plugin cache.
              pkgs.nodejs
              pkgs.pnpm
              pkgs.cargo-tauri
              pkgs.pkg-config
              pkgs.git
              pkgs.gh
              # Wrapped treefmt with prettier/taplo/rustfmt/nixfmt baked in.
              # The devshell `fmt` command shells out to whatever treefmt is on
              # PATH, so without this the bare treefmt can't find its config.
              config.treefmt.build.wrapper
            ]
            ++ lib.optionals pkgs.stdenv.isLinux [
              pkgs.stdenv.cc
            ]
            ++ linuxBuildInputs
            ++ darwinBuildInputs;

            env = [
              {
                name = "RUST_BACKTRACE";
                value = "1";
              }
            ]
            ++ lib.optionals pkgs.stdenv.isLinux [
              {
                name = "PKG_CONFIG_PATH";
                value = lib.concatStringsSep ":" [
                  (lib.makeSearchPath "lib/pkgconfig" (map lib.getDev linuxBuildInputs))
                  (lib.makeSearchPath "share/pkgconfig" (map lib.getDev linuxBuildInputs))
                ];
              }
              {
                name = "LD_LIBRARY_PATH";
                value = lib.makeLibraryPath linuxBuildInputs;
              }
              {
                # WebKitGTK's DMA-BUF renderer crashes on current
                # Mesa/Wayland; fall back to GL-via-EGL.
                name = "WEBKIT_DISABLE_DMABUF_RENDERER";
                value = "1";
              }
              {
                # WebKitGTK's native Wayland backend can report negative
                # viewport/DPR values on Hyprland, collapsing the app grid.
                # Prefer XWayland, but keep Wayland as a fallback for hosts
                # without XWayland.
                name = "GDK_BACKEND";
                value = "x11,wayland";
              }
              {
                name = "GIO_EXTRA_MODULES";
                prefix = "${pkgs.glib-networking}/lib/gio/modules";
              }
              {
                name = "GST_PLUGIN_SYSTEM_PATH_1_0";
                value = lib.makeSearchPath "lib/gstreamer-1.0" linuxBuildInputs;
              }
              {
                name = "XDG_DATA_DIRS";
                prefix = lib.concatStringsSep ":" (
                  (map (pkg: "${pkg}/share") linuxBuildInputs) ++ linuxGSettingsSchemaDirs
                );
              }
              {
                name = "CC";
                value = "${pkgs.stdenv.cc}/bin/cc";
              }
              {
                name = "CXX";
                value = "${pkgs.stdenv.cc}/bin/c++";
              }
              {
                name = "CARGO_TARGET_${cargoTargetEnv}_LINKER";
                value = "${pkgs.stdenv.cc}/bin/cc";
              }
              {
                # Keep Rust's final link on the same Nix glibc as the
                # WebKitGTK closure instead of a host/profile compiler.
                name = "RUSTC_LINKER";
                value = "${pkgs.stdenv.cc}/bin/cc";
              }
            ]
            ++ lib.optionals pkgs.stdenv.isDarwin [
              {
                # Use Apple's clang — Nix's CC wrapper has SDK version
                # mismatches with current nixpkgs unstable. cc-rs (in
                # crates with build.rs C code) honors CC directly.
                name = "CC";
                value = "/usr/bin/cc";
              }
              {
                name = "CXX";
                value = "/usr/bin/c++";
              }
              {
                # rustc's link step invokes plain `cc` via PATH, which
                # inside nix-darwin resolves to /run/current-system/sw/bin/cc
                # — a wrapped GCC pointing at Nix's bundled apple-sdk-14.4.
                # That SDK ships a libSystem.tbd missing dozens of POSIX
                # symbols (_write, _waitpid, __NSGetEnviron, …), and ld
                # errors with "Undefined symbols for architecture arm64".
                # Pinning the cargo linker to /usr/bin/cc forces Apple's
                # toolchain, which finds the active Xcode SDK (currently
                # MacOSX26.5.sdk) and links cleanly against it.
                # Also forces a sane install_name for system libs:
                # /usr/lib/libiconv.2.dylib instead of a /nix/store path.
                name = "CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER";
                value = "/usr/bin/cc";
              }
              {
                # Belt-and-braces: some build scripts spawn cc directly
                # via $RUSTC_LINKER. Same reason as above.
                name = "RUSTC_LINKER";
                value = "/usr/bin/cc";
              }
            ];

            # Keep node_modules in sync with bun.lock on every devshell
            # entry. The check is hash-guarded so it's a sub-ms no-op unless
            # the lockfile moved (e.g. a `git pull` adding a dependency) —
            # see scripts/ensure-frontend-deps.sh. `.envrc` does
            # `watch_file bun.lock`, so nix-direnv reloads the shell (and
            # re-fires this hook) the moment the lockfile changes. A failed
            # sync warns but never aborts shell entry.
            devshell.startup."frontend-deps".text = ''
              if [ -x "$PRJ_ROOT/scripts/ensure-frontend-deps.sh" ]; then
                "$PRJ_ROOT/scripts/ensure-frontend-deps.sh" \
                  || echo "[deps] sync failed; run 'bun install' manually" >&2
              fi
            '';

            commands = [
              {
                category = "dev";
                name = "dev";
                help = "Start Tauri dev mode (Vite-style port auto-increment if 1420/19433 busy)";
                # Vite-style port auto-increment so a leaked 1420 from a
                # prior run doesn't break `dev`. The wrapper finds free
                # ports for Vite + the debug TCP server, writes them to
                # ~/.aethon/dev-info.json (read by the aethon-debug skill),
                # and overrides Tauri's devUrl via $TAURI_CONFIG before
                # exec'ing `cargo tauri dev`.
                command = "exec ./scripts/dev.sh \"$@\"";
              }
              {
                category = "build";
                name = "build-app";
                help = "Build release app bundle. Auto-sources .secrets/signing.env for signed+notarized build if present.";
                command = ''
                  set -uo pipefail
                  if [ -f .secrets/signing.env ]; then
                    echo "==> sourcing .secrets/signing.env (signed + notarized build)"
                    # shellcheck disable=SC1091
                    set -a
                    . .secrets/signing.env
                    set +a
                  else
                    echo "==> .secrets/signing.env not present; building unsigned"
                  fi
                  # The LFM2-Audio runner is staged by tauri.conf's
                  # `beforeBuildCommand` (scripts/stage-lfm2-runner.sh) and
                  # bundled via `resources`, so Tauri packages + signs it into
                  # the .app / DMG / updater itself — no post-build copy.
                  #
                  # Tauri's bundler exits non-zero on a missing
                  # TAURI_SIGNING_PRIVATE_KEY even though the .app has
                  # already been written. For local unsigned builds we
                  # treat that specific tail-end failure as a warning
                  # so the verify step still runs against the bundle.
                  cargo tauri build "$@"
                  status=$?
                  bundle=src-tauri/target/release/bundle/macos/Aethon.app
                  if [ $status -ne 0 ] && [ ! -d "$bundle" ]; then
                    exit $status
                  fi
                  # Belt-and-braces: scan the bundle's load commands for any
                  # /nix/store path. dyld rejects those on non-builder Macs
                  # (Team ID mismatch with our notarized binary), so a leak
                  # here means a freshly-built .app would crash at launch.
                  if [ "$(uname -s)" = "Darwin" ]; then
                    ./scripts/verify-bundle.sh
                  fi
                '';
              }
              {
                category = "dev";
                name = "ios-dev";
                # The iOS companion (apps/mobile) reuses the web UI over
                # the remote gateway. Xcode + CocoaPods live outside Nix;
                # the wrapper puts Homebrew on PATH, scaffolds gen/apple
                # on first run, then runs `cargo tauri ios dev`. Point the
                # app at a running desktop instance (Settings → Remote
                # Devices) to pair.
                help = "Run the iOS companion in the Simulator (needs Xcode + `brew install cocoapods`)";
                command = "exec ./scripts/ios.sh dev \"$@\"";
              }
              {
                category = "build";
                name = "ios-build";
                help = "Build the iOS companion app (cargo tauri ios build; needs Xcode + CocoaPods). No args = unsigned simulator build; --target aarch64 = device (needs a development team).";
                command = "exec ./scripts/ios.sh build \"$@\"";
              }
              {
                category = "docs";
                name = "docs";
                # Bound to 0.0.0.0 on purpose so the dev site is reachable
                # from another host on the LAN (phone, second machine, the
                # cmux-browser surface running elsewhere). VitePress's
                # default localhost-only binding makes that impossible
                # without an extra flag every invocation.
                help = "Start the VitePress docs site on 0.0.0.0 with hot-reload (default http://localhost:5173)";
                command = ''
                  set -euo pipefail
                  exec ./scripts/docs-dev.sh "$@"
                '';
              }
              {
                category = "docs";
                name = "understand-dashboard";
                # Visualize the understand-anything knowledge graph produced by
                # the /understand skill (.understand-anything/knowledge-graph.json).
                # The wrapper resolves the installed plugin, ensures its dashboard
                # package is built, and runs Vite with GRAPH_DIR=<repo root>.
                # Foreground like `dev`/`docs`; open the printed `?token=` URL.
                help = "Launch the understand-anything knowledge-graph dashboard (reads .understand-anything/knowledge-graph.json)";
                command = "exec ./scripts/understand-dashboard.sh \"$@\"";
              }
              {
                category = "check";
                name = "check";
                help = "Full CI gate: clippy + tsc + ESLint + cargo test + vitest";
                command = ''
                  set -euo pipefail
                  echo "==> node scripts/sync-version.mjs --check"
                  node scripts/sync-version.mjs --check
                  echo "==> cargo clippy"
                  cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
                  echo "==> bunx tsc -b --noEmit"
                  bunx tsc -b --noEmit
                  echo "==> bunx eslint . --max-warnings=0 (warnings only)"
                  bunx eslint .
                  echo "==> cargo test --lib"
                  cargo test --manifest-path src-tauri/Cargo.toml --lib
                  echo "==> bunx vitest run"
                  bunx vitest run
                '';
              }
              {
                category = "check";
                name = "lint";
                help = "ESLint frontend + agent (no auto-fix)";
                command = "bunx eslint \"$@\" .";
              }
              {
                category = "check";
                name = "test";
                help = "Run Rust + TS tests (cargo test --lib + vitest run)";
                command = ''
                  set -euo pipefail
                  echo "==> cargo test --lib"
                  cargo test --manifest-path src-tauri/Cargo.toml --lib "$@"
                  echo "==> bunx vitest run"
                  bunx vitest run "$@"
                '';
              }
              {
                category = "check";
                name = "coverage";
                help = "TS coverage report under coverage/ (vitest v8)";
                command = "bunx vitest run --coverage \"$@\"";
              }
              {
                category = "check";
                name = "fmt";
                help = "Format Rust + Nix + JSON/MD/YAML/CSS (prettier) + TOML (taplo)";
                command = "treefmt \"$@\"";
              }
              {
                category = "build";
                name = "clean";
                help = "Remove Rust build artifacts (src-tauri/target/)";
                command = "cargo clean --manifest-path src-tauri/Cargo.toml \"$@\"";
              }
            ];
          };

          treefmt = {
            projectRootFile = "flake.nix";
            programs.nixfmt.enable = true;
            programs.rustfmt = {
              enable = true;
              package = rustToolchain;
            };
            # Prettier handles structured-doc files; TOML uses taplo. JS/TS/TSX
            # are intentionally excluded — ESLint owns the source-code style
            # there, and reformatting hand-tuned files (agent/main.ts, App.tsx,
            # the layout JSONs) would churn unrelated diffs.
            programs.prettier.enable = true;
            programs.taplo.enable = true;
            settings.formatter.prettier.excludes = [
              "*.cjs"
              "*.js"
              "*.jsx"
              "*.mjs"
              "*.ts"
              "*.tsx"
              "*.vue"
              # Hand-shaped layout payloads — element ordering is meaningful.
              "src/extensions/default-layout/*.a2ui.json"
              "src/extensions/default-layout/slots.json"
              # Generated / vendored / out-of-tree.
              "package-lock.json"
              "bun.lock"
              "node_modules/**"
              "dist/**"
              "coverage/**"
              "src-tauri/target/**"
              "src-tauri/binaries/**"
              ".aethon/**"
              ".claude/**"
              "website/**"
            ];
            settings.formatter.taplo.excludes = [
              "src-tauri/target/**"
              "node_modules/**"
            ];
          };
        };
    };
}
