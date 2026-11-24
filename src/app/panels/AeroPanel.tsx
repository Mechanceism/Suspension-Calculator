/**
 * Aerodynamics inputs: off (negligible, the default), generic values (drag area, downforce areas front /
 * rear, drag height, air), or characteristics imported from a file (constants or a ride-height map, e.g.
 * exported from a CFD tool; format in docs/MATH.md § Aero). Shows what they mean at a reference speed.
 */
import { useRef } from 'react';
import { parseAero } from '../../core/vehicle/aero';
import { aeroForces } from '../../core/vehicle/aero';
import { useApp, AERO_KEYS, AERO_META } from '../store';
import { aeroOf } from '../optimizer';
import { FieldRows, fmt } from './FieldRows';
import { useDisplay } from '../units';
import { Local, Val } from './UnitText';

/** Load aero characteristics (File → Import → Aero data, or the Aero panel). */
export async function importAeroFile(file: File) {
  const s = useApp.getState();
  const r = parseAero(await file.text(), file.name.replace(/\.[^.]+$/, ''));
  if (!r.model) { s.notify(`Couldn't use ${file.name}:\n${r.errors.join('\n')}`, 'error'); return; }
  s.setAero({ on: true, file: r.model });
  s.notify(`Aero from ${file.name}${r.model.map ? ` (map: ${r.model.map.rhFront.length} × ${r.model.map.rhRear.length} ride heights)` : ''}.${r.warnings.length ? `\n${r.warnings.join('\n')}` : ''}`, r.warnings.length ? 'warn' : 'info');
}

export function AeroPanel() {
  const aero = useApp((s) => s.aero);
  const setAero = useApp((s) => s.setAero);
  const setField = useApp((s) => s.setAeroField);
  const input = useRef<HTMLInputElement>(null);
  const disp = useDisplay();
  const a = aeroOf({ aero });
  const at = (v: number) => (a ? aeroForces({ ...a, speed: v }, { front: 0, rear: 0 }, { front: 0, rear: 0 }) : null);
  const ref = 100 / 3.6;
  const f = at(ref);
  const down = f ? -(f.liftF + f.liftR) : 0;
  return (
    <>
      <div className="jm-row" title="Off = aerodynamic forces are negligible (slow cars). On: drag on the body and downforce / lift at each axle, at the car's speed.">
        <button className={`chip${!aero.on ? ' on' : ''}`} onClick={() => setAero({ on: false })}>Off (negligible)</button>
        <button className={`chip${aero.on && !aero.file ? ' on' : ''}`} onClick={() => setAero({ on: true, file: null })}>Generic values</button>
        {aero.file && <button className={`chip${aero.on ? ' on' : ''}`} onClick={() => setAero({ on: true })}>{aero.file.name}</button>}
        <button className="chip" onClick={() => input.current?.click()} title="Aero characteristics from a file: constants or a ride-height map (JSON or CSV; e.g. from a CFD tool)">Import aero data</button>
        <input ref={input} type="file" accept=".json,.csv,.txt" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) void importAeroFile(file); e.target.value = ''; }} />
      </div>
      {aero.on && !aero.file && (
        <FieldRows rows={AERO_KEYS.map((k) => ({ label: AERO_META[k].label, field: aero[k], unit: AERO_META[k].unit, hint: AERO_META[k].hint, onCommit: (t: string) => setField(k, t) }))} />
      )}
      {aero.on && aero.file && (
        <>
          <p className="hint">
            <b>{aero.file.name}</b>: {aero.file.map ? `map over ${aero.file.map.rhFront.length} front × ${aero.file.map.rhRear.length} rear ride heights (${aero.file.rideHeightRef === 'change' ? 'change from design' : 'absolute'}, mm)` : 'constant coefficients'}
            {' '}· drag at <Val v={aero.file.dragHeight} unit="mm" digits={0} />. Saved in your project.
          </p>
          <FieldRows rows={(['altitude', 'temperature'] as const).map((k) => ({ label: AERO_META[k].label, field: aero[k], unit: AERO_META[k].unit, hint: AERO_META[k].hint, onCommit: (t: string) => setField(k, t) }))} />
          <div className="jm-row"><button className="chip" onClick={() => setAero({ file: null })}>Remove the file (generic values)</button></div>
        </>
      )}
      {a && f && (
        <p className="small-text">
          At {disp.format(ref, 'm/s', 0)}: drag <b>{disp.format(f.drag, 'N', 0)}</b> · downforce <b>{disp.format(down, 'N', 0)}</b>
          {Math.abs(down) > 1e-6 ? ` (${fmt((-f.liftF / down) * 100, 0)} % front)` : ''} · air {fmt(a.rho, 3)} kg/m³
          {a.model.map ? ' · at the design ride height' : ''}. Forces grow with speed².
        </p>
      )}
      <p className="hint">
        Drag acts on the body (the tires must drive against it; up high it moves load rearward); downforce / lift acts on the body
        at each axle, so it loads the tires and pitches the car. Tests use each moment&apos;s speed; the Vehicle view has a speed slider.
      </p>
    </>
  );
}
