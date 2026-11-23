/**
 * Measure → set dimension. With two points picked, shows their distance, ΔX/ΔY/ΔZ and view angles
 * at ride height (design) or at the current travel. Typing a value moves one point (your choice).
 * Each value can also be held, like a CAD sketch dimension:
 *   - Once: just move the point.
 *   - Hold at ride height / at this travel: the dimension is met at that position (it still changes
 *     through travel, e.g. the LCA angle) and is kept when you edit other points.
 *   - Permanent: a part dimension that never changes (same rigid part, or chassis points).
 * Held dimensions are drawn in the view, listed in the Locks tab and kept by the optimizer.
 */
import { useMemo, useState } from 'react';
import { parseValue } from '../../core/units/units';
import { DoubleWishbone } from '../../core/suspension/doubleWishbone';
import { characteristics } from '../../core/suspension/characteristics';
import { vec3, type Vec3 } from '../../core/math/vec3';
import { withDistance, withDelta, withViewAngle, type Mover } from '../../core/math/dimension';
import { measureValue, isAngleMeasure, type DimMeasure } from '../../core/suspension/dimensions';
import { layoutOf, useApp, rootOf, toGeometry, type AnchorId, type PointKey, type EditableGeometry, type HeldDimension } from '../store';
import { anchorLabel, anchorPosition, STATE_KEY } from '../anchors';
import { pointAxisLocked } from '../locks';
import { permanentAllowed, resolveActive, holdLabel, MEASURE_LABELS } from '../heldDimensions';
import type { Current } from '../useModel';
import { ValueInput } from './ValueInput';
import { derivedField } from './FieldRows';
import { useConversion } from '../units';

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

const ROWS: { m: DimMeasure; label: string; hint?: string }[] = [
  { m: 'distance', label: 'Distance' },
  { m: 'dx', label: 'ΔX' }, { m: 'dy', label: 'ΔY' }, { m: 'dz', label: 'ΔZ' },
  { m: 'front', label: 'Front-view angle', hint: 'Looking along Z, from horizontal. Setting it keeps the front-view length and Z.' },
  { m: 'side', label: 'Side-view angle', hint: 'Looking along X, from horizontal. Setting it keeps the side-view length and X.' },
  { m: 'top', label: 'Top-view angle', hint: 'Looking down, from the X axis. Setting it keeps the top-view length and Y.' },
  { m: 'slope', label: 'Slope from horizontal', hint: '3D angle above the ground plane. Setting it keeps the length and the plan direction.' },
];

type Mode = 'once' | 'hold' | 'permanent';

