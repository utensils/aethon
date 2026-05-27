# Aethon Agent Reference

You are running inside the Aethon desktop app. These docs are the
authoritative reference for the **runtime API** you use to mutate the GUI
and the **A2UI primitives** the renderer understands. They ship inside the
Aethon binary at `$AETHON_DOCS_DIR` so they are available in every build.

Read these on demand with the `read` tool — do not cite them from memory,
since the API has been revised since model training.

## Files

| File            | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.md`        | `globalThis.aethon` runtime API: `setState`, `setLayout`, `patchLayout`, `registerComponent`, `registerSidebarSection`, `registerTheme`, `onEvent`, plus the introspection helpers (`listExtensions`, `listComponents`, `listThemes`, `getLayout`, `getRuntimeSnapshot`).                                                                                                                                                                           |
| `components.md` | A2UI primitive components (`text`, `heading`, `paragraph`, `card`, `button`, `container`, `divider`, `code`, `image`, `icon`, `text-input`, `date-picker`, `checkbox`, `select`, `slider`, `list`, `table`, `form`, `form-field`) and skill-provided composites (`layout`, `sidebar`, `tab-strip`, `chat-history`, `chat-input`, `status-bar`, `terminal`, `main-canvas`). Includes prop schemas and the `$ref` JSON-Pointer data-binding contract. |
| `extensions.md` | Authoring extensions: directory layout under `~/.aethon/extensions/`, project-local `.aethon/extensions/`, npm-distributed extension packages under `~/.aethon/skills/node_modules/` (path retained for back-compat), and worked examples (theme, sidebar section, live data via `setState`, event handler that runs an LLM turn, layout patch, custom A2UI component).                                                                                         |

## Quick reference

- **What's loaded right now**: `cat $AETHON_STATE_FILE` (defaults to
  `~/.aethon/state.json`). Refreshed every time an extension registers.
- **In-process introspection**: `globalThis.aethon.getRuntimeSnapshot()`
  returns the same data structurally.
- **Working directory in release**: do NOT assume the Aethon source is
  present. The `cwd` is whatever the user launched the app from. Mutate
  the live UI via `globalThis.aethon` instead of writing to source files.
- **Working directory in dev**: `$AETHON_PROJECT_ROOT` points at the
  Aethon source tree. You may read files there for reference, but prefer
  `~/.aethon/extensions/` and live mutations for user-visible changes.
