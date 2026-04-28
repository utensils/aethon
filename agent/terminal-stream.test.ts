import { describe, expect, it } from "vitest";
import {
  consumeBashTerminalSnapshot,
  type BashTerminalStreamState,
} from "./terminal-stream";

function consumeAll(snapshots: string[]): string {
  let state: BashTerminalStreamState | undefined;
  let output = "";
  for (const snapshot of snapshots) {
    const update = consumeBashTerminalSnapshot(snapshot, state);
    output += update.delta;
    state = update.state;
  }
  return output;
}

describe("consumeBashTerminalSnapshot", () => {
  it("streams append-only rolling buffers as exact deltas", () => {
    expect(consumeAll(["one", "one\ntwo", "one\ntwo\nthree"])).toBe(
      "one\ntwo\nthree",
    );
  });

  it("does not replay the final result after partial updates", () => {
    let state: BashTerminalStreamState | undefined;
    const first = consumeBashTerminalSnapshot("alpha\n", state);
    state = first.state;
    const second = consumeBashTerminalSnapshot("alpha\nbeta\n", state);
    state = second.state;
    const final = consumeBashTerminalSnapshot("alpha\nbeta\n", state);

    expect(first.delta + second.delta + final.delta).toBe("alpha\nbeta\n");
    expect(final.delta).toBe("");
  });

  it("handles rolling tail truncation by overlapping the old suffix", () => {
    expect(consumeAll([
      "line-001\nline-002\nline-003\n",
      "line-002\nline-003\nline-004\n",
      "line-003\nline-004\nline-005\n",
    ])).toBe(
      "line-001\nline-002\nline-003\nline-004\nline-005\n",
    );
  });

  it("keeps simultaneous bash calls isolated by stream state", () => {
    let first: BashTerminalStreamState | undefined;
    let output = "";

    let update = consumeBashTerminalSnapshot("a1\n", first);
    output += update.delta;
    first = update.state;

    update = consumeBashTerminalSnapshot("b1\n");
    output += update.delta;
    const second = update.state;

    update = consumeBashTerminalSnapshot("a1\na2\n", first);
    output += update.delta;
    first = update.state;

    update = consumeBashTerminalSnapshot("b1\nb2\n", second);
    output += update.delta;

    update = consumeBashTerminalSnapshot("a1\na2\n", first);
    output += update.delta;

    expect(output).toBe("a1\nb1\na2\nb2\n");
  });
});
