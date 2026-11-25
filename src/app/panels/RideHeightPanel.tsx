/**
 * Static ride height (round 4, F21): the chassis reference's height above the ground at the front and rear axle
 * at rest. Set, the springs' preload is fitted so the car rests there — the suspension sits at some travel (the
 * dampers at another length); not set, it rests at the design position. An input, not something the optimizers
 * change. In Vehicle → Inputs and the setup wizard.
 */
import { useMemo } from 'react';
import { useApp, type Field } from '../store';
import { buildVehicleProblem } from '../optimizer';
import { assembleVehicle, staticTravelFor } from '../../core/optimize/vehicle';
import { parseValue } from '../../core/units/units';
import { FieldRows, fmt } from './FieldRows';
import { useDisplay } from '../units';

const fieldOf = (v: number): Field => ({ text: String(Math.round(v * 10) / 10), value: v });

/** The design ride height (mm) — where the car rests with no ride height set. */
export function useDesignRideHeight(): number | null {
  const corners = useApp((s) => s.corners), vehicle = useApp((s) => s.vehicle), links = useApp((s) => s.links), settings = useApp((s) => s.settings);
  return useMemo(() => {
    try {
      const p = buildVehicleProblem(useApp.getState()).problem;
      const asm = assembleVehicle(p, Object.fromEntries(Object.entries(p.designs).map(([r, d]) => [r, d!.geometry])));
      return asm ? -asm.groundY : null;
    } catch { return null; }
  }, [corners, vehicle, links, settings]);
}

export function setRideHeight(patch: Partial<{ on: boolean; front: string; rear: string }>) {
  const s = useApp.getState();
  const r = s.rideHeight;
  const num = (text: string | undefined, prev: Field) => {
    if (text === undefined) return prev;
    const v = parseValue(text, 'length');
    return v.ok ? { text, value: v.value } : prev;
  };
  useApp.setState({ rideHeight: { on: patch.on ?? r.on, front: num(patch.front, r.front), rear: num(patch.rear, r.rear) } });
}

export function RideHeightPanel() {
  const r = useApp((s) => s.rideHeight);
  const droop = useApp((s) => s.droop), bump = useApp((s) => s.bump);
  const design = useDesignRideHeight();
  const disp = useDisplay();
  const travelOf = (target: number) => (design === null ? null : staticTravelFor(-design, target, droop, bump));
  const f = r.on ? travelOf(r.front.value) : null, b = r.on ? travelOf(r.rear.value) : null;
  const turnOn = () => {
    // The first time: start from where it rests now.
    if (design !== null && r.front.value === 100 && r.rear.value === 100) useApp.setState({ rideHeight: { on: true, front: fieldOf(design), rear: fieldOf(design) } });
    else setRideHeight({ on: true });
  };
  const at = (t: { travel: number } | null) => (t === null ? '—' : Math.abs(t.travel) < 0.05 ? 'at the design position' : `${disp.format(Math.abs(t.travel), 'mm', 1)} into ${t.travel > 0 ? 'bump' : 'droop'}`);
  return (
    <>
      <label className="check" title="Set: the springs' preload is fitted so the chassis rests at these heights (the suspension at some travel). Not set: it rests at the design position.">
        <input type="checkbox" checked={r.on} onChange={() => (r.on ? setRideHeight({ on: false }) : turnOn())} /> Set the static ride height
      </label>
      {r.on && (
        <FieldRows rows={[
          { label: 'Ride height, front axle', field: r.front, unit: 'mm', hint: 'The chassis reference above the ground at the front axle, at rest.', onCommit: (t: string) => setRideHeight({ front: t }) },
          { label: 'Ride height, rear axle', field: r.rear, unit: 'mm', hint: 'The chassis reference above the ground at the rear axle, at rest.', onCommit: (t: string) => setRideHeight({ rear: t }) },
        ]} />
      )}
      <p className="small-text">
        {design !== null && <>Design position: {disp.format(design, 'mm', 1)} at both axles. </>}
        {r.on && <>At rest the front sits {at(f)}, the rear {at(b)}.</>}
        {!r.on && 'Not set: the car rests at the design position.'}
      </p>
      {(f?.clamped || b?.clamped) && <p className="hint warn-text">Out of reach: {f?.clamped ? 'the front' : ''}{f?.clamped && b?.clamped ? ' and ' : ''}{b?.clamped ? 'the rear' : ''} can&apos;t sit that far {((f?.clamped ? f : b)!.travel > 0) ? 'into bump' : 'into droop'} (travel ±{fmt(Math.max(droop, bump), 0)} mm): it rests at the travel limit. More travel or a different ride height.</p>}
      <p className="hint">The suspension sits at some travel at rest (the dampers at another length, the travel left to the bump stops changes). An input: the optimizers don&apos;t change it.</p>
    </>
  );
}
