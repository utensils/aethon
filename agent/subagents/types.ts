/**
 * Subagent definitions.
 *
 * A subagent is a named, scoped delegate the main agent can hand a focused
 * task to via the `task` tool (auto-delegation by `description`, or explicit
 * `@name`). Each runs in an isolated pi session with its own model + tool
 * allowlist, so a main agent on (say) `openai/gpt-5.5` can delegate to a
 * subagent on a local Ollama model.
 *
 * Definitions live as one markdown file per subagent with YAML frontmatter:
 *
 *   ~/.aethon/agents/<name>.md            (user scope, global)
 *   <project>/.aethon/agents/<name>.md    (project scope, overrides user)
 *
 *   ---
 *   description: Reviews diffs for correctness and edge cases.
 *   model: ollama/llama3.3
 *   tools: [read, grep, bash]
 *   surface: inline
 *   ---
 *   You are a meticulous code reviewer...   <- markdown body == system prompt
 *
 * The file *stem* is the canonical name and the override key (a project
 * `reviewer.md` shadows a user `reviewer.md`). This module is pure data +
 * parsing; IO lives in {@link ./loader}.
 */

export type SubagentScope = "user" | "project";

/** Where a subagent's run is surfaced in the UI. `inline` streams a nested
 *  tool card inside the delegating turn (default); `tab` opens its own agent
 *  tab via the task launcher. */
export type SubagentSurface = "inline" | "tab";

export interface Subagent {
  /** Canonical name == sanitized file stem; also the override key. */
  name: string;
  /** Drives auto-delegation — the main model picks a subagent by this. */
  description: string;
  /** `provider/model-id` (e.g. `ollama/llama3.3`). Undefined inherits the
   *  delegating tab's model. */
  model?: string;
  /** Tool allowlist. `undefined` inherits the full toolset; `[]` locks the
   *  subagent down to reasoning only (no tools). */
  tools?: string[];
  /** Default `inline`. */
  surface: SubagentSurface;
  /** Markdown body — used as the subagent's system prompt. */
  systemPrompt: string;
  scope: SubagentScope;
  /** Absolute path the definition was loaded from. */
  filePath: string;
}

/** A definition that failed to load/parse. Surfaced to the user (settings /
 *  overview) rather than thrown, so one bad file never breaks the registry. */
export interface SubagentLoadIssue {
  filePath: string;
  scope: SubagentScope;
  error: string;
}

/** Merged effective registry for one cwd (user scope + that project scope,
 *  project-wins-by-name) plus any load issues. */
export interface LoadSubagentsResult {
  byName: Map<string, Subagent>;
  issues: SubagentLoadIssue[];
}
