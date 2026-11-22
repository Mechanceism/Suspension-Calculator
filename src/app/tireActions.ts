/**
 * Loading `.tir` tire files (File → Import → Tire, and the tire grip editor): parse, report, use the model
 * on both axles / the front / the rear, and offer the file's tire size when it has one.
 */
import { parseTir, type TirModel } from '../core/tire/tir';
import { useApp, type TireAxle } from './store';

/** Tire size in the file (mm), when it has one. */
export function tirDimensions(m: TirModel): { outerDiameter?: number; width?: number; rimDiameter?: number } | null {
  const r = m.p.UNLOADED_RADIUS, w = m.p.WIDTH, rim = m.p.RIM_RADIUS;
  const out = {
    ...(r && r > 0 ? { outerDiameter: 2 * r * 1000 } : {}),
    ...(w && w > 0 ? { width: w * 1000 } : {}),
    ...(rim && rim > 0 ? { rimDiameter: 2 * rim * 1000 } : {}),
  };
  return Object.keys(out).length ? out : null;
}

const axleText = (a: TireAxle) => (a === 'both' ? 'all four tires' : a === 'front' ? 'the front tires' : 'the rear tires');

export async function importTireFile(file: File, axle: TireAxle = 'both'): Promise<TirModel | null> {
  const s = useApp.getState();
  const r = parseTir(await file.text(), file.name);
  if (!r.model) { s.notify(`Couldn't use ${file.name}:\n${r.errors.join('\n')}`, 'error'); return null; }
  s.setTireFile(r.model, axle);
  s.notify(`Tire model from ${file.name} for ${axleText(axle)} (Magic Formula ${r.model.version}, ${Object.keys(r.model.p).length} values).${r.warnings.length ? `\n${r.warnings.join('\n')}` : ''}`, r.warnings.length ? 'warn' : 'info');
  const dims = tirDimensions(r.model);
  if (dims) {
    const parts = [dims.outerDiameter ? `${dims.outerDiameter.toFixed(0)} mm diameter` : '', dims.width ? `${dims.width.toFixed(0)} mm wide` : '', dims.rimDiameter ? `${(dims.rimDiameter / 25.4).toFixed(1)}" rim` : ''].filter(Boolean).join(', ');
    if (window.confirm(`${file.name} gives a tire size: ${parts}. Use it for ${axleText(axle)}?`)) s.applyTireDims(axle, dims);
  }
  return r.model;
}
