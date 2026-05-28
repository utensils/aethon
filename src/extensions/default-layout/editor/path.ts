/** Show the last 2 path components — full path is kept in the title attribute. */
export function compressPath(filePath: string): string {
  if (!filePath) return "";
  const trimmed = filePath.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return filePath;
  return `…/${parts.slice(-2).join("/")}`;
}
