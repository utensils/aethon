import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
  __resetOllamaContextCache,
  cachedOllamaContextWindow,
  isOllamaModel,
  refreshOllamaContextWindow,
} from "./ollama-context";

function ollamaModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "qwen3.6:35b-a3b-coding-nvfp4",
    name: "qwen",
    provider: "ollama-localhost",
    api: "openai-completions",
    baseUrl: "http://localhost:11434/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262_144,
    maxTokens: 16_384,
    ...overrides,
  };
}

/** Minimal Response-like stub so the test doesn't depend on a global Response. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

afterEach(() => {
  __resetOllamaContextCache();
  vi.unstubAllGlobals();
});

describe("isOllamaModel", () => {
  it("matches ollama-* providers and :11434 baseUrls, not lmstudio", () => {
    expect(isOllamaModel(ollamaModel())).toBe(true);
    expect(
      isOllamaModel(
        ollamaModel({ provider: "custom", baseUrl: "http://host:11434/v1" }),
      ),
    ).toBe(true);
    expect(
      isOllamaModel(
        ollamaModel({
          provider: "lmstudio-localhost",
          baseUrl: "http://localhost:1234/v1",
        }),
      ),
    ).toBe(false);
    expect(isOllamaModel(undefined)).toBe(false);
  });
});

describe("refreshOllamaContextWindow", () => {
  it("corrects the model window from /api/ps when the server differs", async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        String(url).endsWith("/api/ps")
          ? jsonResponse(200, {
              models: [
                {
                  name: "qwen3.6:35b-a3b-coding-nvfp4",
                  context_length: 4096,
                },
              ],
            })
          : jsonResponse(404, {}),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const model = ollamaModel(); // configured 262_144
    expect(await refreshOllamaContextWindow(model)).toBe(true);
    expect(model.contextWindow).toBe(4096);
    expect(cachedOllamaContextWindow(model)).toBe(4096);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to /api/show when /api/ps has no match", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (String(url).endsWith("/api/ps")) {
        return Promise.resolve(jsonResponse(200, { models: [] }));
      }
      if (String(url).endsWith("/api/show")) {
        return Promise.resolve(
          jsonResponse(200, {
            model_info: { "qwen3moe.context_length": 131_072 },
          }),
        );
      }
      return Promise.resolve(jsonResponse(404, {}));
    });
    vi.stubGlobal("fetch", fetchMock);

    const model = ollamaModel();
    expect(await refreshOllamaContextWindow(model)).toBe(true);
    expect(model.contextWindow).toBe(131_072);
  });

  it("leaves the configured window untouched when the server is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
    );

    const model = ollamaModel({ contextWindow: 262_144 });
    expect(await refreshOllamaContextWindow(model)).toBe(false);
    expect(model.contextWindow).toBe(262_144);
    expect(cachedOllamaContextWindow(model)).toBeUndefined();
  });

  it("is a no-op (no fetch) for non-ollama models", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const model = ollamaModel({
      provider: "lmstudio-localhost",
      baseUrl: "http://localhost:1234/v1",
    });
    expect(await refreshOllamaContextWindow(model)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caches the result and reports no further change once corrected", async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        String(url).endsWith("/api/ps")
          ? jsonResponse(200, {
              models: [
                { name: "qwen3.6:35b-a3b-coding-nvfp4", context_length: 4096 },
              ],
            })
          : jsonResponse(404, {}),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const model = ollamaModel();
    expect(await refreshOllamaContextWindow(model)).toBe(true);
    // Cached + already applied: no change, no re-probe.
    expect(await refreshOllamaContextWindow(model)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
