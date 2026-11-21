import { useEffect, useState } from 'react';
import { useApp, SCALAR_META, TIRE_KEYS, TIRE_META, type ScalarKey, type TireModelKind } from '../store';
import { ValueInput } from './ValueInput';

const DIM_KEYS: ScalarKey[] = ['tireDiameter', 'tireWidth', 'rimDiameter', 'shoulderRadius'];

const MODEL_TEXT: Record<TireModelKind, string> = {
  rigid: 'Rigid (no load; kinematics only)',
  stiffness: 'Vertical stiffness (N/mm)',
  gas: 'Air spring (gas law + patch area)',
};

export function TirePanel() {
  const geom = useApp((s) => s.geom);
  const setScalar = useApp((s) => s.setScalar);
  const tireModel = useApp((s) => s.tireModel);
  const tire = useApp((s) => s.tire);
  const volumeChange = useApp((s) => s.volumeChange);
  const sizeText = useApp((s) => s.tireSizeText);
  const sizeError = useApp((s) => s.tireSizeError);
  const applyTireSize = useApp((s) => s.applyTireSize);
  const setTireField = useApp((s) => s.setTireField);
  const set = useApp((s) => s.set);
  const [size, setSize] = useState(sizeText);
  useEffect(() => setSize(sizeText), [sizeText]);

  return (
    <section className="panel">
      <h2>Tire</h2>
      <div className="row">
        <span className="muted">Size</span>
        <input
          className={`text-input${sizeError ? ' invalid' : ''}`} value={size} placeholder="225/45R17 · 31x10.50R15 · 20.5x7.0-13"
          title={sizeError ?? 'Press Enter to fill the dimensions below'}
          onChange={(e) => setSize(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') applyTireSize(size); }}
          onBlur={() => { if (size && size !== sizeText) applyTireSize(size); }}
          spellCheck={false}
        />
      </div>
      {sizeError && <p className="hint error">{sizeError}</p>}
      <table className="hp-table scalars">
        <tbody>
          {DIM_KEYS.map((k) => (
            <tr key={k}>
              <td>{SCALAR_META[k].label}</td>
              <td><ValueInput field={geom.scalars[k]} unit="mm" onCommit={(t) => setScalar(k, t)} /></td>
              <td className="muted">mm</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 8 }}>
        <span className="muted">Model</span>
        <select value={tireModel} onChange={(e) => set('tireModel', e.target.value as TireModelKind)}>
          {(Object.keys(MODEL_TEXT) as TireModelKind[]).map((k) => <option key={k} value={k}>{MODEL_TEXT[k]}</option>)}
        </select>
      </div>
      {tireModel !== 'rigid' && (
        <table className="hp-table scalars">
          <tbody>
            {TIRE_KEYS.filter((k) => TIRE_META[k].models.includes(tireModel)).map((k) => (
              <tr key={k}>
                <td>{TIRE_META[k].label}</td>
                <td><ValueInput field={tire[k]} unit={TIRE_META[k].unit} onCommit={(t) => setTireField(k, t)} /></td>
                <td className="muted">{TIRE_META[k].unit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {tireModel === 'gas' && (
        <label className="check-row">
          <input type="checkbox" checked={volumeChange} onChange={() => set('volumeChange', !volumeChange)} />
          Apply air-volume change from displaced volume
        </label>
      )}
      <p className="hint">
        Units can be typed: <code>12psi</code>, <code>2.2bar</code>, <code>200lbf</code>, <code>5000ft</code>, <code>68F</code>.
        The patch is a rigid-cylinder approximation; compare designs with it, calibrate later.
      </p>
    </section>
  );
}
