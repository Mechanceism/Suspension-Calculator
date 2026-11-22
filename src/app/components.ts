/**
 * Components of the corner and how they connect ("family"): used by the inspector, the browser and
 * click-selection in the viewport. 1st family = directly connected; 2nd family = connected through
 * one other component.
 */
import type { ComponentId, PointKey, ArmChoice } from './store';
import type { SuspensionKind } from '../core/suspension/doubleWishbone';

export interface ComponentDef {
  id: ComponentId;
  label: string;
  /** Hardpoints that belong to this component (editable in its inspector). */
  points: PointKey[];
  /** Components this one mounts to (toward the chassis). */
  parents: ComponentId[];
}

/**
 * Components per suspension type. A type without a component (MacPherson: no upper arm) keeps it with no
 * points (`absent`), so the records stay complete.
 */
export function componentDefs(damperArm: ArmChoice, kind: SuspensionKind = 'doubleWishbone', layout: 'coilover' | 'rocker' = 'coilover', pushrodOn: ArmChoice = 'lca', steer: 'rack' | 'arm' = 'rack'): Record<ComponentId, ComponentDef & { absent?: boolean }> {
  const defs = withSprings(damperArm, kind, layout, pushrodOn);
  if (steer !== 'arm') return defs;
  // Steering arm / plate: the "rack" part is the arm on its pivot axis.
  return { ...defs, rack: { id: 'rack', label: 'Steering arm / plate', points: ['strPiv1', 'strPiv2', 'trInner'], parents: ['chassis'] } };
}

function withSprings(damperArm: ArmChoice, kind: SuspensionKind, layout: 'coilover' | 'rocker', pushrodOn: ArmChoice): Record<ComponentId, ComponentDef & { absent?: boolean }> {
  const defs = kindDefs(damperArm, kind);
  if (layout !== 'rocker' || kind === 'macpherson' || kind === 'rigid') return defs;
  // Pushrod + rocker: the spring part holds the rocker, pushrod and spring; the pushrod's lower end belongs
  // to what it is on (not the coilover's old mount).
  const strip = (pts: PointKey[]) => pts.filter((k) => k !== 'dmpArm');
  const on: ComponentId = pushrodOn === 'upright' ? 'upright' : kind === 'multilink' ? 'upright' : pushrodOn;
  const out = Object.fromEntries(Object.entries(defs).map(([id, d]) => [id, { ...d, points: strip(d.points) }])) as typeof defs;
  out[on] = { ...out[on], points: [...out[on].points, 'prArm'] };
  out.chassis = { ...out.chassis, points: [...out.chassis.points, 'rkrPiv1', 'rkrPiv2'] };
  out.spring = { id: 'spring', label: 'Rocker, pushrod and spring', points: ['rkrPiv1', 'rkrPiv2', 'prRkr', 'prArm', 'dmpArm', 'dmpChassis'], parents: ['chassis', on] };
  return out;
}

