import { describe, expect, it } from "vitest";

import {
  dueGitFetchPaths,
  GIT_FETCH_INTERVAL_MS,
  uniqueProjectPaths,
  type GitFetchCadenceState,
} from "./gitFetchScheduler";

function state(
  lastAttemptedAt: Array<[string, number]> = [],
  inFlight: string[] = [],
): GitFetchCadenceState {
  return {
    lastAttemptedAt: new Map(lastAttemptedAt),
    inFlight: new Set(inFlight),
  };
}

describe("git fetch scheduler", () => {
  it("deduplicates project paths while preserving order", () => {
    expect(uniqueProjectPaths(["/repo", "/repo", "/other", "", "/other"])).toEqual([
      "/repo",
      "/other",
    ]);
  });

  it("fetches projects with no prior attempt", () => {
    expect(dueGitFetchPaths(["/repo"], state(), 1_000)).toEqual(["/repo"]);
  });

  it("skips projects fetched recently or already in flight", () => {
    const now = 20_000;
    expect(
      dueGitFetchPaths(
        ["/fresh", "/stale", "/busy"],
        state(
          [
            ["/fresh", now - GIT_FETCH_INTERVAL_MS + 1],
            ["/stale", now - GIT_FETCH_INTERVAL_MS],
          ],
          ["/busy"],
        ),
        now,
      ),
    ).toEqual(["/stale"]);
  });

  it("uses the configured cadence for focus/interval checks", () => {
    const now = 1_000_000;
    const cadence = 15_000;
    expect(
      dueGitFetchPaths(["/repo"], state([["/repo", now - cadence + 1]]), now, cadence),
    ).toEqual([]);
    expect(
      dueGitFetchPaths(["/repo"], state([["/repo", now - cadence]]), now, cadence),
    ).toEqual(["/repo"]);
  });
});
