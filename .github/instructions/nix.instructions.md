---
applyTo: "**/*.nix,flake.lock,rust-toolchain.toml"
---

# Nix / devshell review focus

## Rust pin

Rust is pinned at **1.92.0** in `flake.nix` (via `rust-overlay`).
`rust-toolchain.toml` says `channel = "stable"` for non-Nix builds,
but the Nix pin wins inside the devshell. **Bumping the Rust
version is a review-blocker until upstream `icu_provider 2.2.0`,
`regex-automata 0.4.14`, and `objc2` are 1.95+ compatible** —
verify the comment in `flake.nix` before approving any bump.

## Platform workarounds

`flake.nix` carries platform-specific workarounds. Read the comments
before touching:

- Linux: `webkit2gtk_4_1` + GTK closure on `PKG_CONFIG_PATH` set
  manually (numtide/devshell skips the pkg-config hook).
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` dodges a Mesa/Wayland crash.
- macOS: Apple's `/usr/bin/cc` (not Nix's CC wrapper) because of
  SDK mismatches; `libiconv` pulled via `LIBRARY_PATH` + `NIX_LDFLAGS`.

Removing any of these without verifying the build still works on
the affected platform is a regression risk.

## Style

- **Two-space indentation** for Nix (sorted attribute sets, no
  trailing commas at the top of a multi-line list).
- Format with `nixfmt` via `treefmt` (`fmt` devshell command).
- Prefer upstream `nixpkgs` packages over custom derivations.
- Flake inputs should follow `nixpkgs` via
  `inputs.X.inputs.nixpkgs.follows = "nixpkgs";` to dedupe.

## Devshell helpers

`flake.nix` exposes commands the rest of the project depends on:
`dev`, `build-app`, `check`, `lint`, `test`, `coverage`, `fmt`.
Renaming or removing any of these breaks CI, scripts, and skill
prompts — flag it in review.

## Cross-platform

The flake must support both `aarch64-darwin` and `x86_64-linux` at
minimum (`aarch64-linux` and Windows targets land later). Use
`pkgs.stdenv.isDarwin` / `pkgs.stdenv.isLinux` to gate
platform-specific code. CUDA / WebKitGTK are Linux-only.