function kindDefs(damperArm: ArmChoice, kind: SuspensionKind): Record<ComponentId, ComponentDef & { absent?: boolean }> {
  if (kind === 'macpherson') {
    return {
      chassis: { id: 'chassis', label: 'Chassis / frame', points: ['lcaFwd', 'lcaAft', 'dmpChassis'], parents: [] },
      uca: { id: 'uca', label: 'Upper arm (none: the strut)', points: [], parents: ['chassis'], absent: true },
      lca: { id: 'lca', label: 'Lower control arm', points: ['lcaFwd', 'lcaAft', 'lcaOut'], parents: ['chassis'] },
      rack: { id: 'rack', label: 'Steering rack', points: ['trInner'], parents: ['chassis'] },
      tieRod: { id: 'tieRod', label: 'Tie rod', points: ['trInner', 'trOuter'], parents: ['rack'] },
      upright: { id: 'upright', label: 'Upright / knuckle (with the strut tube)', points: ['lcaOut', 'dmpArm', 'trOuter', 'wheelCenter'], parents: ['lca', 'spring', 'tieRod'] },
      wheel: { id: 'wheel', label: 'Wheel & tire', points: ['wheelCenter'], parents: ['upright'] },
      spring: { id: 'spring', label: 'Strut (spring / damper, top mount)', points: ['dmpChassis', 'dmpArm'], parents: ['chassis'] },
    };
  }
  if (kind === 'singleArm') {
    return {
      chassis: { id: 'chassis', label: 'Chassis / frame', points: ['lcaFwd', 'lcaAft', 'dmpChassis'], parents: [] },
      uca: { id: 'uca', label: 'Upper arm (none)', points: [], parents: ['chassis'], absent: true },
      lca: { id: 'lca', label: 'Arm (carries the kingpin)', points: ['lcaFwd', 'lcaAft', 'lcaOut', 'ucaOut', ...(damperArm !== 'upright' ? ['dmpArm' as const] : [])], parents: ['chassis'] },
      rack: { id: 'rack', label: 'Steering rack', points: ['trInner'], parents: ['chassis'] },
      tieRod: { id: 'tieRod', label: 'Tie rod / toe link', points: ['trInner', 'trOuter'], parents: ['rack'] },
      upright: { id: 'upright', label: 'Knuckle (on the kingpin)', points: ['ucaOut', 'lcaOut', 'trOuter', 'wheelCenter', ...(damperArm === 'upright' ? ['dmpArm' as const] : [])], parents: ['lca', 'tieRod'] },
      wheel: { id: 'wheel', label: 'Wheel & tire', points: ['wheelCenter'], parents: ['upright'] },
      spring: { id: 'spring', label: 'Coilover (spring/damper)', points: ['dmpChassis', 'dmpArm'], parents: ['chassis', damperArm === 'upright' ? 'upright' : 'lca'] },
    };
  }
  if (kind === 'rigid') {
    return {
      chassis: { id: 'chassis', label: 'Chassis / frame (kingpin mounts)', points: ['ucaOut', 'lcaOut'], parents: [] },
      uca: { id: 'uca', label: 'Upper arm (none)', points: [], parents: ['chassis'], absent: true },
      lca: { id: 'lca', label: 'Lower arm (none)', points: [], parents: ['chassis'], absent: true },
      rack: { id: 'rack', label: 'Steering rack', points: ['trInner'], parents: ['chassis'] },
      tieRod: { id: 'tieRod', label: 'Tie rod', points: ['trInner', 'trOuter'], parents: ['rack'] },
      upright: { id: 'upright', label: 'Spindle / knuckle (on the kingpin)', points: ['ucaOut', 'lcaOut', 'trOuter', 'wheelCenter'], parents: ['chassis', 'tieRod'] },
      wheel: { id: 'wheel', label: 'Wheel & tire', points: ['wheelCenter'], parents: ['upright'] },
      spring: { id: 'spring', label: 'Spring (none)', points: [], parents: ['chassis'], absent: true },
    };
  }
  if (kind === 'multilink') {
    return {
      chassis: { id: 'chassis', label: 'Chassis / frame', points: ['ucaFwd', 'ucaAft', 'lcaFwd', 'lcaAft', 'dmpChassis'], parents: [] },
      uca: { id: 'uca', label: 'Upper links (front, rear)', points: ['ucaFwd', 'ucaOut', 'ucaAft', 'ucaOut2'], parents: ['chassis'] },
      lca: { id: 'lca', label: 'Lower links (front, rear)', points: ['lcaFwd', 'lcaOut', 'lcaAft', 'lcaOut2'], parents: ['chassis'] },
      rack: { id: 'rack', label: 'Steering rack / toe-link mount', points: ['trInner'], parents: ['chassis'] },
      tieRod: { id: 'tieRod', label: 'Tie rod / toe link', points: ['trInner', 'trOuter'], parents: ['rack'] },
      upright: { id: 'upright', label: 'Upright / knuckle', points: ['ucaOut', 'ucaOut2', 'lcaOut', 'lcaOut2', 'trOuter', 'wheelCenter', 'dmpArm'], parents: ['uca', 'lca', 'tieRod'] },
      wheel: { id: 'wheel', label: 'Wheel & tire', points: ['wheelCenter'], parents: ['upright'] },
      spring: { id: 'spring', label: 'Coilover (spring/damper)', points: ['dmpChassis', 'dmpArm'], parents: ['chassis', 'upright'] },
    };
  }
  return {
    chassis: { id: 'chassis', label: 'Chassis / frame', points: ['ucaFwd', 'ucaAft', 'lcaFwd', 'lcaAft', 'dmpChassis'], parents: [] },
    // The coilover's lower mount is fixed to whichever arm carries it, so it belongs to that arm too.
    uca: { id: 'uca', label: 'Upper control arm', points: ['ucaFwd', 'ucaAft', 'ucaOut', ...(damperArm === 'uca' ? ['dmpArm' as const] : [])], parents: ['chassis'] },
    lca: { id: 'lca', label: 'Lower control arm', points: ['lcaFwd', 'lcaAft', 'lcaOut', ...(damperArm === 'lca' ? ['dmpArm' as const] : [])], parents: ['chassis'] },
    rack: { id: 'rack', label: 'Steering rack', points: ['trInner'], parents: ['chassis'] },
    tieRod: { id: 'tieRod', label: 'Tie rod', points: ['trInner', 'trOuter'], parents: ['rack'] },
    upright: { id: 'upright', label: 'Upright / knuckle', points: ['ucaOut', 'lcaOut', 'trOuter', 'wheelCenter', ...(damperArm === 'upright' ? ['dmpArm' as const] : [])], parents: ['uca', 'lca', 'tieRod'] },
    wheel: { id: 'wheel', label: 'Wheel & tire', points: ['wheelCenter'], parents: ['upright'] },
    spring: { id: 'spring', label: 'Coilover (spring/damper)', points: ['dmpChassis', 'dmpArm'], parents: ['chassis', damperArm] },
  };
}