export function MeasurePanel({ cur }: { cur: Current | null }) {
  const measure = useApp((s) => s.measure);
  const locks = useApp((s) => s.locks);
  const root = useApp((s) => rootOf(s.activeCorner, s.links));
  const geom = useApp((s) => s.geom);
  const travel = useApp((s) => s.travel);
  const dims = useApp((s) => s.dimensions);
  const violations = useApp((s) => s.dimViolations);
  const setPointsAxis = useApp((s) => s.setPointsAxis);
  const holdDimension = useApp((s) => s.holdDimension);
  const removeDimension = useApp((s) => s.removeDimension);
  const notify = useApp((s) => s.notify);
  const toggleMeasure = useApp((s) => s.toggleMeasure);
  const lenConv = useConversion('mm');
  const [moverPref, setMover] = useState<Mover>('b');
  const [atTravel, setAtTravel] = useState(false);
  const [mode, setMode] = useState<Mode>('once');
  const ids = measure.slice(0, 2);
  const [da, db] = useDesignAnchors(ids);
  if (ids.length < 2) return null;
  const [ia, ib] = ids as [AnchorId, AnchorId];
  const t = Math.round(travel * 10) / 10;
  const useTravel = atTravel && t !== 0;
  const live = useTravel && cur ? [anchorPosition(ia, cur), anchorPosition(ib, cur)] : [da, db];
  const [a, b] = live;
  const canMove = { a: isPoint(ia), b: isPoint(ib) };
  const mover: Mover | null = canMove[moverPref] ? moverPref : canMove.a ? 'a' : canMove.b ? 'b' : null;
  const movingId = mover === 'a' ? ia : mover === 'b' ? ib : null;
  const bothPoints = isPoint(ia) && isPoint(ib);
  const heldTravel: number | null = mode === 'permanent' ? null : useTravel ? t : 0;
  const findHeld = (m: DimMeasure) => (bothPoints ? dims.find((d) => d.root === root && d.measure === m
    && ((d.a === ia && d.b === ib) || (d.a === ib && d.b === ia))) : undefined);
  const permanentFor = (m: DimMeasure) => (bothPoints ? permanentAllowed(ia as PointKey, ib as PointKey, m, geom.damperArm, geom.kind, layoutOf(geom)) : { ok: false, why: 'Needs two joints' });

  const close = () => toggleMeasure();

  /** Move the moving point so measure m = v (and keep the other held dimensions). */
  const setValue = (m: DimMeasure, v: number) => {
    if (!movingId || !isPoint(movingId) || !a || !b) return;
    const k = movingId;
    const lockedAxis = ([0, 1, 2] as const).filter((ax) => pointAxisLocked(locks, root, k, ax, geom.damperArm, geom.kind, layoutOf(geom), geom.steerMechanism, geom.steeredAxle));
    const others = dims.filter((d) => d.root === root);
    const sharesPoint = others.some((d) => d.a === k || d.b === k);
    if (!useTravel && !sharesPoint) {
      // Static and no other held dimension on this point: exact geometric move.
      const next = m === 'distance' ? withDistance(a, b, v, mover!)
        : m === 'dx' || m === 'dy' || m === 'dz' ? withDelta(a, b, m === 'dx' ? 0 : m === 'dy' ? 1 : 2, v, mover!)
          : withViewAngle(a, b, m, v, mover!);
      if (!next) return;
      const curPos = fieldPos(geom, k);
      const updates: { key: PointKey; axis: 0 | 1 | 2; value: number }[] = [];
      for (const ax of [0, 1, 2] as const) {
        const nv = [next.x, next.y, next.z][ax]!, ov = [curPos.x, curPos.y, curPos.z][ax]!;
        if (Math.abs(nv - ov) < 1e-9) continue;
        if (lockedAxis.includes(ax)) { notify(`${anchorLabel(k)} ${'XYZ'[ax]} is locked: unlock it, or move the other point instead.`, 'warn'); return; }
        updates.push({ key: k, axis: ax, value: Number(nv.toFixed(4)) });
      }
      if (updates.length) setPointsAxis(updates);
      return;
    }
    // At a travel position, or with other held dimensions on this point: solve for the moving point
    // so this value and every held dimension are met together.
    if (!bothPoints) { notify('Setting at a travel position needs two joints.', 'warn'); return; }
    const target: HeldDimension = { id: '__new', root, a: ia as PointKey, b: ib as PointKey, measure: m, value: v, travel: useTravel ? t : 0 };
    const keep = others.filter((d) => !(d.measure === m && ((d.a === ia && d.b === ib) || (d.a === ib && d.b === ia))));
    const r = resolveActive(geom, [target, ...keep], (p, ax) => p !== k || lockedAxis.includes(ax));
    if (r.violated.includes('__new')) { notify(`Couldn't reach that ${MEASURE_LABELS[m]} by moving ${anchorLabel(k)} (locked axes or other held dimensions).`, 'warn'); return; }
    const updates = ([0, 1, 2] as const)
      .filter((ax) => r.geom.points[k][ax].value !== geom.points[k][ax].value)
      .map((ax) => ({ key: k, axis: ax, value: Number(r.geom.points[k][ax].value.toFixed(4)) }));
    if (updates.length) setPointsAxis(updates);
  };

  const hold = (m: DimMeasure, value: number) => {
    if (!bothPoints) return;
    if (mode === 'permanent' && !permanentFor(m).ok) { notify(permanentFor(m).why, 'warn'); return; }
    holdDimension({ root, a: ia as PointKey, b: ib as PointKey, measure: m, value, travel: heldTravel });
  };

  const onCommit = (m: DimMeasure, text: string) => {
    const r = parseValue(text, isAngleMeasure(m) ? 'angle' : 'length');
    if (!r.ok) return;
    setValue(m, r.value);
    if (mode !== 'once') hold(m, r.value);
  };

  const permanentAny = bothPoints && ROWS.some((r) => permanentFor(r.m).ok);
  return (
    <div className="measure-panel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="measure-head">
        <b>Set dimension</b>
        <span className="muted">{useTravel ? `at ${t} mm travel` : 'ride height (design)'}</span>
        <button className="icon-btn measure-close" onClick={close} title="Close the measure tool (Esc)">✕ Close</button>
      </div>
      <div className="muted small-text">{anchorLabel(ia)} → {anchorLabel(ib)}</div>
      {!a || !b ? <p className="hint">This point depends on the load (patch centroid): it can be measured, not set.</p> : (
        <>
          {mover ? (
            <div className="jm-row">
              <span className="muted">Move</span>
              {(['a', 'b'] as const).map((mv) => (
                <button key={mv} className={`chip${mover === mv ? ' on' : ''}`} disabled={!canMove[mv]} onClick={() => setMover(mv)}
                  title={canMove[mv] ? `Move ${anchorLabel(mv === 'a' ? ia : ib)}; the other point stays` : 'A derived point cannot be moved directly'}>
                  {anchorLabel(mv === 'a' ? ia : ib)}
                </button>
              ))}
            </div>
          ) : <p className="hint">Both points are derived (contact, roll center…): pick at least one joint to set a dimension.</p>}
          {t !== 0 && (
            <div className="jm-row">
              <span className="muted">Values at</span>
              <button className={`chip${!useTravel ? ' on' : ''}`} onClick={() => setAtTravel(false)}>Ride height</button>
              <button className={`chip${useTravel ? ' on' : ''}`} onClick={() => setAtTravel(true)} disabled={!bothPoints}>
                Current travel ({t} mm)
              </button>
            </div>
          )}
          {mover && bothPoints && (
            <div className="jm-row hold-modes">
              <span className="muted">When set</span>
              <label title="Just move the point"><input type="radio" checked={mode === 'once'} onChange={() => setMode('once')} /> Once</label>
              <label title="Keep this value at this position; it still moves through travel and comes back">
                <input type="radio" checked={mode === 'hold'} onChange={() => setMode('hold')} /> Hold {useTravel ? `at ${t} mm` : 'at ride height'}
              </label>
              <label title={permanentAny ? 'A part dimension: true at every travel' : permanentFor('distance').why} className={permanentAny && !useTravel ? '' : 'off'}>
                <input type="radio" checked={mode === 'permanent'} disabled={!permanentAny || useTravel} onChange={() => setMode('permanent')} /> Permanent
              </label>
            </div>
          )}
          {mover && (
            <table className="field-rows measure-rows">
              <tbody>
                {ROWS.map((row) => {
                  const v = measureValue(a, b, row.m);
                  const held = findHeld(row.m);
                  const bad = held && violations.includes(held.id);
                  const unit = isAngleMeasure(row.m) ? '°' : 'mm';
                  return (
                    <tr key={row.m} title={row.hint} className={held ? 'held' : ''}>
                      <td>{row.label}</td>
                      <td className="num"><ValueInput field={derivedField(v, 3)} unit={unit} locked={!!held} onCommit={(tx) => onCommit(row.m, tx)} /></td>
                      <td className="unit">{isAngleMeasure(row.m) ? '°' : lenConv.unit}</td>
                      <td>
                        {bothPoints && (held
                          ? <button className={`lock-btn on${bad ? ' bad' : ''}`} title={`Held ${holdLabel(held.travel)}${bad ? ' — not met!' : ''}. Click to release.`} onClick={() => removeDimension(held.id)}>🔒</button>
                          : <button className="lock-btn" title={`Hold the current value (${mode === 'permanent' ? 'permanent' : holdLabel(useTravel ? t : 0)})`}
                              onClick={() => { if (mode === 'permanent' && !permanentFor(row.m).ok) { notify(permanentFor(row.m).why, 'warn'); return; } holdDimension({ root, a: ia as PointKey, b: ib as PointKey, measure: row.m, value: v, travel: mode === 'permanent' ? null : useTravel ? t : 0 }); }}>🔓</button>)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {mover && (
            <p className="hint">
              Type a value and press Enter: <b>{anchorLabel(movingId!)}</b> moves, the other stays.
              {mode !== 'once' && ' The value is then held (🔒) and kept when you edit other points.'}
              {' '}🔓 holds the current value. Held dimensions are listed in the Locks tab.
            </p>
          )}
        </>
      )}
    </div>
  );
}
