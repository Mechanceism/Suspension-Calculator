/**
 * Edit one hardpoint: type coordinates, nudge in steps, move by an entered amount, or slide it along
 * the line toward a connected joint (e.g. the LCA rear bushing toward the ball joint, or along the
 * pivot axis). Steps and typed amounts follow the display units.
 */
import { useEffect, useMemo, useState } from 'react';
import { vec3, sub, length, normalize, type Vec3 } from '../../core/math/vec3';
import { parseValue, UNITS } from '../../core/units/units';
import { alongLine } from '../../core/math/dimension';
import { layoutOf, useApp, rootOf, POINT_KEYS, activePointKeys, type PointKey, type EditableGeometry, type ArmChoice } from '../store';
import { lockKeys, pointAxisLocked } from '../locks';
import { componentDefs, pointLabel } from '../components';
import type { SuspensionKind } from '../../core/suspension/doubleWishbone';
import { useConversion, toDisplay, type Conversion } from '../units';
import { ValueInput, LockButton } from './ValueInput';
import { derivedField } from './FieldRows';

const AXES = ['X', 'Y', 'Z'] as const;
const axisVec = (i: number, s: number) => vec3(i === 0 ? s : 0, i === 1 ? s : 0, i === 2 ? s : 0);
const posOf = (g: EditableGeometry, k: PointKey): Vec3 => vec3(g.points[k][0].value, g.points[k][1].value, g.points[k][2].value);

const METRIC_STEPS = [0.1, 0.5, 1, 5, 10, 25];
const INCH_STEPS = [0.005, 0.01, 0.05, 0.1, 0.25, 1].map((x) => x * 25.4);
const METRIC_GRID = [0.1, 0.5, 1, 2, 5, 10];
const INCH_GRID = [0.01, 0.05, 0.1, 0.125, 0.25, 0.5].map((x) => x * 25.4);
const imperialLength = (c: Conversion) => ['in', 'ft', 'yd'].includes(c.unit);
const showLen = (mm: number, c: Conversion) => `${Number(toDisplay(mm, c).toFixed(4))}`;

/** Read a typed amount: plain numbers in the display length unit, typed units as typed. */
function readLength(text: string, c: Conversion): number | null {
  const unit = c.unit in UNITS.length ? c.unit : 'mm';
  const r = parseValue(text, 'length', unit);
  return r.ok ? r.value : null;
}

function StepRow() {
  const step = useApp((s) => s.nudgeStep);
  const set = useApp((s) => s.set);
  const conv = useConversion('mm');
  const steps = imperialLength(conv) ? INCH_STEPS : METRIC_STEPS;
  // Switching unit systems: pick the closest step of the new list.
  useEffect(() => {
    if (!steps.some((s) => Math.abs(s - step) < 1e-9)) {
      set('nudgeStep', steps.reduce((a, b) => (Math.abs(b - step) < Math.abs(a - step) ? b : a)));
    }
  }, [steps, step, set]);
  return (
    <div className="jm-row">
      <span className="muted">Step</span>
      {steps.map((s) => (
        <button key={s} className={`chip${Math.abs(s - step) < 1e-9 ? ' on' : ''}`} onClick={() => set('nudgeStep', s)}>{showLen(s, conv)}</button>
      ))}
      <span className="muted">{conv.unit}</span>
    </div>
  );
}

function SnapRow() {
  const snap = useApp((s) => s.snapToGrid);
  const grid = useApp((s) => s.gridSize);
  const set = useApp((s) => s.set);
  const conv = useConversion('mm');
  const grids = imperialLength(conv) ? INCH_GRID : METRIC_GRID;
  useEffect(() => {
    if (!grids.some((g) => Math.abs(g - grid) < 1e-9)) set('gridSize', grids.reduce((a, b) => (Math.abs(b - grid) < Math.abs(a - grid) ? b : a)));
  }, [grids, grid, set]);
  return (
    <div className="jm-row">
      <label className="check-inline">
        <input type="checkbox" checked={snap} onChange={() => set('snapToGrid', !snap)} />
        Snap drag to grid
      </label>
      <select value={grids.find((g) => Math.abs(g - grid) < 1e-9) ?? grids[2]} onChange={(e) => set('gridSize', Number(e.target.value))} disabled={!snap}>
        {grids.map((g) => <option key={g} value={g}>{showLen(g, conv)} {conv.unit}</option>)}
      </select>
    </div>
  );
}

function MoveBy({ onMove }: { onMove: (d: Vec3) => void }) {
  const conv = useConversion('mm');
  const [delta, setDelta] = useState(['0', '0', '0']);
  const apply = () => {
    const v = delta.map((t) => readLength(t, conv) ?? 0);
    onMove(vec3(v[0]!, v[1]!, v[2]!));
    setDelta(['0', '0', '0']);
  };
  return (
    <div className="jm-row">
      <span className="muted">Move by</span>
      {delta.map((d, i) => (
        <input
          key={i} className="value-input small" value={d} title={`Δ${AXES[i]} in ${conv.unit} (or type a unit, e.g. 0.25in)`}
          onChange={(e) => setDelta(delta.map((x, j) => (j === i ? e.target.value : x)))}
          onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
        />
      ))}
      <button className="chip on" onClick={apply}>Apply</button>
    </div>
  );
}

