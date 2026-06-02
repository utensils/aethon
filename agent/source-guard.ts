import { isAbsolute, join, resolve, sep } from "node:path";
import type { Agent } from "@mariozechner/pi-agent-core";

const GUARDED_TOOLS = new Set(["write", "edit"]);

const PROTECTED_DIRS = ["src", "src-tauri", "agent"] as const;

/** Optional hard project-root guardrail layered on top of the always-on
 *  Aethon source guard. When `hardEnforce()` returns true, write/edit/bash
 *  tool calls touching paths outside `tabRoot` are blocked. */
export interface HardGuardOptions {
  /** The tab's working directory (the bash/edit/write tools resolve relative
   *  paths against this). Paths outside it are blocked when enforcement is on. */
  tabRoot?: string;
  /** Live per-tab toggle, read on every tool call so a runtime flip (the
   *  composer guardrail switch) takes effect without re-wrapping the agent. */
  hardEnforce?: () => boolean;
}

/**
 * Wrap `agent.beforeToolCall` with two guards:
 *
 *  1. **Source guard** (always on when `sourceRoot` is set — dev only): blocks
 *     write/edit into Aethon's own `{src,src-tauri,agent}` tree. Extensions go
 *     to `~/.aethon/extensions/` instead.
 *  2. **Hard project-root guard** (opt-in, per tab): when `hardGuard.hardEnforce()`
 *     is true, blocks write/edit (exact, from the structured `path` arg) and
 *     bash (best-effort, from parsed write/cd targets) that escape `tabRoot`.
 *
 * No-op when neither guard applies, preserving the previous release-mode
 * behaviour (no `beforeToolCall` wrapper at all).
 */
export function wrapWithSourceGuard(
  agent: Agent,
  sourceRoot: string | undefined,
  hardGuard?: HardGuardOptions,
): void {
  if (!sourceRoot && !hardGuard?.tabRoot) return;

  const sourcePrefixes = sourceRoot
    ? PROTECTED_DIRS.map((d) => join(sourceRoot, d) + sep)
    : [];

  const original = agent.beforeToolCall;
  // Plain (non-async) wrapper — the body never awaits; it returns a Promise
  // either from the guard verdict or by delegating to `original`.
  agent.beforeToolCall = (ctx, signal) => {
    const verdict = evaluateGuard(ctx, sourcePrefixes, hardGuard);
    if (verdict) return Promise.resolve(verdict);
    return original?.call(agent, ctx, signal) ?? Promise.resolve(undefined);
  };
}

interface GuardCtx {
  toolCall: { name: string };
  args?: unknown;
}

function evaluateGuard(
  ctx: GuardCtx,
  sourcePrefixes: string[],
  hardGuard: HardGuardOptions | undefined,
): { block: true; reason: string } | undefined {
  const name = ctx.toolCall.name;
  const args = ctx.args as { path?: string; command?: string } | undefined;

  // 1. Aethon source guard. Resolve relative paths against process.cwd()
  //    (the agent launch dir == the source root in dev), matching the
  //    original behaviour.
  if (sourcePrefixes.length > 0 && GUARDED_TOOLS.has(name) && args?.path) {
    const abs = isAbsolute(args.path)
      ? resolve(args.path)
      : resolve(process.cwd(), args.path);
    for (const prefix of sourcePrefixes) {
      if (abs.startsWith(prefix) || abs === prefix.slice(0, -1)) {
        return {
          block: true,
          reason:
            `Blocked: "${abs}" is inside Aethon's source tree. ` +
            "Aethon source is not user-editable from inside the agent. " +
            "Write extensions to ~/.aethon/extensions/ instead — " +
            "see $AETHON_DOCS_DIR/extensions.md for authoring guidance.",
        };
      }
    }
  }

  // 2. Hard project-root guard (opt-in). Resolve relative paths against the
  //    tab's working dir, which is where the tools actually run.
  const tabRoot = hardGuard?.tabRoot;
  if (tabRoot && hardGuard?.hardEnforce?.()) {
    if (GUARDED_TOOLS.has(name) && args?.path) {
      const abs = isAbsolute(args.path)
        ? resolve(args.path)
        : resolve(tabRoot, args.path);
      if (!isInsideRoot(abs, tabRoot)) {
        return { block: true, reason: outsideRootReason(name, abs, tabRoot) };
      }
    }
    if (name === "bash" && typeof args?.command === "string") {
      const escapee = bashEscapesRoot(args.command, tabRoot);
      if (escapee) {
        return {
          block: true,
          reason: outsideRootReason("bash", escapee, tabRoot),
        };
      }
    }
  }

  return undefined;
}

function outsideRootReason(tool: string, abs: string, root: string): string {
  return (
    `Guardrail: "${abs}" is outside the active project root "${root}". ` +
    `Hard enforcement is on for this session, so ${tool} operations outside ` +
    "the project are blocked. Work within the project root, or ask the user " +
    "to turn the guardrail off (composer ⋯ menu) if this is intentional."
  );
}

/** True when `abs` is `root` itself or a descendant of it. */
export function isInsideRoot(abs: string, root: string): boolean {
  const r = root.endsWith(sep) ? root.slice(0, -1) : root;
  return abs === r || abs.startsWith(r + sep);
}

/**
 * Best-effort detection of a bash command writing to / cd-ing to a path
 * outside `root`. Returns the first escaping absolute path, or undefined.
 *
 * Catches the common escape patterns — output redirections (`>`, `>>`),
 * `tee`, and `cd` / `pushd` — resolving relative targets against `root`
 * (where the bash tool runs). It deliberately does NOT try to fully parse
 * the shell: `eval`, command substitution, variable expansion, and
 * `cp`/`mv` destinations can slip through. This is a speed-bump against a
 * wandering model, not a sandbox; the write/edit guard above is exact.
 */
export function bashEscapesRoot(
  command: string,
  root: string,
): string | undefined {
  for (const candidate of extractBashTargets(command)) {
    const abs = isAbsolute(candidate)
      ? resolve(candidate)
      : resolve(root, candidate);
    if (!isInsideRoot(abs, root)) return abs;
  }
  return undefined;
}

function extractBashTargets(command: string): string[] {
  const targets: string[] = [];
  const push = (re: RegExp, group: number) => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(command)) !== null) {
      const v = m[group];
      if (v) targets.push(v);
    }
  };
  // Output redirection: `> path`, `>> path` (skip fd-dup `>&` and stderr
  // `2>` — the char before `>` must not be a digit or `>`).
  push(/(?:^|[^0-9>])>>?\s*(['"]?)([^\s'"|&;<>]+)\1/g, 2);
  // `tee [-a] path` (write side of a pipe).
  push(/\btee\s+(?:-a\s+)?(['"]?)([^\s'"|&;<>]+)\1/g, 2);
  // `cd` / `pushd` — a working-dir escape, even without a write.
  push(/\b(?:cd|pushd)\s+(['"]?)([^\s'"|&;<>]+)\1/g, 2);
  return targets;
}
