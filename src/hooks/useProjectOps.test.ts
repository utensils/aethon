import { describe, expect, it } from "vitest";
import { NO_PROJECT_KEY } from "../types/tab";
import {
  blankTabForProjectBucket,
  projectIdFromBucketKey,
} from "./useProjectOps";

describe("projectIdFromBucketKey", () => {
  it("maps the no-project bucket back to null", () => {
    expect(projectIdFromBucketKey(NO_PROJECT_KEY)).toBeNull();
    expect(projectIdFromBucketKey("project-1")).toBe("project-1");
  });
});

describe("blankTabForProjectBucket", () => {
  it("creates a fresh Tab 1 for an empty project bucket", () => {
    const tab = blankTabForProjectBucket(
      {
        model: "openai/gpt-5.5",
        projectModels: { "project-1": "anthropic/claude-opus-4-7" },
      },
      "project-1",
      "openai/gpt-5-mini",
    );

    expect(tab).toMatchObject({
      id: "default",
      label: "Tab 1",
      projectId: "project-1",
      messages: [],
      canvas: null,
      model: "anthropic/claude-opus-4-7",
    });
  });
});
