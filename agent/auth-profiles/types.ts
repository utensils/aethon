import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthProfileMeta } from "./store";

/** A profile's pi model/auth pair. `modelRuntime` is the async facade
 *  (credentials, login, catalog refresh); `modelRegistry` is its synchronous
 *  projection for hot-path reads. Always resolve them together: the model's
 *  base URL / key live on the runtime the registry was built from. */
export interface AuthProfileServices {
  modelRuntime: ModelRuntime;
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
