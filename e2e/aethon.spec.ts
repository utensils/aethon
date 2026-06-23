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

type InvokeCall = {
  cmd: string;
  args: Record<string, unknown>;
};

function isTransientNavigationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Execution context was destroyed") ||
    message.includes("Cannot find context with specified id") ||
    message.includes("Target closed") ||
    message.includes("Page closed")
  );
}

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
  try {
    return await page.evaluate(() => {
      const state = window.__AETHON_STATE__?.();
      return {
        waiting: state?.waiting,
        queueCount: state?.queueCount,
        status: state?.status,
      };
    });
  } catch (error) {
    if (isTransientNavigationError(error)) {
      return {};
    }
    throw error;
  }
}

async function getComposerRightOverlayGeometry(
  page: Page,
  overlaySelector: string,
): Promise<{
  overlayRight: number;
  firstActionLeft: number;
  actionLane: string;
  textareaPaddingRight: string;
}> {
  return await page.locator(".a2ui-chat-input-field-wrap").evaluate(
    (wrap, selector) => {
      const overlay = wrap.querySelector(selector);
      const conversation = wrap.querySelector(".a2ui-chat-input-conversation");
      const voice = wrap.querySelector(
        ".a2ui-chat-input-voice:not(.a2ui-chat-input-conversation)",
      );
      const send = wrap.querySelector(".a2ui-chat-input-send");
      const textarea = wrap.querySelector(".a2ui-chat-input-field");
      if (!overlay || !conversation || !voice || !send || !textarea) {
        throw new Error("expected composer overlay and voice controls");
      }
      const overlayRect = overlay.getBoundingClientRect();
      const actionRects = [conversation, voice, send].map((el) =>
        el.getBoundingClientRect(),
      );
      const wrapStyle = getComputedStyle(wrap);
      const textareaStyle = getComputedStyle(textarea);
      return {
        overlayRight: overlayRect.right,
        firstActionLeft: Math.min(...actionRects.map((rect) => rect.left)),
        actionLane: wrapStyle
          .getPropertyValue("--a2ui-chat-input-action-lane")
          .trim(),
        textareaPaddingRight: textareaStyle.paddingRight,
      };
    },
    overlaySelector,
  );
}

async function completeActiveTurn(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__AETHON_E2E__?.completeActiveTurn();
  });
}

function sendMessageRequests(calls: InvokeCall[]): Record<string, unknown>[] {
  return calls
    .filter((c) => c.cmd === "send_message")
    .map((c) =>
      c.args.request && typeof c.args.request === "object"
        ? (c.args.request as Record<string, unknown>)
        : c.args,
    );
}

test.beforeEach(async ({ page }) => {
  await installAethonHarness(page);
});

