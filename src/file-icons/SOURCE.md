# File icons — Material Icon Theme subset

Icons here are vendored from [PKief/vscode-material-icon-theme][upstream]
under the MIT license. The full license text is at `LICENSE` in this
directory.

We vendor a hand-curated subset (~50 icons) rather than the upstream
~1000+ to keep bundle size reasonable. The mapping from
file basename + extension → icon module key lives in `manifest.ts`;
unknown types fall back to `file.svg` (file) or `folder.svg` (directory).

If you need more icons, fetch them from the upstream repo and add
them here, then update `manifest.ts` to wire them. Don't reach across
license boundaries (e.g. don't pull from `vscode-icons` — different
license).

Upstream commit reference (when vendored):
`main` branch of github.com/PKief/vscode-material-icon-theme as of
2026-05 (see git history of this directory for the exact date).

[upstream]: https://github.com/PKief/vscode-material-icon-theme
