export type MemoryScopeName = "user" | "project";

export type ProjectMemorySource =
  | "aethon-project"
  | "aethon-workspace"
  | "git-common-dir"
  | "git-toplevel"
  | "cwd";

export interface ProjectMemoryIdentity {
  id: string;
  key: string;
  root: string;
  label: string;
  source: ProjectMemorySource;
  resolvedFromCwd: string;
}

export interface ResolvedMemoryScope {
  scope: MemoryScopeName;
  dir: string;
  memoryPath: string;
  topicsDir: string;
  project?: ProjectMemoryIdentity;
}

export interface ResolvedMemoryContext {
  user: ResolvedMemoryScope;
  project: ResolvedMemoryScope;
  userMemory: string;
  projectMemory: string;
  maxLines?: number;
  maxBytes?: number;
}

export interface RememberInput {
  kind: "instruction" | "preference" | "fact" | "workflow" | "pitfall";
  text: string;
  tags?: string[];
}

export interface RememberResult {
  id: string;
  created: boolean;
  path: string;
}

export interface ForgetInput {
  id?: string;
  text?: string;
}

export interface ForgetResult {
  removed: number;
  path: string;
}
