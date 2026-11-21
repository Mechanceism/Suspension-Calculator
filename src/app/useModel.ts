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
import { patchSamples } from '../core/tire/geometry';
import { dot, vec3, Y_AXIS, type Vec3 } from '../core/math/vec3';
import { damperTravelLimits, type TravelLimits } from '../core/suspension/spring';
import {
  headingAngle, lowerArmAngle, steeringLoads, steeringArmLever, parkingTorque, type SteeringLoads,
} from '../core/suspension/steering';
import { normalize, sub } from '../core/math/vec3';

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

export interface SteeringInfo {
  /** Road-wheel angle relative to straight ahead at the same arm position (rad, + = front toward outboard). */
  roadWheelAngle: number;
  /** Steering-wheel angle (deg) from rack travel and the c-factor. */
  steeringWheelAngle: number;
  /** Overall steering ratio at the current position (steering-wheel deg per road-wheel deg). */
  ratio: number;
  loads: SteeringLoads;
  /** Parking (standstill) scrub torque about the steering axis, N·mm, and what it takes at the rack / wheel. */
  parkingTorque: number;
  parkingRackForce: number;
  parkingWheelTorque: number;
}

export interface SteerSample {
  rack: number;
  steeringWheelAngle: number;
  roadWheelAngle: number;
  camber: number;
  /** Body rise from steering at a fixed arm position (contact drop), mm. */
  jacking: number;
  /** Steering-wheel torque from the vertical load alone (self-centering), N·m. */
  centeringTorque: number;
}

export interface Current extends Omit<Sample, 'spring'> {
  steering: SteeringInfo | null;
  /** Effective load factor (set in loaded mode, implied by the spring in kinematic mode). */
  loadFactor: number;
  /** Tire vertical load at this position, N. */
  tireLoad: number;
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
  steerSweep: SteerSample[];
  damperLimits: TravelLimits | null;
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
  const damper = useApp((s) => s.damper);
  const bumpStop = useApp((s) => s.bumpStop);
  const steer = useApp((s) => s.steer);
  const cFactor = steer.cFactor.value;
  const driver = mode === 'loaded' ? 'wheelCenter' : sliderDriver;
  const factor = mode === 'loaded' ? loadFactor : 1;

  // While a joint is being dragged, the heavy sweeps (trails, curves, limits) keep the last settled
  // geometry and catch up on release; the current position always uses the live geometry.
  const interacting = useApp((s) => s.interacting);
  const settledGeom = useRef(geom);
  if (!interacting) settledGeom.current = geom;
  const sweepGeom = settledGeom.current;
  const build = (g: typeof geom) => {
    try {
      return { corner: new DoubleWishbone(toGeometry(g)), error: null };
    } catch (e) {
      return { corner: null, error: e instanceof Error ? e.message : String(e) };
    }
  };
  const live = useMemo(() => build(geom), [geom]);
  const built = useMemo(() => (sweepGeom === geom ? live : build(sweepGeom)), [sweepGeom, geom, live]);

  const spec = useMemo<SpringSpec>(() => ({
    rate: spring.springRate.value, freeLength: spring.freeLength.value,
    ...(bumpStop ? { bumpStopLength: damper.bumpStopLength.value, bumpStopRate: damper.bumpStopRate.value } : {}),
  }), [spring, damper, bumpStop]);

  const damperLimits = useMemo(() => {
    const corner = built.corner;
    if (!corner?.geometry.damper) return null;
    return damperTravelLimits(corner, damper.minLength.value, damper.maxLength.value, rack);
  }, [built, damper, rack]);
  const ws = sprungLoad(spring, factor);

  const tireSetup = useMemo(() => {
    const model = toForceModel(tireModel, tire, volumeChange);
    return model ? { model, profile: toProfile(geom) } : null;
  }, [tireModel, tire, volumeChange, geom.scalars]); // the profile only depends on the tire scalars

  const staticLoad = spring.cornerLoad.value;
  const makeLoader = (load: number) => (tireSetup
    ? (state: CornerState, chars: Characteristics) => loadCorner(state, chars, tireSetup.profile, tireSetup.model, load)
    : null);
  // Through-travel curves use the static load so animating the load factor doesn't rebuild them.
  const sweepLoader = useMemo(() => makeLoader(staticLoad), [tireSetup, staticLoad]);
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
    const corner = live.corner;
    if (!corner) return null;
    const hasSpring = Boolean(corner.geometry.damper);

