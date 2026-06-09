import { describe, expect, test } from "vitest";
import { FRONTEND_REGISTRY_TYPES, withWorkerOrigin } from "./origin-gate";

describe("withWorkerOrigin", () => {
  test("stamps originTabId on every frontend-registry type", () => {
    const sent: Record<string, unknown>[] = [];
    const send = withWorkerOrigin((obj) => sent.push(obj), "tab-a");

    for (const type of FRONTEND_REGISTRY_TYPES) {
      send({ type, mutationId: "m1" });
    }

    expect(sent).toHaveLength(FRONTEND_REGISTRY_TYPES.size);
    for (const obj of sent) {
      expect(obj["originTabId"]).toBe("tab-a");
    }
  });

  test("does not mutate the caller's object", () => {
    const sent: Record<string, unknown>[] = [];
    const send = withWorkerOrigin((obj) => sent.push(obj), "tab-a");
    const original = { type: "layout_set", payload: {} };

    send(original);

    expect("originTabId" in original).toBe(false);
    expect(sent[0]?.["originTabId"]).toBe("tab-a");
  });

  test("passes chat-stream and lifecycle messages through unstamped", () => {
    const sent: Record<string, unknown>[] = [];
    const send = withWorkerOrigin((obj) => sent.push(obj), "tab-a");

    for (const type of [
      "response_delta",
      "response_end",
      "prompt_started",
      "tab_ready",
      "worker_ready",
      "notification",
      "notice",
      "state_patch",
      "error",
    ]) {
      send({ type });
    }

    for (const obj of sent) {
      expect("originTabId" in obj).toBe(false);
    }
  });

  test("ignores messages without a string type", () => {
    const sent: Record<string, unknown>[] = [];
    const send = withWorkerOrigin((obj) => sent.push(obj), "tab-a");

    send({ payload: 1 });

    expect(sent).toEqual([{ payload: 1 }]);
  });
});
