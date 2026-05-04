import { describe, expect, it, vi } from "vitest";
import { handleRegisterHighlightGrammar } from "./registerHighlightGrammar";
import { buildHandlerFixture } from "./testFixtures";
import * as highlight from "../../utils/highlight";

describe("handleRegisterHighlightGrammar", () => {
  it("registers a grammar and acks on a valid payload", () => {
    const spy = vi.spyOn(highlight, "registerGrammar").mockImplementation(() => {});
    const { ctx, mocks } = buildHandlerFixture();
    handleRegisterHighlightGrammar(
      {
        type: "register_highlight_grammar",
        lang: "rufus",
        grammar: { scopeName: "source.rufus" },
        mutationId: "m1",
      },
      ctx,
    );
    expect(spy).toHaveBeenCalledWith("rufus", { scopeName: "source.rufus" });
    expect(mocks.ackMutation).toHaveBeenCalledWith("m1", true);
    spy.mockRestore();
  });

  it("acks failure on a missing payload", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleRegisterHighlightGrammar(
      { type: "register_highlight_grammar", mutationId: "m2" },
      ctx,
    );
    expect(mocks.ackMutation).toHaveBeenCalledWith(
      "m2",
      false,
      "register_highlight_grammar: bad payload",
    );
  });
});
