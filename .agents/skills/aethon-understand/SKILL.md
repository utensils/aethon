---
name: aethon-understand
description: Use the existing Aethon Understand Anything knowledge graph for architecture, onboarding, dependency, impact-analysis, and codebase-navigation questions in this repository.
---

# Aethon Understand

Use `.understand-anything/knowledge-graph.json` as the first orientation source
for broad Aethon architecture questions, impact analysis, onboarding summaries,
and "where does X live?" investigations.

## Workflow

1. Check `.understand-anything/meta.json` and compare its `gitCommitHash` to
   `git rev-parse HEAD`.
2. If the graph is stale, say so before relying on it. Use it for orientation,
   then verify current behavior against source files before making claims or
   edits.
3. Search the graph with `rg` or structured `jq`; do not dump the whole JSON
   into context.
4. Follow matching `nodes`, their 1-hop `edges`, and related `layers`/`tour`
   entries to identify the relevant files and contracts.
5. Confirm any implementation detail in the live source before editing or
   reporting it as current.

## Useful Commands

```bash
jq '.project' .understand-anything/knowledge-graph.json
jq '{meta: .project, nodes: (.nodes|length), edges: (.edges|length), layers: (.layers|length), tour: (.tour|length)}' .understand-anything/knowledge-graph.json
rg -n '"(name|summary|filePath|id)":.*<term>' .understand-anything/knowledge-graph.json
git rev-parse HEAD
jq '.gitCommitHash // .lastAnalyzedAt' .understand-anything/meta.json
```

The full Understand Anything user-level skills are installed globally as
`understand`, `understand-chat`, `understand-diff`, `understand-dashboard`,
`understand-domain`, `understand-explain`, `understand-knowledge`, and
`understand-onboard`.
