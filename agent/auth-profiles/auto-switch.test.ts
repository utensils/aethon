import { describe, expect, it, vi } from "vitest";
import { pickAvailableAccount, type AccountCandidate } from "./auto-switch";

const PROFILES: AccountCandidate[] = [
  { id: "codex-a", providerId: "openai-codex" },
  { id: "codex-b", providerId: "openai-codex" },
  { id: "codex-c", providerId: "openai-codex" },
  { id: "anthropic-x", providerId: "anthropic" },
];

describe("pickAvailableAccount", () => {
  it("returns the first same-provider account with headroom, skipping the current one", async () => {
    // a = current, b = limited, c = available → pick c.
    const probe = vi.fn((id: string) => Promise.resolve(id === "codex-b"));
    const chosen = await pickAvailableAccount(
      PROFILES,
      "openai-codex",
      "codex-a",
      new Set(["codex-a"]),
      probe,
    );
    expect(chosen).toBe("codex-c");
    // Never probed the current account or the other-provider one.
    expect(probe).not.toHaveBeenCalledWith("codex-a", expect.anything());
    expect(probe).not.toHaveBeenCalledWith("anthropic-x", expect.anything());
  });

  it("skips already-tried accounts (loop guard)", async () => {
    const probe = vi.fn(() => Promise.resolve(false)); // everything has headroom
    const chosen = await pickAvailableAccount(
      PROFILES,
      "openai-codex",
      "codex-a",
      new Set(["codex-a", "codex-b"]),
      probe,
    );
    expect(chosen).toBe("codex-c");
  });

  it("returns undefined when every alternative is rate-limited", async () => {
    const probe = vi.fn(() => Promise.resolve(true)); // all limited
    const chosen = await pickAvailableAccount(
      PROFILES,
      "openai-codex",
      "codex-a",
      new Set(["codex-a"]),
      probe,
    );
    expect(chosen).toBeUndefined();
  });

  it("treats an unprobeable account as unusable and moves on", async () => {
    const probe = vi.fn((id: string) => {
      if (id === "codex-b") return Promise.reject(new Error("token dead"));
      return Promise.resolve(false);
    });
    const chosen = await pickAvailableAccount(
      PROFILES,
      "openai-codex",
      "codex-a",
      new Set(["codex-a"]),
      probe,
    );
    expect(chosen).toBe("codex-c");
  });

  it("never crosses providers", async () => {
    const probe = vi.fn(() => Promise.resolve(false));
    const chosen = await pickAvailableAccount(
      PROFILES,
      "openai-codex",
      "codex-a",
      new Set(["codex-a", "codex-b", "codex-c"]),
      probe,
    );
    // Only anthropic-x remains, but it's a different provider → undefined.
    expect(chosen).toBeUndefined();
  });
});
