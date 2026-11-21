import { useApp } from '../store';
import type { Model } from '../useModel';
import { Inspector } from './Inspector';
import { Browser } from './Browser';
import { Hardpoints } from './Hardpoints';
import { SpringPanel } from './SpringPanel';
import { TirePanel } from './TirePanel';
import { SteeringPanel } from './SteeringPanel';

const TABS = [
  { id: 'inspector', label: 'Inspector' },
  { id: 'browser', label: 'Browser' },
  { id: 'table', label: 'All inputs' },
] as const;

export function LeftSidebar({ model }: { model: Model }) {
  const tab = useApp((s) => s.leftTab);
  const set = useApp((s) => s.set);
  return (
    <>
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => set('leftTab', t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      <div className="tab-body">
        {tab === 'inspector' && <Inspector model={model} />}
        {tab === 'browser' && <Browser />}
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
