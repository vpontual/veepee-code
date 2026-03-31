import { useSyncExternalStore } from 'react';
import type { AppState, AppAction } from './types.js';
import { appReducer, initialState } from './reducer.js';

type Listener = () => void;

export interface Store {
  getState(): AppState;
  dispatch(action: AppAction): void;
  subscribe(listener: Listener): () => void;
}

/** Create an external store that works with both React (useSyncExternalStore) and imperative code */
export function createStore(): Store {
  let state = { ...initialState };
  const listeners = new Set<Listener>();

  return {
    getState() {
      return state;
    },

    dispatch(action: AppAction) {
      state = appReducer(state, action);
      for (const listener of listeners) {
        listener();
      }
    },

    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** React hook to use the external store */
export function useStore(store: Store): AppState {
  return useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState,
  );
}

/** React hook to select a slice of state (prevents unnecessary re-renders) */
export function useStoreSelector<T>(store: Store, selector: (state: AppState) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}
