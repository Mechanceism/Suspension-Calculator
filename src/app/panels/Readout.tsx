import { deg } from '../../core/suspension/characteristics';
import type { Model } from '../useModel';

const fmt = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined || Number.isNaN(v) ? '—' : Number.isFinite(v) ? v.toFixed(digits) : '∞';

const STATUS_TEXT: Record<string, string> = {
  converged: 'Solved',
  'under-constrained': 'Under-constrained',
  singular: 'Near toggle / singular',
  'not-converged': 'Cannot reach position',
};

export function Readout({ model }: { model: Model }) {
  const cur = model.current;
  if (!cur) return <section className="panel"><h2>Characteristics</h2><p className="muted">{model.error ?? 'No solution'}</p></section>;
  const c = cur.chars;
  const s = cur.state.solve;
  const rows: [string, string, string, string?][] = [
    ['Camber', fmt(deg(c.camber), 3), '°', '+ = top outboard'],
    ['Camber gain', fmt(cur.camberGain, 4), '°/mm'],
    ['Toe', fmt(deg(c.toe), 3), '°', '+ = toe-in'],
    ['Bump steer', fmt(cur.bumpSteer, 4), '°/mm'],
    ['Caster', fmt(deg(c.caster), 2), '°', '+ = top rearward'],
    ['KPI', fmt(deg(c.kpi), 2), '°', '+ = top inboard'],
    ['Scrub radius', fmt(c.scrubRadius, 1), 'mm', '+ = axis inboard at ground'],
    ['Mechanical trail', fmt(c.mechanicalTrail, 1), 'mm', '+ = axis ahead at ground'],
    ['Kingpin offset @ WC', fmt(c.kingpinOffsetAtWheelCenter, 1), 'mm'],
    ['Caster offset @ WC', fmt(c.casterOffsetAtWheelCenter, 1), 'mm'],
    ['FVSA', fmt(c.fvsa, 0), 'mm', '+ = IC inboard'],
    ['Roll center height', fmt(c.rollCenterHeight, 1), 'mm', 'mirrored corner'],
    ['SVSA', fmt(c.svsa, 0), 'mm', '+ = IC behind'],
    ['Anti angle (contact)', fmt(deg(c.antiAngleContact), 2), '°'],
    ['Half track', fmt(c.halfTrack, 1), 'mm'],
    ['Wheel center Y', fmt(c.wheelCenter.y, 1), 'mm'],
    ['Ground Y', fmt(cur.loaded ? cur.loaded.groundY : c.groundY, 1), 'mm', 'ride height = −ground Y'],
  ];
  const sp = cur.spring;
  const springRows: [string, string, string, string?][] = sp ? [
    ['Wheel travel', fmt(cur.travel, 1), 'mm', 'wheel center, + = bump'],
    ['Sprung load on spring', fmt(sp.sprungLoad, 0), 'N', '(corner load − unsprung weight) × load factor'],
    ['Spring force', fmt(sp.force, 0), 'N'],
    ['Spring length', fmt(sp.length, 1), 'mm'],
    ['Spring compression', fmt(sp.compression, 1), 'mm', 'from free length'],
    ['Motion ratio', fmt(sp.motionRatio, 3), '', 'spring mm per wheel mm'],
    ['Wheel rate', fmt(sp.wheelRate, 1), 'N/mm'],
    ['Tire rate', fmt(sp.tireRate, 0), 'N/mm'],
    ['Ride rate', fmt(sp.rideRate, 1), 'N/mm', 'wheel rate in series with tire'],
    ['Ride frequency', fmt(sp.frequency, 2), 'Hz', 'sprung corner'],
  ] : [];
  const STATUS: Record<string, string> = { 'droop-limit': 'At droop limit', 'bump-limit': 'At bump limit' };
  const l = cur.loaded;
  const tireRows: [string, string, string, string?][] = l ? [
    ['Tire load', fmt(l.force.force, 0), 'N'],
    ['Deflection', fmt(l.deflection, 2), 'mm', 'ground rise vs. rigid tire'],
    ['Patch area', fmt(l.patch.area / 100, 1), 'cm²'],
    ['Patch length', fmt(l.patch.length, 1), 'mm'],
    ['Patch width', fmt(l.patch.sMax - l.patch.sMin, 1), 'mm', 'along the axle'],
    ['Inclination', fmt(deg(l.patch.inclination), 3), '°', 'wheel vs. ground normal'],
    ['Pressure (gauge)', fmt(l.force.pressureGauge, 2), 'kPa', 'operating'],
    ['Air volume change', fmt(l.force.volumeChangeRatio !== undefined ? l.force.volumeChangeRatio * 100 : undefined, 3), '%'],
    ['Effective scrub', fmt(l.effectiveScrubRadius, 1), 'mm', 'to patch centroid'],
    ['Effective trail', fmt(l.effectiveTrail, 1), 'mm', 'to patch centroid'],
  ] : [];
  return (
    <section className="panel">
      <h2>
        Characteristics
        <span className={`status status-${s.status}`} title={`RMS residual ${s.residualRms.toExponential(1)} mm · conditioning ${s.conditioning.toExponential(1)}`}>
          {STATUS_TEXT[s.status] ?? s.status}
        </span>
      </h2>
      <table className="readout">
        <tbody>
          {rows.map(([name, value, unit, hint]) => (
            <tr key={name} title={hint}>
              <td>{name}</td>
              <td className="num">{value}</td>
              <td className="unit">{unit}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sp && (
        <>
          <h3 className="subhead">
            Spring & ride
            {sp.status && sp.status !== 'ok' && <span className="status status-singular">{STATUS[sp.status]}</span>}
          </h3>
          <table className="readout">
            <tbody>
              {springRows.map(([name, value, unit, hint]) => (
                <tr key={name} title={hint}>
                  <td>{name}</td>
                  <td className="num">{value}</td>
                  <td className="unit">{unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {l && (
        <>
          <h3 className="subhead">
            Tire & contact patch
            {l.bottomedOut && <span className="status status-not-converged">Bottomed out</span>}
          </h3>
          <table className="readout">
            <tbody>
              {tireRows.map(([name, value, unit, hint]) => (
                <tr key={name} title={hint}>
                  <td>{name}</td>
                  <td className="num">{value}</td>
                  <td className="unit">{unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
