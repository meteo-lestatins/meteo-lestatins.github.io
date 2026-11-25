const HOUR = 3600000;
const plotHeight = baseline => baseline / 2;
export const minimumRainBarHeight = 6;
const rainColorMaximum = 7;
const rainColorMidpoint = 2.25;
const rainStops = [[0, 'low'], [100 * rainColorMidpoint / rainColorMaximum, 'medium'], [100, 'high']];
const rainRamp = rainStops.map(([offset, level]) => `<stop offset="${offset}%" class="day-rain-${level}"/>`).join('');
const number = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });

export function precipitation24h(group) {
  const snowPhase = ['snow', 'snow-unknown', 'mixed'].includes(group.phase);
  const snow = snowPhase && group.snowfall > 0 ? group.snowfall : 0;
  const liquidKnown = Number.isFinite(group.liquidRain);
  const equivalent = snow ? group.phase === 'mixed' && !liquidKnown
    : snowPhase || group.phase === 'unknown' || !liquidKnown && group.phase !== 'rain';
  const rain = snow && !equivalent ? (liquidKnown ? group.liquidRain : 0) : group.rain;
  const hours = (group.end - group.start) / HOUR;
  return { group, rain, snow, equivalent, rainRate: rain / hours, snowRate: snow / hours };
}

export function precipitation24hScales(bars) {
  const rainBars = bars.filter(bar => bar.rain >= .01 - 1e-9);
  const snowPeak = Math.max(1, ...bars.map(bar => bar.snowRate));
  const magnitude = 10 ** Math.floor(Math.log10(snowPeak));
  return {
    rain: rainBars.length ? Math.max(10, ...rainBars.filter(bar => bar.rain >= .1 - 1e-9).map(bar => bar.rainRate)) : 0,
    snow: bars.some(bar => bar.snow > 0) ? [1, 2, 5, 10].find(step => step * magnitude >= snowPeak) * magnitude : 0,
    equivalent: rainBars.some(bar => bar.equivalent),
  };
}

export function precipitation24hHeight(rate, maximum, baseline) {
  return maximum > 0 ? plotHeight(baseline) * rate / maximum : 0;
}

export function rainIntensityGradient(id, baseline, range, maximum) {
  const end = baseline - range * rainColorMaximum / maximum;
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${baseline}" y2="${end}">${rainRamp}</linearGradient>`;
}

export function precipitation24hGradient(id, baseline, maximum) {
  return rainIntensityGradient(id, baseline, plotHeight(baseline), maximum);
}

export function rainBarDropsMarkup(left, right, top, rate) {
  const width = right - left;
  if (width < 10) return '';
  const spacing = 49;
  const count = Math.max(1, Math.round(width / spacing));
  const first = (left + right - (count - 1) * spacing) / 2;
  const offsets = [2, 7, 4, 9, 5];
  const firstPosition = Math.round(first / spacing);
  const intensity = Math.min(rainColorMaximum, Math.max(0, rate));
  const [startColor, endColor, mix] = intensity <= rainColorMidpoint
    ? ['low', 'medium', intensity / rainColorMidpoint]
    : ['medium', 'high', (intensity - rainColorMidpoint) / (rainColorMaximum - rainColorMidpoint)];
  const fill = `color-mix(in srgb, var(--rain-${startColor}), var(--rain-${endColor}) ${(mix * 100).toFixed(3)}%)`;
  return Array.from({ length: count }, (_, index) => {
    const offset = offsets[(firstPosition + index) % offsets.length];
    return `<path class="rain-bar-drop" transform="translate(${first + index * spacing} ${top - offset}) scale(1.6)" style="fill:${fill}" d="M0 -6 C-1.2 -4.4 -2.4 -3.2 -2.4 -2.1 C-2.4 .7 2.4 .7 2.4 -2.1 C2.4 -3.2 1.2 -4.4 0 -6Z" aria-hidden="true"/>`;
  }).join('');
}

export function precipitation24hBarMarkup({ left, right, baseline, rainHeight, snowHeight, rainRate, trace, gradient, edge }) {
  const width = right - left;
  const rainTop = baseline - rainHeight;
  const rainDrops = rainHeight > 0 && snowHeight === 0 && !trace && !edge ? rainBarDropsMarkup(left, right, rainTop, rainRate) : '';
  const rainBar = rainHeight > 0 ? `<rect x="${left}" y="${rainTop}" width="${width}" height="${rainHeight}" class="day-combined-rain${trace ? ' day-combined-rain-trace' : ''}${edge ? ' day-adjacent-rain' : ''}" style="fill:url(#${gradient});opacity:1"/>` : '';
  const snowTop = baseline - snowHeight;
  const snowBar = snowHeight > 0 ? `<rect class="piaf-snow-bar" x="${left}" y="${snowTop}" width="${width}" height="${snowHeight}"/>` : '';
  const snowEdge = snowHeight > 0 ? `<path class="piaf-snow-bar-edge" d="M${left},${snowTop - 7.1} V${baseline} H${right} V${snowTop - 7.1}" aria-hidden="true"/>` : '';
  // Both measurements cover the same interval and use their own scale from the baseline.
  return snowBar + rainBar + snowEdge + rainDrops;
}

export function precipitation24hLegend(scales, gradient) {
  const axes = [];
  function axis(name, unit, maximum, snow) {
    const title = `${name}, échelle de 0 à ${number.format(maximum)} ${unit}${!snow && scales.equivalent ? ' en équivalent eau pour les créneaux sans répartition pluie/neige' : ''}`;
    const legendId = `${gradient}-legend`;
    const swatch = snow ? '<rect class="piaf-snow-bar day-precipitation-snow-key" x=".5" y=".5" width="81" height="5"/>'
      : `<defs><linearGradient id="${legendId}" x2="${100 * rainColorMaximum / maximum}%">${rainRamp}</linearGradient></defs><rect width="82" height="6" fill="url(#${legendId})"/>`;
    const ticks = [0, maximum / 2, maximum].map(rate => `<span>${number.format(rate)}</span>`).join('');
    return `<span class="day-precipitation-scale" role="img" aria-label="${title}"><span class="day-precipitation-scale-name">${name} ${unit}</span><span class="day-precipitation-range"><svg class="day-precipitation-swatch" viewBox="0 0 82 6" aria-hidden="true">${swatch}</svg><span class="day-precipitation-ticks">${ticks}</span></span></span>`;
  }
  if (scales.rain) axes.push(axis(scales.equivalent ? 'Précip.' : 'Pluie', 'mm/h', scales.rain, false));
  if (scales.snow) axes.push(axis('Neige', 'cm/h', scales.snow, true));
  return axes.length ? `<span class="day-precipitation-scales">${axes.join('')}</span>` : '';
}
