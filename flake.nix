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
            pkgs.openssl
            pkgs.libayatana-appindicator
            pkgs.gsettings-desktop-schemas
          ];

          darwinBuildInputs = lib.optionals pkgs.stdenv.isDarwin [
            pkgs.libiconv
          ];
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
                hash = "sha256-nO82FJPRtzl2jxiSu+Y/keXVhbDPp2D2/7sBT2tB46I=";
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
                # mismatches with current nixpkgs unstable.
                name = "CC";
                value = "/usr/bin/cc";
              }
              {
                name = "CXX";
                value = "/usr/bin/c++";
              }
              {
                # Apple's linker won't find Nix-provided libiconv without an
                # explicit lib path. clang honors LIBRARY_PATH like GCC does.
                name = "LIBRARY_PATH";
                value = "${pkgs.libiconv}/lib";
              }
              {
                # Belt-and-braces: rustc passes NIX_LDFLAGS through to the
                # linker on macOS; this guarantees the -L is on the link line
                # for any crate that bypasses LIBRARY_PATH.
                name = "NIX_LDFLAGS";
                value = "-L${pkgs.libiconv}/lib";
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
                help = "Build release app bundle (.app / .deb / .msi); src-tauri/build.rs compiles the agent sidecar automatically";
                command = "cargo tauri build \"$@\"";
              }
              {
                category = "check";
                name = "check";
                help = "Full CI gate: clippy + tsc + ESLint + cargo test + vitest";
                command = ''
                  set -euo pipefail
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
                help = "Format Rust + Nix";
                command = "treefmt \"$@\"";
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
          };
        };
    };
}