/** Move several points together (a whole part or a multi-selection) by steps or an entered amount. */
export function GroupMove({ ids }: { ids: PointKey[] }) {
  const movePoints = useApp((s) => s.movePoints);
  const locks = useApp((s) => s.locks);
  const root = useApp((s) => rootOf(s.activeCorner, s.links));
  const damperArm = useApp((s) => s.geom.damperArm);
  const kind = useApp((s) => s.geom.kind);
  const layout = useApp((s) => layoutOf(s.geom));
  const steerMech = useApp((s) => s.geom.steerMechanism ?? 'rack');
  const steeredAxle = useApp((s) => !!s.geom.steeredAxle);
  const axisLocked = (i: number) => ids.some((k) => pointAxisLocked(locks, root, k, i as 0 | 1 | 2, damperArm, kind, layout, steerMech, steeredAxle));
  const step = useApp((s) => s.nudgeStep);
  const conv = useConversion('mm');
  return (
    <div className="point-editor">
      <div className="jm-row">
        {AXES.map((ax, i) => (
          <span key={ax} className="nowrap">
            <span className="muted">{ax}</span>
            <button className="nudge" disabled={axisLocked(i)} title={axisLocked(i) ? 'Locked' : `−${showLen(step, conv)} ${conv.unit}`} onClick={() => movePoints(ids, axisVec(i, -step))}>−</button>
            <button className="nudge" disabled={axisLocked(i)} title={axisLocked(i) ? 'Locked' : `+${showLen(step, conv)} ${conv.unit}`} onClick={() => movePoints(ids, axisVec(i, step))}>+</button>
          </span>
        ))}
      </div>
      <StepRow />
      <SnapRow />
      <MoveBy onMove={(d) => movePoints(ids, d)} />
      <p className="hint">Or drag the X / Y / Z arrows at the center of the selection in the viewport.</p>
    </div>
  );
}

/** The most useful lines first: along the arm to its ball joint, then along the pivot axis, etc. */
const PREFERRED: Partial<Record<PointKey, PointKey[]>> = {
  ucaFwd: ['ucaOut', 'ucaAft'], ucaAft: ['ucaOut', 'ucaFwd'], lcaFwd: ['lcaOut', 'lcaAft'], lcaAft: ['lcaOut', 'lcaFwd'],
  ucaOut: ['lcaOut', 'ucaFwd', 'ucaAft'], lcaOut: ['ucaOut', 'lcaFwd', 'lcaAft'],
  trInner: ['trOuter'], trOuter: ['trInner'], dmpChassis: ['dmpArm'], dmpArm: ['dmpChassis'],
};

/** Joints this point is connected to (shares a part with), for "move along the line toward…". */
function neighbors(id: PointKey, damperArm: ArmChoice, kind: SuspensionKind, layout: 'coilover' | 'rocker' = 'coilover', steerMech: 'rack' | 'arm' = 'rack'): PointKey[] {
  const out = new Set<PointKey>(PREFERRED[id] ?? []);
  for (const d of Object.values(componentDefs(damperArm, kind, layout, 'lca', steerMech))) if (d.points.includes(id)) for (const p of d.points) if (p !== id) out.add(p);
  return [...out];
}

