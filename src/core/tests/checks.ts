/**
 * What counts as a pass. Every check has a severity (Pass = ignored, Warning = a "passing fail": reported,
 * the test still passes, Fail) and, where it makes sense, a threshold. Profiles set them all at once.
 * The optimizer treats Fail checks as hard requirements and Warning checks as soft penalties.
 */
import { CORNER_IDS, isFront, type CornerId, type VehicleResult } from '../vehicle/vehicle';
import type { SteerNeed } from './steer';

export type Severity = 'pass' | 'warn' | 'fail';

export type CheckId =
  | 'nearLimit' | 'understeer' | 'oversteer' | 'wheelspin' | 'absActive' | 'lockup' | 'speedNotReached'
  | 'bumpStop' | 'bottoming' | 'wheelLift' | 'rollover' | 'noSolution' | 'beyondGrip' | 'steerLimit' | 'pathError' | 'spin' | 'offCourse' | 'airborne' | 'blowout' | 'impact' | 'tireOverload' | 'brakeLimit' | 'brakeFade' | 'longPedal' | 'mcStroke' | 'kickback' | 'shimmy' | 'trailerSway' | 'hitchLoad' | 'lightTongue' | 'gripTarget';

export interface CheckSetting {
  severity: Severity;
  /** Main threshold (meaning per check, %). */
  threshold?: number;
  /** Second threshold (oversteer: front reserve needed to catch the slide, %). */
  threshold2?: number;
}
export type CheckProfile = Record<CheckId, CheckSetting>;

export interface CheckMeta {
  label: string;
  hint: string;
  threshold?: { label: string; unit: string };
  threshold2?: { label: string; unit: string };
  /** Severity can't be changed. */
  fixed?: boolean;
}

