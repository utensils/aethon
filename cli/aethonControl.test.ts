import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import {
  activeTargetFromState,
  buildAccountSwitchPayloads,
  installSkill,
  jsonPointerGet,
  normalizeTabs,
  planSkillInstall,
} from "./aethonControl.ts";
import { resolveDebugPort } from "./debugClient.ts";
import { AethonControlClient, readControlInfo } from "./controlClient.ts";

describe("aethonctl helpers", () => {
  it("builds the same two-step account switch used by the UI for tab workers", () => {
    expect(
      buildAccountSwitchPayloads("openai-codex-secondary", {
        tabId: "tab-worker",
        cwd: "/repo",
        model: "openai-codex/gpt-5.5",
      }),
    ).toEqual([
      {
        type: "auth_profile_use_for_tab",
        tabId: "tab-worker",
        profileId: "openai-codex-secondary",
      },
      {
        type: "auth_profile_apply",
        tabId: "tab-worker",
        profileId: "openai-codex-secondary",
        cwd: "/repo",
        model: "openai-codex/gpt-5.5",
      },
    ]);
  });

  it("keeps default account switches on the global bridge", () => {
    expect(buildAccountSwitchPayloads("primary", { tabId: "default" })).toEqual(
      [
        {
          type: "auth_profile_use_for_tab",
          tabId: "default",
          profileId: "primary",
        },
      ],
    );
  });

  it("resolves active tabs from object-shaped app state", () => {
    const target = activeTargetFromState(
      {
        activeTabId: "t1",
        tabs: {
          t1: {
            id: "t1",
            kind: "agent",
            cwd: "/repo",
            model: "openai-codex/gpt-5.5",
          },
        },
      },
      "active",
    );

    expect(target).toEqual({
      tabId: "t1",
      cwd: "/repo",
      model: "openai-codex/gpt-5.5",
    });
  });

  it("falls back to default when the active surface is not an agent tab", () => {
    expect(
      activeTargetFromState(
        {
          activeTabId: "shell",
          tabs: { shell: { id: "shell", kind: "shell" } },
        },
        "active",
      ),
    ).toEqual({ tabId: "default" });
  });

  it("keeps explicit tab ids even when the frontend snapshot is stale", () => {
    expect(
      activeTargetFromState({ activeTabId: "other", tabs: [] }, "new-tab"),
    ).toEqual({
      tabId: "new-tab",
    });
  });

  it("reads JSON Pointer state paths", () => {
    expect(jsonPointerGet({ a: { "b/c": ["zero", "one"] } }, "/a/b~1c/1")).toBe(
      "one",
    );
  });

  it("normalizes object and array tab containers", () => {
    expect(normalizeTabs({ a: { id: "a" } })).toEqual([{ id: "a" }]);
    expect(normalizeTabs([{ id: "b", label: "Bee" }])).toEqual([
      { id: "b", label: "Bee" },
    ]);
  });

  it("plans project skill installs using claude plus generic agents targets", () => {
    const root = mkdtempSync(join(tmpdir(), "aethon-skill-"));
    const plan = planSkillInstall({ project: true, dir: root });
    expect(plan.paths).toEqual([
      join(root, ".claude", "skills", "aethon-control", "SKILL.md"),
      join(root, ".agents", "skills", "aethon-control", "SKILL.md"),
    ]);
  });

  it("writes skill files with account guidance", () => {
    const root = mkdtempSync(join(tmpdir(), "aethon-skill-"));
    const plan = planSkillInstall({
      targets: ["codex"],
      project: true,
      dir: root,
    });
    const [path] = installSkill(plan, true);
    const body = readFileSync(path, "utf8");
    expect(body).toContain("accounts use <profile-id>");
    expect(body).toContain("--account <profile-id>");
  });

  it("resolves debug port from the conventional dev-info file", () => {
    const home = mkdtempSync(join(tmpdir(), "aethon-home-"));
    mkdirSync(join(home, ".aethon"));
    writeFileSync(
      join(home, ".aethon", "dev-info.json"),
      JSON.stringify({ debugPort: 20123 }),
    );
    expect(resolveDebugPort({ home, env: {} })).toBe(20123);
  });

  it("reads release control info and sends token-authenticated socket requests", async () => {
    const root = mkdtempSync(join(tmpdir(), "aethon-control-"));
    const controlDir = join(root, ".aethon", "control");
    mkdirSync(controlDir, { recursive: true });
    const socketPath = join(controlDir, "control.sock");
    const tokenPath = join(controlDir, "token");
    writeFileSync(tokenPath, "test-token");
    writeFileSync(
      join(controlDir, "control.json"),
      JSON.stringify({
        protocolVersion: 1,
        mode: "local",
        socketPath,
        tokenPath,
        pid: 123,
        version: "0.0.0-test",
        instanceId: "instance",
      }),
    );
    rmSync(socketPath, { force: true });
    const server: Server = createServer((socket: Socket) => {
      let body = "";
      socket.on("data", (chunk) => {
        body += chunk.toString("utf8");
        if (!body.includes("\n")) return;
        const request = JSON.parse(body) as { token: string; method: string };
        socket.end(JSON.stringify({ ok: true, result: request }) + "\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const testEnv: NodeJS.ProcessEnv = {};
      expect(readControlInfo({ home: root, env: testEnv })?.socketPath).toBe(
        socketPath,
      );
      const client = new AethonControlClient({ home: root, env: testEnv });
      await expect(client.request("status")).resolves.toEqual({
        token: "test-token",
        method: "status",
        params: {},
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
