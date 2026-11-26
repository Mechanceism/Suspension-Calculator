/**
 * The results the panels show, as data (R9: the Compare tab shows the same rows for both designs side by
 * side): the Corner results (Readout) and the whole car's (Vehicle results). Values are numbers in base
 * units (formatted with `digits` when shown); `text` stands in where a row isn't a number.
 */
import { deg } from '../core/suspension/characteristics';
import type { RolloverStats } from '../core/vehicle/rollover';
import { dampingRatio } from '../core/suspension/spring';
import { CORNER_IDS } from '../core/vehicle/vehicle';
import type { Model } from './useModel';
import type { VehicleModel } from './useVehicle';

export interface ResultRow {
  group: string;
  label: string;
  value?: number;
  digits: number;
  unit: string;
  hint?: string;
  /** Shown instead of the value (not a number: "parallel", "one steered wheel"…). */
  text?: string;
  /** Shown as "value of `of`" (e.g. the pedal force needed of the most). */
  of?: number;
}
const G = 9.80665;
const r = (group: string, label: string, value: number | undefined | null, digits: number, unit: string, hint?: string): ResultRow =>
  ({ group, label, value: value ?? undefined, digits, unit, ...(hint ? { hint } : {}) });

/** The Corner results (the active corner at the current travel / steer). `damper`: its bump and rebound damping rates. */
export function cornerResultRows(model: Model, damper: { bump: number; rebound: number }): ResultRow[] {
  const cur = model.current;
  if (!cur) return [];
  const c = cur.chars;
  const Gm = 'Geometry';
  const rows: ResultRow[] = [
    r(Gm, 'Camber', deg(c.camber), 3, '°', '+ = top outboard'),
    r(Gm, 'Camber gain', cur.camberGain, 4, '°/mm'),
    r(Gm, 'Toe', deg(c.toe), 3, '°', '+ = toe-in'),
    r(Gm, 'Bump steer', cur.bumpSteer, 4, '°/mm'),
    r(Gm, 'Caster', deg(c.caster), 2, '°', '+ = top rearward'),
    r(Gm, 'Caster gain', cur.casterGain, 4, '°/mm', 'caster change per mm of bump'),
    r(Gm, 'KPI', deg(c.kpi), 2, '°', '+ = top inboard'),
    r(Gm, 'KPI gain', cur.kpiGain, 4, '°/mm'),
    r(Gm, 'Roll camber', cur.rollCamber, 2, '°/°', "Outside wheel's camber change to the ground per degree of body roll: 1 = leans fully with the body, 0 = stays upright (like a solid axle), < 0 = leans into the turn. 1 + camber gain · half track"),
    r(Gm, 'KPI in roll', cur.rollKpi, 2, '°/°', "Outside wheel's KPI change to the ground per degree of body roll: −1 + KPI gain · half track (the body tips the axis outward by the roll)"),
    r(Gm, 'Caster in roll', cur.rollCaster, 3, '°/°', "Outside wheel's caster change per degree of body roll: caster gain · half track"),
    r(Gm, 'Compliance steer, side force', cur.compliance?.lateral.toe, 3, '°/kN', 'Toe change (+ = in) per kN of side force pushing the tire inboard (an outside wheel in a turn), from the arm pivot bushings flexing (Inspector → Chassis → Arm bushings)'),
    r(Gm, 'Compliance camber, side force', cur.compliance?.lateral.camber, 3, '°/kN', 'Camber change (+ = top outboard) per kN of side force pushing the tire inboard'),
    r(Gm, 'Compliance steer, braking', cur.compliance?.braking.toe, 3, '°/kN', 'Toe change (+ = in) per kN of braking force at the contact patch'),
    r(Gm, 'Track change (scrub)', cur.trackChange, 3, 'mm/mm', 'half-track change per mm of bump (+ = contact moves outboard): tire scrub over bumps'),
    r(Gm, 'Scrub radius', c.scrubRadius, 1, 'mm', '+ = axis inboard at ground'),
    r(Gm, 'Mechanical trail', c.mechanicalTrail, 1, 'mm', '+ = axis ahead at ground'),
    r(Gm, 'Kingpin offset @ WC', c.kingpinOffsetAtWheelCenter, 1, 'mm'),
    r(Gm, 'Caster offset @ WC', c.casterOffsetAtWheelCenter, 1, 'mm'),
    r(Gm, 'FVSA', c.fvsa, 0, 'mm', '+ = IC inboard'),
    r(Gm, 'Roll center height', c.rollCenterHeight, 1, 'mm', 'mirrored corner'),
    r(Gm, 'Roll center migration', cur.rcMigration, 2, 'mm/mm', 'roll-center height change per mm of heave (bump)'),
    r(Gm, 'SVSA', c.svsa, 0, 'mm', '+ = IC behind'),
    r(Gm, 'Anti angle (contact)', deg(c.antiAngleContact), 2, '°'),
    r(Gm, 'Half track', c.halfTrack, 1, 'mm'),
    r(Gm, 'Wheel center Y', c.wheelCenter.y, 1, 'mm'),
    r(Gm, 'Ground Y', cur.loaded ? cur.loaded.groundY : c.groundY, 1, 'mm', 'ride height = −ground Y'),
  ];
  const sp = cur.spring;
  if (sp) {
    const S = 'Spring & ride';
    rows.push(
      r(S, 'Wheel travel', cur.travel, 1, 'mm', 'wheel center, + = bump'),
      r(S, 'Sprung load on spring', sp.sprungLoad, 0, 'N', '(corner load − unsprung weight) × load factor'),
      r(S, 'Spring force', sp.force, 0, 'N'),
      r(S, 'Spring length', sp.length, 1, 'mm'),
      r(S, 'Spring compression', sp.compression, 1, 'mm', 'from free length'),
      r(S, 'Motion ratio', sp.motionRatio, 3, '', 'spring mm per wheel mm'),
      r(S, 'Wheel rate', sp.wheelRate, 1, 'N/mm'),
      r(S, 'Tire rate', sp.tireRate, 0, 'N/mm'),
      r(S, 'Ride rate', sp.rideRate, 1, 'N/mm', 'wheel rate in series with tire'),
      r(S, 'Ride frequency', sp.frequency, 2, 'Hz', 'sprung corner'),
      r(S, 'Damping ratio, bump', dampingRatio(damper.bump, sp.motionRatio, sp.rideRate, sp.sprungLoad / G), 2, '', 'ζ = damper rate · MR² / (2·√(ride rate · sprung mass)). 0.25–0.4 ride, 0.6–0.7 handling'),
      r(S, 'Damping ratio, rebound', dampingRatio(damper.rebound, sp.motionRatio, sp.rideRate, sp.sprungLoad / G), 2, ''),
    );
  }
  const l = cur.loaded;
  if (l) {
    const T = 'Tire & contact patch';
    rows.push(
      r(T, 'Tire load', l.force.force, 0, 'N'),
      r(T, 'Deflection', l.deflection, 2, 'mm', 'ground rise vs. rigid tire'),
      r(T, 'Patch area', l.patch.area / 100, 1, 'cm²'),
      r(T, 'Patch length', l.patch.length, 1, 'mm'),
      r(T, 'Patch width', l.patch.sMax - l.patch.sMin, 1, 'mm', 'along the axle'),
      r(T, 'Inclination', deg(l.patch.inclination), 3, '°', 'wheel vs. ground normal'),
      r(T, 'Pressure (gauge)', l.force.pressureGauge, 2, 'kPa', 'operating'),
      r(T, 'Air volume change', l.force.volumeChangeRatio !== undefined ? l.force.volumeChangeRatio * 100 : undefined, 3, '%'),
      r(T, 'Effective scrub', l.effectiveScrubRadius, 1, 'mm', 'to patch centroid'),
      r(T, 'Effective trail', l.effectiveTrail, 1, 'mm', 'to patch centroid'),
    );
  }
  return rows;
}

