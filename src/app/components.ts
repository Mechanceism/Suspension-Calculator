/**
 * Components of the corner and how they connect ("family"): used by the inspector, the browser and
 * click-selection in the viewport. 1st family = directly connected; 2nd family = connected through
 * one other component.
 */
import type { ComponentId, PointKey, ArmChoice } from './store';

export interface ComponentDef {
  id: ComponentId;
  label: string;
  /** Hardpoints that belong to this component (editable in its inspector). */
  points: PointKey[];
  /** Components this one mounts to (toward the chassis). */
  parents: ComponentId[];
}

export function componentDefs(damperArm: ArmChoice): Record<ComponentId, ComponentDef> {
  return {
    chassis: { id: 'chassis', label: 'Chassis / frame', points: ['ucaFwd', 'ucaAft', 'lcaFwd', 'lcaAft', 'dmpChassis'], parents: [] },
    uca: { id: 'uca', label: 'Upper control arm', points: ['ucaFwd', 'ucaAft', 'ucaOut'], parents: ['chassis'] },
    lca: { id: 'lca', label: 'Lower control arm', points: ['lcaFwd', 'lcaAft', 'lcaOut'], parents: ['chassis'] },
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
  trInner: 'Tie rod inner (rack)', trOuter: 'Tie rod outer', wheelCenter: 'Wheel center',
  dmpChassis: 'Coilover chassis mount', dmpArm: 'Coilover arm mount',
};
