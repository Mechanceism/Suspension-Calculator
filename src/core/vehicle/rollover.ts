/**
 * Rollover (round 5, item 8): how close a car is to tipping, from the car itself.
 *
 *  - Static stability factor (SSF): half track ÷ total CG height — the lateral g a rigid car tips at.
 *  - Lift-off g: the lateral g at which the inside wheels unload, the whole car solved (body roll, tire squash,
 *    the CG moving out): lower than the SSF.
 *  - Tipping angle: the roll (of the whole car, about the outside contact patches) at which the total CG is over
 *    the line through them: atan(half track ÷ CG height).
 *  - Trip speed: the least sideways speed that tips the car over when its tires are stopped at once (a curb, soft
 *    ground). The impact keeps the angular momentum about the outside contact line, m·v·h = I_c·ω; it tips when
 *    ½·I_c·ω² lifts the CG over the line: m·g·(√(h² + (t/2)²) − h). So v = √(2·m·g·Δh·I_c) ÷ (m·h), with
 *    I_c = I_roll + m·(h² + (t/2)²) the roll inertia about that line.
 */
import { solveVehicle, type VehicleInput, type CornerId } from './vehicle';

const G = 9.80665;

export interface RolloverStats {
  /** Half track ÷ CG height (g). */
  ssf: number;
  /** Lateral g at which the inside wheels unload (null: not below 3 g, or the solve failed). */
  liftOffG: number | null;
  /** Roll angle at which the CG is over the outside contact patches, deg. */
  tippingAngle: number;
  /** Least sideways speed that trips it over, m/s. */
  tripSpeed: number;
  /** What it was worked from: total mass (kg), CG height (mm), half track (mm), roll inertia about the CG (kg·m²). */
  basis: { mass: number; cgHeight: number; halfTrack: number; rollInertia: number };
}

/**
 * `input`: the car at rest (vehicleInputOf with no accelerations); `rollInertia`: the sprung body's about its CG
 * (kg·m²) — the unsprung masses are added at their wheel centers.
 */
export function rolloverStats(input: VehicleInput, rollInertia: number): RolloverStats | null {
  const rest = solveVehicle(input);
  if (!rest.converged) return null;
  const ids = input.corners.map((c) => c.id);
  const m = input.totalMass;
  // Total CG height above the ground and half track, from the car at rest.
  const h = (input.cg.y - input.groundY) / 1000;
  const xs = ids.map((id) => Math.abs(rest.corners[id].contact.x));
  const halfTrack = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length) / 1000;
  if (!(h > 0) || !(halfTrack > 0)) return null;
  // Whole-car roll inertia about its CG: the body's plus each wheel's mass at its distance from the CG (roll axis
  // along the car through the CG).
  let I = Math.max(0, rollInertia);
  for (const c of input.corners) {
    const w = rest.corners[c.id].wheelCenter;
    const dx = w.x / 1000, dy = (w.y - input.cg.y) / 1000;
    I += c.unsprungMass * (dx * dx + dy * dy);
  }
  const ssf = halfTrack / h;
  const reach = Math.hypot(h, halfTrack);
  const Ic = I + m * reach * reach;
  const tripSpeed = Math.sqrt(2 * m * G * (reach - h) * Ic) / (m * h);
  // Lift-off: a left turn (+ lateral g) unloads the left (inside) wheels. Stepping up from rest, each solve
  // starting from the last one's pose (straight at a high g the solve has no equilibrium to find: past the
  // tipping point there is none), then halving the step where the lighter inside tire first unloads.
  const inside = ids.filter((id) => id === 'FL' || id === 'RL') as CornerId[];
  const W = m * G;
  let guess = rest.pose;
  const lightAt = (g: number): number | null => {
    const r = solveVehicle({ ...input, lateralG: g }, { guess });
    if (!r.converged) return null;
    guess = r.pose;
    return Math.min(...inside.map((id) => r.corners[id].tireLoad));
  };
  let liftOffG: number | null = null;
  if (inside.length) {
    const step = 0.1, top = 1.2 * ssf;
    let lo = 0;
    for (let g = step; g <= top + 1e-9; g += step) {
      const l = lightAt(g);
      if (l === null) break;
      if (l < 0.01 * W) {
        let hi = g;
        const back = guess;
        for (let k = 0; k < 6; k++) {
          const mid = (lo + hi) / 2;
          guess = back;
          const lm = lightAt(mid);
          if (lm === null || lm < 0.01 * W) hi = mid; else lo = mid;
        }
        liftOffG = (lo + hi) / 2;
        break;
      }
      lo = g;
    }
  }
  return {
    ssf, liftOffG, tippingAngle: (Math.atan(halfTrack / h) * 180) / Math.PI, tripSpeed,
    basis: { mass: m, cgHeight: h * 1000, halfTrack: halfTrack * 1000, rollInertia: I },
  };
}
