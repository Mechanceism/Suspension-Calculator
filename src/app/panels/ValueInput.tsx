import { useEffect, useState } from 'react';
import type { Field } from '../store';

/**
 * Text entry with unit parsing. Commits on Enter or blur. Keeps the user's text (e.g. "5in");
 * the tooltip shows the parsed base value.
 */
export function ValueInput({ field, unit, onCommit, width }: {
  field: Field; unit: string; onCommit: (text: string) => void; width?: number;
}) {
  const [text, setText] = useState(field.text);
  useEffect(() => setText(field.text), [field.text]);
  const commit = () => { if (text !== field.text) onCommit(text); };
  return (
    <input
      className={`value-input${field.error ? ' invalid' : ''}`}
      style={width ? { width } : undefined}
      value={text}
      title={field.error ?? `${Number(field.value.toFixed(4))} ${unit}`}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
        if (e.key === 'Escape') { setText(field.text); (e.target as HTMLInputElement).blur(); }
      }}
      spellCheck={false}
    />
  );
}