/** Slide a joint along the line toward another joint: distance to it, nudges, a drag arrow. */
function AlongLine({ id }: { id: PointKey }) {
  const geom = useApp((s) => s.geom);
  const locks = useApp((s) => s.locks);
  const root = useApp((s) => rootOf(s.activeCorner, s.links));
  const lineMove = useApp((s) => s.lineMove);
  const set = useApp((s) => s.set);
  const setPointsAxis = useApp((s) => s.setPointsAxis);
  const notify = useApp((s) => s.notify);
  const step = useApp((s) => s.nudgeStep);
  const conv = useConversion('mm');
  const near = useMemo(() => neighbors(id, geom.damperArm, geom.kind, layoutOf(geom), geom.steerMechanism), [id, geom.damperArm, geom.kind]);
  const toward = lineMove?.id === id ? lineMove.toward : near[0] ?? POINT_KEYS.find((k) => k !== id)!;
  // Keep the store in sync so the viewport shows the extra arrow for this line.
  useEffect(() => {
    if (lineMove?.id !== id) set('lineMove', { id, toward });
    return () => { if (useApp.getState().lineMove?.id === id) useApp.getState().set('lineMove', null); };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const p = posOf(geom, id);
  const q = posOf(geom, toward);
  const dist = length(sub(q, p));
  const dir = dist > 1e-9 ? normalize(sub(q, p)) : vec3(0, 0, 0);
  const changedAxes = ([0, 1, 2] as const).filter((a) => Math.abs([dir.x, dir.y, dir.z][a]!) > 1e-9);
  const lockedAxes = changedAxes.filter((a) => pointAxisLocked(locks, root, id, a, geom.damperArm, geom.kind, layoutOf(geom), geom.steerMechanism, geom.steeredAxle));
  const blocked = lockedAxes.length > 0;

  const moveBy = (amount: number) => {
    if (blocked) { notify(`${pointLabel(id, geom.kind, layoutOf(geom))} ${lockedAxes.map((a) => AXES[a]).join('/')} is locked.`, 'warn'); return; }
    const n = alongLine(p, q, amount);
    if (!n) return;
    setPointsAxis(changedAxes.map((a) => ({ key: id, axis: a, value: Number([n.x, n.y, n.z][a]!.toFixed(4)) })));
  };
  const options = [...near, ...activePointKeys(geom.kind, layoutOf(geom), geom.steerMechanism, geom.steeredAxle).filter((k) => k !== id && !near.includes(k))];

  return (
    <div className="along-line">
      <div className="jm-row">
        <span className="muted">Along the line toward</span>
        <select value={toward} onChange={(e) => set('lineMove', { id, toward: e.target.value as PointKey })}>
          {options.map((k) => <option key={k} value={k}>{near.includes(k) ? '' : '· '}{pointLabel(k, geom.kind, layoutOf(geom))}</option>)}
        </select>
      </div>
      <table className="jm-table">
        <tbody>
          <tr title="Set the distance to that joint: this joint slides along the line between them">
            <td className="muted">Distance</td>
            <td>
              <ValueInput field={derivedField(dist, 3)} unit="mm" locked={blocked} onCommit={(t) => {
                const r = parseValue(t, 'length');
                if (r.ok) moveBy(dist - r.value);
              }} />
            </td>
            <td className="nowrap">
              <button className="nudge" disabled={blocked} title={`Away by ${showLen(step, conv)} ${conv.unit}`} onClick={() => moveBy(-step)}>−</button>
              <button className="nudge" disabled={blocked} title={`Toward by ${showLen(step, conv)} ${conv.unit}`} onClick={() => moveBy(step)}>+</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p className="hint">
        Slides this joint on its current line to {pointLabel(toward, geom.kind, layoutOf(geom))} (+ = toward), keeping the direction: no need to work out X, Y and Z.
        Or drag the yellow arrow in the viewport.{blocked && ` Locked: ${lockedAxes.map((a) => AXES[a]).join(', ')}.`}
      </p>
    </div>
  );
}

export function PointEditor({ id }: { id: PointKey }) {
  const field = useApp((s) => s.geom.points[id]);
  const locks = useApp((s) => s.locks);
  const root = useApp((s) => rootOf(s.activeCorner, s.links));
  const damperArm = useApp((s) => s.geom.damperArm);
  const kind = useApp((s) => s.geom.kind);
  const layout = useApp((s) => layoutOf(s.geom));
  const steerMech = useApp((s) => s.geom.steerMechanism ?? 'rack');
  const steeredAxle = useApp((s) => !!s.geom.steeredAxle);
  const setPoint = useApp((s) => s.setPoint);
  const movePoint = useApp((s) => s.movePoint);
  const startMeasure = useApp((s) => s.startMeasure);
  const step = useApp((s) => s.nudgeStep);
  const conv = useConversion('mm');
  return (
    <div className="point-editor">
      <table className="jm-table">
        <tbody>
          {AXES.map((ax, i) => {
            const locked = pointAxisLocked(locks, root, id, i as 0 | 1 | 2, damperArm, kind, layout, steerMech, steeredAxle);
            return (
              <tr key={ax} data-lock-key={lockKeys.point(root, id, i as 0 | 1 | 2)}>
                <td className="muted">{ax}</td>
                <td><ValueInput field={field[i]!} unit="mm" onCommit={(t) => setPoint(id, i as 0 | 1 | 2, t)} locked={locked} /></td>
                <td className="nowrap">
                  <button className="nudge" disabled={locked} title={locked ? 'Locked' : `−${showLen(step, conv)} ${conv.unit}`} onClick={() => movePoint(id, axisVec(i, -step))}>−</button>
                  <button className="nudge" disabled={locked} title={locked ? 'Locked' : `+${showLen(step, conv)} ${conv.unit}`} onClick={() => movePoint(id, axisVec(i, step))}>+</button>
                  <LockButton keys={[lockKeys.point(root, id, i as 0 | 1 | 2)]} title={`Lock ${ax} of this point`} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <StepRow />
      <SnapRow />
      <p className="hint">Drag the X / Y / Z arrows on the joint in the viewport to move it.</p>
      <MoveBy onMove={(d) => movePoint(id, d)} />
      <AlongLine id={id} />
      <div className="jm-row">
        <button className="chip" onClick={() => startMeasure([id])} title="Measure from this joint: click a second point to see and set the distance and angles">
          📏 Measure / set dimension from here
        </button>
      </div>
    </div>
  );
}

