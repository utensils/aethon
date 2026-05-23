import { describe, expect, it } from "vitest";
import {
  REQUIRED_SLOT_NAMES,
  SLOT_NAMES,
  inspectLayoutSlotCoverage,
  isKnownSlot,
  layoutSlots,
} from "./slots";
import workstationPayload from "./workstation.a2ui.json";

describe("layout-slot catalogue", () => {
  it("ships every documented canonical slot", () => {
    // Lock the canonical list so a future rename is a deliberate
    // breaking change with a test failure to flag it.
    expect(SLOT_NAMES).toEqual([
      "header",
      "sidebar",
      "files-sidebar",
      "tabs",
      "canvas",
      "terminal",
      "composer",
      "status",
      "empty-state",
    ]);
  });

  it("marks canvas + composer as required (no other slots)", () => {
    expect([...REQUIRED_SLOT_NAMES].sort()).toEqual(["canvas", "composer"]);
  });

  it("each slot has description + defaultComposite + required flag", () => {
    for (const [name, def] of Object.entries(layoutSlots.slots)) {
      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(0);
      expect(typeof def.defaultComposite).toBe("string");
      expect(def.defaultComposite.length).toBeGreaterThan(0);
      expect(typeof def.required).toBe("boolean");
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it("isKnownSlot only matches catalogue entries", () => {
    expect(isKnownSlot("canvas")).toBe(true);
    expect(isKnownSlot("composer")).toBe(true);
    expect(isKnownSlot("chat-input")).toBe(false); // legacy area name
    expect(isKnownSlot("")).toBe(false);
  });
});

describe("inspectLayoutSlotCoverage — built-in layouts", () => {
  it("workstation fills every canonical slot except `tabs` (hoisted into header)", () => {
    const r = inspectLayoutSlotCoverage(workstationPayload);
    expect(r.missingRequired).toEqual([]);
    expect(r.unknownAreasUsed).toEqual([]);
    // The redesign moves the chrome tab strip into the header container so
    // only seven of the eight canonical slots are filled. `tabs` is the
    // missing one — the slot stays canonical, just unused at this layer.
    // tabs is hoisted into the header container, so it stays canonical
    // but unfilled at this layer.
    const expected = [...SLOT_NAMES].filter((s) => s !== "tabs").sort();
    expect([...r.filledSlots].sort()).toEqual(expected);
    // workstation uses {$ref} for `areas` so the inspector tags it.
    expect(r.dynamicAreas).toBe(true);
  });

  // Sibling layouts (editorial / command-deck / live-layout) were
  // trimmed while the workstation surface gets focused polish. When
  // they come back, restore their coverage assertions here.
});

describe("inspectLayoutSlotCoverage — edge cases", () => {
  it("flags a layout missing canvas + composer", () => {
    const stub = {
      components: [
        {
          type: "layout",
          props: { columns: "1fr", rows: "1fr", areas: ["status"] },
          children: [
            { id: "x", type: "status-bar", props: { area: "status" } },
          ],
        },
      ],
    };
    const r = inspectLayoutSlotCoverage(stub);
    expect(r.missingRequired).toEqual(expect.arrayContaining(["canvas", "composer"]));
    expect(r.filledSlots).toEqual(["status"]);
  });

  it("collects unknown area names in unknownAreasUsed", () => {
    const stub = {
      components: [
        {
          type: "layout",
          props: { areas: ["custom-pane", "composer", "canvas"] },
          children: [
            { id: "a", type: "card", props: { area: "custom-pane" } },
            { id: "b", type: "main-canvas", props: { area: "canvas" } },
            { id: "c", type: "chat-input", props: { area: "composer" } },
          ],
        },
      ],
    };
    const r = inspectLayoutSlotCoverage(stub);
    expect(r.unknownAreasUsed).toEqual(["custom-pane"]);
    expect(r.missingRequired).toEqual([]);
  });

  it("returns a fully-missing report when the root isn't a <layout>", () => {
    const r = inspectLayoutSlotCoverage({
      components: [{ type: "card", props: {} }],
    });
    expect(r.filledSlots).toEqual([]);
    expect(r.missingRequired).toEqual([...REQUIRED_SLOT_NAMES]);
  });

  it("handles an empty payload without throwing", () => {
    const r = inspectLayoutSlotCoverage({});
    expect(r.filledSlots).toEqual([]);
    expect(r.missingRequired).toEqual([...REQUIRED_SLOT_NAMES]);
  });
});
