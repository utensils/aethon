// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { applyUiScale, writeUiViewportVars } from "./viewport";

const originalDescriptors = {
  window: {
    innerWidth: Object.getOwnPropertyDescriptor(window, "innerWidth"),
    innerHeight: Object.getOwnPropertyDescriptor(window, "innerHeight"),
    outerWidth: Object.getOwnPropertyDescriptor(window, "outerWidth"),
    outerHeight: Object.getOwnPropertyDescriptor(window, "outerHeight"),
    visualViewport: Object.getOwnPropertyDescriptor(window, "visualViewport"),
  },
  documentElement: {
    clientWidth: Object.getOwnPropertyDescriptor(
      document.documentElement,
      "clientWidth",
    ),
    clientHeight: Object.getOwnPropertyDescriptor(
      document.documentElement,
      "clientHeight",
    ),
  },
  body: {
    clientWidth: Object.getOwnPropertyDescriptor(document.body, "clientWidth"),
    clientHeight: Object.getOwnPropertyDescriptor(document.body, "clientHeight"),
  },
};

function restoreProperty(
  target: object,
  key: string,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
  } else {
    delete (target as Record<string, unknown>)[key];
  }
}

afterEach(() => {
  document.documentElement.style.removeProperty("--app-ui-scale");
  document.documentElement.style.removeProperty("--app-viewport-width");
  document.documentElement.style.removeProperty("--app-viewport-height");
  document.documentElement.style.zoom = "";

  restoreProperty(window, "innerWidth", originalDescriptors.window.innerWidth);
  restoreProperty(window, "innerHeight", originalDescriptors.window.innerHeight);
  restoreProperty(window, "outerWidth", originalDescriptors.window.outerWidth);
  restoreProperty(window, "outerHeight", originalDescriptors.window.outerHeight);
  restoreProperty(
    window,
    "visualViewport",
    originalDescriptors.window.visualViewport,
  );
  restoreProperty(
    document.documentElement,
    "clientWidth",
    originalDescriptors.documentElement.clientWidth,
  );
  restoreProperty(
    document.documentElement,
    "clientHeight",
    originalDescriptors.documentElement.clientHeight,
  );
  restoreProperty(
    document.body,
    "clientWidth",
    originalDescriptors.body.clientWidth,
  );
  restoreProperty(
    document.body,
    "clientHeight",
    originalDescriptors.body.clientHeight,
  );
});

describe("applyUiScale", () => {
  it("dispatches ui-scale changes only when the scale changes", () => {
    const listener = vi.fn();
    window.addEventListener("aethon:ui-scale-change", listener);

    applyUiScale(1.2);
    applyUiScale(1.2);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({
      detail: { scale: 1.2 },
    });

    window.removeEventListener("aethon:ui-scale-change", listener);
  });
});

describe("writeUiViewportVars", () => {
  it("preserves window inner dimensions when they are sane", () => {
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: 1280 },
      innerHeight: { configurable: true, value: 720 },
      outerWidth: { configurable: true, value: 1440 },
      outerHeight: { configurable: true, value: 900 },
      visualViewport: {
        configurable: true,
        value: { width: 960, height: 540 },
      },
    });

    writeUiViewportVars(1);

    expect(
      document.documentElement.style.getPropertyValue("--app-viewport-width"),
    ).toBe("1280px");
    expect(
      document.documentElement.style.getPropertyValue("--app-viewport-height"),
    ).toBe("720px");
  });

  it("falls back when WebKit reports negative viewport dimensions", () => {
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: -90816 },
      innerHeight: { configurable: true, value: -92352 },
      outerWidth: { configurable: true, value: 946 },
      outerHeight: { configurable: true, value: 990 },
      visualViewport: {
        configurable: true,
        value: { width: -90816, height: -92352 },
      },
    });
    Object.defineProperties(document.documentElement, {
      clientWidth: { configurable: true, value: 946000002 },
      clientHeight: { configurable: true, value: 962000002 },
    });
    Object.defineProperties(document.body, {
      clientWidth: { configurable: true, value: 33554432 },
      clientHeight: { configurable: true, value: 33554432 },
    });

    writeUiViewportVars(1);

    expect(
      document.documentElement.style.getPropertyValue("--app-viewport-width"),
    ).toBe("946px");
    expect(
      document.documentElement.style.getPropertyValue("--app-viewport-height"),
    ).toBe("990px");
  });
});
