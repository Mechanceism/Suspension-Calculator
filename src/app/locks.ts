/**
 * Locks: values the user has fixed, so the (future) optimizer must work around them.
 *
 * A lock is a key string. Corner keys start with the corner whose design they belong to (linked
 * corners share a design, so they share its locks):
 *   FL.point.ucaFwd.x      one coordinate of a hardpoint
 *   FL.part.uca            a whole part (all of its points)
 *   FL.derived.uca.length  a derived dimension (arm length, pivot-axis angles)
 *   FL.spring.springRate   FL.damper.minLength   FL.tire.pressure   FL.scalar.staticCamber
 * Vehicle keys:  vehicle.mass   shared.front.arbRate   steer.cFactor
 *
 * Locked values can still be typed by hand; dragging / nudging a locked coordinate is blocked.
 */
import type { CornerId } from '../core/vehicle/vehicle';
import { CORNER_IDS } from '../core/vehicle/vehicle';
import {
  POINT_NAMES, SCALAR_META, SPRING_META, DAMPER_META, TIRE_META, VEHICLE_META, SHARED_META, STEER_META, CORNER_NAMES,
  forCorner, rootOf,
  type PointKey, type ComponentId, type CornerLinks, type Selection,
activePointKeys, type ArmChoice, type SpringLayout, } from './store';
import { componentDefs, ownersOf, POINT_LABELS } from './components';
import type { SuspensionKind } from '../core/suspension/doubleWishbone';

export type Locks = Record<string, true>;
const AXES = ['x', 'y', 'z'] as const;

export const lockKeys = {
  point: (root: CornerId, k: PointKey, axis: 0 | 1 | 2) => `${root}.point.${k}.${AXES[axis]}`,
  part: (root: CornerId, c: ComponentId) => `${root}.part.${c}`,
  derived: (root: CornerId, arm: 'uca' | 'lca', which: string) => `${root}.derived.${arm}.${which}`,
  field: (root: CornerId, group: 'spring' | 'damper' | 'tire' | 'scalar', key: string) => `${root}.${group}.${key}`,
};

/**
 * Is this coordinate locked, directly or because a part it belongs to is locked? A point the corner's
 * suspension type doesn't use counts as locked (nothing may free it).
 */
export function pointAxisLocked(locks: Locks, root: CornerId, k: PointKey, axis: 0 | 1 | 2, damperArm: ArmChoice, kind: SuspensionKind = 'doubleWishbone', layout: SpringLayout = 'coilover', steer: 'rack' | 'arm' = 'rack'): boolean {
  if (!activePointKeys(kind, layout, steer).includes(k)) return true;
  if (locks[lockKeys.point(root, k, axis)]) return true;
  return ownersOf(k, componentDefs(damperArm, kind, layout, 'lca', steer)).some((c) => locks[lockKeys.part(root, c)]);
}

export const pointLocked = (locks: Locks, root: CornerId, k: PointKey, damperArm: ArmChoice, kind: SuspensionKind = 'doubleWishbone', layout: SpringLayout = 'coilover', steer: 'rack' | 'arm' = 'rack') =>
  ([0, 1, 2] as const).every((a) => pointAxisLocked(locks, root, k, a, damperArm, kind, layout, steer));

export const anyAxisLocked = (locks: Locks, root: CornerId, k: PointKey, damperArm: ArmChoice, kind: SuspensionKind = 'doubleWishbone', layout: SpringLayout = 'coilover', steer: 'rack' | 'arm' = 'rack') =>
  ([0, 1, 2] as const).some((a) => pointAxisLocked(locks, root, k, a, damperArm, kind, layout, steer));

const DERIVED_LABELS: Record<string, string> = { length: 'length', inclination: 'pivot-axis inclination', planAngle: 'pivot-axis plan angle', frontViewAngle: 'front-view angle' };
const PART_LABELS: Record<ComponentId, string> = {
  chassis: 'Chassis / frame (all mounts)', uca: 'Upper control arm (whole part)', lca: 'Lower control arm (whole part)',
  upright: 'Upright (whole part)', tieRod: 'Tie rod (whole part)', rack: 'Steering rack mount', spring: 'Coilover mounts', wheel: 'Wheel center',
};

export interface LockInfo {
  key: string;
  /** Group heading, e.g. "FL (shared with FR, RL, RR)" or "Vehicle". */
  group: string;
  label: string;
  /** Where to go: workspace, corner and selection, plus the inspector row to flash. */
  target: { workspace: 'corner' | 'vehicle'; corner?: CornerId; selection?: Selection };
}

