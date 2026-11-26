/**
 * Basic car profiles: whole-car starting points (File → New from car profile). Each sets every corner's
 * suspension type and points, the springs (from a ride frequency), dampers (from critical damping), tires,
 * travel and the vehicle inputs (mass, CG, wheelbase, brakes and drive). The points are the sample layouts
 * scaled to the car's tire size (height and length) and track (width); everything stays editable.
 */
import { formatValue, type Quantity } from '../core/units/units';
import { vec3, type Vec3 } from '../core/math/vec3';
import { DoubleWishbone, type DoubleWishboneGeometry } from '../core/suspension/doubleWishbone';
import type { CornerId } from '../core/vehicle/vehicle';
import { wizardKeys } from './locks';
import {
  SAMPLE_LAYOUTS, SAMPLE_MACPHERSON, SAMPLE_MULTILINK, SAMPLE_BEAM4, SAMPLE_TWIST_BEAM, SAMPLE_LEAF, SAMPLE_TRAILING_ARM,
} from '../examples/sampleLayouts';
import {
  defaultDesign, editableFromGeometry, fittedSpring, toGeometry, vehicleStaticLoads,
  type CornerDesign, type DesignState, type CornerSettings, type Field,
} from './store';

const G = 9.80665;
const field = (value: number, quantity: Quantity = 'length'): Field => ({ text: formatValue(value, quantity), value });
const round = (v: number, step = 1) => Math.round(v / step) * step;

/** A geometry scaled: x (across the car) by sx, height and length by s. The wheel's spin axis is unchanged. */
export function scaleGeometry(g: DoubleWishboneGeometry, sx: number, s: number): DoubleWishboneGeometry {
  const v = (p: Vec3): Vec3 => vec3(p.x * sx, p.y * s, p.z * s);
  const walk = (o: unknown, key = ''): unknown => {
    if (Array.isArray(o)) return o.map((x) => walk(x));
    if (!o || typeof o !== 'object') return o;
    const r = o as Record<string, unknown>;
    if (key !== 'spinAxis' && typeof r.x === 'number' && typeof r.y === 'number' && typeof r.z === 'number' && Object.keys(r).length === 3) return v(r as unknown as Vec3);
    return Object.fromEntries(Object.entries(r).map(([k, x]) => [k, walk(x, k)]));
  };
  const out = walk(g) as DoubleWishboneGeometry;
  return { ...out, wheel: { ...out.wheel, spinAxis: g.wheel.spinAxis, radius: g.wheel.radius * s, width: (g.wheel.width ?? 205) * sx } };
}

/** One axle of a profile. */
interface AxleSpec {
  /** Base layout and the half track to put its wheel center at (mm). */
  layout: DoubleWishboneGeometry;
  halfTrack: number;
  /** Tire: outer diameter, section width, rim diameter (mm), tire size text, set pressure (kPa). */
  tire: { diameter: number; width: number; rim: number; text: string; pressure: number };
  unsprung: number;
  /** Ride frequency (Hz) for the spring, damping ratio (bump; rebound = 1.6 ×). */
  rideHz: number;
  zeta: number;
  camber: number;
}

export interface CarProfileSpec {
  id: string;
  label: string;
  hint: string;
  front: AxleSpec;
  rear: AxleSpec;
  mass: number;
  /** CG height above the ground and front weight share (0–1). */
  cgHeight: number;
  frontShare: number;
  wheelbase: number;
  brakeBias: number;
  driveSplit: number;
  /** Driven / braked axles. */
  drive: 'front' | 'rear' | 'all';
  brakes: 'all' | 'rear';
  /** The rear brake is one brake through the differential / solid axle (a mower's transaxle brake, a kart's disc on its axle). */
  rearDriveline?: boolean;
  abs: boolean;
  diff: CornerSettings['diff'];
  /** Body inertias, kg·m²: roll, pitch, yaw. */
  inertia: [number, number, number];
  droop: number;
  bump: number;
  /** Rack travel per steering-wheel turn (mm/rev) and its limit (mm). */
  rack: [number, number];
  /** Anti-roll bars at the wheel, N/mm (0 = none). */
  bars: [number, number];
  /**
   * Powertrain (F5), one gear — peak torque (N·m) @ rpm, peak power (kW) @ rpm, redline (electric: most rpm), idle,
   * clutch (rpm; gas only), overall ratio, efficiency (%). Gas unless `electric`.
   */
  engine: { torque: number; torqueRpm: number; power: number; powerRpm: number; redline: number; idle: number; clutch: number; ratio: number; efficiency: number; electric?: boolean };
  /** Aerodynamics on, generic values: drag area and downforce areas front / rear (m²). */
  aero?: { CdA: number; downF: number; downR: number };
  /** Towing: the hitch's rated tongue load (kg; the trailer itself stays off). */
  hitchRating?: number;
}

