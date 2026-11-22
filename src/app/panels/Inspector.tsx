/**
 * Inspector: the editable variables of whatever is selected (click a part or joint in the viewport),
 * plus its 1st and 2nd family so related settings are one click away.
 */
import { useApp, POINT_NAMES, activeParam, SPRING_META, vehicleStaticLoads, mergedCorners, rootOf, type ComponentId, type PointKey } from '../store';
import { lockKeys, pointAxisLocked } from '../locks';
import { toGeometry } from '../store';
import { componentDefs, family, ownersOf, pointLabel } from '../components';
import { SUSPENSION_KINDS, SUSPENSION_LABELS, type SuspensionKind } from '../../core/suspension/doubleWishbone';
import { coiloverGeometry, setCoilover, moveAlongArm } from '../../core/suspension/coilover';
import { parseValue } from '../../core/units/units';
import type { Vec3 } from '../../core/math/vec3';

/** Components of the active design's suspension type. */
function useDefs() {
  const arm = useApp((s) => s.geom.damperArm);
  const kind = useApp((s) => s.geom.kind);
  return componentDefs(arm, kind);
}
const labelOf = (k: PointKey) => pointLabel(k, useApp.getState().geom.kind);
import { armMetrics } from '../../core/suspension/armGeometry';
import { deg } from '../../core/suspension/characteristics';
import { distance } from '../../core/math/vec3';
import { COLORS } from '../viewport/Scene';
import type { Model } from '../useModel';
import { FieldRows, Section, fmt, derivedField } from './FieldRows';
import { ValueInput, LockButton } from './ValueInput';
import { useDisplay } from '../units';
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
  const defs = useDefs();
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
  const locks = useApp((s) => s.locks);
  const root = useApp((s) => rootOf(s.activeCorner, s.links));
  return (
    <table className="hp-table">
      <thead><tr><th>Point</th><th>X</th><th>Y</th><th>Z</th><th /></tr></thead>
      <tbody>
        {points.map((k) => (
          <tr key={k}>
            <td>
              <button className="link-btn" title={`${activeParam(POINT_NAMES[k])} — select the joint`} onClick={() => select({ kind: 'point', id: k })}>
                {labelOf(k)}
              </button>
            </td>
            {([0, 1, 2] as const).map((i) => (
              <td key={i} data-lock-key={lockKeys.point(root, k, i)}>
                <ValueInput field={geom.points[k][i]} unit="mm" onCommit={(t) => setPoint(k, i, t)} locked={pointAxisLocked(locks, root, k, i, geom.damperArm, geom.kind)} />
              </td>
            ))}
            <td><LockButton keys={([0, 1, 2] as const).map((i) => lockKeys.point(root, k, i))} title="Lock / unlock X, Y and Z of this point" /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ArmSection({ arm, model }: { arm: 'uca' | 'lca'; model: Model }) {
  const geom = useApp((s) => s.geom);
  const root = useApp((s) => rootOf(s.activeCorner, s.links));

  const setArmDerived = useApp((s) => s.setArmDerived);
  const a = toGeometry(geom)[arm];
  const m = armMetrics(a);
  const cur = model.current;
  const live = cur ? armMetrics({ fwd: a.fwd, aft: a.aft, out: arm === 'uca' ? cur.state.points.ucaOut : cur.state.points.lcaOut }) : null;
  return (
    <>
      <FieldRows rows={[
        { label: 'Length (ball joint → pivot axis)', field: derivedField(m.length, 2), unit: 'mm', onCommit: (t) => setArmDerived(arm, 'length', t), hint: 'Moves the frame pivots; the ball joint stays put', lockKey: lockKeys.derived(root, arm, 'length') },
        { label: 'Pivot-axis inclination', field: derivedField(deg(m.inclination), 3), unit: '°', onCommit: (t) => setArmDerived(arm, 'inclination', t), hint: 'Side view, + = front pivot higher (anti-dive style)', lockKey: lockKeys.derived(root, arm, 'inclination') },
        { label: 'Pivot-axis plan angle', field: derivedField(deg(m.planAngle), 3), unit: '°', onCommit: (t) => setArmDerived(arm, 'planAngle', t), hint: 'Top view, + = front pivot further outboard', lockKey: lockKeys.derived(root, arm, 'planAngle') },
        { label: 'Front-view angle (static)', field: derivedField(deg(m.frontViewAngle), 3), unit: '°', onCommit: (t) => setArmDerived(arm, 'frontViewAngle', t), hint: '+ = ball joint higher than the pivot axis. Swings the pivot axis around the ball joint (frame pivots move)', lockKey: lockKeys.derived(root, arm, 'frontViewAngle') },
      ]} />
      <FieldRows rows={[
        { label: 'Front leg', value: fmt(m.frontLeg, 1), unit: 'mm' },
        { label: 'Rear leg', value: fmt(m.rearLeg, 1), unit: 'mm' },
        { label: 'Pivot spacing', value: fmt(m.pivotSpacing, 1), unit: 'mm' },
        { label: 'Front-view angle (now)', value: fmt(live ? deg(live.frontViewAngle) : NaN, 2), unit: '°' },
      ]} />
      <p className="hint">Editing these moves the frame pivots so the upright and track width stay the same.</p>
    </>
  );
}

/**
 * The coilover / strut as numbers: installed length, front- and side-view angle, and the lower mount's
 * position along its arm. Editing keeps the lower mount (moving along the arm moves the whole coilover).
 */
function CoiloverPlacement() {
  const geom = useApp((s) => s.geom);
  const setPointsAxis = useApp((s) => s.setPointsAxis);
  const notify = useApp((s) => s.notify);
  const locks = useApp((s) => s.locks);
  const root = useApp((s) => rootOf(s.activeCorner, s.links));
  const g = toGeometry(geom);
  const d = g.damper;
  if (!d) return null;
  const kind = geom.kind ?? 'doubleWishbone';
  const arm = kind === 'doubleWishbone' && (geom.damperArm === 'uca' || geom.damperArm === 'lca') ? g[geom.damperArm] : kind === 'macpherson' ? undefined : undefined;
  const c = coiloverGeometry(d.chassis, d.armPoint, arm);
  const put = (moves: { key: 'dmpChassis' | 'dmpArm'; p: Vec3 }[]) => {
    const updates = moves.flatMap(({ key, p }) => ([0, 1, 2] as const).map((axis) => ({ key, axis, value: [p.x, p.y, p.z][axis]! })));
    const blocked = updates.filter((u) => Math.abs(u.value - geom.points[u.key][u.axis].value) > 1e-9 && pointAxisLocked(locks, root, u.key, u.axis, geom.damperArm, geom.kind));
    if (blocked.length) { notify(`${blocked.map((u) => `${labelOf(u.key)} ${'XYZ'[u.axis]}`).join(', ')} locked: unlock to move the ${kind === 'macpherson' ? 'strut' : 'coilover'}.`, 'warn'); return; }
    setPointsAxis(updates);
  };
  const angle = (which: 'frontViewAngle' | 'sideViewAngle') => (t: string) => {
    const r = parseValue(t, 'angle'); if (!r.ok) return;
    put([{ key: 'dmpChassis', p: setCoilover(d.chassis, d.armPoint, which, (r.value * Math.PI) / 180) }]);
  };
  const where = kind === 'macpherson' ? 'top mount' : 'chassis mount';
  return (
    <>
      <FieldRows rows={[
        { label: 'Installed length (mount to mount)', field: derivedField(c.length, 1), unit: 'mm', hint: `At ride height. Moves the ${where} along the axis; the lower mount stays.`, onCommit: (t: string) => { const r = parseValue(t, 'length'); if (r.ok && r.value > 0) put([{ key: 'dmpChassis', p: setCoilover(d.chassis, d.armPoint, 'length', r.value) }]); } },
        { label: 'Front-view angle from vertical', field: derivedField(deg(c.frontViewAngle), 2), unit: '°', hint: `+ = top leans inboard. Swings the ${where} about the lower mount (length kept).`, onCommit: angle('frontViewAngle') },
        { label: 'Side-view angle from vertical', field: derivedField(deg(c.sideViewAngle), 2), unit: '°', hint: `+ = top leans rearward. Swings the ${where} about the lower mount.`, onCommit: angle('sideViewAngle') },
        ...(arm ? [{
          label: 'Lower mount along the arm', field: derivedField(c.alongArm * 100, 1), unit: '%',
          hint: '0 % = on the arm\'s pivot axis, 100 % = at the ball joint. Moves the whole coilover along the arm (length and angles kept); further out = higher motion ratio.',
          onCommit: (t: string) => { const v = Number(t.replace('%', '')); if (Number.isFinite(v)) { const m = moveAlongArm(d.chassis, d.armPoint, arm, v / 100); put([{ key: 'dmpChassis', p: m.chassis }, { key: 'dmpArm', p: m.lower }]); } },
        }] : []),
      ]} />
      <p className="hint">
        {kind === 'macpherson' ? 'The strut is the spring / damper: its top mount and its point on the upright set the steering axis too.'
          : kind === 'multilink' ? 'On a multilink the coilover mounts on the upright.'
            : <>Lower mount on: <b>{geom.damperArm === 'upright' ? 'the knuckle' : geom.damperArm === 'uca' ? 'the upper arm' : 'the lower arm'}</b> (change in Spring &amp; load → Lower mount on).</>}
      </p>
    </>
  );
}

function UprightSection({ model }: { model: Model }) {
  const c = model.current?.chars;
  const p = model.current?.state.points;
  return (
    <FieldRows rows={[
      { label: 'Steering-axis point spacing', value: fmt(p ? distance(p.steerUpper, p.steerLower) : NaN, 1), unit: 'mm', hint: 'Ball joints; MacPherson: lower ball joint to strut top; multilink: the virtual pivots (where each pair of links passes closest)' },
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
  const root = useApp((s) => rootOf(s.activeCorner, s.links));

  const setScalar = useApp((s) => s.setScalar);
  return (
    <FieldRows rows={[
      { label: 'Static camber', field: geom.scalars.staticCamber, unit: '°', onCommit: (t) => setScalar('staticCamber', t), hint: '+ = top outboard', lockKey: lockKeys.field(root, 'scalar', 'staticCamber') },
      { label: 'Static toe', field: geom.scalars.staticToe, unit: '°', onCommit: (t) => setScalar('staticToe', t), hint: '+ = toe-in', lockKey: lockKeys.field(root, 'scalar', 'staticToe') },
    ]} />
  );
}

function ChassisSection() {
  const spring = useApp((s) => s.spring);
  const setSpringField = useApp((s) => s.setSpringField);
  const mode = useApp((s) => s.cornerLoadMode);
  const vehicleLoad = useApp((s) => vehicleStaticLoads(s.vehicle, mergedCorners(s), s.links)[s.activeCorner]);
  const disp = useDisplay();
  const root = useApp((s) => rootOf(s.activeCorner, s.links));

  const droop = useApp((s) => s.droop);
  const bump = useApp((s) => s.bump);
  const set = useApp((s) => s.set);
  return (
    <>
      <div className="row">
        <span className="muted">Corner load</span>
        <select value={mode} onChange={(e) => set('cornerLoadMode', e.target.value as 'vehicle' | 'manual')}>
          <option value="vehicle">From vehicle CG ({disp.format(vehicleLoad, 'N', 0)})</option>
          <option value="manual">Manual (study this corner alone)</option>
        </select>
      </div>
      <FieldRows rows={[
        ...(mode === 'manual'
          ? [{ label: SPRING_META.cornerLoad.label, field: spring.cornerLoad, unit: 'N', onCommit: (t: string) => setSpringField('cornerLoad', t), lockKey: lockKeys.field(root, 'spring', 'cornerLoad') }]
          : [{ label: SPRING_META.cornerLoad.label, value: vehicleLoad.toFixed(0), unit: 'N', hint: 'Static weight on this corner from the vehicle mass and CG' }]),
        { label: SPRING_META.unsprungMass.label, field: spring.unsprungMass, unit: SPRING_META.unsprungMass.unit, onCommit: (t: string) => setSpringField('unsprungMass', t), lockKey: lockKeys.field(root, 'spring', 'unsprungMass') },
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
  const kind = useApp((s) => s.geom.kind);
  const focusOn = useApp((s) => s.focusOn);
  const startMeasure = useApp((s) => s.startMeasure);
  const root = useApp((s) => rootOf(s.activeCorner, s.links));

  const defs = useDefs();
  const def = defs[id];
  const fam = family(id, defs);
  return (
    <div className="inspector">
      <div className="insp-head" data-lock-key={lockKeys.part(root, id)}>
        <span className="swatch big" style={{ background: COMPONENT_COLOR[id] }} />
        <b>{def.label}</b>
        {def.points.length > 0 && <LockButton keys={[lockKeys.part(root, id)]} title="Lock the whole part (all of its points) so the optimizer can't move it" />}
        {def.points.length === 2 && (
          <button className="icon-btn" title="Measure this part, and set its length or angles (static height)" onClick={() => startMeasure([def.points[0]!, def.points[1]!])}>📏</button>
        )}
        <button className="icon-btn" title="Focus camera" onClick={() => focusOn(id)}>◎ Focus</button>
      </div>
      <Family {...fam} />
      {(id === 'uca' || id === 'lca') && (kind === 'doubleWishbone' || (kind === 'macpherson' && id === 'lca')) && <Section title="Dimensions"><ArmSection arm={id} model={model} /></Section>}
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
          <Section title={kind === 'macpherson' ? 'Strut placement' : 'Coilover placement'}><CoiloverPlacement /></Section>
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
  const defs = useDefs();
  const root = useApp((s) => rootOf(s.activeCorner, s.links));

  const owners = ownersOf(id, defs);
  const related = [...new Set(owners.flatMap((o) => family(o, defs).first))].filter((c) => !owners.includes(c));
  return (
    <div className="inspector">
      <div className="insp-head">
        <span className="swatch big" style={{ background: '#ffffff' }} />
        <div>
          <b>{labelOf(id)}</b>
          <div className="mono muted">{activeParam(POINT_NAMES[id])}</div>
        </div>
        <LockButton keys={([0, 1, 2] as const).map((i) => lockKeys.point(root, id, i))} title="Lock / unlock X, Y and Z of this point" />
      </div>
      <div className="family">
        <div className="family-row"><span className="muted">Part of</span>{owners.map((c) => <Chip key={c} id={c} label={defs[c].label} />)}</div>
        {related.length > 0 && <div className="family-row"><span className="muted">Next</span>{related.map((c) => <Chip key={c} id={c} label={defs[c].label} />)}</div>}
      </div>
      <Section title="Position (design)"><PointEditor id={id} /></Section>
    </div>
  );
}

/** Suspension type of the active corner (and the corners linked to it). */
export function SuspensionTypeRow() {
  const kind = useApp((s) => s.geom.kind ?? 'doubleWishbone');
  const setKind = useApp((s) => s.setSuspensionKind);
  const active = useApp((s) => s.activeCorner);
  return (
    <div className="row" title="Switching keeps the lower arm, tie rod, hub and tire and places the new parts from them (Undo restores).">
      <span className="muted">{active} type</span>
      <select value={kind} onChange={(e) => setKind(e.target.value as SuspensionKind)}>
        {SUSPENSION_KINDS.map((k) => <option key={k} value={k}>{SUSPENSION_LABELS[k]}</option>)}
      </select>
    </div>
  );
}

export function Inspector({ model }: { model: Model }) {
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const defs = useDefs();
  if (!selection) {
    return (
      <div className="inspector empty">
        <SuspensionTypeRow />
        <p><b>Click a part or a joint</b> in the viewport to edit it here.</p>
        <ul className="hint-list">
          <li>Parts show their dimensions, settings and connected parts.</li>
          <li>Click a joint to move it: drag its X / Y / Z arrows, or type / nudge here.</li>
          <li><kbd>Shift</kbd> or <kbd>Ctrl</kbd> + click joints or parts to select several and move them together.</li>
          <li><b>📏 Measure</b> (or <kbd>M</kbd>) measures between any two points. <kbd>Esc</kbd> closes.</li>
        </ul>
        <div className="family-row wrap">
          {(Object.keys(defs) as ComponentId[]).filter((c) => !defs[c].absent).map((c) => <Chip key={c} id={c} label={defs[c].label} />)}
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
            <button className="link-btn" onClick={() => select({ kind: 'point', id: k })} title={activeParam(POINT_NAMES[k])}>{labelOf(k)}</button>
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
