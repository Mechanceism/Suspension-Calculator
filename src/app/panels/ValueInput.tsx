import { useEffect, useState } from 'react';
import { useApp, type Field } from '../store';

/** Lock toggle for one or more lock keys (locked = every key locked). */
export function LockButton({ keys, title }: { keys: string[]; title?: string }) {
  const locked = useApp((s) => keys.length > 0 && keys.every((k) => s.locks[k]));
  const partial = useApp((s) => !locked && keys.some((k) => s.locks[k]));
  const setLocks = useApp((s) => s.setLocks);
  return (
    <button
      type="button"
      className={`lock-btn${locked ? ' on' : partial ? ' partial' : ''}`}
      onClick={() => setLocks(keys, !locked)}
      title={title ?? (locked ? 'Locked: the optimizer must keep this. Click to unlock.' : 'Lock so the optimizer keeps this value')}
      aria-pressed={locked}
    >
      {locked ? '🔒' : '🔓'}
    </button>
  );
}

/**
 * Text entry with unit parsing. Commits on Enter or blur. Keeps the user's text (e.g. "5in");
 * the tooltip shows the parsed base value. With `lockKey`, shows a lock toggle; a locked value can
 * still be typed, but it's highlighted so it's clear the optimizer won't change it.
 */
export function ValueInput({ field, unit, onCommit, width, lockKey, locked: lockedProp }: {
  field: Field; unit: string; onCommit: (text: string) => void; width?: number;
  lockKey?: string;
  /** Show as locked without a toggle (e.g. a coordinate locked through its part). */
  locked?: boolean;
}) {
  const [text, setText] = useState(field.text);
  useEffect(() => setText(field.text), [field.text]);
  const lockedByKey = useApp((s) => (lockKey ? !!s.locks[lockKey] : false));
  const locked = lockedByKey || !!lockedProp;
  const commit = () => { if (text !== field.text) onCommit(text); };
  const input = (
    <input
      className={`value-input${field.error ? ' invalid' : ''}${locked ? ' locked' : ''}`}
      style={width ? { width } : undefined}
      value={text}
      title={field.error ?? `${Number(field.value.toFixed(4))} ${unit}${locked ? ' · locked' : ''}`}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
        if (e.key === 'Escape') { setText(field.text); (e.target as HTMLInputElement).blur(); }
      }}
      spellCheck={false}
    />
  );
  if (!lockKey) return input;
  return <span className="vi-wrap">{input}<LockButton keys={[lockKey]} /></span>;
}
