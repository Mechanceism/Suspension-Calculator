/** Units menu (top bar): Metric / Imperial, or Custom with a unit per quantity. Display only. */
import { useEffect, useRef, useState } from 'react';
import { useUnits, activeUnits, DISPLAY_UNITS, QUANTITY_LABELS, type DisplayQuantity, type UnitSystem } from '../units';

const SYSTEMS: { id: UnitSystem; label: string; hint: string }[] = [
  { id: 'metric', label: 'Metric', hint: 'mm · kg · N · kPa · N·m · °C' },
  { id: 'imperial', label: 'Imperial', hint: 'in · lb · lbf · psi · lbf·ft · °F' },
  { id: 'custom', label: 'Custom', hint: 'pick a unit per quantity' },
];

export function UnitsMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const system = useUnits((s) => s.system);
  const custom = useUnits((s) => s.custom);
  const setSystem = useUnits((s) => s.setSystem);
  const setCustom = useUnits((s) => s.setCustom);
  const units = activeUnits({ system, custom });

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <div className="file-menu" ref={root}>
      <button className={`menu-btn${open ? ' on' : ''}`} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}
        title="Display units (the math always runs in mm, kg, N…)">
        Units <span className="muted small-text">{SYSTEMS.find((s) => s.id === system)!.label}</span>
      </button>
      {open && (
        <div className="menu units-menu" role="menu">
          {SYSTEMS.map((s) => (
            <label key={s.id} className="units-choice">
              <input type="radio" name="unit-system" checked={system === s.id} onChange={() => setSystem(s.id)} />
              <span><b>{s.label}</b> <span className="muted small-text">{s.hint}</span></span>
            </label>
          ))}
          <div className="menu-sep" />
          <table className="units-table">
            <tbody>
              {(Object.keys(DISPLAY_UNITS) as DisplayQuantity[]).map((q) => (
                <tr key={q}>
                  <td>{QUANTITY_LABELS[q]}</td>
                  <td>
                    <select value={units[q]} onChange={(e) => setCustom(q, e.target.value)} title="Choosing a unit switches to Custom">
                      {Object.entries(DISPLAY_UNITS[q]).map(([id, d]) => <option key={id} value={id}>{d.label}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint units-hint">
            Rates and gains follow their parts (N/mm → lbf/in, °/mm → °/in). Typed numbers are read in these units;
            a typed unit (<code>5in</code>, <code>12psi</code>) always wins. Saved in this browser, not in the project.
          </p>
        </div>
      )}
    </div>
  );
}
