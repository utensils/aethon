import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  ALT_MODEL,
  DEFAULT_MODEL,
  PROJECT_ROOT,
  getInvokeCalls,
  installAethonHarness,
  waitForAethonReady,
} from "./support/aethon-harness";

type AgentCommandPayload = {
  type?: string;
  cwd?: string;
  model?: string;
};

type ActiveTurnState = {
  waiting?: boolean;
  queueCount?: number;
  status?: string;
};

function parseAgentCommandPayload(payload: unknown): AgentCommandPayload {
  if (typeof payload !== "string") return {};
  const parsed: unknown = JSON.parse(payload);
  if (!parsed || typeof parsed !== "object") return {};
  const record = parsed as Record<string, unknown>;
  return {
    type: typeof record.type === "string" ? record.type : undefined,
    cwd: typeof record.cwd === "string" ? record.cwd : undefined,
    model: typeof record.model === "string" ? record.model : undefined,
  };
}

async function getActiveTurnState(page: Page): Promise<ActiveTurnState> {
  return page.evaluate(() => {
    const state = window.__AETHON_STATE__?.();
    return {
      waiting: state?.waiting,
      queueCount: state?.queueCount,
      status: state?.status,
    };
  });
}

async function completeActiveTurn(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__AETHON_E2E__?.completeActiveTurn();
  });
}

test.beforeEach(async ({ page }) => {
  await installAethonHarness(page);
});

test("boots the real app shell through mocked Tauri IPC", async ({ page }) => {
  await waitForAethonReady(page);

  await expect(page.locator(".a2ui-tab")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "aethon" })).toBeVisible();
  await expect(page.locator(".ae-file-tree")).toContainText("package.json");

  const calls = await getInvokeCalls(page);
  expect(calls.map((c) => c.cmd)).toEqual(
    expect.arrayContaining([
      "agent_command",
      "read_config",
      "read_state",
      "host_info",
      "fs_list_dir",
      "fs_watch_dirs",
    ]),
  );
});

test("queues normal Enter messages behind an in-flight turn and drains cleanly", async ({
  page,
}) => {
  await waitForAethonReady(page);

  await page.getByRole("button", { name: "New Tab" }).click();
  await page.locator(".a2ui-chat-input-field").fill("first prompt");
  await page.keyboard.press("Enter");

  await expect
    .poll(() => getActiveTurnState(page))
    .toEqual({ waiting: true, queueCount: 0, status: "thinking…" });
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(page.getByText("Enter queues")).toBeVisible();
  await expect(page.getByText("Cmd/Ctrl+Enter steers")).toBeVisible();

  await page.locator(".a2ui-chat-input-field").fill("queued prompt");
  await page.keyboard.press("Enter");

  await expect(page.locator(".a2ui-chat-input-queue")).toHaveText("+1");
  await expect(page.locator(".a2ui-tab")).toContainText("+1");
  await expect(page.locator(".a2ui-chat-delivery-queued")).toHaveText("queued");
  await expect
    .poll(() => getActiveTurnState(page))
    .toEqual({ waiting: true, queueCount: 1, status: "thinking…" });

  await completeActiveTurn(page);
  await expect(page.locator(".a2ui-chat-input-queue")).toHaveCount(0);
  await expect
    .poll(() => getActiveTurnState(page))
    .toEqual({ waiting: true, queueCount: 0, status: "thinking…" });
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  await completeActiveTurn(page);
  await expect
    .poll(() => getActiveTurnState(page))
    .toEqual({ waiting: false, queueCount: 0, status: "ready" });
  await expect(page.locator(".a2ui-chat-input-queue")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(page.getByText("Enter queues")).toHaveCount(0);

  const calls = await getInvokeCalls(page);
  const sends = calls.filter((c) => c.cmd === "send_message");
  expect(sends.map((c) => c.args)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ message: "first prompt", mode: "normal" }),
      expect.objectContaining({ message: "queued prompt", mode: "normal" }),
    ]),
  );
});

