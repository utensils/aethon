import { describe, expect, it } from "vitest";
import {
  devshellNeedsPreparation,
  initialDevshellTerminalBuffer,
} from "./devshellTerminal";
import { TERMINAL_REPLAY_MAX } from "./constants";

describe("devshell terminal seed helpers", () => {
  it("seeds a loading line when the matching workspace devshell is resolving", () => {
    const state = {
      devshell: {
        entries: {
          "/worktrees/nyc": { state: "resolving" },
        },
      },
    };

    expect(devshellNeedsPreparation(state, "/worktrees/nyc/feature")).toBe(true);
    expect(initialDevshellTerminalBuffer(state, "/worktrees/nyc/feature")).toBe(
      "[devshell] Preparing Nix devshell for this workspace...\r\n",
    );
  });

  it("replays retained output from the most specific matching workspace root", () => {
    const state = {
      devshell: {
        entries: {
          "/worktrees/nyc": { state: "resolving" },
          "/worktrees/nyc/feature": { state: "ready" },
        },
        outputByRoot: {
          "/worktrees/nyc": "parent output\r\n",
          "/worktrees/nyc/feature": "feature output\r\n",
        },
      },
    };

    expect(initialDevshellTerminalBuffer(state, "/worktrees/nyc/feature")).toBe(
      "feature output\r\n",
    );
  });

  it("trims retained output to the terminal replay cap", () => {
    const output = "x".repeat(TERMINAL_REPLAY_MAX + 10);
    const state = {
      devshell: {
        outputByRoot: {
          "/repo": output,
        },
      },
    };

    const seeded = initialDevshellTerminalBuffer(state, "/repo");
    expect(seeded).toHaveLength(TERMINAL_REPLAY_MAX);
    expect(seeded).toBe(output.slice(10));
  });
});