test("boots the real app shell through mocked Tauri IPC", async ({ page }) => {
  await waitForAethonReady(page);

  await expect(
    page.getByRole("tab", { name: "Back to overview" }),
  ).toBeVisible();
  await expect(page.locator(".a2ui-tab:not(.a2ui-tab-overview)")).toHaveCount(
    0,
  );
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

test("chat canvas contains wide content without horizontal scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await waitForAethonReady(page);

  await page.getByRole("button", { name: "New Tab" }).click();
  await expect(page.locator(".a2ui-chat-input-field")).toBeVisible();

  const tabId = await page.evaluate(
    () => window.__AETHON_STATE__?.().activeTabId ?? "default",
  );
  const longToken = "0123456789abcdef".repeat(220);
  const wideMarkdown = [
    `Long URL: https://example.com/${longToken}`,
    "",
    "| path | value |",
    "| --- | --- |",
    `| ${longToken} | ${longToken} |`,
    "",
    "```typescript",
    `const value = "${longToken}";`,
    "```",
  ].join("\n");

  await page.evaluate(
    ({ tabId: activeTabId, longToken: token, wideMarkdown: markdown }) => {
      window.__AETHON_E2E__?.emitAgent({
        type: "response",
        tabId: activeTabId,
        content: markdown,
        done: true,
      });
      window.__AETHON_E2E__?.emitAgent({
        type: "a2ui",
        tabId: activeTabId,
        id: "wide-tool",
        done: true,
        payload: {
          components: [
            {
              id: "tool-wide",
              type: "tool-card",
              props: {
                title: "bash",
                description: token,
                startedAt: 1,
                endedAt: 2,
              },
              children: [
                {
                  id: "tool-code-wide",
                  type: "code",
                  props: {
                    content: `const value = "${token}";`,
                    language: "typescript",
                  },
                },
              ],
            },
          ],
        },
      });
    },
    { tabId, longToken, wideMarkdown },
  );

  await expect(page.locator(".a2ui-canvas-message")).toHaveCount(2);

  const scrollerMetrics = await page
    .locator(".a2ui-canvas-scroller")
    .evaluate((el) => ({ overflowX: getComputedStyle(el).overflowX }));
  expect(scrollerMetrics.overflowX).toBe("hidden");

  const containment = await page.locator(".ae-tool-card").evaluate((details) => {
    if (!(details instanceof HTMLDetailsElement)) {
      throw new Error("expected tool card details element");
    }
    details.open = true;
    details.dispatchEvent(new Event("toggle", { bubbles: true }));

    const code = details.querySelector(".a2ui-code");
    if (!code) throw new Error("expected open tool card code block");
    const scroller = document.querySelector(".a2ui-canvas-scroller");
    const codeRect = code.getBoundingClientRect();
    const scrollerRect = scroller?.getBoundingClientRect();
    return {
      canvasClientWidth: scroller?.clientWidth ?? 0,
      canvasScrollWidth: scroller?.scrollWidth ?? 0,
      codeRight: codeRect.right,
      scrollerRight: scrollerRect?.right ?? 0,
    };
  });
  expect(containment.codeRight).toBeLessThanOrEqual(
    containment.scrollerRight + 1,
  );
  expect(containment.canvasScrollWidth).toBeLessThanOrEqual(
    containment.canvasClientWidth + 1,
  );
});

test("voice transcribing status does not overlap composer action buttons", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await waitForAethonReady(page);

  await page.getByRole("button", { name: "New Tab" }).click();
  await expect(page.locator(".a2ui-chat-input-field")).toBeVisible();

  await page.getByRole("button", { name: "Voice input" }).click();
  await expect(
    page.getByRole("button", { name: "Stop voice input" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Stop voice input" }).click();
  await expect(page.locator(".a2ui-chat-input-voice-status")).toContainText(
    "Transcribing",
  );

  const geometry = await getComposerRightOverlayGeometry(
    page,
    ".a2ui-chat-input-voice-status",
  );

  expect(geometry.overlayRight).toBeLessThanOrEqual(
    geometry.firstActionLeft - 4,
  );
  expect(geometry.textareaPaddingRight).toBe(geometry.actionLane);
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

  // Stack two prompts while the first turn is still in flight. With
  // the client-held queue UX, these land in the popover above the
  // composer — NOT in chat history — and only become history bubbles
  // once the auto-drain pops them on the next idle.
  await page.locator(".a2ui-chat-input-field").fill("queued prompt");
  await page.keyboard.press("Enter");

  await expect(page.locator(".a2ui-chat-input-queue")).toHaveText("+1");
  const queueGeometry = await getComposerRightOverlayGeometry(
    page,
    ".a2ui-chat-input-queue",
  );
  expect(queueGeometry.overlayRight).toBeLessThanOrEqual(
    queueGeometry.firstActionLeft - 4,
  );
  await expect(page.locator(".a2ui-tab-active")).toContainText("+1");
  await expect(page.locator(".a2ui-queued-popover")).toBeVisible();
  await expect(page.locator(".a2ui-queued-message")).toHaveCount(1);
  await expect(page.locator(".a2ui-queued-content")).toHaveText(
    "queued prompt",
  );
  await expect(
    page.getByRole("button", { name: "Stop + clear" }),
  ).toBeVisible();
  await expect
    .poll(() => getActiveTurnState(page))
    .toEqual({ waiting: true, queueCount: 1, status: "thinking…" });

  await page.locator(".a2ui-chat-input-field").fill("second queued prompt");
  await page.keyboard.press("Enter");

  await expect(page.locator(".a2ui-chat-input-queue")).toHaveText("+2");
  await expect(page.locator(".a2ui-queued-message")).toHaveCount(2);
  await expect(page.locator(".a2ui-queued-content")).toHaveText([
    "queued prompt",
    "second queued prompt",
  ]);
  await expect
    .poll(() => getActiveTurnState(page))
    .toEqual({ waiting: true, queueCount: 2, status: "thinking…" });

  // First turn ends → head of queue drains → second user bubble lands
  // in history, popover shrinks to one row.
  await completeActiveTurn(page);
  await expect(page.locator(".a2ui-chat-input-queue")).toHaveText("+1");
  await expect(page.locator(".a2ui-queued-message")).toHaveCount(1);
  await expect(page.locator(".a2ui-queued-content")).toHaveText(
    "second queued prompt",
  );
  await expect
    .poll(() => getActiveTurnState(page))
    .toEqual({ waiting: true, queueCount: 1, status: "thinking…" });

  // Second turn ends → last queued message drains → popover empties.
  await completeActiveTurn(page);
  await expect(page.locator(".a2ui-chat-input-queue")).toHaveCount(0);
  await expect(page.locator(".a2ui-queued-popover")).toHaveCount(0);
  await expect
    .poll(() => getActiveTurnState(page))
    .toEqual({ waiting: true, queueCount: 0, status: "thinking…" });
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  // Third turn ends → idle.
  await completeActiveTurn(page);
  await expect
    .poll(() => getActiveTurnState(page))
    .toEqual({ waiting: false, queueCount: 0, status: "ready" });
  await expect(page.locator(".a2ui-chat-input-queue")).toHaveCount(0);
  await expect(page.locator(".a2ui-queued-popover")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(page.getByText("Enter queues")).toHaveCount(0);

  const calls = await getInvokeCalls(page);
  expect(sendMessageRequests(calls)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ message: "first prompt", mode: "normal" }),
      expect.objectContaining({ message: "queued prompt", mode: "normal" }),
      expect.objectContaining({
        message: "second queued prompt",
        mode: "normal",
      }),
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
  await expect(page.locator(".a2ui-tab-active")).not.toContainText("+1");
  await expect(page.locator(".a2ui-chat-delivery-steered")).toHaveText(
    "steered",
  );
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

  expect(sendMessageRequests(calls)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ message: "first prompt", mode: "normal" }),
      expect.objectContaining({ message: "steer now", mode: "steer" }),
    ]),
  );
});

