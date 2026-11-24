/**
 * The brake ladder (round 3, R5; docs/MATH.md § Brakes, the ladder): size each axle's brakes to the tests.
 * From the hardest stop of the last test runs (each axle's demand ÷ its faded capacity), pick the smallest
 * step on the ladder that keeps the reserve: more pistons first, larger rotors last, rotors that fit the
 * wheel; stepping down when there is a lot to spare. A drum axle stays on drums unless the user allowed
 * discs for it; when its drums run out it asks. With the brake bias taken from the hydraulics the bias
 * holds: a balance bar is re-set to it, a tandem master cylinder picks the front / rear pair nearest to it.
 */
import { brakesOf, type BrakesModel } from './optimizer';
import type { AppState, BrakeSettings, Field } from './store';
import {
  brakeLadder, pickStep, pedalTravel, wheelTorque, area, brakeCapacity,
  type BrakeAxle, type BrakeStep, type BrakeSystem,
} from '../core/vehicle/brakes';

type Axle = 'front' | 'rear';
const SIDE: Record<Axle, 'F' | 'R'> = { front: 'F', rear: 'R' };

export interface BrakeSizing {
  /** Brake settings to apply (empty: nothing to change). */
  patch: Partial<BrakeSettings>;
  /** What changed, per axle, in words. */
  changes: string[];
  /** Axles whose brakes can't be made strong enough (and why). */
  blocked: string[];
  /** Drum axles whose drums ran out: the user may allow discs. */
  askDisc: Axle[];
}

const fieldOf = (v: number): Field => ({ text: String(Number(v.toFixed(3))), value: v });

/** The brakes' hardest use over test runs (each axle's demand ÷ faded capacity; 1 = the most pedal force). */
export function hardestUse(runs: { brakeUse?: { front: number; rear: number } }[]): { front: number; rear: number } | null {
  const u = runs.map((r) => r.brakeUse).filter((x): x is { front: number; rear: number } => !!x);
  if (!u.length) return null;
  return { front: Math.max(...u.map((x) => x.front)), rear: Math.max(...u.map((x) => x.rear)) };
}

/** Front share of the hydraulics' braking force (the bias they make) for a system. */
const biasOf = (sys: BrakeSystem, m: BrakesModel) => brakeCapacity(sys, m.tireRadius).bias;

/** The balance bar's front share that makes the hydraulic bias `target`. */
function balanceFor(sys: BrakeSystem, m: BrakesModel, target: number): number {
  const k = (a: BrakeAxle, r: number) => (wheelTorque(a, 1) / area(a.mcBore)) / Math.max(r, 1e-9);
  const kf = k(sys.front, m.tireRadius.front), kr = k(sys.rear, m.tireRadius.rear);
  return Math.min(0.95, Math.max(0.05, (target * kr) / (kf * (1 - target) + target * kr)));
}

