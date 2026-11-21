/**
 * Every locked value in one list, so the user can see where they are constraining the (future)
 * optimizer. Clicking an item goes to it: switches workspace / corner, selects the part or joint
 * (highlighting it in the viewport), opens the inspector and flashes the row that holds the setting.
 */
import {
  useApp, mergedCorners, toGeometry, VEHICLE_META, STEER_META, SHARED_META, SPRING_META, DAMPER_META, TIRE_META, SCALAR_META,
  type DesignState, type PointKey,
} from '../store';
import { describeLock, flashLockRow, type LockInfo } from '../locks';
import { armMetrics } from '../../core/suspension/armGeometry';
import { deg } from '../../core/suspension/characteristics';
import { switchWorkspace } from '../viewport/SafeHtml';
import type { CornerId } from '../../core/vehicle/vehicle';
import { fmt } from './FieldRows';

const AXIS = { x: 0, y: 1, z: 2 } as const;

/** The current value of a locked item, as text (typed text kept). */
export function lockValue(s: DesignState, key: string): string {
  const p = key.split('.');
  const show = (f?: { text: string; value: number }, unit = '') => {
    if (!f) return '';
    const t = f.text || fmt(f.value, 2);
    return unit && !/[a-z°%"']/i.test(t) ? `${t} ${unit}` : t;
  };
  if (p[0] === 'vehicle') return show(s.vehicle[p[1] as keyof typeof s.vehicle], VEHICLE_META[p[1] as keyof typeof VEHICLE_META]?.unit);
  if (p[0] === 'steer') return show(s.steer[p[1] as keyof typeof s.steer], STEER_META[p[1] as keyof typeof STEER_META]?.unit);
  if (p[0] === 'shared') {
    const sh = s.shared[p[1] as 'front' | 'rear'];
    if (p[2] === 'dropLink') return show(sh.dropLink[AXIS[p[3] as 'x']], 'mm');
    return show(sh[p[2] as 'arbRate'] as { text: string; value: number } | undefined, SHARED_META[p[2] as keyof typeof SHARED_META]?.unit);
  }
  const d = mergedCorners(s)[p[0] as CornerId];
  if (!d) return '';
  switch (p[1]) {
    case 'point': return show(d.geom.points[p[2] as PointKey]?.[AXIS[p[3] as 'x']], 'mm');
    case 'part': return '';
    case 'derived': {
      const m = armMetrics(toGeometry(d.geom)[p[2] as 'uca' | 'lca']);
      return p[3] === 'length' ? `${fmt(m.length, 1)} mm` : `${fmt(deg(p[3] === 'inclination' ? m.inclination : m.planAngle), 2)}°`;
    }
    case 'spring': return show(d.spring[p[2] as keyof typeof d.spring], SPRING_META[p[2] as keyof typeof SPRING_META]?.unit);
    case 'damper': return show(d.damper[p[2] as keyof typeof d.damper], DAMPER_META[p[2] as keyof typeof DAMPER_META]?.unit);
    case 'tire': return show(d.tire[p[2] as keyof typeof d.tire], TIRE_META[p[2] as keyof typeof TIRE_META]?.unit);
    case 'scalar': {
      const m = SCALAR_META[p[2] as keyof typeof SCALAR_META];
      return show(d.geom.scalars[p[2] as keyof typeof d.geom.scalars], m?.quantity === 'angle' ? '°' : 'mm');
    }
    default: return '';
  }
}

/** Go to a lock: workspace, corner, selection, inspector tab, then flash its row. */
export function goToLock(info: LockInfo): void {
  const s = useApp.getState();
  const t = info.target;
  const finish = () => {
    const now = useApp.getState();
    if (t.corner && t.corner !== now.activeCorner) now.setActiveCorner(t.corner);
    if (t.selection) useApp.getState().select(t.selection);
    else if (t.workspace === 'corner') useApp.getState().set('leftTab', 'inspector');
    flashLockRow(info.key);
  };
  if (s.workspace === t.workspace) { finish(); return; }
  // Switch first and select once the new view (and its 3D labels) has mounted.
  switchWorkspace(t.workspace);
  const wait = (n: number) => {
    const now = useApp.getState();
    if ((now.workspace === t.workspace && !now.suspendHtml) || n <= 0) finish();
    else requestAnimationFrame(() => wait(n - 1));
  };
  requestAnimationFrame(() => wait(60));
}

export function LocksPanel({ compact = false }: { compact?: boolean }) {
  const locks = useApp((s) => s.locks);
  const links = useApp((s) => s.links);
  const setLocks = useApp((s) => s.setLocks);
  const clearLocks = useApp((s) => s.clearLocks);
  const state = useApp((s) => s);
  const items = Object.keys(locks).sort().map((k) => describeLock(k, links));
  const groups = new Map<string, LockInfo[]>();
  for (const it of items) groups.set(it.group, [...(groups.get(it.group) ?? []), it]);

  return (
    <div className="locks-panel">
      {!compact && (
        <p className="hint">
          Locked values are fixed for the optimizer: it has to work around them. Lock anything you have already
          built or bought with the 🔓 buttons next to values, joints and parts. Click an item to find it.
        </p>
      )}
      {items.length === 0 && <p className="muted">Nothing is locked yet.</p>}
      {[...groups].map(([group, list]) => (
        <div key={group} className="locks-group">
          <div className="locks-head">{group} <span className="muted">({list.length})</span></div>
          <ul>
            {list.map((it) => (
              <li key={it.key}>
                <button className="lock-item" title="Show in the design and the inspector" onClick={() => goToLock(it)}>
                  <span className="lock-icon">🔒</span>
                  <span className="lock-label">{it.label}</span>
                  <span className="lock-val mono">{lockValue(state, it.key)}</span>
                </button>
                <button className="icon-btn lock-x" title="Unlock" onClick={() => setLocks([it.key], false)}>✕</button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {items.length > 0 && (
        <button className="wide-btn" onClick={() => { if (confirm(`Unlock all ${items.length} locked values?`)) clearLocks(); }}>
          Unlock all
        </button>
      )}
    </div>
  );
}
