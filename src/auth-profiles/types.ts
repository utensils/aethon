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

export interface AuthProfileProvider {
  id: string;
  label: string;
  kind: AuthProfileKind;
  configured: boolean;
  modelCount: number;
}

export interface AuthProfilesSnapshot {
  profiles: AuthProfileMeta[];
  defaultByProvider: Record<string, string>;
  providers: AuthProfileProvider[];
  activeByTab: Record<string, string>;
}

export interface AuthProfileLoginEvent {
  type: "started" | "auth" | "progress" | "prompt" | "complete";
  challengeId: string;
  profileId: string;
  providerId: string;
  url?: string;
  instructions?: string;
  message?: string;
  placeholder?: string;
  allowEmpty?: boolean;
  ok?: boolean;
  error?: string;
}

export interface AuthProfilesUiState extends AuthProfilesSnapshot {
  modal?: {
    open?: boolean;
  };
  login?: AuthProfileLoginEvent;
}

export const EMPTY_AUTH_PROFILES: AuthProfilesSnapshot = {
  profiles: [],
  defaultByProvider: {},
  providers: [],
  activeByTab: {},
};
