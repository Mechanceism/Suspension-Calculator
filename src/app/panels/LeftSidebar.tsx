import { useApp } from '../store';
import type { Model } from '../useModel';
import { Inspector } from './Inspector';
import { Browser } from './Browser';
import { Hardpoints } from './Hardpoints';
import { SpringPanel } from './SpringPanel';
import { TirePanel } from './TirePanel';
import { SteeringPanel } from './SteeringPanel';
import { CornerSetup } from './VehiclePanels';
import { Section } from './FieldRows';
import { LocksPanel } from './LocksPanel';
import { OptimizePanel } from './OptimizePanel';

const TABS = [
  { id: 'inspector', label: 'Inspector' },
  { id: 'browser', label: 'Browser' },
  { id: 'table', label: 'Inputs' },
  { id: 'locks', label: 'Locks' },
  { id: 'optimize', label: 'Optimize' },
] as const;

export function LeftSidebar({ model }: { model: Model }) {
  const tab = useApp((s) => s.leftTab);
  const set = useApp((s) => s.set);
  const nLocks = useApp((s) => Object.keys(s.locks).length);
  return (
    <>
      <div className="corner-bar">
        <Section title="Corner" extra={<span className="muted small-text">pick · settings · links</span>}>
          <CornerSetup />
        </Section>
      </div>
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => set('leftTab', t.id)}>
            {t.label}{t.id === 'locks' && nLocks > 0 && <span className="tab-count">{nLocks}</span>}
          </button>
        ))}
      </nav>
      <div className="tab-body">
        {tab === 'inspector' && <Inspector model={model} />}
        {tab === 'browser' && <Browser />}
        {tab === 'locks' && <LocksPanel />}
        {tab === 'optimize' && <OptimizePanel />}
        {tab === 'table' && (
          <>
            <Hardpoints />
            <SpringPanel model={model} />
            <SteeringPanel model={model} />
            <TirePanel />
          </>
        )}
      </div>
    </>
  );
}
