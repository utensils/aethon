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
                value = lib.makeSearchPath "lib/pkgconfig" (
                  map lib.getDev linuxBuildInputs
                );
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
                help = "Start Tauri dev mode with hot-reload";
                command = "cargo tauri dev \"$@\"";
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
                help = "cargo clippy + tsc typecheck";
                command = ''
                  set -euo pipefail
                  cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
                  bunx tsc -b --noEmit
                '';
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
