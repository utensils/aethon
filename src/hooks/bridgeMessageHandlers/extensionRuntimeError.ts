import type { BridgeMessageHandler } from "./types";

/** Sticky, deduped notification per extension. Bridge already
 *  rate-limits the underlying log line, so we get one notification when
 *  the misbehavior starts (or resumes after the suppression window) —
 *  not one every 2s. */
export const handleExtensionRuntimeError: BridgeMessageHandler = (data, ctx) => {
  const name = (data.name as string | undefined) ?? "(unknown)";
  const kind = (data.kind as string | undefined) ?? "error";
  const path = (data.path as string | undefined) ?? "";
  const sizeKB = data.sizeKB as number | undefined;
  const limitKB = data.limitKB as number | undefined;
  const message =
    kind === "state-too-large" && sizeKB !== undefined && limitKB !== undefined
      ? `setState ${path} rejected — ${sizeKB} KB exceeds ${limitKB} KB limit. Store file paths, not content.`
      : `Extension reported a runtime error.`;
  ctx.pushNotification({
    id: `ext-runtime-error:${name}`,
    title: `Extension \`${name}\` is misbehaving`,
    message,
    kind: "warning",
    durationMs: null,
  });
};
