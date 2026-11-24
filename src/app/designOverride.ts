/**
 * Another design in place of the current one (R9, compare): under `DesignOverride`, the model hooks
 * (useModel, useVehicle) read that design (the snapshot's model and tests) instead of the current one,
 * with everything else — the sliders, the load cases, the view — from the app as it is. So the snapshot is
 * worked out by the same code, at the same state, as the current design.
 */
import { createContext, useContext } from 'react';
import { useApp, mergedCorners, rootOf, type AppState, type DesignState } from './store';
import type { CornerId } from '../core/vehicle/vehicle';

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

/**
 * A design with another corner active (as the store's setActiveCorner does: the active corner's design is
 * the top-level one): so a snapshot is shown for the same corner as the current design.
 */
const byCorner = new WeakMap<DesignState, Map<CornerId, DesignState>>();
export function withActiveCorner(d: DesignState, id: CornerId): DesignState {
  if (d.activeCorner === id) return d;
  let m = byCorner.get(d);
  if (!m) { m = new Map(); byCorner.set(d, m); }
  let out = m.get(id);
  if (!out) {
    const corners = mergedCorners(d);
    const root = rootOf(id, d.links);
    out = { ...d, corners, activeCorner: id, ...corners[root], damperCurve: corners[root].damperCurve };
    m.set(id, out);
  }
  return out;
}

/** `useApp(selector)`, reading the overriding design when there is one. */
export function useDesignApp<T>(selector: (s: AppState) => T): T {
  const design = useContext(DesignOverride);
  return useApp(design ? (s: AppState) => selector(withDesign(s, design)) : selector);
}
