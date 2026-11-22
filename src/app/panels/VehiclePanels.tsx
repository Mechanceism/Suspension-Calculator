import { steeringWheelAngle, inputForWheelAngle } from '../../core/tests/steer';
import { useEffect, useRef } from 'react';
import { Num, UnitLabel } from './UnitText';
import { openWizard, EstimatedNote } from './SetupWizard';
import { AeroPanel } from './AeroPanel';
import { brakesOf } from '../optimizer';
import { useConversion, toDisplay, fromDisplay, useDisplay } from '../units';
import type { GripSummary, SlipState } from '../../core/vehicle/vehicle';
import { LocksPanel } from './LocksPanel';
import { VehicleOptimizePanel } from './OptimizePanel';
import { CORNER_IDS, type CornerId } from '../../core/vehicle/vehicle';
import { deg } from '../../core/suspension/characteristics';
import {
  useApp, VEHICLE_KEYS, VEHICLE_META, CORNER_NAMES, SHARED_META, rootOf,
  type CornerLinks, type DiffType, type Axle, type SharedDesign,
  BRAKE_KEYS, BRAKE_META, TOW_KEYS, TOW_META,
} from '../store';
import type { BrakeMount } from '../../core/vehicle/vehicle';
import { ValueInput } from './ValueInput';
import type { VehicleModel } from '../useVehicle';
import { FieldRows, Section, fmt } from './FieldRows';

const G = 9.80665;

const LINK_LABELS: Record<keyof CornerLinks, string> = {
  frontPair: 'Front left / right same dimensions',
  rearPair: 'Rear left / right same dimensions',
  rearFromFront: 'Rear same dimensions as front',
};

/** Corner picker + per-corner settings + dimension links (used in both workspaces). */
export function CornerSetup({ compact = false }: { compact?: boolean }) {
  const active = useApp((s) => s.activeCorner);
  const links = useApp((s) => s.links);
  const settings = useApp((s) => s.settings);
  const setActiveCorner = useApp((s) => s.setActiveCorner);
  const setLink = useApp((s) => s.setLink);
  const setCornerSetting = useApp((s) => s.setCornerSetting);
  const root = rootOf(active, links);
  const sharedWith = CORNER_IDS.filter((id) => id !== active && rootOf(id, links) === root);
  return (
    <div className="corner-setup">
      <div className="corner-picker" role="tablist" aria-label="Corner being edited">
        {CORNER_IDS.map((id) => (
          <button key={id} role="tab" aria-selected={id === active} className={id === active ? 'on' : ''} onClick={() => setActiveCorner(id)} title={CORNER_NAMES[id]}>
            {id}
            <span className="corner-flags">{settings[id].steered ? 'S' : ''}{settings[id].powered ? 'P' : ''}{settings[id].brake === 'inboard' ? 'i' : settings[id].brake === 'none' ? '–' : ''}</span>
          </button>
        ))}
      </div>
      <p className="hint">
        Editing <b>{CORNER_NAMES[active]}</b>
        {sharedWith.length > 0 && <> — dimensions shared with {sharedWith.join(', ')} (linked)</>}
      </p>
      <div className="setting-row">
        <label className="check-inline">
          <input type="checkbox" checked={settings[active].steered} onChange={(e) => setCornerSetting(active, 'steered', e.target.checked)} />
          Steers
        </label>
        <label className="check-inline" title="Drive forces come later; this marks the corner as powered">
          <input type="checkbox" checked={settings[active].powered} onChange={(e) => setCornerSetting(active, 'powered', e.target.checked)} />
          Powered
        </label>
      </div>
      {settings[active].powered && (
        <div className="row">
          <span className="muted">Drive</span>
          <select
            value={settings[active].drive} onChange={(e) => setCornerSetting(active, 'drive', e.target.value as 'chassis' | 'hub')}
            title="Chassis diff: drive torque through a halfshaft, so the force acts at the wheel center. Hub motor: torque into the upright, so it acts at the contact patch."
          >
            <option value="chassis">Chassis diff + halfshaft</option>
            <option value="hub">Hub motor</option>
          </select>
        </div>
      )}
      {settings[active].powered && settings[active].drive === 'chassis' && (
        <div className="row">
          <span className="muted">Differential</span>
          <select
            value={settings[active].diff} onChange={(e) => setCornerSetting(active, 'diff', e.target.value as DiffType)}
            title="Open: equal torque to both wheels (the weaker tire limits the axle). Locked: both wheels turn together (force follows grip). Limited-slip: in between (up to 2.5× torque bias). The axle uses its left corner's setting."
          >
            <option value="open">Open</option>
            <option value="lsd">Limited-slip</option>
            <option value="locked">Locked / spool</option>
          </select>
        </div>
      )}
      <div className="row">
        <span className="muted">Brake</span>
        <select
          value={settings[active].brake} onChange={(e) => setCornerSetting(active, 'brake', e.target.value as BrakeMount)}
          title="Outboard: brake torque goes into the upright (force acts at the contact patch). Inboard: into the chassis (force acts at the wheel center)."
        >
          <option value="outboard">Outboard (at the wheel)</option>
          <option value="inboard">Inboard (on the chassis)</option>
          <option value="none">None</option>
        </select>
        {settings[active].brake !== 'none' && (
          <label className="check-inline" title="Anti-lock brakes on this corner. Without ABS a tire braked past its grip locks and slides (less braking force, no cornering grip).">
            <input type="checkbox" checked={settings[active].abs} onChange={(e) => setCornerSetting(active, 'abs', e.target.checked)} />
            ABS
          </label>
        )}
      </div>
      {!compact && (
        <div className="link-rows">
          {(Object.keys(LINK_LABELS) as (keyof CornerLinks)[]).map((k) => (
            <label key={k} className="check-row">
              <input type="checkbox" checked={links[k]} onChange={(e) => setLink(k, e.target.checked)} />
              {LINK_LABELS[k]}
            </label>
          ))}
          <p className="hint">Unlinking gives that corner its own copy to edit, starting from the shared dimensions.</p>
        </div>
      )}
    </div>
  );
}

