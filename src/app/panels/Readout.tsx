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
    ['Ground Y', fmt(c.groundY, 1), 'mm', 'ride height = −ground Y'],
  ];
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
    </section>
  );
}
