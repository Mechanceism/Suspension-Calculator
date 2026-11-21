/**
 * Tire size designations → dimensions (mm). docs/MATH.md § Tire Size Input.
 *
 *   Metric (ISO):       225/45R17, P205/55R16, LT265/70R17   width mm / aspect % / rim in
 *   Flotation / inch:   31x10.50R15                         OD in x width in, rim in
 *   Racing / off-road:  20.5x7.0-13                         OD in x width in - rim in
 */

export type TireSizeFormat = 'metric' | 'inch';

export interface TireSize {
  format: TireSizeFormat;
  outerDiameter: number;
  sectionWidth: number;
  rimDiameter: number;
  sidewallHeight: number;
}

const IN = 25.4;
const METRIC = /^\s*(?:P|LT|ST|T)?\s*(\d{3})\s*\/\s*(\d{2,3})\s*(?:Z?R|RF|D|B|-)\s*(\d{2}(?:\.\d)?)\b/i;
const INCH = /^\s*(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)\s*(?:Z?R|D|B|-)?\s*(\d+(?:\.\d+)?)\b/;

export function parseTireSize(text: string): TireSize | null {
  const m = METRIC.exec(text);
  if (m) {
    const width = Number(m[1]);
    const aspect = Number(m[2]) / 100;
    const rim = Number(m[3]) * IN;
    const sidewall = width * aspect;
    return { format: 'metric', sectionWidth: width, rimDiameter: rim, sidewallHeight: sidewall, outerDiameter: rim + 2 * sidewall };
  }
  const i = INCH.exec(text);
  if (i) {
    const od = Number(i[1]) * IN;
    const width = Number(i[2]) * IN;
    const rim = Number(i[3]) * IN;
    if (!(od > rim)) return null;
    return { format: 'inch', outerDiameter: od, sectionWidth: width, rimDiameter: rim, sidewallHeight: (od - rim) / 2 };
  }
  return null;
}
