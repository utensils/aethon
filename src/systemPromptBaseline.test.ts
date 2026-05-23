import { describe, expect, it } from "vitest";
import {
  buildEditableSystemPromptBaseline,
  DEFAULT_AETHON_SYSTEM_PROMPT,
} from "./systemPromptBaseline";

describe("system prompt baseline", () => {
  it("extracts the bridge's default Aethon prompt for editor seeding", () => {
    expect(DEFAULT_AETHON_SYSTEM_PROMPT).toContain("# About Aethon");
    expect(DEFAULT_AETHON_SYSTEM_PROMPT).toContain(
      "`globalThis.aethon.getRuntimeSnapshot()`",
    );
  });

  it("explains why the live runtime snapshot is not persisted", () => {
    const baseline = buildEditableSystemPromptBaseline();
    expect(baseline).toContain(DEFAULT_AETHON_SYSTEM_PROMPT);
    expect(baseline).toContain(
      "live runtime snapshot and system-prompt-append.md",
    );
  });
});