const FSAE_TIRE = { diameter: 457, width: 190, rim: 254, text: '18x7.5-10', pressure: 83 };

export const CAR_PROFILES: CarProfileSpec[] = [
  {
    id: 'road', label: 'Road car (front-drive hatchback)',
    hint: 'MacPherson struts in front, a multilink rear, 205/55 R16 tires, 1300 kg with 61 % on the front, front-wheel drive with ABS.',
    front: { layout: SAMPLE_MACPHERSON, halfTrack: 760, tire: { diameter: 632, width: 205, rim: 406.4, text: '205/55R16', pressure: 230 }, unsprung: 40, rideHz: 1.3, zeta: 0.3, camber: -0.5 },
    rear: { layout: SAMPLE_MULTILINK, halfTrack: 750, tire: { diameter: 632, width: 205, rim: 406.4, text: '205/55R16', pressure: 220 }, unsprung: 35, rideHz: 1.5, zeta: 0.3, camber: -1.2 },
    mass: 1300, cgHeight: 540, frontShare: 0.61, wheelbase: 2600, brakeBias: 0.7, driveSplit: 1, drive: 'front', brakes: 'all', abs: true, diff: 'open',
    inertia: [450, 1800, 2000], droop: 80, bump: 80, rack: [50, 75], bars: [30, 12],
    // A 1.6 l four; one gear at about second's overall ratio (≈ 100 km/h at the redline).
    engine: { torque: 160, torqueRpm: 4000, power: 90, powerRpm: 6000, redline: 6500, idle: 800, clutch: 2000, ratio: 7.5, efficiency: 90 },
  },
  {
    id: 'fsae', label: 'FSAE car',
    hint: 'Double wishbones all round, 10 in wheels (18 × 7.5-10), 300 kg with the driver, 1550 mm wheelbase, rear-wheel drive through a limited-slip differential.',
    front: { layout: SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry, halfTrack: 610, tire: FSAE_TIRE, unsprung: 12, rideHz: 3.0, zeta: 0.6, camber: -1.5 },
    rear: { layout: SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry, halfTrack: 590, tire: FSAE_TIRE, unsprung: 13, rideHz: 3.2, zeta: 0.6, camber: -1 },
    mass: 300, cgHeight: 280, frontShare: 0.47, wheelbase: 1550, brakeBias: 0.62, driveSplit: 0, drive: 'rear', brakes: 'all', abs: false, diff: 'lsd',
    inertia: [35, 100, 140], droop: 30, bump: 30, rack: [75, 30], bars: [15, 10],
    // A 600 cc motorcycle engine in one gear (≈ second: ≈ 100 km/h at the redline).
    engine: { torque: 55, torqueRpm: 9500, power: 60, powerRpm: 11500, redline: 13000, idle: 1500, clutch: 5000, ratio: 11, efficiency: 88 },
  },
  {
    id: 'kart', label: 'Kart',
    hint: 'No real suspension: very stiff springs stand in for the frame flex. A solid rear axle with no differential, rear brake only, 5 in wheels, 165 kg with the driver.',
    front: { layout: SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry, halfTrack: 540, tire: { diameter: 254, width: 114, rim: 127, text: '10x4.50-5', pressure: 75 }, unsprung: 3, rideHz: 9, zeta: 0.2, camber: -1 },
    rear: { layout: SAMPLE_BEAM4, halfTrack: 600, tire: { diameter: 279, width: 180, rim: 127, text: '11x7.10-5', pressure: 75 }, unsprung: 6, rideHz: 9, zeta: 0.2, camber: 0 },
    mass: 165, cgHeight: 260, frontShare: 0.42, wheelbase: 1040, brakeBias: 0, driveSplit: 0, drive: 'rear', brakes: 'rear', rearDriveline: true, abs: false, diff: 'locked',
    inertia: [8, 14, 18], droop: 10, bump: 10, rack: [60, 25], bars: [0, 0],
    // A 206 cc four-stroke kart engine (≈ 9 hp), a centrifugal clutch, 18 : 60 chain drive.
    engine: { torque: 12.5, torqueRpm: 3800, power: 6.7, powerRpm: 5600, redline: 6100, idle: 1800, clutch: 2400, ratio: 60 / 18, efficiency: 92 },
  },
  {
    id: 'trophy', label: 'Trophy truck (long travel)',
    hint: 'Long-travel double wishbones in front, a 4-link solid rear axle, 40 in tires, 2700 kg, soft springs and lots of travel; rear-wheel drive with a locked rear.',
    front: { layout: SAMPLE_LAYOUTS.find((l) => l.id === 'A')!.geometry, halfTrack: 1100, tire: { diameter: 1016, width: 343, rim: 431.8, text: '40x13.50R17', pressure: 140 }, unsprung: 140, rideHz: 1.0, zeta: 0.35, camber: 0 },
    rear: { layout: SAMPLE_BEAM4, halfTrack: 1080, tire: { diameter: 1016, width: 343, rim: 431.8, text: '40x13.50R17', pressure: 140 }, unsprung: 200, rideHz: 1.1, zeta: 0.35, camber: 0 },
    mass: 2700, cgHeight: 800, frontShare: 0.5, wheelbase: 3050, brakeBias: 0.72, driveSplit: 0, drive: 'rear', brakes: 'all', abs: false, diff: 'locked',
    inertia: [1500, 5500, 6000], droop: 200, bump: 250, rack: [60, 70], bars: [25, 0],
    // A big V8 (≈ 870 hp) in one gear (≈ third: ≈ 215 km/h at the redline).
    engine: { torque: 1000, torqueRpm: 4800, power: 650, powerRpm: 6500, redline: 7000, idle: 900, clutch: 2500, ratio: 6, efficiency: 88 },
  },
  {
    id: 'supercar', label: 'Supercar (mid-engine)',
    hint: 'Double wishbones all round, 245/35 R20 front and 305/30 R20 rear, 1500 kg with 42 % on the front, a mid-mounted twin-turbo V8 driving the rear through a limited-slip differential, wings and ABS.',
    front: { layout: SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry, halfTrack: 830, tire: { diameter: 680, width: 245, rim: 508, text: '245/35R20', pressure: 220 }, unsprung: 40, rideHz: 1.9, zeta: 0.35, camber: -1.5 },
    rear: { layout: SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry, halfTrack: 820, tire: { diameter: 691, width: 305, rim: 508, text: '305/30R20', pressure: 220 }, unsprung: 45, rideHz: 2.1, zeta: 0.35, camber: -2 },
    mass: 1500, cgHeight: 440, frontShare: 0.42, wheelbase: 2650, brakeBias: 0.62, driveSplit: 0, drive: 'rear', brakes: 'all', abs: true, diff: 'lsd',
    inertia: [450, 1800, 2000], droop: 60, bump: 60, rack: [55, 70], bars: [40, 25],
    // ≈ 600 hp in one gear (≈ third: ≈ 250 km/h at the redline).
    engine: { torque: 770, torqueRpm: 3500, power: 450, powerRpm: 7000, redline: 8000, idle: 900, clutch: 2000, ratio: 4.3, efficiency: 88 },
    aero: { CdA: 0.75, downF: 0.4, downR: 0.6 },
  },
  {
    id: 'mower', label: 'Riding lawnmower',
    hint: 'No suspension (very stiff springs stand in for the frame and tire flex): 15 × 6-6 front and 20 × 8-8 rear tires, 200 kg with the driver, a 13 hp engine geared for ≈ 9 km/h, rear brakes, no differential lock, no ABS.',
    front: { layout: SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry, halfTrack: 400, tire: { diameter: 381, width: 152, rim: 152.4, text: '15x6.00-6', pressure: 100 }, unsprung: 6, rideHz: 6, zeta: 0.2, camber: 0 },
    rear: { layout: SAMPLE_BEAM4, halfTrack: 430, tire: { diameter: 508, width: 203, rim: 203.2, text: '20x8.00-8', pressure: 70 }, unsprung: 15, rideHz: 6, zeta: 0.2, camber: 0 },
    mass: 200, cgHeight: 420, frontShare: 0.35, wheelbase: 1200, brakeBias: 0, driveSplit: 0, drive: 'rear', brakes: 'rear', rearDriveline: true, abs: false, diff: 'open',
    inertia: [12, 25, 30], droop: 10, bump: 10, rack: [40, 30], bars: [0, 0],
    // A 13 hp single, governed at 3600 rpm, through a big reduction (≈ 9 km/h at full throttle).
    engine: { torque: 27, torqueRpm: 2600, power: 9.7, powerRpm: 3400, redline: 3600, idle: 1200, clutch: 1500, ratio: 38, efficiency: 80 },
  },
  {
    id: 'ev', label: 'Electric hatchback',
    hint: 'MacPherson struts in front, a twist beam rear, 205/55 R16 tires, 1600 kg (the battery low in the floor) with 56 % on the front, a 150 kW motor driving the front wheels through one gear, ABS.',
    front: { layout: SAMPLE_MACPHERSON, halfTrack: 770, tire: { diameter: 632, width: 205, rim: 406.4, text: '205/55R16', pressure: 250 }, unsprung: 42, rideHz: 1.4, zeta: 0.3, camber: -0.7 },
    rear: { layout: SAMPLE_TWIST_BEAM, halfTrack: 765, tire: { diameter: 632, width: 205, rim: 406.4, text: '205/55R16', pressure: 250 }, unsprung: 38, rideHz: 1.6, zeta: 0.3, camber: -1 },
    mass: 1600, cgHeight: 500, frontShare: 0.56, wheelbase: 2700, brakeBias: 0.7, driveSplit: 1, drive: 'front', brakes: 'all', abs: true, diff: 'open',
    inertia: [550, 2200, 2400], droop: 80, bump: 80, rack: [50, 75], bars: [25, 0],
    // 150 kW, 310 N·m from standstill, 14 000 rpm, one gear (≈ 160 km/h at the most rpm).
    engine: { torque: 310, torqueRpm: 0, power: 150, powerRpm: 0, redline: 14000, idle: 0, clutch: 0, ratio: 10.5, efficiency: 94, electric: true },
  },
  {
    id: 'pickup', label: 'Pickup truck (leaf springs, tows)',
    hint: 'Double wishbones in front, a solid rear axle on leaf springs, 265/70 R17 tires, 2300 kg with 57 % on the front, a V8 driving the rear through an open differential, ABS; the hitch is rated for 450 kg of tongue load (Towing: switch the trailer on).',
    front: { layout: SAMPLE_LAYOUTS.find((l) => l.id === 'A')!.geometry, halfTrack: 860, tire: { diameter: 802, width: 265, rim: 431.8, text: '265/70R17', pressure: 240 }, unsprung: 70, rideHz: 1.2, zeta: 0.3, camber: 0 },
    rear: { layout: SAMPLE_LEAF, halfTrack: 860, tire: { diameter: 802, width: 265, rim: 431.8, text: '265/70R17', pressure: 280 }, unsprung: 110, rideHz: 1.5, zeta: 0.3, camber: 0 },
    mass: 2300, cgHeight: 720, frontShare: 0.57, wheelbase: 3550, brakeBias: 0.68, driveSplit: 0, drive: 'rear', brakes: 'all', abs: true, diff: 'open',
    inertia: [1100, 4800, 5200], droop: 110, bump: 110, rack: [55, 75], bars: [30, 0],
    // A 5.0 l V8 in one gear (≈ second: ≈ 120 km/h at the redline).
    engine: { torque: 540, torqueRpm: 4000, power: 300, powerRpm: 6000, redline: 6500, idle: 700, clutch: 1600, ratio: 7.5, efficiency: 88 },
    hitchRating: 450,
  },
  {
    id: 'utv', label: 'UTV / side-by-side',
    hint: 'Long-travel double wishbones in front, trailing arms behind, 30 × 10-14 tires, 800 kg with two people, a 1000 cc twin through a CVT (one ratio here) to all four wheels, a locked rear, no ABS.',
    front: { layout: SAMPLE_LAYOUTS.find((l) => l.id === 'A')!.geometry, halfTrack: 780, tire: { diameter: 762, width: 254, rim: 355.6, text: '30x10-14', pressure: 100 }, unsprung: 30, rideHz: 1.3, zeta: 0.4, camber: 0 },
    rear: { layout: SAMPLE_TRAILING_ARM, halfTrack: 760, tire: { diameter: 762, width: 254, rim: 355.6, text: '30x10-14', pressure: 100 }, unsprung: 35, rideHz: 1.4, zeta: 0.4, camber: 0 },
    mass: 800, cgHeight: 600, frontShare: 0.42, wheelbase: 2300, brakeBias: 0.6, driveSplit: 0.35, drive: 'all', brakes: 'all', abs: false, diff: 'locked',
    inertia: [250, 800, 900], droop: 180, bump: 200, rack: [60, 70], bars: [15, 0],
    // ≈ 100 hp through a CVT, taken as one ratio (≈ 110 km/h at the most rpm).
    engine: { torque: 95, torqueRpm: 6000, power: 75, powerRpm: 8000, redline: 8500, idle: 1300, clutch: 2500, ratio: 10, efficiency: 82 },
  },
  {
    id: 'formula', label: 'Formula car (wings)',
    hint: 'Pushrod double wishbones, 13 in wheels, 580 kg with the driver and 45 % on the front, a 2.0 l engine behind the driver through a limited-slip differential, big wings and a low ride, no ABS.',
    front: { layout: SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry, halfTrack: 790, tire: { diameter: 550, width: 230, rim: 330.2, text: '230/550R13', pressure: 140 }, unsprung: 14, rideHz: 3.5, zeta: 0.5, camber: -2.5 },
    rear: { layout: SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry, halfTrack: 760, tire: { diameter: 570, width: 290, rim: 330.2, text: '290/570R13', pressure: 140 }, unsprung: 16, rideHz: 3.8, zeta: 0.5, camber: -1.5 },
    mass: 580, cgHeight: 270, frontShare: 0.45, wheelbase: 2750, brakeBias: 0.58, driveSplit: 0, drive: 'rear', brakes: 'all', abs: false, diff: 'lsd',
    inertia: [60, 400, 450], droop: 25, bump: 30, rack: [70, 25], bars: [60, 40],
    // ≈ 220 hp in one gear (≈ 200 km/h at the redline).
    engine: { torque: 250, torqueRpm: 5500, power: 164, powerRpm: 7000, redline: 7500, idle: 1500, clutch: 3000, ratio: 4.1, efficiency: 90 },
    aero: { CdA: 1.1, downF: 1.2, downR: 1.6 },
  },
];

