// @vitest-environment node
//
// Icon externalization (#159): project icons (base64 data: URLs) persist in a
// `project-icons.json` sidecar, NOT inline in projects.json, to keep the hot
// project-list file small. These tests pin the save/load round-trip and the
// automatic migration of a pre-externalization inline icon.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory persist backend keyed by filename.
const store = new Map<string, string>();
vi.mock("./persist", () => ({
  readState: vi.fn((file: string) => Promise.resolve(store.get(file) ?? null)),
  writeState: vi.fn((file: string, content: string) => {
    store.set(file, content);
    return Promise.resolve();
  }),
}));

import {
  emptyProjectsState,
  loadProjects,
  saveProjects,
  upsertProject,
} from "./projects";

const HOST = "local:test";

beforeEach(() => store.clear());
afterEach(() => vi.clearAllMocks());

function projectsWithIcon(iconUrl: string) {
  const { state } = upsertProject(emptyProjectsState(HOST), "/Users/x/aethon");
  state.projects[0].iconUrl = iconUrl;
  return state;
}

describe("project icon externalization", () => {
  it("keeps icons out of projects.json and in the sidecar on save", async () => {
    await saveProjects(projectsWithIcon("data:image/png;base64,AAAA"));

    const main = JSON.parse(store.get("projects.json")!);
    expect(main.projects[0].iconUrl).toBeUndefined();

    const icons = JSON.parse(store.get("project-icons.json")!);
    const id = main.projects[0].id;
    expect(icons[id]).toBe("data:image/png;base64,AAAA");
  });

  it("re-attaches icons from the sidecar on load", async () => {
    await saveProjects(projectsWithIcon("data:image/png;base64,BBBB"));
    const loaded = await loadProjects(HOST);
    expect(loaded.projects[0].iconUrl).toBe("data:image/png;base64,BBBB");
  });

  it("migrates a pre-externalization inline icon, then strips it on next save", async () => {
    // Old-format projects.json: icon embedded inline, no sidecar yet.
    const id = "p1";
    store.set(
      "projects.json",
      JSON.stringify({
        schemaVersion: 3,
        projects: [
          {
            id,
            label: "aethon",
            path: "/Users/x/aethon",
            lastUsed: 1,
            hostId: HOST,
            iconUrl: "data:image/png;base64,OLD",
          },
        ],
        activeId: null,
      }),
    );

    // Load keeps the inline icon (sidecar absent).
    const loaded = await loadProjects(HOST);
    expect(loaded.projects[0].iconUrl).toBe("data:image/png;base64,OLD");

    // Saving externalizes it: stripped from main, written to the sidecar.
    await saveProjects(loaded);
    expect(JSON.parse(store.get("projects.json")!).projects[0].iconUrl).toBeUndefined();
    expect(JSON.parse(store.get("project-icons.json")!)[id]).toBe(
      "data:image/png;base64,OLD",
    );
  });

  it("omits projects without an icon from the sidecar", async () => {
    const { state } = upsertProject(emptyProjectsState(HOST), "/Users/x/noicon");
    await saveProjects(state);
    expect(JSON.parse(store.get("project-icons.json")!)).toEqual({});
  });
});