const VEHICLE_TABS = [
  { id: 'inputs', label: 'Inputs' },
  { id: 'locks', label: 'Locks' },
  { id: 'optimize', label: 'Optimize' },
] as const;

/** Vehicle workspace sidebar: inputs, locks, and the whole-vehicle optimizer. */
export function VehicleSidebar({ model }: { model: VehicleModel | null }) {
  const tab = useApp((s) => s.vehicleTab);
  const set = useApp((s) => s.set);
  const nLocks = useApp((s) => Object.keys(s.locks).length + s.dimensions.length);
  return (
    <>
      <nav className="tabs" role="tablist">
        {VEHICLE_TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => set('vehicleTab', t.id)}>
            {t.label}{t.id === 'locks' && nLocks > 0 && <span className="tab-count">{nLocks}</span>}
          </button>
        ))}
      </nav>
      <div className="tab-body">
        {tab === 'inputs' && <VehicleInputs model={model} />}
        {tab === 'locks' && <LocksPanel />}
        {tab === 'optimize' && <VehicleOptimizePanel />}
      </div>
    </>
  );
}

export function VehicleInputs({ model }: { model: VehicleModel | null }) {
  const vehicle = useApp((s) => s.vehicle);
  const setVehicleField = useApp((s) => s.setVehicleField);
  const autoPreload = useApp((s) => s.autoPreload);
  const set = useApp((s) => s.set);
  const loads = model?.staticLoads;
  const total = loads ? CORNER_IDS.reduce((a, id) => a + loads[id], 0) : 0;
  return (
    <div className="inspector">
      <div className="jm-row">
        <button className="wide-btn" onClick={() => openWizard()} title="Enter your car step by step: easy values first, measuring tools included (corner-scale CG, spring rate from a weight)">Setup wizard</button>
      </div>
      <Section title="Vehicle">
        <FieldRows rows={VEHICLE_KEYS.map((k) => ({
          label: VEHICLE_META[k].label, field: vehicle[k], unit: VEHICLE_META[k].unit, hint: VEHICLE_META[k].hint,
          onCommit: (t: string) => setVehicleField(k, t), lockKey: `vehicle.${k}`,
        }))} />
        <p className="hint">Corner unsprung masses are set per corner (Spring &amp; load). The CG is the whole car at static ride height.</p>
      </Section>
      <Section title="Aerodynamics" open={false} extra={<AeroBadge />}>
        <AeroPanel />
      </Section>
      <Section title="Towing" open={false} extra={<span className="muted small-text">{useApp.getState().tow.on ? 'trailer' : 'off'}</span>}>
        <TowPanel />
      </Section>
      <Section title="Brake system" open={false} extra={<span className="muted small-text">{useApp.getState().brakes.on ? 'hydraulics' : 'off'}</span>}>
        <BrakePanel />
      </Section>
      <Section title="Static corner weights (from CG)">
        {loads && (
          <>
            <table className="corner-grid">
              <tbody>
                <tr><td>FL <b><Num text={fmt(loads.FL, 0)} unit="N" /></b> <UnitLabel unit="N" /></td><td>FR <b><Num text={fmt(loads.FR, 0)} unit="N" /></b> <UnitLabel unit="N" /></td></tr>
                <tr><td>RL <b><Num text={fmt(loads.RL, 0)} unit="N" /></b> <UnitLabel unit="N" /></td><td>RR <b><Num text={fmt(loads.RR, 0)} unit="N" /></b> <UnitLabel unit="N" /></td></tr>
              </tbody>
            </table>
            <p className="hint">
              Front {fmt((100 * (loads.FL + loads.FR)) / total, 1)}% · Left {fmt((100 * (loads.FL + loads.RL)) / total, 1)}%
              · Total <Num text={fmt(total / G, 1)} unit="kg" withUnit />
            </p>
          </>
        )}
        <label className="check-row">
          <input type="checkbox" checked={autoPreload} onChange={() => set('autoPreload', !autoPreload)} />
          Set spring preload per corner for design ride height
        </label>
        <p className="hint">Like adjusting each coilover's collar: each corner's free length is fitted to its static weight. Off = use each corner's own free length.</p>
      </Section>
      <Section title="Shared components (per axle)">
        <SharedEditor axle="front" />
        <SharedEditor axle="rear" />
      </Section>
      <Section title="Corners">
        <CornerSetup />
      </Section>
    </div>
  );
}

