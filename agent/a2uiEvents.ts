import type { AethonApi } from "./aethon-api";
import type { AethonAgentState, PiHandlerCtx, TabRecord } from "./state";
import {
  maybeExitForReload,
  type DispatcherDeps,
  type InboundMessage,
} from "./dispatcherTypes";
import { setState, makeCanvasApi } from "./state-mutation";
import { ensureTab, modelKey } from "./tab-lifecycle";

export async function handleA2UIEvent(
  state: AethonAgentState,
  deps: DispatcherDeps,
  aethonApi: AethonApi,
  msg: InboundMessage,
): Promise<void> {
  const stateMutationDeps = { send: deps.send };
  const ev = msg.event ?? {};
  const descendantId = ev.componentId?.includes("__tpl__")
    ? ev.componentId.split("__tpl__").slice(1).join("__tpl__")
    : undefined;
  const handlerTabId = msg.tabId ?? "default";
  const handlerTab = await ensureTab(state, deps, handlerTabId);
  const piCtx = buildPiHandlerCtx(state, deps, handlerTab, handlerTabId);
  const tabScopedSetState = (path: string, value: unknown) =>
    setState(state, stateMutationDeps, path, value, handlerTabId);
  const tabScopedCanvas = makeCanvasApi(state, stateMutationDeps, handlerTabId);

  for (const { match, handler } of state.a2uiEventHandlers) {
    if (
      match.templateRootType &&
      match.templateRootType !== ev.templateRootType
    )
      continue;
    if (match.componentType && match.componentType !== ev.componentType)
      continue;
    if (match.eventType && match.eventType !== ev.eventType) continue;
    if (match.descendantId && match.descendantId !== descendantId) continue;
    if (match.surfaceId && match.surfaceId !== ev.surfaceId) continue;
    if (match.windowId && match.windowId !== ev.windowId) continue;
    const windowId =
      typeof ev.windowId === "string" && ev.windowId.length > 0
        ? ev.windowId
        : undefined;
    const windowCtx = windowId
      ? {
          id: windowId,
          setState: (path: string, value: unknown) =>
            aethonApi.windows.setState(windowId, path, value),
          emit: (components: unknown) =>
            aethonApi.windows.emitCanvas(windowId, components),
          append: (components: unknown) =>
            aethonApi.windows.appendCanvas(windowId, components),
          patch: (path: string, value: unknown) =>
            aethonApi.windows.patchCanvas(windowId, path, value),
          clear: () => aethonApi.windows.clearCanvas(windowId),
          setTitle: (title: string) =>
            aethonApi.windows.setTitle(windowId, title),
          focus: () => aethonApi.windows.focus(windowId),
          close: () => aethonApi.windows.close(windowId),
        }
      : undefined;
    // Fire-and-forget the handler — don't await inside the stdin loop.
    Promise.resolve()
      .then(() =>
        state.tabContext.run(handlerTabId, () =>
          handler(ev, {
            setState: tabScopedSetState,
            registerComponent: aethonApi.registerComponent,
            pi: piCtx,
            canvas: tabScopedCanvas,
            shells: aethonApi.shells,
            windows: aethonApi.windows,
            ...(windowCtx ? { window: windowCtx } : {}),
          }),
        ),
      )
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        deps.send({
          type: "notice",
          tabId: handlerTabId,
          message: `a2ui handler: ${message}`,
        });
      });
  }
}

function buildPiHandlerCtx(
  state: AethonAgentState,
  deps: DispatcherDeps,
  handlerTab: TabRecord,
  handlerTabId: string,
): PiHandlerCtx {
  return {
    async prompt(text: string) {
      if (!text || typeof text !== "string") return;
      if (handlerTab.promptInFlight) {
        deps.send({
          type: "notice",
          tabId: handlerTabId,
          message: "agent busy — handler prompt rejected",
        });
        throw new Error("agent busy — prompt in flight");
      }
      handlerTab.promptInFlight = true;
      handlerTab.agentEndFired = false;
      state.currentAgentTabId = handlerTabId;
      deps.send({
        type: "prompt_started",
        tabId: handlerTabId,
        source: "handler",
      });
      try {
        await state.tabContext.run(handlerTabId, () =>
          handlerTab.session.prompt(text),
        );
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        deps.send({
          type: "notice",
          tabId: handlerTabId,
          message: `handler prompt: ${m}`,
        });
        throw err;
      } finally {
        if (!handlerTab.agentEndFired) {
          handlerTab.promptInFlight = false;
          deps.send({ type: "response_end", tabId: handlerTabId });
        }
        if (state.currentAgentTabId === handlerTabId) {
          state.currentAgentTabId = undefined;
        }
        maybeExitForReload(state, deps);
      }
    },
    notify(message: string) {
      if (!message) return;
      deps.send({ type: "notice", tabId: handlerTabId, message });
    },
    get session() {
      const messages = handlerTab.session.messages ?? [];
      return {
        model: handlerTab.session.model
          ? modelKey(handlerTab.session.model)
          : "",
        messages: messages.slice(-50),
      };
    },
    get signal() {
      return (
        handlerTab.session as {
          agent?: { signal?: AbortSignal };
        }
      ).agent?.signal;
    },
  };
}
