import { describe, expect, it } from "vitest";
import { handlePalette } from "./palette";
import { buildRouteFixture } from "./testFixtures";

describe("handlePalette", () => {
  it("close calls closePalette", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handlePalette(
      { component: { id: "command-palette" }, eventType: "close" },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.closePalette).toHaveBeenCalledTimes(1);
  });

  it("query writes /palette/query and resets selectedIndex", async () => {
    const { ctx, applySetState } = buildRouteFixture({
      state: { palette: { open: true, query: "old", selectedIndex: 5 } },
    });
    await handlePalette(
      {
        component: { id: "command-palette" },
        eventType: "query",
        data: { value: "new" },
      },
      ctx,
    );
    const next = applySetState({
      palette: { open: true, query: "old", selectedIndex: 5 },
    });
    expect(next.palette).toEqual({
      open: true,
      query: "new",
      selectedIndex: 0,
    });
  });

  it("navigate updates only selectedIndex", async () => {
    const { ctx, applySetState } = buildRouteFixture();
    await handlePalette(
      {
        component: { id: "command-palette" },
        eventType: "navigate",
        data: { index: 3 },
      },
      ctx,
    );
    const next = applySetState({
      palette: { open: true, query: "q", selectedIndex: 0 },
    });
    expect(next.palette).toEqual({
      open: true,
      query: "q",
      selectedIndex: 3,
    });
  });

  it("select closes palette and runs the item", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const item = { kind: "tab" as const, tabId: "abc", label: "tab abc" };
    const handled = await handlePalette(
      {
        component: { id: "command-palette" },
        eventType: "select",
        data: { item },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.closePalette).toHaveBeenCalledTimes(1);
    expect(mocks.runPaletteItem).toHaveBeenCalledWith(item);
  });
});
