/**
 * Vehicle view model (L6): builds all four corners from their (linked) designs, solves the whole-car
 * equilibrium, and derives the results shown in the Vehicle view.
 */
import { rollStiffness, ackermannLinesCross } from '../core/suspension/derived';
import { brakesOf, trailerOf } from './optimizer';
import { useDesignApp } from './designOverride';
import { useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  toGeometry, toProfile, toForceModel, mergedCorners, rootOf, vehicleStaticLoads,
  type CornerDesign, type DesignState,
} from './store';
import { DoubleWishbone, type CornerState } from '../core/suspension/doubleWishbone';
import { characteristics, type Characteristics } from '../core/suspension/characteristics';
import { fitFreeLength } from '../core/suspension/spring';
import { contactPatch, type ContactPatch, type TireProfile } from '../core/tire/geometry';
import type { TireForceModel } from '../core/tire/model';
import { CornerTable } from '../core/vehicle/cornerTable';
import { AxleTable, AxleCornerTable } from '../core/vehicle/axleTable';
import type { CornerTableLike } from '../core/vehicle/vehicle';
import {
  CORNER_IDS, isLeft, isFront, placement, poseFns, solveVehicle, vehicleAt, designGroundY, axleRollCenter,
  type CornerId, type VehicleResult, type ChassisPose, type VehicleCorner, type AxleShared,
} from '../core/vehicle/vehicle';
import type { SharedDesign } from './store';
import { vec3, Y_AXIS, type Vec3 } from '../core/math/vec3';
import { roadEffective } from '../core/tests/segments';
import { tireGripFor, aeroOf } from './optimizer';

const G = 9.80665;
/** A "rigid" tire is modelled as a very stiff one so every corner has a defined tire force. */
const RIGID_TIRE: TireForceModel = { kind: 'stiffness', rate: 1e5 };

export interface VehicleCornerView {
  id: CornerId;
  root: CornerId;
  rack: number;
  state: CornerState;
  chars: Characteristics;
  patch: ContactPatch | null;
  /** World spin axis (outboard). */
  axisWorld: Vec3;
  profile: TireProfile;
  /** Anti-roll-bar drop-link mount (corner frame, moved with the arm), if a torsion bar is used. */
  dropLink: Vec3 | null;
  unsprungMass: number;
}

export interface AxleTransfer {
  /** Lateral load transfer, N (+ = outside tire gains load). */
  total: number;
  /** Part carried through the links (roll-center height), N. */
  geometric: number;
  /** Part carried through the springs (body roll), N. */
  elastic: number;
}

export interface VehicleModel {
  error: string | null;
  result: VehicleResult | null;
  corners: Partial<Record<CornerId, VehicleCornerView>>;
  staticLoads: Record<CornerId, number>;
  groundY: number;
  /** Roll centers in world coordinates (x, y) and height above ground. */
  rollCenters: { front: { x: number; y: number; h: number } | null; rear: { x: number; y: number; h: number } | null };
  rideHeight: { front: number; rear: number };
  transfer: { front: AxleTransfer; rear: AxleTransfer; lltdFront: number };
  /** Roll stiffness per axle from this cornering state, N·m/deg (NaN without cornering), and roll per g. */
  rollStiffness: { front: number; rear: number };
  rollGradient: number;
  /**
   * Classic Ackermann lines (vehicle frame, sprung): each front steering axis (at the tie-rod height) through
   * its outer tie-rod joint, and where they cross (null = parallel). 100 % Ackermann: on the rear axle.
   */
  ackermannLines: AckermannAxle[];
  /** Longitudinal (braking) load transfer onto the front axle vs. static, N. */
  frontLoadGain: number;
  /** Classic geometric anti-dive (front) and anti-lift (rear) under braking, % (side-view IC, brake mount, bias). */
  antiDive: number;
  antiLift: number;
  /** Classic geometric anti-squat (rear) and front anti-lift under acceleration, % (side-view IC, drive mount, split). */
  antiSquat: number;
  antiLiftAccel: number;
  rolloverG: number;
  sprungCgWorld: Vec3 | null;
  wheelbase: number;
  /** Accelerations used in the solve, g (+ lateral = left turn, + longitudinal = accelerating). */
  accel: { lateral: number; longitudinal: number };
}

