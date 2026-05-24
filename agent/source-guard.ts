import { isAbsolute, join, resolve } from "node:path";
import type { Agent } from "@mariozechner/pi-agent-core";

const GUARDED_TOOLS = new Set(["write", "edit"]);

const PROTECTED_DIRS = ["src", "src-tauri", "agent"] as const;

export function wrapWithSourceGuard(
  agent: Agent,
  projectRoot: string | undefined,
): void {
  if (!projectRoot) return;

  const prefixes = PROTECTED_DIRS.map((d) => join(projectRoot, d) + "/");

  const original = agent.beforeToolCall;
  agent.beforeToolCall = async (ctx, signal) => {
    if (GUARDED_TOOLS.has(ctx.toolCall.name)) {
      const args = ctx.args as { path?: string } | undefined;
      if (args?.path) {
        const abs = isAbsolute(args.path)
          ? resolve(args.path)
          : resolve(process.cwd(), args.path);
        for (const prefix of prefixes) {
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
    }
    return original?.call(agent, ctx, signal);
  };
}
