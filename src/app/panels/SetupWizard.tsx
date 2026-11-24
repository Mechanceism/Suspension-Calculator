/**
 * Setup wizard: walks through entering the car, easy values first, hard ones last. Each step can be
 * applied (the user's values) or skipped with "Use an estimate" (the current values stay and are marked
 * as estimates, so results can say what they rest on). Measurement helpers: the corner-scale CG
 * calculator, the unsprung-weight sum, the spring-rate-from-a-weight tool and the inertia estimate.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { parseValue, type Quantity } from '../../core/units/units';
import { parseTireSize } from '../../core/tire/size';
import { tireRate, unloadedSetPressure } from '../../core/tire/model';
import { DoubleWishbone, SUSPENSION_KINDS, SUSPENSION_LABELS, type SuspensionKind } from '../../core/suspension/doubleWishbone';
import { springLength, dampingForRatio } from '../../core/suspension/spring';
import { cgFromScales, springFromWeight, unsprungFromParts, estimateInertia, G, type CornerKg, type UnsprungParts } from '../../core/setup/measure';
import { rackForWheelAngle } from '../../core/tests/steer';
import { angleInput,
  useApp, mergedCorners, rootOf, toGeometry, toProfile, toForceModel, vehicleStaticLoads, mountedTireWidth, measuringRim, SETUP_STEPS, SETUP_LABELS,
  type SetupStep, type CornerDesign, type TireAxle, type Field,
} from '../store';
import { importTireFile } from '../tireActions';
import { switchWorkspace } from '../viewport/SafeHtml';
import { axleRoots, wizardKeys } from '../locks';
import { ValueInput } from './ValueInput';
import { fmt } from './FieldRows';
import { useDisplay } from '../units';
import { Local, Val } from './UnitText';

export const useWizard = create<{ open: boolean; step: number }>(() => ({ open: false, step: 0 }));
export const openWizard = (step?: SetupStep) => useWizard.setState({ open: true, step: step ? SETUP_STEPS.indexOf(step) : 0 });

const f = (v: number): Field => ({ text: String(Number(v.toFixed(4))), value: v });

/** A number input in base units (typed plain numbers follow the display unit). */
function Num({ value, unit, q, onChange, width = 70 }: { value: number; unit: string; q: Quantity; onChange: (v: number) => void; width?: number }) {
  const disp = useDisplay();
  return (
    <span className="nowrap">
      <ValueInput field={f(value)} unit={unit} width={width} onCommit={(t) => { const r = parseValue(t, q); if (r.ok) onChange(r.value); }} />
      {' '}<span className="unit">{disp.conv(unit).unit}</span>
    </span>
  );
}

const Row = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
  <tr title={hint}><td>{label}</td><td>{children}</td></tr>
);

/** Design of an axle (front = FL's, rear = RL's). */
const designOf = (axle: 'front' | 'rear') => {
  const s = useApp.getState();
  return mergedCorners(s)[rootOf(axle === 'front' ? 'FL' : 'RL', s.links)];
};

/** Half track of a design: the tire's centerline (wheel offset applied), mm. */
const halfTrackOf = (d: CornerDesign) => Math.abs(toGeometry(d.geom).wheel.center.x);

/** Spring travel per wheel travel of a design at ride height (1 when it can't be found). */
function motionRatio(d: CornerDesign): number {
  try {
    const c = new DoubleWishbone(toGeometry(d.geom));
    const a = springLength(c.solve({ travel: -1 })), b = springLength(c.solve({ travel: 1 }));
    return a !== null && b !== null ? Math.abs(b - a) / 2 || 1 : 1;
  } catch { return 1; }
}

// ---------------------------------------------------------------- steps

/** `fn` writes the step's values and returns the lock keys of what it wrote (locked as the user's values). */
interface StepProps { apply: (fn: () => string[] | void) => void }
/** Every design the front and rear axles use (one when all four corners share a design). */
const allRoots = () => { const l = useApp.getState().links; return [...new Set([...axleRoots(l, 'front'), ...axleRoots(l, 'rear')])]; };
type StepView = (p: StepProps) => ReactNode;

const TypeStep: StepView = ({ apply }) => {
  const links = useApp((s) => s.links);
  const setLink = useApp((s) => s.setLink);
  useApp((s) => s.corners); useApp((s) => s.geom); // re-render when a type changes
  const kindOf = (axle: 'front' | 'rear') => designOf(axle).geom.kind ?? 'doubleWishbone';
  // The same switch as the Inspector's (it links a solid axle's / twist beam's left and right, steers a
  // steered corner's axle, turns steering off on a twist beam and offers it back).
  const setKind = (axle: 'front' | 'rear', kind: SuspensionKind) => useApp.getState().setSuspensionKindFor(axle === 'front' ? 'FL' : 'RL', kind);
  const sel = (axle: 'front' | 'rear') => (
    <select value={kindOf(axle)} onChange={(e) => setKind(axle, e.target.value as SuspensionKind)} disabled={axle === 'rear' && links.rearFromFront}>
      {SUSPENSION_KINDS.map((k) => <option key={k} value={k}>{SUSPENSION_LABELS[k]}</option>)}
    </select>
  );
  return (
    <>
      <p>
        Each axle&apos;s suspension type. Switching keeps the lower arm, tie rod, hub and tire and places the new parts from them
        (a MacPherson strut from the upright up to a top mount; a multilink starts as the wishbones with each link ending at its own point, moving (nearly) the same until you change them);
        you enter the real points on the points page.
      </p>
      <table className="opt-table">
        <tbody>
          <Row label="Front">{sel('front')}</Row>
          <Row label="Rear" hint={links.rearFromFront ? 'The rear uses the same dimensions as the front (untick below for its own type)' : undefined}>{sel('rear')}</Row>
        </tbody>
      </table>
      <p className="hint">Left and right of an axle share a type while they are mirror images; unlink them to give one corner its own (Hardpoints → Type).</p>
      <label className="check-row"><input type="checkbox" checked={links.frontPair && links.rearPair} onChange={(e) => { setLink('frontPair', e.target.checked); setLink('rearPair', e.target.checked); }} /> Left and right are mirror images</label>
      <label className="check-row"><input type="checkbox" checked={links.rearFromFront} onChange={(e) => setLink('rearFromFront', e.target.checked)} /> The rear uses the same dimensions as the front</label>
      <div className="jm-row"><button className="wide-btn primary" onClick={() => apply(() => {})}>That&apos;s my car: next</button></div>
    </>
  );
};