/** Size both axles to the hardest use (use ≥ 0 per axle; 0 = no braking asked of it). */
export function sizeBrakes(s: AppState, use: { front: number; rear: number }): BrakeSizing | null {
  const m = brakesOf(s);
  if (!m) return null;
  const b = s.brakes;
  const reserve = Math.max(0, b.ladderReserve.value) / 100;
  const out: BrakeSizing = { patch: {}, changes: [], blocked: [], askDisc: [] };
  const sys: BrakeSystem = { ...m.system, front: { ...m.system.front }, rear: { ...m.system.rear } };
  // The hardest stop's pedal share once an axle is resized (its use falls by the step's gain).
  const pedalOk = (axle: Axle, cand: BrakeAxle) => {
    if (!m.detail) return true;
    const t0 = wheelTorque(sys[axle], 1);
    const gain = t0 > 0 ? wheelTorque(cand, 1) / t0 : 1;
    const other = axle === 'front' ? use.rear : use.front;
    const share = Math.min(1, Math.max(use[axle] / Math.max(gain, 1e-9), other));
    const t = pedalTravel({ ...sys, [axle]: cand }, m.detail, share);
    return t.strokeUse <= 1 && t.pedal <= m.detail.maxPedalTravel;
  };
  const picks: Partial<Record<Axle, { step: BrakeStep; ladder: BrakeStep[]; need: number }>> = {};
  for (const axle of ['front', 'rear'] as const) {
    const u = use[axle];
    if (!(u > 0) || !Number.isFinite(u)) continue;
    const a = sys[axle];
    const need = u * (1 + reserve);
    const room = m.room[axle];
    let ladder = brakeLadder(a.kind ?? 'disc', room);
    let pick = pickStep(a, ladder, need, (c) => pedalOk(axle, c));
    if (pick.keep) continue;
    if (!pick.step && a.kind === 'drum') {
      const allowed = axle === 'front' ? b.allowDiscF : b.allowDiscR;
      if (allowed) {
        ladder = brakeLadder('disc', room);
        pick = pickStep(a, ladder, need, (c) => pedalOk(axle, c));
      } else {
        out.askDisc.push(axle);
        out.blocked.push(`${axle === 'front' ? 'Front' : 'Rear'} drums are at their largest that fit and still ${pct(pick.short)} short: allow discs on this axle to go further.`);
        continue;
      }
    }
    if (!pick.step) {
      out.blocked.push(`${axle === 'front' ? 'Front' : 'Rear'}: the largest brakes that fit the wheel${m.detail ? ' (with the pedal travel allowed)' : ''} are still ${pct(pick.short)} short. A booster, more pedal ratio or a smaller master cylinder (Brake system) can make up the rest.`);
      continue;
    }
    picks[axle] = { step: pick.step, ladder, need };
  }
  // Hold the bias when it comes from the hydraulics.
  const target = b.useBias ? m.capacity.bias : NaN;
  const apply = (axle: Axle, st: BrakeStep) => { sys[axle] = { ...sys[axle], ...st.patch }; };
  if (Number.isFinite(target) && !b.dualMc && picks.front && picks.rear) {
    // Tandem master cylinder: the pair nearest the bias among the first few steps that are enough.
    const firstFew = (axle: Axle) => {
      const p = picks[axle]!;
      const i = p.ladder.indexOf(p.step);
      return p.ladder.slice(i, i + 12).filter((st) => wheelTorque({ ...sys[axle], ...st.patch }, 1) >= wheelTorque(sys[axle], 1) * p.need - 1e-9);
    };
    let best: { f: BrakeStep; r: BrakeStep; cost: number } | null = null;
    const fs = firstFew('front'), rs = firstFew('rear');
    fs.forEach((f, i) => rs.forEach((r, j) => {
      const bias = biasOf({ ...sys, front: { ...sys.front, ...f.patch }, rear: { ...sys.rear, ...r.patch } }, m);
      const cost = Math.abs(bias - target) * 100 + 0.05 * (i + j);
      if (!best || cost < best.cost) best = { f, r, cost };
    }));
    if (best) { picks.front!.step = (best as { f: BrakeStep }).f; picks.rear!.step = (best as { r: BrakeStep }).r; }
  }
  for (const axle of ['front', 'rear'] as const) if (picks[axle]) apply(axle, picks[axle]!.step);
  let balance = sys.balanceFront;
  if (Number.isFinite(target) && b.dualMc) balance = balanceFor(sys, m, target);

  // Changes, in the settings' terms.
  const patch: Partial<BrakeSettings> = {};
  for (const axle of ['front', 'rear'] as const) {
    const p = picks[axle];
    if (!p) continue;
    const before = m.system[axle], after = sys[axle], X = SIDE[axle];
    const same = before.kind === after.kind && (after.kind === 'drum'
      ? Math.abs((before.drumRadius ?? 0) - (after.drumRadius ?? 0)) < 1e-6 && Math.abs((before.wheelCylinder ?? 0) - (after.wheelCylinder ?? 0)) < 1e-6
      : Math.abs(before.rotorRadius - after.rotorRadius) < 1e-6 && before.pistonsPerSide === after.pistonsPerSide && Math.abs(before.pistonDiameter - after.pistonDiameter) < 1e-6);
    if (same) continue;
    if (after.kind === 'drum') {
      Object.assign(patch, { [`drumR${X}`]: fieldOf(after.drumRadius!), [`wcBore${X}`]: fieldOf(after.wheelCylinder!) });
    } else {
      Object.assign(patch, { [`rotorR${X}`]: fieldOf(after.rotorRadius), [`pistons${X}`]: fieldOf(after.pistonsPerSide), [`pistonDia${X}`]: fieldOf(after.pistonDiameter) });
      if (before.kind === 'drum') Object.assign(patch, { [`drum${X}`]: false });
    }
    const gain = wheelTorque(after, 1) / Math.max(wheelTorque(before, 1), 1e-9);
    out.changes.push(`${axle === 'front' ? 'Front' : 'Rear'}: ${before.kind === 'drum' && after.kind !== 'drum' ? 'drums → discs, ' : ''}${p.step.label} (${gain >= 1 ? '+' : ''}${pct(gain - 1 + 1, true)} torque; the hardest stop used ${(100 * use[axle]).toFixed(0)} % of the brakes, now ${(100 * use[axle] / gain).toFixed(0)} %)`);
  }
  if (Math.abs(balance - m.system.balanceFront) > 1e-4) {
    patch.balanceFront = fieldOf(balance * 100);
    out.changes.push(`Balance bar ${(m.system.balanceFront * 100).toFixed(1)} % → ${(balance * 100).toFixed(1)} % front, keeping the hydraulic bias at ${(target * 100).toFixed(1)} %`);
  } else if (Number.isFinite(target) && out.changes.length) {
    const nb = biasOf(sys, m);
    if (Math.abs(nb - target) > 0.005) out.changes.push(`Hydraulic bias ${(target * 100).toFixed(1)} % → ${(nb * 100).toFixed(1)} % (the nearest pair of sizes)`);
  }
  out.patch = patch;
  return out;
}

/** "18 %" short, or as a gain "+12 %". */
function pct(x: number | undefined, asGain = false): string {
  if (x === undefined || !Number.isFinite(x)) return '—';
  return asGain ? `${((x - 1) * 100).toFixed(0)} %` : `${((x - 1) * 100).toFixed(0)} %`;
}