export const CHECK_META: Record<CheckId, CheckMeta> = {
  nearLimit: { label: 'Near the grip limit', hint: 'A tire uses more than (100% − reserve) of its grip.', threshold: { label: 'reserve', unit: '%' } },
  understeer: { label: 'Understeer', hint: 'The front axle is out of grip: the car runs wide.', threshold: { label: 'allowed over', unit: '%' } },
  oversteer: { label: 'Oversteer / drift', hint: 'The rear axle is out of grip. Allowed up to the % over, as long as the front keeps the reserve to catch it.', threshold: { label: 'allowed over', unit: '%' }, threshold2: { label: 'front reserve', unit: '%' } },
  wheelspin: { label: 'Wheelspin', hint: 'A driven tire is pushed past its grip.', threshold: { label: 'allowed over', unit: '%' } },
  absActive: { label: 'ABS active', hint: 'Braking at the ABS limit: the car stops a little longer than asked. Above the allowed shortfall it also counts as speed not reached.', threshold: { label: 'allowed shortfall', unit: '%' } },
  lockup: { label: 'Lock-up', hint: 'A tire without ABS locks and slides (no steering grip).' },
  speedNotReached: { label: 'Speed not reached', hint: "The car can't accelerate or brake as asked: no powered / braked wheels, or not enough grip." },
  bumpStop: { label: 'Bump-stop contact', hint: 'A suspension is on its bump stop.' },
  bottoming: { label: 'Bottoming / topping out', hint: 'A suspension reaches its travel limit.' },
  wheelLift: { label: 'Wheel lift', hint: 'A tire unloads to (almost) nothing.' },
  rollover: { label: 'Rollover', hint: 'Cornering g beyond the rigid rollover threshold (half track ÷ CG height).', fixed: true },
  noSolution: { label: 'No solution', hint: "The car can't settle in this state.", fixed: true },
  brakeLimit: { label: 'Brakes too weak', hint: 'With the brake hydraulics modeled: the braking asked needs more pedal force than the driver applies (line pressure, pistons, pads, rotors). Bigger pistons / rotors, a smaller master cylinder, a booster or more pedal ratio help.' },
  hitchLoad: { label: 'Hitch overloaded', hint: 'Towing: the load on the hitch ball (tongue weight plus what braking, accelerating and bumps add) is above the hitch\'s rated tongue load (Towing → Hitch rating).' },
  lightTongue: { label: 'Light tongue', hint: 'Towing: the trailer\'s static tongue weight is below this share of its weight. Below about 10 % a trailer tends to sway.', threshold: { label: 'least tongue share', unit: '%' } },
  trailerSway: { label: 'Trailer sway', hint: 'Towing, driving over time with the driver steering: the trailer swings side to side about the line it would follow without tire slip by more than this (or jackknifes). More tongue weight, a lighter or shorter trailer (less yaw inertia), a longer hitch-to-axle distance or a lower speed help.', threshold: { label: 'allowed', unit: '°' } },
  longPedal: { label: 'Long pedal', hint: 'Detailed brake hydraulics: in this stop the pedal travels further than the most you set (pad clearance, the circuit swelling under pressure, the master-cylinder bore). A larger master cylinder, less piston area, stiffer hoses or less pedal ratio shorten it (and raise the pedal force).' },
  kickback: { label: 'Kickback', hint: 'Over time with the steering modeled: a jolt at the steering wheel above this (N·m above its 0.3 s running mean) from the front tires\u2019 forces: a bump\u2019s push through the kingpin offset at the wheel center, braking through the scrub radius, load changes through the axis\u2019 tilt, side force through the trail. A smaller scrub radius / kingpin offset or a slower steering ratio reduces it.', threshold: { label: 'allowed jolt', unit: 'N·m' } },
  shimmy: { label: 'Shimmy / death wobble', hint: 'With the shimmy check on (Vehicle → Inputs → Shimmy): the front wheels, knocked by a one-sided bump at the test’s fastest speeds, keep oscillating about their steering axes instead of settling, with worn parts (free play, softer steering, weaker damper, wheel imbalance) or even new ones. More trail, a stiffer steering system, a steering damper, less free play help.' },
  mcStroke: { label: 'Master cylinder runs out', hint: 'Detailed brake hydraulics: the master cylinder would need more than its stroke to make this stop (the pedal hits the floor). A larger bore or a longer stroke, less piston area or stiffer hoses help.' },
  brakeFade: { label: 'Brake fade', hint: 'With brake fade modeled: the rotors are hot enough that the pads have lost more than this share of their grip. If the faded brakes can no longer make the braking asked, it counts as Brakes too weak. Heavier rotors, more cooling, or pads that fade hotter help.', threshold: { label: 'allowed pad grip loss', unit: '%' } },
  pathError: { label: 'Off the line', hint: 'Driving over time with the driver steering: the car leaves a lane this wide (as a share of its own width, track + tire width) centered on the path — runs wide or cuts in. 200 %: half its width either side (the road is drawn at 150 %).', threshold: { label: 'lane', unit: '% of car width' } },
  spin: { label: 'Spin / slide', hint: 'Driving over time with the driver steering: the car\'s sideslip angle (how far it points away from where it travels) is beyond this.', threshold: { label: 'allowed', unit: '°' } },
  steerLimit: { label: 'Steering lock', hint: 'The turn is tighter than the steering allows: its road-wheel angle (atan(wheelbase ÷ radius), plus the front − rear tire slip angle at speed) needs more rack travel than the rack limit, or no wheel steers.' },
  gripTarget: { label: 'Driver push lowered', hint: 'Speeds as maximums: every way of taking the segment with the driver pushing to the test’s share of the tires’ grip (brake before, brake in, coast in, hold the speed, speed up in) failed over time, so the driver pushes less there (slower, a reserve for what the plan doesn’t see). The finding says to what; it also says when slowing down didn’t cure it.' },
  beyondGrip: { label: 'Beyond the tires', hint: 'The state asks for more total force than all four tires can give: no suspension can pass it. Lower the speed, enlarge the radius, or improve the tires.', fixed: true },
  airborne: { label: 'Wheels on the ground', hint: 'At least this many wheels on the ground (round 5): fewer for more than a moment — off a crest, a jump — fails. It also sets how the driver takes a crest: needing 3 or more, the speed plan slows so the tires keep some load over it; fewer (or Pass: e.g. Off-road) and the car may take a jump flat out.', threshold: { label: 'at least', unit: 'wheels' } },
  blowout: { label: 'Tire pressure spike', hint: 'Over time (round 5): a tire squashed on a landing or a big hit, its air pressure rises; with its sidewall maximum given (Tire → Max pressure) it blows out past it (a Warning within 10 % of it); otherwise the thresholds are shares over its cold set pressure — a Warning above the second, a blowout above the first. Gas-model tires only.', threshold: { label: 'blows out at', unit: '% over' }, threshold2: { label: 'warn at', unit: '% over' } },
  impact: { label: 'Landing / impact (body)', hint: 'Over time (round 5): the body\'s largest vertical acceleration (a landing, a big hit), in g — a Warning above the second threshold, this rule\'s severity above the first.', threshold: { label: 'limit', unit: 'g' }, threshold2: { label: 'warn at', unit: 'g' } },
  tireOverload: { label: 'Tire overload', hint: 'Over time (round 5): a tire\'s largest load as a multiple of its rated load (Tire → Load rating; when not given, estimated as its load at 15 % of its section height squashed at the set pressure) — a Warning above the second threshold, this rule\'s severity above the first.', threshold: { label: 'limit', unit: '× rated' }, threshold2: { label: 'warn at', unit: '× rated' } },
  offCourse: { label: 'Off course / spun', hint: 'Driving over time with the driver steering: the car went more than twice its width off the line (and at least one width past the lane), or turned more than 90° from the path (across it or backwards). The run ends there: the test did not finish.', fixed: true },
};
export const CHECK_IDS = Object.keys(CHECK_META) as CheckId[];

