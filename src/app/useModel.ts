/**
 * Runs the math core for the UI: builds the corner from the editable geometry, sweeps the travel
 * range (for plots, trails and ghosts) and solves the current position warm-started from the
 * nearest sweep sample.
 */
import { useMemo } from 'react';
import { useApp, toGeometry } from './store';
import { DoubleWishbone, type CornerState } from '../core/suspension/doubleWishbone';
import { characteristics, deg, type Characteristics } from '../core/suspension/characteristics';

export interface Sample {
  travel: number;
  state: CornerState;
  chars: Characteristics;
}

export interface Current extends Sample {
  /** deg per mm of travel */
  camberGain: number;
  /** toe change, deg per mm of travel */
  bumpSteer: number;
}

export interface Model {
  error: string | null;
  corner: DoubleWishbone | null;
  sweep: Sample[];
  current: Current | null;
}

const SWEEP_STEPS = 41;

export function useModel(): Model {
  const geom = useApp((s) => s.geom);
  const travel = useApp((s) => s.travel);
  const rack = useApp((s) => s.rack);
  const driver = useApp((s) => s.driver);
  const droop = useApp((s) => s.droop);
  const bump = useApp((s) => s.bump);

  const built = useMemo(() => {
    try {
      return { corner: new DoubleWishbone(toGeometry(geom)), error: null };
    } catch (e) {
      return { corner: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [geom]);

  const sweep = useMemo<Sample[]>(() => {
    const corner = built.corner;
    if (!corner) return [];
    const lo = -Math.abs(droop);
    const hi = Math.abs(bump);
    const travels = Array.from({ length: SWEEP_STEPS }, (_, i) => lo + ((hi - lo) * i) / (SWEEP_STEPS - 1));
    const states = corner.sweep(travels, (t) => ({ travel: t, rack, driver }));
    return states.map((state, i) => ({ travel: travels[i]!, state, chars: characteristics(state) }));
  }, [built, rack, driver, droop, bump]);

  const current = useMemo<Current | null>(() => {
    const corner = built.corner;
    if (!corner) return null;
    let nearest: Sample | undefined;
    for (const s of sweep) if (!nearest || Math.abs(s.travel - travel) < Math.abs(nearest.travel - travel)) nearest = s;
    const warm = nearest?.state.poses;
    const state = corner.solve({ travel, rack, driver }, warm);
    const chars = characteristics(state);
    const h = 0.5;
    const minus = characteristics(corner.solve({ travel: travel - h, rack, driver }, state.poses));
    const plus = characteristics(corner.solve({ travel: travel + h, rack, driver }, state.poses));
    return {
      travel, state, chars,
      camberGain: (deg(plus.camber) - deg(minus.camber)) / (2 * h),
      bumpSteer: (deg(plus.toe) - deg(minus.toe)) / (2 * h),
    };
  }, [built, sweep, travel, rack, driver]);

  return { error: built.error, corner: built.corner, sweep, current };
}