/** The whole car's results (Vehicle results), the corners' loads, travels, inclinations and toes included. */
/** `rollover`: the rollover stats (Vehicle results, worked out in a worker: 'pending' meanwhile); absent: no rollover rows. */
export function vehicleResultRows(model: VehicleModel | null, rollover?: RolloverStats | null | 'pending'): ResultRow[] {
  const res = model?.result;
  if (!model || !res) return [];
  const t = model.transfer;
  const rows: ResultRow[] = [];
  if (res.grip) rows.push(r('Grip', 'Most grip use (any tire)', res.grip.maxUtilization * 100, 0, '%', 'The worst tire’s share of its grip in this state'));
  if (res.aero) {
    const A = 'Aero', lift = res.aero.liftF + res.aero.liftR, has = Math.abs(lift) > 1e-6;
    rows.push(
      r(A, 'Drag', res.aero.drag, 0, 'N', 'On the body, rearward; the driven tires push against it'),
      r(A, 'Downforce, front axle', -res.aero.liftF, 0, 'N', '− = lift'),
      r(A, 'Downforce, rear axle', -res.aero.liftR, 0, 'N'),
      { ...r(A, 'Aero balance (front share)', has ? (res.aero.liftF / lift) * 100 : undefined, 1, '%', 'Moves with ride height (maps), roll (roll sensitivity) and, over time, sideslip'), ...(has ? {} : { text: '—' }) },
      { ...r(A, 'Center of pressure, behind the front axle', has ? (res.aero.liftR / lift) * model.wheelbase : undefined, 0, 'mm', 'Where the downforce acts along the car'), ...(has ? {} : { text: '—' }) },
    );
  }
  const B = 'Body';
  rows.push(
    r(B, 'Roll', deg(res.pose.roll), 3, '°', '+ = top leans toward −X (right)'),
    r(B, 'Pitch', deg(res.pose.pitch), 3, '°', '+ = nose down'),
    r(B, 'Heave', res.pose.heave, 2, 'mm', 'chassis rise from design'),
    r(B, 'Ride height, front axle', model.rideHeight.front, 1, 'mm', 'frame bottom to ground'),
    r(B, 'Ride height, rear axle', model.rideHeight.rear, 1, 'mm'),
    r(B, 'Roll center height, front', model.rollCenters.front?.h, 1, 'mm', 'from the actual left/right corners'),
    r(B, 'Roll center height, rear', model.rollCenters.rear?.h, 1, 'mm'),
    r(B, 'Roll center lateral, front', model.rollCenters.front?.x, 1, 'mm', '+ = left of centerline'),
    r(B, 'Rollover threshold (rigid)', model.rolloverG, 2, 'g', 'half track ÷ CG height'),
    ...(rollover === 'pending' ? [{ ...r(B, 'Inside wheels lift at', undefined, 2, 'g', 'Working out…'), text: '…' }] : rollover ? [
      { ...r(B, 'Inside wheels lift at', rollover.liftOffG ?? undefined, 2, 'g', 'Lateral g at which the inside wheels unload, the whole car solved (body roll, tire squash, the CG moving out): below the rigid threshold'), ...(rollover.liftOffG === null ? { text: 'not found (no lift before the solve gives up)' } : {}) },
      r(B, 'Tipping angle', rollover.tippingAngle, 1, '°', 'Roll of the whole car (about the outside contact patches) at which its CG is over them: atan(half track ÷ CG height)'),
      r(B, 'Trip speed', rollover.tripSpeed * 3.6, 1, 'km/h', 'Least sideways speed that tips it over when its tires are stopped at once (a curb, soft ground): the energy to lift the CG over the outside contact patches, with the roll inertia about them'),
    ] : []),
    ...model.ackermannLines.map((a) => {
      const row = r(B, `Ackermann lines cross, ${a.axle}`, a.cross && a.lines.length >= 2 ? (a.axle === 'front' ? a.cross.z - a.target.z : a.target.z - a.cross.z) : undefined, 0, 'mm',
        `Top view: lines from each steered wheel's steering axis through its steering arm's outer joint (View → Ackermann lines). Distance of their crossing past (+) or short of (−) the ${a.target.label.toLowerCase()}, where classic 100 % Ackermann puts it. Parallel = parallel steer. Drag the crossing or a line's handle in the Vehicle view to move the outer tie-rod joints. A rule for near straight ahead: Ackermann % in the Corner view shows what the linkage really does.`);
      return a.lines.length < 2 ? { ...row, text: 'one steered wheel' } : !a.cross ? { ...row, text: 'parallel' } : row;
    }),
  );
  const L = 'Lateral load transfer', tot = t.front.total + t.rear.total;
  rows.push(
    r(L, 'Front total', t.front.total, 0, 'N', '+ = outside tire gains load'),
    r(L, 'Front, through links (roll center)', t.front.geometric, 0, 'N'),
    r(L, 'Front, through springs (body roll)', t.front.elastic, 0, 'N'),
    r(L, 'Rear total', t.rear.total, 0, 'N'),
    r(L, 'Rear, through links (roll center)', t.rear.geometric, 0, 'N'),
    r(L, 'Rear, through springs (body roll)', t.rear.elastic, 0, 'N'),
    { ...r(L, 'Front share (LLTD)', Math.abs(tot) < 1 ? undefined : 100 * t.lltdFront, 1, '%', 'Front axle share of the total lateral load transfer'), ...(Math.abs(tot) < 1 ? { text: '—' } : {}) },
    r(L, 'Roll stiffness, front', model.rollStiffness.front, 0, 'N·m/°', 'Load moved through the springs (springs, anti-roll bar, heave spring) × track ÷ body roll, at this cornering. — without cornering'),
    r(L, 'Roll stiffness, rear', model.rollStiffness.rear, 0, 'N·m/°'),
    r(L, 'Roll stiffness, front share', (100 * model.rollStiffness.front) / (model.rollStiffness.front + model.rollStiffness.rear), 1, '%'),
    r(L, 'Roll gradient', model.rollGradient, 2, '°/g', 'Body roll per g of cornering (this state)'),
  );
  const K = 'Braking & acceleration';
  rows.push(r(K, 'Load moved onto the front axle', model.frontLoadGain, 0, 'N', 'Front axle load minus its static load (negative = moved to the rear)'));
  if (res.hitch) rows.push(
    r(K, 'Hitch: tongue load (down on the car)', -res.hitch.force.y, 0, 'N', 'Static tongue weight plus the load shift from braking / accelerating'),
    r(K, 'Hitch: trailer push (+) / pull (−)', res.hitch.force.z, 0, 'N', 'Along the car: + pushes it forward (braking without trailer brakes)'),
    r(K, 'Hitch: side force on the car', res.hitch.force.x, 0, 'N', '+ = toward the left; cornering, the trailer pulls the hitch outward'),
  );
  if (res.brakePedal) rows.push({ ...r(K, 'Pedal force this braking needs', res.brakePedal.needed, 0, 'N', 'Brake hydraulics: more than the most = the brakes are too weak for this braking'), of: res.brakePedal.max });
  rows.push(
    r(K, 'Anti-dive, braking (front)', model.antiDive, 1, '%', 'tan θ · (wheelbase / CG height) · front brake share; θ from the side-view IC (contact patch for outboard brakes, wheel center for inboard)'),
    r(K, 'Anti-lift, braking (rear)', model.antiLift, 1, '%'),
    r(K, 'Anti-squat, accelerating (rear)', model.antiSquat, 1, '%', 'Powered rear corners: θ from the wheel center (chassis diff) or contact patch (hub motor), × rear drive share'),
    r(K, 'Anti-lift, accelerating (front)', model.antiLiftAccel, 1, '%', 'Powered front corners'),
  );
  for (const id of CORNER_IDS) {
    const c = res.corners[id], v = model.corners[id], C = 'Corners';
    rows.push(
      r(C, `${id} load`, c.tireLoad, 0, 'N'),
      r(C, `${id} load change from static`, c.tireLoad - model.staticLoads[id], 0, 'N'),
      r(C, `${id} longitudinal force`, c.longitudinalForce, 0, 'N', '− braking, + drive'),
      r(C, `${id} travel`, c.travel, 1, 'mm'),
      r(C, `${id} inclination`, deg(c.inclination), 2, '°', 'wheel vs. ground, + = top toward that corner’s outboard side'),
      r(C, `${id} toe`, v ? deg(v.chars.toe) : undefined, 2, '°', '+ = toe-in'),
    );
  }
  return rows;
}
