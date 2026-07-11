import {
  useMemo,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from "react";

export type AppState = Record<string, unknown>;
export type AppStateUpdate = SetStateAction<AppState>;
export type AppStateSelector<T> = (state: AppState) => T;
export type EqualityFn<T> = (a: T, b: T) => boolean;

export interface AppStore {
  getState: () => AppState;
  setState: Dispatch<AppStateUpdate>;
  subscribe: (listener: () => void) => () => void;
  subscribeSelector: <T>(
    selector: AppStateSelector<T>,
    listener: (next: T, prev: T) => void,
    equality?: EqualityFn<T>,
  ) => () => void;
  stateRef: { current: AppState };
}

const objectIs = <T>(a: T, b: T) => Object.is(a, b);

export function createAppStore(initialState: AppState): AppStore {
  let state = initialState;
  const stateRef = { current: state };
  const listeners = new Set<() => void>();

  const getState = () => state;

  const setState: Dispatch<AppStateUpdate> = (update) => {
    const next = typeof update === "function" ? update(state) : update;
    if (Object.is(next, state)) return;
    state = next;
    stateRef.current = next;
    for (const listener of [...listeners]) listener();
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const subscribeSelector = <T>(
    selector: AppStateSelector<T>,
    listener: (next: T, prev: T) => void,
    equality: EqualityFn<T> = objectIs,
  ) => {
    let selected = selector(state);
    return subscribe(() => {
      const next = selector(state);
      if (equality(selected, next)) return;
      const prev = selected;
      selected = next;
      listener(next, prev);
    });
  };

  return { getState, setState, subscribe, subscribeSelector, stateRef };
}

export function useAppState<T>(
  store: AppStore,
  selector: AppStateSelector<T>,
  equality: EqualityFn<T> = objectIs,
): T {
  const subscription = useMemo(
    () => createSelectorSubscription(store, selector, equality),
    [equality, selector, store],
  );
  return useSyncExternalStore(
    subscription.subscribe,
    subscription.getSnapshot,
    subscription.getSnapshot,
  );
}

function createSelectorSubscription<T>(
  store: AppStore,
  selector: AppStateSelector<T>,
  equality: EqualityFn<T>,
): { subscribe: (listener: () => void) => () => void; getSnapshot: () => T } {
  let selected = selector(store.getState());
  const listeners = new Set<() => void>();
  let unsubscribeStore: (() => void) | null = null;
  const onStoreChange = () => {
    const next = selector(store.getState());
    if (equality(selected, next)) return;
    selected = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    getSnapshot: () => selected,
    subscribe: (listener) => {
      listeners.add(listener);
      unsubscribeStore ??= store.subscribe(onStoreChange);
      // Reconcile a store update that landed between render and subscription.
      onStoreChange();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsubscribeStore?.();
          unsubscribeStore = null;
        }
      };
    },
  };
}
