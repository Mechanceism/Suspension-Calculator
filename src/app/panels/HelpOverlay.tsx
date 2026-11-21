/** Keyboard & mouse help (press ? or click the ? button). */
import { useEffect } from 'react';

const SECTIONS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'View',
    rows: [
      ['Drag', 'Orbit'],
      ['Right-drag', 'Pan'],
      ['Wheel', 'Zoom'],
      ['Double middle-click / ⤢ Fit', 'Fit everything in view'],
      ['Front / Rear / … buttons', 'Standard views'],
      ['View menu', 'Show / hide parts in every view'],
    ],
  },
  {
    title: 'Editing',
    rows: [
      ['Click a part or joint', 'Edit it in the Inspector'],
      ['Shift / Ctrl + click', 'Add to a multi-selection'],
      ['Drag X / Y / Z arrows', 'Move the selection (snaps to the grid if on)'],
      ['Drag the yellow → arrow', 'Slide a joint along its line (Inspector → Along the line toward)'],
      ['🔓 / 🔒', 'Lock a value for the optimizer'],
      ['Esc', 'Clear the selection / leave the measure tool'],
    ],
  },
  {
    title: 'Measure & set',
    rows: [
      ['M or 📏 Measure', 'Measure tool: click two points'],
      ['Set dimension panel', 'Type a distance, ΔX/ΔY/ΔZ or a view angle to move one point'],
      ['📏 on a tie rod / coilover', 'Measure and set that part'],
    ],
  },
  {
    title: 'File & history',
    rows: [
      ['Ctrl + Z', 'Undo'],
      ['Ctrl + Y / Ctrl + Shift + Z', 'Redo'],
      ['Ctrl + S', 'Save'],
      ['Ctrl + Shift + S', 'Save as'],
      ['?', 'This help'],
    ],
  },
];

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="help-backdrop" onMouseDown={onClose}>
      <div className="help-panel" role="dialog" aria-label="Keyboard and mouse help" onMouseDown={(e) => e.stopPropagation()}>
        <div className="help-head"><b>Keyboard & mouse</b><button className="icon-btn" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="help-grid">
          {SECTIONS.map((s) => (
            <section key={s.title}>
              <h3 className="subhead">{s.title}</h3>
              <table>
                <tbody>
                  {s.rows.map(([k, v]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{v}</td></tr>)}
                </tbody>
              </table>
            </section>
          ))}
        </div>
        <p className="hint">Values accept units (<code>5in</code>, <code>1ft 2in</code>, <code>12psi</code>); plain numbers use the Units menu.</p>
      </div>
    </div>
  );
}
