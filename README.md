<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/aethon-hero-light.svg">
    <img alt="Aethon — pi with a face" src="assets/brand/aethon-hero-dark.svg" width="760">
  </picture>
</p>

# Aethon

> Pi with a face.

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Status: early development" src="https://img.shields.io/badge/status-early%20development-orange">
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=white">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black">
  <img alt="Rust 1.92" src="https://img.shields.io/badge/Rust-1.92-DEA584?logo=rust&logoColor=white">
  <img alt="Nix flake" src="https://img.shields.io/badge/Nix-flake-5277C3?logo=nixos&logoColor=white">
  <img alt="Platforms: macOS | Linux" src="https://img.shields.io/badge/platforms-macOS%20%7C%20Linux-lightgrey">
</p>

> ⚠️ **Early development — not ready for use.** This is a scaffold. Expect breaking changes and missing features.

Aethon is a cross-platform desktop application that embeds the pi coding agent
and renders its output as rich, interactive UI via the [A2UI] protocol. Instead
of a fixed IDE layout, the interface is a canvas that the agent populates
dynamically — skills bring their own UI components, themes control the look,
and the agent decides the layout based on what you're doing.

The name comes from Greek mythology: Αἴθων, one of the horses that pulled
Helios's sun chariot. The blazing one that shapes what you see.

[A2UI]: https://github.com/google/a2ui

## Stack

- **Tauri 2** — native binary, system webview, ~5MB shell
- **React 19 + TypeScript + Vite** — frontend
- **Rust** — OS shim (window, filesystem, agent subprocess)
- **Bun** — JS runtime and package manager
- **Nix flake** — reproducible dev environment

## Development

Requires [Nix] with flakes enabled. With [direnv], the dev shell activates
automatically when you `cd` into the directory.

```bash
nix develop          # enter the dev shell
bun install          # install JS deps
bun tauri dev        # launch the app (hot reload)
```

Inside the dev shell, helper commands are available:

| Command     | What it does                                            |
| ----------- | ------------------------------------------------------- |
| `dev`       | `cargo tauri dev` with hot-reload                       |
| `build-app` | Release bundle (`.app` / `.dmg` / `.deb` / `.AppImage`) |
| `check`     | clippy + tsc typecheck                                  |
| `fmt`       | format Rust + Nix with treefmt                          |

[Nix]: https://nixos.org/download
[direnv]: https://direnv.net

## Layout

```
aethon/
├── src/             # React frontend (entry: src/main.tsx)
├── src-tauri/       # Rust Tauri shell
├── agent/           # Pi agent bridge (run as a bun subprocess)
├── flake.nix        # Nix dev environment
└── package.json     # Frontend deps + tauri CLI
```

See [`CLAUDE.md`](CLAUDE.md) for architecture notes and implementation status.

## License

[MIT](LICENSE) © James Brink
