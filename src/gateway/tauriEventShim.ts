// Aliased in place of `@tauri-apps/api/event` for the mobile build.
// Bridges Tauri's `listen` onto the gateway's topic subscription: an
// event name maps to a gateway topic, and each frame's verbatim payload
// is delivered as the Tauri `Event.payload` the frontend already expects.
//
// Events the desktop never mirrors over the gateway (e.g. `menu`,
// window drag) simply never fire — identical to the app's behaviour in
// a plain browser today.

import { gateway } from "./transport";

export type UnlistenFn = () => void;

export interface Event<T> {
  event: string;
  id: number;
  payload: T;
}
export type EventCallback<T> = (event: Event<T>) => void;

let eventSeq = 0;

export function listen<T = unknown>(
  event: string,
  handler: EventCallback<T>,
): Promise<UnlistenFn> {
  const unsub = gateway.subscribe(event, (payload) => {
    handler({ event, id: eventSeq++, payload: payload as T });
  });
  return Promise.resolve(unsub);
}

export function once<T = unknown>(
  event: string,
  handler: EventCallback<T>,
): Promise<UnlistenFn> {
  let unsub: UnlistenFn = () => {};
  unsub = gateway.subscribe(event, (payload) => {
    unsub();
    handler({ event, id: eventSeq++, payload: payload as T });
  });
  return Promise.resolve(unsub);
}

/** The reused frontend emits exactly once (the native-canvas window,
 *  never mounted on mobile). A no-op keeps that path inert. */
export function emit(event: string, _payload?: unknown): Promise<void> {
  if (import.meta.env?.DEV) {
    console.warn(`[gateway] emit(${event}) is a no-op on the companion surface`);
  }
  return Promise.resolve();
}

export function emitTo(
  _target: unknown,
  event: string,
  _payload?: unknown,
): Promise<void> {
  return emit(event);
}