/** Damper length (mm) at a travel; NaN when the corner can't be solved there. */
function damperLength(g: DoubleWishboneGeometry, travel: number): number {
  try {
    const st = new DoubleWishbone(g).solve({ travel, rack: 0 });
    const a = st.points.damperChassis, b = st.points.damperArm;
    return st.solve.status === 'converged' && a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : NaN;
  } catch {
    return NaN;
  }
}

/** A corner design for one axle of a profile, its spring and dampers sized for this corner's sprung load. */
/** Every point raised by dy (mm): the corner moved up or down on the chassis. */
function shiftGeometry(g: DoubleWishboneGeometry, dy: number): DoubleWishboneGeometry {
  const walk = (o: unknown, key = ''): unknown => {
    if (Array.isArray(o)) return o.map((x) => walk(x));
    if (!o || typeof o !== 'object') return o;
    const r = o as Record<string, unknown>;
    if (key !== 'spinAxis' && typeof r.x === 'number' && typeof r.y === 'number' && typeof r.z === 'number' && Object.keys(r).length === 3) return vec3(r.x as number, (r.y as number) + dy, r.z as number);
    return Object.fromEntries(Object.entries(r).map(([k, x]) => [k, walk(x, k)]));
  };
  return walk(g) as DoubleWishboneGeometry;
}