    let state: CornerState;
    let travel = sliderTravel;
    let status: EquilibriumStatus | null = null;
    let wheelRate = NaN;
    if (mode === 'loaded' && hasSpring) {
      // Settle within the travel range, tightened to the damper stroke when it's shorter.
      const lo = Math.max(-Math.abs(droop), damperLimits?.droop ?? -Infinity);
      const hi = Math.min(Math.abs(bump), damperLimits?.bump ?? Infinity);
      const eq = solveEquilibrium(corner, spec, ws, [lo, hi], rack, lastEquilibrium.current);
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
    // Travel and load are tied together by the spring: in loaded mode the load factor sets the
    // travel; in kinematic mode the travel implies a load factor (spring wheel force ÷ static sprung load).
    const staticSprung = sprungLoad(spring, 1);
    let effFactor = factor;
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
      const force = springForce(spec, L);
      const wheelForce = force * mr;
      if (mode !== 'loaded' && staticSprung > 0) effFactor = Math.max(0, wheelForce / staticSprung);
      const kt = tireSetup
        ? tireRate(tireSetup.model, tireSetup.profile, dot(Y_AXIS, state.spinAxis), Math.max(spring.cornerLoad.value * effFactor, 1))
        : Infinity;
      // Natural frequency uses the static sprung mass; the load factor is extra g, not extra mass.
      const ride = rideMetrics(wheelRate, kt, staticSprung / G);
      springInfo = {
        length: L, compression: spec.freeLength - L, force, motionRatio: mr, wheelForce,
        wheelRate, tireRate: kt, rideRate: ride.rideRate, frequency: ride.frequency,
        sprungLoad: mode === 'loaded' ? ws : wheelForce, status,
      };
    }
    const effTireLoad = spring.cornerLoad.value * effFactor;
    const loaded = tireSetup ? loadCorner(state, chars, tireSetup.profile, tireSetup.model, effTireLoad) : null;

    // Steering: compare with straight ahead at the same arm position.
    const armAngle = lowerArmAngle(corner.geometry, state);
    const atRack = (r: number) => corner.solve({ driver: 'lowerArmAngle', armAngle, rack: r }, state.poses);
    const straight = atRack(0);
    const rp = atRack(rack + 0.5);
    const rm = atRack(rack - 0.5);
    const dHeading = deg(headingAngle(rp.spinAxis) - headingAngle(rm.spinAxis));
    const vertical = loaded ? loaded.force.force : effTireLoad;
    const contact = loaded?.patch.centroid ?? chars.contactPoint;
    const forces = {
      vertical, lateral: steer.lateral.value, longitudinal: steer.longitudinal.value, pneumaticTrail: steer.pneumaticTrail.value,
    };
    const loads = steeringLoads(state, contact, forces, corner.rackAxis, cFactor);
    const axisGround = loaded?.steeringAxisAtGround ?? chars.steeringAxisAtGround;
    const samples = loaded && tireSetup
      ? patchSamples(state.points.wheelCenter, state.spinAxis, { point: vec3(0, loaded.groundY, 0), normal: Y_AXIS }, tireSetup.profile, 24, 10)
      : { points: [contact], weights: [1] };
    const parkT = axisGround ? parkingTorque(samples, axisGround, vertical, steer.mu.value) : NaN;
    const lever = Math.abs(steeringArmLever(state));
    const rackShare = Math.abs(dot(normalize(sub(state.points.trInner, state.points.trOuter)), corner.rackAxis));
    const parkRack = (parkT / lever) * rackShare;
    const steering: SteeringInfo = {
      roadWheelAngle: headingAngle(state.spinAxis) - headingAngle(straight.spinAxis),
      steeringWheelAngle: (rack / cFactor) * 360,
      ratio: ((1 / cFactor) * 360) / Math.abs(dHeading),
      loads,
      parkingTorque: parkT,
      parkingRackForce: parkRack,
      parkingWheelTorque: (parkRack * cFactor) / (2 * Math.PI) / 1000,
    };

    return {
      travel, state, chars, loaded, spring: springInfo, steering, loadFactor: effFactor, tireLoad: effTireLoad,
      camberGain: (deg(plus.camber) - deg(minus.camber)) / (2 * h),
      bumpSteer: (deg(plus.toe) - deg(minus.toe)) / (2 * h),
    };
  }, [live, sweep, sliderTravel, rack, driver, mode, factor, spec, ws, droop, bump, tireSetup, spring, steer, cFactor, damperLimits]);

  // Steering sweep across the rack range at the current arm position.
  const armKey = current && built.corner ? Math.round(lowerArmAngle(built.corner.geometry, current.state) * 1e5) : 0;
  const rackLimit = steer.rackLimit.value;
  const curTireLoad = Math.round(current?.tireLoad ?? spring.cornerLoad.value);
  const steerSweep = useMemo<SteerSample[]>(() => {
    const corner = built.corner;
    if (!corner || !current) return [];
    const armAngle = armKey / 1e5;
    const n = 25;
    const racks = Array.from({ length: n }, (_, i) => -rackLimit + (2 * rackLimit * i) / (n - 1));
    const states = corner.sweep(racks, (r) => ({ driver: 'lowerArmAngle', armAngle, rack: r }));
    const mid = corner.solve({ driver: 'lowerArmAngle', armAngle, rack: 0 }, states[(n - 1) / 2]!.poses);
    const h0 = headingAngle(mid.spinAxis);
    const y0 = mid.points.contact.y;
    return states.map((st, i) => {
      const c = characteristics(st);
      const l = steeringLoads(st, c.contactPoint, { vertical: curTireLoad, lateral: 0, longitudinal: 0, pneumaticTrail: 0 }, corner.rackAxis, cFactor);
      return {
        rack: racks[i]!, steeringWheelAngle: (racks[i]! / cFactor) * 360,
        roadWheelAngle: headingAngle(st.spinAxis) - h0, camber: c.camber,
        jacking: y0 - st.points.contact.y, centeringTorque: l.steeringWheelTorque,
      };
    });
  }, [built, armKey, rackLimit, cFactor, curTireLoad]);

  return { error: live.error, corner: live.corner, sweep, current, steerSweep, damperLimits };
}
