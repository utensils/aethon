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
          };

          rustPlatform = pkgs.makeRustPlatform {
            cargo = rustToolchain;
            rustc = rustToolchain;
          };

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
            pkgs.glib
            pkgs.glib-networking
            pkgs.alsa-lib
            pkgs.openssl
            pkgs.libayatana-appindicator
            pkgs.gsettings-desktop-schemas
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
              pkgs.cargo-tauri
              pkgs.pkg-config
              pkgs.git
              pkgs.gh
              # Wrapped treefmt with prettier/taplo/rustfmt/nixfmt baked in.
              # The devshell `fmt` command shells out to whatever treefmt is on
              # PATH, so without this the bare treefmt can't find its config.
              config.treefmt.build.wrapper
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
                value = lib.makeSearchPath "lib/pkgconfig" (map lib.getDev linuxBuildInputs);
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
                name = "GIO_EXTRA_MODULES";
                prefix = "${pkgs.glib-networking}/lib/gio/modules";
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
                  # Stage the prebuilt LFM2-Audio runner so the bundler can
                  # ship it. Best-effort: voice is optional, and a missing
                  # runner only disables that one provider.
                  ./scripts/stage-lfm2-runner.sh || \
                    echo "build-app: LFM2-Audio runner not staged (voice provider will be unavailable)"
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
                  # Place the runner (binary + @loader_path dylibs) beside the
                  # executable, where resolve_lfm2_binary finds it. NOTE: for a
                  # SIGNED + notarized release the nested runner must be signed
                  # too — re-sign it and the app here. A notarized build that
                  # adds the runner after `cargo tauri build` notarizes would
                  # invalidate the ticket, so signed pipelines should validate
                  # this on a real signed build (see RELEASING.md).
                  if [ -d src-tauri/binaries/lfm2-audio ] && [ -d "$bundle" ]; then
                    rm -rf "$bundle/Contents/MacOS/lfm2-audio"
                    cp -R src-tauri/binaries/lfm2-audio "$bundle/Contents/MacOS/lfm2-audio"
                    if [ -n "''${APPLE_SIGNING_IDENTITY:-}" ] && [ "$(uname -s)" = "Darwin" ]; then
                      find "$bundle/Contents/MacOS/lfm2-audio" -type f \
                        \( -name '*.dylib' -o -name '*.so' -o -name 'llama-lfm2-audio' \) \
                        -exec codesign --force --options runtime --timestamp \
                        --sign "$APPLE_SIGNING_IDENTITY" {} + || true
                      codesign --force --options runtime --timestamp \
                        --sign "$APPLE_SIGNING_IDENTITY" "$bundle" || true
                    fi
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
                  cd website
                  [ -d node_modules ] || bun install --frozen-lockfile
                  exec bun run dev --host 0.0.0.0 "$@"
                '';
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
