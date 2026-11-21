import { useApp, SPRING_KEYS, SPRING_META, type ArmChoice } from '../store';
import { ValueInput } from './ValueInput';

export function SpringPanel() {
  const spring = useApp((s) => s.spring);
  const setSpringField = useApp((s) => s.setSpringField);
  const damperArm = useApp((s) => s.geom.damperArm);
  const setDamperArm = useApp((s) => s.setDamperArm);
  const fitSpring = useApp((s) => s.fitSpring);
  return (
    <section className="panel">
      <h2>Spring & load</h2>
      <div className="row">
        <span className="muted">Layout</span>
        <select value="coilover" disabled title="Pushrod / rocker layouts are planned">
          <option value="coilover">Coilover, arm → chassis</option>
        </select>
      </div>
      <div className="row">
        <span className="muted">Lower mount on</span>
        <select value={damperArm} onChange={(e) => setDamperArm(e.target.value as ArmChoice)}>
          <option value="lca">Lower control arm</option>
          <option value="uca">Upper control arm</option>
        </select>
      </div>
      <p className="hint">Mount points are <code>FL_Dmp_Chs</code> and <code>FL_Dmp_Arm</code> in Hardpoints.</p>
      <table className="hp-table scalars">
        <tbody>
          {SPRING_KEYS.map((k) => (
            <tr key={k}>
              <td>{SPRING_META[k].label}</td>
              <td><ValueInput field={spring[k]} unit={SPRING_META[k].unit} onCommit={(t) => setSpringField(k, t)} /></td>
              <td className="muted">{SPRING_META[k].unit}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="wide-btn" onClick={fitSpring} title="Free length that holds the static corner load at the design position (travel 0)">
        Fit free length to design ride height
      </button>
    </section>
  );
}
