import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  authProfileAuthPath,
  createProfileMeta,
  loadAuthProfilesState,
  saveAuthProfilesState,
  upsertProfileMeta,
} from "./store";

describe("auth profile store", () => {
  it("persists profile metadata without credential values", () => {
    const userDir = mkdtempSync(join(tmpdir(), "aethon-auth-"));
    let state = loadAuthProfilesState(userDir);
    const profile = createProfileMeta(state, {
      providerId: "anthropic",
      label: "work",
      kind: "oauth",
      now: 1,
    });
    state = upsertProfileMeta(state, profile);
    state.defaultByProvider.anthropic = profile.id;
    saveAuthProfilesState(userDir, state);

    const raw = readFileSync(join(userDir, "auth", "profiles.json"), "utf8");
    expect(raw).not.toContain("access");
    expect(raw).not.toContain("refresh");
    expect(loadAuthProfilesState(userDir)).toEqual(state);
  });

  it("allocates separate pi-compatible auth paths for accounts", () => {
    const userDir = mkdtempSync(join(tmpdir(), "aethon-auth-"));
    const initial = loadAuthProfilesState(userDir);
    const first = createProfileMeta(initial, {
      providerId: "anthropic",
      label: "Claude Pro",
      kind: "oauth",
      now: 1,
    });
    const second = createProfileMeta(upsertProfileMeta(initial, first), {
      providerId: "anthropic",
      label: "Claude Pro",
      kind: "oauth",
      now: 2,
    });

    expect(first.id).toBe("anthropic-claude-pro");
    expect(second.id).toBe("anthropic-claude-pro-2");
    expect(authProfileAuthPath(userDir, first.id)).not.toBe(
      authProfileAuthPath(userDir, second.id),
    );
    expect(authProfileAuthPath(userDir, first.id)).toMatch(/auth\.json$/);
  });
});