test("steers Command-Enter into the running turn without queuing it", async ({
  page,
}) => {
  await waitForAethonReady(page);

  await page.getByRole("button", { name: "New Tab" }).click();
  await page.locator(".a2ui-chat-input-field").fill("first prompt");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => getActiveTurnState(page))
    .toEqual({ waiting: true, queueCount: 0, status: "thinking…" });

  await page.locator(".a2ui-chat-input-field").fill("steer now");
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+Enter" : "Control+Enter",
  );

  await expect(page.locator(".a2ui-chat-input-queue")).toHaveCount(0);
  await expect(page.locator(".a2ui-tab")).not.toContainText("+1");
  await expect(page.locator(".a2ui-chat-delivery-steered")).toHaveText("steered");
  await expect
    .poll(() => getActiveTurnState(page))
    .toEqual({ waiting: true, queueCount: 0, status: "thinking…" });

  await completeActiveTurn(page);
  await expect
    .poll(() => getActiveTurnState(page))
    .toEqual({ waiting: false, queueCount: 0, status: "ready" });
  await expect(page.locator(".a2ui-chat-input-queue")).toHaveCount(0);

  const calls = await getInvokeCalls(page);
  const tabOpen = calls
    .filter((c) => c.cmd === "agent_command")
    .map((c) => parseAgentCommandPayload(c.args.payload))
    .find((p) => p.type === "tab_open");
  expect(tabOpen).toMatchObject({
    cwd: PROJECT_ROOT,
    model: DEFAULT_MODEL,
  });

  const sends = calls.filter((c) => c.cmd === "send_message");
  expect(sends.map((c) => c.args)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ message: "first prompt", mode: "normal" }),
      expect.objectContaining({ message: "steer now", mode: "steer" }),
    ]),
  );
});

test("steering during an existing follow-up queue preserves the queued turn", async ({
  page,
}) => {
  await waitForAethonReady(page);

  await page.getByRole("button", { name: "New Tab" }).click();
  await page.locator(".a2ui-chat-input-field").fill("first prompt");
  await page.keyboard.press("Enter");
  await page.locator(".a2ui-chat-input-field").fill("queued prompt");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => getActiveTurnState(page))
    .toEqual({ waiting: true, queueCount: 1, status: "thinking…" });

  await page.locator(".a2ui-chat-input-field").fill("steer current turn");
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+Enter" : "Control+Enter",
  );

  await expect(page.locator(".a2ui-chat-input-queue")).toHaveText("+1");
  await expect(page.locator(".a2ui-chat-delivery-queued")).toHaveText("queued");
  await expect(page.locator(".a2ui-chat-delivery-steered")).toHaveText("steered");
  await expect
    .poll(() => getActiveTurnState(page))
    .toEqual({ waiting: true, queueCount: 1, status: "thinking…" });

  await completeActiveTurn(page);
  await expect
    .poll(() => getActiveTurnState(page))
    .toEqual({ waiting: true, queueCount: 0, status: "thinking…" });

  await completeActiveTurn(page);
  await expect
    .poll(() => getActiveTurnState(page))
    .toEqual({ waiting: false, queueCount: 0, status: "ready" });

  const sends = (await getInvokeCalls(page)).filter((c) => c.cmd === "send_message");
  expect(sends.map((c) => c.args)).toEqual([
    expect.objectContaining({ message: "first prompt", mode: "normal" }),
    expect.objectContaining({ message: "queued prompt", mode: "normal" }),
    expect.objectContaining({ message: "steer current turn", mode: "steer" }),
  ]);
});

test("runs native slash commands without leaving the UI stuck busy", async ({
  page,
}) => {
  await waitForAethonReady(page);

  await page.getByRole("button", { name: "New Tab" }).click();
  await page.locator(".a2ui-chat-input-field").fill("/context");
  await page.keyboard.press("Enter");

  await expect(page.getByText("Window: 272,000 tokens")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.__AETHON_STATE__?.();
        return { waiting: state?.waiting, status: state?.status };
      }),
    )
    .toEqual({ waiting: false, status: "ready" });
});

test("switches models through the real picker path and keeps active state aligned", async ({
  page,
}) => {
  await waitForAethonReady(page);

  await page.getByRole("button", { name: "New Tab" }).click();
  await page.locator(".a2ui-dropdown-trigger").filter({ hasText: "GPT-5.5" }).click();
  await page.getByRole("option", { name: /qwen3\.6:35b-a3b-coding-nvfp4/ }).click();

  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.__AETHON_STATE__?.();
        return {
          model: state?.model,
          active: state?.sidebar?.models?.find((m: { id: string }) => m.id === state?.model)
            ?.active,
        };
      }),
    )
    .toEqual({ model: ALT_MODEL, active: true });
});

test("refreshes visible file-tree folders after fs-tree-changed events", async ({
  page,
}) => {
  await waitForAethonReady(page);

  await page.evaluate(({ root }) => {
    window.__AETHON_E2E__?.setDir(root, root, [
      { name: "agent", path: `${root}/agent`, kind: "dir", size: 0, modified: 1 },
      { name: "src", path: `${root}/src`, kind: "dir", size: 0, modified: 1 },
      { name: "package.json", path: `${root}/package.json`, kind: "file", size: 42, modified: 1 },
      {
        name: "z-e2e-created.txt",
        path: `${root}/z-e2e-created.txt`,
        kind: "file",
        size: 42,
        modified: 1,
      },
    ]);
    window.__AETHON_E2E__?.emit("fs-tree-changed", { root, dirs: [root] });
  }, { root: PROJECT_ROOT });

  await expect(page.locator(".ae-file-tree")).toContainText("z-e2e-created.txt");
});
