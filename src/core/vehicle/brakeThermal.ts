/**
 * Brake fade (docs/MATH.md § Brakes, fade): one lumped rotor per wheel, heated by the braking power and
 * cooled by the air, and pad friction that falls when the rotor is hot.
 *
 *   C dT/dt = P − hA(v) (T − T_air)          C = rotor mass · 460 J/(kg·K) (cast iron)
 *   P       = braking force at the wheel · v  (all the braking energy goes into the rotor)
 *   hA(v)   = cooling · (0.2 + 0.8 · v / 27.8 m/s)   (cooling given at 100 km/h; a fifth of it at a stop)
 *
 * For constant P and v over a step the solution is exact:
 *   T(t) = T∞ + (T0 − T∞) e^(−hA t / C),  T∞ = T_air + P / hA.
 *
 * Pad friction: μ = μ0 below the fade start, falling linearly to μ0 · (1 − loss) at the fade end, then
 * staying there. The hydraulics' braking capacity scales with it, per axle.
 */

export interface BrakeThermal {
  /** Rotor mass per wheel, kg. */
  rotorMass: { front: number; rear: number };
  /** Cooling per rotor at 100 km/h (heat carried away per kelvin above the air), W/K. */
  cooling: number;
  /** Pad friction starts to fall at this rotor temperature, and has lost `fadeLoss` at `fadeEnd`, °C. */
  fadeStart: number;
  fadeEnd: number;
  /** Share of the pad friction lost at the fade end (0–1). */
  fadeLoss: number;
  /** Air temperature and the rotors' temperature at the start of a test, °C. */
  air: number;
  start: number;
  /** Drum axles: the brake factor falls faster than the lining μ (BF ∝ μ^k, k > 1); 1 (disc) when absent. */
  sensitivity?: { front: number; rear: number };
}

export interface AxleTemps { front: number; rear: number }

/** Specific heat of a cast-iron rotor, J/(kg·K). */
export const ROTOR_SPECIFIC_HEAT = 460;
const V100 = 100 / 3.6;

/** Cooling at speed v (m/s), W/K per rotor. */
export const coolingAt = (th: BrakeThermal, v: number) => Math.max(1e-6, th.cooling * (0.2 + 0.8 * Math.max(0, v) / V100));

/** Pad friction as a share of its cold value at rotor temperature T (°C). */
export function padFactor(th: BrakeThermal, T: number): number {
  const loss = Math.min(1, Math.max(0, th.fadeLoss));
  if (!(T > th.fadeStart)) return 1;
  if (!(th.fadeEnd > th.fadeStart) || T >= th.fadeEnd) return 1 - loss;
  return 1 - loss * (T - th.fadeStart) / (th.fadeEnd - th.fadeStart);
}

/** One rotor's temperature after dt s at a braking power P (W per rotor) and speed v (m/s), exact for constant P, v. */
export function rotorStep(th: BrakeThermal, mass: number, T0: number, P: number, v: number, dt: number): number {
  const C = Math.max(1e-6, mass) * ROTOR_SPECIFIC_HEAT;
  const hA = coolingAt(th, v);
  const Tinf = th.air + Math.max(0, P) / hA;
  return Tinf + (T0 - Tinf) * Math.exp((-hA * Math.max(0, dt)) / C);
}

/** Both axles one step on: braking force per axle (N, both wheels, ≥ 0), speed (m/s), dt (s). */
export function brakeStep(th: BrakeThermal, T: AxleTemps, force: AxleTemps, v: number, dt: number): AxleTemps {
  return {
    front: rotorStep(th, th.rotorMass.front, T.front, (Math.max(0, force.front) * v) / 2, v, dt),
    rear: rotorStep(th, th.rotorMass.rear, T.rear, (Math.max(0, force.rear) * v) / 2, v, dt),
  };
}

/** Each axle's braking capacity as a share of its cold value (a drum's falls faster: its sensitivity). */
export const padFactors = (th: BrakeThermal, T: AxleTemps): AxleTemps => ({
  front: padFactor(th, T.front) ** Math.max(1, th.sensitivity?.front ?? 1),
  rear: padFactor(th, T.rear) ** Math.max(1, th.sensitivity?.rear ?? 1),
});
