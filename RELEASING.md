# Releasing Aethon

This document covers the one-time setup for cutting signed releases that the
in-app updater can install.

## 1. Generate a signing keypair (one-time)

The updater verifies bundle signatures with a minisign-style keypair. Generate
yours and store it offline:

```sh
bun tauri signer generate -w ~/.tauri/aethon.key
# → ~/.tauri/aethon.key      (private, encrypted with the passphrase you choose)
# → ~/.tauri/aethon.key.pub  (public, base64)
```

**Lose the private key and you can no longer ship updates to existing installs.**
Back the `.key` file up somewhere durable (e.g. a password manager, encrypted
USB).

## 2. Wire the public key into the app

Paste the contents of `aethon.key.pub` into `src-tauri/tauri.conf.json` under
`plugins.updater.pubkey`. Commit the change. Builds without a configured
pubkey will boot, but `check()` will refuse to validate downloads.

## 3. Provide signing secrets to CI

Add two repository secrets in GitHub (Settings → Secrets and variables →
Actions):

| Name | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | full contents of `aethon.key` (private file) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the passphrase you chose at generate time |

`cargo tauri build` reads these env vars and emits `*.sig` files alongside
each platform bundle. Without them present, no signatures get generated and
the updater rejects the download.

## 4. Cut a release

Recommended: use `tauri-apps/tauri-action@v0` in a GitHub Actions workflow.
It builds for each target, signs each bundle, uploads them to a draft
release, and writes the `latest.json` manifest the updater endpoint expects.

Manual fallback (single-platform):

```sh
bun tauri build
# Bundles + signatures land in src-tauri/target/release/bundle/.
# Upload them to a GitHub release named after the version (e.g. v0.2.0)
# along with a hand-written latest.json that points at them.
```

`latest.json` shape:

```json
{
  "version": "0.2.0",
  "notes": "Release notes here.",
  "pub_date": "2026-04-26T12:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<paste contents of Aethon_0.2.0_aarch64.app.tar.gz.sig here>",
      "url": "https://github.com/utensils/aethon/releases/download/v0.2.0/Aethon_0.2.0_aarch64.app.tar.gz"
    }
  }
}
```

The updater endpoint in `tauri.conf.json` is set to
`https://github.com/utensils/aethon/releases/latest/download/latest.json`,
which means uploading `latest.json` as a release asset is enough — GitHub
serves `latest/download/<asset>` automatically.

## 5. Verify

After publishing, run a previous build of Aethon and pick **Aethon → Check
for Updates…** The app should detect the new version, download it, and
relaunch.

## Notes

- The `version` in `tauri.conf.json` is the source of truth — bump it when
  cutting a release. The updater compares the manifest version against this.
- Updates are append-only by design; you can't roll back via the updater. To
  push a fix, ship a new release with a higher version that re-applies the
  fix.
- The `createUpdaterArtifacts` flag in `bundle` triggers Tauri to emit the
  update-friendly `.app.tar.gz` / `.AppImage.tar.gz` bundles required by the
  updater. Without it, only the user-installable `.dmg` / `.AppImage` get
  built and the updater has nothing to point at.
