import { useEffect, useRef } from 'react';
import { CORNER_IDS, type CornerId } from '../../core/vehicle/vehicle';
import { deg } from '../../core/suspension/characteristics';
import { useApp, VEHICLE_KEYS, VEHICLE_META, CORNER_NAMES, rootOf, type CornerLinks } from '../store';
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
            <span className="corner-flags">{settings[id].steered ? 'S' : ''}{settings[id].powered ? 'P' : ''}</span>
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

export function VehicleInputs({ model }: { model: VehicleModel | null }) {
  const vehicle = useApp((s) => s.vehicle);
  const setVehicleField = useApp((s) => s.setVehicleField);
  const autoPreload = useApp((s) => s.autoPreload);
  const set = useApp((s) => s.set);
  const loads = model?.staticLoads;
  const total = loads ? CORNER_IDS.reduce((a, id) => a + loads[id], 0) : 0;
  return (
    <div className="inspector">
      <Section title="Vehicle">
        <FieldRows rows={VEHICLE_KEYS.map((k) => ({
          label: VEHICLE_META[k].label, field: vehicle[k], unit: VEHICLE_META[k].unit, hint: VEHICLE_META[k].hint,
          onCommit: (t: string) => setVehicleField(k, t),
        }))} />
        <p className="hint">Corner unsprung masses are set per corner (Spring &amp; load). The CG is the whole car at static ride height.</p>
      </Section>
      <Section title="Static corner weights (from CG)">
        {loads && (
          <>
            <table className="corner-grid">
              <tbody>
                <tr><td>FL <b>{fmt(loads.FL, 0)}</b> N</td><td>FR <b>{fmt(loads.FR, 0)}</b> N</td></tr>
                <tr><td>RL <b>{fmt(loads.RL, 0)}</b> N</td><td>RR <b>{fmt(loads.RR, 0)}</b> N</td></tr>
              </tbody>
            </table>
            <p className="hint">
              Front {fmt((100 * (loads.FL + loads.FR)) / total, 1)}% · Left {fmt((100 * (loads.FL + loads.RL)) / total, 1)}%
              · Total {fmt(total / G, 1)} kg
            </p>
          </>
        )}
        <label className="check-row">
          <input type="checkbox" checked={autoPreload} onChange={() => set('autoPreload', !autoPreload)} />
          Set spring preload per corner for design ride height
        </label>
        <p className="hint">Like adjusting each coilover's collar: each corner's free length is fitted to its static weight. Off = use each corner's own free length.</p>
      </Section>
      <Section title="Corners">
        <CornerSetup />
      </Section>
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
      <Section title="Body">
        <FieldRows rows={[
          { label: 'Roll', value: fmt(deg(r.pose.roll), 3), unit: '°', hint: '+ = top leans toward −X (right)' },
          { label: 'Pitch', value: fmt(deg(r.pose.pitch), 3), unit: '°', hint: '+ = nose up' },
          { label: 'Heave', value: fmt(r.pose.heave, 2), unit: 'mm', hint: 'chassis rise from design' },
          { label: 'Ride height, front axle', value: fmt(model.rideHeight.front, 1), unit: 'mm', hint: 'frame bottom to ground' },
          { label: 'Ride height, rear axle', value: fmt(model.rideHeight.rear, 1), unit: 'mm' },
          { label: 'Roll center height, front', value: fmt(model.rollCenters.front?.h, 1), unit: 'mm', hint: 'from the actual left/right corners' },
          { label: 'Roll center height, rear', value: fmt(model.rollCenters.rear?.h, 1), unit: 'mm' },
          { label: 'Roll center lateral, front', value: fmt(model.rollCenters.front?.x, 1), unit: 'mm', hint: '+ = left of centerline' },
          { label: 'Rollover threshold (rigid)', value: fmt(model.rolloverG, 2), unit: 'g', hint: 'half track ÷ CG height' },
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
        ]} />
      </Section>
      <Section title="Corners">
        <table className="corner-table">
          <thead><tr><th /><th>Load N</th><th>Δ static</th><th>Travel</th><th>Incl. °</th><th>Toe °</th></tr></thead>
          <tbody>
            {corners.map(({ id, c, v, s }) => (
              <tr key={id} title={c.status !== 'ok' ? `At ${STATUS[c.status]}` : undefined} className={c.status !== 'ok' ? 'warn' : ''}>
                <td><b>{id}</b></td>
                <td>{fmt(c.tireLoad, 0)}</td>
                <td>{fmt(c.tireLoad - s, 0)}</td>
                <td>{fmt(c.travel, 1)}{c.status !== 'ok' ? ' !' : ''}</td>
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
  const playingSteer = useApp((s) => s.playingSteer);
  const rack = useApp((s) => s.rack);
  const cFactor = useApp((s) => s.steer.cFactor.value);
  const rackLimit = useApp((s) => s.steer.rackLimit.value);
  const set = useApp((s) => s.set);
  const swLimit = (rackLimit / cFactor) * 360;
  usePlay(playing, 5000, (s) => useApp.getState().set('lateralG', Number((1.2 * s).toFixed(3))));
  usePlay(playingSteer, 5000, (s) => useApp.getState().set('rack', s * rackLimit));
  const setG = (g: number) => { set('playingLateral', false); set('lateralG', g); };
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
          <span>Steering wheel <b>{((rack / cFactor) * 360).toFixed(0)}</b>° · rack <b>{rack.toFixed(1)}</b> mm</span>
          <input type="range" min={-swLimit} max={swLimit} step={1} value={(rack / cFactor) * 360} onChange={(e) => setRack((Number(e.target.value) / 360) * cFactor)} onDoubleClick={() => setRack(0)} />
          <span className="quick">
            <button onClick={() => setRack(-rackLimit)}>◀ Lock</button>
            <button onClick={() => setRack(0)}>0</button>
            <button onClick={() => setRack(rackLimit)}>Lock ▶</button>
          </span>
        </label>
        <button className={playingSteer ? 'active' : ''} onClick={() => set('playingSteer', !playingSteer)}>{playingSteer ? '❚❚' : '▶'} Steer</button>
      </div>
    </div>
  );
}

export type { CornerId };
