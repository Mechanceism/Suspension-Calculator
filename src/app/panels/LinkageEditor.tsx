/**
 * Linkage editor (custom suspension type): the corner's own bodies and joints. Every joint joins two
 * bodies — the frame ('chassis'), the steering ('rack'), the knuckle ('upright', which carries the wheel)
 * or a body you add. A corner needs exactly one free motion with the steering held (the travel).
 */
import { useApp } from '../store';
import { ValueInput } from './ValueInput';
import { parseValue } from '../../core/units/units';
import { customFreedom, customProblems, JOINT_EQUATIONS, type CustomJoint, type CustomJointKind, type CustomLinkage } from '../../core/suspension/customLinkage';
import type { Vec3 } from '../../core/math/vec3';

const KIND_LABEL: Record<CustomJointKind, string> = { ball: 'Ball joint', hinge: 'Hinge / bushing', rod: 'Rod (two ball ends)', cylinder: 'Slide and turn (cylindrical)', slider: 'Slide only (prismatic)' };
const KIND_HINT: Record<CustomJointKind, string> = {
  ball: 'The two bodies share a point and turn freely about it (3 constraints)',
  hinge: 'The two bodies turn about a common axis through two points, like a pivot bushing (5 constraints)',
  rod: 'A fixed-length link with ball joints at its ends, from the first body to the second (1 constraint)',
  cylinder: 'The two bodies slide along and turn about a common axis through two points, like a strut tube in its body or a sliding pillar (4 constraints)',
  slider: 'The two bodies only slide along a common axis through two points, without turning (5 constraints)',
};

const fieldOf = (v: number) => ({ text: String(Number(v.toFixed(3))), value: v });

function PointRow({ label, v, onChange }: { label: string; v: Vec3; onChange: (v: Vec3) => void }) {
  const set = (axis: 'x' | 'y' | 'z', text: string) => {
    const r = parseValue(text, 'length');
    if (r.ok) onChange({ ...v, [axis]: r.value });
  };
  return (
    <tr>
      <td className="muted small-text">{label}</td>
      {(['x', 'y', 'z'] as const).map((a) => <td key={a}><ValueInput field={fieldOf(v[a])} unit="mm" onCommit={(t) => set(a, t)} width={64} /></td>)}
    </tr>
  );
}

