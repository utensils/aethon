import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  authProfileAuthPath,
  authProfilesStatePath,
  createProfileMeta,
  deleteProfileFiles,
  isSafeProfileId,
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

  it("falls back to an empty state when profiles.json is corrupt", () => {
    const userDir = mkdtempSync(join(tmpdir(), "aethon-auth-"));
    mkdirSync(dirname(authProfilesStatePath(userDir)), { recursive: true });
    writeFileSync(authProfilesStatePath(userDir), "{not json");

    expect(loadAuthProfilesState(userDir)).toEqual({
      version: 1,
      profiles: [],
      defaultByProvider: {},
    });
  });

  it("ignores unsafe profile ids when loading metadata", () => {
    const userDir = mkdtempSync(join(tmpdir(), "aethon-auth-"));
    mkdirSync(dirname(authProfilesStatePath(userDir)), { recursive: true });
    writeFileSync(
      authProfilesStatePath(userDir),
      JSON.stringify({
        version: 1,
        profiles: [
          {
            id: "../escape",
            providerId: "anthropic",
            label: "bad",
            kind: "oauth",
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: "anthropic-safe",
            providerId: "anthropic",
            label: "safe",
            kind: "oauth",
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        defaultByProvider: {
          anthropic: "../escape",
          openai: 123,
        },
      }),
    );

    expect(loadAuthProfilesState(userDir)).toEqual({
      version: 1,
      profiles: [
        expect.objectContaining({
          id: "anthropic-safe",
          providerId: "anthropic",
        }),
      ],
      defaultByProvider: {},
    });
  });

  it("rejects unsafe profile ids before filesystem operations", () => {
    const userDir = mkdtempSync(join(tmpdir(), "aethon-auth-"));

    expect(isSafeProfileId("anthropic-claude-pro_2")).toBe(true);
    expect(isSafeProfileId("../escape")).toBe(false);
    expect(() => authProfileAuthPath(userDir, "../escape")).toThrow(
      /Invalid auth profile id/,
    );
    expect(() => deleteProfileFiles(userDir, "../escape")).toThrow(
      /Invalid auth profile id/,
    );
  });
});