/** Human-readable description and navigation target of a lock key. */
export function describeLock(key: string, links: CornerLinks): LockInfo {
  const parts = key.split('.');
  const head = parts[0]!;
  if ((CORNER_IDS as string[]).includes(head)) {
    const root = head as CornerId;
    const sharers = CORNER_IDS.filter((id) => rootOf(id, links) === root);
    const corner = sharers[0] ?? root;
    const group = sharers.length > 1 ? `${root} (shared with ${sharers.filter((s) => s !== root).join(', ')})` : `${CORNER_NAMES[root]} (${root})`;
    const kind = parts[1];
    if (kind === 'point') {
      const k = parts[2] as PointKey;
      return {
        key, group, label: `${POINT_LABELS[k]} ${parts[3]!.toUpperCase()} · ${forCorner(root, POINT_NAMES[k])}`,
        target: { workspace: 'corner', corner, selection: { kind: 'point', id: k } },
      };
    }
    if (kind === 'part') {
      const c = parts[2] as ComponentId;
      return { key, group, label: PART_LABELS[c] ?? c, target: { workspace: 'corner', corner, selection: { kind: 'component', id: c } } };
    }
    if (kind === 'derived') {
      const arm = parts[2] as 'uca' | 'lca';
      return {
        key, group, label: `${arm.toUpperCase()} ${DERIVED_LABELS[parts[3]!] ?? parts[3]}`,
        target: { workspace: 'corner', corner, selection: { kind: 'component', id: arm } },
      };
    }
    const k = parts[2]!;
    const meta = kind === 'spring' ? SPRING_META[k as keyof typeof SPRING_META]
      : kind === 'damper' ? DAMPER_META[k as keyof typeof DAMPER_META]
        : kind === 'tire' ? TIRE_META[k as keyof typeof TIRE_META]
          : SCALAR_META[k as keyof typeof SCALAR_META];
    const label = meta ? ('label' in meta ? meta.label : k) : k;
    const comp: ComponentId = kind === 'spring' && k !== 'unsprungMass' && k !== 'cornerLoad' ? 'spring'
      : kind === 'damper' ? 'spring'
        : kind === 'spring' ? 'chassis'
          : 'wheel';
    return { key, group, label, target: { workspace: 'corner', corner, selection: { kind: 'component', id: comp } } };
  }
  if (head === 'vehicle') {
    const k = parts[1] as keyof typeof VEHICLE_META;
    return { key, group: 'Vehicle', label: VEHICLE_META[k]?.label ?? k, target: { workspace: 'vehicle' } };
  }
  if (head === 'shared') {
    const axleName = parts[1] === 'front' ? 'Front' : 'Rear';
    if (parts[2] === 'dropLink') return { key, group: 'Vehicle', label: `${axleName} anti-roll bar drop-link mount ${parts[3]!.toUpperCase()}`, target: { workspace: 'vehicle' } };
    const k = parts[2] as keyof typeof SHARED_META;
    return { key, group: 'Vehicle', label: `${parts[1] === 'front' ? 'Front' : 'Rear'} ${SHARED_META[k]?.label.toLowerCase() ?? k}`, target: { workspace: 'vehicle' } };
  }
  if (head === 'steer') {
    const k = parts[1] as keyof typeof STEER_META;
    const comp: ComponentId = k === 'cFactor' || k === 'rackLimit' ? 'rack' : 'wheel';
    return { key, group: 'Steering & tire forces', label: STEER_META[k]?.label ?? k, target: { workspace: 'corner', selection: { kind: 'component', id: comp } } };
  }
  return { key, group: 'Other', label: key, target: { workspace: 'corner' } };
}

/** Scroll an inspector row for this lock into view and flash it (after the view has switched). */
export function flashLockRow(key: string): void {
  const tryFlash = (n: number) => {
    const el = document.querySelector(`[data-lock-key="${CSS.escape(key)}"]`) as HTMLElement | null;
    if (!el) { if (n > 0) setTimeout(() => tryFlash(n - 1), 120); return; }
    for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  };
  setTimeout(() => tryFlash(12), 80);
}

/** Copy one corner's locks to another (when a corner is unlinked it starts with the same locks). */
export function copyCornerLocks(locks: Locks, from: CornerId, to: CornerId): Locks {
  const out = { ...locks };
  for (const k of Object.keys(locks)) if (k.startsWith(`${from}.`)) out[`${to}${k.slice(from.length)}`] = true;
  return out;
}
