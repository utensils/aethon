import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The bridge logger writes a rotating daily file alongside stderr. Under test
 * runs that file must NOT land in the real `~/.aethon/logs/` — the agent runs
 * `bunx vitest` via its bash tool, which loads these very modules and would
 * otherwise flood the production `bridge.<date>.log` with test fixtures.
 *
 * The module reads its env (AETHON_LOG_DIR / VITEST) at load time, so each case
 * resets the module registry and re-imports with the env it wants.
 */
describe("bridge logger file sink", () => {
  afterEach(() => {
    // Restore the individual stubbed vars without replacing the process.env
    // reference — a fresh object would leak into other test files sharing this
    // Vitest worker and break helpers like vi.stubEnv.
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.doUnmock("node:os");
  });

  it("writes to AETHON_LOG_DIR when the override is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aethon-log-override-"));
    try {
      vi.stubEnv("AETHON_LOG_DIR", dir);
      vi.resetModules();
      const { logger } = await import("./logger");
      logger.scope("probe").info("override-line");

      const files = readdirSync(dir).filter((f) => f.startsWith("bridge."));
      expect(files).toHaveLength(1);
      expect(readFileSync(join(dir, files[0]), "utf8")).toContain(
        "override-line",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("disables the file sink under vitest when no override is set", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "aethon-home-"));
    try {
      vi.doMock("node:os", () => ({
        homedir: () => fakeHome,
        tmpdir: () => tmpdir(),
      }));
      vi.stubEnv("AETHON_LOG_DIR", undefined);
      vi.stubEnv("VITEST", "true");
      vi.resetModules();
      const { logger } = await import("./logger");
      logger.scope("probe").info("must-not-be-filed");

      // No file (and not even the logs dir) should be created in the
      // would-be production location.
      expect(existsSync(join(fakeHome, ".aethon", "logs"))).toBe(false);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