test("retries failed user sends from the transcript", async ({ page }) => {
  await waitForAethonReady(page);

  await page.getByRole("button", { name: "New Tab" }).click();
  await page.evaluate(() => window.__AETHON_E2E__?.failNextSendMessage());
  await page.locator(".a2ui-chat-input-field").fill("retry me");
  await page.keyboard.press("Enter");

  await expect(page.locator(".a2ui-chat-delivery-failed")).toHaveText("failed");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

  await page.getByRole("button", { name: "Retry" }).click();

  await expect(page.locator(".a2ui-chat-delivery-failed")).toHaveCount(0);
  await expect
    .poll(() => getActiveTurnState(page))
    .toEqual({ waiting: true, queueCount: 0, status: "thinking…" });

  await completeActiveTurn(page);
  await expect
    .poll(() => getActiveTurnState(page))
    .toEqual({ waiting: false, queueCount: 0, status: "ready" });

  expect(sendMessageRequests(await getInvokeCalls(page))).toEqual([
    expect.objectContaining({ message: "retry me", mode: "normal" }),
    expect.objectContaining({ message: "retry me", mode: "normal" }),
  ]);
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

  // Steer mid-turn — adds a steered bubble to history, leaves the
  // queued message in the popover untouched.
  await expect(page.locator(".a2ui-chat-input-queue")).toHaveText("+1");
  await expect(page.locator(".a2ui-queued-message")).toHaveCount(1);
  await expect(page.locator(".a2ui-queued-content")).toHaveText(
    "queued prompt",
  );
  await expect(page.locator(".a2ui-chat-delivery-steered")).toHaveText(
    "steered",
  );
  await expect
    .poll(() => getActiveTurnState(page))
    .toEqual({ waiting: true, queueCount: 1, status: "thinking…" });

  // First turn ends → queued message drains; steered bubble stays
  // as historical record of the mid-turn interjection.
  await completeActiveTurn(page);
  await expect(page.locator(".a2ui-queued-popover")).toHaveCount(0);
  await expect(page.locator(".a2ui-chat-delivery-steered")).toHaveText(
    "steered",
  );
  await expect
    .poll(() => getActiveTurnState(page))
    .toEqual({ waiting: true, queueCount: 0, status: "thinking…" });

  await completeActiveTurn(page);
  await expect
    .poll(() => getActiveTurnState(page))
    .toEqual({ waiting: false, queueCount: 0, status: "ready" });

  expect(sendMessageRequests(await getInvokeCalls(page))).toEqual([
    expect.objectContaining({ message: "first prompt", mode: "normal" }),
    expect.objectContaining({ message: "steer current turn", mode: "steer" }),
    expect.objectContaining({ message: "queued prompt", mode: "normal" }),
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
  await page
    .locator(".a2ui-dropdown-trigger")
    .filter({ hasText: "GPT-5.5" })
    .click();
  await page
    .getByRole("option", { name: /qwen3\.6:35b-a3b-coding-nvfp4/ })
    .click();

  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.__AETHON_STATE__?.();
        return {
          model: state?.model,
          // A header pick is also the chosen default for new sessions.
          defaultModel: state?.defaultModel,
          active: state?.sidebar?.models?.find(
            (m: { id: string }) => m.id === state?.model,
          )?.active,
        };
      }),
    )
    .toEqual({ model: ALT_MODEL, defaultModel: ALT_MODEL, active: true });
});

