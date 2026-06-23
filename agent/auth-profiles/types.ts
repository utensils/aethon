import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { AuthProfileMeta } from "./store";

export interface AuthProfileServices {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  authPath?: string;
  authMtimeMs?: number;
}

export interface AuthProfileProvider {
  id: string;
  label: string;
  kind: "oauth" | "api_key";
  configured: boolean;
  modelCount: number;
}

export interface AuthProfilesSnapshot {
  profiles: AuthProfileMeta[];
  defaultByProvider: Record<string, string>;
  providers: AuthProfileProvider[];
  activeByTab: Record<string, string>;
}
