import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type AuthProfileKind = "oauth" | "api_key";

export interface AuthProfileMeta {
  id: string;
  providerId: string;
  label: string;
  kind: AuthProfileKind;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface AuthProfilesState {
  version: 1;
  profiles: AuthProfileMeta[];
  defaultByProvider: Record<string, string>;
}

const EMPTY_STATE: AuthProfilesState = {
  version: 1,
  profiles: [],
  defaultByProvider: {},
};

export function authProfilesDir(userDir: string): string {
  return join(userDir, "auth");
}

export function authProfilesStatePath(userDir: string): string {
  return join(authProfilesDir(userDir), "profiles.json");
}

export function authProfileAuthPath(userDir: string, profileId: string): string {
  return join(authProfilesDir(userDir), "profiles", profileId, "auth.json");
}

export function sanitizeProfileId(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "account";
}

export function loadAuthProfilesState(userDir: string): AuthProfilesState {
  const path = authProfilesStatePath(userDir);
  if (!existsSync(path)) return { ...EMPTY_STATE, defaultByProvider: {} };
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<AuthProfilesState>;
  const profiles = Array.isArray(parsed.profiles)
    ? parsed.profiles.filter(isProfileMeta)
    : [];
  const ids = new Set(profiles.map((p) => p.id));
  const defaultByProvider: Record<string, string> = {};
  for (const [provider, profileId] of Object.entries(parsed.defaultByProvider ?? {})) {
    if (ids.has(profileId)) defaultByProvider[provider] = profileId;
  }
  return { version: 1, profiles, defaultByProvider };
}

export function saveAuthProfilesState(userDir: string, state: AuthProfilesState): void {
  const path = authProfilesStatePath(userDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

export function createProfileMeta(
  state: AuthProfilesState,
  input: {
    providerId: string;
    label: string;
    kind: AuthProfileKind;
    now?: number;
  },
): AuthProfileMeta {
  const now = input.now ?? Date.now();
  const base = sanitizeProfileId(`${input.providerId}-${input.label}`);
  const used = new Set(state.profiles.map((p) => p.id));
  let id = base;
  for (let i = 2; used.has(id); i += 1) id = `${base}-${i}`;
  return {
    id,
    providerId: input.providerId,
    label: input.label.trim() || input.providerId,
    kind: input.kind,
    createdAt: now,
    updatedAt: now,
  };
}

export function upsertProfileMeta(
  state: AuthProfilesState,
  meta: AuthProfileMeta,
): AuthProfilesState {
  const profiles = state.profiles.filter((p) => p.id !== meta.id);
  profiles.push(meta);
  profiles.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.label.localeCompare(b.label));
  return { ...state, profiles };
}

export function deleteProfileFiles(userDir: string, profileId: string): void {
  rmSync(join(authProfilesDir(userDir), "profiles", profileId), {
    recursive: true,
    force: true,
  });
}

function isProfileMeta(value: unknown): value is AuthProfileMeta {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.id === "string" &&
    typeof rec.providerId === "string" &&
    typeof rec.label === "string" &&
    (rec.kind === "oauth" || rec.kind === "api_key") &&
    typeof rec.createdAt === "number" &&
    typeof rec.updatedAt === "number"
  );
}
