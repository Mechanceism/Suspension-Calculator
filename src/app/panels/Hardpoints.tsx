import { useApp, forCorner, rootOf, POINT_KEYS, POINT_NAMES, SCALAR_KEYS, SCALAR_META } from '../store';
import { lockKeys, pointAxisLocked } from '../locks';
import { SAMPLE_LAYOUTS } from '../../examples/sampleLayouts';
import { ValueInput, LockButton } from './ValueInput';

export function Hardpoints() {
  const geom = useApp((s) => s.geom);
  const active = useApp((s) => s.activeCorner);
  const presetId = useApp((s) => s.presetId);
  const loadPreset = useApp((s) => s.loadPreset);
  const setPoint = useApp((s) => s.setPoint);
  const setScalar = useApp((s) => s.setScalar);
  const locks = useApp((s) => s.locks);
  const root = useApp((s) => rootOf(s.activeCorner, s.links));
  return (
    <section className="panel">
      <h2>Hardpoints</h2>
      <div className="row">
        <span className="muted">Preset</span>
        <select value={presetId} onChange={(e) => loadPreset(e.target.value)}>
          {presetId === 'custom' && <option value="custom">Custom (edited)</option>}
          {SAMPLE_LAYOUTS.map((l) => <option key={l.id} value={l.id}>{l.id}: {l.label}</option>)}
        </select>
      </div>
      <p className="hint">mm unless a unit is typed (e.g. <code>5in</code>, <code>1ft 2in</code>). Enter to apply.</p>
      <table className="hp-table">
        <thead>
          <tr><th>Point</th><th>X</th><th>Y</th><th>Z</th><th /></tr>
        </thead>
        <tbody>
          {POINT_KEYS.map((k) => (
            <tr key={k}>
              <td className="mono">{forCorner(active, POINT_NAMES[k])}</td>
              {([0, 1, 2] as const).map((axis) => (
                <td key={axis}>
                  <ValueInput field={geom.points[k][axis]} unit="mm" onCommit={(t) => setPoint(k, axis, t)} locked={pointAxisLocked(locks, root, k, axis, geom.damperArm)} />
                </td>
              ))}
              <td><LockButton keys={([0, 1, 2] as const).map((a) => lockKeys.point(root, k, a))} title="Lock / unlock X, Y and Z of this point" /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="hp-table scalars">
        <tbody>
          {SCALAR_KEYS.filter((k) => k === 'staticCamber' || k === 'staticToe').map((k) => (
            <tr key={k}>
              <td className="mono">{forCorner(active, SCALAR_META[k].name)}</td>
              <td>
                <ValueInput
                  field={geom.scalars[k]} unit={SCALAR_META[k].quantity === 'angle' ? 'deg' : 'mm'}
                  onCommit={(t) => setScalar(k, t)} lockKey={lockKeys.field(root, 'scalar', k)}
                />
              </td>
              <td className="muted">{SCALAR_META[k].quantity === 'angle' ? 'deg' : 'mm'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">Axes: X outboard, Y up (0 = frame bottom), Z forward.</p>
    </section>
  );
}
