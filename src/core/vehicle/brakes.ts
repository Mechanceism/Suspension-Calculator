/**
 * Brake hydraulics (docs/MATH.md § Brakes): the most braking force the brakes can make, from the pedal to
 * the tire, independent of grip.
 *
 *   pedal → master cylinder   F_mc = F_pedal · pedal ratio · booster gain · (balance-bar share, dual MC)
 *   line pressure             p = F_mc / A_mc                             (A_mc = π/4 · bore²)
 *   clamp → friction          F_friction = 2 · μ_pad · p · A_pistons      (A_pistons: one side's piston area;
 *                                                                          opposed or floating caliper: two pads)
 *   torque → tire force       T = F_friction · r_eff,   F_tire = T / r_tire   (per wheel)
 *
 * With one (tandem) master cylinder both circuits see the same pressure (balanceFront ignored); with two
 * master cylinders and a balance bar the pedal force splits balanceFront : (1 − balanceFront).
 *
 * Drum brakes (round 3, R5): the wheel cylinder pushes each shoe with F = p · A_wc and the shoes wrap into
 * the drum, multiplying it: T = BF · F · r_drum, BF = the brake factor of the pair (leading / trailing ≈ 2–2.5
 * at lining μ ≈ 0.4, duo-servo ≈ 3–5; a disc's is 2μ ≈ 0.9). The same self-energizing makes a drum fade
 * sooner: its brake factor falls faster than the lining μ (`fadeSensitivity` k: BF ∝ μ^k).
 *
 * Detailed hydraulics (optional): the fluid the master cylinder has to push. Per caliper the pads close
 * their clearance on both sides (2 · A_side · c, opposed or floating alike); per drum both wheel-cylinder
 * pistons push the shoes out (2 · A_wc · c); and the circuit swells under pressure (hoses, caliper flex,
 * pad compression: C · p). Master-cylinder travel = volume ÷ bore area; the pedal moves pedal ratio × the
 * pushrod (tandem: both chambers in series; balance bar: the pushrod at the bar's pivot).
 */

export interface BrakeAxle {
  /** Disc (caliper on a rotor) or drum (shoes in a drum). Default disc. */
  kind?: 'disc' | 'drum';
  /** Rotors / drums on the axle: 2 (one per wheel, default) or 1 (one brake through the differential, round 5). */
  rotors?: number;
  /** Master cylinder bore, mm. */
  mcBore: number;
  /** Caliper piston diameter (mm) and pistons per side. */
  pistonDiameter: number;
  pistonsPerSide: number;
  /** Pad friction coefficient. */
  padMu: number;
  /** Effective rotor radius (pad center), mm. */
  rotorRadius: number;
  /** Drum: wheel-cylinder bore (mm), drum radius (mm), brake factor of the shoe pair and its fade sensitivity. */
  wheelCylinder?: number;
  drumRadius?: number;
  brakeFactor?: number;
  fadeSensitivity?: number;
}

/** Brake torque per wheel (N·mm) at line pressure p (MPa). */
export function wheelTorque(a: BrakeAxle, p: number): number {
  if (a.kind === 'drum') return Math.max(0, a.brakeFactor ?? 2) * p * area(a.wheelCylinder ?? 0) * Math.max(0, a.drumRadius ?? 0);
  return 2 * a.padMu * p * area(a.pistonDiameter) * Math.max(0, a.pistonsPerSide) * a.rotorRadius;
}

export interface BrakeSystem {
  /** Most pedal force the driver applies, N. */
  maxPedalForce: number;
  pedalRatio: number;
  /** Booster gain (1 = none). */
  boost: number;
  /** Two master cylinders on a balance bar (else one tandem master cylinder for both circuits). */
  dualMc: boolean;
  /** Balance bar: share of the pedal force to the front master cylinder (0–1). */
  balanceFront: number;
  front: BrakeAxle;
  rear: BrakeAxle;
}

export interface BrakeCapacity {
  /** Line pressure at the most pedal force, kPa. */
  pressure: { front: number; rear: number };
  /** Brake torque per wheel, N·m. */
  torque: { front: number; rear: number };
  /** Most braking force at the tires per axle (two wheels), N. */
  axleForce: { front: number; rear: number };
  /** Front share of the braking force the hydraulics give (the brake bias they set). */
  bias: number;
}

export const area = (d: number) => (Math.PI / 4) * d * d;

