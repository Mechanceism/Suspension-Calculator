/**
 * Held dimensions in the app: conversion to the core spec, which pairs can be held permanently, and
 * the enforcer that keeps them after every edit (like dimensions in a CAD sketch).
 *
 * After an edit, the coordinates you just changed stay put (and locked ones too); the other points
 * in held dimensions move as little as possible so every held dimension is met. While dragging,
 * this waits until the drag ends.
 */
import { resolveDimensions, type DimensionSpec, type DimMeasure } from '../core/suspension/dimensions';
import type { HardpointId } from '../core/optimize/corner';
import { useApp, rootOf, toGeometry, POINT_KEYS, type HeldDimension, type PointKey, type EditableGeometry, type Field } from './store';
import { STATE_KEY } from './anchors';
import { pointAxisLocked } from './locks';
import { componentDefs, POINT_LABELS } from './components';
import type { SuspensionKind } from '../core/suspension/doubleWishbone';

export const toSpec = (d: HeldDimension): DimensionSpec => ({
  a: STATE_KEY[d.a] as HardpointId, b: STATE_KEY[d.b] as HardpointId, measure: d.measure, value: d.value, travel: d.travel,
});

export const MEASURE_LABELS: Record<DimMeasure, string> = {
  distance: 'distance', dx: 'ΔX', dy: 'ΔY', dz: 'ΔZ', front: 'front-view angle', side: 'side-view angle', top: 'top-view angle', slope: 'slope',
};

export const dimensionLabel = (d: Pick<HeldDimension, 'a' | 'b' | 'measure'>) => `${POINT_LABELS[d.a]} → ${POINT_LABELS[d.b]} ${MEASURE_LABELS[d.measure]}`;
export const holdLabel = (travel: number | null) => (travel === null ? 'permanent' : travel === 0 ? 'at ride height' : `at ${travel} mm travel`);

/** Rigid parts (points that keep their distances through travel). The chassis never moves in the corner frame. */
function rigidGroups(damperArm: 'lca' | 'uca', kind: SuspensionKind = 'doubleWishbone'): { chassis: PointKey[]; moving: PointKey[][] } {
  const d = componentDefs(damperArm, kind);
  return {
    chassis: ['ucaFwd', 'ucaAft', 'lcaFwd', 'lcaAft', 'dmpChassis'],
    moving: [d.uca.points, d.lca.points, d.upright.points, d.tieRod.points],
  };
}

/**
 * Can this dimension be held permanently (true at every travel)? Any measure between two chassis
 * points; a distance between two points of the same moving part. Everything else changes with travel.
 */
export function permanentAllowed(a: PointKey, b: PointKey, measure: DimMeasure, damperArm: 'lca' | 'uca', kind: SuspensionKind = 'doubleWishbone'): { ok: boolean; why: string } {
  const g = rigidGroups(damperArm, kind);
  if (g.chassis.includes(a) && g.chassis.includes(b)) return { ok: true, why: 'Both points are on the chassis, which does not move' };
  const part = g.moving.find((p) => p.includes(a) && p.includes(b));
  if (part && measure === 'distance') return { ok: true, why: 'Both points are on the same rigid part, so their distance never changes' };
  if (part) return { ok: false, why: 'Only the distance stays constant on a moving part; angles and ΔX/ΔY/ΔZ change with travel' };
  return { ok: false, why: 'These points are on different moving parts, so this changes with travel: hold it at a travel position instead' };
}

const fieldOf = (v: number): Field => ({ text: String(Number(v.toFixed(4))), value: v });

/** Resolve the active design's held dimensions against `geom`, keeping `isFixed` coordinates. */
export function resolveActive(geom: EditableGeometry, dims: HeldDimension[], isFixed: (k: PointKey, axis: 0 | 1 | 2) => boolean) {
  const keyOf = Object.fromEntries(POINT_KEYS.map((k) => [STATE_KEY[k], k])) as Record<HardpointId, PointKey>;
  const r = resolveDimensions(toGeometry(geom), dims.map(toSpec), (p, axis) => isFixed(keyOf[p], axis));
  let next = geom;
  if (r.moved.length) {
    const points = { ...geom.points };
    for (const m of r.moved) {
      const k = keyOf[m.point];
      const t = [...points[k]] as [Field, Field, Field];
      t[m.axis] = fieldOf(m.value);
      points[k] = t;
    }
    next = { ...geom, points };
  }
  return { geom: next, moved: r.moved.length > 0, violated: r.violated.map((i) => dims[i]!.id) };
}

let started = false;
let baseline: EditableGeometry | null = null;
let baseKey = '';
let resolving = false;

/** Watch the store and keep held dimensions after every edit. */
export function initHeldDimensions(): void {
  if (started) return;
  started = true;
  const keyOf = (s: ReturnType<typeof useApp.getState>) => `${s.activeCorner}|${JSON.stringify(s.links)}`;
  baseline = useApp.getState().geom;
  baseKey = keyOf(useApp.getState());
  useApp.subscribe((s, prev) => {
    if (resolving || s.interacting) return;
    const dragEnded = prev.interacting && !s.interacting;
    if (!dragEnded && s.geom === prev.geom && s.dimensions === prev.dimensions && s.locks === prev.locks) return;
    // A different design came into the working fields (corner switch, links): just take it as the baseline.
    if (keyOf(s) !== baseKey) { baseKey = keyOf(s); baseline = s.geom; return; }
    const root = rootOf(s.activeCorner, s.links);
    const dims = s.dimensions.filter((d) => d.root === root);
    if (!dims.length) { baseline = s.geom; if (s.dimViolations.length) useApp.setState({ dimViolations: [] }); return; }
    const base = baseline ?? s.geom;
    const changed = (k: PointKey, axis: 0 | 1 | 2) => base.points[k][axis].value !== s.geom.points[k][axis].value;
    const isFixed = (k: PointKey, axis: 0 | 1 | 2) => changed(k, axis) || pointAxisLocked(s.locks, root, k, axis, s.geom.damperArm, s.geom.kind);
    const r = resolveActive(s.geom, dims, isFixed);
    resolving = true;
    try {
      const prevViolations = s.dimViolations;
      useApp.setState({ ...(r.moved ? { geom: r.geom, presetId: 'custom' } : {}), dimViolations: r.violated });
      const fresh = r.violated.filter((id) => !prevViolations.includes(id));
      if (fresh.length) {
        const names = dims.filter((d) => fresh.includes(d.id)).map(dimensionLabel).join('; ');
        s.notify(`Couldn't keep the held dimension: ${names}. The points it needs are locked or the edit conflicts with it.`, 'warn');
      }
    } finally { resolving = false; }
    baseline = useApp.getState().geom;
  });
}
