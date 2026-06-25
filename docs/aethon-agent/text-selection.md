# Text-selection policy

Aethon's UI mixes **chrome** (sidebar, tabs, status bar, menus, palette,
buttons) and **content** (chat messages, code blocks, terminal, editor,
markdown preview, search results). The two need opposite defaults.

## Rules

1. **Chrome** — `user-select: none`.
   - Sidebar rows, tab labels, status-bar segments, header pills,
     command-palette items, context-menu items, button labels,
     notification toast headers.
   - Ghost selection during click-drag is confusing on a navigation
     surface; the few cases where the user actually wants to copy a
     chrome label are handled via opt-in (rule 3 below).

2. **Content** — `user-select: text`.
   - Chat message bodies, code blocks, terminal scrollback, Monaco
     editor, markdown previews, status-bar telemetry numbers,
     settings-panel field values.
   - These are read-and-quote surfaces. Selection must work without
     ceremony.

3. **Path-like strings inside chrome** — opt-in via `data-selectable`.
   - File-tree row label, project path under the empty state, branch
     name in the status-bar chip, tooltip-style metadata strings.
   - Add `data-selectable` to the element that wraps the copyable
     text. `chrome/base.css` scopes a `[data-selectable] { user-select: text }`
     rule so the opt-in works wherever the parent disables selection.

## Implementing the policy in CSS

`src/styles/chrome/` is the authoritative place. `src/styles/chrome.css` is
now just an `@import` aggregator; the real rules live in the per-domain
stylesheets it pulls in (e.g. `src/styles/chrome/base.css` carries the
selection defaults). Roughly:

```css
/* Chrome containers default to user-select: none */
.a2ui-sidebar,
.app-header,
.a2ui-status-bar,
.a2ui-tab-strip,
.a2ui-context-menu,
.ae-palette,
.a2ui-notification {
  user-select: none;
}

/* Opt-in inside chrome */
[data-selectable] {
  user-select: text;
}

/* Content surfaces are selectable by default — nothing to do */
```

## Reviewing changes

When you add a new chrome composite, the default selection state should
inherit `none` from its container. If you want a specific text inside
that composite to be copyable (a path, a branch, an error message),
wrap it with `data-selectable`.

When you add a new content surface (a new chat-block kind, a new
viewer), confirm that the wrapping element is **not** inside a
`user-select: none` container — or, if it is, add `data-selectable` (or
a more specific rule) so the user can copy.

The policy is enforced by review; there's no lint rule for it. Search
for `user-select` in `src/styles/chrome/` to see the current set of overrides.
