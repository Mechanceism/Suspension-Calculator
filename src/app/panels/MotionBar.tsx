/**
 * Motion controls. Travel and load are linked through the spring, so both sliders are always shown:
 * dragging travel sets the position (and the load slider shows the load that position implies);
 * dragging load settles the corner on its spring (and the travel slider follows). Steering has its
 * own slider and Play so it can be animated together with either.
 */
import { steeringWheelAngle, inputForWheelAngle } from '../../core/tests/steer';
import { useConversion, toDisplay, fromDisplay } from '../units';
import { Num } from './UnitText';
import { useEffect, useRef } from 'react';
import { ratioSpecOf, useApp } from '../store';
import type { Model } from '../useModel';

function usePlayLoop(active: boolean, period: number, onPhase: (s: number) => void) {
  const cb = useRef(onPhase);
  cb.current = onPhase;
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      cb.current(Math.sin(((now - t0) / period) * Math.PI * 2));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, period]);
}

export function MotionBar({ model }: { model: Model }) {
  const travel = useApp((s) => s.travel);
  const rack = useApp((s) => s.rack);
  const driver = useApp((s) => s.driver);
  const droop = useApp((s) => s.droop);
  const bump = useApp((s) => s.bump);
  const rackLimit = useApp((s) => s.steer.rackLimit.value);
  const cFactor = useApp((s) => s.steer.cFactor.value);
  const cFactorLock = useApp((s) => s.steer.cFactorLock.value);
  const armMech = useApp((s) => s.geom.steerMechanism === 'arm');
  const playing = useApp((s) => s.playing);
  const playingSteer = useApp((s) => s.playingSteer);
  const mode = useApp((s) => s.mode);
  const loadFactor = useApp((s) => s.loadFactor);
  const set = useApp((s) => s.set);
  const steers = useApp((s) => s.settings[s.activeCorner].steered);
  const hasSpring = Boolean(model.corner?.geometry.damper);
  const loaded = mode === 'loaded' && hasSpring;
  const curveText = useApp((s) => s.steerCurve);
  const ratio = { ...ratioSpecOf({ steer: useApp.getState().steer, steerCurve: curveText }), cFactor, cFactorLock, rackLimit };
  const swLimit = steeringWheelAngle(rackLimit, ratio);
  const shownTravel = model.current?.travel ?? travel;
  const shownLoad = model.current?.loadFactor ?? loadFactor;
  const setTravel = (t: number) => { set('playing', false); set('mode', 'kinematic'); set('travel', t); };
  const setLoad = (f: number) => { set('playing', false); set('mode', 'loaded'); set('loadFactor', f); };
  const setRack = (r: number) => { set('playingSteer', false); set('rack', r); };

  // Play motion: drives whichever input is active (travel, or load when the corner is settling).
  usePlayLoop(playing, 4000, (s) => {
    if (useApp.getState().mode === 'loaded') useApp.getState().set('loadFactor', 1.1 + 0.8 * s);
    else useApp.getState().set('travel', s >= 0 ? s * bump : s * droop);
  });
  // Play steering: lock to lock.
  usePlayLoop(playingSteer, 5000, (s) => useApp.getState().set('rack', s * rackLimit));

  return (
    <div className="motion-bar">
      <div className={`motion-group${!loaded ? ' driving' : ''}`}>
        <label className="slider">
          <span>Travel <b><Num text={shownTravel.toFixed(1)} unit="mm" withUnit /></b> {!loaded && <em className="drive-tag">input</em>}</span>
          <input
            type="range" min={-droop} max={bump} step={0.5} value={shownTravel}
            onChange={(e) => { set('playing', false); set('mode', 'kinematic'); set('travel', Number(e.target.value)); }}
            onDoubleClick={() => setTravel(0)}
          />
          <span className="quick">
            <button onClick={() => setTravel(-droop)} title="Full droop">Droop</button>
            <button onClick={() => setTravel(0)} title="Design ride height">0</button>
            <button onClick={() => setTravel(bump)} title="Full bump">Bump</button>
          </span>
        </label>
        <label className="slider">
          <span>
            Load <b>{shownLoad.toFixed(2)}</b>× static
            {hasSpring ? (loaded && <em className="drive-tag">input</em>) : <em className="muted"> (needs a spring)</em>}
          </span>
          <input
            type="range" min={0} max={3} step={0.01} value={shownLoad} disabled={!hasSpring}
            onChange={(e) => { set('playing', false); set('mode', 'loaded'); set('loadFactor', Number(e.target.value)); }}
            onDoubleClick={() => setLoad(1)}
          />
          {hasSpring && (
            <span className="quick">
              <button onClick={() => setLoad(0)} title="No load (wheel hangs)">0×</button>
              <button onClick={() => setLoad(1)} title="Static load">1×</button>
              <button onClick={() => setLoad(2)} title="Twice static (e.g. a 1 g bump)">2×</button>
            </span>
          )}
        </label>
        <button className={playing ? 'active' : ''} onClick={() => set('playing', !playing)} title={loaded ? 'Animate load 0.3× – 1.9×' : 'Animate travel droop ↔ bump'}>
          {playing ? '❚❚' : '▶'} {loaded ? 'Load' : 'Travel'}
        </button>
      </div>
      <div className="motion-group">
        <label className="slider">
          <span>Steering wheel <b>{steeringWheelAngle(rack, ratio).toFixed(0)}</b>° · {armMech ? <>arm <b>{rack.toFixed(1)}°</b></> : <>rack <b><Num text={rack.toFixed(1)} unit="mm" withUnit /></b></>}{!steers && <em className="muted"> (this corner doesn't steer)</em>}</span>
          <input
            type="range" min={-swLimit} max={swLimit} step={1} value={steeringWheelAngle(rack, ratio)} disabled={!steers}
            onChange={(e) => { set('playingSteer', false); set('rack', inputForWheelAngle(Number(e.target.value), ratio)); }}
            onDoubleClick={() => setRack(0)}
          />
          <span className="quick">
            <button onClick={() => setRack(-rackLimit)} title="Full lock, rack inboard">◀ Lock</button>
            <button onClick={() => setRack(0)} title="Straight ahead">0</button>
            <button onClick={() => setRack(rackLimit)} title="Full lock, rack outboard">Lock ▶</button>
          </span>
        </label>
        <button className={playingSteer ? 'active' : ''} onClick={() => set('playingSteer', !playingSteer)} title="Animate steering lock to lock">
          {playingSteer ? '❚❚' : '▶'} Steer
        </button>
      </div>
      <div className="motion-group small-group">
        <TravelLimit label="Droop" value={droop} onChange={(v) => set('droop', v)} />
        <TravelLimit label="Bump" value={bump} onChange={(v) => set('bump', v)} />
        {!loaded && (
          <label className="small">
            Travel at
            <select value={driver} onChange={(e) => set('driver', e.target.value as typeof driver)}>
              <option value="wheelCenter">Wheel center</option>
              <option value="contactPatch">Contact patch</option>
            </select>
          </label>
        )}
      </div>
    </div>
  );
}

/** A travel limit (mm) entered in the display length unit. */
function TravelLimit({ label, value, onChange }: { label: string; value: number; onChange: (mm: number) => void }) {
  const c = useConversion('mm');
  const shown = Number(toDisplay(value, c).toFixed(c.identity ? 1 : 3));
  return (
    <label className="small" title={`${label} travel (wheel center), ${c.unit}`}>
      {label} <span className="muted">{c.unit}</span>
      <input type="number" value={shown} min={0} step={c.identity ? 1 : 0.1}
        onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(Math.min(300, Math.max(1, fromDisplay(v, c)))); }} />
    </label>
  );
}
