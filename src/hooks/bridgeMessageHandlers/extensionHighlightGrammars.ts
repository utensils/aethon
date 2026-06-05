import { registerGrammar as registerHighlightGrammar } from "../../utils/highlight";
import type { BridgeMessageHandler } from "./types";

export interface ExtensionHighlightGrammar {
  lang: string;
  grammar: unknown;
}

export function replayHighlightGrammars(
  grammars: readonly ExtensionHighlightGrammar[],
): void {
  for (const entry of grammars) {
    if (
      entry &&
      typeof entry.lang === "string" &&
      entry.lang.trim().length > 0 &&
      entry.grammar
    ) {
      registerHighlightGrammar(entry.lang.trim(), entry.grammar);
    }
  }
}

export const handleExtensionHighlightGrammars: BridgeMessageHandler = (
  data,
  ctx,
) => {
  const grammars =
    (data.grammars as ExtensionHighlightGrammar[] | undefined) ?? [];
  replayHighlightGrammars(grammars);
  ctx.ackMutation(data.mutationId, true);
};
