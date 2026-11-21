/** Edit one hardpoint: type coordinates, nudge in steps, or move by an entered amount. */
import { useState } from 'react';
import { vec3 } from '../../core/math/vec3';
import { parseValue } from '../../core/units/units';
import { useApp, type PointKey } from '../store';
import { ValueInput } from './ValueInput';

const STEPS = [0.1, 0.5, 1, 5, 10, 25];
const AXES = ['X', 'Y', 'Z'] as const;
const axisVec = (i: number, s: number) => vec3(i === 0 ? s : 0, i === 1 ? s : 0, i === 2 ? s : 0);

export function PointEditor({ id }: { id: PointKey }) {
  const field = useApp((s) => s.geom.points[id]);
  const setPoint = useApp((s) => s.setPoint);
  const movePoint = useApp((s) => s.movePoint);
  const step = useApp((s) => s.nudgeStep);
  const snap = useApp((s) => s.snapToGrid);
  const grid = useApp((s) => s.gridSize);
  const set = useApp((s) => s.set);
  const [delta, setDelta] = useState(['0', '0', '0']);
  const applyDelta = () => {
    const v = delta.map((t) => { const r = parseValue(t, 'length'); return r.ok ? r.value : 0; });
    movePoint(id, vec3(v[0]!, v[1]!, v[2]!));
    setDelta(['0', '0', '0']);
  };
  return (
    <div className="point-editor">
      <table className="jm-table">
        <tbody>
          {AXES.map((ax, i) => (
            <tr key={ax}>
              <td className="muted">{ax}</td>
              <td><ValueInput field={field[i]!} unit="mm" onCommit={(t) => setPoint(id, i as 0 | 1 | 2, t)} /></td>
              <td className="nowrap">
                <button className="nudge" title={`−${step} mm`} onClick={() => movePoint(id, axisVec(i, -step))}>−</button>
                <button className="nudge" title={`+${step} mm`} onClick={() => movePoint(id, axisVec(i, step))}>+</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="jm-row">
        <span className="muted">Step</span>
        {STEPS.map((s) => (
          <button key={s} className={`chip${s === step ? ' on' : ''}`} onClick={() => set('nudgeStep', s)}>{s}</button>
        ))}
        <span className="muted">mm</span>
      </div>
      <div className="jm-row">
        <label className="check-inline">
          <input type="checkbox" checked={snap} onChange={() => set('snapToGrid', !snap)} />
          Snap drag to grid
        </label>
        <select value={grid} onChange={(e) => set('gridSize', Number(e.target.value))} disabled={!snap}>
          {[0.1, 0.5, 1, 2, 5, 10].map((g) => <option key={g} value={g}>{g} mm</option>)}
        </select>
      </div>
      <p className="hint">Drag the X / Y / Z arrows on the joint in the viewport to move it.</p>
      <div className="jm-row">
        <span className="muted">Move by</span>
        {delta.map((d, i) => (
          <input
            key={i} className="value-input small" value={d} title={`Δ${AXES[i]} (units allowed, e.g. 0.25in)`}
            onChange={(e) => setDelta(delta.map((x, j) => (j === i ? e.target.value : x)))}
            onKeyDown={(e) => { if (e.key === 'Enter') applyDelta(); }}
          />
        ))}
        <button className="chip on" onClick={applyDelta}>Apply</button>
      </div>
    </div>
  );
}