const ARB_TYPES: Record<SharedDesign['antiRollBar'], string> = {
  none: 'None',
  wheelRate: 'Rate at the wheel',
  torsionBar: 'Torsion bar + drop links',
};

function SharedEditor({ axle }: { axle: Axle }) {
  const sh = useApp((s) => s.shared[axle]);
  const setShared = useApp((s) => s.setShared);
  const setSharedField = useApp((s) => s.setSharedField);
  const setDropLink = useApp((s) => s.setDropLink);
  const row = (k: keyof typeof SHARED_META) => ({
    label: SHARED_META[k].label, field: sh[k], unit: SHARED_META[k].unit, hint: SHARED_META[k].hint,
    onCommit: (t: string) => setSharedField(axle, k, t), lockKey: `shared.${axle}.${k}`,
  });
  return (
    <div className="shared-axle">
      <div className="tree-head">{axle === 'front' ? 'Front axle' : 'Rear axle'}</div>
      <div className="row">
        <span className="muted">Anti-roll bar</span>
        <select value={sh.antiRollBar} onChange={(e) => setShared(axle, { antiRollBar: e.target.value as SharedDesign['antiRollBar'] })}>
          {(Object.keys(ARB_TYPES) as SharedDesign['antiRollBar'][]).map((k) => <option key={k} value={k}>{ARB_TYPES[k]}</option>)}
        </select>
      </div>
      {sh.antiRollBar === 'wheelRate' && <FieldRows rows={[row('arbRate')]} />}
      {sh.antiRollBar === 'torsionBar' && (
        <>
          <FieldRows rows={[row('barRate'), row('lever')]} />
          <div className="row drop-link">
            <span className="muted" title="Where the drop link attaches to the lower arm (corner frame; mirrored for the right side)">Drop link on LCA</span>
            {(['X', 'Y', 'Z'] as const).map((ax, i) => (
              <span key={ax} data-lock-key={`shared.${axle}.dropLink.${ax.toLowerCase()}`}>
                <ValueInput field={sh.dropLink[i]!} unit="mm" width={58} onCommit={(t) => setDropLink(axle, i as 0 | 1 | 2, t)} lockKey={`shared.${axle}.dropLink.${ax.toLowerCase()}`} />
              </span>
            ))}
          </div>
        </>
      )}
      <div className="row">
        <span className="muted">Heave spring</span>
        <select value={sh.heaveSpring} onChange={(e) => setShared(axle, { heaveSpring: e.target.value as SharedDesign['heaveSpring'] })}>
          <option value="none">None</option>
          <option value="wheelRate">Rate at the wheel</option>
        </select>
      </div>
      {sh.heaveSpring === 'wheelRate' && <FieldRows rows={[row('heaveRate')]} />}
    </div>
  );
}

const STATUS: Record<string, string> = { 'droop-limit': 'droop limit', 'bump-limit': 'bump limit' };

