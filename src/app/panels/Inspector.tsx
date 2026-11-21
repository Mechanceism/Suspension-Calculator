/**
 * Inspector: the editable variables of whatever is selected (click a part or joint in the viewport),
 * plus its 1st and 2nd family so related settings are one click away.
 */
import { useApp, POINT_NAMES, activeParam, SPRING_META, vehicleStaticLoads, mergedCorners, type ComponentId, type PointKey } from '../store';
import { toGeometry } from '../store';
import { componentDefs, family, ownersOf, POINT_LABELS } from '../components';
import { armMetrics } from '../../core/suspension/armGeometry';
import { deg } from '../../core/suspension/characteristics';
import { distance } from '../../core/math/vec3';
import { COLORS } from '../viewport/Scene';
import type { Model } from '../useModel';
import { FieldRows, Section, fmt, derivedField } from './FieldRows';
import { ValueInput } from './ValueInput';
import { PointEditor, GroupMove } from './PointEditor';
import { SpringFields, DamperFields } from './SpringPanel';
import { TireFields } from './TirePanel';
import { SteeringSystemFields, TireForceFields, SteeringReadout } from './SteeringPanel';

const COMPONENT_COLOR: Record<ComponentId, string> = {
  chassis: COLORS.chassis, uca: COLORS.uca, lca: COLORS.lca, upright: COLORS.upright,
  tieRod: COLORS.tieRod, rack: COLORS.chassis, spring: COLORS.spring, wheel: COLORS.wheel,
};

function Chip({ id, label }: { id: ComponentId; label: string }) {
  const select = useApp((s) => s.select);
  return (
    <button className="family-chip" onClick={() => select({ kind: 'component', id })}>
      <span className="swatch" style={{ background: COMPONENT_COLOR[id] }} />{label}
    </button>
  );
}

function Family({ first, second }: { first: ComponentId[]; second: ComponentId[] }) {
  const defs = componentDefs(useApp((s) => s.geom.damperArm));
  return (
    <div className="family">
      <div className="family-row"><span className="muted">Connected</span>{first.map((c) => <Chip key={c} id={c} label={defs[c].label} />)}</div>
      {second.length > 0 && (
        <div className="family-row"><span className="muted">Next</span>{second.map((c) => <Chip key={c} id={c} label={defs[c].label} />)}</div>
      )}
    </div>
  );
}

