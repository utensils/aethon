import { describe, expect, it } from "vitest";
import { handleSearch } from "./search";
import { buildRouteFixture } from "./testFixtures";

describe("handleSearch", () => {
  it("close calls closeSessionSearch", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleSearch(
      { component: { id: "search-panel" }, eventType: "close" },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.closeSessionSearch).toHaveBeenCalledTimes(1);
  });

  it("query forwards the search string", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleSearch(
      {
        component: { id: "search-panel" },
        eventType: "query",
        data: { value: "needle" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.setSearchQuery).toHaveBeenCalledWith("needle");
  });

  it("scope=current narrows the search", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleSearch(
      {
        component: { id: "search-panel" },
        eventType: "scope",
        data: { scope: "current" },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.setSearchScope).toHaveBeenCalledWith("current");
  });

  it("select opens the chosen hit", async () => {
    const { ctx, mocks } = buildRouteFixture();
    const handled = await handleSearch(
      {
        component: { id: "search-panel" },
        eventType: "select",
        data: { hit: { tabId: "abc", snippetMatch: "needle" } },
      },
      ctx,
    );
    expect(handled).toBe(true);
    expect(mocks.openSearchHit).toHaveBeenCalledWith({
      tabId: "abc",
      snippetMatch: "needle",
    });
  });
});
