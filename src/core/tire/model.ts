/**
 * Tire vertical force models (L4, docs/MATH.md § L4). Pressures in kPa, forces in N, lengths in mm.
 * 1 kPa = 0.001 N/mm².
 */
import { bisect } from '../math/quadrature';
import { localPatch, airVolume, type LocalPatch, type TireProfile } from './geometry';

/** Standard-atmosphere ambient pressure at altitude (m), kPa. */
export const ambientPressure = (altitudeM: number): number =>
  101.325 * Math.pow(1 - 2.25577e-5 * altitudeM, 5.25588);

export interface TireConditions {
  /** Gauge pressure the tire was set to, kPa. */
  readonly setPressure: number;
  /** Altitude (m) and temperature (°C) where the pressure was set. */
  readonly setAltitude: number;
  readonly setTemperature: number;
  /** Altitude (m) and temperature (°C) while driving. */
  readonly operatingAltitude: number;
  readonly operatingTemperature: number;
}

export type TireForceModel =
  | { readonly kind: 'stiffness'; /** N/mm */ readonly rate: number }
  | {
      readonly kind: 'gas';
      readonly conditions: TireConditions;
      /** Apply the air-volume change from the displaced volume (toggle). */
      readonly volumeChange: boolean;
      /** Fraction of the geometric displaced volume actually lost from the air volume (0–1). */
      readonly volumeFactor: number;
      /** Optional carcass/sidewall stiffness added on top of the air spring, N/mm. */
      readonly carcassRate?: number;
    };

export interface TireForce {
  force: number;
  /** Operating gauge pressure, kPa (gas model). */
  pressureGauge?: number;
  /** Air volume after deflection, mm³ (gas model). */
  airVolume?: number;
  /** Relative air-volume change, (V₂ − V₁)/V₁ (gas model). */
  volumeChangeRatio?: number;
}

/** Vertical tire force for a given patch. */
export function tireForce(model: TireForceModel, profile: TireProfile, patch: LocalPatch): TireForce {
  if (!patch.inContact) return { force: 0 };
  if (model.kind === 'stiffness') return { force: model.rate * Math.max(0, patch.penetration) };
  const c = model.conditions;
  const v1 = airVolume(profile);
  const v2 = model.volumeChange ? Math.max(v1 * 1e-3, v1 - model.volumeFactor * patch.volume) : v1;
  const p1Abs = c.setPressure + ambientPressure(c.setAltitude);
  const t1 = c.setTemperature + 273.15;
  const t2 = c.operatingTemperature + 273.15;
  const p2Abs = p1Abs * (v1 / v2) * (t2 / t1);
  const gauge = p2Abs - ambientPressure(c.operatingAltitude);
  const force = gauge * 1e-3 * patch.area + (model.carcassRate ?? 0) * Math.max(0, patch.penetration);
  return { force, pressureGauge: gauge, airVolume: v2, volumeChangeRatio: (v2 - v1) / v1 };
}

/** Vertical tire stiffness at a load, N/mm (central difference on the back-solved height). */
export function tireRate(model: TireForceModel, profile: TireProfile, tilt: number, load: number): number {
  const d = Math.max(load * 0.02, 1);
  const fLo = Math.max(load - d, 1e-6);
  const fHi = load + d;
  const hLo = solveLoadedHeight(model, profile, tilt, fLo).centerHeight;
  const hHi = solveLoadedHeight(model, profile, tilt, fHi).centerHeight;
  return (fHi - fLo) / (hLo - hHi);
}

export interface LoadedTire {
  /** Wheel center height above the ground that carries the load, mm. */
  centerHeight: number;
  patch: LocalPatch;
  result: TireForce;
  /** The load could not be carried before the ground reached the rim. */
  bottomedOut: boolean;
}

/**
 * Back-solve the wheel-center height at which the tire carries `load` (N), at axle tilt n·a.
 * Force decreases monotonically with height, so a bracketed bisection always converges.
 */
export function solveLoadedHeight(model: TireForceModel, profile: TireProfile, tilt: number, load: number): LoadedTire {
  const evalAt = (h: number) => {
    const patch = localPatch(profile, h, tilt);
    return { patch, result: tireForce(model, profile, patch) };
  };
  const cosG = Math.sqrt(Math.max(1e-12, 1 - tilt * tilt));
  // Highest height with possible contact, and lowest before the rim meets the ground everywhere.
  const hi = profile.radius * cosG + Math.abs(tilt) * profile.width / 2 + 1e-6;
  const lo = profile.rimRadius * cosG - Math.abs(tilt) * profile.width / 2;
  if (load <= 0) {
    const r = evalAt(hi);
    return { centerHeight: hi, ...r, bottomedOut: false };
  }
  const atLo = evalAt(lo);
  if (atLo.result.force < load) return { centerHeight: lo, ...atLo, bottomedOut: true };
  const h = bisect((x) => evalAt(x).result.force - load, lo, hi, 1e-5);
  const r = evalAt(h);
  return { centerHeight: h, ...r, bottomedOut: r.patch.bottomedOut };
}

/**
 * Set pressure with no load (gauge, kPa) from a pressure measured with the tire carrying `load` (N) at the
 * set conditions: the loaded tire's air volume is smaller, so its gauge reads higher than when it was
 * unloaded (p · V constant at the same temperature). Fixed-point on the gas model; the stiffness model
 * has no air, so the reading is returned as is.
 */
export function unloadedSetPressure(model: TireForceModel, profile: TireProfile, measuredGauge: number, load: number): number {
  if (model.kind !== 'gas' || !model.volumeChange || !(load > 0)) return measuredGauge;
  const c = model.conditions;
  const at = (p: number): TireForceModel => ({ ...model, conditions: { ...c, setPressure: p, operatingAltitude: c.setAltitude, operatingTemperature: c.setTemperature } });
  let p = measuredGauge;
  for (let i = 0; i < 30; i++) {
    const loaded = tireForce(at(p), profile, solveLoadedHeight(at(p), profile, 0, load).patch).pressureGauge ?? measuredGauge;
    const next = p + (measuredGauge - loaded);
    if (Math.abs(next - p) < 1e-6) return next;
    p = next;
  }
  return p;
}
