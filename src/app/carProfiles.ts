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
import {
  SAMPLE_LAYOUTS, SAMPLE_MACPHERSON, SAMPLE_MULTILINK, SAMPLE_BEAM4,
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
  },
  {
    id: 'fsae', label: 'FSAE car',
    hint: 'Double wishbones all round, 10 in wheels (18 × 7.5-10), 300 kg with the driver, 1550 mm wheelbase, rear-wheel drive through a limited-slip differential.',
    front: { layout: SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry, halfTrack: 610, tire: FSAE_TIRE, unsprung: 12, rideHz: 3.0, zeta: 0.6, camber: -1.5 },
    rear: { layout: SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry, halfTrack: 590, tire: FSAE_TIRE, unsprung: 13, rideHz: 3.2, zeta: 0.6, camber: -1 },
    mass: 300, cgHeight: 280, frontShare: 0.47, wheelbase: 1550, brakeBias: 0.62, driveSplit: 0, drive: 'rear', brakes: 'all', abs: false, diff: 'lsd',
    inertia: [35, 100, 140], droop: 30, bump: 30, rack: [75, 30], bars: [15, 10],
  },
  {
    id: 'kart', label: 'Kart',
    hint: 'No real suspension: very stiff springs stand in for the frame flex. A solid rear axle with no differential, rear brake only, 5 in wheels, 165 kg with the driver.',
    front: { layout: SAMPLE_LAYOUTS.find((l) => l.id === 'C')!.geometry, halfTrack: 540, tire: { diameter: 254, width: 114, rim: 127, text: '10x4.50-5', pressure: 75 }, unsprung: 3, rideHz: 9, zeta: 0.2, camber: -1 },
    rear: { layout: SAMPLE_BEAM4, halfTrack: 600, tire: { diameter: 279, width: 180, rim: 127, text: '11x7.10-5', pressure: 75 }, unsprung: 6, rideHz: 9, zeta: 0.2, camber: 0 },
    mass: 165, cgHeight: 260, frontShare: 0.42, wheelbase: 1040, brakeBias: 0, driveSplit: 0, drive: 'rear', brakes: 'rear', abs: false, diff: 'locked',
    inertia: [8, 14, 18], droop: 10, bump: 10, rack: [60, 25], bars: [0, 0],
  },
  {
    id: 'trophy', label: 'Trophy truck (long travel)',
    hint: 'Long-travel double wishbones in front, a 4-link solid rear axle, 40 in tires, 2700 kg, soft springs and lots of travel; rear-wheel drive with a locked rear.',
    front: { layout: SAMPLE_LAYOUTS.find((l) => l.id === 'A')!.geometry, halfTrack: 1100, tire: { diameter: 1016, width: 343, rim: 431.8, text: '40x13.50R17', pressure: 140 }, unsprung: 140, rideHz: 1.0, zeta: 0.35, camber: 0 },
    rear: { layout: SAMPLE_BEAM4, halfTrack: 1080, tire: { diameter: 1016, width: 343, rim: 431.8, text: '40x13.50R17', pressure: 140 }, unsprung: 200, rideHz: 1.1, zeta: 0.35, camber: 0 },
    mass: 2700, cgHeight: 800, frontShare: 0.5, wheelbase: 3050, brakeBias: 0.6, driveSplit: 0, drive: 'rear', brakes: 'all', abs: false, diff: 'locked',
    inertia: [1500, 5500, 6000], droop: 200, bump: 250, rack: [60, 70], bars: [25, 0],
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
function axleDesign(base: CornerDesign, a: AxleSpec, cornerLoad: number, droop: number, bump: number): CornerDesign {
  const baseG = a.layout;
  const s = a.tire.diameter / 2 / baseG.wheel.radius;
  const sx = a.halfTrack / baseG.wheel.center.x;
  const g = scaleGeometry(baseG, sx, s);
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
  const first: CornerDesign = axleDesign(base, p.front, 1000, p.droop, p.bump);
  const firstR: CornerDesign = axleDesign(base, p.rear, 1000, p.droop, p.bump);
  const loads = vehicleStaticLoads(vehicle, { FL: first, FR: first, RL: firstR, RR: firstR }, links);
  const front = axleDesign(base, p.front, loads.FL, p.droop, p.bump);
  const rear = axleDesign(base, p.rear, loads.RL, p.droop, p.bump);
  const powered = (id: CornerId) => p.drive === 'all' || (p.drive === 'front') === id.startsWith('F');
  const settings = Object.fromEntries((['FL', 'FR', 'RL', 'RR'] as CornerId[]).map((id) => [id, {
    ...d.settings[id], steered: id.startsWith('F'), powered: powered(id),
    brake: p.brakes === 'rear' && id.startsWith('F') ? 'none' : 'outboard', abs: p.abs, diff: p.diff,
  } satisfies CornerSettings])) as Record<CornerId, CornerSettings>;
  const bar = (rate: number) => (rate > 0 ? { antiRollBar: 'wheelRate' as const, arbRate: field(rate, 'rate') } : { antiRollBar: 'none' as const });
  return {
    ...d,
    ...front,
    presetId: 'custom',
    steer: { ...d.steer, cFactor: field(p.rack[0]), rackLimit: field(p.rack[1]) },
    droop: p.droop, bump: p.bump,
    corners: { FL: front, FR: front, RL: rear, RR: rear },
    links, settings, vehicle,
    shared: { front: { ...d.shared.front, ...bar(p.bars[0]) }, rear: { ...d.shared.rear, ...bar(p.bars[1]) } },
  };
}
