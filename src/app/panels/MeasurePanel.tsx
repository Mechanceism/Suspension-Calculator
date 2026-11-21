/**
 * Measure → set dimension. With two points picked, shows their static (design) distance, ΔX/ΔY/ΔZ
 * and view angles; typing a value moves one of the points (your choice) so the dimension is met.
 * The 3D label keeps showing the live values through travel.
 */
import { useMemo, useState } from 'react';
import { parseValue } from '../../core/units/units';
import { DoubleWishbone } from '../../core/suspension/doubleWishbone';
import { characteristics } from '../../core/suspension/characteristics';
import { vec3, sub, length, type Vec3 } from '../../core/math/vec3';
import { viewAngle, withDistance, withDelta, withViewAngle, type ViewAngle, type Mover } from '../../core/math/dimension';
import { useApp, rootOf, toGeometry, type AnchorId, type PointKey, type EditableGeometry } from '../store';
import { anchorLabel, STATE_KEY } from '../anchors';
import { pointAxisLocked } from '../locks';
import { FieldRows, derivedField } from './FieldRows';

const isPoint = (id: AnchorId): id is PointKey => id in STATE_KEY;
const fieldPos = (g: EditableGeometry, k: PointKey): Vec3 => vec3(g.points[k][0].value, g.points[k][1].value, g.points[k][2].value);

/** Static (design) position of any anchor. */
function useDesignAnchors(ids: AnchorId[]): (Vec3 | null)[] {
  const geom = useApp((s) => s.geom);
  return useMemo(() => {
    let chars: ReturnType<typeof characteristics> | null = null;
    const derived = () => {
      if (!chars) { try { chars = characteristics(new DoubleWishbone(toGeometry(geom)).design()); } catch { return null; } }
      return chars;
    };
    return ids.map((id) => {
      if (isPoint(id)) return fieldPos(geom, id);
      const c = derived();
      if (!c) return null;
      switch (id) {
        case 'contact': return c.contactPoint;
        case 'axisGround': return c.steeringAxisAtGround;
        case 'rollCenter': return c.rollCenterHeight === null ? null : vec3(0, c.groundY + c.rollCenterHeight, c.contactPoint.z);
        case 'frontViewIC': return c.frontViewIC;
        default: return null; // patch centroid depends on load: measure only
      }
    });
  }, [geom, ids]);
}

const ANGLES: { view: ViewAngle; label: string; hint: string }[] = [
  { view: 'front', label: 'Front-view angle', hint: 'Looking along Z, from horizontal. Keeps the front-view length and Z.' },
  { view: 'side', label: 'Side-view angle', hint: 'Looking along X, from horizontal. Keeps the side-view length and X.' },
  { view: 'top', label: 'Top-view angle', hint: 'Looking down, from the X axis. Keeps the top-view length and Y.' },
  { view: 'slope', label: 'Slope from horizontal', hint: '3D angle above the ground plane. Keeps the length and the plan direction.' },
];

export function MeasurePanel() {
  const measure = useApp((s) => s.measure);
  const locks = useApp((s) => s.locks);
  const root = useApp((s) => rootOf(s.activeCorner, s.links));
  const damperArm = useApp((s) => s.geom.damperArm);
  const setPointsAxis = useApp((s) => s.setPointsAxis);
  const notify = useApp((s) => s.notify);
  const [moverPref, setMover] = useState<Mover>('b');
  const ids = measure.slice(0, 2);
  const [a, b] = useDesignAnchors(ids);
  if (ids.length < 2) return null;
  const [ia, ib] = ids as [AnchorId, AnchorId];
  const canMove = { a: isPoint(ia), b: isPoint(ib) };
  const mover: Mover | null = canMove[moverPref] ? moverPref : canMove.a ? 'a' : canMove.b ? 'b' : null;
  const movingId = mover === 'a' ? ia : mover === 'b' ? ib : null;

  const apply = (next: Vec3 | null) => {
    if (!next || !movingId || !isPoint(movingId) || !a || !b) return;
    const cur = mover === 'a' ? a : b;
    const updates: { key: PointKey; axis: 0 | 1 | 2; value: number }[] = [];
    const vals = [next.x, next.y, next.z];
    const old = [cur.x, cur.y, cur.z];
    for (const axis of [0, 1, 2] as const) {
      if (Math.abs(vals[axis]! - old[axis]!) < 1e-9) continue;
      if (pointAxisLocked(locks, root, movingId, axis, damperArm)) {
        notify(`${anchorLabel(movingId)} ${'XYZ'[axis]} is locked: unlock it, or move the other point instead.`, 'warn');
        return;
      }
      updates.push({ key: movingId, axis, value: Number(vals[axis]!.toFixed(4)) });
    }
    if (updates.length) setPointsAxis(updates);
  };
  const num = (t: string, q: 'length' | 'angle') => { const r = parseValue(t, q); return r.ok ? r.value : null; };

  const d = a && b ? sub(b, a) : null;
  const rows = a && b && d ? [
    { label: 'Distance', field: derivedField(length(d), 3), unit: 'mm', onCommit: (t: string) => { const v = num(t, 'length'); if (v !== null) apply(withDistance(a, b, v, mover!)); } },
    ...(['ΔX', 'ΔY', 'ΔZ'] as const).map((label, i) => ({
      label, field: derivedField([d.x, d.y, d.z][i]!, 3), unit: 'mm',
      onCommit: (t: string) => { const v = num(t, 'length'); if (v !== null) apply(withDelta(a, b, i as 0 | 1 | 2, v, mover!)); },
    })),
    ...ANGLES.map((x) => ({
      label: x.label, hint: x.hint, field: derivedField(viewAngle(a, b, x.view), 3), unit: '°',
      onCommit: (t: string) => { const v = num(t, 'angle'); if (v !== null) apply(withViewAngle(a, b, x.view, v, mover!)); },
    })),
  ] : [];

  return (
    <div className="measure-panel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="measure-head">
        <b>Set dimension</b> <span className="muted">static height (design)</span>
      </div>
      <div className="muted small-text">{anchorLabel(ia)} → {anchorLabel(ib)}</div>
      {!a || !b ? <p className="hint">This point depends on the load (patch centroid): it can be measured, not set.</p> : (
        <>
          {mover ? (
            <div className="jm-row">
              <span className="muted">Move</span>
              {(['a', 'b'] as const).map((m) => (
                <button key={m} className={`chip${mover === m ? ' on' : ''}`} disabled={!canMove[m]} onClick={() => setMover(m)}
                  title={canMove[m] ? `Move ${anchorLabel(m === 'a' ? ia : ib)}; the other point stays` : 'A derived point cannot be moved directly'}>
                  {anchorLabel(m === 'a' ? ia : ib)}
                </button>
              ))}
            </div>
          ) : <p className="hint">Both points are derived (contact, roll center…): pick at least one joint to set a dimension.</p>}
          {mover && (
            <>
              <FieldRows rows={rows} />
              <p className="hint">
                Type a value and press Enter: <b>{anchorLabel(movingId!)}</b> moves, the other stays.
                {!isPoint(mover === 'a' ? ib : ia) && ' The derived point is taken at static height and may shift after the move.'}
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
