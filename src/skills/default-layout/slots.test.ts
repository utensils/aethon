import { describe, expect, it } from "vitest";
import {
  REQUIRED_SLOT_NAMES,
  SLOT_NAMES,
  inspectLayoutSlotCoverage,
  isKnownSlot,
  layoutSlots,
} from "./slots";
import layoutPayload from "./layout.a2ui.json";
import singlePanePayload from "./single-pane.a2ui.json";
import focusModePayload from "./focus-mode.a2ui.json";

describe("layout-slot catalogue", () => {
  it("ships every documented canonical slot", () => {
    // Lock the canonical list so a future rename is a deliberate
    // breaking change with a test failure to flag it.
    expect(SLOT_NAMES).toEqual([
      "header",
      "sidebar",
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
  it("default-layout fills every canonical slot", () => {
    const r = inspectLayoutSlotCoverage(layoutPayload);
    expect(r.missingRequired).toEqual([]);
    expect(r.unknownAreasUsed).toEqual([]);
    expect([...r.filledSlots].sort()).toEqual([...SLOT_NAMES].sort());
    // default-layout uses {$ref} for `areas` so the inspector tags it.
    expect(r.dynamicAreas).toBe(true);
  });

  it("single-pane covers required slots, omits sidebar/terminal", () => {
    const r = inspectLayoutSlotCoverage(singlePanePayload);
    expect(r.missingRequired).toEqual([]);
    expect(r.unknownAreasUsed).toEqual([]);
    expect(r.filledSlots).toContain("canvas");
    expect(r.filledSlots).toContain("composer");
    expect(r.filledSlots).not.toContain("sidebar");
    expect(r.filledSlots).not.toContain("terminal");
    expect(r.dynamicAreas).toBe(false);
  });

  it("focus-mode is the minimum viable layout", () => {
    const r = inspectLayoutSlotCoverage(focusModePayload);
    expect(r.missingRequired).toEqual([]);
    expect([...r.filledSlots].sort()).toEqual(["canvas", "composer", "status"]);
  });
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
