/**
 * Runs the math core for the UI.
 *
 * Kinematic mode: travel comes from the slider.
 * Loaded mode: the corner settles — travel is the spring equilibrium for the (scaled) corner load.
 * In both modes, a selected tire model carries the tire load and the coilover is evaluated
 * (motion ratio, wheel rate, ride rate, ride frequency).
 */
import { useMemo, useRef } from 'react';
import { useApp, ratioSpecOf, toGeometry, toProfile, toForceModel, sprungLoad, vehicleStaticLoads, mergedCorners } from './store';
import { DoubleWishbone, type CornerState } from '../core/suspension/doubleWishbone';
import { rollCamber, ackermann } from '../core/suspension/derived';
import { steeringWheelAngle, inputPerRev } from '../core/tests/steer';
import type { SteeringMechanism } from '../core/suspension/steering';
import { normalize as normV, sub as subV, add as addV } from '../core/math/vec3';
import { mulVec } from '../core/math/mat3';
import { centerLinkPose } from '../core/suspension/steering';

/** How the corner's steering input moves the inner tie-rod joint. */
const mechanismOf = (c: { rackAxis: import('../core/math/vec3').Vec3; geometry: import('../core/suspension/doubleWishbone').DoubleWishboneGeometry }, input = 0): SteeringMechanism => {
  const s = c.geometry.steering;
  if (s?.kind === 'centerLink') {
    // The inner joint rides on the center link: its motion per radian of pitman angle (central difference at the input).
    const at = (deg: number) => { const cl = centerLinkPose(s, deg); return cl ? addV(cl.A, mulVec(cl.R, subV(c.geometry.tieRod.inner, cl.A0))) : null; };
    const a = at(input - 0.05), b = at(input + 0.05);
    const k = 180 / Math.PI / 0.1;
    return { kind: 'arm', pivot: s.pivot1, axis: normV(subV(s.pivot2, s.pivot1)), ...(a && b ? { rate: { x: (b.x - a.x) * k, y: (b.y - a.y) * k, z: (b.z - a.z) * k } } : {}) };
  }
  return s?.kind === 'arm' ? { kind: 'arm', pivot: s.pivot1, axis: normV(subV(s.pivot2, s.pivot1)) } : { kind: 'rack', axis: c.rackAxis };
};
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
  /** Ackermann % with the mirrored corner at this rack travel (NaN near straight ahead). */
  ackermann: number;
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
  /** Caster and KPI change, deg per mm of travel. */
  casterGain: number;
  kpiGain: number;
  /** Half-track change (scrub), mm per mm of travel (+ = contact moves outboard in bump). */
  trackChange: number;
  /** Roll-center height change, mm per mm of travel (mirrored corner). */
  rcMigration: number;
  /** Outside wheel's camber change to the ground per degree of body roll (deg/deg; 1 = leans with the body). */
  rollCamber: number;
  /** Outside wheel's KPI and caster change to the ground per degree of body roll (°/°). */
  rollKpi: number;
  rollCaster: number;
  /** Compliance (arm bushings): toe / camber change per kN of side force (tire pushed inboard) and per kN of braking, °/kN. */
  compliance: { lateral: { toe: number; camber: number }; braking: { toe: number; camber: number } } | null;
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
  const rawRack = useApp((s) => s.rack);
  // Corners that don't steer keep the rack (toe link) fixed.
  const steered = useApp((s) => s.settings[s.activeCorner].steered);
  const rack = steered ? rawRack : 0;
  const sliderDriver = useApp((s) => s.driver);
  const droop = useApp((s) => s.droop);
  const bump = useApp((s) => s.bump);
  const tireModel = useApp((s) => s.tireModel);
  const tire = useApp((s) => s.tire);
  const volumeChange = useApp((s) => s.volumeChange);
  const mode = useApp((s) => s.mode);
  const loadFactor = useApp((s) => s.loadFactor);
  const manualSpring = useApp((s) => s.spring);
  // The corner load follows the vehicle's static weight on this corner unless set manually.
  const vehicleLoad = useApp((s) => (s.cornerLoadMode === 'vehicle' ? vehicleStaticLoads(s.vehicle, mergedCorners(s), s.links)[s.activeCorner] : null));
  const spring = useMemo(
    () => (vehicleLoad === null ? manualSpring : { ...manualSpring, cornerLoad: { text: vehicleLoad.toFixed(0), value: vehicleLoad } }),
    [manualSpring, vehicleLoad],
  );
  const damper = useApp((s) => s.damper);
  const bumpStop = useApp((s) => s.bumpStop);
  const steer = useApp((s) => s.steer);
  const cFactor = steer.cFactor.value;
  const curveText = useApp((s) => s.steerCurve);
  const ratioSpec = { ...ratioSpecOf({ steer, steerCurve: curveText }), cFactor };
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
  // `built` only changes when the settled geometry changes, so sweeps don't re-run mid-drag.
  const built = useMemo(() => build(sweepGeom), [sweepGeom]);
  const live = useMemo(() => (geom === sweepGeom ? built : build(geom)), [geom, sweepGeom, built]);

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
  // While dragging, slow extras reuse their last values so the drag stays responsive.
  const lastSlow = useRef<{ wheelRate: number; tireRate: number; steering: SteeringInfo | null; compliance?: Current['compliance'] }>({ wheelRate: NaN, tireRate: Infinity, steering: null });
  const lastSteerSweep = useRef<SteerSample[]>([]);

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
      if (!Number.isFinite(wheelRate) && interacting) wheelRate = lastSlow.current.wheelRate;
      if (!Number.isFinite(wheelRate)) {
        const a = wheelLoadAt(corner, spec, travel - h, rack, state.poses);
        const b = wheelLoadAt(corner, spec, travel + h, rack, state.poses);
        wheelRate = (b.wheelForce - a.wheelForce) / (b.state.points.contact.y - a.state.points.contact.y);
      }
      const force = springForce(spec, L);
      const wheelForce = force * mr;
      if (mode !== 'loaded' && staticSprung > 0) effFactor = Math.max(0, wheelForce / staticSprung);
      const kt = interacting ? lastSlow.current.tireRate : tireSetup
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

    const computeSteering = (): SteeringInfo => {
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
    const mech = mechanismOf(corner, rack);
    const cLocal = inputPerRev(rack, ratioSpec);
    const loads = steeringLoads(state, contact, forces, mech, cLocal);
    const axisGround = loaded?.steeringAxisAtGround ?? chars.steeringAxisAtGround;
    const samples = loaded && tireSetup
      ? patchSamples(state.points.wheelCenter, state.spinAxis, { point: vec3(0, loaded.groundY, 0), normal: Y_AXIS }, tireSetup.profile, 24, 10)
      : { points: [contact], weights: [1] };
    const parkT = axisGround ? parkingTorque(samples, axisGround, vertical, steer.mu.value) : NaN;
    const lever = Math.abs(steeringArmLever(state));
    const rackShare = Math.abs(dot(normalize(sub(state.points.trInner, state.points.trOuter)), corner.rackAxis));
    const parkRack = (parkT / lever) * rackShare;
    return {
      roadWheelAngle: headingAngle(state.spinAxis) - headingAngle(straight.spinAxis),
      steeringWheelAngle: steeringWheelAngle(rack, ratioSpec),
      ratio: ((1 / cLocal) * 360) / Math.abs(dHeading),
      loads,
      parkingTorque: parkT,
      parkingRackForce: parkRack,
      // Steering arm: through the overall ratio (virtual work), the same as rack force × c / 2π for a rack.
      parkingWheelTorque: mech.kind === 'arm' ? (parkT / (((1 / cLocal) * 360) / Math.abs(dHeading))) / 1000 : (parkRack * cLocal) / (2 * Math.PI) / 1000,
    };
    };
    // A beam axle doesn't steer here: no steering readout.
    const steering = (corner.solidAxle && !corner.geometry.steeredAxle) || corner.twistBeam ? null : interacting && lastSlow.current.steering ? lastSlow.current.steering : computeSteering();
    if (!interacting) {
      lastSlow.current = { wheelRate: springInfo?.wheelRate ?? NaN, tireRate: springInfo?.tireRate ?? Infinity, steering };
    }

    // A twist beam cambers differently in roll (each arm about bushing → shear center) than in heave.
    let rollCamberGain: number | null = null;
    if (corner.twistBeam) {
      const tb = corner.twistBeam, q = state.inputs.travel;
      const cam = (l: number, r: number) => { const w = tb.solve({ left: l, right: r }).left; return deg(Math.asin(Math.max(-1, Math.min(1, -w.spinAxis.y)))); };
      rollCamberGain = (cam(q + h, q - h) - cam(q - h, q + h)) / (2 * h);
    }
    return {
      travel, state, chars, loaded, spring: springInfo, steering, loadFactor: effFactor, tireLoad: effTireLoad,
      camberGain: (deg(plus.camber) - deg(minus.camber)) / (2 * h),
      bumpSteer: (deg(plus.toe) - deg(minus.toe)) / (2 * h),
      casterGain: (deg(plus.caster) - deg(minus.caster)) / (2 * h),
      kpiGain: (deg(plus.kpi) - deg(minus.kpi)) / (2 * h),
      trackChange: (plus.halfTrack - minus.halfTrack) / (2 * h),
      rcMigration: plus.rollCenterHeight !== null && minus.rollCenterHeight !== null ? (plus.rollCenterHeight - minus.rollCenterHeight) / (2 * h) : NaN,
      rollCamber: rollCamber(rollCamberGain ?? (deg(plus.camber) - deg(minus.camber)) / (2 * h), chars.halfTrack),
      // Body roll tips the outside wheel's axis outward by the roll (KPI falls by it); its bump changes both.
      rollKpi: -1 + ((deg(plus.kpi) - deg(minus.kpi)) / (2 * h)) * (Math.PI / 180) * chars.halfTrack,
      rollCaster: ((deg(plus.caster) - deg(minus.caster)) / (2 * h)) * (Math.PI / 180) * chars.halfTrack,
      compliance: interacting ? lastSlow.current.compliance ?? null : (() => {
        const b = useApp.getState().geom.bushing;
        try { const r = corner.compliance(state, { radial: b?.radial.value ?? 5000, axial: b?.axial.value ?? 1500 }); lastSlow.current.compliance = r; return r; } catch { return null; }
      })(),
    };
  }, [live, sweep, sliderTravel, rack, driver, mode, factor, spec, ws, droop, bump, tireSetup, spring, steer, cFactor, damperLimits, interacting]);

  // Steering sweep across the rack range at the current arm position.
  const armKey = current && built.corner ? Math.round(lowerArmAngle(built.corner.geometry, current.state) * 1e5) : 0;
  const rackLimit = steer.rackLimit.value;
  const wheelbase = useApp((s) => s.vehicle.wheelbase.value);
  const curTireLoad = Math.round(current?.tireLoad ?? spring.cornerLoad.value);
  const steerSweep = useMemo<SteerSample[]>(() => {
    const corner = built.corner;
    if (!corner || !current || (corner.solidAxle && !corner.geometry.steeredAxle) || corner.twistBeam) return [];
    if (interacting) return lastSteerSweep.current;
    const armAngle = armKey / 1e5;
    const n = 25;
    const racks = Array.from({ length: n }, (_, i) => -rackLimit + (2 * rackLimit * i) / (n - 1));
    const states = corner.sweep(racks, (r) => ({ driver: 'lowerArmAngle', armAngle, rack: r }));
    const mid = corner.solve({ driver: 'lowerArmAngle', armAngle, rack: 0 }, states[(n - 1) / 2]!.poses);
    const h0 = headingAngle(mid.spinAxis);
    const y0 = mid.points.contact.y;
    // Ackermann with the mirrored corner: this wheel at rack r, its mirror image at −r (yaw + = left).
    const yaw = states.map((st) => headingAngle(st.spinAxis) - h0);
    const g0 = characteristics(mid).steeringAxisAtGround;
    const steerTrack = 2 * Math.abs(g0 ? g0.x : mid.points.contact.x);
    return states.map((st, i) => {
      const c = characteristics(st);
      const l = steeringLoads(st, c.contactPoint, { vertical: curTireLoad, lateral: 0, longitudinal: 0, pneumaticTrail: 0 }, mechanismOf(corner, rack), inputPerRev(racks[i]!, ratioSpec));
      return {
        rack: racks[i]!, steeringWheelAngle: steeringWheelAngle(racks[i]!, ratioSpec),
        roadWheelAngle: headingAngle(st.spinAxis) - h0, camber: c.camber,
        jacking: y0 - st.points.contact.y, centeringTorque: l.steeringWheelTorque,
        ackermann: ackermann(yaw[i]!, -yaw[n - 1 - i]!, wheelbase, steerTrack).percent,
      };
    });
  }, [built, armKey, rackLimit, cFactor, ratioSpec.cFactorLock, curTireLoad, interacting, wheelbase]);
  if (!interacting) lastSteerSweep.current = steerSweep;

  return { error: live.error, corner: live.corner, sweep, current, steerSweep, damperLimits };
}
