# Releasing Aethon

Aethon ships two channels:

- **Stable** — semver tags (`v0.4.0`, `v0.4.1`, …) cut by
  [release-please](https://github.com/googleapis/release-please) from
  Conventional Commits on `main`. The bot opens a release PR; merging
  it tags + builds + publishes the GitHub Release.
- **Nightly** — rebuilt on every push to `main`. Always at the
  `nightly` tag; previous nightly assets remain reachable for the
  in-app updater until the new build promotes atomically.

Both build on **macOS Apple Silicon only** today (the only platform
we ship). The signed `.app.tar.gz` updater bundle is what
`tauri-plugin-updater` consumes; the `.dmg` is for manual installs.

## How a release happens

### Stable

1. Commit to `main` with [Conventional Commits](https://www.conventionalcommits.org/)
   (`feat: …`, `fix: …`, `feat!: …` for breaking).
2. `release-please` opens (or rebases) a release PR titled `chore(main):
release X.Y.Z`. It bumps `package.json`, `package-lock.json`, and
   `CHANGELOG.md`.
3. A follow-up job in the same workflow runs `bun run version:sync`
   on the PR branch and force-pushes the synced `tauri.conf.json` +
   `src-tauri/Cargo.toml` + `src-tauri/Cargo.lock` to that branch, so
   `bun run version:check` passes on the PR's CI.
4. Merge the release PR. release-please creates the `vX.Y.Z` tag +
   GitHub Release (immediately marked draft).
5. The build matrix builds + notarizes + signs the macOS bundle and
   uploads to the draft release. The publish job synthesizes
   `latest.json` and un-drafts.

To build/publish an existing tag manually, use **Actions → Release
Please → Run workflow** with the tag input.

### Nightly

Push to `main` → the `Nightly Build` workflow:

1. Computes a `dev`-suffixed version like `0.4.0-dev.46.g9153d99`
   (next minor + commit-count + short SHA).
2. Creates a fresh `nightly-staging` release.
3. Builds + notarizes + signs the macOS bundle into staging.
4. Synthesizes `latest.json` using the future `nightly/` asset URLs.
5. Atomically retags `nightly-staging` → `nightly` and un-drafts.

The previous nightly's `latest.json` stays live for the ~entire build
duration; the actual swap window is ~1–2 s. The updater treats
"manifest not found" as "no update," which covers that window.

## One-time setup

### Tauri signing key (already done on this repo)

The updater verifies bundle signatures with a minisign-style keypair.
Generate yours once and store the private key offline:

```sh
bun tauri signer generate -w ~/.tauri/aethon.key
# → ~/.tauri/aethon.key      (private, encrypted with the passphrase you choose)
# → ~/.tauri/aethon.key.pub  (public, base64)
```

**Lose the private key and you can no longer ship updates to existing
installs.** Back it up somewhere durable (password manager, encrypted
USB).

Paste the contents of `aethon.key.pub` into `src-tauri/tauri.conf.json`
under `plugins.updater.pubkey`. Add the GitHub Actions secrets:

| Secret                               | Value                                        |
| ------------------------------------ | -------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | full contents of `aethon.key` (private file) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | passphrase chosen at generate time           |

### Apple Developer ID + notarization (one-time)

CI needs six secrets for macOS code signing + notarization. All six
must be present or the bundle ships unsigned (and Gatekeeper will
quarantine it).

| Secret                       | What it is                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`          | Base64-encoded `.p12` of your **Developer ID Application** cert + private key   |
| `APPLE_CERTIFICATE_PASSWORD` | Password you set when exporting the `.p12`                                      |
| `APPLE_SIGNING_IDENTITY`     | Full identity string, e.g. `Developer ID Application: James Brink (ABC1234XYZ)` |
| `APPLE_ID`                   | Your Apple Developer account email                                              |
| `APPLE_PASSWORD`             | An **app-specific password** for notarization (not your Apple ID password)      |
| `APPLE_TEAM_ID`              | 10-character Team ID from developer.apple.com → Membership                      |

**Walk-through:**

1. **Generate / fetch the Developer ID Application certificate.**

   On the macOS machine you'll use to bootstrap:

   ```sh
   open "https://developer.apple.com/account/resources/certificates/list"
   ```

   - Click **+** → **Developer ID Application** → Continue.
   - Open **Keychain Access** → **Certificate Assistant** → **Request
     a Certificate From a Certificate Authority…**
     - Email: your Apple ID
     - Common Name: `Aethon Developer ID` (or anything)
     - Saved to disk → save the `.certSigningRequest`.
   - Upload that CSR in the browser → download the resulting `.cer`.
   - Double-click the `.cer` to import it into Keychain Access.

2. **Export the certificate + private key as a `.p12`.**

   In Keychain Access, find the cert (under **My Certificates** in
   the login keychain). It should have a disclosure arrow showing
   the associated private key — if not, the CSR step didn't run on
   this Mac and you'll need to re-do step 1 here.
   - Right-click the cert → **Export…** → Format: **Personal Information
     Exchange (.p12)**.
   - Save as `aethon-developer-id.p12`. Set a strong password — that's
     `APPLE_CERTIFICATE_PASSWORD`.

3. **Base64-encode the `.p12`.**

   ```sh
   base64 -i aethon-developer-id.p12 -o aethon-developer-id.p12.b64
   pbcopy < aethon-developer-id.p12.b64    # copies to clipboard
   ```

   That string is `APPLE_CERTIFICATE`.

4. **Find your signing identity + team ID.**

   ```sh
   security find-identity -v -p codesigning
   # 1) ABCDEF…   "Developer ID Application: James Brink (ABC1234XYZ)"
   ```

   The quoted string is `APPLE_SIGNING_IDENTITY`. The `(ABC1234XYZ)`
   part is your `APPLE_TEAM_ID` (also visible at
   developer.apple.com → Membership).

5. **Generate an app-specific password for notarization.**

   Notarization (Apple's notary service) accepts your Apple ID **only**
   with an app-specific password, never your real password.
   - Visit https://appleid.apple.com → **Sign In and Security** →
     **App-Specific Passwords** → **Generate password**.
   - Label: `Aethon CI Notarization` (or anything).
   - Copy the password. That's `APPLE_PASSWORD`.
   - `APPLE_ID` is the Apple ID email you signed in with.

6. **Push all six to the repo as Actions secrets.**

   ```sh
   gh secret set APPLE_CERTIFICATE < aethon-developer-id.p12.b64
   gh secret set APPLE_CERTIFICATE_PASSWORD       # paste the .p12 password
   gh secret set APPLE_SIGNING_IDENTITY           # paste the "Developer ID Application: …" string
   gh secret set APPLE_ID                         # your Apple ID email
   gh secret set APPLE_PASSWORD                   # the app-specific password
   gh secret set APPLE_TEAM_ID                    # 10-char team ID
   ```

   Or via **GitHub → Settings → Secrets and variables → Actions → New
   repository secret** for each.

7. **Clean up local files** — the `.p12` + base64 file should not
   stay on disk:

   ```sh
   rm aethon-developer-id.p12 aethon-developer-id.p12.b64
   ```

   Keep the `.cer` in Keychain Access on at least one Mac (and back
   it up via Keychain export to encrypted storage) — that's your
   only copy.

### Other secrets

| Secret                 | Used by                          | Required?                                |
| ---------------------- | -------------------------------- | ---------------------------------------- |
| `CARGO_REGISTRY_TOKEN` | `publish-crate` (release-please) | Optional — crate publish skips if absent |

Add via `gh secret set CARGO_REGISTRY_TOKEN`.

## Building signed locally

For testing the full signing + notarization pipeline before pushing
secrets to CI (or for ad-hoc local releases), the devshell helper
`build-app` auto-sources `.secrets/signing.env` when that file exists.

Create `.secrets/signing.env` (the directory is gitignored):

```sh
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/aethon.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<passphrase>"
export APPLE_SIGNING_IDENTITY="Developer ID Application: James Brink (28X9H69QGE)"
export APPLE_ID="brink.james@gmail.com"
export APPLE_PASSWORD="<app-specific-password>"
export APPLE_TEAM_ID="28X9H69QGE"
```

Tighten permissions: `chmod 600 .secrets/signing.env`.

Local builds skip `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD`
because the Developer ID cert is already in your login keychain;
`codesign` finds it by the identity string. CI needs the base64'd
`.p12` instead because the runner has no preexisting keychain.

Run:

```sh
build-app
# ==> sourcing .secrets/signing.env (signed + notarized build)
# … cargo tauri build …
# Code signing: identity=Developer ID Application: James Brink (28X9H69QGE)
# Notarizing bundle…
# Notarization status: Accepted
# Stapling notarization ticket
# Bundles at src-tauri/target/release/bundle/
```

Verify on a clean install:

```sh
spctl --assess --type execute -v src-tauri/target/release/bundle/macos/Aethon.app
# source=Notarized Developer ID
```

If `.secrets/signing.env` is absent, `build-app` produces an unsigned
bundle (`source=No Matching Rule`) — useful for fast iteration when you
don't need a Gatekeeper-clean artifact.

## Verifying signing in CI

After secrets are set, kick a stable release (or merge a release-please
PR). In the build job's log, you should see:

```
Code signing: identity=Developer ID Application: …
Notarizing bundle…
Notarization status: Accepted
Stapling notarization ticket to …
```

A signed + notarized `.app` opens on a clean macOS install without
the "unidentified developer" warning. Download the release `.dmg`,
mount it, and run:

```sh
spctl --assess --type execute -v /Volumes/Aethon/Aethon.app
# Aethon.app: accepted
# source=Notarized Developer ID
```

If you see `source=No Matching Rule` or `unsigned`, the secrets are
either missing or wrong — check the build log for `Code signing
identity=` lines.

## Notes

- **`package.json` is the version source of truth.** `bun run
version:sync` propagates the version to `tauri.conf.json`,
  `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock`. CI fails if any
  drift.
- The `bundle.createUpdaterArtifacts` flag in `tauri.conf.json` is
  what makes Tauri emit the `.app.tar.gz` bundle the updater needs.
  Don't disable it.
- **In-app channel switching.** Settings → Updater toggles between
  `stable` (signed releases) and `nightly` (the `nightly` GitHub tag).
  The channel is persisted in `~/.aethon/config.toml` under
  `[updates] channel = "..."`; the `commands::updater` module
  resolves endpoints per channel at runtime, so the bundled
  `tauri.conf.json` endpoint only sets the default for the very
  first launch.
- **Boot-probation rollback.** Each in-app update first copies the
  installed `.app` bundle to `~/.aethon/updates/previous/<version>/`
  and writes a sentinel to `~/.aethon/boot-probation.json`. If the
  next launch's webview doesn't ack a healthy boot via `boot_ok`
  within ~20s (override with `AETHON_BOOT_PROBATION_SECS`), the
  shell spawns a helper sub-invocation (`--boot-rollback-helper
<sentinel> <pid>`), waits for the parent to exit, restores the
  backup, and relaunches. The next boot shows a dialog summarising
  what rolled back. See `src-tauri/src/boot_probation.rs` for the
  full state machine and the `MAX_PROBATION_ATTEMPTS` heuristic
  that prevents force-quit-during-probation loops.
