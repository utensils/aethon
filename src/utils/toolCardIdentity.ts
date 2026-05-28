export function normalizeToolCallId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 96);
}

export function toolCardIdentityFromId(id: string): string | undefined {
  if (id.startsWith("restored-tool-")) {
    return id.slice("restored-tool-".length);
  }
  const liveMatch = /^tool-\d+-(.+)$/.exec(id);
  if (liveMatch) {
    return normalizeToolCallId(liveMatch[1]);
  }
  return undefined;
}
