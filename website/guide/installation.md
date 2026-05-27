# Installation

Aethon ships native bundles for macOS, Linux, and Windows. All bundles
contain the same Tauri 2 shell, the bun-built pi agent sidecar, and the
React frontend — only the OS surface differs.

## Download a release

Grab the latest bundle from the [GitHub Releases page][releases].

[releases]: https://github.com/utensils/aethon/releases

| Platform | Bundle | Notes |
|---|---|---|
| macOS (Apple Silicon) | `Aethon_<version>_aarch64.dmg` | Drag to `/Applications`. |
| macOS (Intel) | `Aethon_<version>_x64.dmg` | Drag to `/Applications`. |
| Linux (x86_64, Debian / Ubuntu) | `aethon_<version>_amd64.deb` | `sudo apt install ./aethon_*.deb` |
| Linux (x86_64, Fedora / RHEL) | `aethon-<version>-1.x86_64.rpm` | `sudo rpm -i aethon-*.rpm` |
| Linux (portable) | `aethon_<version>_amd64.AppImage` | `chmod +x` and run. |
| Windows | `Aethon_<version>_x64-setup.exe` | NSIS installer. |

::: tip Updates
The macOS app self-updates via the bundled updater plugin. Linux/Windows
users currently re-download from Releases — automated update channels for
those platforms are tracked in the spec.
:::

## Install with Nix

Aethon's flake exposes a package and overlay for downstream Nix consumers:

```bash
nix run github:utensils/aethon
nix build github:utensils/aethon#aethon
```

Or pin the overlay in your own flake:

```nix
{
  inputs.aethon.url = "github:utensils/aethon";
  outputs = { nixpkgs, aethon, ... }: {
    # Apply the overlay to get pkgs.aethon
    nixosConfigurations.host = nixpkgs.lib.nixosSystem {
      modules = [ { nixpkgs.overlays = [ aethon.overlays.default ]; } ];
    };
  };
}
```

## Run from source (for contributors)

Aethon's dev environment is fully Nix-managed. With [direnv][direnv]
installed, the dev shell activates when you `cd` into the repo.

```bash
git clone https://github.com/utensils/aethon
cd aethon
nix develop          # rust toolchain + bun + tauri CLI
bun install          # install JS deps
dev                  # launch with hot reload
```

Without Nix you'll need:

- **Rust 1.92.0** — pinned in `flake.nix` for the Nix devshell;
  `rust-toolchain.toml` only says `stable` for non-Nix builds, so
  install 1.92.0 and apply it as a **per-repo override** to match CI
  without disturbing the rest of your machine:
  ```bash
  rustup install 1.92.0
  rustup override set 1.92.0   # run inside the aethon checkout
  ```
- **Bun 1.x**
- **Tauri 2** prerequisites for your OS — see the [Tauri docs][tauri-prereq].

[direnv]: https://direnv.net
[tauri-prereq]: https://v2.tauri.app/start/prerequisites/

## First-run setup — provider keys

Pi (the embedded coding agent) reads provider keys from the environment.
At least one of:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
export GROQ_API_KEY="..."
# ...or any other provider pi supports
```

Set these in your shell profile (`~/.zshrc`, `~/.bashrc`) so they're
visible to Aethon when the GUI app launches. On macOS, GUI apps inherit
environment variables set in the user's login shell only when the variable
is exported via `launchctl setenv` or [`~/Library/LaunchAgents/`][launchagents].
For most users, launching Aethon from a terminal (`open -a Aethon` or
running the dev build) is the simplest path.

[launchagents]: https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html

The first time Aethon runs it creates `~/.aethon/` with:

```
~/.aethon/
├── config.toml         User-editable settings (see Configuration)
├── projects.json       MRU project list (max 16)
├── sessions/<tabId>/   Pi session transcripts per tab
├── extensions/         Drop-in extensions (.ts files)
├── skills/             npm-installed skills
└── themes/             Custom theme JSON files
```

Nothing under `~/.aethon/` is created or modified before the first launch.

## Verify the install

Launch Aethon and:

1. Send any message in the default agent tab — you should see a streamed
   response from your provider.
2. Press `Cmd+,` (`Ctrl+,` on Linux/Windows) to open the **Settings**
   panel and confirm the active model.
3. Press `Cmd+P` to open the **Command palette** and explore the
   built-in actions.

If the agent never responds, see [Troubleshooting](/troubleshooting).

## Next steps

- [Quick start](/guide/quick-start) — open a project and send your first prompt.
- [Configuration](/guide/configuration) — tour `~/.aethon/config.toml`.
- [Keyboard shortcuts](/reference/keyboard-shortcuts) — full reference.