function PointsTable({ points }: { points: PointKey[] }) {
  const geom = useApp((s) => s.geom);
  const setPoint = useApp((s) => s.setPoint);
  const select = useApp((s) => s.select);
  return (
    <table className="hp-table">
      <thead><tr><th>Point</th><th>X</th><th>Y</th><th>Z</th></tr></thead>
      <tbody>
        {points.map((k) => (
          <tr key={k}>
            <td>
              <button className="link-btn" title={`${activeParam(POINT_NAMES[k])} — open joint menu`} onClick={() => select({ kind: 'point', id: k })}>
                {POINT_LABELS[k]}
              </button>
            </td>
            {([0, 1, 2] as const).map((i) => (
              <td key={i}><ValueInput field={geom.points[k][i]} unit="mm" onCommit={(t) => setPoint(k, i, t)} /></td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ArmSection({ arm, model }: { arm: 'uca' | 'lca'; model: Model }) {
  const geom = useApp((s) => s.geom);
  const setArmDerived = useApp((s) => s.setArmDerived);
  const a = toGeometry(geom)[arm];
  const m = armMetrics(a);
  const cur = model.current;
  const live = cur ? armMetrics({ fwd: a.fwd, aft: a.aft, out: arm === 'uca' ? cur.state.points.ucaOut : cur.state.points.lcaOut }) : null;
  return (
    <>
      <FieldRows rows={[
        { label: 'Length (ball joint → pivot axis)', field: derivedField(m.length, 2), unit: 'mm', onCommit: (t) => setArmDerived(arm, 'length', t), hint: 'Moves the frame pivots; the ball joint stays put' },
        { label: 'Pivot-axis inclination', field: derivedField(deg(m.inclination), 3), unit: '°', onCommit: (t) => setArmDerived(arm, 'inclination', t), hint: 'Side view, + = front pivot higher (anti-dive style)' },
        { label: 'Pivot-axis plan angle', field: derivedField(deg(m.planAngle), 3), unit: '°', onCommit: (t) => setArmDerived(arm, 'planAngle', t), hint: 'Top view, + = front pivot further outboard' },
      ]} />
      <FieldRows rows={[
        { label: 'Front leg', value: fmt(m.frontLeg, 1), unit: 'mm' },
        { label: 'Rear leg', value: fmt(m.rearLeg, 1), unit: 'mm' },
        { label: 'Pivot spacing', value: fmt(m.pivotSpacing, 1), unit: 'mm' },
        { label: 'Front-view angle (static)', value: fmt(deg(m.frontViewAngle), 2), unit: '°', hint: '+ = ball joint higher than the pivot axis' },
        { label: 'Front-view angle (now)', value: fmt(live ? deg(live.frontViewAngle) : NaN, 2), unit: '°' },
      ]} />
      <p className="hint">Editing these moves the frame pivots so the upright and track width stay the same.</p>
    </>
  );
}

function UprightSection({ model }: { model: Model }) {
  const c = model.current?.chars;
  const p = model.current?.state.points;
  return (
    <FieldRows rows={[
      { label: 'Ball-joint spacing', value: fmt(p ? distance(p.ucaOut, p.lcaOut) : NaN, 1), unit: 'mm' },
      { label: 'KPI', value: fmt(c ? deg(c.kpi) : NaN, 2), unit: '°' },
      { label: 'Caster', value: fmt(c ? deg(c.caster) : NaN, 2), unit: '°' },
      { label: 'Scrub radius', value: fmt(c?.scrubRadius, 1), unit: 'mm' },
      { label: 'Mechanical trail', value: fmt(c?.mechanicalTrail, 1), unit: 'mm' },
      { label: 'Kingpin offset @ WC', value: fmt(c?.kingpinOffsetAtWheelCenter, 1), unit: 'mm' },
      { label: 'Caster offset @ WC', value: fmt(c?.casterOffsetAtWheelCenter, 1), unit: 'mm' },
    ]} />
  );
}

function TieRodSection({ model }: { model: Model }) {
  const cur = model.current;
  const p = cur?.state.points;
  return (
    <FieldRows rows={[
      { label: 'Length', value: fmt(p ? distance(p.trInner, p.trOuter) : NaN, 1), unit: 'mm' },
      { label: 'Toe (now)', value: fmt(cur ? deg(cur.chars.toe) : NaN, 3), unit: '°' },
      { label: 'Bump steer', value: fmt(cur?.bumpSteer, 4), unit: '°/mm' },
      { label: 'Tie-rod force', value: fmt(cur?.steering?.loads.tieRodForce, 0), unit: 'N', hint: '+ = tension' },
    ]} />
  );
}

function WheelSection() {
  const geom = useApp((s) => s.geom);
  const setScalar = useApp((s) => s.setScalar);
  return (
    <FieldRows rows={[
      { label: 'Static camber', field: geom.scalars.staticCamber, unit: '°', onCommit: (t) => setScalar('staticCamber', t), hint: '+ = top outboard' },
      { label: 'Static toe', field: geom.scalars.staticToe, unit: '°', onCommit: (t) => setScalar('staticToe', t), hint: '+ = toe-in' },
    ]} />
  );
}

function ChassisSection() {
  const spring = useApp((s) => s.spring);
  const setSpringField = useApp((s) => s.setSpringField);
  const mode = useApp((s) => s.cornerLoadMode);
  const vehicleLoad = useApp((s) => vehicleStaticLoads(s.vehicle, mergedCorners(s), s.links)[s.activeCorner]);
  const droop = useApp((s) => s.droop);
  const bump = useApp((s) => s.bump);
  const set = useApp((s) => s.set);
  return (
    <>
      <div className="row">
        <span className="muted">Corner load</span>
        <select value={mode} onChange={(e) => set('cornerLoadMode', e.target.value as 'vehicle' | 'manual')}>
          <option value="vehicle">From vehicle CG ({vehicleLoad.toFixed(0)} N)</option>
          <option value="manual">Manual (study this corner alone)</option>
        </select>
      </div>
      <FieldRows rows={[
        ...(mode === 'manual'
          ? [{ label: SPRING_META.cornerLoad.label, field: spring.cornerLoad, unit: 'N', onCommit: (t: string) => setSpringField('cornerLoad', t) }]
          : [{ label: SPRING_META.cornerLoad.label, value: vehicleLoad.toFixed(0), unit: 'N', hint: 'Static weight on this corner from the vehicle mass and CG' }]),
        { label: SPRING_META.unsprungMass.label, field: spring.unsprungMass, unit: SPRING_META.unsprungMass.unit, onCommit: (t: string) => setSpringField('unsprungMass', t) },
      ]} />
      <FieldRows rows={[
        { label: 'Droop travel', field: derivedField(droop, 1), unit: 'mm', onCommit: (t) => set('droop', Math.max(1, Math.abs(Number(t) || droop))) },
        { label: 'Bump travel', field: derivedField(bump, 1), unit: 'mm', onCommit: (t) => set('bump', Math.max(1, Math.abs(Number(t) || bump))) },
      ]} />
    </>
  );
}

function SpringResults({ model }: { model: Model }) {
  const sp = model.current?.spring;
  if (!sp) return null;
  return (
    <FieldRows rows={[
      { label: 'Spring length', value: fmt(sp.length, 1), unit: 'mm' },
      { label: 'Spring force', value: fmt(sp.force, 0), unit: 'N' },
      { label: 'Motion ratio', value: fmt(sp.motionRatio, 3), unit: '' },
      { label: 'Wheel rate', value: fmt(sp.wheelRate, 1), unit: 'N/mm' },
      { label: 'Ride frequency', value: fmt(sp.frequency, 2), unit: 'Hz' },
    ]} />
  );
}

function ComponentInspector({ id, model }: { id: ComponentId; model: Model }) {
  const damperArm = useApp((s) => s.geom.damperArm);
  const focusOn = useApp((s) => s.focusOn);
  const defs = componentDefs(damperArm);
  const def = defs[id];
  const fam = family(id, defs);
  return (
    <div className="inspector">
      <div className="insp-head">
        <span className="swatch big" style={{ background: COMPONENT_COLOR[id] }} />
        <b>{def.label}</b>
        <button className="icon-btn" title="Focus camera" onClick={() => focusOn(id)}>◎ Focus</button>
      </div>
      <Family {...fam} />
      {(id === 'uca' || id === 'lca') && <Section title="Dimensions"><ArmSection arm={id} model={model} /></Section>}
      {id === 'chassis' && <Section title="Corner load & travel"><ChassisSection /></Section>}
      {id === 'upright' && <Section title="Steering axis"><UprightSection model={model} /></Section>}
      {id === 'tieRod' && <Section title="Tie rod"><TieRodSection model={model} /></Section>}
      {id === 'rack' && (
        <>
          <Section title="Steering system"><SteeringSystemFields /></Section>
          <Section title="Steering results"><SteeringReadout model={model} /></Section>
        </>
      )}
      {id === 'spring' && (
        <>
          <Section title="Spring"><SpringFields keys={['springRate', 'freeLength']} /></Section>
          <Section title="Damper & bump stop"><DamperFields model={model} /></Section>
          <Section title="Results"><SpringResults model={model} /></Section>
        </>
      )}
      {id === 'wheel' && (
        <>
          <Section title="Wheel alignment"><WheelSection /></Section>
          <Section title="Tire"><TireFields /></Section>
          <Section title="Tire forces at the patch" open={false}><TireForceFields /></Section>
        </>
      )}
      {def.points.length > 0 && <Section title="Points"><PointsTable points={def.points} /></Section>}
      {def.points.length > 1 && (
        <Section title="Move whole part" open={false}>
          <p className="hint">Moves all of this part's points together{def.points.some((k) => ownersOf(k, defs).length > 1) ? ' — shared joints (e.g. ball joints) move with it' : ''}.</p>
          <GroupMove ids={def.points} />
        </Section>
      )}
    </div>
  );
}

function PointInspector({ id }: { id: PointKey }) {
  const defs = componentDefs(useApp((s) => s.geom.damperArm));
  const owners = ownersOf(id, defs);
  const related = [...new Set(owners.flatMap((o) => family(o, defs).first))].filter((c) => !owners.includes(c));
  return (
    <div className="inspector">
      <div className="insp-head">
        <span className="swatch big" style={{ background: '#ffffff' }} />
        <div>
          <b>{POINT_LABELS[id]}</b>
          <div className="mono muted">{activeParam(POINT_NAMES[id])}</div>
        </div>
      </div>
      <div className="family">
        <div className="family-row"><span className="muted">Part of</span>{owners.map((c) => <Chip key={c} id={c} label={defs[c].label} />)}</div>
        {related.length > 0 && <div className="family-row"><span className="muted">Next</span>{related.map((c) => <Chip key={c} id={c} label={defs[c].label} />)}</div>}
      </div>
      <Section title="Position (design)"><PointEditor id={id} /></Section>
    </div>
  );
}

export function Inspector({ model }: { model: Model }) {
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const defs = componentDefs(useApp((s) => s.geom.damperArm));
  if (!selection) {
    return (
      <div className="inspector empty">
        <p><b>Click a part or a joint</b> in the viewport to edit it here.</p>
        <ul className="hint-list">
          <li>Parts show their dimensions, settings and connected parts.</li>
          <li>Click a joint to move it: drag its X / Y / Z arrows, or type / nudge here.</li>
          <li><kbd>Shift</kbd> or <kbd>Ctrl</kbd> + click joints or parts to select several and move them together.</li>
          <li><b>📏 Measure</b> (or <kbd>M</kbd>) measures between any two points. <kbd>Esc</kbd> closes.</li>
        </ul>
        <div className="family-row wrap">
          {(Object.keys(defs) as ComponentId[]).map((c) => <Chip key={c} id={c} label={defs[c].label} />)}
        </div>
        <button className="link-btn" onClick={() => select({ kind: 'component', id: 'chassis' })}>Corner load & travel →</button>
      </div>
    );
  }
  if (selection.kind === 'point') return <PointInspector id={selection.id} />;
  if (selection.kind === 'points') return <PointsInspector ids={selection.ids} />;
  return <ComponentInspector id={selection.id} model={model} />;
}

function PointsInspector({ ids }: { ids: PointKey[] }) {
  const select = useApp((s) => s.select);
  const toggle = useApp((s) => s.toggleSelectPoints);
  return (
    <div className="inspector">
      <div className="insp-head">
        <span className="swatch big" style={{ background: '#ffffff' }} />
        <b>{ids.length} points selected</b>
        <button className="icon-btn" onClick={() => select(null)} title="Clear selection (Esc)">Clear</button>
      </div>
      <div className="family-row wrap">
        {ids.map((k) => (
          <span key={k} className="family-chip">
            <button className="link-btn" onClick={() => select({ kind: 'point', id: k })} title={activeParam(POINT_NAMES[k])}>{POINT_LABELS[k]}</button>
            <button className="icon-btn tiny" onClick={() => toggle([k])} title="Remove from selection">✕</button>
          </span>
        ))}
      </div>
      <p className="hint"><kbd>Shift</kbd>/<kbd>Ctrl</kbd> + click joints or parts to add or remove them.</p>
      <Section title="Move together"><GroupMove ids={ids} /></Section>
      <Section title="Points"><PointsTable points={ids} /></Section>
    </div>
  );
}
