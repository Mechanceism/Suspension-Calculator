/**
 * Another design in place of the current one (R9, compare): under `DesignOverride`, the model hooks
 * (useModel, useVehicle) read that design (the snapshot's model and tests) instead of the current one,
 * with everything else — the sliders, the load cases, the view — from the app as it is. So the snapshot is
 * worked out by the same code, at the same state, as the current design.
 */
import { createContext, useContext } from 'react';
import { useApp, type AppState, type DesignState } from './store';

export const DesignOverride = createContext<DesignState | null>(null);

// One merged state per (app state, design): the selectors see the same object across calls.
const merged = new WeakMap<AppState, WeakMap<DesignState, AppState>>();
export function withDesign(s: AppState, design: DesignState): AppState {
  let byDesign = merged.get(s);
  if (!byDesign) { byDesign = new WeakMap(); merged.set(s, byDesign); }
  let m = byDesign.get(design);
  if (!m) { m = { ...s, ...design }; byDesign.set(design, m); }
  return m;
}

/** `useApp(selector)`, reading the overriding design when there is one. */
export function useDesignApp<T>(selector: (s: AppState) => T): T {
  const design = useContext(DesignOverride);
  return useApp(design ? (s: AppState) => selector(withDesign(s, design)) : selector);
}
