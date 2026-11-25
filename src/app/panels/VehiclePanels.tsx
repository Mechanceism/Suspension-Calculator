import { usePlayLoop } from '../playLoop';
import { vehicleResultRows } from '../resultRows';
import { steeringWheelAngle, inputForWheelAngle } from '../../core/tests/steer';
import { useEffect, useMemo, useRef } from 'react';
import { Num, UnitLabel } from './UnitText';
import { openWizard, EstimatedNote } from './SetupWizard';
import { AeroPanel } from './AeroPanel';
import { PowertrainPanel, PowertrainBadge } from './PowertrainPanel';
import { brakesOf, buildVehicleProblem } from '../optimizer';
import { shimmyReport, shimmyKicks } from '../../core/optimize/shimmyOf';
import type { ShimmyScan } from '../../core/vehicle/shimmy';
import { maxRotor, fitsWheel, pedalTravel, brakeFixes, pedalFixes } from '../../core/vehicle/brakes';
import { hardestUse } from '../brakeLadder';
import { useRun } from './TestsPanels';
import { useConversion, toDisplay, fromDisplay, useDisplay } from '../units';
import type { GripSummary, SlipState } from '../../core/vehicle/vehicle';
import { LocksPanel } from './LocksPanel';
import { VehicleOptimizePanel } from './OptimizePanel';
import { CORNER_IDS, type CornerId } from '../../core/vehicle/vehicle';
import { deg } from '../../core/suspension/characteristics';
import { isOneAxle, SUSPENSION_LABELS } from '../../core/suspension/doubleWishbone';
import { angleInput, ratioSpecOf,
  useApp, VEHICLE_KEYS, VEHICLE_META, CORNER_NAMES, SHARED_META, rootOf, resolvedCorner, canSteer,
  type CornerLinks, type DiffType, type Axle, type SharedDesign,
  BRAKE_KEYS, BRAKE_META, FADE_KEYS, FADE_META, BRAKE_MORE_META, type BrakeMoreKey, SHIMMY_KEYS, SHIMMY_META, TOW_KEYS, TOW_META,
} from '../store';
import type { BrakeMount } from '../../core/vehicle/vehicle';
import { ValueInput } from './ValueInput';
import type { VehicleModel } from '../useVehicle';
import { FieldRows, Section, fmt } from './FieldRows';
import { Local, Val } from './UnitText';

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
  // A solid axle or twist beam is one part under both wheels: its left / right link can't be undone.
  const axleKind = (s: Parameters<typeof resolvedCorner>[0], id: CornerId) => { const k = resolvedCorner(s, id).geom.kind; return isOneAxle(k) ? k! : null; };
  const frontAxle = useApp((s) => axleKind(s, 'FL'));
  const rearAxle = useApp((s) => axleKind(s, 'RL'));
  const activeKind = useApp((s) => resolvedCorner(s, s.activeCorner).geom.kind);
  const lockedBy = (k: keyof CornerLinks) => (k === 'frontPair' ? frontAxle : k === 'rearPair' ? rearAxle : null);
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
        <label className="check-inline" title={canSteer(activeKind) ? undefined : "A twist beam doesn't steer: its hub is fixed to the trailing arm (no knuckle or tie rod)"}>
          <input type="checkbox" checked={settings[active].steered} disabled={!canSteer(activeKind) && !settings[active].steered} onChange={(e) => setCornerSetting(active, 'steered', e.target.checked)} />
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
            <label key={k} className="check-row" title={lockedBy(k) && links[k] ? `${SUSPENSION_LABELS[lockedBy(k)!]}: one axle under both wheels, so left and right share one design` : undefined}>
              <input type="checkbox" checked={links[k]} disabled={!!lockedBy(k) && links[k]} onChange={(e) => setLink(k, e.target.checked)} />
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
      <Section title="Powertrain" open={false} extra={<PowertrainBadge />}>
        <PowertrainPanel />
      </Section>
      <Section title="Towing" open={false} extra={<span className="muted small-text">{useApp.getState().tow.on ? 'trailer' : 'off'}</span>}>
        <TowPanel />
      </Section>
      <Section title="Brake system" open={false} extra={<span className="muted small-text">{useApp.getState().brakes.on ? 'hydraulics' : 'off'}</span>}>
        <BrakePanel />
      </Section>
      <Section title="Shimmy / death wobble" open={false}>
        <ShimmyPanel />
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
          <div className="row" title="What the drop link is fixed to. On a pushrod layout's rocker the bar works through the rocker's motion ratio (on corners without a rocker it goes on the knuckle).">
            <span className="muted">Drop link on</span>
            <select value={sh.dropLinkOn ?? 'lca'} onChange={(e) => setShared(axle, { dropLinkOn: e.target.value as NonNullable<SharedDesign['dropLinkOn']> })}>
              <option value="lca">Lower arm</option>
              <option value="uca">Upper arm</option>
              <option value="upright">Knuckle / upright</option>
              <option value="rocker">Rocker (pushrod layouts)</option>
            </select>
          </div>
          <div className="row drop-link">
            <span className="muted" title="Where the drop link attaches (corner frame; mirrored for the right side)">Drop link mount</span>
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
  // The rows (shared with the Compare tab).
  const shared = vehicleResultRows(model);
  return (
    <section className="panel">
      <h2>
        Vehicle results
        <span className={`status ${r.converged ? 'status-converged' : 'status-not-converged'}`}>{r.converged ? 'Settled' : 'Not converged'}</span>
      </h2>
      <EstimatedNote />
      {r.grip && <GripSection grip={r.grip} />}
      {(['Aero', 'Body', 'Lateral load transfer', 'Braking & acceleration'] as const).map((g) => {
        const rows = shared.filter((x) => x.group === g);
        return rows.length ? (
          <Section key={g} title={g}>
            <FieldRows rows={rows.map((x) => ({ label: x.label, unit: x.unit, hint: x.hint, value: x.text ?? (x.of !== undefined ? `${fmt(x.value, x.digits)} of ${fmt(x.of, x.digits)}` : fmt(x.value, x.digits)) }))} />
          </Section>
        ) : null;
      })}
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

const usePlay = usePlayLoop;

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
  const armMech = useApp((s) => angleInput(s.geom.steerMechanism));
  const rackLimit = useApp((s) => s.steer.rackLimit.value);
  const set = useApp((s) => s.set);
  const curveText = useApp((s) => s.steerCurve);
  const ratio = { ...ratioSpecOf({ steer: useApp.getState().steer, steerCurve: curveText }), cFactor, cFactorLock, rackLimit };
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
          <span>Steering wheel <b>{steeringWheelAngle(rack, ratio).toFixed(0)}</b>° · {armMech ? <>{useApp.getState().geom.steerMechanism === 'centerLink' ? 'pitman' : 'arm'} <b>{rack.toFixed(1)}°</b></> : <>rack <b><Num text={rack.toFixed(1)} unit="mm" withUnit /></b></>}</span>
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
  const setFade = useApp((s) => s.setFadeField);
  const disp = useDisplay();
  const st = useApp.getState();
  const brk = brakesOf(st);
  const setMore = useApp((s) => s.setBrakeMoreField);
  const results = useRun((r) => r.results);
  // Disc fields only on a disc axle; a drum axle shows its own (wheel cylinder, drum, shoe factor).
  const DISC_F: string[] = ['pistonDiaF', 'pistonsF', 'padMuF', 'rotorRF'], DISC_R: string[] = ['pistonDiaR', 'pistonsR', 'padMuR', 'rotorRR'];
  const keys = BRAKE_KEYS.filter((k) => (b.dualMc || k !== 'balanceFront') && !(b.drumF && DISC_F.includes(k)) && !(b.drumR && DISC_R.includes(k)));
  const moreKeys = (ks: BrakeMoreKey[]) => ks.map((k) => ({ label: BRAKE_MORE_META[k].label, field: b[k], unit: BRAKE_MORE_META[k].unit, hint: BRAKE_MORE_META[k].hint, onCommit: (t: string) => setMore(k, t) }));
  const drumKeys: BrakeMoreKey[] = [...(b.drumF ? ['wcBoreF', 'drumRF', 'brakeFactorF'] as const : []), ...(b.drumR ? ['wcBoreR', 'drumRR', 'brakeFactorR'] as const : [])];
  const mass = st.vehicle.mass.value;
  // Fit in the wheel, the pedal (detailed hydraulics) and what the last test runs asked of the brakes.
  const fit = brk ? (['front', 'rear'] as const).map((a) => ({ a, m: maxRotor(brk.room[a]), ok: fitsWheel(brk.system[a], brk.room[a]), drum: brk.system[a].kind === 'drum' })) : [];
  const full = brk?.detail ? pedalTravel(brk.system, brk.detail, 1) : null;
  const use = hardestUse(Object.values(results).map((e) => e.result));
  const worst = use ? Math.max(use.front, use.rear) : 0;
  return (
    <>
      <div className="jm-row" title="Off: the brakes can always make the braking asked (only grip limits it). On: from the pedal through the master cylinders, calipers and rotors, the braking is limited to what they make at the most pedal force.">
        <button className={`chip${!b.on ? ' on' : ''}`} onClick={() => setB({ on: false })}>Off (always strong enough)</button>
        <button className={`chip${b.on ? ' on' : ''}`} onClick={() => setB({ on: true })}>Model the hydraulics</button>
      </div>
      {b.on && (
        <>
          <label className="check-row"><input type="checkbox" checked={b.dualMc} onChange={(e) => setB({ dualMc: e.target.checked })} /> Two master cylinders on a balance bar (else one tandem master cylinder)</label>
          <div className="jm-row" title="Disc: a caliper clamps a rotor. Drum: a wheel cylinder pushes two shoes out into a drum; the shoes wrap into it (more torque per pressure) and fade sooner.">
            {(['F', 'R'] as const).map((x) => (
              <label key={x} className="check-label">{x === 'F' ? 'Front' : 'Rear'}{' '}
                <select value={(x === 'F' ? b.drumF : b.drumR) ? 'drum' : 'disc'} onChange={(e) => setB(x === 'F' ? { drumF: e.target.value === 'drum' } : { drumR: e.target.value === 'drum' })}>
                  <option value="disc">Disc</option><option value="drum">Drum</option>
                </select>
              </label>
            ))}
          </div>
          <FieldRows rows={keys.map((k) => ({ label: BRAKE_META[k].label, field: b[k], unit: BRAKE_META[k].unit, hint: BRAKE_META[k].hint, onCommit: (t: string) => setF(k, t) }))} />
          {drumKeys.length > 0 && <FieldRows rows={moreKeys(drumKeys)} />}
          <FieldRows rows={moreKeys(['brakeRoom', 'padHeight'])} />
          {fit.map(({ a, m, ok, drum }) => (
            <p key={a} className={`small-text ${ok ? 'muted' : 'bad-text'}`} title="From the rim diameter, the room for the caliper and the pad height">
              {a === 'front' ? 'Front' : 'Rear'} wheel fits <Local text={drum ? `a drum up to ${fmt(m.drumRadius, 0)} mm radius` : `a rotor up to ${fmt(m.diameter, 0)} mm (effective radius ${fmt(m.effectiveRadius, 0)} mm)`} />{ok ? '' : ': the brake is larger than fits!'}
            </p>
          ))}
          <div className="jm-row" title="Simple: pressure and force only. Detailed: also the fluid the master cylinder pushes, so the pedal travel and the master cylinder's stroke (Long pedal, Master cylinder runs out in the tests).">
            <span className="muted">Hydraulics</span>
            <button className={`chip${!b.detail ? ' on' : ''}`} onClick={() => setB({ detail: false })}>Simple</button>
            <button className={`chip${b.detail ? ' on' : ''}`} onClick={() => setB({ detail: true })}>Detailed (pedal travel)</button>
          </div>
          {b.detail && <FieldRows rows={moreKeys(['mcStroke', 'maxPedalTravel', 'padClearance', ...(b.drumF || b.drumR ? ['shoeClearance' as const] : []), 'complianceF', 'complianceR'])} />}
          {full && (
            <FieldRows rows={[
              { label: 'Pedal travel at the most pedal force', value: fmt(full.pedal, 0), unit: 'mm', hint: 'Pads closing their clearance plus the circuits swelling at full pressure, through the master cylinders and the pedal ratio' },
              { label: 'Master-cylinder stroke used', value: fmt(full.strokeUse * 100, 0), unit: '%' },
            ]} />
          )}
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
          {use && (
            <div className="small-text" title="From the last run of each test (Tests workspace): the hardest stop's braking divided by what the (faded) brakes make at the most pedal force">
              <p className={worst > 1 ? 'bad-text' : 'muted'}>Last test runs: the hardest stop needs {fmt(use.front * 100, 0)} % of the front brakes, {fmt(use.rear * 100, 0)} % of the rear{worst > 1 ? ': too weak.' : '.'}</p>
              {worst > 1 && brk && (
                <>
                  <p className="muted">What would fix it (any one of these, per axle):</p>
                  <ul className="fix-list">
                    {(['front', 'rear'] as const).filter((a) => use[a] > 1).flatMap((a) => brakeFixes(brk.system[a], use[a], brk.room[a]).map((f) => (
                      <li key={`${a}${f.what}`} className={f.fits ? '' : 'muted'}>{a === 'front' ? 'Front' : 'Rear'} {f.what.toLowerCase()}: {fmt(f.now, 2)} → {fmt(f.needed, 2)} {f.unit}{f.fits ? '' : ' (does not fit / not available)'}</li>
                    )))}
                    {pedalFixes(brk.system, worst).map((f) => <li key={f.what} className={f.fits ? '' : 'muted'}>{f.what}: {fmt(f.now, 2)} → {fmt(f.needed, 2)} {f.unit}{f.fits ? '' : ' (beyond the usual)'}</li>)}
                  </ul>
                  <p className="muted">Or let the brake ladder pick sizes: Tests → Optimize → Brakes (step ladder).</p>
                </>
              )}
            </div>
          )}
          <label className="check-row" title="Tests heat the rotors with every stop (and cool them with the air); hot pads lose grip, so a long or repeated stop can need more pedal force than the driver has."><input type="checkbox" checked={b.fade} onChange={(e) => setB({ fade: e.target.checked })} /> Brake fade in tests (rotors heat up, pads lose grip when hot)</label>
          {b.fade && <FieldRows rows={FADE_KEYS.map((k) => ({ label: FADE_META[k].label, field: b[k], unit: FADE_META[k].unit, hint: FADE_META[k].hint, onCommit: (t: string) => setFade(k, t) }))} />}
          {b.fade && (b.drumF || b.drumR) && <FieldRows rows={moreKeys(['drumFadeK'])} />}
        </>
      )}
    </>
  );
}