/**
 * The off-the-line lane as a share of the car's width (2 = 200 %). Before round 4 the setting was metres off the
 * line (1 m by default): a value under 30 is read that way (lane % ≈ 100 + 100 · m).
 */
export const laneShare = (threshold: number | undefined) => {
  const t = threshold ?? 200;
  return (t < 30 ? 100 + 100 * t : t) / 100;
};

const base: CheckProfile = {
  nearLimit: { severity: 'warn', threshold: 10 },
  understeer: { severity: 'fail', threshold: 0 },
  oversteer: { severity: 'fail', threshold: 0, threshold2: 10 },
  wheelspin: { severity: 'fail', threshold: 0 },
  absActive: { severity: 'warn', threshold: 5 },
  lockup: { severity: 'fail' },
  speedNotReached: { severity: 'fail' },
  bumpStop: { severity: 'warn' },
  bottoming: { severity: 'fail' },
  wheelLift: { severity: 'warn' },
  rollover: { severity: 'fail' },
  noSolution: { severity: 'fail' },
  beyondGrip: { severity: 'fail' },
  steerLimit: { severity: 'fail' },
  pathError: { severity: 'fail', threshold: 200 },
  brakeLimit: { severity: 'fail' },
  brakeFade: { severity: 'warn', threshold: 10 },
  longPedal: { severity: 'warn' },
  mcStroke: { severity: 'fail' },
  kickback: { severity: 'warn', threshold: 5 },
  shimmy: { severity: 'fail' },
  trailerSway: { severity: 'fail', threshold: 5 },
  hitchLoad: { severity: 'fail' },
  lightTongue: { severity: 'warn', threshold: 10 },
  // A slide is a Warning (round 4, F10): drifting can be fast; a spin-out also runs off the line, which fails.
  spin: { severity: 'warn', threshold: 12 },
  // Off course / spun (round 4, F25): the run ends there, always a Fail.
  offCourse: { severity: 'fail' },
  // Crests and jumps (round 5): a road car keeps at least 3 wheels on the ground (the plan slows for a crest).
  airborne: { severity: 'fail', threshold: 3 },
  // Landings and big hits (round 5): Fail at the first threshold, Warning above the second.
  blowout: { severity: 'fail', threshold: 100, threshold2: 50 },
  impact: { severity: 'fail', threshold: 6, threshold2: 3 },
  tireOverload: { severity: 'fail', threshold: 4, threshold2: 2.5 },
  gripTarget: { severity: 'warn' },
};

