export interface BashTerminalStreamState {
  snapshot: string;
}

export interface BashTerminalStreamUpdate {
  delta: string;
  state: BashTerminalStreamState;
}

export function consumeBashTerminalSnapshot(
  snapshot: string,
  previous?: BashTerminalStreamState,
): BashTerminalStreamUpdate {
  const prev = previous?.snapshot ?? "";
  if (snapshot.length === 0 || snapshot === prev) {
    return { delta: "", state: { snapshot } };
  }
  if (prev.length === 0) {
    return { delta: snapshot, state: { snapshot } };
  }
  if (snapshot.startsWith(prev)) {
    return { delta: snapshot.slice(prev.length), state: { snapshot } };
  }

  const overlap = longestSuffixPrefixOverlap(prev, snapshot);
  return { delta: snapshot.slice(overlap), state: { snapshot } };
}

function longestSuffixPrefixOverlap(previous: string, current: string): number {
  const max = Math.min(previous.length, current.length);
  if (max === 0) return 0;

  const pattern = current.slice(0, max);
  const text = previous.slice(previous.length - max);
  const lps = buildPrefixTable(pattern);
  let matched = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    while (matched > 0 && ch !== pattern[matched]) {
      matched = lps[matched - 1];
    }
    if (ch === pattern[matched]) {
      matched += 1;
      if (matched === pattern.length) {
        continue;
      }
    }
  }

  return matched;
}

function buildPrefixTable(pattern: string): number[] {
  const lps = new Array<number>(pattern.length).fill(0);
  let len = 0;
  for (let i = 1; i < pattern.length; i += 1) {
    while (len > 0 && pattern[i] !== pattern[len]) {
      len = lps[len - 1];
    }
    if (pattern[i] === pattern[len]) {
      len += 1;
      lps[i] = len;
    }
  }
  return lps;
}
