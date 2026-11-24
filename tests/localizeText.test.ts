import { describe, expect, it } from 'vitest';
import { localizeText, PRESETS } from '../src/app/units';

const imp = PRESETS.imperial, met = PRESETS.metric;

describe('values in sentences shown in the display units', () => {
  it('leaves metric text as written', () => {
    const t = 'Too tight for the steering: needs 26.7° (rack 26.0 mm, limit ±25 mm); 34 km/h at the end instead of 48 km/h; 1.02 m off the line';
    expect(localizeText(t, met)).toBe(t);
  });

  it('converts each value, keeping its precision, signs and ranges', () => {
    expect(localizeText('(rack 26.0 mm, limit ±25 mm); full lock gives 25.6°', imp)).toBe('(rack 1.02 in, limit ±1.0 in); full lock gives 25.6°');
    expect(localizeText('34 km/h at the end instead of 48 km/h', imp)).toBe('21 mph at the end instead of 30 mph');
    expect(localizeText('1.02 m off the line (left of the path)', imp)).toBe('3.3 ft off the line (left of the path)');
    expect(localizeText('Hitch load 4500 N is above its rating (4000 N)', imp)).toBe('Hitch load 1012 lbf is above its rating (899 lbf)');
    expect(localizeText('rotors 450 °C front, 300 °C rear', imp)).toBe('rotors 842 °F front, 572 °F rear');
    expect(localizeText('travel 12–30 mm', imp)).toBe('travel 0.5–1.2 in');
    expect(localizeText('a −4.0 mm move', imp)).toBe('a −0.16 in move');
  });

  it('leaves units it does not own alone', () => {
    const t = 'air 1.225 kg/m³ · 0.7 g · 9.81 m/s² · 12 % · 3 times · 5 min';
    expect(localizeText(t, imp)).toBe(t);
  });
});
