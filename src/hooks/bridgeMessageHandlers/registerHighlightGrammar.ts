import { registerGrammar as registerHighlightGrammar } from "../../utils/highlight";
import type { BridgeMessageHandler } from "./types";

/** Extension surface for the `code` primitive: a TextMate grammar for a
 *  language Shiki doesn't ship by default. Forward to the worker; bridge
 *  already validated lang + grammar shape, so we trust the payload. */
export const handleRegisterHighlightGrammar: BridgeMessageHandler = (data, ctx) => {
  const lang = data.lang as string | undefined;
  const grammar = data.grammar;
  if (typeof lang === "string" && grammar) {
    registerHighlightGrammar(lang, grammar);
    ctx.ackMutation(data.mutationId, true);
  } else {
    ctx.ackMutation(data.mutationId, false, "register_highlight_grammar: bad payload");
  }
};
