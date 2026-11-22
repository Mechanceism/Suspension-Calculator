/**
 * Vehicle view model (L6): builds all four corners from their (linked) designs, solves the whole-car
 * equilibrium, and derives the results shown in the Vehicle view.
 */
import { useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  useApp, toGeometry, toProfile, toForceModel, mergedCorners, rootOf, vehicleStaticLoads,
  type CornerDesign, type DesignState,
} from './store';
import { DoubleWishbone, type CornerState } from '../core/suspension/doubleWishbone';
import { characteristics, type Characteristics } from '../core/suspension/characteristics';
import { fitFreeLength } from '../core/suspension/spring';
import { contactPatch, type ContactPatch, type TireProfile } from '../core/tire/geometry';
import type { TireForceModel } from '../core/tire/model';
import { CornerTable } from '../core/vehicle/cornerTable';
import {
  CORNER_IDS, isLeft, isFront, placement, poseFns, solveVehicle, vehicleAt, designGroundY, axleRollCenter,
  type CornerId, type VehicleResult, type ChassisPose, type VehicleCorner, type AxleShared,
} from '../core/vehicle/vehicle';
import type { SharedDesign } from './store';
import { vec3, Y_AXIS, type Vec3 } from '../core/math/vec3';
import { roadEffective } from '../core/tests/segments';
import { tireGripOf } from './optimizer';

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
  geom: s.geom, spring: s.spring, damper: s.damper, bumpStop: s.bumpStop, tireModel: s.tireModel, tire: s.tire,
  volumeChange: s.volumeChange, tireSizeText: s.tireSizeText, corners: s.corners, links: s.links,
  settings: s.settings, activeCorner: s.activeCorner, vehicle: s.vehicle, autoPreload: s.autoPreload,
  droop: s.droop, bump: s.bump, shared: s.shared,
});

export function useVehicle(enabled: boolean): VehicleModel | null {
  const s = useApp(useShallow(pickVehicleInputs));
  // Motion inputs are separate so moving a slider doesn't rebuild the corners (or their cached curves).
  const rack = useApp((st) => st.rack);
  const lateralGKin = useApp((st) => st.lateralG);
  const longitudinalG = useApp((st) => st.longitudinalG);
  const roadGrade = useApp((st) => st.roadGrade);
  const roadBank = useApp((st) => st.roadBank);
  const wheelBumps = useApp((st) => st.wheelBumps);
  const gripFields = useApp((st) => st.tireGrip);
  const rideView = useApp((st) => st.rideView);
  // Grade and bank fold into what the tires must supply (see core/tests/segments.ts).
  const road = roadEffective(lateralGKin, longitudinalG, Math.atan(roadGrade / 100), (roadBank * Math.PI) / 180);
  const lateralG = road.lateralG;
  const brakingG = road.brakingG;
  const accelG = road.accelG;
  const tableCache = useRef(new WeakMap<object, Map<string, CornerTable>>());
  const lastPose = useRef<ChassisPose | undefined>(undefined);

  // Corners: linked corners share a design object (and so a DoubleWishbone and its tables).
  const setup = useMemo(() => {
    if (!enabled) return null;
    try {
      const all = mergedCorners(s as unknown as DesignState);
      const built = new Map<CornerDesign, { corner: DoubleWishbone; model: TireForceModel; profile: ReturnType<typeof toProfile> }>();
      for (const id of CORNER_IDS) {
        const d = all[rootOf(id, s.links)];
        if (!built.has(d)) {
          built.set(d, {
            corner: new DoubleWishbone(toGeometry(d.geom)),
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

  const result = useMemo<VehicleModel | null>(() => {
    if (!enabled || !setup) return null;
    const v = s.vehicle;
    const wheelbase = v.wheelbase.value;
    const empty: VehicleModel = {
      error: setup.error, result: null, corners: {}, staticLoads: { FL: 0, FR: 0, RL: 0, RR: 0 }, groundY: 0,
      rollCenters: { front: null, rear: null }, rideHeight: { front: NaN, rear: NaN },
      transfer: { front: { total: 0, geometric: 0, elastic: 0 }, rear: { total: 0, geometric: 0, elastic: 0 }, lltdFront: NaN },
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
        let byRack = tableCache.current.get(b.corner);
        if (!byRack) { byRack = new Map(); tableCache.current.set(b.corner, byRack); }
        const axleShared = s.shared[isFront(id) ? 'front' : 'rear'];
        const dl = axleShared.antiRollBar === 'torsionBar'
          ? vec3(axleShared.dropLink[0].value, axleShared.dropLink[1].value, axleShared.dropLink[2].value) : null;
        const key = `${cornerRack.toFixed(3)}|${range[0]}|${range[1]}|${dl ? `${dl.x},${dl.y},${dl.z}` : '-'}`;
        let table = byRack.get(key);
        if (!table) {
          table = new CornerTable(b.corner, cornerRack, range, 41, dl ? { body: 'lca', point: dl } : undefined);
          byRack.set(key, table);
          if (byRack.size > 24) byRack.delete(byRack.keys().next().value!);
        }
        const mu = d.spring.unsprungMass.value;
        const freeLength = s.autoPreload
          ? fitFreeLength(b.corner, d.spring.springRate.value, Math.max(0, staticLoads[id] - mu * G))
          : d.spring.freeLength.value;
        corners.push({
          id, table, unsprungMass: mu, tire: { profile: b.profile, model: b.model }, brake: s.settings[id].brake, abs: s.settings[id].abs,
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
      const bias = v.brakeBias.value / 100;
      const vin = {
        corners, totalMass: v.mass.value, cg, wheelbase, groundY, lateralG, brakingG, brakeBias: bias,
        accelG, driveSplit: v.driveSplit.value / 100,
        shared: { front: toAxle(s.shared.front), rear: toAxle(s.shared.rear) },
        gravityScale: road.gravityScale, groundOffset: wheelBumps, tireGrip: tireGripOf(gripFields),
        diff: { front: s.settings.FL.diff, rear: s.settings.RL.diff },
      };
      // Playback of the ride over time poses the car directly (body motion and travels from the simulation).
      const res = rideView ? vehicleAt(vin, rideView.pose, rideView.travel) : solveVehicle(vin, { guess: lastPose.current });
      if (res.converged) lastPose.current = res.pose;
      const P = poseFns(res.pose);

      // Exact corner states at the solved travels, for drawing and characteristics.
      const views: Partial<Record<CornerId, VehicleCornerView>> = {};
      for (const c of corners) {
        const d = all[rootOf(c.id, s.links)];
        const b = setup.built.get(d)!;
        const state = b.corner.solve({ travel: res.corners[c.id].travel, rack: racks[c.id] });
        const pl = placement(c.id, wheelbase);
        const wcWorld = P.point(pl.point(state.points.wheelCenter));
        const axisWorld = P.rot(pl.dir(state.spinAxis));
        const patch = contactPatch(wcWorld, axisWorld, { point: vec3(0, res.corners[c.id].groundY, 0), normal: Y_AXIS }, b.profile, 24);
        const axleShared = s.shared[isFront(c.id) ? 'front' : 'rear'];
        const dropLink = axleShared.antiRollBar === 'torsionBar'
          ? b.corner.pointOn(state, 'lca', vec3(axleShared.dropLink[0].value, axleShared.dropLink[1].value, axleShared.dropLink[2].value))
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
  }, [enabled, setup, s.vehicle, s.links, s.settings, s.autoPreload, s.droop, s.bump, s.shared, rack, lateralG, brakingG, accelG, road.gravityScale, wheelBumps, gripFields, rideView]);

  return result;
}

export { isFront };