export function VehicleResults({ model }: { model: VehicleModel | null }) {
  const r = model?.result;
  if (!model || !r) return <section className="panel"><h2>Vehicle results</h2><p className="muted">{model?.error ?? 'Solving…'}</p></section>;
  const corners = CORNER_IDS.map((id) => ({ id, c: r.corners[id], v: model.corners[id], s: model.staticLoads[id] }));
  const t = model.transfer;
  return (
    <section className="panel">
      <h2>
        Vehicle results
        <span className={`status ${r.converged ? 'status-converged' : 'status-not-converged'}`}>{r.converged ? 'Settled' : 'Not converged'}</span>
      </h2>
      <EstimatedNote />
      {r.grip && <GripSection grip={r.grip} />}
      {r.aero && (
        <Section title="Aero">
          <FieldRows rows={[
            { label: 'Drag', value: fmt(r.aero.drag, 0), unit: 'N', hint: 'On the body, rearward; the driven tires push against it' },
            { label: 'Downforce, front axle', value: fmt(-r.aero.liftF, 0), unit: 'N', hint: '− = lift' },
            { label: 'Downforce, rear axle', value: fmt(-r.aero.liftR, 0), unit: 'N' },
            { label: 'Aero balance (front share)', value: Math.abs(r.aero.liftF + r.aero.liftR) > 1e-6 ? fmt((r.aero.liftF / (r.aero.liftF + r.aero.liftR)) * 100, 1) : '—', unit: '%' },
          ]} />
        </Section>
      )}
      <Section title="Body">
        <FieldRows rows={[
          { label: 'Roll', value: fmt(deg(r.pose.roll), 3), unit: '°', hint: '+ = top leans toward −X (right)' },
          { label: 'Pitch', value: fmt(deg(r.pose.pitch), 3), unit: '°', hint: '+ = nose down' },
          { label: 'Heave', value: fmt(r.pose.heave, 2), unit: 'mm', hint: 'chassis rise from design' },
          { label: 'Ride height, front axle', value: fmt(model.rideHeight.front, 1), unit: 'mm', hint: 'frame bottom to ground' },
          { label: 'Ride height, rear axle', value: fmt(model.rideHeight.rear, 1), unit: 'mm' },
          { label: 'Roll center height, front', value: fmt(model.rollCenters.front?.h, 1), unit: 'mm', hint: 'from the actual left/right corners' },
          { label: 'Roll center height, rear', value: fmt(model.rollCenters.rear?.h, 1), unit: 'mm' },
          { label: 'Roll center lateral, front', value: fmt(model.rollCenters.front?.x, 1), unit: 'mm', hint: '+ = left of centerline' },
          { label: 'Rollover threshold (rigid)', value: fmt(model.rolloverG, 2), unit: 'g', hint: 'half track ÷ CG height' },
          {
            label: 'Ackermann lines cross', unit: 'mm',
            value: !model.ackermannLines ? '—' : !model.ackermannLines.cross ? 'parallel' : fmt(model.ackermannLines.cross.z + model.wheelbase, 0),
            hint: 'Top view: lines from each front steering axis through its steering arm\'s outer joint (View → Ackermann lines). Distance of their crossing ahead of the rear axle (+) or behind it (−). Classic 100 % Ackermann: 0 (on the rear axle). Parallel = parallel steer. A rule for near straight ahead: Ackermann % in the Corner view shows what the linkage really does.',
          },
        ]} />
      </Section>
      <Section title="Lateral load transfer">
        <FieldRows rows={[
          { label: 'Front total', value: fmt(t.front.total, 0), unit: 'N', hint: '+ = outside tire gains load' },
          { label: 'Front, through links (roll center)', value: fmt(t.front.geometric, 0), unit: 'N' },
          { label: 'Front, through springs (body roll)', value: fmt(t.front.elastic, 0), unit: 'N' },
          { label: 'Rear total', value: fmt(t.rear.total, 0), unit: 'N' },
          { label: 'Rear, through links (roll center)', value: fmt(t.rear.geometric, 0), unit: 'N' },
          { label: 'Rear, through springs (body roll)', value: fmt(t.rear.elastic, 0), unit: 'N' },
          { label: 'Front share (LLTD)', value: Math.abs(t.front.total + t.rear.total) < 1 ? '—' : fmt(100 * t.lltdFront, 1), unit: '%', hint: 'Front axle share of the total lateral load transfer' },
          { label: 'Roll stiffness, front', value: fmt(model.rollStiffness.front, 0), unit: 'N·m/°', hint: 'Load moved through the springs (springs, anti-roll bar, heave spring) × track ÷ body roll, at this cornering. — without cornering' },
          { label: 'Roll stiffness, rear', value: fmt(model.rollStiffness.rear, 0), unit: 'N·m/°' },
          { label: 'Roll stiffness, front share', value: fmt(100 * model.rollStiffness.front / (model.rollStiffness.front + model.rollStiffness.rear), 1), unit: '%' },
          { label: 'Roll gradient', value: fmt(model.rollGradient, 2), unit: '°/g', hint: 'Body roll per g of cornering (this state)' },
        ]} />
      </Section>
      <Section title="Braking & acceleration">
        <FieldRows rows={[
          { label: 'Load moved onto the front axle', value: fmt(model.frontLoadGain, 0), unit: 'N', hint: 'Front axle load minus its static load (negative = moved to the rear)' },
          ...(r.hitch ? [
            { label: 'Hitch: tongue load (down on the car)', value: fmt(-r.hitch.force.y, 0), unit: 'N', hint: 'Static tongue weight plus the load shift from braking / accelerating' },
            { label: 'Hitch: trailer push (+) / pull (−)', value: fmt(r.hitch.force.z, 0), unit: 'N', hint: 'Along the car: + pushes it forward (braking without trailer brakes)' },
            { label: 'Hitch: side force on the car', value: fmt(r.hitch.force.x, 0), unit: 'N', hint: '+ = toward the left; cornering, the trailer pulls the hitch outward' },
          ] : []),
          ...(r.brakePedal ? [{ label: 'Pedal force this braking needs', value: `${fmt(r.brakePedal.needed, 0)} of ${fmt(r.brakePedal.max, 0)}`, unit: 'N', hint: 'Brake hydraulics: more than the most = the brakes are too weak for this braking' }] : []),
          { label: 'Anti-dive, braking (front)', value: fmt(model.antiDive, 1), unit: '%', hint: 'tan θ · (wheelbase / CG height) · front brake share; θ from the side-view IC (contact patch for outboard brakes, wheel center for inboard)' },
          { label: 'Anti-lift, braking (rear)', value: fmt(model.antiLift, 1), unit: '%' },
          { label: 'Anti-squat, accelerating (rear)', value: fmt(model.antiSquat, 1), unit: '%', hint: 'Powered rear corners: θ from the wheel center (chassis diff) or contact patch (hub motor), × rear drive share' },
          { label: 'Anti-lift, accelerating (front)', value: fmt(model.antiLiftAccel, 1), unit: '%', hint: 'Powered front corners' },
        ]} />
      </Section>
      <Section title="Corners">
        <table className="corner-table">
          <thead><tr><th /><th>Load <UnitLabel unit="N" /></th><th>Δ static</th><th title="Longitudinal tire force: − braking, + drive">Long. <UnitLabel unit="N" /></th><th>Travel <UnitLabel unit="mm" /></th><th>Incl. °</th><th>Toe °</th></tr></thead>
          <tbody>
            {corners.map(({ id, c, v, s }) => (
              <tr key={id} title={c.status !== 'ok' ? `At ${STATUS[c.status]}` : undefined} className={c.status !== 'ok' ? 'warn' : ''}>
                <td><b>{id}</b></td>
                <td><Num text={fmt(c.tireLoad, 0)} unit="N" /></td>
                <td><Num text={fmt(c.tireLoad - s, 0)} unit="N" /></td>
                <td><Num text={fmt(c.longitudinalForce, 0)} unit="N" /></td>
                <td><Num text={fmt(c.travel, 1)} unit="mm" />{c.status !== 'ok' ? ' !' : ''}</td>
                <td>{fmt(deg(c.inclination), 2)}</td>
                <td>{fmt(v ? deg(v.chars.toe) : NaN, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint">Inclination: wheel vs. ground, + = top toward that corner's outboard side. Toe: + = toe-in.</p>
      </Section>
    </section>
  );
}

function usePlay(active: boolean, period: number, onPhase: (s: number) => void) {
  const cb = useRef(onPhase);
  cb.current = onPhase;
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => { cb.current(Math.sin(((now - t0) / period) * Math.PI * 2)); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, period]);
}

export function VehicleMotionBar() {
  const lateralG = useApp((s) => s.lateralG);
  const playing = useApp((s) => s.playingLateral);
  const longG = useApp((s) => s.longitudinalG);
  const playingLong = useApp((s) => s.playingLongitudinal);
  const anyPowered = useApp((s) => Object.values(s.settings).some((c) => c.powered));
  const playingSteer = useApp((s) => s.playingSteer);
  const rack = useApp((s) => s.rack);
  const cFactor = useApp((s) => s.steer.cFactor.value);
  const cFactorLock = useApp((s) => s.steer.cFactorLock.value);
  const armMech = useApp((s) => s.geom.steerMechanism === 'arm');
  const rackLimit = useApp((s) => s.steer.rackLimit.value);
  const set = useApp((s) => s.set);
  const ratio = { cFactor, cFactorLock, rackLimit };
  const swLimit = steeringWheelAngle(rackLimit, ratio);
  usePlay(playing, 5000, (s) => useApp.getState().set('lateralG', Number((1.2 * s).toFixed(3))));
  usePlay(playingSteer, 5000, (s) => useApp.getState().set('rack', s * rackLimit));
  // Play: brake to 1.2 g, then (if any corner is powered) accelerate to 0.6 g.
  usePlay(playingLong, 5000, (s) => useApp.getState().set('longitudinalG', Number((s < 0 ? 1.2 * s : (anyPowered ? 0.6 : 0) * s).toFixed(3))));
  const setL = (g: number) => { set('rideView', null); set('playingLongitudinal', false); set('longitudinalG', g); };
  const setG = (g: number) => { set('rideView', null); set('playingLateral', false); set('lateralG', g); };
  const setRack = (r: number) => { set('playingSteer', false); set('rack', r); };
  return (
    <div className="motion-bar">
      <div className="motion-group">
        <label className="slider">
          <span>Lateral acceleration <b>{lateralG.toFixed(2)}</b> g {lateralG > 0 ? '(left turn)' : lateralG < 0 ? '(right turn)' : ''}</span>
          <input type="range" min={-2} max={2} step={0.01} value={lateralG} onChange={(e) => setG(Number(e.target.value))} onDoubleClick={() => setG(0)} />
          <span className="quick">
            <button onClick={() => setG(-1)}>−1 g</button>
            <button onClick={() => setG(0)}>0</button>
            <button onClick={() => setG(1)}>+1 g</button>
          </span>
        </label>
        <button className={playing ? 'active' : ''} onClick={() => set('playingLateral', !playing)} title="Animate ±1.2 g">
          {playing ? '❚❚' : '▶'} Corner
        </button>
      </div>
      <div className="motion-group">
        <label className="slider">
          <span>
            Longitudinal <b>{Math.abs(longG).toFixed(2)}</b> g {longG < 0 ? '(braking)' : longG > 0 ? '(accelerating)' : ''}
            {longG > 0 && !anyPowered && <em className="muted"> — no powered corners</em>}
          </span>
          <input type="range" min={-1.6} max={1.2} step={0.01} value={longG} onChange={(e) => setL(Number(e.target.value))} onDoubleClick={() => setL(0)} />
          <span className="quick">
            <button onClick={() => setL(-1)}>Brake 1 g</button>
            <button onClick={() => setL(0)}>0</button>
            <button onClick={() => setL(0.5)} disabled={!anyPowered}>Accel 0.5 g</button>
          </span>
        </label>
        <button className={playingLong ? 'active' : ''} onClick={() => set('playingLongitudinal', !playingLong)} title="Animate braking (and accelerating if any corner is powered)">
          {playingLong ? '❚❚' : '▶'} Brake/accel
        </button>
      </div>
      <div className="motion-group">
        <label className="slider">
          <span>Steering wheel <b>{steeringWheelAngle(rack, ratio).toFixed(0)}</b>° · {armMech ? <>arm <b>{rack.toFixed(1)}°</b></> : <>rack <b><Num text={rack.toFixed(1)} unit="mm" withUnit /></b></>}</span>
          <input type="range" min={-swLimit} max={swLimit} step={1} value={steeringWheelAngle(rack, ratio)} onChange={(e) => setRack(inputForWheelAngle(Number(e.target.value), ratio))} onDoubleClick={() => setRack(0)} />
          <span className="quick">
            <button onClick={() => setRack(-rackLimit)}>◀ Lock</button>
            <button onClick={() => setRack(0)}>0</button>
            <button onClick={() => setRack(rackLimit)}>Lock ▶</button>
          </span>
        </label>
        <button className={playingSteer ? 'active' : ''} onClick={() => set('playingSteer', !playingSteer)}>{playingSteer ? '❚❚' : '▶'} Steer</button>
      </div>
      <SpeedControl />
      <RoadControls />
    </div>
  );
}

/** Car speed (for aero): shown when aero is on. */
function SpeedControl() {
  const on = useApp((s) => s.aero.on);
  const speed = useApp((s) => s.vehicleSpeed);
  const set = useApp((s) => s.set);
  const conv = useConversion('m/s');
  if (!on) return null;
  return (
    <div className="motion-group">
      <label className="slider" title="The car's speed: drag and downforce grow with speed²">
        <span>Speed <b>{toDisplay(speed, conv).toFixed(0)}</b> {conv.unit} (aero)</span>
        <input type="range" min={0} max={90} step={0.5} value={speed} onChange={(e) => { set('rideView', null); set('vehicleSpeed', Number(e.target.value)); }} onDoubleClick={() => set('vehicleSpeed', 0)} />
      </label>
    </div>
  );
}

/** Towing a trailer (static): its forces at the hitch while the car corners, brakes and accelerates. */
function TowPanel() {
  const t = useApp((s) => s.tow);
  const setT = useApp((s) => s.setTow);
  const setF = useApp((s) => s.setTowField);
  return (
    <>
      <div className="jm-row" title="A trailer on a ball hitch behind the car: its tongue weight, and its pull / push and side force at the hitch as the car accelerates, brakes and corners (it follows the car; no sway).">
        <button className={`chip${!t.on ? ' on' : ''}`} onClick={() => setT({ on: false })}>No trailer</button>
        <button className={`chip${t.on ? ' on' : ''}`} onClick={() => setT({ on: true })}>Towing a trailer</button>
      </div>
      {t.on && <FieldRows rows={TOW_KEYS.map((k) => ({ label: TOW_META[k].label, field: t[k], unit: TOW_META[k].unit, hint: TOW_META[k].hint, onCommit: (x: string) => setF(k, x) }))} />}
    </>
  );
}

/** Brake hydraulics: off (brakes always strong enough) or pedal → master cylinders → calipers → rotors. */
function BrakePanel() {
  const b = useApp((s) => s.brakes);
  const setB = useApp((s) => s.setBrakes);
  const setF = useApp((s) => s.setBrakeField);
  const disp = useDisplay();
  const st = useApp.getState();
  const brk = brakesOf(st);
  const keys = BRAKE_KEYS.filter((k) => b.dualMc || k !== 'balanceFront');
  const mass = st.vehicle.mass.value;
  return (
    <>
      <div className="jm-row" title="Off: the brakes can always make the braking asked (only grip limits it). On: from the pedal through the master cylinders, calipers and rotors, the braking is limited to what they make at the most pedal force.">
        <button className={`chip${!b.on ? ' on' : ''}`} onClick={() => setB({ on: false })}>Off (always strong enough)</button>
        <button className={`chip${b.on ? ' on' : ''}`} onClick={() => setB({ on: true })}>Model the hydraulics</button>
      </div>
      {b.on && (
        <>
          <label className="check-row"><input type="checkbox" checked={b.dualMc} onChange={(e) => setB({ dualMc: e.target.checked })} /> Two master cylinders on a balance bar (else one tandem master cylinder)</label>
          <FieldRows rows={keys.map((k) => ({ label: BRAKE_META[k].label, field: b[k], unit: BRAKE_META[k].unit, hint: BRAKE_META[k].hint, onCommit: (t: string) => setF(k, t) }))} />
          <label className="check-row" title="Use the front / rear split the hydraulics make as the brake bias (instead of the Brake bias input)"><input type="checkbox" checked={b.useBias} onChange={(e) => setB({ useBias: e.target.checked })} /> Brake bias from the hydraulics</label>
          {brk && (
            <FieldRows rows={[
              { label: 'Line pressure at full pedal, front / rear', value: `${disp.format(brk.capacity.pressure.front, 'kPa', 0)} / ${disp.format(brk.capacity.pressure.rear, 'kPa', 0)}`, unit: '' },
              { label: 'Brake torque per wheel, front / rear', value: `${fmt(brk.capacity.torque.front, 0)} / ${fmt(brk.capacity.torque.rear, 0)}`, unit: 'N·m' },
              { label: 'Most braking force, front / rear axle', value: `${disp.format(brk.capacity.axleForce.front, 'N', 0)} / ${disp.format(brk.capacity.axleForce.rear, 'N', 0)}`, unit: '', hint: 'At the tires, at the most pedal force (grip may limit it sooner)' },
              { label: 'Most braking the brakes can make', value: fmt((brk.capacity.axleForce.front + brk.capacity.axleForce.rear) / (mass * 9.80665), 2), unit: 'g', hint: 'With the hydraulic split; the brake bias in use may reach less' },
              { label: 'Hydraulic bias (front share)', value: fmt(brk.capacity.bias * 100, 1), unit: '%' },
            ]} />
          )}
        </>
      )}
    </>
  );
}

function AeroBadge() {
  const aero = useApp((s) => s.aero);
  return <span className="muted small-text">{!aero.on ? 'off' : aero.file ? aero.file.name : 'generic'}</span>;
}

/** Road under the car: grade, bank and a bump / pothole under each wheel (steady state). */
function RoadControls() {
  const grade = useApp((s) => s.roadGrade);
  const bank = useApp((s) => s.roadBank);
  const bumps = useApp((s) => s.wheelBumps);
  const set = useApp((s) => s.set);
  const lenC = useConversion('mm');
  const anyBump = CORNER_IDS.some((id) => bumps[id] !== 0);
  return (
    <div className="motion-group road-group">
      <label className="slider" title="Road grade, % (+ = uphill)">
        <span>Grade <b>{grade.toFixed(0)}</b> % {grade > 0 ? '(uphill)' : grade < 0 ? '(downhill)' : ''}</span>
        <input type="range" min={-30} max={30} step={1} value={grade} onChange={(e) => set('roadGrade', Number(e.target.value))} onDoubleClick={() => set('roadGrade', 0)} />
      </label>
      <label className="slider" title="Road bank, deg (+ = left side lower)">
        <span>Bank <b>{bank.toFixed(0)}</b>°</span>
        <input type="range" min={-20} max={20} step={1} value={bank} onChange={(e) => set('roadBank', Number(e.target.value))} onDoubleClick={() => set('roadBank', 0)} />
      </label>
      <div className="bump-inputs" title="Ground height under each wheel: + bump, − pothole">
        <span className="muted">Bumps ({lenC.unit})</span>
        {CORNER_IDS.map((id) => (
          <label key={id} className="small">
            {id}
            <input type="number" step={lenC.identity ? 5 : 0.25} value={Number(toDisplay(bumps[id], lenC).toFixed(3))}
              onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) set('wheelBumps', { ...bumps, [id]: fromDisplay(v, lenC) }); }} />
          </label>
        ))}
        {(anyBump || grade !== 0 || bank !== 0) && (
          <button onClick={() => { set('wheelBumps', { FL: 0, FR: 0, RL: 0, RR: 0 }); set('roadGrade', 0); set('roadBank', 0); }}>Flat</button>
        )}
      </div>
    </div>
  );
}

const SLIP_TEXT: Record<SlipState, string> = { grip: 'grip', sliding: 'sliding', 'abs-limit': 'ABS limit', locked: 'locked', wheelspin: 'wheelspin' };

/** Grip use per tire and what limits the car (placeholder grip model). */
function GripSection({ grip }: { grip: GripSummary }) {
  return (
    <Section title="Grip (tires)" extra={<span className={`status ${grip.passed ? 'status-converged' : 'status-not-converged'}`}>{grip.passed ? 'All gripping' : 'Over the limit'}</span>}>
      <table className="corner-table grip-table">
        <thead><tr><th /><th title="Combined force ÷ what the tire can carry (friction ellipse, 100% = sliding)">Grip use</th><th>State</th><th title="Slip angle the tire needs for its side force (— = past its peak)">Slip</th><th title="Lean toward the turn: + gains camber thrust">Lean</th><th title="Peak force in the direction the tire pushes">Peak <UnitLabel unit="N" /></th></tr></thead>
        <tbody>
          {CORNER_IDS.map((id) => {
            const c = grip.corners[id];
            const cls = c.utilization > 1 ? 'bad' : c.utilization > 0.9 ? 'warn' : '';
            return (
              <tr key={id} className={cls}>
                <td><b>{id}</b></td>
                <td>{fmt(c.utilization * 100, 0)} %</td>
                <td>{SLIP_TEXT[c.state]}</td>
                <td>{Number.isFinite(c.slipAngle) ? `${fmt(Math.abs(c.slipAngle), 1)}°` : '—'}</td>
                <td>{fmt(c.camberToTurn, 1)}°</td>
                <td><Num text={fmt(c.capacity, 0)} unit="N" /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="small-text">Axles (cornering): front {fmt(grip.axles.front * 100, 0)} % · rear {fmt(grip.axles.rear * 100, 0)} %</p>
      {grip.limits.map((l) => <p key={l.text} className="hint warn-text">{l.text}</p>)}
      <p className="hint">Tire grip: Magic Formula with generic coefficients (edit in Optimize → Tire grip model). Lean = inclination toward the turn: leaning into it adds camber thrust.</p>
    </Section>
  );
}

export type { CornerId };