/** The ground under an axle's tire as scaled (wheel center height − radius), mm in the corner frame. */
const groundOf = (a: AxleSpec) => {
  const s = a.tire.diameter / 2 / a.layout.wheel.radius;
  return a.layout.wheel.center.y * s - a.tire.diameter / 2;
};

/**
 * `ground`: where the tires touch at the design position (mm): the corner is moved up or down so its tire
 * touches there, so a car with different front and rear wheels sits level on all four (round 4: the
 * lawnmower's 381 mm front and 508 mm rear wheels left the front tires ≈ 25 mm off the ground, and it
 * couldn't settle).
 */
function axleDesign(base: CornerDesign, a: AxleSpec, cornerLoad: number, droop: number, bump: number, ground = groundOf(a)): CornerDesign {
  const baseG = a.layout;
  const s = a.tire.diameter / 2 / baseG.wheel.radius;
  const sx = a.halfTrack / baseG.wheel.center.x;
  const g = shiftGeometry(scaleGeometry(baseG, sx, s), ground - groundOf(a));
  const ed = editableFromGeometry(g);
  const geom = {
    ...ed,
    scalars: {
      ...ed.scalars,
      staticCamber: field(a.camber, 'angle'),
      tireDiameter: field(a.tire.diameter), tireWidth: field(a.tire.width), rimDiameter: field(a.tire.rim),
    },
  };
  const geo = toGeometry(geom);
  // Motion ratio (damper / wheel) near ride height and the damper lengths over the travel.
  const l0 = damperLength(geo, 0);
  const mr = Math.abs((damperLength(geo, -5) - damperLength(geo, 5)) / 10) || 1;
  const lMax = damperLength(geo, -droop), lMin = damperLength(geo, bump);
  const sprung = Math.max(0, cornerLoad / G - a.unsprung);
  const wheelRate = (sprung * (2 * Math.PI * a.rideHz) ** 2) / 1000; // N/mm
  const springRate = round(wheelRate / (mr * mr), 0.5) || 1;
  const crit = 2 * Math.sqrt(wheelRate * 1000 * sprung); // N·s/m at the wheel
  const bumpC = round((a.zeta * crit) / (mr * mr), 10);
  const spring = fittedSpring(geom, {
    ...base.spring, cornerLoad: field(round(cornerLoad), 'force'), unsprungMass: field(a.unsprung, 'mass'), springRate: field(springRate, 'rate'),
  });
  const ext = Number.isFinite(lMax) ? lMax + 5 : (Number.isFinite(l0) ? l0 + droop * mr + 5 : base.damper.maxLength.value);
  const comp = Number.isFinite(lMin) ? lMin - 5 : (Number.isFinite(l0) ? l0 - bump * mr - 5 : base.damper.minLength.value);
  const damper = {
    ...base.damper,
    maxLength: field(round(ext)), minLength: field(round(comp)), bumpStopLength: field(round(comp + 0.15 * (ext - comp))),
    bumpStopRate: field(round(Math.max(50, springRate * 6), 10), 'rate'),
    bumpDamping: field(bumpC, 'damping'), reboundDamping: field(round(1.6 * bumpC, 10), 'damping'),
    bumpDampingHigh: field(round(bumpC / 2, 10), 'damping'), reboundDampingHigh: field(round(0.8 * bumpC, 10), 'damping'),
  };
  return {
    ...base, geom, spring, damper,
    tire: { ...base.tire, pressure: field(a.tire.pressure, 'pressure') },
    tireSizeText: a.tire.text,
  };
}