const pickVehicleInputs = (s: DesignState) => ({
  geom: s.geom, spring: s.spring, damper: s.damper, bumpStop: s.bumpStop, damperMode: s.damperMode, damperCurve: s.damperCurve, tireModel: s.tireModel, tire: s.tire,
  volumeChange: s.volumeChange, tireSizeText: s.tireSizeText, corners: s.corners, links: s.links,
  settings: s.settings, activeCorner: s.activeCorner, vehicle: s.vehicle, autoPreload: s.autoPreload,
  droop: s.droop, bump: s.bump, shared: s.shared,
});

/** Playback's corner tables, shared by every view of the same corner design (keyed by its design, rack and range). */
const PLAYBACK_TABLES = new Map<string, CornerTable>();

export function useVehicle(enabled: boolean): VehicleModel | null {
  const s = useDesignApp(useShallow(pickVehicleInputs));
  // Motion inputs are separate so moving a slider doesn't rebuild the corners (or their cached curves).
  const rack = useDesignApp((st) => st.rack);
  const lateralGKin = useDesignApp((st) => st.lateralG);
  const longitudinalG = useDesignApp((st) => st.longitudinalG);
  const roadGrade = useDesignApp((st) => st.roadGrade);
  const roadBank = useDesignApp((st) => st.roadBank);
  const wheelBumps = useDesignApp((st) => st.wheelBumps);
  const gripFields = useDesignApp((st) => st.tireGrip);
  // The test playback's pose (ride over time) belongs to the Tests workspace only: elsewhere the car is solved.
  // The playback's pose (Tests, and Compare's test views).
  const rideView = useDesignApp((st) => (st.workspace === 'tests' || st.workspace === 'compare' ? st.rideView : null));
  // Steering playing in the Vehicle view: the rack moves every frame, so the tables are made the playback way
  // (rounded rack, 21 points, the shared cache) — a 41-point table per frame made ▶ Steer lag (round 4).
  const steerPlay = useDesignApp((st) => !!st.playingSteer);
  const tireFile = useDesignApp((st) => st.tireFile);
  const tireFileRear = useDesignApp((st) => st.tireFileRear);
  const aeroSettings = useDesignApp((st) => st.aero);
  const brakeSettings = useDesignApp((st) => st.brakes);
  const towSettings = useDesignApp((st) => st.tow);
  const speed = useDesignApp((st) => st.vehicleSpeed);
  // Grade and bank fold into what the tires must supply (see core/tests/segments.ts).
  const road = roadEffective(lateralGKin, longitudinalG, Math.atan(roadGrade / 100), (roadBank * Math.PI) / 180);
  const lateralG = road.lateralG;
  const brakingG = road.brakingG;
  const accelG = road.accelG;
  const tableCache = useRef(new WeakMap<object, Map<string, CornerTable>>());
  const axleCache = useRef(new WeakMap<object, Map<string, AxleTable>>());
  const lastPose = useRef<ChassisPose | undefined>(undefined);

  // Corners: linked corners share a design object (and so a DoubleWishbone and its tables).
  const setup = useMemo(() => {
    if (!enabled) return null;
    try {
      const all = mergedCorners(s as unknown as DesignState);
      const built = new Map<CornerDesign, { corner: DoubleWishbone; model: TireForceModel; profile: ReturnType<typeof toProfile>; key: string }>();
      for (const id of CORNER_IDS) {
        const d = all[rootOf(id, s.links)];
        if (!built.has(d)) {
          built.set(d, {
            corner: new DoubleWishbone(toGeometry(d.geom)),
            key: JSON.stringify(d.geom),
            model: toForceModel(d.tireModel, d.tire, d.volumeChange) ?? RIGID_TIRE,
            profile: toProfile(d.geom),
          });
        }
      }
      return { all, built, error: null as string | null };
    } catch (e) {
      return { all: null, built: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [enabled, s.geom, s.spring, s.damper, s.bumpStop, s.tireModel, s.tire, s.volumeChange, s.tireSizeText, s.corners, s.links, s.activeCorner]);

  // Playback: each frame's pose object is stable, so a frame shown once is shown again from here (until
  // anything else about the car changes).
  const frameCache = useMemo(() => new WeakMap<object, VehicleModel | null>(),
    [enabled, setup, s.vehicle, s.links, s.settings, s.autoPreload, s.droop, s.bump, s.shared, gripFields, tireFile, tireFileRear, aeroSettings, brakeSettings, towSettings, speed]);
  const result = useMemo<VehicleModel | null>(() => {
    if (rideView && frameCache.has(rideView)) return frameCache.get(rideView)!;
    const out = computeModel();
    if (rideView && out && !out.error) frameCache.set(rideView, out);
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, setup, s.vehicle, s.links, s.settings, s.autoPreload, s.droop, s.bump, s.shared, rack, lateralG, brakingG, accelG, road.gravityScale, wheelBumps, gripFields, rideView, tireFile, tireFileRear, aeroSettings, brakeSettings, towSettings, speed, frameCache, steerPlay]);

  function computeModel(): VehicleModel | null {
    if (!enabled || !setup) return null;
    const v = s.vehicle;
    const wheelbase = v.wheelbase.value;
    const empty: VehicleModel = {
      error: setup.error, result: null, corners: {}, staticLoads: { FL: 0, FR: 0, RL: 0, RR: 0 }, groundY: 0,
      rollCenters: { front: null, rear: null }, rideHeight: { front: NaN, rear: NaN },
      transfer: { front: { total: 0, geometric: 0, elastic: 0 }, rear: { total: 0, geometric: 0, elastic: 0 }, lltdFront: NaN },
      rollStiffness: { front: NaN, rear: NaN }, rollGradient: NaN, ackermannLines: [],
      rolloverG: NaN, sprungCgWorld: null, wheelbase, accel: { lateral: 0, longitudinal: 0 }, frontLoadGain: NaN, antiDive: NaN, antiLift: NaN, antiSquat: NaN, antiLiftAccel: NaN,
    };
    if (!setup.all || !setup.built) return empty;
    const all = setup.all;
    try {
      const staticLoads = vehicleStaticLoads(v, all, s.links);
      const range: [number, number] = [-Math.abs(s.droop), Math.abs(s.bump)];
      const corners: VehicleCorner[] = [];
      const racks = {} as Record<CornerId, number>;
      const groundInputs: Parameters<typeof designGroundY>[0] = [];
      for (const id of CORNER_IDS) {
        const d = all[rootOf(id, s.links)];
        const b = setup.built.get(d)!;
        const cornerRack = s.settings[id].steered ? (isLeft(id) ? rack : -rack) : 0;
        racks[id] = cornerRack;
        // Playing back (pose and travels given): the tables at the rack rounded to 1 mm, with 21 points, kept in
        // one cache for every view of the same design (the current car, a snapshot's ghost and its results). In a
        // turn the rack moves every frame, and a table per frame (41 solves per steered corner, per view) made
        // playback lag in turns; the corners drawn are still solved at the exact rack.
        const quick = !!rideView || steerPlay;
        const tableRack = quick ? Math.round(cornerRack) : cornerRack;
        let byRack = tableCache.current.get(b.corner);
        if (!byRack) { byRack = new Map(); tableCache.current.set(b.corner, byRack); }
        const axleShared = s.shared[isFront(id) ? 'front' : 'rear'];
        const dl = axleShared.antiRollBar === 'torsionBar'
          ? vec3(axleShared.dropLink[0].value, axleShared.dropLink[1].value, axleShared.dropLink[2].value) : null;
        const dlOn = axleShared.dropLinkOn ?? 'lca';
        const key = `${tableRack.toFixed(3)}|${range[0]}|${range[1]}|${dl ? `${dl.x},${dl.y},${dl.z},${dlOn}` : '-'}`;
        const mu = d.spring.unsprungMass.value;
        const rigid = b.corner.kind === 'rigid';
        // A solid axle: one table over both wheels' travel (cached with the design), preload from its heave ratio.
        let axleRef: { table: AxleTable; side: 'L' | 'R' } | undefined;
        let table: CornerTableLike | undefined;
        let freeLength = d.spring.freeLength.value;
        const coupled = b.corner.solidAxle ?? b.corner.twistBeam;
        if (coupled) {
          const axRack0 = b.corner.geometry.steeredAxle && s.settings[id].steered ? rack : 0;
          const axRack = quick ? Math.round(axRack0) : axRack0;
          // A drop-link anti-roll bar: the table tracks its mount on the axle (or on each twist-beam arm).
          const akey = `axle|${range[0]}|${range[1]}|${axRack}|${dl ? `${dl.x},${dl.y},${dl.z}` : '-'}`;
          let at = axleCache.current.get(b.corner)?.get(akey);
          if (!at) {
            at = new AxleTable(coupled, range, 17, axRack, dl ?? undefined);
            const byKey = axleCache.current.get(b.corner) ?? new Map<string, AxleTable>();
            byKey.set(akey, at);
            if (byKey.size > 12) byKey.delete(byKey.keys().next().value!);
            axleCache.current.set(b.corner, byKey);
          }
          const side = isLeft(id) ? 'L' : 'R';
          axleRef = { table: at, side };
          table = new AxleCornerTable(at, side);
          const s0 = at.at(side, 0, 0), mr = -(s0.dL + s0.dLX);
          if (s.autoPreload && Number.isFinite(s0.L) && mr > 1e-6) freeLength = s0.L + Math.max(0, staticLoads[id] - mu * G) / mr / d.spring.springRate.value;
        } else {
          const shared = quick ? `${b.key}|${key}` : null;
          let t = shared ? PLAYBACK_TABLES.get(shared) : byRack.get(key);
          if (!t) {
            t = new CornerTable(b.corner, tableRack, range, quick ? 21 : 41, dl ? { body: dlOn, point: dl } : undefined);
            if (shared) {
              PLAYBACK_TABLES.set(shared, t);
              if (PLAYBACK_TABLES.size > 160) PLAYBACK_TABLES.delete(PLAYBACK_TABLES.keys().next().value!);
            } else {
              byRack.set(key, t);
              if (byRack.size > 24) byRack.delete(byRack.keys().next().value!);
            }
          }
          table = t;
          if (s.autoPreload && !rigid) freeLength = fitFreeLength(b.corner, d.spring.springRate.value, Math.max(0, staticLoads[id] - mu * G));
        }
        corners.push({
          id, table: table!, ...(axleRef ? { axle: axleRef } : {}), unsprungMass: mu, ...(rigid ? { rigid: true } : {}), tire: { profile: b.profile, model: b.model, ...(tireFileRear && !isFront(id) ? { grip: tireGripFor({ tireGrip: gripFields, tireFile, tireFileRear }, 'rear') } : {}) }, brake: s.settings[id].brake, abs: s.settings[id].abs,
          drive: s.settings[id].powered ? s.settings[id].drive : 'none',
          spring: {
            rate: d.spring.springRate.value, freeLength,
            ...(d.bumpStop ? { bumpStopLength: d.damper.bumpStopLength.value, bumpStopRate: d.damper.bumpStopRate.value } : {}),
          },
        });
        const design = b.corner.design();
        groundInputs.push({ contactY: design.points.contact.y, profile: b.profile, model: b.model, staticLoad: staticLoads[id], tilt: design.spinAxis.y });
      }
      const groundY = designGroundY(groundInputs);
      const cg = vec3(v.cgX.value, groundY + v.cgY.value, v.cgZ.value);
      const toAxle = (a: SharedDesign): AxleShared => ({
        antiRollBar: a.antiRollBar === 'wheelRate' ? { kind: 'wheelRate', rate: a.arbRate.value }
          : a.antiRollBar === 'torsionBar'
            // N·m/deg → N·mm/rad
            ? { kind: 'torsionBar', barRate: a.barRate.value * 1000 * (180 / Math.PI), lever: a.lever.value }
            : { kind: 'none' },
        heaveSpring: a.heaveSpring === 'wheelRate' ? { kind: 'wheelRate', rate: a.heaveRate.value } : { kind: 'none' },
      });
      const brk = brakesOf({ ...s, brakes: brakeSettings } as never);
      const bias = brk && brakeSettings.useBias && Number.isFinite(brk.capacity.bias) ? brk.capacity.bias : v.brakeBias.value / 100;
      const vin = {
        corners, totalMass: v.mass.value, cg, wheelbase, groundY, lateralG, brakingG, brakeBias: bias,
        accelG, driveSplit: v.driveSplit.value / 100,
        shared: { front: toAxle(s.shared.front), rear: toAxle(s.shared.rear) },
        gravityScale: road.gravityScale, groundOffset: wheelBumps, tireGrip: tireGripFor({ tireGrip: gripFields, tireFile, tireFileRear }, 'front'),
        diff: { front: s.settings.FL.diff, rear: s.settings.RL.diff },
        ...(aeroOf({ aero: aeroSettings }) && speed > 0 ? { aero: { ...aeroOf({ aero: aeroSettings })!, speed } } : {}),
        ...(speed > 0 && v.rollingResistance.value > 0 ? { rollingResistance: v.rollingResistance.value } : {}),
        ...(brk ? { brakeLimit: { front: brk.capacity.axleForce.front, rear: brk.capacity.axleForce.rear, maxPedal: brk.system.maxPedalForce } } : {}),
        ...(trailerOf({ tow: towSettings }) ? { trailer: trailerOf({ tow: towSettings })! } : {}),
      };
      // Playback of the ride over time poses the car directly (body motion and travels from the simulation).
      const res = rideView ? vehicleAt(vin, rideView.pose, rideView.travel) : solveVehicle(vin, { guess: lastPose.current });
      if (res.converged) lastPose.current = res.pose;
      const P = poseFns(res.pose);

      // Exact corner states at the solved travels, for drawing and characteristics.
      const views: Partial<Record<CornerId, VehicleCornerView>> = {};
      // A solid axle or twist beam is one part under both wheels: solve it once at both travels and take
      // each corner from that (the right one from the axle's right side), so both wheels sit on it.
      const pairs = new Map<CornerId, ReturnType<DoubleWishbone['solveAxle']>>();
      const stateOf = (id: CornerId, corner: DoubleWishbone) => {
        if (!corner.solidAxle && !corner.twistBeam) return corner.solve({ travel: res.corners[id].travel, rack: racks[id] });
        const l: CornerId = isFront(id) ? 'FL' : 'RL', r: CornerId = isFront(id) ? 'FR' : 'RR';
        let pair = pairs.get(l);
        if (!pair) {
          const axRack = corner.geometry.steeredAxle && s.settings[l].steered ? rack : 0;
          pair = corner.solveAxle({ left: res.corners[l].travel, right: res.corners[r].travel, rack: axRack });
          pairs.set(l, pair);
        }
        return isLeft(id) ? pair.left : pair.right;
      };
      for (const c of corners) {
        const d = all[rootOf(c.id, s.links)];
        const b = setup.built.get(d)!;
        const state = stateOf(c.id, b.corner);
        const pl = placement(c.id, wheelbase);
        const wcWorld = P.point(pl.point(state.points.wheelCenter));
        const axisWorld = P.rot(pl.dir(state.spinAxis));
        const patch = contactPatch(wcWorld, axisWorld, { point: vec3(0, res.corners[c.id].groundY, 0), normal: Y_AXIS }, b.profile, 24);
        const axleShared = s.shared[isFront(c.id) ? 'front' : 'rear'];
        const dropLink = axleShared.antiRollBar === 'torsionBar'
          ? b.corner.pointOn(state, axleShared.dropLinkOn ?? 'lca', vec3(axleShared.dropLink[0].value, axleShared.dropLink[1].value, axleShared.dropLink[2].value))
          : null;
        views[c.id] = { id: c.id, root: rootOf(c.id, s.links), rack: racks[c.id], state, chars: characteristics(state), patch, axisWorld, profile: b.profile, dropLink, unsprungMass: c.unsprungMass };
      }

      // Roll centers from the actual left/right corners (front view, world).
      const rcFor = (l: CornerId, r: CornerId) => {
        const side = (id: CornerId) => {
          const view = views[id]!;
          const pl = placement(id, wheelbase);
          const toW = (p: Vec3) => P.point(pl.point(p));
          return { contact: toW(view.chars.contactPoint), ic: view.chars.frontViewIC ? toW(view.chars.frontViewIC) : null };
        };
        const rc = axleRollCenter(side(l), side(r));
        return rc ? { ...rc, h: rc.y - groundY } : null;
      };
      const rollCenters = { front: rcFor('FL', 'FR'), rear: rcFor('RL', 'RR') };

      // Lateral load transfer per axle, split into link (geometric) and spring (elastic) parts.
      const outsideSign = Math.sign(lateralG) || 1; // left turn (+) loads the right side
      const axle = (l: CornerId, r: CornerId, rc: { h: number } | null): AxleTransfer => {
        const L = res.corners[l];
        const R = res.corners[r];
        const total = (outsideSign * (R.tireLoad - L.tireLoad)) / 2;
        const track = L.contact.x - R.contact.x;
        const lateral = Math.abs(L.lateralForce + R.lateralForce);
        const geometric = rc && track > 0 ? (lateral * rc.h) / track : 0;
        return { total, geometric, elastic: total - geometric };
      };
      const front = axle('FL', 'FR', rollCenters.front);
      const rear = axle('RL', 'RR', rollCenters.rear);
      const trackF = res.corners.FL.contact.x - res.corners.FR.contact.x;
      const trackR = res.corners.RL.contact.x - res.corners.RR.contact.x;
      const ride = (z: number) => P.point(vec3(0, 0, z)).y - groundY;
      // Classic anti-dive / anti-lift from the side-view IC: tan θ · (L / h) · axle brake share.
      // θ from the contact patch (outboard brake) or the wheel center (inboard brake).
      const antiOf = (ids: CornerId[], share: number, sign: number) => {
        const vals = ids.filter((id) => s.settings[id].brake !== 'none').map((id) => {
          const ch = views[id]!.chars;
          const th = s.settings[id].brake === 'inboard' ? ch.antiAngleWheelCenter : ch.antiAngleContact;
          return sign * Math.tan(th) * (wheelbase / v.cgY.value) * share * 100;
        });
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      };
      const frontStatic = staticLoads.FL + staticLoads.FR;
      // Anti-squat (rear) / anti-lift (front) under acceleration: θ from the wheel center for a
      // chassis diff, from the contact patch for a hub motor; share = the axle's drive share.
      const poweredIds = CORNER_IDS.filter((id) => s.settings[id].powered);
      const frontPowered = poweredIds.filter((id) => isFront(id));
      const rearPowered = poweredIds.filter((id) => !isFront(id));
      const split = frontPowered.length && rearPowered.length ? v.driveSplit.value / 100 : frontPowered.length ? 1 : 0;
      const driveAnti = (ids: CornerId[], share: number, sign: number) => {
        const vals = ids.map((id) => {
          const ch = views[id]!.chars;
          const th = s.settings[id].drive === 'hub' ? ch.antiAngleContact : ch.antiAngleWheelCenter;
          return sign * Math.tan(th) * (wheelbase / v.cgY.value) * share * 100;
        });
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
      };
      return {
        error: res.converged ? (res.notes.length ? res.notes.join(' ') : null) : 'Vehicle solve did not fully converge — check corner travel ranges and loads.',
        result: res, corners: views, staticLoads, groundY, rollCenters,
        rideHeight: { front: ride(0), rear: ride(-wheelbase) },
        transfer: { front, rear, lltdFront: front.total + rear.total !== 0 ? front.total / (front.total + rear.total) : NaN },
        rollStiffness: Math.abs(lateralG) > 0.02
          ? { front: rollStiffness(front.elastic, trackF, (res.pose.roll * 180) / Math.PI), rear: rollStiffness(rear.elastic, trackR, (res.pose.roll * 180) / Math.PI) }
          : { front: NaN, rear: NaN },
        rollGradient: Math.abs(lateralG) > 0.02 ? Math.abs((res.pose.roll * 180) / Math.PI / lateralG) : NaN,
        ackermannLines: ackermannAxles(views, s.settings, wheelbase),
        rolloverG: (0.5 * (trackF + trackR)) / (2 * v.cgY.value),
        frontLoadGain: res.corners.FL.tireLoad + res.corners.FR.tireLoad - frontStatic,
        antiDive: antiOf(['FL', 'FR'], bias, 1),
        // Rear: a side-view IC ahead of and above the wheel resists lift.
        antiLift: antiOf(['RL', 'RR'], 1 - bias, -1),
        antiSquat: driveAnti(rearPowered, 1 - split, -1),
        antiLiftAccel: driveAnti(frontPowered, split, 1),
        sprungCgWorld: P.point(res.sprungCg),
        wheelbase,
        accel: { lateral: lateralG, longitudinal: res.notes.length ? -brakingG : accelG - brakingG },
      };
    } catch (e) {
      return { ...empty, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return result;
}

export { isFront };

/** One axle's Ackermann lines (vehicle frame, design-frame points of the solved corners). */
export interface AckermannAxle {
  axle: 'front' | 'rear';
  /** Per steered corner: its steering axis at the outer tie-rod joint's height (k) and that joint (t). */
  lines: { id: CornerId; k: Vec3; t: Vec3; axis: [Vec3, Vec3] }[];
  /** Where the two lines cross in top view (null: one line, or parallel). */
  cross: { x: number; z: number } | null;
  /** Where they should cross for classic Ackermann: the other axle's center, or midway when both axles steer. */
  target: { x: number; z: number; label: string };
}

/**
 * Classic Ackermann check for every steered corner, per axle: from its steering axis through its steering
 * arm's outer joint (top view). A non-steered corner has no line.
 */
export function ackermannAxles(views: Partial<Record<CornerId, VehicleCornerView>>, settings: Record<CornerId, { steered: boolean }>, wheelbase: number): AckermannAxle[] {
  const arm = (id: CornerId) => {
    const v = views[id];
    if (!v || !settings[id].steered) return null;
    const p = v.state.points, pl = placement(id, wheelbase);
    const lo = p.steerLower, up = p.steerUpper, t = p.trOuter;
    const f = Math.abs(up.y - lo.y) > 1e-9 ? (t.y - lo.y) / (up.y - lo.y) : 0;
    return { id, k: pl.point(vec3(lo.x + f * (up.x - lo.x), t.y, lo.z + f * (up.z - lo.z))), t: pl.point(t), axis: [pl.point(lo), pl.point(up)] as [Vec3, Vec3] };
  };
  const frontSteers = settings.FL.steered || settings.FR.steered, rearSteers = settings.RL.steered || settings.RR.steered;
  const out: AckermannAxle[] = [];
  for (const [axle, l, r] of [['front', 'FL', 'FR'], ['rear', 'RL', 'RR']] as const) {
    const lines = [arm(l), arm(r)].filter((x): x is NonNullable<typeof x> => !!x);
    if (!lines.length) continue;
    const cross = lines.length === 2 ? ackermannLinesCross(lines[0]!.k, lines[0]!.t, lines[1]!.k, lines[1]!.t) : null;
    const target = frontSteers && rearSteers ? { x: 0, z: -wheelbase / 2, label: 'Midway (both axles steer)' }
      : axle === 'front' ? { x: 0, z: -wheelbase, label: 'Rear axle center' } : { x: 0, z: 0, label: 'Front axle center' };
    out.push({ axle, lines, cross, target });
  }
  return out;
}
