/**
 * Extension-registered keybindings. Combo is a "+"-joined token
 * ("Cmd+Shift+P", "Ctrl+]", "Alt+M") — frontend normalizes to a canonical
 * form for keydown matching. Action is an opaque string the handler can
 * branch on; defaults to the combo. Same dispatch shape as slash commands:
 * paired with aethon.onEvent({componentType: "keybinding", descendantId:
 * "<combo>"}, handler) for the actual behavior.
 */

import type { AethonAgentState, MutationResult } from "./state";
import { trackMutation } from "./mutation-ack";

export interface KeybindingsDeps {
  send: (obj: Record<string, unknown>) => void;
  scheduleStateFileWrite: () => void;
}

/** Parse and normalize a "Cmd+Shift+P"-style combo into the canonical
 *  form the frontend uses for matching. Modifier order is fixed so two
 *  registrations of the same combo (different surface order) collapse.
 *
 *  Aliases: cmd|command → meta, control → ctrl, option → alt. */
export function canonicalizeCombo(input: string): string {
  const parts = input
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const aliased = parts.map((p) =>
    p === "cmd" || p === "command"
      ? "meta"
      : p === "control"
        ? "ctrl"
        : p === "option"
          ? "alt"
          : p,
  );
  const mods = new Set<string>();
  let key = "";
  for (const p of aliased) {
    if (p === "meta" || p === "ctrl" || p === "alt" || p === "shift") {
      mods.add(p);
    } else {
      key = p;
    }
  }
  const ordered = ["meta", "ctrl", "alt", "shift"].filter((m) => mods.has(m));
  return [...ordered, key].filter(Boolean).join("+");
}

export function registerKeybinding(
  state: AethonAgentState,
  deps: KeybindingsDeps,
  binding: unknown,
): Promise<MutationResult> {
  if (!binding || typeof binding !== "object") {
    return Promise.resolve({ ok: false, error: "binding requires { combo }" });
  }
  const obj = binding as {
    combo?: unknown;
    action?: unknown;
    description?: unknown;
  };
  const combo = typeof obj.combo === "string" ? obj.combo.trim() : "";
  if (!combo) {
    const errorMsg =
      'registerKeybinding: combo required (e.g. "Cmd+Shift+P")';
    deps.send({ type: "notice", message: errorMsg });
    return Promise.resolve({ ok: false, error: errorMsg });
  }
  const canonical = canonicalizeCombo(combo);
  if (!canonical) {
    const errorMsg = "registerKeybinding: combo must include a key";
    deps.send({ type: "notice", message: errorMsg });
    return Promise.resolve({ ok: false, error: errorMsg });
  }
  const action =
    typeof obj.action === "string" && obj.action ? obj.action : canonical;
  const description =
    typeof obj.description === "string" ? obj.description : undefined;
  state.extensionKeybindings.set(canonical, {
    combo: canonical,
    action,
    ...(description ? { description } : {}),
  });
  const list = [...state.extensionKeybindings.values()];
  const { id, promise } = trackMutation(state);
  deps.send({ type: "extension_keybindings", mutationId: id, bindings: list });
  deps.scheduleStateFileWrite();
  return promise;
}

export function unregisterKeybinding(
  state: AethonAgentState,
  deps: KeybindingsDeps,
  combo: unknown,
): Promise<MutationResult> {
  if (typeof combo !== "string" || !combo.trim()) {
    return Promise.resolve({ ok: false, error: "combo required" });
  }
  const had = state.extensionKeybindings.delete(canonicalizeCombo(combo));
  if (!had) {
    return Promise.resolve({ ok: false, error: "no such combo" });
  }
  const list = [...state.extensionKeybindings.values()];
  const { id, promise } = trackMutation(state);
  deps.send({ type: "extension_keybindings", mutationId: id, bindings: list });
  deps.scheduleStateFileWrite();
  return promise;
}
