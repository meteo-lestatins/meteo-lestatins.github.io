const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// Same fresh-snow convention as Open-Meteo's Météo-France adapter.
// This is not snow depth on the ground. Keep the water equivalent separately.
export function nativeSnowAmounts(total, snowWaterEquivalent) {
  if (!valid(total) || !valid(snowWaterEquivalent) || snowWaterEquivalent > total + .01) {
    return { liquidRain: null, snowfall: null, snowWaterEquivalent: null, snowfallMethod: null };
  }
  const snow = Math.min(total, snowWaterEquivalent);
  const liquid = Math.max(0, total - snow);
  return { liquidRain: liquid < 1e-6 ? 0 : liquid, snowfall: snow * .7,
    snowWaterEquivalent: snow, snowfallMethod: 'water-equivalent-0.7' };
}
