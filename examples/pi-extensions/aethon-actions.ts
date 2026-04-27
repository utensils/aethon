/**
 * Pi extension example — demonstrates `ctx.pi` integration.
 *
 * Adds a sidebar section "Quick Actions" whose items fire LLM turns
 * directly from the click handler — no user typing. This is the
 * difference between Aethon's UI surface and a static dashboard:
 * buttons can drive the agent. Combine with registerComponent +
 * onEvent to build action panels for any workflow.
 *
 * Install: copy or symlink into `~/.pi/agent/extensions/`.
 */

/// <reference path="./aethon-types.d.ts" />

interface PiExtensionApi {
  registerCommand?(name: string, options: unknown): void;
}

export default function (_api: PiExtensionApi): void {
  if (!globalThis.aethon) return;
  const aethon = globalThis.aethon;

  aethon.registerSidebarSection({
    id: "quick-actions",
    title: "Quick Actions",
    items: [
      { id: "summarize-git-log", label: "Summarize recent commits" },
      { id: "explain-readme", label: "Explain README" },
      { id: "list-models", label: "Show current model" },
    ],
  });

  aethon.onEvent(
    { componentType: "sidebar", eventType: "select" },
    async (event, ctx) => {
      const data = event.data as { sectionId?: string; itemId?: string } | undefined;
      if (data?.sectionId !== "quick-actions") return;

      switch (data.itemId) {
        case "summarize-git-log": {
          ctx.pi.notify("Asking the agent to summarize recent commits…");
          await ctx.pi.prompt(
            "Run `git log --oneline -10` and summarize the recent commits in 3-5 bullets.",
          );
          return;
        }
        case "explain-readme": {
          ctx.pi.notify("Asking the agent to explain README.md…");
          await ctx.pi.prompt(
            "Read README.md and explain what this project does in two paragraphs.",
          );
          return;
        }
        case "list-models": {
          // Read-only ctx.pi.session demo — no LLM round-trip needed.
          ctx.pi.notify(`Current model: ${ctx.pi.session.model || "(none)"}`);
          ctx.setState("/canvas", {
            components: [
              {
                id: "current-model-card",
                type: "card",
                props: {
                  title: "Current model",
                  description: ctx.pi.session.model || "(no model set)",
                },
                children: [
                  {
                    id: "current-model-msgcount",
                    type: "text",
                    props: {
                      content: `${ctx.pi.session.messages.length} messages in current session`,
                      variant: "small",
                      color: "var(--text-dim)",
                    },
                  },
                ],
              },
            ],
          });
          return;
        }
      }
    },
  );
}
