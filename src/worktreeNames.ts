// Auto-generated worktree branch names from the Helios pantheon — the
// figures around the sun, dawn, wind, and sky that share mythological
// space with the app's namesake (Aethon, "blazing horse" of Helios).
//
// Used by sidebar context-menu "Create worktree…" so the user never
// has to type a branch name. Same pool is exposed to the task launcher
// composer as the placeholder suggestion, but it accepts user input
// — auto-gen is the no-click default, manual is the override.
//
// Collisions: when the chosen name is already a branch on the repo,
// append `-2`, `-3`, … until free. Caller passes `taken` so we can
// check both git's branch list AND the in-memory pending worktrees.

const HELIOS_POOL = [
  // Helios chariot horses (CLAUDE.md says Aethon is the namesake).
  "aethon",
  "phlegon",
  "pyrois",
  "eous",
  // Sun + dawn deities.
  "helios",
  "sol",
  "eos",
  "aurora",
  "hyperion",
  "phaethon",
  "selene",
  "luna",
  // Wind gods.
  "boreas",
  "zephyr",
  "notus",
  "eurus",
  // Sky / weather / rainbow.
  "iris",
  "uranus",
  "nyx",
  "hemera",
  "astraeus",
  "asteria",
  // Constellations / stellar mythology.
  "orion",
  "lyra",
  "vega",
  "sirius",
  "altair",
  "rigel",
  "antares",
  "polaris",
];

const BRANCH_PREFIX = "feat";

function shuffled<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Pick a Helios-pantheon name not already in `taken`. Caller supplies
 *  `taken` as the union of existing branch names + pending worktree
 *  branches so we don't collide with either. If the entire pool is
 *  exhausted, append a numeric suffix to a random base. */
export function pickWorktreeName(taken: Iterable<string>): string {
  const used = new Set<string>();
  for (const t of taken) used.add(stripPrefix(t).toLowerCase());
  for (const candidate of shuffled(HELIOS_POOL)) {
    if (!used.has(candidate)) return `${BRANCH_PREFIX}/${candidate}`;
  }
  // Pool exhausted — keep going with `<name>-N` until free.
  const base = HELIOS_POOL[Math.floor(Math.random() * HELIOS_POOL.length)];
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return `${BRANCH_PREFIX}/${candidate}`;
  }
  // Astronomical fallback — should never reach here.
  return `${BRANCH_PREFIX}/${base}-${Date.now()}`;
}

function stripPrefix(branch: string): string {
  // Allow comparing with or without the `feat/` prefix so manual
  // `feat/zephyr` doesn't get re-picked as bare `zephyr`.
  const slash = branch.indexOf("/");
  return slash >= 0 ? branch.slice(slash + 1) : branch;
}

/** Test-only — exposes the pool length for collision-coverage tests. */
export const _POOL_SIZE_FOR_TESTS = HELIOS_POOL.length;
