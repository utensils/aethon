<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/aethon-hero-light.svg">
    <img alt="Aethon — pi with a face" src="assets/brand/aethon-hero-dark.svg" width="760">
  </picture>
</p>

<p align="center">
  <em>An agent-driven desktop shell where the agent decides what you see.</em>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Status: early development" src="https://img.shields.io/badge/status-early%20development-orange">
  <img alt="Platforms: macOS | Linux | Windows" src="https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey">
</p>

> **Early development — not ready for production use.** Expect breaking changes between commits.

Aethon embeds the [pi coding agent][pi] inside a Tauri 2 desktop shell and renders its output as live, interactive UI via the [A2UI][a2ui] protocol. The interface is not a fixed IDE layout — it's a **canvas the agent populates dynamically**.

The name comes from Greek mythology: _Αἴθων_, one of the horses that pulled Helios's sun chariot.

[pi]: https://github.com/mariozechner/pi-coding-agent
[a2ui]: https://github.com/google/a2ui

## Highlights

- **Multi-tab workspace** — agent tabs on top, interactive PTY shells in a bottom panel (xterm.js, full TUI / 256-color).
- **Agent-controlled UI** — themes, layouts, and components are all data the agent (or an extension) can register at runtime.
- **Extensibility** — drop a `.ts` into `~/.aethon/extensions/` for hot-reload, or `npm install` a skill package. Project-local extensions resolve from cwd up.
- **Native shell** — system tray, native menu, auto-updater, persistent sessions, `~/.aethon/config.toml`.
- **Bring your own LLM** — pi reads `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / equivalents.

## Getting started

Requires [Nix][nix] with flakes enabled. With [direnv][direnv] the dev shell activates on `cd`.

```bash
nix develop          # rust toolchain + bun + tauri CLI
bun install
dev                  # launch with hot reload
```

Or build a release bundle: `build-app`. Full CI gate: `check`.

The flake also exposes `nix build .#aethon` and `overlays.default` for downstream consumers.

[nix]: https://nixos.org/download
[direnv]: https://direnv.net

## Documentation

| Doc                                                    | What's there                                          |
| ------------------------------------------------------ | ----------------------------------------------------- |
| [`SPEC.md`](SPEC.md)                                   | Design vision and milestone status checklist          |
| [`CLAUDE.md`](CLAUDE.md)                               | Architecture deep-dive, conventions, devshell details |
| [`docs/aethon-agent/`](docs/aethon-agent/)             | Agent-side API surface, A2UI components, extensions   |
| [`RELEASING.md`](RELEASING.md)                         | Updater keypair, CI secrets, cutting a release        |
| [`CHANGELOG.md`](CHANGELOG.md)                         | Release notes                                         |

## License

[MIT](LICENSE) © James Brink

<sub>Aethon is independent of and not affiliated with Anthropic. Pi is © its respective authors.</sub>
