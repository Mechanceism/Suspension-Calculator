/**
 * What counts as a pass. Every check has a severity (Pass = ignored, Warning = a "passing fail": reported,
 * the test still passes, Fail) and, where it makes sense, a threshold. Profiles set them all at once.
 * The optimizer treats Fail checks as hard requirements and Warning checks as soft penalties.
 */
import { CORNER_IDS, isFront, type CornerId, type VehicleResult } from '../vehicle/vehicle';

export type Severity = 'pass' | 'warn' | 'fail';

export type CheckId =
  | 'nearLimit' | 'understeer' | 'oversteer' | 'wheelspin' | 'absActive' | 'lockup' | 'speedNotReached'
  | 'bumpStop' | 'bottoming' | 'wheelLift' | 'rollover' | 'noSolution' | 'beyondGrip';

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
  beyondGrip: { label: 'Beyond the tires', hint: 'The state asks for more total force than all four tires can give: no suspension can pass it. Lower the speed, enlarge the radius, or improve the tires.', fixed: true },
};
export const CHECK_IDS = Object.keys(CHECK_META) as CheckId[];

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
};

export type BuiltinProfile = 'default' | 'street' | 'track' | 'drift' | 'offroad';
export const PROFILES: Record<BuiltinProfile, { label: string; checks: CheckProfile }> = {
  default: { label: 'Default', checks: base },
  street: { label: 'Street (strict)', checks: { ...base, absActive: { severity: 'fail', threshold: 0 }, bumpStop: { severity: 'fail' } } },
  track: { label: 'Track', checks: { ...base, nearLimit: { severity: 'pass', threshold: 0 }, wheelLift: { severity: 'warn' } } },
  drift: { label: 'Drift', checks: { ...base, oversteer: { severity: 'warn', threshold: 30, threshold2: 10 }, wheelspin: { severity: 'warn', threshold: 30 }, nearLimit: { severity: 'pass', threshold: 0 } } },
  offroad: { label: 'Off-road', checks: { ...base, wheelLift: { severity: 'pass' }, bumpStop: { severity: 'pass' } } },
};
export const cloneProfile = (p: CheckProfile): CheckProfile => JSON.parse(JSON.stringify(p)) as CheckProfile;

export interface Finding {
  check: CheckId;
  severity: Severity;
  text: string;
  corners?: CornerId[];
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
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const sevOf = (p: CheckProfile, id: CheckId) => p[id].severity;

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
  if (!r || !r.converged) { add('noSolution', "The car can't settle in this state"); return out; }
  const g = r.grip;
  if (r.unmet.accel) add('speedNotReached', 'No powered wheels: the car cannot accelerate (or hold speed uphill)');
  if (r.unmet.brake) add('speedNotReached', 'No braked wheels: the car cannot slow down');
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
      const short = abs.reduce((a, id) => a + g.corners[id].shortfall, 0);
      if (f.brakeForce > 0 && short / f.brakeForce > (profile.absActive.threshold ?? 5) / 100) {
        add('speedNotReached', `ABS can only give ${pct(1 - short / f.brakeForce)} of the braking asked: the car can't slow down in the distance`, abs);
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
    if (w('wheelLift')) out.push(w('wheelLift') * Math.max(0, 25 - c.tireLoad) / 2.5);
  }
  return out;
}

export const worstSeverity = (fs: Finding[]): Severity => (fs.some((x) => x.severity === 'fail') ? 'fail' : fs.some((x) => x.severity === 'warn') ? 'warn' : 'pass');