export type BuiltinProfile = 'default' | 'street' | 'track' | 'drift' | 'offroad' | 'drag';
export const PROFILES: Record<BuiltinProfile, { label: string; checks: CheckProfile }> = {
  default: { label: 'Default', checks: base },
  street: { label: 'Street (strict)', checks: { ...base, absActive: { severity: 'fail', threshold: 0 }, bumpStop: { severity: 'fail' } } },
  track: { label: 'Track', checks: { ...base, nearLimit: { severity: 'pass', threshold: 0 }, wheelLift: { severity: 'warn' }, airborne: { severity: 'fail', threshold: 2 } } },
  drift: { label: 'Drift', checks: { ...base, oversteer: { severity: 'warn', threshold: 30, threshold2: 10 }, wheelspin: { severity: 'warn', threshold: 30 }, nearLimit: { severity: 'pass', threshold: 0 }, spin: { severity: 'warn', threshold: 45 }, pathError: { severity: 'warn', threshold: 300 }, airborne: { severity: 'fail', threshold: 2 } } },
  offroad: { label: 'Off-road', checks: { ...base, wheelLift: { severity: 'pass' }, bumpStop: { severity: 'pass' }, airborne: { severity: 'pass', threshold: 0 }, impact: { severity: 'fail', threshold: 8, threshold2: 4 }, tireOverload: { severity: 'fail', threshold: 5, threshold2: 3 } } },
  // Drag (round 4): the front lifting off the line is fine; the rear stepping out (sideslip) or leaving the lane is not.
  drag: { label: 'Drag', checks: { ...base, wheelLift: { severity: 'pass' }, airborne: { severity: 'fail', threshold: 2 }, nearLimit: { severity: 'pass', threshold: 0 }, spin: { severity: 'fail', threshold: 6 } } },
};
/** A copy, with any check missing (profiles saved before it existed) taken from the default. */
export const cloneProfile = (p: CheckProfile): CheckProfile => ({ ...(JSON.parse(JSON.stringify(base)) as CheckProfile), ...(JSON.parse(JSON.stringify(p)) as CheckProfile) });

export interface Finding {
  check: CheckId;
  severity: Severity;
  text: string;
  corners?: CornerId[];
  /** Time it first happens in the ride over time, s (absent for steady states). */
  t?: number;
}