test("a model picked with no active session is the default for the next new tab", async ({
  page,
}) => {
  await waitForAethonReady(page);

  // Switch the header model on the empty/dashboard surface — no agent tab
  // exists yet, so this only sets the default (no live session to retarget).
  await page
    .locator(".a2ui-dropdown-trigger")
    .filter({ hasText: "GPT-5.5" })
    .click();
  await page
    .getByRole("option", { name: /qwen3\.6:35b-a3b-coding-nvfp4/ })
    .click();

  await expect
    .poll(() => page.evaluate(() => window.__AETHON_STATE__?.()?.defaultModel))
    .toBe(ALT_MODEL);

  // Now open a new tab; it must inherit the chosen default rather than
  // pi's boot default — the core regression this fixes.
  await page.getByRole("button", { name: "New Tab" }).click();

  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.__AETHON_STATE__?.();
        const active = (state?.tabs ?? []).find(
          (t) => t.id === state?.activeTabId,
        );
        return active?.model;
      }),
    )
    .toBe(ALT_MODEL);
});

test("refreshes visible file-tree folders after fs-tree-changed events", async ({
  page,
}) => {
  await waitForAethonReady(page);

  await page.evaluate(
    ({ root }) => {
      window.__AETHON_E2E__?.setDir(root, root, [
        {
          name: "agent",
          path: `${root}/agent`,
          kind: "dir",
          size: 0,
          modified: 1,
        },
        { name: "src", path: `${root}/src`, kind: "dir", size: 0, modified: 1 },
        {
          name: "package.json",
          path: `${root}/package.json`,
          kind: "file",
          size: 42,
          modified: 1,
        },
        {
          name: "z-e2e-created.txt",
          path: `${root}/z-e2e-created.txt`,
          kind: "file",
          size: 42,
          modified: 1,
        },
      ]);
      window.__AETHON_E2E__?.emit("fs-tree-changed", { root, dirs: [root] });
    },
    { root: PROJECT_ROOT },
  );

  await expect(page.locator(".ae-file-tree")).toContainText(
    "z-e2e-created.txt",
  );
});