/** What the brakes can make at the most pedal force (tire radii in mm, per axle). */
export function brakeCapacity(b: BrakeSystem, tireRadius: { front: number; rear: number }): BrakeCapacity {
  const pedal = Math.max(0, b.maxPedalForce) * Math.max(0, b.pedalRatio) * Math.max(0, b.boost);
  const share = b.dualMc ? { front: Math.min(1, Math.max(0, b.balanceFront)), rear: 1 - Math.min(1, Math.max(0, b.balanceFront)) } : { front: 1, rear: 1 };
  const axle = (a: BrakeAxle, s: number, rTire: number) => {
    const p = a.mcBore > 0 ? (pedal * s) / area(a.mcBore) : 0; // N/mm² = MPa
    const torque = wheelTorque(a, p); // N·mm
    return { pressure: p * 1000, torque: torque / 1000, force: rTire > 0 ? ((a.rotors ?? 2) * torque) / rTire : 0 };
  };
  const f = axle(b.front, share.front, tireRadius.front), r = axle(b.rear, share.rear, tireRadius.rear);
  return {
    pressure: { front: f.pressure, rear: r.pressure }, torque: { front: f.torque, rear: r.torque },
    axleForce: { front: f.force, rear: r.force }, bias: f.force + r.force > 0 ? f.force / (f.force + r.force) : NaN,
  };
}

/**
 * Pedal force a braking demand needs (N), from the axles' demands (N) and their capacity at the most pedal
 * force (everything is linear in the pedal force). > maxPedalForce = the brakes can't make it.
 */
export function pedalForceNeeded(demand: { front: number; rear: number }, cap: { front: number; rear: number }, maxPedal: number): number {
  const need = (d: number, c: number) => (d > 1e-9 ? (c > 0 ? (d / c) * maxPedal : Infinity) : 0);
  return Math.max(need(demand.front, cap.front), need(demand.rear, cap.rear));
}

// ---------------------------------------------------------------- fitting the wheel, what would fix it

/** Packaging inside the wheel: the caliper (or drum) needs this much radial room inside the rim. */
export interface WheelRoom {
  /** Rim diameter, mm (the bead seat). */
  rimDiameter: number;
  /** Radial room from the rim's bead seat to the rotor's outer edge (rim barrel + caliper body), mm. */
  clearance: number;
  /** Pad height: the effective radius sits half of it inside the rotor's edge, mm. */
  padHeight: number;
}
export const DEFAULT_ROOM = { clearance: 38, padHeight: 36 };

/** Largest rotor (outer diameter and effective radius, mm) and drum radius (mm) that fit the wheel. */
export function maxRotor(room: WheelRoom): { diameter: number; effectiveRadius: number; drumRadius: number } {
  const outer = room.rimDiameter / 2 - room.clearance;
  return { diameter: 2 * outer, effectiveRadius: outer - room.padHeight / 2, drumRadius: room.rimDiameter / 2 - 0.5 * room.clearance };
}

/** Does the axle's rotor (or drum) fit inside the wheel? */
export function fitsWheel(a: BrakeAxle, room: WheelRoom): boolean {
  const m = maxRotor(room);
  return a.kind === 'drum' ? (a.drumRadius ?? 0) <= m.drumRadius + 1e-9 : a.rotorRadius <= m.effectiveRadius + 1e-9;
}

/** One way to get the torque an axle lacks: the input, its value now and what it would need. */
export interface BrakeFix { what: string; now: number; needed: number; unit: string; fits: boolean }

/**
 * What would make an axle's brakes strong enough: each single change that multiplies its torque by `k`
 * (k = demand ÷ capacity, > 1) and whether it is possible (a rotor or drum still fitting the wheel, at most
 * 4 pistons per side, a pad μ a pad can have, a master cylinder not under ½").
 */
export function brakeFixes(a: BrakeAxle, k: number, room?: WheelRoom): BrakeFix[] {
  if (!(k > 1)) return [];
  const out: BrakeFix[] = [];
  const max = room ? maxRotor(room) : null;
  if (a.kind === 'drum') {
    const wc = a.wheelCylinder ?? 0, dr = a.drumRadius ?? 0, bf = a.brakeFactor ?? 2;
    out.push({ what: 'Wheel-cylinder bore', now: wc, needed: wc * Math.sqrt(k), unit: 'mm', fits: true });
    out.push({ what: 'Drum radius', now: dr, needed: dr * k, unit: 'mm', fits: !max || dr * k <= max.drumRadius });
    out.push({ what: 'Brake factor (e.g. duo-servo shoes)', now: bf, needed: bf * k, unit: '', fits: bf * k <= 5 });
  } else {
    out.push({ what: 'Effective rotor radius', now: a.rotorRadius, needed: a.rotorRadius * k, unit: 'mm', fits: !max || a.rotorRadius * k <= max.effectiveRadius });
    out.push({ what: 'Caliper piston diameter', now: a.pistonDiameter, needed: a.pistonDiameter * Math.sqrt(k), unit: 'mm', fits: true });
    const n = Math.ceil(a.pistonsPerSide * k - 1e-9);
    out.push({ what: 'Pistons per side', now: a.pistonsPerSide, needed: n, unit: '', fits: n <= 4 });
    out.push({ what: 'Pad friction μ', now: a.padMu, needed: a.padMu * k, unit: '', fits: a.padMu * k <= 0.65 });
  }
  out.push({ what: 'Master-cylinder bore (smaller)', now: a.mcBore, needed: a.mcBore / Math.sqrt(k), unit: 'mm', fits: a.mcBore / Math.sqrt(k) >= 12.7 });
  return out;
}

