# CLAUDE.md

Development instructions for Claude Code working on Aethon.

## Project

Aethon is a Tauri 2 + React + TypeScript desktop app. See `SPEC.md` for the
design vision and `README.md` for the public-facing description.

The Tauri shell is intentionally thin — agent logic lives elsewhere (eventually
in a compiled Pi binary). The Rust side handles OS boundaries; the React
frontend renders A2UI components emitted by the agent.

## Stack

- **Backend**: Rust + Tauri 2, crate name `aethon`, lib name `aethon_lib`
- **Frontend**: React 19, TypeScript, Vite, bun
- **Dev env**: Nix flake with devshell (rust-overlay stable toolchain + bun)
- **Targets**: macOS (aarch64), Linux (x86_64, aarch64), Windows (later)

## Layout

```
aethon/
├── src/                   # React frontend
│   ├── main.tsx
│   ├── App.tsx
│   └── styles.css
├── src-tauri/             # Rust Tauri shell
│   ├── src/
│   │   ├── main.rs        # thin — calls aethon_lib::run()
│   │   └── lib.rs         # tauri::Builder setup
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json
│   └── capabilities/default.json
├── flake.nix              # devshell
├── package.json           # frontend deps + tauri CLI wrapper
├── vite.config.ts
└── tsconfig*.json
```

## Common Commands

Run inside `nix develop` (or via direnv):

```bash
bun install                # one-time, after pulling
bun tauri dev              # launch app with hot-reload
bun tauri build            # release bundle
check                      # clippy + tsc typecheck (devshell helper)
fmt                        # treefmt (rustfmt + nixfmt)
```

## Conventions

- **Conventional Commits** for all messages: `feat(scope):`, `fix(scope):`, etc.
- **Two-space indent** for Nix; standard for everything else.
- **TypeScript strict mode** + `verbatimModuleSyntax` + `erasableSyntaxOnly`.
  Use `import type { ... }` for type-only imports.
- **Frontend port is fixed at 1420** (Vite `strictPort: true`) — Tauri's
  `devUrl` points there.
- **No global state in the Rust shell** beyond what Tauri's `Manager` exposes.
  Business logic belongs in the agent, not the shell.
- **No emojis in code or commits** unless the user explicitly asks.

## Editing Tauri Config

`src-tauri/tauri.conf.json` controls the window, bundle, and security policy.
Adding a Tauri plugin requires:

1. `cargo add tauri-plugin-X --manifest-path src-tauri/Cargo.toml`
2. Register it in `src-tauri/src/lib.rs` via `.plugin(tauri_plugin_X::init())`
3. Add the plugin's permissions to `src-tauri/capabilities/default.json`

## Reference Projects

- `~/Projects/utensils/Claudette` — sibling Tauri 2 + TS project with much
  deeper integration (xterm, voice, mDNS). Good source of patterns for IPC,
  window management, and the Nix Linux build closure.
- `~/Projects/utensils/claudex` — sibling Rust-only project. Good source of
  patterns for the flake skeleton (flake-parts + devshell + treefmt + crane).

## Out of Scope (for now)

- Mobile builds (`tauri::mobile_entry_point` is wired but untested)
- The actual agent runtime / A2UI renderer / extension system — those are
  milestones M1–M4 in `SPEC.md`. The current scaffold only opens a window
  with placeholder text.
