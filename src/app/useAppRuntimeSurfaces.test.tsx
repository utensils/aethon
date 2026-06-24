// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  useAppRuntimeSurfaces,
  type UseAppRuntimeSurfacesContext,
} from "./useAppRuntimeSurfaces";

const hooks = vi.hoisted(() => ({
  useFrontendStateMirror: vi.fn(),
  useOsEdges: vi.fn(),
  usePersistEditorTabs: vi.fn(),
  useWindowApi: vi.fn(),
}));

vi.mock("../hooks/useFrontendStateMirror", () => ({
  useFrontendStateMirror: hooks.useFrontendStateMirror,
}));

vi.mock("../hooks/useOsEdges", () => ({
  useOsEdges: hooks.useOsEdges,
}));

vi.mock("../hooks/usePersistEditorTabs", () => ({
  usePersistEditorTabs: hooks.usePersistEditorTabs,
}));

vi.mock("../runtime/windowApi", () => ({
  useWindowApi: hooks.useWindowApi,
}));

describe("useAppRuntimeSurfaces", () => {
  it("mounts every App runtime surface with the shared shell context", () => {
    const ctx = {
      state: { status: "ready" },
    } as unknown as UseAppRuntimeSurfacesContext;

    renderHook(() => useAppRuntimeSurfaces(ctx));

    expect(hooks.useWindowApi).toHaveBeenCalledWith(ctx);
    expect(hooks.useFrontendStateMirror).toHaveBeenCalledWith(ctx);
    expect(hooks.usePersistEditorTabs).toHaveBeenCalledWith(ctx);
    expect(hooks.useOsEdges).toHaveBeenCalledWith(ctx);
  });
});
