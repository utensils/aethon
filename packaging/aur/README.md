# AUR packaging

This directory contains Arch User Repository package recipes for Aethon:

- `aethon` builds the latest tagged release from source.
- `aethon-git` builds the current upstream Git history from source and provides/conflicts with `aethon`.

## Verify in a clean Arch container

Build the Arch-based verifier image from the repository root. The image is pinned to `linux/amd64` because Arch's official Docker image is x86_64-only:

```bash
docker build --platform linux/amd64 -f packaging/aur/Dockerfile -t aethon-aur .
```

Run every package through `makepkg`:

```bash
docker run --rm --platform linux/amd64 -v "$PWD:/repo:ro" aethon-aur
```

The container installs Arch build/runtime dependencies, creates an unprivileged `builder` user, and runs `scripts/aur-build-all.sh` over each package directory under `packaging/aur/`.
