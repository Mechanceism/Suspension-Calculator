/**
 * Powertrain inputs (round 4, F5): none (only the tires limit the drive, as before), electric or gas, through one
 * gear. Shows what it gives the car: the push at a few speeds and the top speed (the redline or the drag).
 */
import { useMemo } from 'react';
import { useApp, PT_KEYS, PT_META, PT_GAS_ONLY, ELECTRIC_DEFAULTS, defaultPowertrain, type PowertrainSettings } from '../store';
import { buildVehicleProblem, powertrainOf } from '../optimizer';
import { assembleVehicle } from '../../core/optimize/vehicle';
import { drivenRadius } from '../../core/tests/run';
import { aeroForces } from '../../core/vehicle/aero';
import { wheelDrive, topSpeed } from '../../core/vehicle/powertrain';
import { formatValue } from '../../core/units/units';
import { FieldRows, fmt } from './FieldRows';
import { useDisplay } from '../units';

const G = 9.80665;

export function PowertrainBadge() {
  const kind = useApp((s) => s.powertrain.kind);
  return <span className="muted small-text">{kind === 'none' ? 'off' : kind}</span>;
}

/** Switching to electric from the (gas) defaults takes typical electric values. */
function switchKind(kind: PowertrainSettings['kind']) {
  const s = useApp.getState();
  const pt = s.powertrain;
  if (kind === 'electric' && pt.kind !== 'electric') {
    const d = defaultPowertrain();
    const untouched = PT_KEYS.every((k) => pt[k].value === d[k].value);
    if (untouched) {
      const patch: Partial<PowertrainSettings> = { kind };
      for (const [k, v] of Object.entries(ELECTRIC_DEFAULTS) as [keyof typeof ELECTRIC_DEFAULTS, number][]) patch[k] = { text: formatValue(v, PT_META[k].quantity), value: v };
      s.setPowertrain(patch);
      return;
    }
  }
  s.setPowertrain({ kind });
}

export function PowertrainPanel() {
  const pt = useApp((s) => s.powertrain);
  const setField = useApp((s) => s.setPowertrainField);
  const disp = useDisplay();
  // What it gives this car: the driven wheels' radius, the mass, drag and rolling resistance.
  const vehicle = useApp((s) => s.vehicle), corners = useApp((s) => s.corners), settings = useApp((s) => s.settings), aero = useApp((s) => s.aero);
  const info = useMemo(() => {
    const p = powertrainOf({ powertrain: pt });
    if (!p) return null;
    const prob = buildVehicleProblem(useApp.getState()).problem;
    const asm = assembleVehicle(prob, Object.fromEntries(Object.entries(prob.designs).map(([r, d]) => [r, d!.geometry])));
    if (!asm) return null;
    const r = drivenRadius(prob, asm);
    const dragArea = prob.aero ? aeroForces({ model: prob.aero.model, rho: prob.aero.rho, speed: 10 }, { front: -asm.groundY, rear: -asm.groundY }, { front: -asm.groundY, rear: -asm.groundY }).drag / 100 : 0;
    const rolling = (prob.rollingResistance ?? 0) * prob.mass * G;
    const top = topSpeed(p, r, dragArea, rolling);
    const speeds = [0, 0.25, 0.5, 0.75, 1].map((k) => k * top.v);
    return { r, top, mass: prob.mass, dragArea, rows: speeds.map((v) => ({ v, ...wheelDrive(p, v, r), drag: dragArea * v * v + rolling })), powered: prob.settings && Object.values(prob.settings).some((c) => c.drive !== 'none') };
  }, [pt, vehicle, corners, settings, aero]);
  const keys = PT_KEYS.filter((k) => pt.kind === 'gas' || !PT_GAS_ONLY.includes(k));
  return (
    <>
      <div className="jm-row" title="None: only the tires limit how hard the car accelerates (as before). Electric or gas: the motor / engine through one gear limits it too, and with speeds set to Grip only it sets the top speed.">
        <button className={`chip${pt.kind === 'none' ? ' on' : ''}`} onClick={() => switchKind('none')}>None</button>
        <button className={`chip${pt.kind === 'electric' ? ' on' : ''}`} onClick={() => switchKind('electric')}>Electric</button>
        <button className={`chip${pt.kind === 'gas' ? ' on' : ''}`} onClick={() => switchKind('gas')}>Gas</button>
      </div>
      {pt.kind !== 'none' && (
        <FieldRows rows={keys.map((k) => ({ label: PT_META[k].label, field: pt[k], unit: PT_META[k].unit, hint: PT_META[k].hint, onCommit: (t: string) => setField(k, t) }))} />
      )}
      {info && !info.powered && <p className="hint">No corner is powered: the powertrain has nothing to drive (Corner box → Powered).</p>}
      {info && info.powered && (
        <>
          <table className="compare-table small-text">
            <thead><tr><th>Speed</th><th>rpm</th><th>Torque</th><th>Power</th><th title="The powertrain's push at the wheels ÷ the car's weight">Push</th><th title="Aero drag + rolling resistance ÷ the car's weight">Drag</th></tr></thead>
            <tbody>
              {info.rows.map((x, i) => (
                <tr key={i}>
                  <td className="num">{disp.format(x.v, 'm/s', 0)}</td>
                  <td className="num" title={x.clutchSlip ? 'The clutch is slipping (the engine held at its rpm)' : undefined}>{fmt(x.rpm, 0)}{x.clutchSlip ? '*' : ''}</td>
                  <td className="num">{disp.format(x.torque, 'N·m', 0)}</td>
                  <td className="num">{disp.format(x.power, 'kW', 1)}</td>
                  <td className="num" title={disp.format(x.force, 'N', 0)}>{fmt(x.force / (info.mass * G), 2)} g</td>
                  <td className="num" title={disp.format(x.drag, 'N', 0)}>{fmt(x.drag / (info.mass * G), 2)} g</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small-text">
            {info.rows.some((x) => x.clutchSlip) && <>* the clutch slips (the engine held at its rpm). </>}
            Top speed on the level <b>{disp.format(info.top.v, 'm/s', 0)}</b> ({info.top.by === 'rpm' ? 'at the most rpm: a taller gear would go faster' : 'where the drag and rolling resistance use all the power'})
            {' '}· driven wheels {disp.format(info.r * 1000, 'mm', 0)} loaded radius.
          </p>
        </>
      )}
      <p className="hint">
        The push is what the powertrain can give at that speed; the tires may allow less (traction). Tests with speeds set to
        Grip only have no top-speed cap with a powertrain: the power, the gear&apos;s most rpm, aero drag and rolling resistance limit the straights.
        One gear for now (gears and shift points later).
      </p>
    </>
  );
}
