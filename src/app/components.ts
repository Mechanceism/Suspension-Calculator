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
export function componentDefs(damperArm: ArmChoice, kind: SuspensionKind = 'doubleWishbone'): Record<ComponentId, ComponentDef & { absent?: boolean }> {
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
    upright: { id: 'upright', label: 'Upright / knuckle', points: ['ucaOut', 'lcaOut', 'trOuter', 'wheelCenter'], parents: ['uca', 'lca', 'tieRod'] },
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
};

const KIND_LABELS: Partial<Record<SuspensionKind, Partial<Record<PointKey, string>>>> = {
  macpherson: { dmpChassis: 'Strut top mount', dmpArm: 'Strut lower point (on the upright)' },
  multilink: {
    ucaFwd: 'Upper front link, chassis', ucaOut: 'Upper front link, upright end', ucaAft: 'Upper rear link, chassis',
    lcaFwd: 'Lower front link, chassis', lcaOut: 'Lower front link, upright end', lcaAft: 'Lower rear link, chassis',
    trInner: 'Toe link / tie rod inner', trOuter: 'Toe link / tie rod outer', dmpArm: 'Coilover upright mount',
  },
};

/** A hardpoint's label for a suspension type. */
export const pointLabel = (k: PointKey, kind: SuspensionKind = 'doubleWishbone') => KIND_LABELS[kind]?.[k] ?? POINT_LABELS[k];