export interface StateFacts {
  result: VehicleResult | null;
  /** Requested accelerations, g. */
  lateralG: number;
  /** Rigid rollover threshold, g. */
  rolloverG: number;
  /** Weight pressing on the road, N (m·g·gravity scale). */
  weight: number;
  /** Required braking and drive force totals, N (to judge ABS shortfall). */
  brakeForce: number;
  /** Combined g the state asks of the tires (lateral and along the road, incl. grade / bank). */
  requiredG: number;
  /** Most the four tires can give with the car at rest, g (an upper bound: load transfer only lowers it). */
  availableG: number;
  /** Steering the turn needs (turns only). */
  steer?: SteerNeed | null;
  /** Handling over time (driver steering): distance off the path (m, + = left), sideslip (deg), steering at full lock. */
  handling?: { pathError: number; sideslip: number; atLock: boolean; sway?: number; jackknife?: boolean; articulation?: number; /** The car's width (track + tire width), m. */ carWidth?: number };
  /** Towing: the load on the hitch ball now (N), the hitch's rating (N, 0 = none) and the static tongue share (0–1). */
  hitch?: { load: number; limit: number; share: number };
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const sevOf = (p: CheckProfile, id: CheckId) => (p[id] ?? base[id]).severity;

/** Findings for one solved state (only checks whose severity isn't Pass). */
export function classifyState(f: StateFacts, profile: CheckProfile): Finding[] {
  const out: Finding[] = [];
  const add = (check: CheckId, text: string, corners?: CornerId[]) => {
    const severity = sevOf(profile, check);
    if (severity !== 'pass') out.push({ check, severity, text, corners });
  };
  const r = f.result;
  // Independent of the solve: more than the tires can give at rest can never pass.
  if (f.requiredG > f.availableG * 1.001) add('beyondGrip', `Needs ${f.requiredG.toFixed(2)} g, the tires give at most about ${f.availableG.toFixed(2)} g: no suspension can pass this`);
  const st = f.steer;
  if (st?.none) add('steerLimit', "No steered wheels (or the rack doesn't turn them): the car can't follow the turn");
  else if (st?.over && st.offLine !== undefined) {
    // Over time, steering back to the line (the car ran wide or slid): not the turn being too tight.
    add('steerLimit', `Steering at full lock to get back to the line (${Math.abs(st.offLine).toFixed(2)} m ${st.offLine > 0 ? 'left' : 'right'} of it): it asks ${Math.abs(st.wheelAngle).toFixed(1)}° at the road wheels`
      + `${(st.turnAngle ?? 0) !== 0 ? `, the turn itself ${Math.abs(st.turnAngle!).toFixed(1)}°` : ' on a straight'}; full lock gives ${st.maxAngle.toFixed(1)}°`);
  } else if (st?.over) {
    add('steerLimit', `Too tight for the steering: needs ${Math.abs(st.wheelAngle).toFixed(1)}° at the road wheels${Math.abs(st.slip) > 0.05 ? ` (${st.slip > 0 ? '+' : '−'}${Math.abs(st.slip).toFixed(1)}° of it for the tires' slip)` : ''}`
      + `${Number.isFinite(st.rack) ? ` (rack ${Math.abs(st.rack).toFixed(1)} mm, limit ±${st.limit.toFixed(0)} mm)` : ''}; full lock gives ${st.maxAngle.toFixed(1)}°`);
  }
  const hd = f.handling;
  if (hd) {
    // A lane as a share of the car's width (round 4): the car's center may stray (lane − 1) / 2 of its width.
    const lane = laneShare(profile.pathError?.threshold);
    const width = hd.carWidth && hd.carWidth > 0 ? hd.carWidth : 1.4;
    const allowed = ((lane - 1) / 2) * width;
    if (Math.abs(hd.pathError) > allowed) add('pathError', `${Math.abs(hd.pathError).toFixed(2)} m off the line (${hd.pathError > 0 ? 'left' : 'right'} of the path; allowed ${allowed.toFixed(2)} m: a lane ${Math.round(lane * 100)} % of the car's width)${hd.atLock ? ', steering at full lock' : ''}`);
    if (Math.abs(hd.sideslip) > (profile.spin?.threshold ?? 12)) add('spin', `Sideslip ${Math.abs(hd.sideslip).toFixed(1)}°: the car slides sideways / spins`);
    if (hd.jackknife) add('trailerSway', `The trailer jackknifes (articulation ${Math.abs(hd.articulation ?? 0).toFixed(0)}°)`);
    else if (hd.sway !== undefined && hd.sway > (profile.trailerSway?.threshold ?? 5)) add('trailerSway', `Trailer sway ±${hd.sway.toFixed(1)}°`);
  }
  const hi = f.hitch;
  if (hi && hi.share * 100 < (profile.lightTongue?.threshold ?? 10)) add('lightTongue', `Tongue weight is ${(hi.share * 100).toFixed(0)} % of the trailer: below ${(profile.lightTongue?.threshold ?? 10).toFixed(0)} % a trailer tends to sway`);
  if (hi && hi.limit > 0 && hi.load > hi.limit * (1 + 1e-6)) add('hitchLoad', `Hitch load ${hi.load.toFixed(0)} N is above its rating (${hi.limit.toFixed(0)} N)`);
  if (!r || !r.converged) { add('noSolution', "The car can't settle in this state"); return out; }
  const g = r.grip;
  if (r.unmet.accel) add('speedNotReached', 'No powered wheels: the car cannot accelerate (or hold speed uphill)');
  if (r.unmet.brake) add('speedNotReached', 'No braked wheels: the car cannot slow down');
  if (r.unmet.brakeCapacity && r.brakePedal) add('brakeLimit', `The brakes can't make this braking: it needs ${Number.isFinite(r.brakePedal.needed) ? r.brakePedal.needed.toFixed(0) : '∞'} N of pedal force, the most is ${r.brakePedal.max.toFixed(0)} N`);
  if (Math.abs(f.lateralG) > f.rolloverG) add('rollover', `Cornering ${Math.abs(f.lateralG).toFixed(2)} g is beyond the rollover threshold (${f.rolloverG.toFixed(2)} g)`);
  if (g) {
    const reserve = (profile.nearLimit.threshold ?? 10) / 100;
    const near = CORNER_IDS.filter((id) => g.corners[id].utilization > 1 - reserve && g.corners[id].utilization <= 1);
    if (near.length) add('nearLimit', `${near.join(', ')} above ${pct(1 - reserve)} grip use (max ${pct(Math.max(...near.map((id) => g.corners[id].utilization)))})`, near);
    const uAllow = 1 + (profile.understeer.threshold ?? 0) / 100;
    if (g.axles.front > uAllow) add('understeer', `Front axle at ${pct(g.axles.front)} of its grip: understeer, the car runs wide`, ['FL', 'FR']);
    const oAllow = 1 + (profile.oversteer.threshold ?? 0) / 100;
    const frontReserve = (profile.oversteer.threshold2 ?? 10) / 100;
    if (g.axles.rear > oAllow) add('oversteer', `Rear axle at ${pct(g.axles.rear)} of its grip: oversteer, the rear slides`, ['RL', 'RR']);
    else if (g.axles.rear > 1 && g.axles.front > 1 - frontReserve) add('oversteer', `Rear sliding (${pct(g.axles.rear)}) with too little front grip left to catch it (front at ${pct(g.axles.front)})`, ['RL', 'RR']);
    const wAllow = 1 + (profile.wheelspin.threshold ?? 0) / 100;
    const spin = CORNER_IDS.filter((id) => r.corners[id].driveForce > 0 && r.corners[id].driveForce / Math.max(g.corners[id].capacity, 1e-9) > wAllow);
    if (spin.length) add('wheelspin', `${spin.join(', ')} wheelspin: not enough traction`, spin);
    const abs = CORNER_IDS.filter((id) => g.corners[id].state === 'abs-limit');
    if (abs.length) {
      add('absActive', `${abs.join(', ')} at the ABS limit`, abs);
      // Braking shortfall only: a tire's braking beyond its longitudinal peak (not its cornering share).
      const short = abs.reduce((a, id) => a + Math.max(0, Math.min(-r.corners[id].brakeForce, -r.corners[id].brakeForce - g.corners[id].capX)), 0);
      if (f.brakeForce > 0 && short / f.brakeForce > (profile.absActive.threshold ?? 5) / 100) {
        add('speedNotReached', `ABS can only give ${pct(Math.max(0, 1 - short / f.brakeForce))} of the braking asked: the car can't slow down in the distance`, abs);
      }
    }
    const locked = CORNER_IDS.filter((id) => g.corners[id].state === 'locked');
    if (locked.length) add('lockup', `${locked.join(', ')} lock up (no ABS): sliding, no steering grip`, locked);
    // A single tire sliding on its own (within its axle's limit), e.g. from combined braking + cornering.
    const sliding = CORNER_IDS.filter((id) => g.corners[id].state === 'sliding'
      && !(isFront(id) ? g.axles.front > uAllow : g.axles.rear > oAllow));
    for (const id of sliding) add(isFront(id) ? 'understeer' : 'oversteer', `${id} sliding (${pct(g.corners[id].utilization)})`, [id]);
  }
  const onStop = CORNER_IDS.filter((id) => r.corners[id].onBumpStop);
  if (onStop.length) add('bumpStop', `${onStop.join(', ')} on the bump stop`, onStop);
  const atLimit = CORNER_IDS.filter((id) => r.corners[id].status !== 'ok');
  if (atLimit.length) add('bottoming', `${atLimit.map((id) => `${id} ${r.corners[id].status === 'bump-limit' ? 'bottoms out' : 'tops out'}`).join(', ')}`, atLimit);
  const lifted = CORNER_IDS.filter((id) => r.corners[id].tireLoad < 25);
  if (lifted.length) add('wheelLift', `${lifted.join(', ')} lifts off the ground`, lifted);
  const least = profile.airborne?.threshold ?? 3;
  if (4 - lifted.length < least) add('airborne', `Only ${4 - lifted.length} wheel${4 - lifted.length === 1 ? '' : 's'} on the ground (at least ${least}): ${lifted.join(', ')} in the air`, lifted);
  return out;
}

/**
 * Brake fade at a solved state (rotor temperatures and pad-friction factors per axle; the hydraulics'
 * cold capacity per axle): a warning when the pads have lost more than the allowed share, and Brakes too
 * weak when the faded brakes can't make the braking the state asks (and the cold ones could).
 */
export function fadeFindings(
  r: VehicleResult | null, fade: { temp: { front: number; rear: number }; factor: { front: number; rear: number } },
  limit: { front: number; rear: number; maxPedal: number }, profile: CheckProfile,
): Finding[] {
  const out: Finding[] = [];
  const add = (check: CheckId, text: string) => { const severity = sevOf(profile, check); if (severity !== 'pass') out.push({ check, severity, text }); };
  const loss = 1 - Math.min(fade.factor.front, fade.factor.rear);
  const temps = `rotors ${fade.temp.front.toFixed(0)} °C front, ${fade.temp.rear.toFixed(0)} °C rear`;
  if (loss * 100 > (profile.brakeFade?.threshold ?? 10)) add('brakeFade', `Brakes fading: ${temps}; the pads have lost ${pct(1 - fade.factor.front)} / ${pct(1 - fade.factor.rear)} of their grip`);
  if (r?.converged && !r.unmet.brakeCapacity) {
    const demand = { front: -(r.corners.FL.brakeForce + r.corners.FR.brakeForce), rear: -(r.corners.RL.brakeForce + r.corners.RR.brakeForce) };
    const need = (d: number, c: number) => (d > 1e-9 ? (c > 0 ? (d / c) * limit.maxPedal : Infinity) : 0);
    const needed = Math.max(need(demand.front, limit.front * fade.factor.front), need(demand.rear, limit.rear * fade.factor.rear));
    if (needed > limit.maxPedal * (1 + 1e-6)) add('brakeLimit', `Brake fade: hot (${temps}) the brakes can't make this braking; it needs ${Number.isFinite(needed) ? needed.toFixed(0) : '∞'} N of pedal force, the most is ${limit.maxPedal.toFixed(0)} N`);
  }
  return out;
}

/**
 * Continuous "how far over" amounts for the optimizer (≥ 0; 1 ≈ 1 % over a grip rule), scaled by the
 * rule's severity: Fail = 1, Warning = 0.3, Pass = 0. Failures geometry can't change (no drive /
 * brakes, beyond the tires, rollover) are left out.
 */
export function checkResiduals(r: VehicleResult | null, profile: CheckProfile): number[] {
  if (!r?.converged || !r.grip) return [];
  const g = r.grip;
  const w = (id: CheckId) => (profile[id].severity === 'fail' ? 1 : profile[id].severity === 'warn' ? 0.3 : 0);
  const over = (x: number) => Math.max(0, x) / 0.01;
  const out: number[] = [];
  const reserve = (profile.nearLimit.threshold ?? 10) / 100;
  if (w('nearLimit')) for (const id of CORNER_IDS) out.push(w('nearLimit') * over(g.corners[id].utilization - (1 - reserve)));
  if (w('understeer')) out.push(w('understeer') * over(g.axles.front - (1 + (profile.understeer.threshold ?? 0) / 100)));
  if (w('oversteer')) {
    out.push(w('oversteer') * over(g.axles.rear - (1 + (profile.oversteer.threshold ?? 0) / 100)));
    if (g.axles.rear > 1) out.push(w('oversteer') * over(g.axles.front - (1 - (profile.oversteer.threshold2 ?? 10) / 100)));
  }
  for (const id of CORNER_IDS) {
    const c = r.corners[id];
    const cap = Math.max(g.corners[id].capacity, 1e-9);
    if (w('wheelspin') && c.driveForce > 0) out.push(w('wheelspin') * over(c.driveForce / cap - (1 + (profile.wheelspin.threshold ?? 0) / 100)));
    if (c.brakeForce < 0) {
      const k = g.corners[id].state === 'locked' ? 'lockup' : 'absActive';
      if (w(k)) out.push(w(k) * over(-c.brakeForce / cap - 1));
    }
    if (w('bumpStop') && c.onBumpStop) out.push(w('bumpStop') * 5);
    if (w('bottoming') && c.status !== 'ok') out.push(w('bottoming') * 20);
    // Wheel lift is noted, not fought (round 4): only when the rules make it a Fail.
    if (profile.wheelLift.severity === 'fail') out.push(w('wheelLift') * Math.max(0, 25 - c.tireLoad) / 2.5);
  }
  return out;
}

export const worstSeverity = (fs: Finding[]): Severity => (fs.some((x) => x.severity === 'fail') ? 'fail' : fs.some((x) => x.severity === 'warn') ? 'warn' : 'pass');

/** Detailed hydraulics at a stop: the pedal travel and master-cylinder stroke it takes (brakes.ts § pedalTravel). */
export function pedalFindings(t: { pedal: number; strokeUse: number }, maxPedalTravel: number, profile: CheckProfile): Finding[] {
  const out: Finding[] = [];
  const add = (check: CheckId, text: string) => { const severity = sevOf(profile, check); if (severity !== 'pass') out.push({ check, severity, text }); };
  if (t.strokeUse > 1 + 1e-9) add('mcStroke', `The master cylinder runs out: this stop needs ${(100 * t.strokeUse).toFixed(0)} % of its stroke`);
  else if (maxPedalTravel > 0 && t.pedal > maxPedalTravel * (1 + 1e-9)) add('longPedal', `Long pedal: ${t.pedal.toFixed(0)} mm of pedal travel (most ${maxPedalTravel.toFixed(0)} mm)`);
  return out;
}
