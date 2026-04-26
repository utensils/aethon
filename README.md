# Aethon

> Pi with a face. A native desktop shell where the agent decides what you see.

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
- **Rust** — OS shim (window, filesystem, system tray)
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

| Command     | What it does                                          |
| ----------- | ----------------------------------------------------- |
| `dev`       | `cargo tauri dev` with hot-reload                     |
| `build-app` | Release bundle (`.app` / `.deb` / `.msi`)             |
| `check`     | clippy + tsc typecheck                                |
| `fmt`       | format Rust + Nix with treefmt                        |

[Nix]: https://nixos.org/download
[direnv]: https://direnv.net

## Layout

```
aethon/
├── src/             # React frontend (entry: src/main.tsx)
├── src-tauri/       # Rust Tauri shell
├── flake.nix        # Nix dev environment
└── package.json     # Frontend deps + tauri CLI
```

## License

MIT © James Brink
