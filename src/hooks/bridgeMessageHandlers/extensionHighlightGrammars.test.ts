import { describe, expect, it, vi } from "vitest";
import { handleExtensionHighlightGrammars } from "./extensionHighlightGrammars";
import { buildHandlerFixture } from "./testFixtures";
import * as highlight from "../../utils/highlight";

describe("handleExtensionHighlightGrammars", () => {
  it("replays valid grammars and acks", () => {
    const spy = vi.spyOn(highlight, "registerGrammar").mockImplementation(() => {});
    const { ctx, mocks } = buildHandlerFixture();
    handleExtensionHighlightGrammars(
      {
        type: "extension_highlight_grammars",
        mutationId: "m1",
        grammars: [
          { lang: "lean", grammar: { scopeName: "source.lean" } },
          { lang: "", grammar: { scopeName: "bad" } },
        ],
      },
      ctx,
    );
    expect(spy).toHaveBeenCalledWith("lean", { scopeName: "source.lean" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(mocks.ackMutation).toHaveBeenCalledWith("m1", true);
    spy.mockRestore();
  });
});
