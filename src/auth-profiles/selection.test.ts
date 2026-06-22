import { describe, expect, it } from "vitest";
import {
  accountsForProvider,
  providerOfModelId,
  resolveSelectableProfileId,
  soleDefaultProfileId,
} from "./selection";

const codexPrimary = { id: "codex-primary", providerId: "openai-codex" };
const codexSecondary = { id: "codex-secondary", providerId: "openai-codex" };
const anthropic = { id: "anthropic-main", providerId: "anthropic" };
const profiles = [codexPrimary, codexSecondary, anthropic];

describe("providerOfModelId", () => {
  it("extracts the provider prefix", () => {
    expect(providerOfModelId("openai-codex/gpt-5.5")).toBe("openai-codex");
  });
  it("returns undefined without a provider prefix", () => {
    expect(providerOfModelId("gpt-5.5")).toBeUndefined();
    expect(providerOfModelId(undefined)).toBeUndefined();
    expect(providerOfModelId("")).toBeUndefined();
  });
});

describe("accountsForProvider", () => {
  it("filters to the model's provider", () => {
    expect(accountsForProvider(profiles, "openai-codex")).toEqual([
      codexPrimary,
      codexSecondary,
    ]);
  });
  it("returns all profiles when the provider is unknown", () => {
    expect(accountsForProvider(profiles, undefined)).toEqual(profiles);
  });
  it("returns an empty list when no profile backs the provider", () => {
    expect(accountsForProvider(profiles, "google")).toEqual([]);
  });
});

describe("soleDefaultProfileId", () => {
  it("returns the only default when exactly one provider is configured", () => {
    expect(soleDefaultProfileId({ "openai-codex": "codex-primary" })).toBe(
      "codex-primary",
    );
  });
  it("returns undefined when zero or multiple defaults exist", () => {
    expect(soleDefaultProfileId({})).toBeUndefined();
    expect(soleDefaultProfileId(undefined)).toBeUndefined();
    expect(
      soleDefaultProfileId({ a: "codex-primary", b: "anthropic-main" }),
    ).toBeUndefined();
  });
});

describe("resolveSelectableProfileId", () => {
  const selectable = [codexPrimary, codexSecondary];
  it("picks the first candidate that is selectable", () => {
    expect(
      resolveSelectableProfileId(
        selectable,
        "anthropic-main", // not selectable for codex — skipped
        "codex-secondary",
      ),
    ).toBe("codex-secondary");
  });
  it("falls back to the first selectable account when no candidate matches", () => {
    expect(
      resolveSelectableProfileId(selectable, undefined, "anthropic-main"),
    ).toBe("codex-primary");
  });
  it("returns undefined when nothing is selectable", () => {
    expect(resolveSelectableProfileId([], "codex-primary")).toBeUndefined();
  });
});