/** The whole design for a profile. */
export function carProfileDesign(id: string): DesignState {
  const p = CAR_PROFILES.find((c) => c.id === id) ?? CAR_PROFILES[0]!;
  const d = defaultDesign();
  const cgZ = -(1 - p.frontShare) * p.wheelbase;
  const vehicle = {
    ...d.vehicle,
    mass: field(p.mass, 'mass'), cgX: field(0), cgY: field(p.cgHeight), cgZ: field(round(cgZ, 0.1)), wheelbase: field(p.wheelbase),
    brakeBias: field(p.brakeBias * 100, 'percent'), driveSplit: field(p.driveSplit * 100, 'percent'),
    rollInertia: field(p.inertia[0], 'ratio'), pitchInertia: field(p.inertia[1], 'ratio'), yawInertia: field(p.inertia[2], 'ratio'),
  };
  const links = { frontPair: true, rearPair: true, rearFromFront: false };
  // Static loads from a first pass (they depend only on the contact points, which the springs don't move).
  // The default corner design (only the corner's own fields: spreading the whole design state into a corner
  // would carry its vehicle, links and corners along).
  const base = d.corners.FL;
  // Both axles' tires on one ground: the front's.
  const ground = groundOf(p.front);
  const first: CornerDesign = axleDesign(base, p.front, 1000, p.droop, p.bump, ground);
  const firstR: CornerDesign = axleDesign(base, p.rear, 1000, p.droop, p.bump, ground);
  const loads = vehicleStaticLoads(vehicle, { FL: first, FR: first, RL: firstR, RR: firstR }, links);
  const front = axleDesign(base, p.front, loads.FL, p.droop, p.bump, ground);
  const rear = axleDesign(base, p.rear, loads.RL, p.droop, p.bump, ground);
  const powered = (id: CornerId) => p.drive === 'all' || (p.drive === 'front') === id.startsWith('F');
  const settings = Object.fromEntries((['FL', 'FR', 'RL', 'RR'] as CornerId[]).map((id) => [id, {
    ...d.settings[id], steered: id.startsWith('F'), powered: powered(id),
    brake: p.brakes === 'rear' && id.startsWith('F') ? 'none' : p.rearDriveline && id.startsWith('R') ? 'driveline' : 'outboard', abs: p.abs, diff: p.diff,
  } satisfies CornerSettings])) as Record<CornerId, CornerSettings>;
  // The tire grip model's nominal load and pressure at this car's static tire load and set pressure (the
  // generic coefficients are relative to them; left at a light car's 1 kN, a heavy car's tires read as
  // having almost no grip).
  const meanLoad = (loads.FL + loads.FR + loads.RL + loads.RR) / 4;
  const tireGrip = { ...d.tireGrip, fz0: field(round(meanLoad, 10), 'force'), p0: field((p.front.tire.pressure + p.rear.tire.pressure) / 2, 'pressure') };
  const bar = (rate: number) => (rate > 0 ? { antiRollBar: 'wheelRate' as const, arbRate: field(rate, 'rate') } : { antiRollBar: 'none' as const });
  return {
    ...d,
    ...front,
    presetId: 'custom',
    steer: { ...d.steer, cFactor: field(p.rack[0]), rackLimit: field(p.rack[1]) },
    droop: p.droop, bump: p.bump,
    corners: { FL: front, FR: front, RL: rear, RR: rear },
    links, settings, vehicle, tireGrip,
    // The car's size is the profile's: track and wheelbase locked (the wheel centers' X and Z), shown as "car
    // profile" in the Locks tab and unlocked like any lock (round 4). Ride height stays free.
    ...((): Pick<DesignState, 'locks' | 'wizardLocks'> => {
      const keys = wizardKeys.size(['FL', 'RL']);
      return { locks: { ...d.locks, ...Object.fromEntries(keys.map((k) => [k, true])) }, wizardLocks: { ...d.wizardLocks, ...Object.fromEntries(keys.map((k) => [k, 'profile' as const])) } };
    })(),
    ...(p.aero ? { aero: { ...d.aero, on: true, file: null, CdA: field(p.aero.CdA, 'ratio'), downF: field(p.aero.downF, 'ratio'), downR: field(p.aero.downR, 'ratio') } } : {}),
    ...(p.hitchRating ? { tow: { ...d.tow, tongueLimit: field(p.hitchRating, 'mass') } } : {}),
    powertrain: {
      ...d.powertrain, kind: p.engine.electric ? 'electric' : 'gas',
      peakTorque: field(p.engine.torque, 'torque'), torqueRpm: field(p.engine.torqueRpm, 'ratio'), peakPower: field(p.engine.power, 'power'), powerRpm: field(p.engine.powerRpm, 'ratio'),
      maxRpm: field(p.engine.redline, 'ratio'), idleRpm: field(p.engine.idle, 'ratio'), clutchRpm: field(p.engine.clutch, 'ratio'),
      ratio: field(round(p.engine.ratio, 0.01), 'ratio'), efficiency: field(p.engine.efficiency, 'percent'),
    },
    shared: { front: { ...d.shared.front, ...bar(p.bars[0]) }, rear: { ...d.shared.rear, ...bar(p.bars[1]) } },
  };
}