/** Which corners steer, are powered and have brakes (and how). */
const DriveStep: StepView = ({ apply }) => {
  const settings = useApp((s) => s.settings);
  const setSetting = useApp((s) => s.setCornerSetting);
  const ids = ['FL', 'FR', 'RL', 'RR'] as const;
  return (
    <>
      <p>Which wheels steer, which are driven, and which have brakes. These decide how the car turns, accelerates and stops in the tests.</p>
      <table className="opt-table">
        <thead><tr><th /><th>Steers</th><th>Powered</th><th>Drive</th><th>Brake</th><th>ABS</th></tr></thead>
        <tbody>
          {ids.map((id) => {
            const c = settings[id];
            return (
              <tr key={id}>
                <td><b>{id}</b></td>
                <td><input type="checkbox" checked={c.steered} onChange={(e) => setSetting(id, 'steered', e.target.checked)} /></td>
                <td><input type="checkbox" checked={c.powered} onChange={(e) => setSetting(id, 'powered', e.target.checked)} /></td>
                <td>
                  <select value={c.drive} disabled={!c.powered} onChange={(e) => setSetting(id, 'drive', e.target.value as 'chassis' | 'hub')} title="Chassis: a differential and halfshaft; hub: a motor in the wheel">
                    <option value="chassis">Diff + halfshaft</option>
                    <option value="hub">Hub motor</option>
                  </select>
                </td>
                <td>
                  <select value={c.brake} onChange={(e) => setSetting(id, 'brake', e.target.value as typeof c.brake)} title="Outboard: at the wheel (torque into the upright); inboard: on the chassis (e.g. at the diff)">
                    <option value="outboard">At the wheel</option>
                    <option value="inboard">Inboard</option>
                    <option value="none">None</option>
                  </select>
                </td>
                <td><input type="checkbox" checked={c.abs} disabled={c.brake === 'none'} onChange={(e) => setSetting(id, 'abs', e.target.checked)} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="hint">Changes apply right away. Brake bias and the drive split are on the weight page and in Vehicle → Inputs.</p>
      <div className="jm-row"><button className="wide-btn primary" onClick={() => apply(() => {})}>That&apos;s my car: next</button></div>
    </>
  );
};

const TiresStep: StepView = ({ apply }) => {
  const front = designOf('front'), rear = designOf('rear');
  const [sizeF, setSizeF] = useState(front.tireSizeText || '');
  const [sizeR, setSizeR] = useState(rear.tireSizeText || '');
  const [same, setSame] = useState((front.tireSizeText || '') === (rear.tireSizeText || ''));
  const [pF, setPF] = useState(front.tire.pressure.value);
  const [pR, setPR] = useState(rear.tire.pressure.value);
  const rimOf = (d: CornerDesign) => (Number.isFinite(d.geom.scalars.rimWidth.value) ? d.geom.scalars.rimWidth.value : measuringRim(d.geom.scalars.tireWidth.value));
  const [rimF, setRimF] = useState(rimOf(front));
  const [rimR, setRimR] = useState(rimOf(rear));
  const [etF, setEtF] = useState(front.geom.scalars.wheelOffset.value || 0);
  const [etR, setEtR] = useState(rear.geom.scalars.wheelOffset.value || 0);
  // When and how the pressure was set: cold, at some temperature and altitude, with or without load.
  const [setT, setSetT] = useState(front.tire.setTemperature.value);
  const [setAlt, setSetAlt] = useState(front.tire.setAltitude.value);
  const [loadedReading, setLoadedReading] = useState(false);
  const okF = !!parseTireSize(sizeF), okR = same || !!parseTireSize(sizeR);
  const go = () => apply(() => {
    const s = useApp.getState();
    const loads = vehicleStaticLoads(s.vehicle, mergedCorners(s), s.links);
    const set = (axle: TireAxle, text: string, p: number, rim: number, et: number) => {
      const size = parseTireSize(text)!;
      s.applyTireDims(axle, { outerDiameter: size.outerDiameter, width: size.sectionWidth, rimDiameter: size.rimDiameter });
      useApp.getState().updateDesigns(axle, (d) => {
        const tire = { ...d.tire, setTemperature: f(setT), setAltitude: f(setAlt), pressure: f(p) };
        const geom = { ...d.geom, scalars: { ...d.geom.scalars, rimWidth: f(rim), wheelOffset: f(et) } };
        // Read with the car on the wheel: the model's set pressure is with no load (more air volume).
        if (loadedReading) {
          const model = toForceModel(d.tireModel, tire, d.volumeChange);
          const load = loads[axle === 'rear' ? 'RL' : 'FL'];
          if (model && load > 0) tire.pressure = f(Number(unloadedSetPressure(model, toProfile(geom), p, load).toFixed(2)));
        }
        return { ...d, tireSizeText: text, tire, geom };
      });
    };
    if (same) set('both', sizeF, pF, rimF, etF);
    else { set('front', sizeF, pF, rimF, etF); set('rear', sizeR, pR, rimR, etR); }
    return wizardKeys.tires(allRoots());
  });
  const widthOn = (text: string, rim: number, d: CornerDesign = front) => { const z = parseTireSize(text); return mountedTireWidth({ ...d.geom.scalars, tireWidth: f(z ? z.sectionWidth : d.geom.scalars.tireWidth.value), rimWidth: f(rim) }); };
  return (
    <>
      <p>The size printed on the tire sidewall (225/45R17, 31x10.50R15, 20.5x7.0-13…) and the pressure you run.</p>
      <table className="opt-table">
        <tbody>
          <Row label={same ? 'Tire size' : 'Front tire size'}><input className={`value-input wide-text${sizeF && !okF ? ' invalid' : ''}`} value={sizeF} onChange={(e) => setSizeF(e.target.value)} placeholder="225/45R17" /></Row>
          {!same && <Row label="Rear tire size"><input className={`value-input wide-text${sizeR && !okR ? ' invalid' : ''}`} value={sizeR} onChange={(e) => setSizeR(e.target.value)} /></Row>}
          <Row label={same ? 'Pressure' : 'Front pressure'}><Num value={pF} unit="kPa" q="pressure" onChange={setPF} /></Row>
          {!same && <Row label="Rear pressure"><Num value={pR} unit="kPa" q="pressure" onChange={setPR} /></Row>}
          <Row label="Pressure measured" hint="The model uses the pressure set cold with no load on the tire. Measured with the car sitting on it, the reading is a little higher (less air volume): it is converted.">
            <select value={loadedReading ? 'loaded' : 'free'} onChange={(e) => setLoadedReading(e.target.value === 'loaded')}>
              <option value="free">Cold, wheel off the ground (no load)</option>
              <option value="loaded">Cold, with the car on its wheels</option>
            </select>
          </Row>
          <Row label="Temperature when set" hint="Air (tire) temperature when the pressure was set, before driving"><Num value={setT} unit="°C" q="temperature" onChange={setSetT} /></Row>
          <Row label="Altitude when set" hint="Gauge pressure depends on the outside air pressure"><Num value={setAlt} unit="m" q="altitude" onChange={setSetAlt} /></Row>
          <Row label={same ? 'Rim width' : 'Front rim width'} hint="The wheel's width (e.g. 7&quot; for a 7x13 wheel). A rim wider than the tire's measuring rim spreads the tire about 5 mm per ½&quot;."><Num value={rimF} unit="mm" q="length" onChange={setRimF} /></Row>
          {!same && <Row label="Rear rim width"><Num value={rimR} unit="mm" q="length" onChange={setRimR} /></Row>}
          <Row label={same ? 'Wheel offset (ET)' : 'Front wheel offset (ET)'} hint="Stamped on the wheel (ET35 = 35 mm). From the rim's centerline to the hub mounting face; + = the face is outboard of the centerline (the tire sits inboard)."><Num value={etF} unit="mm" q="length" onChange={setEtF} /></Row>
          {!same && <Row label="Rear wheel offset (ET)"><Num value={etR} unit="mm" q="length" onChange={setEtR} /></Row>}
        </tbody>
      </table>
      <div className="wizard-figs">
        <OffsetDiagram />
        <p className="small-text muted">
          Tire width on this rim: <Val v={widthOn(sizeF, rimF)} unit="mm" digits={0} />{!same ? <Local text={` front, ${fmt(widthOn(sizeR, rimR, rear), 0)} mm rear`} /> : ''} (section width is quoted on the tire&apos;s measuring rim).
          The suspension&apos;s wheel-center point is the <b>hub mounting face</b>: the tire&apos;s centerline sits the offset inboard of it.
        </p>
      </div>
      <label className="check-row"><input type="checkbox" checked={same} onChange={(e) => setSame(e.target.checked)} /> Same tires front and rear</label>
      {!okF && sizeF && <p className="hint warn-text">Unrecognized size (try 225/45R17, 31x10.50R15 or 20.5x7.0-13).</p>}
      <div className="jm-row"><button className="wide-btn primary" disabled={!okF || !okR} onClick={go}>Apply and next</button></div>
    </>
  );
};

const SizeStep: StepView = ({ apply }) => {
  const s = useApp.getState();
  const front = designOf('front'), rear = designOf('rear');
  const halfF = halfTrackOf(front), halfR = halfTrackOf(rear);
  const [wb, setWb] = useState(s.vehicle.wheelbase.value);
  const [mode, setMode] = useState<'track' | 'width'>('track');
  const [tF, setTF] = useState(2 * halfF);
  const [tR, setTR] = useState(2 * halfR);
  const tireW = (d: CornerDesign) => mountedTireWidth(d.geom.scalars);
  const trackOf = (v: number, d: CornerDesign) => (mode === 'width' ? v - tireW(d) : v);
  const linked = s.links.rearFromFront;
  const go = () => apply(() => {
    const st = useApp.getState();
    st.setVehicleField('wheelbase', String(wb));
    const shift = (axle: 'front' | 'rear', newTrack: number, half: number) => {
      const dx = newTrack / 2 - half;
      if (Math.abs(dx) < 1e-6) return;
      // Move the whole corner sideways (chassis pivots too): its geometry keeps its shape.
      useApp.getState().updateDesigns(axle, (d) => ({
        ...d,
        geom: { ...d.geom, points: Object.fromEntries(Object.entries(d.geom.points).map(([k, p]) => [k, [f(p[0].value + dx), p[1], p[2]]])) as typeof d.geom.points },
      }));
    };
    shift('front', trackOf(tF, front), halfF);
    if (!linked) shift('rear', trackOf(tR, rear), halfR);
    return wizardKeys.size(allRoots());
  });
  return (
    <>
      <p>Wheelbase: front wheel center to rear wheel center. Track: center of the left tire to center of the right tire (or measure the overall width outside the tires; the tire width is taken off).</p>
      <div className="jm-row">
        <button className={`chip${mode === 'track' ? ' on' : ''}`} onClick={() => setMode('track')}>I measured the track</button>
        <button className={`chip${mode === 'width' ? ' on' : ''}`} onClick={() => setMode('width')}>I measured the overall width</button>
      </div>
      <TrackDiagram mode={mode} />
      <table className="opt-table">
        <tbody>
          <Row label="Wheelbase"><Num value={wb} unit="mm" q="length" onChange={setWb} /></Row>
          <Row label={mode === 'track' ? 'Front track' : 'Front overall width'}><Num value={tF} unit="mm" q="length" onChange={setTF} /></Row>
          {!linked && <Row label={mode === 'track' ? 'Rear track' : 'Rear overall width'}><Num value={tR} unit="mm" q="length" onChange={setTR} /></Row>}
        </tbody>
      </table>
      {mode === 'width' && <p className="small-text muted">Track: front <Val v={trackOf(tF, front)} unit="mm" digits={0} />{!linked ? <Local text={`, rear ${fmt(trackOf(tR, rear), 0)} mm`} /> : ''}.</p>}
      {linked && <p className="hint">The rear uses the front&apos;s dimensions (step 1), so it gets the front track.</p>}
      <p className="hint">Changing the track moves each corner sideways as a whole (its arms keep their lengths and angles).</p>
      <div className="jm-row"><button className="wide-btn primary" onClick={go}>Apply and next</button></div>
    </>
  );
};

const WeightStep: StepView = ({ apply }) => {
  const s = useApp.getState();
  const v = s.vehicle;
  const L = v.wheelbase.value;
  const tF = 2 * halfTrackOf(designOf('front'));
  const tR = 2 * halfTrackOf(designOf('rear'));
  const [mass, setMass] = useState(v.mass.value);
  const [frontPct, setFrontPct] = useState(100 * (1 + v.cgZ.value / L));
  const [leftPct, setLeftPct] = useState(50 + (100 * v.cgX.value) / ((tF + tR) / 2));
  const [height, setHeight] = useState(v.cgY.value);
  const [calc, setCalc] = useState(false);
  const share = mass / 4;
  const [kg, setKg] = useState<CornerKg>({ FL: share, FR: share, RL: share, RR: share });
  const [lift, setLift] = useState<{ axle: 'front' | 'rear'; height: number; groundAxleKg: number }>({ axle: 'front', height: 0, groundAxleKg: 0 });
  const [wcH, setWcH] = useState(designOf('front').geom.scalars.tireDiameter.value / 2);
  const cg = calc ? cgFromScales(kg, L, tF, tR, lift.height > 0 && lift.groundAxleKg > 0 ? { ...lift, wheelCenterHeight: wcH } : undefined) : null;
  const go = () => apply(() => {
    const st = useApp.getState();
    const m = cg ? cg.mass : mass;
    const z = cg ? cg.z : -(1 - frontPct / 100) * L;
    const x = cg ? cg.x : (leftPct / 100 - 0.5) * ((tF + tR) / 2);
    const h = cg?.height ?? height;
    st.setVehicleField('mass', String(Number(m.toFixed(2))));
    st.setVehicleField('cgZ', String(Number(z.toFixed(1))));
    st.setVehicleField('cgX', String(Number(x.toFixed(1))));
    st.setVehicleField('cgY', String(Number(h.toFixed(1))));
    return wizardKeys.weight();
  });
  return (
    <>
      <p>The car&apos;s weight as driven (with driver and fuel) and where its center of gravity is.</p>
      <div className="jm-row">
        <button className={`chip${!calc ? ' on' : ''}`} onClick={() => setCalc(false)}>I know the values</button>
        <button className={`chip${calc ? ' on' : ''}`} onClick={() => setCalc(true)}>Calculate from corner scales</button>
      </div>
      {!calc ? (
        <table className="opt-table">
          <tbody>
            <Row label="Total weight"><Num value={mass} unit="kg" q="mass" onChange={setMass} /></Row>
            <Row label="Weight on the front" hint="Front axle share of the weight"><Num value={frontPct} unit="%" q="percent" onChange={setFrontPct} /></Row>
            <Row label="Weight on the left"><Num value={leftPct} unit="%" q="percent" onChange={setLeftPct} /></Row>
            <Row label="CG height above the ground"><Num value={height} unit="mm" q="length" onChange={setHeight} /></Row>
          </tbody>
        </table>
      ) : (
        <>
          <p className="small-text">1. On level ground, one scale under each tire:</p>
          <table className="opt-table"><tbody>
            {(['FL', 'FR', 'RL', 'RR'] as const).map((id) => (
              <Row key={id} label={id}><Num value={kg[id]} unit="kg" q="mass" onChange={(x) => setKg((k) => ({ ...k, [id]: x }))} /></Row>
            ))}
          </tbody></table>
          <p className="small-text">2. For the CG height: lock the suspension (rigid links in place of the dampers), raise one axle and weigh the other again.</p>
          <table className="opt-table"><tbody>
            <Row label="Raised axle">
              <select value={lift.axle} onChange={(e) => setLift((l) => ({ ...l, axle: e.target.value as 'front' | 'rear' }))}><option value="front">front</option><option value="rear">rear</option></select>
            </Row>
            <Row label="Raised by (at the wheel centers)"><Num value={lift.height} unit="mm" q="length" onChange={(x) => setLift((l) => ({ ...l, height: x }))} /></Row>
            <Row label={`${lift.axle === 'front' ? 'Rear' : 'Front'} axle weight then (both scales)`}><Num value={lift.groundAxleKg} unit="kg" q="mass" onChange={(x) => setLift((l) => ({ ...l, groundAxleKg: x }))} /></Row>
            <Row label="Wheel-center height (loaded radius)"><Num value={wcH} unit="mm" q="length" onChange={setWcH} /></Row>
          </tbody></table>
          {cg && (
            <p className="small-text">
              <b><Val v={cg.mass} unit="kg" digits={1} /></b> · {fmt(cg.front * 100, 1)} % front · {fmt(cg.left * 100, 1)} % left · CG <Val v={-cg.z} unit="mm" digits={0} /> behind the front axle
              {cg.height !== null ? <>, <b><Val v={cg.height} unit="mm" digits={0} /> high</b></> : ' (height: step 2)'}
            </p>
          )}
        </>
      )}
      <div className="jm-row"><button className="wide-btn primary" onClick={go} disabled={calc && !cg}>Apply and next</button></div>
    </>
  );
};

const PARTS: [keyof UnsprungParts, string, string][] = [
  ['wheelTire', 'Wheel and tire', ''], ['hubUpright', 'Hub, bearing and upright', ''], ['brake', 'Brake (rotor and caliper)', ''],
  ['arms', 'Control arms and tie rod', 'Half counts: one end is on the body'], ['springDamper', 'Spring and damper', 'Half counts'],
  ['halfshaft', 'Halfshaft', 'Half counts (driven corners)'], ['other', 'Other wheel-end parts', ''],
];

const UnsprungStep: StepView = ({ apply }) => {
  const blank = (d: CornerDesign): UnsprungParts => ({ wheelTire: 0, hubUpright: 0, brake: 0, arms: 0, springDamper: 0, halfshaft: 0, other: d.spring.unsprungMass.value });
  const [parts, setParts] = useState({ front: blank(designOf('front')), rear: blank(designOf('rear')) });
  const linked = useApp.getState().links.rearFromFront;
  const axles: ('front' | 'rear')[] = linked ? ['front'] : ['front', 'rear'];
  const go = () => apply(() => {
    for (const a of axles) useApp.getState().updateDesigns(linked ? 'both' : a, (d) => ({ ...d, spring: { ...d.spring, unsprungMass: f(unsprungFromParts(parts[a])) } }));
    return wizardKeys.unsprung(allRoots());
  });
  return (
    <>
      <p>What moves with each wheel (per corner). Weigh the parts, or enter the total under &quot;Other&quot;.</p>
      <table className="opt-table">
        <thead><tr><th /><th>{linked ? 'Each corner' : 'Front'}</th>{!linked && <th>Rear</th>}</tr></thead>
        <tbody>
          {PARTS.map(([k, label, hint]) => (
            <tr key={k} title={hint}>
              <td>{label}</td>
              {axles.map((a) => <td key={a}><Num value={parts[a][k]} unit="kg" q="mass" width={56} onChange={(x) => setParts((p) => ({ ...p, [a]: { ...p[a], [k]: x } }))} /></td>)}
            </tr>
          ))}
          <tr><td><b>Unsprung per corner</b></td>{axles.map((a) => <td key={a}><b><Val v={unsprungFromParts(parts[a])} unit="kg" digits={1} /></b></td>)}</tr>
        </tbody>
      </table>
      <div className="jm-row"><button className="wide-btn primary" onClick={go}>Apply and next</button></div>
    </>
  );
};

const PointsStep: StepView = ({ apply }) => (
  <>
    <p>
      The suspension points (hardpoints) of each corner: chassis pivots, ball joints, tie-rod ends, coilover mounts, wheel center, in
      the corner&apos;s frame (X outboard, Y up, Z forward). Measure them from the car or CAD, then type them into the point table.
    </p>
    <p className="hint">Tip: <b>Measure</b> (M) and the <b>Set dimension</b> panel help check lengths and angles against the car. Until then the sample layout&apos;s points are used.</p>
    <div className="jm-row">
      <button className="wide-btn" onClick={() => { useWizard.setState({ open: false }); switchWorkspace('corner'); useApp.getState().set('leftTab', 'table'); }}>Open the point table (Corner → Inputs)</button>
    </div>
    <div className="jm-row"><button className="wide-btn primary" onClick={() => apply(() => {})}>My points are entered: next</button></div>
  </>
);

const SpringsStep: StepView = ({ apply }) => {
  const s = useApp.getState();
  const linked = s.links.rearFromFront;
  const axles: ('front' | 'rear')[] = linked ? ['front'] : ['front', 'rear'];
  const loads = useMemo(() => vehicleStaticLoads(s.vehicle, mergedCorners(s), s.links), [s]);
  const info = (a: 'front' | 'rear') => {
    const d = designOf(a);
    const model = toForceModel(d.tireModel, d.tire, d.volumeChange);
    const load = loads[a === 'front' ? 'FL' : 'RL'];
    return { d, mr: motionRatio(d), kt: model ? tireRate(model, toProfile(d.geom), 0, load) : undefined };
  };
  const [mode, setMode] = useState<'know' | 'measure'>('know');
  const [rate, setRate] = useState({ front: designOf('front').spring.springRate.value, rear: designOf('rear').spring.springRate.value });
  const [meas, setMeas] = useState({ front: { kg: 50, drop: 0 }, rear: { kg: 50, drop: 0 } });
  const result = (a: 'front' | 'rear') => { const i = info(a); return springFromWeight(meas[a].kg, meas[a].drop, i.mr, i.kt); };
  const go = () => apply(() => {
    const st = useApp.getState();
    const roots: string[] = [];
    for (const a of axles) {
      const k = mode === 'know' ? rate[a] : result(a)?.springRate;
      if (k && k > 0) {
        st.updateDesigns(linked ? 'both' : a, (d) => ({ ...d, spring: { ...d.spring, springRate: f(k) } }));
        roots.push(...wizardKeys.springs(linked ? allRoots() : axleRoots(st.links, a)));
      }
    }
    // Keep the design ride height: free lengths follow the springs.
    st.set('autoPreload', true);
    return roots;
  });
  return (
    <>
      <p>The spring rate (stamped on the spring or on its label), or measure it on the car.</p>
      <div className="jm-row">
        <button className={`chip${mode === 'know' ? ' on' : ''}`} onClick={() => setMode('know')}>I know the rate</button>
        <button className={`chip${mode === 'measure' ? ' on' : ''}`} onClick={() => setMode('measure')}>Measure it with a weight</button>
      </div>
      <table className="opt-table">
        <tbody>
          {axles.map((a) => mode === 'know' ? (
            <Row key={a} label={linked ? 'Spring rate' : `${a === 'front' ? 'Front' : 'Rear'} spring rate`}><Num value={rate[a]} unit="N/mm" q="rate" onChange={(x) => setRate((r) => ({ ...r, [a]: x }))} /></Row>
          ) : (
            <tr key={a}>
              <td>{linked ? 'Corner' : a === 'front' ? 'Front corner' : 'Rear corner'}</td>
              <td>
                add <Num value={meas[a].kg} unit="kg" q="mass" width={50} onChange={(x) => setMeas((m) => ({ ...m, [a]: { ...m[a], kg: x } }))} />
                {' '}body drops <Num value={meas[a].drop} unit="mm" q="length" width={50} onChange={(x) => setMeas((m) => ({ ...m, [a]: { ...m[a], drop: x } }))} />
                {result(a) && <div className="small-text">→ spring <b><Val v={result(a)!.springRate} unit="N/mm" digits={1} /></b> (wheel rate <Val v={result(a)!.wheelRate} unit="N/mm" digits={1} />, motion ratio {fmt(info(a).mr, 2)}{info(a).kt ? <Local text={`, tire ${fmt(info(a).kt!, 0)} N/mm taken out`} /> : ''})</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {mode === 'measure' && <p className="hint">Put the weight right over the wheel (e.g. on the fender above it) and measure how much the body drops at that wheel. Use a weight of at least a quarter of the corner&apos;s load. The motion ratio comes from your suspension points (step 6).</p>}
      <div className="jm-row"><button className="wide-btn primary" onClick={go}>Apply and next</button></div>
    </>
  );
};

const DampersStep: StepView = ({ apply }) => {
  const s = useApp.getState();
  const linked = s.links.rearFromFront;
  const axles: ('front' | 'rear')[] = linked ? ['front'] : ['front', 'rear'];
  const [mode, setMode] = useState<'ratio' | 'rates'>('ratio');
  const [ratio, setRatio] = useState({ bump: 0.3, rebound: 0.5 });
  const [rates, setRates] = useState({
    front: { bump: designOf('front').damper.bumpDamping.value, rebound: designOf('front').damper.reboundDamping.value },
    rear: { bump: designOf('rear').damper.bumpDamping.value, rebound: designOf('rear').damper.reboundDamping.value },
  });
  const [bars, setBars] = useState({ front: s.shared.front.antiRollBar === 'wheelRate' ? s.shared.front.arbRate.value : 0, rear: s.shared.rear.antiRollBar === 'wheelRate' ? s.shared.rear.arbRate.value : 0 });
  const fromRatio = (a: 'front' | 'rear') => {
    const d = designOf(a);
    const mr = motionRatio(d);
    const loads = vehicleStaticLoads(s.vehicle, mergedCorners(s), s.links);
    const m = Math.max(1, loads[a === 'front' ? 'FL' : 'RL'] / G - d.spring.unsprungMass.value);
    const wheelRate = d.spring.springRate.value * mr * mr;
    return { bump: dampingForRatio(ratio.bump, mr, wheelRate, m), rebound: dampingForRatio(ratio.rebound, mr, wheelRate, m) };
  };
  const go = () => apply(() => {
    const st = useApp.getState();
    for (const a of axles) {
      const r = mode === 'ratio' ? fromRatio(a) : rates[a];
      st.updateDesigns(linked ? 'both' : a, (d) => ({ ...d, damper: { ...d.damper, bumpDamping: f(Math.round(r.bump)), reboundDamping: f(Math.round(r.rebound)) } }));
    }
    for (const a of ['front', 'rear'] as const) {
      if (bars[a] > 0) { st.setShared(a, { antiRollBar: 'wheelRate' }); st.setSharedField(a, 'arbRate', String(bars[a])); }
      else if (st.shared[a].antiRollBar === 'wheelRate') st.setShared(a, { antiRollBar: 'none' });
    }
    return wizardKeys.dampers(allRoots(), (['front', 'rear'] as const).filter((a) => bars[a] > 0));
  });
  return (
    <>
      <p>Damper rates at the damper, bump (compression) and rebound (extension). Without a dyno sheet, generic rates from a damping ratio are a good start.</p>
      <div className="jm-row">
        <button className={`chip${mode === 'ratio' ? ' on' : ''}`} onClick={() => setMode('ratio')}>Generic (from damping ratios)</button>
        <button className={`chip${mode === 'rates' ? ' on' : ''}`} onClick={() => setMode('rates')}>I know the rates</button>
      </div>
      <table className="opt-table">
        <tbody>
          {mode === 'ratio' ? (
            <>
              <Row label="Damping ratio, bump" hint="0.25–0.4 comfort, up to 0.7 for handling"><Num value={ratio.bump} unit="" q="ratio" onChange={(x) => setRatio((r) => ({ ...r, bump: x }))} /></Row>
              <Row label="Damping ratio, rebound"><Num value={ratio.rebound} unit="" q="ratio" onChange={(x) => setRatio((r) => ({ ...r, rebound: x }))} /></Row>
              {axles.map((a) => { const r = fromRatio(a); return <Row key={a} label={`→ ${linked ? '' : a + ' '}rates`}><span className="small-text">bump <Val v={r.bump} unit="N·s/m" digits={0} /> · rebound <Val v={r.rebound} unit="N·s/m" digits={0} /></span></Row>; })}
            </>
          ) : axles.map((a) => (
            <Row key={a} label={`${linked ? '' : a === 'front' ? 'Front ' : 'Rear '}bump / rebound`}>
              <Num value={rates[a].bump} unit="N·s/m" q="damping" width={60} onChange={(x) => setRates((r) => ({ ...r, [a]: { ...r[a], bump: x } }))} />
              {' '}<Num value={rates[a].rebound} unit="N·s/m" q="damping" width={60} onChange={(x) => setRates((r) => ({ ...r, [a]: { ...r[a], rebound: x } }))} />
            </Row>
          ))}
          <Row label="Front anti-roll bar (rate at the wheel)" hint="0 = none. Torsion-bar geometry can be entered in Vehicle → Inputs"><Num value={bars.front} unit="N/mm" q="rate" onChange={(x) => setBars((b) => ({ ...b, front: x }))} /></Row>
          <Row label="Rear anti-roll bar (rate at the wheel)"><Num value={bars.rear} unit="N/mm" q="rate" onChange={(x) => setBars((b) => ({ ...b, rear: x }))} /></Row>
        </tbody>
      </table>
      <p className="hint">Two-stage dampers (a knee speed and high-speed rates) can be set in the Corner view&apos;s Inputs → Damper.</p>
      <div className="jm-row"><button className="wide-btn primary" onClick={go}>Apply and next</button></div>
    </>
  );
};

const SteeringStep: StepView = ({ apply }) => {
  const armMech = useApp((st) => angleInput(st.geom.steerMechanism));
  const steer = useApp((st) => st.steer);
  const wheelbase = useApp((st) => st.vehicle.wheelbase.value);
  const [turnsMode, setTurnsMode] = useState<'lockToLock' | 'centerToLock'>('lockToLock');
  const [turns, setTurns] = useState(Number(((2 * steer.rackLimit.value) / Math.max(steer.cFactor.value, 1e-9)).toFixed(2)));
  const [angleMode, setAngleMode] = useState<'span' | 'inside'>('span');
  const [angle, setAngle] = useState(50);
  const corner = useMemo(() => { try { return new DoubleWishbone(toGeometry(designOf('front').geom)); } catch { return null; } }, []);
  const lock = corner && angle > 0 ? rackForWheelAngle(corner, (angle * Math.PI) / 180, angleMode) : null;
  const centerTurns = turnsMode === 'lockToLock' ? turns / 2 : turns;
  const cFactor = lock && centerTurns > 0 ? lock.rack / centerTurns : NaN;
  const deg = (r: number) => (r * 180) / Math.PI;
  const mean = lock ? (lock.inside + lock.outside) / 2 : NaN;
  const go = () => apply(() => {
    if (!lock || !(cFactor > 0)) return;
    const st = useApp.getState();
    st.setSteerField('rackLimit', String(Number(lock.rack.toFixed(2))));
    st.setSteerField('cFactor', String(Number(cFactor.toFixed(2))));
    return wizardKeys.steering();
  });
  return (
    <>
      <p>Two easy measurements on the car: how many turns the steering wheel makes, and how far a front wheel turns.</p>
      <div className="jm-row">
        <button className={`chip${turnsMode === 'lockToLock' ? ' on' : ''}`} onClick={() => setTurnsMode('lockToLock')}>Turns lock to lock</button>
        <button className={`chip${turnsMode === 'centerToLock' ? ' on' : ''}`} onClick={() => setTurnsMode('centerToLock')}>Turns center to lock</button>
      </div>
      <div className="jm-row">
        <button className={`chip${angleMode === 'span' ? ' on' : ''}`} onClick={() => setAngleMode('span')}>Wheel angle full left to full right</button>
        <button className={`chip${angleMode === 'inside' ? ' on' : ''}`} onClick={() => setAngleMode('inside')}>Wheel angle straight to full lock</button>
      </div>
      <table className="opt-table">
        <tbody>
          <Row label={turnsMode === 'lockToLock' ? 'Steering-wheel turns, lock to lock' : 'Steering-wheel turns, center to lock'}><Num value={turns} unit="" q="ratio" onChange={setTurns} /></Row>
          <Row label={angleMode === 'span' ? 'One front wheel, full left to full right' : 'One front wheel, straight to full lock (turning toward that side)'}
            hint="Measure the wheel's angle (e.g. turn plates, or a straight edge on the tire and a protractor on the floor)">
            <Num value={angle} unit="°" q="angle" onChange={setAngle} />
          </Row>
        </tbody>
      </table>
      {lock ? (
        <p className="small-text">
          {armMech ? 'Steering-arm angle' : 'Rack travel'} <b>{armMech ? `±${fmt(lock.rack, 1)} °` : <>±<Val v={lock.rack} unit="mm" digits={1} /></>}</b> · <b>{armMech ? `${fmt(cFactor, 1)} °` : <Val v={cFactor} unit="mm" digits={1} />}</b> per steering-wheel turn ·
          full lock: inside wheel <b>{fmt(deg(lock.inside), 1)}°</b>, outside <b>{fmt(deg(lock.outside), 1)}°</b> (max steering angle) ·
          overall ratio {fmt((centerTurns * 360) / deg(mean), 1)}:1 · tightest turn about <Val v={wheelbase / 1000 / Math.tan(mean)} unit="m" digits={1} /> radius
        </p>
      ) : <p className="hint warn-text">The steering geometry can&apos;t turn the wheel that far: check the angle (and the tie-rod points).</p>}
      <p className="hint">The inside and outside wheels turn by different amounts (Ackermann); the {armMech ? 'steering-arm angle' : 'rack travel'} comes from your steering geometry (tie-rod points{armMech ? " and the arm's pivot" : ''}). Rack or steering arm / plate: Steering → Mechanism.</p>
      <div className="jm-row"><button className="wide-btn primary" disabled={!lock || !(cFactor > 0)} onClick={go}>Apply and next</button></div>
    </>
  );
};

const GripStep: StepView = ({ apply }) => {
  const tireFile = useApp((s) => s.tireFile);
  const tireFileRear = useApp((s) => s.tireFileRear);
  const input = useRef<HTMLInputElement>(null);
  const rear = tireFileRear === null ? 'the same as the front' : tireFileRear === 'simple' ? 'the generic model' : tireFileRear.name;
  return (
    <>
      <p>How much grip the tires give: the hardest values to get, and the ones grip results depend on most.</p>
      <p>Now: front {tireFile ? <b>{tireFile.name}</b> : 'the generic model'}, rear {rear}.</p>
      <ul className="small-text">
        <li><b>A .tir file</b> (a fitted Magic Formula model of your tire, from the tire maker, a sim or published data): Import .tir.</li>
        <li><b>Your own measurements</b> (slip angle, load, forces…): fit a model in Vehicle → Optimize → Tire grip model → <i>Fit a tire model to measured data</i>.</li>
        <li><b>Neither yet:</b> use an estimate (the generic model) and come back later.</li>
      </ul>
      <div className="jm-row">
        <button className="chip" onClick={() => input.current?.click()}>Import .tir</button>
        <button className="chip" onClick={() => { useWizard.setState({ open: false }); useApp.getState().set('vehicleTab', 'optimize'); switchWorkspace('vehicle'); }}>Fit from measured data</button>
        <input ref={input} type="file" accept=".tir,.TIR,.txt" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) void importTireFile(file, 'both'); e.target.value = ''; }} />
      </div>
      <div className="jm-row"><button className="wide-btn primary" disabled={!tireFile} onClick={() => apply(() => {})} title={tireFile ? '' : 'Load a .tir file first, or use an estimate'}>My tire model is loaded: next</button></div>
    </>
  );
};

/** Top view: what the track, the overall width and the wheelbase are. */
function TrackDiagram({ mode }: { mode: 'track' | 'width' }) {
  const W = 300, H = 150;
  const tire = (x: number, y: number) => <rect x={x - 9} y={y - 18} width={18} height={36} rx={4} className="dg-tire" />;
  const xs = [95, 205], ys = [38, 112];
  const arrow = (x1: number, y1: number, x2: number, y2: number, on: boolean, label: string, lx: number, ly: number) => (
    <g className={on ? 'dg-on' : 'dg-off'}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} markerStart="url(#dg-a)" markerEnd="url(#dg-a)" />
      <text x={lx} y={ly} textAnchor="middle">{label}</text>
    </g>
  );
  return (
    <svg className="wizard-diagram" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Track, overall width and wheelbase">
      <defs><marker id="dg-a" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" /></marker></defs>
      <rect x={100} y={30} width={100} height={90} rx={12} className="dg-body" />
      {xs.map((x) => ys.map((y) => <g key={`${x}${y}`}>{tire(x, y)}</g>))}
      <line x1={xs[0]} y1={10} x2={xs[0]} y2={140} className="dg-center" />
      <line x1={xs[1]} y1={10} x2={xs[1]} y2={140} className="dg-center" />
      {arrow(xs[0], 16, xs[1], 16, mode === 'track', 'track: tire center to tire center', 150, 11)}
      {arrow(xs[0] - 9, 140, xs[1] + 9, 140, mode === 'width', 'overall width: outside to outside', 150, 136)}
      {arrow(250, ys[0], 250, ys[1], true, 'wheelbase', 278, 78)}
      <line x1={xs[1] + 12} y1={ys[0]} x2={256} y2={ys[0]} className="dg-center" />
      <line x1={xs[1] + 12} y1={ys[1]} x2={256} y2={ys[1]} className="dg-center" />
      <text x={20} y={78} className="dg-note">front ↑</text>
    </svg>
  );
}

/** Wheel cross-section: rim centerline, hub mounting face and the offset between them. */
function OffsetDiagram() {
  return (
    <svg className="wizard-diagram small" viewBox="0 0 220 120" role="img" aria-label="Wheel offset">
      <rect x={60} y={14} width={70} height={92} rx={10} className="dg-tire" />
      <line x1={95} y1={6} x2={95} y2={114} className="dg-center" />
      <line x1={118} y1={34} x2={118} y2={86} className="dg-hub" />
      <g className="dg-on">
        <line x1={95} y1={60} x2={118} y2={60} markerStart="url(#dg-b)" markerEnd="url(#dg-b)" />
      </g>
      <defs><marker id="dg-b" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" /></marker></defs>
      <text x={95} y={118} textAnchor="middle" className="dg-note">rim centerline</text>
      <text x={122} y={30} className="dg-note">hub face</text>
      <text x={150} y={62} className="dg-note">ET (+)</text>
      <text x={150} y={76} className="dg-note">outboard →</text>
    </svg>
  );
}

const InertiaStep: StepView = ({ apply }) => {
  const s = useApp.getState();
  const v = s.vehicle;
  const [roll, setRoll] = useState(v.rollInertia.value);
  const [pitch, setPitch] = useState(v.pitchInertia.value);
  const [yaw, setYaw] = useState(v.yawInertia.value);
  const estimate = () => {
    const all = mergedCorners(s);
    const unsprung = (['FL', 'FR', 'RL', 'RR'] as const).reduce((a, id) => a + all[id].spring.unsprungMass.value, 0);
    const track = halfTrackOf(designOf('front')) + halfTrackOf(designOf('rear'));
    const e = estimateInertia(v.mass.value - unsprung, track, v.wheelbase.value, v.mass.value);
    setRoll(Number(e.roll.toFixed(1))); setPitch(Number(e.pitch.toFixed(1))); setYaw(Number(e.yaw.toFixed(0)));
  };
  const go = () => apply(() => { const st = useApp.getState(); st.setVehicleField('rollInertia', String(roll)); st.setVehicleField('pitchInertia', String(pitch)); st.setVehicleField('yawInertia', String(yaw)); return wizardKeys.inertia(); });
  return (
    <>
      <p>How hard the body is to roll and pitch (for the ride over time) and the whole car to turn (yaw, for handling). Rarely measured: the estimate from the weight and size is usually fine.</p>
      <table className="opt-table">
        <tbody>
          <Row label="Roll inertia (about the sprung CG)"><Num value={roll} unit="kg·m²" q="ratio" onChange={setRoll} /></Row>
          <Row label="Pitch inertia"><Num value={pitch} unit="kg·m²" q="ratio" onChange={setPitch} /></Row>
          <Row label="Yaw inertia (whole car, about the CG)"><Num value={yaw} unit="kg·m²" q="ratio" onChange={setYaw} /></Row>
        </tbody>
      </table>
      <div className="jm-row"><button className="chip" onClick={estimate}>Estimate from weight and size</button></div>
      <div className="jm-row"><button className="wide-btn primary" onClick={go}>Apply and finish</button></div>
    </>
  );
};

const VIEWS: Record<SetupStep, StepView> = {
  type: TypeStep, drive: DriveStep, tires: TiresStep, size: SizeStep, weight: WeightStep, unsprung: UnsprungStep,
  points: PointsStep, springs: SpringsStep, dampers: DampersStep, steering: SteeringStep, grip: GripStep, inertia: InertiaStep,
};

/** Results based on estimates say so. */
export function EstimatedNote() {
  const status = useApp((s) => s.setupStatus);
  const est = SETUP_STEPS.filter((k) => status[k] === 'estimated');
  if (!est.length) return null;
  return (
    <p className="hint estimate-note">
      Based on estimated values: {est.map((k) => SETUP_LABELS[k].toLowerCase()).join(', ')}.{' '}
      <button className="link-btn" onClick={() => openWizard(est[0])}>Enter them</button>
    </p>
  );
}

export function SetupWizard() {
  const { open, step } = useWizard();
  const status = useApp((s) => s.setupStatus);
  if (!open) return null;
  const done = step >= SETUP_STEPS.length;
  const key = SETUP_STEPS[Math.min(step, SETUP_STEPS.length - 1)]!;
  const View = VIEWS[key];
  const next = () => useWizard.setState({ step: step + 1 });
  const apply = (fn: () => string[] | void) => {
    const keys = fn() ?? [];
    const st = useApp.getState();
    st.setSetupStatus(key, 'entered');
    // What the user entered is locked so no optimizer changes it (Locks tab, marked "from setup wizard").
    st.lockFromWizard(key, keys);
    next();
  };
  const estimate = () => { useApp.getState().setSetupStatus(key, 'estimated'); next(); };
  const close = () => useWizard.setState({ open: false });
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal wizard" role="dialog" aria-label="Setup wizard" onMouseDown={(e) => e.stopPropagation()}>
        <div className="wizard-steps">
          {SETUP_STEPS.map((k, i) => (
            <button key={k} className={`wizard-step${i === step ? ' on' : ''} ${status[k] ?? ''}`} onClick={() => useWizard.setState({ step: i })} title={status[k] === 'estimated' ? 'Estimate' : status[k] === 'entered' ? 'Your values' : 'Not done yet'}>
              <span className="wizard-num">{status[k] === 'entered' ? '✓' : status[k] === 'estimated' ? '~' : i + 1}</span>{SETUP_LABELS[k]}
            </button>
          ))}
          <button className={`wizard-step${done ? ' on' : ''}`} onClick={() => useWizard.setState({ step: SETUP_STEPS.length })}><span className="wizard-num">✔</span>Summary</button>
        </div>
        <div className="wizard-body">
          {!done ? (
            <>
              <h3>{step + 1}. {SETUP_LABELS[key]}</h3>
              <View key={key} apply={apply} />
              <div className="modal-actions">
                <button onClick={close}>Close</button>
                {step > 0 && <button onClick={() => useWizard.setState({ step: step - 1 })}>Back</button>}
                <button onClick={estimate} title="Keep the current values and mark them as estimates">Use an estimate</button>
              </div>
            </>
          ) : (
            <>
              <h3>Summary</h3>
              <table className="opt-table"><tbody>
                {SETUP_STEPS.map((k, i) => (
                  <tr key={k} className="clickable" onClick={() => useWizard.setState({ step: i })}>
                    <td>{SETUP_LABELS[k]}</td>
                    <td className={status[k] === 'entered' ? 'ok-text' : status[k] === 'estimated' ? 'warn-text' : 'muted'}>{status[k] === 'entered' ? 'your values' : status[k] === 'estimated' ? 'estimate' : 'not done'}</td>
                  </tr>
                ))}
              </tbody></table>
              <p className="hint">Values you entered are locked (Locks tab, marked &quot;setup wizard&quot;) so the optimizers keep them; unlock any you want optimized. Estimates stay free and marked: results that rest on them say so. Come back any time (File → Setup wizard). Every change can be undone (Ctrl+Z).</p>
              <div className="modal-actions"><button className="primary" onClick={close}>Done</button></div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