export function family(id: ComponentId, defs: Record<ComponentId, ComponentDef>): { first: ComponentId[]; second: ComponentId[] } {
  const all = Object.values(defs);
  const neighbours = (c: ComponentId) => {
    const parents = defs[c].parents;
    const children = all.filter((d) => d.parents.includes(c)).map((d) => d.id);
    return [...new Set([...parents, ...children])];
  };
  const first = neighbours(id);
  const second = [...new Set(first.flatMap(neighbours))].filter((c) => c !== id && !first.includes(c));
  return { first, second };
}

/** Components a hardpoint belongs to. */
export function ownersOf(point: PointKey, defs: Record<ComponentId, ComponentDef>): ComponentId[] {
  return Object.values(defs).filter((d) => d.points.includes(point)).map((d) => d.id);
}

export const POINT_LABELS: Record<PointKey, string> = {
  ucaFwd: 'UCA front pivot', ucaAft: 'UCA rear pivot', ucaOut: 'Upper ball joint',
  lcaFwd: 'LCA front pivot', lcaAft: 'LCA rear pivot', lcaOut: 'Lower ball joint',
  trInner: 'Tie rod inner (rack)', trOuter: 'Tie rod outer', wheelCenter: 'Hub center (wheel mounting face)',
  dmpChassis: 'Coilover chassis mount', dmpArm: 'Coilover arm mount',
  ucaOut2: 'Upper rear link, upright end', lcaOut2: 'Lower rear link, upright end',
  rkrPiv1: 'Rocker pivot (front)', rkrPiv2: 'Rocker pivot (rear)', prArm: 'Pushrod lower end', prRkr: 'Pushrod end on the rocker',
  strPiv1: 'Steering arm pivot axis (bottom)', strPiv2: 'Steering arm pivot axis (top)',
};

const KIND_LABELS: Partial<Record<SuspensionKind, Partial<Record<PointKey, string>>>> = {
  macpherson: { dmpChassis: 'Strut top mount', dmpArm: 'Strut lower point (on the upright)' },
  rigid: { ucaOut: 'Kingpin top', lcaOut: 'Kingpin bottom' },
  singleArm: { lcaFwd: 'Arm front pivot (frame)', lcaAft: 'Arm rear pivot (frame)', lcaOut: 'Kingpin bottom (on the arm)', ucaOut: 'Kingpin top (on the arm)', dmpArm: 'Coilover lower mount' },
  multilink: {
    ucaFwd: 'Upper front link, chassis', ucaOut: 'Upper front link, upright end', ucaAft: 'Upper rear link, chassis',
    lcaFwd: 'Lower front link, chassis', lcaOut: 'Lower front link, upright end', lcaAft: 'Lower rear link, chassis',
    trInner: 'Toe link / tie rod inner', trOuter: 'Toe link / tie rod outer', dmpArm: 'Coilover upright mount',
  },
};

/** A hardpoint's label for a suspension type (and spring layout). */
export const pointLabel = (k: PointKey, kind: SuspensionKind = 'doubleWishbone', layout: 'coilover' | 'rocker' = 'coilover') =>
  (layout === 'rocker' && k === 'dmpArm' ? 'Spring end on the rocker' : layout === 'rocker' && k === 'dmpChassis' ? 'Spring frame mount' : KIND_LABELS[kind]?.[k] ?? POINT_LABELS[k]);
