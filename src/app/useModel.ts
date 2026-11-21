/**
 * Runs the math core for the UI.
 *
 * Kinematic mode: travel comes from the slider.
 * Loaded mode: the corner settles — travel is the spring equilibrium for the (scaled) corner load.
 * In both modes, a selected tire model carries the tire load and the coilover is evaluated
 * (motion ratio, wheel rate, ride rate, ride frequency).
 */
import { useMemo, useRef } from 'react';
import { useApp, toGeometry, toProfile, toForceModel, sprungLoad } from './store';
import { DoubleWishbone, type CornerState } from '../core/suspension/doubleWishbone';
import { characteristics, deg, type Characteristics } from '../core/suspension/characteristics';
import { loadCorner, type LoadedCorner } from '../core/suspension/loaded';
import {
  springLength, springForce, wheelLoadAt, solveEquilibrium, rideMetrics,
  type SpringSpec, type EquilibriumStatus,
} from '../core/suspension/spring';
import { tireRate } from '../core/tire/model';
import { dot, Y_AXIS } from '../core/math/vec3';

export interface SampleSpring {
  length: number;
  motionRatio: number;
  wheelForce: number;
  wheelRate: number;
}

export interface Sample {
  travel: number;
  state: CornerState;
  chars: Characteristics;
  /** Present when a tire force model is selected. */
  loaded: LoadedCorner | null;
  spring: SampleSpring | null;
}

export interface SpringInfo {
  length: number;
  compression: number;
  force: number;
  motionRatio: number;
  wheelForce: number;
  wheelRate: number;
  tireRate: number;
  rideRate: number;
  frequency: number;
  sprungLoad: number;
  /** Loaded mode only: whether the equilibrium was found inside the travel range. */
  status: EquilibriumStatus | null;
}

export interface Current extends Omit<Sample, 'spring'> {
  /** deg per mm of travel */
  camberGain: number;
  /** toe change, deg per mm of travel */
  bumpSteer: number;
  spring: SpringInfo | null;
}

export interface Model {
  error: string | null;
  corner: DoubleWishbone | null;
  sweep: Sample[];
  current: Current | null;
}

const SWEEP_STEPS = 41;
const G = 9.80665;

