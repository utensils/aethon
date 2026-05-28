export interface FsTreeChangedPayload {
  root: string;
  dirs: string[];
}

export function visibleChangedDirs(
  payload: FsTreeChangedPayload,
  projectPath: string,
  watchedDirs: readonly string[],
): string[] {
  if (!projectPath || payload.root !== projectPath) return [];
  const visible = new Set(watchedDirs);
  return payload.dirs.filter((dir) => visible.has(dir));
}
