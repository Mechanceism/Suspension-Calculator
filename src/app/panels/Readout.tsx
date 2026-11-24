import type { Model } from '../useModel';
import { Section, fmt } from './FieldRows';
import { SteeringReadout } from './SteeringPanel';
import { useDisplay } from '../units';
import { useApp } from '../store';
import { cornerResultRows } from '../resultRows';

const STATUS_TEXT: Record<string, string> = {
  converged: 'Solved',
  'under-constrained': 'Under-constrained',
  singular: 'Near toggle / singular',
  'not-converged': 'Cannot reach position',
};


export function Readout({ model }: { model: Model }) {
  const d = useDisplay();
  const damper = useApp((s) => s.damper);
  const cur = model.current;
  if (!cur) return <section className="panel"><h2>Characteristics</h2><p className="muted">{model.error ?? 'No solution'}</p></section>;
  const c = cur.chars;
  const s = cur.state.solve;
  // The rows (shared with the Compare tab): name, formatted value, unit, hint.
  const all = cornerResultRows(model, { bump: damper.bumpDamping.value, rebound: damper.reboundDamping.value });
  const of = (group: string): [string, string, string, string?][] => all.filter((x) => x.group === group).map((x) => [x.label, x.text ?? fmt(x.value, x.digits), x.unit, x.hint]);
  const rows = of('Geometry');
  const sp = cur.spring;
  const springRows = of('Spring & ride');
  const STATUS: Record<string, string> = { 'droop-limit': 'At droop limit', 'bump-limit': 'At bump limit' };
  const l = cur.loaded;
  const tireRows = of('Tire & contact patch');
  const Table = ({ rows: r }: { rows: [string, string, string, string?][] }) => (
    <table className="readout">
      <tbody>
        {r.map(([name, value, unit, hint]) => {
          const shown = d.text(value, unit);
          return (
            <tr key={name} title={hint}>
              <td>{name}</td>
              <td className="num">{shown.text}</td>
              <td className="unit">{shown.unit}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
  return (
    <section className="panel">
      <h2>
        Results
        <span className={`status status-${s.status}`} title={`RMS residual ${s.residualRms.toExponential(1)} mm · conditioning ${s.conditioning.toExponential(1)}`}>
          {STATUS_TEXT[s.status] ?? s.status}
        </span>
      </h2>
      <Section title="Geometry"><Table rows={rows} /></Section>
      {sp && (
        <Section
          title="Spring & ride"
          extra={sp.status && sp.status !== 'ok' ? <span className="status status-singular">{STATUS[sp.status]}</span> : undefined}
        >
          <Table rows={springRows} />
        </Section>
      )}
      {cur.steering && (
        <Section title="Steering"><SteeringReadout model={model} /></Section>
      )}
      {l && (
        <Section
          title="Tire & contact patch"
          extra={l.bottomedOut ? <span className="status status-not-converged">Bottomed out</span> : undefined}
        >
          <Table rows={tireRows} />
        </Section>
      )}
    </section>
  );
}