/** The pedal-side changes (whole system) that multiply both axles' torque by k. */
export function pedalFixes(b: BrakeSystem, k: number): BrakeFix[] {
  if (!(k > 1)) return [];
  return [
    { what: 'Pedal ratio', now: b.pedalRatio, needed: b.pedalRatio * k, unit: ':1', fits: b.pedalRatio * k <= 7 },
    { what: 'Booster gain', now: b.boost, needed: b.boost * k, unit: '×', fits: b.boost * k <= 8 },
    { what: 'Pedal force', now: b.maxPedalForce, needed: b.maxPedalForce * k, unit: 'N', fits: b.maxPedalForce * k <= 1000 },
  ];
}

// ---------------------------------------------------------------- detailed hydraulics: fluid and pedal travel

export interface BrakeDetail {
  /** Master-cylinder stroke (a tandem's two chambers share it), mm. */
  mcStroke: number;
  /** Most pedal travel the driver accepts (at the pedal pad), mm. */
  maxPedalTravel: number;
  /** Disc: the clearance each pad closes before it clamps, mm. */
  padClearance: number;
  /** Drum: each shoe's travel at the wheel cylinder, mm. */
  shoeClearance: number;
  /** Circuit swell under pressure (hoses, caliper / drum flex, pad compression), both wheels of an axle, mm³/MPa. */
  compliance: { front: number; rear: number };
}

/** Fluid an axle's circuit takes at line pressure p (MPa), every brake on the axle (both wheels, or the one driveline brake), mm³. */
export function circuitVolume(a: BrakeAxle, d: BrakeDetail, compliance: number, p: number): number {
  const close = a.kind === 'drum'
    ? 2 * area(a.wheelCylinder ?? 0) * d.shoeClearance
    : 2 * area(a.pistonDiameter) * Math.max(0, a.pistonsPerSide) * d.padClearance;
  return (a.rotors ?? 2) * close + Math.max(0, compliance) * Math.max(0, p);
}

export interface PedalTravel {
  /** Pedal travel at the pedal pad, mm. */
  pedal: number;
  /** Master-cylinder travel per circuit, mm. */
  mc: { front: number; rear: number };
  /** Share of the stroke used (the fullest master cylinder; a tandem's chambers add up); > 1 = it runs out. */
  strokeUse: number;
}

/**
 * Pedal and master-cylinder travel when the pedal pushes `pedalShare` of its most force (line pressure
 * scales with it; each axle's circuit filled to its pressure).
 */
export function pedalTravel(b: BrakeSystem, d: BrakeDetail, pedalShare: number): PedalTravel {
  const push = Math.max(0, b.maxPedalForce) * Math.max(0, b.pedalRatio) * Math.max(0, b.boost) * Math.max(0, pedalShare);
  const share = b.dualMc ? { front: Math.min(1, Math.max(0, b.balanceFront)), rear: 1 - Math.min(1, Math.max(0, b.balanceFront)) } : { front: 1, rear: 1 };
  const x = (a: BrakeAxle, s: number, c: number) => {
    const A = area(a.mcBore);
    return A > 0 ? circuitVolume(a, d, c, (push * s) / A) / A : 0;
  };
  const xf = x(b.front, share.front, d.compliance.front), xr = x(b.rear, share.rear, d.compliance.rear);
  const rod = b.dualMc ? share.front * xf + share.rear * xr : xf + xr;
  const strokeUse = d.mcStroke > 0 ? (b.dualMc ? Math.max(xf, xr) : xf + xr) / d.mcStroke : Infinity;
  return { pedal: rod * Math.max(0, b.pedalRatio), mc: { front: xf, rear: xr }, strokeUse };
}

// ---------------------------------------------------------------- the brake ladder (optimizer)