export function useModel(): Model {
  const geom = useApp((s) => s.geom);
  const sliderTravel = useApp((s) => s.travel);
  const rack = useApp((s) => s.rack);
  const sliderDriver = useApp((s) => s.driver);
  const droop = useApp((s) => s.droop);
  const bump = useApp((s) => s.bump);
  const tireModel = useApp((s) => s.tireModel);
  const tire = useApp((s) => s.tire);
  const volumeChange = useApp((s) => s.volumeChange);
  const mode = useApp((s) => s.mode);
  const loadFactor = useApp((s) => s.loadFactor);
  const spring = useApp((s) => s.spring);
  const driver = mode === 'loaded' ? 'wheelCenter' : sliderDriver;
  const factor = mode === 'loaded' ? loadFactor : 1;

  const built = useMemo(() => {
    try {
      return { corner: new DoubleWishbone(toGeometry(geom)), error: null };
    } catch (e) {
      return { corner: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [geom]);

  const spec = useMemo<SpringSpec>(() => ({ rate: spring.springRate.value, freeLength: spring.freeLength.value }), [spring]);
  const tireLoad = spring.cornerLoad.value * factor;
  const ws = sprungLoad(spring, factor);

  const tireSetup = useMemo(() => {
    const model = toForceModel(tireModel, tire, volumeChange);
    return model ? { model, profile: toProfile(geom) } : null;
  }, [tireModel, tire, volumeChange, geom]);

  const staticLoad = spring.cornerLoad.value;
  const makeLoader = (load: number) => (tireSetup
    ? (state: CornerState, chars: Characteristics) => loadCorner(state, chars, tireSetup.profile, tireSetup.model, load)
    : null);
  // Through-travel curves use the static load so animating the load factor doesn't rebuild them.
  const sweepLoader = useMemo(() => makeLoader(staticLoad), [tireSetup, staticLoad]);
  const loader = useMemo(() => makeLoader(tireLoad), [tireSetup, tireLoad]);
  const lastEquilibrium = useRef<number | undefined>(undefined);

  const kinematicSweep = useMemo(() => {
    const corner = built.corner;
    if (!corner) return [];
    const lo = -Math.abs(droop);
    const hi = Math.abs(bump);
    const travels = Array.from({ length: SWEEP_STEPS }, (_, i) => lo + ((hi - lo) * i) / (SWEEP_STEPS - 1));
    const states = corner.sweep(travels, (t) => ({ travel: t, rack, driver }));
    return states.map((state, i) => ({ travel: travels[i]!, state, chars: characteristics(state) }));
  }, [built, rack, driver, droop, bump]);

  const sweep = useMemo<Sample[]>(() => {
    const lengths = kinematicSweep.map((s) => springLength(s.state));
    const ys = kinematicSweep.map((s) => s.state.points.contact.y);
    const n = kinematicSweep.length;
    // Motion ratio and wheel force from neighbouring samples (central differences).
    const springs: (SampleSpring | null)[] = kinematicSweep.map((_, i) => {
      const L = lengths[i];
      if (L === null || L === undefined || n < 2) return null;
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      const mr = -((lengths[b] ?? 0) - (lengths[a] ?? 0)) / (ys[b]! - ys[a]!);
      return { length: L, motionRatio: mr, wheelForce: springForce(spec, L) * mr, wheelRate: NaN };
    });
    springs.forEach((s, i) => {
      if (!s) return;
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      const fa = springs[a];
      const fb = springs[b];
      if (fa && fb) s.wheelRate = (fb.wheelForce - fa.wheelForce) / (ys[b]! - ys[a]!);
    });
    return kinematicSweep.map((s, i) => ({ ...s, loaded: sweepLoader ? sweepLoader(s.state, s.chars) : null, spring: springs[i] ?? null }));
  }, [kinematicSweep, sweepLoader, spec]);

  const current = useMemo<Current | null>(() => {
    const corner = built.corner;
    if (!corner) return null;
    const hasSpring = Boolean(corner.geometry.damper);

    let state: CornerState;
    let travel = sliderTravel;
    let status: EquilibriumStatus | null = null;
    let wheelRate = NaN;
    if (mode === 'loaded' && hasSpring) {
      const eq = solveEquilibrium(corner, spec, ws, [-Math.abs(droop), Math.abs(bump)], rack, lastEquilibrium.current);
      lastEquilibrium.current = eq.travel;
      state = eq.load.state;
      travel = eq.travel;
      status = eq.status;
      wheelRate = eq.wheelRate;
    } else {
      let nearest: Sample | undefined;
      for (const s of sweep) if (!nearest || Math.abs(s.travel - travel) < Math.abs(nearest.travel - travel)) nearest = s;
      state = corner.solve({ travel, rack, driver }, nearest?.state.poses);
    }
    const chars = characteristics(state);
    const h = 0.5;
    const minusState = corner.solve({ travel: travel - h, rack, driver }, state.poses);
    const plusState = corner.solve({ travel: travel + h, rack, driver }, state.poses);
    const minus = characteristics(minusState);
    const plus = characteristics(plusState);
    const loaded = loader ? loader(state, chars) : null;

    let springInfo: SpringInfo | null = null;
    const L = springLength(state);
    if (hasSpring && L !== null) {
      const dy = plusState.points.contact.y - minusState.points.contact.y;
      const mr = -(springLength(plusState)! - springLength(minusState)!) / dy;
      if (!Number.isFinite(wheelRate)) {
        const a = wheelLoadAt(corner, spec, travel - h, rack, state.poses);
        const b = wheelLoadAt(corner, spec, travel + h, rack, state.poses);
        wheelRate = (b.wheelForce - a.wheelForce) / (b.state.points.contact.y - a.state.points.contact.y);
      }
      const kt = tireSetup
        ? tireRate(tireSetup.model, tireSetup.profile, dot(Y_AXIS, state.spinAxis), Math.max(tireLoad, 1))
        : Infinity;
      // Natural frequency uses the static sprung mass; the load factor is extra g, not extra mass.
      const ride = rideMetrics(wheelRate, kt, sprungLoad(spring, 1) / G);
      const force = springForce(spec, L);
      springInfo = {
        length: L, compression: spec.freeLength - L, force, motionRatio: mr, wheelForce: force * mr,
        wheelRate, tireRate: kt, rideRate: ride.rideRate, frequency: ride.frequency, sprungLoad: ws, status,
      };
    }

    return {
      travel, state, chars, loaded, spring: springInfo,
      camberGain: (deg(plus.camber) - deg(minus.camber)) / (2 * h),
      bumpSteer: (deg(plus.toe) - deg(minus.toe)) / (2 * h),
    };
  }, [built, sweep, sliderTravel, rack, driver, loader, mode, spec, ws, droop, bump, tireSetup, tireLoad, spring]);

  return { error: built.error, corner: built.corner, sweep, current };
}