/** Shimmy: the inputs and, live, whether the front wheels' steer oscillation dies out (new / worn parts). */
function ShimmyPanel() {
  const m = useApp((s) => s.shimmy);
  const setF = useApp((s) => s.setShimmyField);
  const setM = useApp((s) => s.setShimmy);
  const disp = useDisplay();
  const geom = useApp((s) => s.geom), corners = useApp((s) => s.corners), steer = useApp((s) => s.steer), vehicle = useApp((s) => s.vehicle), settings = useApp((s) => s.settings);
  const rep = useMemo(() => {
    try {
      const { problem } = buildVehicleProblem(useApp.getState());
      const r = shimmyReport(problem, undefined, 40);
      const kick = r ? shimmyKicks(problem, problem.shimmy!.maxSpeed) : null;
      return r ? { r, kick } : null;
    } catch { return null; }
  }, [m, geom, corners, steer, vehicle, settings]);
  const kmh = (u: number) => disp.format(u, 'm/s', 0);
  const line = (sc: ShimmyScan) => sc.onset !== null
    ? <span className="bad-text">shimmies from {kmh(sc.onset)} (least damping {fmt(sc.minZeta, 3)} at {kmh(sc.worstSpeed)})</span>
    : <span className={sc.minZeta < 0.05 ? 'warn-text' : 'ok-text'}>stable to {kmh(m.shimMaxSpeed.value)} (least damping {fmt(sc.minZeta, 3)} at {kmh(sc.worstSpeed)})</span>;
  return (
    <>
      <p className="hint">The front wheels' oscillation about their steering axes (4–25 Hz): trail and tire relaxation, the steering system's stiffness and damping, the steering wheel, and on a steered solid axle its tramp with the wheels' gyroscopic coupling (death wobble). Checked with new parts and worn ones (free play, softer, a tired damper). The car's path is held straight in this model, so the slow hands-off steering response isn't judged.</p>
      <FieldRows rows={SHIMMY_KEYS.map((k) => ({ label: SHIMMY_META[k].label, field: m[k], unit: SHIMMY_META[k].unit, hint: SHIMMY_META[k].hint, onCommit: (t: string) => setF(k, t) }))} />
      <label className="check-row" title="Hands lightly on the wheel (else hands off, the worst case)"><input type="checkbox" checked={m.handsOn} onChange={(e) => setM({ handsOn: e.target.checked })} /> Driver's hands lightly on the wheel</label>
      <label className="check-row" title="Each test kicks the front wheels at its fastest speeds (one-sided bump) with new and worn parts: Shimmy fails when they keep wobbling"><input type="checkbox" checked={m.check} onChange={(e) => setM({ check: e.target.checked })} /> Check shimmy in the tests</label>
      {!rep ? <p className="muted small-text">The front corners don't steer (or the design can't be solved): no shimmy model.</p> : (
        <div className="small-text">
          <p>New parts: {line(rep.r.fresh)}</p>
          <p>Worn parts: {line(rep.r.worn)}</p>
          {rep.kick && <p className={rep.kick.worn.shimmies || rep.kick.fresh.shimmies ? 'bad-text' : 'muted'}>Kicked at {kmh(m.shimMaxSpeed.value)} (free play and wheel imbalance as set): {rep.kick.fresh.shimmies ? 'wobbles even with new parts' : rep.kick.worn.shimmies ? `wobbles with worn parts (${fmt(rep.kick.worn.late, 2)}° a second later)` : 'settles'}.</p>}
          <p className="muted">Trail <Val v={rep.r.params.trail * 1000} unit="mm" digits={0} /> + pneumatic <Val v={rep.r.params.pneumaticTrail * 1000} unit="mm" digits={0} />{steer.pneumaticTrail.value > 0 ? '' : ' (estimated)'}, relaxation length <Val v={rep.r.params.relaxation * 1000} unit="mm" digits={0} />{vehicle.relaxation.value > 0 ? '' : ' (estimated)'}{rep.r.params.axle ? ', solid axle: tramp included' : ''}. Goal: Vehicle → Optimize → Shimmy margin.</p>
        </div>
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
      {grip.limits.map((l) => <p key={l.text} className="hint warn-text"><Local text={l.text} /></p>)}
      <p className="hint">Tire grip: Magic Formula with generic coefficients (edit in Optimize → Tire grip model). Lean = inclination toward the turn: leaning into it adds camber thrust.</p>
    </Section>
  );
}

export type { CornerId };