/** One size on the ladder: what changes on the axle. */
export interface BrakeStep { label: string; patch: Partial<BrakeAxle> }

/** Calipers by clamping area per side, smallest first (1 piston per side = a 1-piston floating or a 2-piston opposed caliper). */
export const CALIPER_STEPS: { pistons: number; diameter: number; label: string }[] = [
  { pistons: 1, diameter: 32, label: '1 × 32 mm per side' }, { pistons: 1, diameter: 36, label: '1 × 36 mm per side' },
  { pistons: 1, diameter: 40, label: '1 × 40 mm per side' }, { pistons: 1, diameter: 45, label: '1 × 45 mm per side' },
  { pistons: 1, diameter: 51, label: '1 × 51 mm per side' }, { pistons: 2, diameter: 38, label: '2 × 38 mm per side (4-piston opposed)' },
  { pistons: 2, diameter: 42, label: '2 × 42 mm per side' }, { pistons: 3, diameter: 38, label: '3 × 38 mm per side (6-piston opposed)' },
  { pistons: 3, diameter: 42, label: '3 × 42 mm per side' },
];
/** Rotor outer diameters, mm (effective radius = half, less half the pad height). */
export const ROTOR_DIAMETERS = [200, 220, 240, 260, 280, 300, 320, 340, 355, 380, 405];
/** Drums: wheel-cylinder bores and drum diameters, mm. */
export const WHEEL_CYLINDERS = [15.9, 17.5, 19.05, 20.6, 22.2, 23.8, 25.4];
export const DRUM_DIAMETERS = [180, 203, 229, 254, 279, 305];

/**
 * The ladder for an axle, in order: more pistons first, larger rotors last (every caliper on the smallest
 * rotor, then every caliper on the next rotor…), rotors only while they fit the wheel. A drum axle: wheel
 * cylinders first, then larger drums. A disc ladder for a drum axle when it may switch (`kind`).
 */
export function brakeLadder(kind: 'disc' | 'drum', room: WheelRoom): BrakeStep[] {
  const max = maxRotor(room);
  const out: BrakeStep[] = [];
  if (kind === 'drum') {
    for (const D of DRUM_DIAMETERS) {
      if (D / 2 > max.drumRadius + 1e-9) break;
      for (const wc of WHEEL_CYLINDERS) out.push({ label: `${D} mm drum, ${wc} mm wheel cylinder`, patch: { kind: 'drum', drumRadius: D / 2, wheelCylinder: wc } });
    }
    return out;
  }
  for (const D of ROTOR_DIAMETERS) {
    if (D > max.diameter + 1e-9) break;
    const r = D / 2 - room.padHeight / 2;
    for (const c of CALIPER_STEPS) out.push({ label: `${D} mm rotor, ${c.label}`, patch: { kind: 'disc', rotorRadius: r, pistonsPerSide: c.pistons, pistonDiameter: c.diameter } });
  }
  return out;
}

export interface LadderPick {
  /** The chosen step (null: none is enough). */
  step: BrakeStep | null;
  /** Its torque per unit pressure over the axle's current one. */
  gain: number;
  /** The ladder ran out: the largest that fits is short by this factor (> 1). */
  short?: number;
  /** The axle's own brakes are the right size (enough, and the ladder has nothing smaller that is). */
  keep?: boolean;
}

/**
 * The first (smallest) step on the ladder whose torque is at least `need` × the axle's current torque
 * (need = the hardest braking's demand ÷ the faded capacity × (1 + reserve); < 1 steps down). `ok` can
 * veto a step (e.g. one that makes the pedal too long).
 */
export function pickStep(a: BrakeAxle, ladder: BrakeStep[], need: number, ok: (axle: BrakeAxle) => boolean = () => true): LadderPick {
  const t0 = wheelTorque(a, 1);
  if (!(t0 > 0)) return { step: null, gain: NaN };
  let best = 0;
  // The axle's own brakes are a size too: kept when they're enough and the ladder only has bigger ones.
  const keep = need <= 1 + 1e-9 && ok(a);
  for (const st of ladder) {
    const cand = { ...a, ...st.patch };
    const g = wheelTorque(cand, 1) / t0;
    if (ok(cand)) best = Math.max(best, g);
    if (g >= need - 1e-9 && ok(cand)) return keep && g > 1 + 1e-9 ? { step: null, gain: 1, keep: true } : { step: st, gain: g };
  }
  if (keep) return { step: null, gain: 1, keep: true };
  return { step: null, gain: best, short: need / Math.max(best, 1e-9) };
}
