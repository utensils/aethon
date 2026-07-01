import { describe, expect, it } from "vitest";
import {
  SPEECH_SOURCE_CAP,
  createSpeechChunker,
  stripForSpeechSource,
} from "./speechChunker";

describe("createSpeechChunker", () => {
  it("holds short fragments until a clause boundary past the minimum", () => {
    const chunker = createSpeechChunker();
    expect(chunker.push("Sure, I'll get started")).toEqual([]);
    expect(
      chunker.push(" on that right away. It should only take a moment"),
    ).toEqual(["Sure, I'll get started on that right away."]);
    expect(chunker.flush()).toBe("It should only take a moment");
  });

  it("emits the largest ready clause run, not one clause at a time", () => {
    const chunker = createSpeechChunker();
    const chunks = chunker.push(
      "First sentence here, fairly long. Second one lands too! And a tail",
    );
    expect(chunks).toEqual([
      "First sentence here, fairly long. Second one lands too!",
    ]);
    expect(chunker.flush()).toBe("And a tail");
  });

  it("does not split on decimals", () => {
    const chunker = createSpeechChunker();
    const chunks = chunker.push(
      "The version is now 3.5 which everybody wanted since forever, right",
    );
    expect(chunks).toEqual([]);
    expect(chunker.flush()).toContain("3.5");
  });

  it("reset drops the buffer", () => {
    const chunker = createSpeechChunker();
    chunker.push("something partial");
    chunker.reset();
    expect(chunker.flush()).toBe("");
  });
});

describe("stripForSpeechSource", () => {
  it("removes fenced code and caps length", () => {
    const text = `Done.\n\`\`\`ts\nconst x = 1;\n\`\`\`\nAll green.`;
    const out = stripForSpeechSource(text);
    expect(out).not.toContain("const x");
    expect(out).toContain("Done.");
    expect(out).toContain("All green.");
    expect(stripForSpeechSource("x".repeat(10_000))).toHaveLength(
      SPEECH_SOURCE_CAP,
    );
  });
});