export function LinkageEditor() {
  const c = useApp((s) => s.geom.custom);
  const setCustom = useApp((s) => s.setCustom);
  const hub = useApp((s) => s.geom.points.wheelCenter);
  if (!c) return null;
  const bodies = [{ id: 'chassis', name: 'Frame' }, { id: 'rack', name: 'Steering rack' }, { id: 'upright', name: 'Knuckle (wheel)' }, ...c.bodies];
  const nameOf = (id: string) => bodies.find((b) => b.id === id)?.name ?? id;
  const problems = customProblems(c);
  const free = customFreedom(c);
  const put = (next: Partial<CustomLinkage>) => setCustom({ ...c, ...next });
  const putJoint = (id: string, patch: Partial<CustomJoint>) => put({ joints: c.joints.map((j) => (j.id === id ? { ...j, ...patch } : j)) });
  const newId = (prefix: string, taken: string[]) => { let n = 1; while (taken.includes(`${prefix}${n}`)) n++; return `${prefix}${n}`; };
  const addBody = () => {
    const id = newId('b', c.bodies.map((b) => b.id));
    put({ bodies: [...c.bodies, { id, name: `Body ${c.bodies.length + 1}` }] });
  };
  const removeBody = (id: string) => put({
    bodies: c.bodies.filter((b) => b.id !== id),
    joints: c.joints.filter((j) => j.a !== id && j.b !== id),
    ...(c.damperBody === id ? { damperBody: 'upright' } : {}),
  });
  const addJoint = (kind: CustomJointKind) => {
    // Start near the hub, inboard, so it can be seen and moved.
    const h = { x: hub[0].value, y: hub[1].value, z: hub[2].value };
    const p = { x: h.x - 200, y: h.y, z: h.z + 100 }, q = { x: h.x - 200, y: h.y, z: h.z - 100 };
    const id = newId('j', c.joints.map((j) => j.id));
    const j: CustomJoint = kind === 'ball' ? { id, kind, name: `Ball joint ${id}`, a: 'chassis', b: 'upright', p }
      : kind === 'hinge' ? { id, kind, name: `Hinge ${id}`, a: 'chassis', b: 'upright', p, q }
      : kind === 'cylinder' || kind === 'slider' ? { id, kind, name: `${kind === 'slider' ? 'Slider' : 'Sliding pillar'} ${id}`, a: 'chassis', b: 'upright', p: { x: h.x - 120, y: h.y - 150, z: h.z }, q: { x: h.x - 140, y: h.y + 150, z: h.z } }
      : { id, kind, name: `Rod ${id}`, a: 'chassis', b: 'upright', p, q: { x: h.x - 50, y: h.y, z: h.z } };
    put({ joints: [...c.joints, j] });
  };
  const setKind = (j: CustomJoint, kind: CustomJointKind) => putJoint(j.id, { kind, ...(kind !== 'ball' && !j.q ? { q: { ...j.p, z: j.p.z - 150 } } : {}) });
  return (
    <div className="linkage-editor">
      <h3>Linkage</h3>
      <p className={`small-text ${problems.length ? 'warn-text' : ''}`}>
        {problems.length ? problems.map((x, i) => <span key={i}>{x}<br /></span>)
          : <>✓ {free} free motion (the travel) with the steering held: {c.joints.length} joints, {c.bodies.length + 1} moving bodies.</>}
      </p>
      <h4>Bodies</h4>
      <table className="hp-table">
        <tbody>
          <tr><td colSpan={2} className="muted small-text">Frame, Steering rack and Knuckle (carries the wheel) are always there.</td></tr>
          {c.bodies.map((b) => (
            <tr key={b.id}>
              <td><input className="value-input" style={{ width: 180 }} value={b.name} onChange={(e) => put({ bodies: c.bodies.map((x) => (x.id === b.id ? { ...x, name: e.target.value } : x)) })} /></td>
              <td><button className="icon-btn" title="Remove this body and its joints" onClick={() => removeBody(b.id)}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="chip" onClick={addBody}>+ Body</button>
      <h4>Joints</h4>
      {c.joints.map((j) => (
        <div key={j.id} className="linkage-joint">
          <div className="row">
            <input className="value-input" style={{ width: 130 }} value={j.name} onChange={(e) => putJoint(j.id, { name: e.target.value })} />
            <select value={j.kind} title={KIND_HINT[j.kind]} onChange={(e) => setKind(j, e.target.value as CustomJointKind)}>
              {(Object.keys(KIND_LABEL) as CustomJointKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]} · {JOINT_EQUATIONS[k]}</option>)}
            </select>
            <button className="icon-btn" title="Remove this joint" onClick={() => put({ joints: c.joints.filter((x) => x.id !== j.id) })}>✕</button>
          </div>
          <div className="row small-text">
            <span className="muted">joins</span>
            <select value={j.a} onChange={(e) => putJoint(j.id, { a: e.target.value })}>{bodies.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
            <span className="muted">and</span>
            <select value={j.b} onChange={(e) => putJoint(j.id, { b: e.target.value })}>{bodies.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          </div>
          <table className="hp-table">
            <thead><tr><th /><th>X</th><th>Y</th><th>Z</th></tr></thead>
            <tbody>
              <PointRow label={j.kind === 'ball' ? 'Joint' : j.kind === 'rod' ? `End on ${nameOf(j.a)}` : 'Axis point 1'} v={j.p} onChange={(p) => putJoint(j.id, { p })} />
              {j.kind !== 'ball' && j.q && <PointRow label={j.kind === 'rod' ? `End on ${nameOf(j.b)}` : 'Axis point 2'} v={j.q} onChange={(q) => putJoint(j.id, { q })} />}
            </tbody>
          </table>
        </div>
      ))}
      <div className="row">
        <button className="chip" onClick={() => addJoint('ball')} title={KIND_HINT.ball}>+ Ball joint</button>
        <button className="chip" onClick={() => addJoint('hinge')} title={KIND_HINT.hinge}>+ Hinge</button>
        <button className="chip" onClick={() => addJoint('rod')} title={KIND_HINT.rod}>+ Rod</button>
        <button className="chip" onClick={() => addJoint('cylinder')} title={KIND_HINT.cylinder}>+ Slide &amp; turn</button>
        <button className="chip" onClick={() => addJoint('slider')} title={KIND_HINT.slider}>+ Slider</button>
      </div>
      <h4>Coilover</h4>
      <div className="row small-text">
        <span className="muted">Lower end on</span>
        <select value={c.damperBody ?? 'upright'} onChange={(e) => put({ damperBody: e.target.value })}>
          {bodies.filter((b) => b.id !== 'chassis' && b.id !== 'rack').map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <span className="muted">(its points: Coilover in the parts below)</span>
      </div>
      <p className="hint small-text">
        Click a joint's point in the view to move it with the X / Y / Z arrows. The Optimize tab can move them too (Free coordinates → Linkage points).
        Steering: a rod (or joint) to the Steering rack steers the knuckle; without one the corner doesn&apos;t steer. The instant axis,
        roll center and steering axis (KPI, caster) come from how the knuckle actually moves.
      </p>
    </div>
  );
}
