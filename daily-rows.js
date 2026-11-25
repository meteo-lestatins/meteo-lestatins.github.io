import { prepareBasicForecast } from './forecast-core.js';
import { precipitation24h, precipitation24hScales, precipitation24hHeight, precipitation24hGradient,
  precipitation24hLegend, precipitation24hBarMarkup, minimumRainBarHeight, rainBarDropsMarkup, rainIntensityGradient } from './precipitation-24h.js';

const HOUR = 3600000;
const CHART_INSET = 30;
const CHART_SLOT_WIDTH = 69;
const valid = value => typeof value === 'number' && Number.isFinite(value);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const number = value => valid(value) ? value.toLocaleString('fr-FR', { maximumFractionDigits: 1 }) : '—';
const rainNumber = value => valid(value) ? value.toLocaleString('fr-FR', { maximumFractionDigits: 2 }) : '—';
const rainDetailNumber = value => valid(value) && value > 0 && value < .005 ? '< 0,01' : rainNumber(value);
const snowLabel = value => (value > 0 && Math.round(value) === 0 ? '< 1' : Math.round(value).toLocaleString('fr-FR')) + ' cm';
const snowPhase = sample => ['snow', 'snow-unknown', 'mixed'].includes(sample.phase || precipitationPhase(sample));
const displayedSnowfall = sample => valid(sample.snowfall) ? snowPhase(sample) ? sample.snowfall : 0 : null;
const rainVisible = value => valid(value) && value >= .01 - 1e-9;
const rainTrace = value => rainVisible(value) && value < .1 - 1e-9;
const rainLabelParts = (group, withUnit = false) => {
  const suffix = group.estimated ? '*' : '';
  if (group.source === 'PIAF') return [(rainTrace(group.rain) ? 'gouttes' : rainNumber(group.rain) + ' mm') + suffix];
  if (group.snowfall > 0 && snowPhase(group)) {
    const snow = snowLabel(group.snowfall) + suffix;
    return rainVisible(group.liquidRain) ? [(rainTrace(group.liquidRain) ? 'gouttes' : rainNumber(group.liquidRain) + ' mm') + suffix, snow] : [snow];
  }
  if (['snow', 'snow-unknown', 'mixed'].includes(group.phase)) return ['Neige' + suffix];
  return [(rainTrace(group.rain) ? 'gouttes' : rainNumber(group.rain) + (withUnit ? ' mm' : '')) + suffix];
};
const rainLabelWidth = (group, withUnit = false) => Math.max(28, ...rainLabelParts(group, withUnit).map(text => text.length * 6.5));
const values = (samples, key) => samples.map(sample => sample[key]).filter(valid);
export const notableGust = 50;

export function windSummaryMarkup(wind, gust, causes) {
  const reading = (value, name, highlighted, mean = false) => {
    const speed = Math.round(value).toLocaleString('fr-FR');
    const label = `${name} jusqu’à ${speed} km/h`;
    return `<span class="wind-reading${mean ? ' wind-mean' : ''}" title="${label}" aria-label="${label}"><span class="gust-speed${highlighted ? ' alert-value' : ''}" aria-hidden="true">${speed}</span><span class="gust-unit" aria-hidden="true"><span>km</span><span>h</span></span></span>`;
  };
  const gusts = valid(gust) && (gust >= notableGust || causes.gust) ? reading(gust, 'Rafales', Boolean(causes.gust)) : '';
  const mean = valid(wind) && (gusts || causes.wind) ? reading(wind, 'Vent moyen', Boolean(causes.wind), true) : '';
  const divider = mean && gusts ? '<span class="wind-divider" aria-hidden="true">/</span>' : '';
  return mean || gusts ? `<span class="gust-total">${mean}${divider}${gusts}</span>` : '';
}

// Shared snowdrift outline: separate horizontal plateaus, never a bridge over
// a dry interval or a vertical cap between two different intensities.
function snowCapMarkup(plateaus) {
  const contour = plateaus.map(plateau => {
    const { left: start, right: stop, level, stamp } = plateau;
    const count = Math.max(3, Math.floor((stop - start) / 24));
    const seed = Math.floor(stamp / 300000);
    const lengths = Array.from({ length: count }, (_, index) => [.8, 1.2, .65, 1.4, 1][(index + seed) % 5]);
    const totalLength = lengths.reduce((sum, value) => sum + value, 0);
    let cursor = start, previousY = level, path = 'M' + start + ',' + level;
    for (let index = 0; index < count; index++) {
      const nextX = index === count - 1 ? stop : cursor + (stop - start) * lengths[index] / totalLength;
      const nextY = index === count - 1 ? level : level - [1.1, 2.4, .7, 1.8, .3, 2.8][(index + seed) % 6];
      const middle = (cursor + nextX) / 2;
      path += ' C' + middle + ',' + previousY + ' ' + middle + ',' + nextY + ' ' + nextX + ',' + nextY;
      cursor = nextX; previousY = nextY;
    }
    return path;
  }).join(' ');
  return contour ? `<g class="piaf-snow-caps" aria-hidden="true"><path class="piaf-snow-cap-outline" d="${contour}"/><path class="piaf-snow-cap" d="${contour}"/></g>` : '';
}

export function precipitationPhase(sample) {
  if (sample.rain === 0 && !(sample.snowfall > 0)) return 'dry';
  // A sub-millimetre snow trace must not announce a snowy period.
  // Decide on the native interval, before clipping or grouping; retain raw amounts.
  if (sample.snowfall > 0 && sample.snowfall < .1
    && ![71, 73, 75, 77, 85, 86].includes(sample.weatherCode)) return sample.liquidRain > 0 ? 'rain' : 'unknown';
  if (sample.snowfall > 0) return sample.liquidRain > 0 ? 'mixed' : sample.liquidRain === 0 ? 'snow' : 'snow-unknown';
  if ([56, 57, 66, 67].includes(sample.weatherCode)) return 'freezing';
  if (sample.snowfall === 0 && sample.liquidRain > 0) return 'rain';
  if ([71, 73, 75, 77, 85, 86].includes(sample.weatherCode)) return 'snow';
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(sample.weatherCode)) return 'rain';
  return sample.rain > 0 ? 'unknown' : null;
}

function precipitationSummary(samples) {
  const wet = samples.filter(sample => sample.rain > 0 || sample.snowfall > 0);
  const representative = wet.reduce((chosen, sample) => !chosen || (sample.rain || 0) > (chosen.rain || 0) ? sample : chosen, null);
  const phases = [...new Set(wet.map(sample => sample.phase || precipitationPhase(sample)).filter(Boolean))];
  return { phase: representative?.phase || (representative ? precipitationPhase(representative)
    : samples.length && samples.every(sample => sample.rain === 0) ? 'dry' : null),
    snowfall: representative?.snowfall ?? null, liquidRain: representative?.liquidRain ?? null,
    phaseDescription: phases.length > 1 ? 'Précipitations de natures différentes selon les créneaux ; pictogramme du créneau le plus intense' : null };
}

// Use the end of acquired intervals, including dry intervals, never the
// requested horizon. Missing coverage stays unknown.
function precipitationCoverageEnd(intervals, timezone, { minuteUnit = '', before = Infinity } = {}) {
  const ends = intervals.map(interval => interval.end).filter(valid);
  const end = Math.max(...ends);
  if (!ends.length || end >= before) return '';
  const parts = new Intl.DateTimeFormat('fr-FR', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(end);
  const hour = parts.find(part => part.type === 'hour').value;
  const minute = parts.find(part => part.type === 'minute').value;
  return hour + ' h' + (minute === '00' ? '' : ' ' + minute + minuteUnit);
}

export function precipitationCoverageSuffix(intervals, timezone = 'Europe/Paris') {
  const time = precipitationCoverageEnd(intervals, timezone);
  return time ? ` (jusqu’à ${time})` : '';
}

export function localDateKey(time, timezone = 'Europe/Paris') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(time);
}

function localTime(date, hour, timezone) {
  const assumed = Date.parse(date + 'T00:00:00Z') + hour * HOUR;
  let time = assumed;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(formatter.formatToParts(time).map(part => [part.type, part.value]));
    const represented = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    time += assumed - represented;
  }
  return time;
}

function series(hours = [], source) {
  return hours.map(hour => ({ ...hour, source, stamp: Date.parse(hour.time) })).filter(hour => valid(hour.stamp)).sort((a, b) => a.stamp - b.stamp);
}

const forecastSources = (dashboard, week) => [series(dashboard.arome?.hours, 'AROME'), series(week?.hours, 'ARPEGE'), series(dashboard.openMeteo?.hours, 'Open-Meteo')];

function sourceUpdatesMarkup(updates, timezone, now) {
  if (!updates.length) return '';
  const format = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: timezone });
  return `<span class="day-source" aria-label="Sources et dernières mises à jour">${updates.map(source => {
    const stamp = source.fetchedAt instanceof Date ? source.fetchedAt.getTime()
      : typeof source.fetchedAt === 'string' ? Date.parse(source.fetchedAt) : source.fetchedAt;
    if (!valid(stamp) || stamp <= 0) return `<span>${escape(source.name)} · date inconnue</span>`;
    const minutes = Math.floor((now - stamp) / 60000);
    const age = minutes < 0 ? 'date future' : minutes === 0 ? 'à l’instant'
      : minutes < 60 ? `il y a ${minutes}min` : `il y a ${Math.floor(minutes / 60)}h, ${minutes % 60}min`;
    return `<span>${escape(source.name)} · <time datetime="${new Date(stamp).toISOString()}" title="${escape(format.format(stamp))}">${age}</time></span>`;
  }).join(' · ')}</span>`;
}

export function weatherPictogram(sample, iconMarkup) {
  const storm = sample.stormSignal === true;
  const phase = sample.phase || precipitationPhase(sample);
  const trace = phase === 'rain' && sample.rainTrace;
  const snow = ['snow', 'mixed', 'snow-unknown'].includes(phase), freezing = phase === 'freezing';
  const phaseLabel = phase === 'mixed' ? 'Pluie et neige sur ce créneau ; simultanéité non précisée'
    : phase === 'snow-unknown' ? 'Neige ; quantité de pluie inconnue' : snow ? 'Neige' : freezing ? 'Pluie verglaçante' : '';
  const cloudCover = valid(sample.cloudCover) ? sample.cloudCover : storm || snow || freezing ? 100 : null;
  const liquid = phase === 'mixed' ? sample.liquidRain : sample.rain;
  const rainLevel = !snow || phase === 'mixed' ? Math.max(0, Math.min(5, sample.rainLevel ??
    (valid(liquid) && liquid >= .01 ? liquid < 3 ? 1 : liquid < 8 ? 2 : liquid < 15 ? 3 : liquid < 30 ? 4 : 5 : 0))) : 0;
  const image = valid(cloudCover) ? iconMarkup({ ...sample, cloudCover: snow || freezing ? Math.max(35, cloudCover) : cloudCover,
    ...(snow || freezing || phase === 'unknown' || trace ? { rain: 0, rainLevel: 0 } : { rainLevel }) }) : '<span class="day-icon-missing">—</span>';
  const snowLevel = [1, 2, 3].includes(sample.snowLevel) ? sample.snowLevel
    : sample.snowfall >= 1 ? 3 : sample.snowfall >= .2 ? 2 : 1;
  // Each component of mixed precipitation keeps its own quantity and scale.
  // Reuse the existing vector layers, side by side under the same cloud.
  const mixedLayer = phase === 'mixed' ? mixedPrecipitationMarkup(rainLevel, snowLevel) : '';
  const phaseImage = snow || freezing ? `<span class="day-phase-icon" role="img" aria-label="${phaseLabel}">${freezing ? '' : image}${mixedLayer || `<img class="day-snow-layer" src="pictogrammes/${freezing ? 'pluie-verglacante' : 'calque-neige-' + snowLevel}.svg" alt="" loading="lazy" decoding="async">`}</span>` : image;
  const lightning = storm ? '<img class="day-weather-storm" src="pictogrammes/calque-orage.svg" alt="" loading="lazy" decoding="async">' : '';
  const traceLayer = trace ? '<img class="day-rain-trace-layer" src="pictogrammes/calque-traces-pluie.svg" alt="Traces de pluie prévues">' : '';
  const description = trace ? 'Traces de pluie prévues' : sample.phaseDescription;
  return `<span class="weather-icon" data-precipitation-phase="${escape(phase || 'unknown')}" data-rain-level="${!trace && ['rain', 'mixed'].includes(phase) ? rainLevel : 0}" data-snow-level="${snow ? snowLevel : 0}"${description ? ` title="${escape(description)}"` : ''}${storm ? ' role="img" aria-label="Orage possible"' : ''}>${phaseImage}${traceLayer}${lightning}</span>`;
}

export function mixedPrecipitationMarkup(rainLevel, snowLevel) {
  return `<svg class="day-snow-layer day-mixed-layer" viewBox="0 0 128 128" aria-hidden="true">${rainLevel ? `<image href="pictogrammes/calque-pluie-${rainLevel}.svg" x="-13" y="30" width="96" height="96"/>` : ''}<image href="pictogrammes/calque-neige-${snowLevel}.svg" x="40" y="26" width="96" height="96"/></svg>`;
}

function rainIntensityPictogramLevel(rate) {
  if (!(rate > 0)) return 0;
  return rate < 2 ? 1 : rate < 10 ? 2 : rate < 30 ? 3 : rate < 60 ? 4 : 5;
}

export function rainPictogramLevelForIntervals(intervals, { includeUnclassified = false } = {}) {
  const rates = intervals.map(interval => {
    const amount = interval.phase === 'mixed' ? interval.liquidRain
      : interval.phase === 'rain' || (includeUnclassified && interval.phase === 'unknown') ? interval.rain : 0;
    return amount > 0 ? amount * HOUR / (interval.end - interval.start) : 0;
  });
  return rainIntensityPictogramLevel(Math.max(0, ...rates));
}

// Only interpolate continuous fields between acquired points. A gap larger
// than six hours remains unknown; neither rain nor storm signals are smoothed.
function continuous(hours, time, key) {
  const after = hours.findIndex(hour => hour.stamp >= time);
  if (after < 0) return null;
  const right = hours[after];
  if (right.stamp === time) return valid(right[key]) ? right[key] : null;
  const left = hours[after - 1];
  if (!left || right.stamp - left.stamp > 6 * HOUR || !valid(left[key]) || !valid(right[key])) return null;
  if (key === 'windDirection') {
    const difference = ((right[key] - left[key] + 540) % 360) - 180;
    return (left[key] + difference * (time - left.stamp) / (right.stamp - left.stamp) + 360) % 360;
  }
  return left[key] + (right[key] - left[key]) * (time - left.stamp) / (right.stamp - left.stamp);
}

// Keep acquired accumulation periods intact. Lower-priority sources only fill
// uncovered periods; cutting an acquired period is explicitly an estimate.
function nativeRainIntervals(sources) {
  const intervals = [];
  for (const hours of sources) {
    for (const hour of hours) {
      if (!valid(hour.rain)) continue;
      const end = hour.rainIntervalEnd ? Date.parse(hour.rainIntervalEnd) : hour.stamp;
      const start = hour.rainIntervalStart ? Date.parse(hour.rainIntervalStart) : end - HOUR;
      if (!valid(start) || !valid(end) || end <= start) continue;
      const covered = intervals.filter(interval => interval.end > start && interval.start < end).sort((a, b) => a.start - b.start);
      let cursor = start;
      const append = stop => {
        if (stop <= cursor) return;
        intervals.push({ start: cursor, end: stop, rain: Math.max(0, hour.rain) * (stop - cursor) / (end - start),
          liquidRain: valid(hour.liquidRain) ? Math.max(0, hour.liquidRain) * (stop - cursor) / (end - start) : null,
          snowfall: valid(hour.snowfall) && hour.snowfall >= 0 ? hour.snowfall * (stop - cursor) / (end - start) : null,
          phase: precipitationPhase(hour), weatherCode: hour.weatherCode, snowfallMethod: hour.snowfallMethod,
          nativeLiquidRain: hour.liquidRain, nativeSnowfall: hour.snowfall,
          source: hour.source, nativeStart: start, nativeEnd: end, nativeRain: Math.max(0, hour.rain),
          interpolated: hour.source === 'Open-Meteo' && !hour.rainIntervalStart,
          estimated: cursor !== start || stop !== end });
      };
      for (const interval of covered) {
        append(Math.min(end, interval.start));
        cursor = Math.max(cursor, interval.end);
      }
      append(end);
    }
  }
  return intervals.sort((a, b) => a.start - b.start);
}

// Chart-only replacement: PIAF amounts are already millimetres per five minutes.
// PIAF owns its acquired intervals. Models continue exactly where it has no data.
function piafChartRainIntervals(modelIntervals, piaf, now) {
  const horizon = now + 3 * HOUR;
  const clip = (interval, start, end) => {
    const fraction = (end - start) / (interval.end - interval.start);
    return { ...interval, start, end, rain: interval.rain * fraction,
      liquidRain: valid(interval.liquidRain) ? interval.liquidRain * fraction : null,
      snowfall: valid(interval.snowfall) ? interval.snowfall * fraction : null,
      estimated: interval.estimated || start !== interval.start || end !== interval.end };
  };
  const result = [];
  const input = piaf && (!piaf.source || piaf.source === 'piaf') ? { ...piaf,
    values: (piaf.values || []).filter(item => valid(item.precipitation) && item.precipitation >= 0) } : null;
  const steps = [...new Map(prepareBasicForecast({ piaf: input }, now).rainSteps
    .filter(step => step.baseRainSource === 'piaf').map(step => [step.intervalStart + '/' + step.intervalEnd, step])).values()];
  for (const step of steps) {
    const start = Math.max(now, step.intervalStart), end = Math.min(horizon, step.intervalEnd);
    if (!(end > start)) continue;
    const boundaries = [...new Set([start, end, ...modelIntervals.flatMap(interval => [interval.start, interval.end])
      .filter(time => time > start && time < end)])].sort((a, b) => a - b);
    for (let index = 0; index < boundaries.length - 1; index++) {
      const begin = boundaries[index], stop = boundaries[index + 1];
      const owner = modelIntervals.find(interval => interval.start <= begin && interval.end >= stop);
      const rain = step.basePrecipitation * (stop - begin) / (step.intervalEnd - step.intervalStart);
      const phase = piafPrecipitationPhase(owner, rain);
      result.push({ start: begin, end: stop, rain, source: 'PIAF', phase,
        phaseSource: owner?.source, snowSource: owner?.source, weatherCode: owner?.weatherCode,
        liquidRain: phase === 'dry' || phase === 'snow' ? 0 : ['rain', 'freezing'].includes(phase) ? rain : null,
        snowfall: phase === 'dry' ? 0 : valid(owner?.snowfall) ? owner.snowfall * (stop - begin) / (owner.end - owner.start) : null,
        snowfallMethod: owner?.snowfallMethod, nativeSnowfall: owner?.nativeSnowfall,
        nativeStart: step.intervalStart, nativeEnd: step.intervalEnd, nativeRain: step.basePrecipitation,
        interpolated: false, estimated: begin !== step.intervalStart || stop !== step.intervalEnd });
    }
  }
  const acquired = [...result].sort((a, b) => a.start - b.start);
  for (const model of modelIntervals) {
    let cursor = model.start;
    for (const interval of acquired.filter(interval => interval.end > model.start && interval.start < model.end)) {
      if (interval.start > cursor) result.push(clip(model, cursor, Math.min(model.end, interval.start)));
      cursor = Math.max(cursor, interval.end);
    }
    if (cursor < model.end) result.push(clip(model, cursor, model.end));
  }
  return result.sort((a, b) => a.start - b.start);
}

export function dailyRainBars(day, start = day.start, end = day.end, metric = 'rain') {
  return day.rainIntervals.filter(interval => interval.end > start && interval.start < end
    && (metric !== 'snowfall' || valid(interval.snowfall))).map(interval => {
    const begin = Math.max(start, interval.start), stop = Math.min(end, interval.end);
    const fraction = (stop - begin) / (interval.end - interval.start);
    const amount = metric === 'snowfall' ? displayedSnowfall(interval) : interval.rain;
    return { ...interval, start: begin, end: stop, rain: amount * fraction,
      liquidRain: valid(interval.liquidRain) ? interval.liquidRain * fraction : null,
      snowfall: valid(interval.snowfall) ? interval.snowfall * fraction : null,
      nativeRain: metric === 'snowfall' ? interval.nativeSnowfall : interval.nativeRain,
      estimated: interval.estimated || begin !== interval.start || stop !== interval.end };
  });
}

export function dailyRainScale(days) {
  const maximum = Math.max(10, ...days.flatMap(day => dailyRainBars(day.chartRainIntervals ? { ...day, rainIntervals: day.chartRainIntervals } : day).map(interval => interval.rain * HOUR / (interval.end - interval.start))));
  const power = 10 ** Math.floor(Math.log10(maximum));
  return [1, 2, 5, 10].map(value => value * power).find(value => value >= maximum);
}

// Aggregation is a display choice, never evidence of a model's native step.
// Keep every component so tooltips retain its acquired interval and source.
export function dailyRainDisplayBars(day, width, start = day.start, end = day.end) {
  const { xStamp } = dailyTimeAxis(day, width);
  const groups = [];
  const merge = (left, right) => ({ ...left, end: right.end, rain: left.rain + right.rain,
    snowfall: valid(left.snowfall) && valid(right.snowfall) ? left.snowfall + right.snowfall : null,
    liquidRain: valid(left.liquidRain) && valid(right.liquidRain) ? left.liquidRain + right.liquidRain : null,
    estimated: left.estimated || right.estimated, interpolated: left.interpolated || right.interpolated,
    components: [...left.components, ...right.components] });
  const adjacent = (left, right) => left && left.source === right.source && left.phase === right.phase
    && left.snowfallMethod === right.snowfallMethod && Math.abs(left.end - right.start) < 1;
  for (const interval of dailyRainBars(day, start, end)) {
    const group = { ...interval, components: [interval] }, previous = groups.at(-1);
    if (adjacent(previous, group) && previous.interpolated && group.interpolated
      && Math.floor(previous.start / (3 * HOUR)) === Math.floor((group.end - 1) / (3 * HOUR))) {
      groups[groups.length - 1] = merge(previous, group);
    } else groups.push(group);
  }
  const visible = [];
  const requiredWidth = group => rainLabelWidth(group) + 6;
  for (const group of groups) {
    const previous = visible.at(-1);
    if (adjacent(previous, group) && xStamp(previous.end) - xStamp(previous.start) < requiredWidth(previous)) {
      visible[visible.length - 1] = merge(previous, group);
    } else visible.push(group);
  }
  const last = visible.at(-1), previous = visible.at(-2);
  if (adjacent(previous, last) && xStamp(last.end) - xStamp(last.start) < requiredWidth(last)) {
    visible.splice(-2, 2, merge(previous, last));
  }
  return visible;
}

function stormAt(hours, time) {
  const hour = hours.find(item => item.rainIntervalStart && Date.parse(item.rainIntervalStart) <= time && Date.parse(item.rainIntervalEnd) > time)
    || hours.find(item => item.stamp === time);
  if (!hour) return null;
  if (typeof hour.stormSignal === 'boolean') return Number(hour.stormSignal);
  return valid(hour.weatherCode) ? Number([95, 96, 99].includes(hour.weatherCode)) : null;
}

export function buildDailyRows({ dashboard = {}, week = {}, now = Date.now(), timezone = 'Europe/Paris', count = 16, sunTimesForDate, piafForChart = false } = {}) {
  const sources = forecastSources(dashboard, week);
  const rainIntervals = nativeRainIntervals(sources);
  const chartRainIntervals = piafForChart ? piafChartRainIntervals(rainIntervals, dashboard.piaf, now) : null;
  const sourceMetadata = { AROME: dashboard.arome, ARPEGE: week, 'Open-Meteo': dashboard.openMeteo };
  const today = localDateKey(now, timezone);
  const limit = localDateKey(localTime(today, 24 * count, timezone), timezone);
  const coveredTimes = [...sources.flat().map(hour => hour.stamp), ...rainIntervals.flatMap(interval => [interval.start, interval.end - 1])];
  const dates = [...new Set(coveredTimes.map(time => localDateKey(time, timezone)))].filter(date => date >= today && date < limit).sort();
  return dates.map(date => {
    const midnight = localTime(date, 0, timezone), end = localTime(date, 24, timezone);
    const start = midnight;
    const pastUntil = date === today ? Math.min(end, Math.max(start, now)) : start;
    const sampleAt = time => {
      const stamp = time, intervalEnd = time + HOUR;
      const sample = { time: new Date(stamp).toISOString(), stamp, intervalEnd, durationHours: (intervalEnd - stamp) / HOUR, past: intervalEnd <= pastUntil, sources: {} };
      const rain = dailyRainBars({ rainIntervals }, stamp, intervalEnd);
      sample.rain = rain.reduce((sum, interval) => sum + interval.end - interval.start, 0) >= HOUR - 1
        ? rain.reduce((sum, interval) => sum + interval.rain, 0) : null;
      sample.rainSources = [...new Set(rain.map(interval => interval.source))];
      Object.assign(sample, precipitationSummary(rain));
      // The summary chooses a phase, not the amount of a representative fragment.
      for (const key of ['liquidRain', 'snowfall']) sample[key] = rain.length && valid(sample.rain) && rain.every(interval => valid(interval[key]))
        ? rain.reduce((sum, interval) => sum + interval[key], 0) : null;
      if (valid(sample.rain)) sample.sources.rain = sample.rainSources.join(' · ');
      for (const key of ['temperature', 'cloudCover', 'windSpeed', 'windGust', 'windDirection', 'storm']) {
        sample[key] = null;
        for (const hours of sources) {
          const value = key === 'storm' ? stormAt(hours, time) : continuous(hours, stamp, key);
          if (!valid(value)) continue;
          sample[key] = value;
          sample.sources[key] = hours[0].source;
          break;
        }
      }
      return sample;
    };
    const samples = [];
    for (let time = midnight; time < end; time += HOUR) samples.push(sampleAt(time));
    const boundary = sampleAt(end);
    // Compressed nights can expose more adjacent hours inside the chart inset.
    const contextBefore = Array.from({ length: 24 }, (_, index) => sampleAt(start - (24 - index) * HOUR));
    const contextAfter = Array.from({ length: 24 }, (_, index) => sampleAt(end + (index + 1) * HOUR));
    const sourceLabels = [...new Set([...samples, boundary].flatMap(sample => [
      ...Object.entries(sample.sources).filter(([key]) => key !== 'rain').map(([, name]) => name), ...sample.rainSources]))];
    const sun = sunTimesForDate?.(new Date((start + end) / 2));
    return { date, midnight, start, end, pastUntil, samples, boundary, contextBefore, contextAfter, rainIntervals,
      ...(chartRainIntervals ? { chartRainIntervals, chartPiafWindow: { start: now, end: now + 3 * HOUR, fetchedAt: dashboard.piaf?.fetchedAt ?? null } } : {}),
      sunrise: sun?.sunrise?.valueOf(), sunset: sun?.sunset?.valueOf(), nextNightEnd: localTime(date, 30, timezone),
      sources: sourceLabels, sourceUpdates: sourceLabels.map(name => ({ name, fetchedAt: sourceMetadata[name]?.fetchedAt ?? null })),
      trend: Date.parse(date) - Date.parse(today) >= 8 * 24 * HOUR };
  }).filter(day => day.sources.length);
}

// Keep independent scenarios for the hover details; the displayed forecast
// continues to use its existing source priorities.
export function buildDailySourceRows({ dashboard = {}, week = {}, ...options } = {}) {
  return [
    ['AROME', { dashboard: { arome: dashboard.arome } }, dashboard.arome],
    ['ARPEGE', { week }, week],
    ['Open-Meteo', { dashboard: { openMeteo: dashboard.openMeteo } }, dashboard.openMeteo]
  ].filter(([, , source]) => source?.hours?.length).map(([name, input, source]) => ({
    name, hours: source.hours, days: buildDailyRows({ ...options, ...input })
  }));
}

export function dailyPeriodSourceSummaries(sourceRows, date, start, end, now = Date.now()) {
  return sourceRows.flatMap(source => {
    const day = source.days.find(day => day.date === date);
    if (!day) return [];
    const summary = dailyPeriodSummary(day, start, end, now);
    if (!summary.available) return [];
    const periodHours = source.hours.filter(hour => {
      const stop = Date.parse(hour.rainIntervalEnd || hour.time);
      const begin = hour.rainIntervalStart ? Date.parse(hour.rainIntervalStart) : stop - HOUR;
      return stop > summary.begin && begin < end;
    });
    const probabilities = periodHours.map(hour => hour.probability).filter(valid);
    const codes = periodHours.map(hour => hour.weatherCode).filter(valid);
    const amountBetween = (begin, end) => summary.intervals.reduce((sum, interval) =>
      sum + interval.rain * Math.max(0, Math.min(end, interval.end) - Math.max(begin, interval.start)) / (interval.end - interval.start), 0);
    const edges = [...new Set([summary.begin, ...summary.intervals.flatMap(interval => [interval.start, interval.end - 3 * HOUR])])]
      .filter(time => time >= summary.begin && time < end);
    const rain3h = Math.max(0, ...edges.map(time => amountBetween(time, Math.min(time + 3 * HOUR, end))));
    const storms = summary.samples.filter(sample => sample.storm === 1 && sample.stamp >= summary.begin && sample.stamp < end);
    const overlapsRain = (sample, amount) => summary.intervals.some(interval => interval.nativeRain >= amount
      && sample.stamp >= interval.nativeStart && sample.stamp < interval.nativeEnd);
    const stormRainOverlap = storms.some(sample => overlapsRain(sample, 5));
    const stormsWithRain = storms.filter(sample => overlapsRain(sample, 1));
    const stormWind = Math.max(0, ...stormsWithRain.map(sample => sample.windSpeed ?? 0));
    const stormGust = Math.max(0, ...stormsWithRain.map(sample => sample.windGust ?? 0));
    const stormWindCauses = { ...(stormWind >= 30 && { wind: stormWind }), ...(stormGust >= 50 && { gust: stormGust }) };
    const stormRainWindOverlap = stormWind >= 30 || stormGust >= 50;
    return [{ name: source.name, ...summary, probability: probabilities.length ? Math.max(...probabilities) : null,
      rain3h, stormRainOverlap, stormRainWindOverlap, stormWindCauses, weatherCode: codes.length ? Math.max(...codes) : null }];
  });
}

// Alert colours follow the acquired forecast horizon: AROME, then ARPEGE,
// then Open-Meteo. Split a period at real coverage boundaries so the end of a
// model run cannot suppress a warning in the following uncovered hours.
export function dailyPeriodAlertSummaries(sourceRows, date, start, end, now = Date.now()) {
  const summaries = dailyPeriodSourceSummaries(sourceRows, date, start, end, now);
  const priority = ['AROME', 'ARPEGE', 'Open-Meteo'];
  const candidates = priority.flatMap(name => {
    const summary = summaries.find(item => item.name === name);
    if (!summary) return [];
    const lastPoint = Math.max(...(sourceRows.find(row => row.name === name)?.hours || []).map(hour => Date.parse(hour.time)));
    const spans = [...summary.intervals.map(interval => ({ start: interval.start, end: interval.end })),
      ...summary.samples.filter(sample => ['windSpeed', 'windGust', 'storm'].some(key => valid(sample[key])))
        .map(sample => ({ start: sample.stamp, end: Math.min(sample.intervalEnd, lastPoint) }))]
      .map(span => ({ start: Math.max(summary.begin, span.start), end: Math.min(end, span.end) }))
      .filter(span => span.end > span.start);
    return spans.length ? [{ name, spans }] : [];
  });
  const boundaries = [...new Set([Math.max(start, now < end ? now : start), end,
    ...candidates.flatMap(candidate => candidate.spans.flatMap(span => [span.start, span.end]))])].sort((a, b) => a - b);
  const segments = [];
  for (let index = 0; index < boundaries.length - 1; index++) {
    const begin = boundaries[index], stop = boundaries[index + 1];
    const owner = candidates.find(candidate => candidate.spans.some(span => span.start <= begin && span.end >= stop));
    if (!owner) continue;
    const previous = segments.at(-1);
    if (previous?.name === owner.name && previous.end === begin) previous.end = stop;
    else segments.push({ name: owner.name, start: begin, end: stop });
  }
  return segments.flatMap(segment => dailyPeriodSourceSummaries(sourceRows.filter(row => row.name === segment.name),
    date, segment.start, segment.end, now).map(summary => ({ ...summary, deterministic: segment.name !== 'Open-Meteo' })));
}

export function dailyRainAlertTone(sourceRows, day, now = Date.now()) {
  const segments = dailyPeriodAlertSummaries(sourceRows, day.date, day.start, day.end, Math.min(now, day.start));
  const amounts = new Map();
  for (const segment of segments) {
    if (!segment.completeRain || !valid(segment.liquidRain) || (!segment.deterministic && !(segment.probability >= 70))) continue;
    amounts.set(segment.name, (amounts.get(segment.name) || 0) + segment.liquidRain);
  }
  const total = Math.max(0, ...amounts.values());
  return total >= 50 - 1e-9 ? 'orange' : total >= 40 - 1e-9 ? 'yellow' : '';
}

function extent(samples, key, fallback) {
  const entries = values(samples, key);
  return entries.length ? [Math.min(...entries), Math.max(...entries)] : fallback;
}

export function createDailyChartState() {
  return { showHourly: false,
    opacities: { temperature: 100, rain: 100, cloudiness: 0, wind: 0, gust: 0 },
    offsets: { temperature: 0, rain: 0, cloudiness: 0, wind: 0, gust: 0 } };
}

function compressedTimeIntervals(day, width = Infinity) {
  if (!valid(day.sunrise) || !valid(day.sunset) || day.sunrise >= day.sunset) return null;
  const firstDayHour = Math.min(day.end, Math.max(day.start, day.start + Math.ceil((day.sunrise - day.start) / HOUR) * HOUR));
  const lastDayHour = Math.max(firstDayHour, Math.min(day.end, day.start + Math.floor((day.sunset - day.start) / HOUR) * HOUR));
  const intervals = [];
  const night = (start, end) => {
    const hours = Math.round((end - start) / HOUR), count = Math.max(1, Math.floor(hours / 3));
    for (let i = 0; i < count && hours > 0; i++) {
      intervals.push({ start: start + Math.round(i * hours / count) * HOUR,
        end: start + Math.round((i + 1) * hours / count) * HOUR });
    }
  };
  night(day.start, firstDayHour);
  for (let time = firstDayHour; time < lastDayHour; time += HOUR) intervals.push({ start: time, end: time + HOUR });
  night(lastDayHour, day.end);
  const count = Math.min(intervals.length, Math.max(1, Math.floor((width - 2 * CHART_INSET) / CHART_SLOT_WIDTH)));
  return Array.from({ length: count }, (_, i) => ({ start: intervals[Math.round(i * intervals.length / count)].start,
    end: intervals[Math.round((i + 1) * intervals.length / count) - 1].end }));
}

export function dailyHourlyWidth(day) {
  const intervals = compressedTimeIntervals(day);
  return Math.ceil(2 * CHART_INSET + (intervals?.length ?? (day.end - day.start) / HOUR) * CHART_SLOT_WIDTH);
}

export function dailyChartSize(viewportWidth, state = createDailyChartState(), day) {
  const viewport = Math.max(160, Math.round(viewportWidth));
  const hourlyWidth = day ? dailyHourlyWidth(day) : viewport;
  const canExpand = hourlyWidth > viewport;
  return { width: state.showHourly && canExpand ? hourlyWidth : viewport, canExpand,
    height: Math.max(220, Math.min(300, Math.round(160 + viewport * .1))) };
}

// Monotone Hermite time mapping: equal-width columns, with a continuous clock
// speed at their boundaries. Harmonic tangents preserve order without overshoot.
export function dailyTimeAxis(day, width) {
  const compressed = compressedTimeIntervals(day, width);
  const intervals = compressed || [{ start: day.start, end: day.end }];
  const durations = intervals.map(interval => interval.end - interval.start);
  const linear = durations.every(duration => duration === durations[0]);
  const tangents = [durations[0], ...durations.slice(1).map((duration, index) =>
    2 * duration * durations[index] / (duration + durations[index])), durations.at(-1)];
  const timeInColumn = (index, u) => intervals[index].start
    + (u ** 3 - 2 * u ** 2 + u) * tangents[index]
    + (-2 * u ** 3 + 3 * u ** 2) * durations[index]
    + (u ** 3 - u ** 2) * tangents[index + 1];
  const fraction = time => {
    if (linear) return (time - day.start) / (day.end - day.start);
    if (time <= day.start) return (time - day.start) / durations[0] / intervals.length;
    if (time >= day.end) return 1 + (time - day.end) / durations.at(-1) / intervals.length;
    const index = intervals.findIndex(interval => time < interval.end);
    if (time === intervals[index].start) return index / intervals.length;
    let low = 0, high = 1;
    for (let step = 0; step < 40; step++) {
      const middle = (low + high) / 2;
      if (timeInColumn(index, middle) < time) low = middle;
      else high = middle;
    }
    return (index + (low + high) / 2) / intervals.length;
  };
  const xStamp = time => CHART_INSET + fraction(time) * (width - 2 * CHART_INSET);
  const positionAt = x => (x - CHART_INSET) / (width - 2 * CHART_INSET) * intervals.length;
  const timeAt = x => {
    if (linear) return day.start + (x - CHART_INSET) / (width - 2 * CHART_INSET) * (day.end - day.start);
    const position = positionAt(x);
    if (position <= 0) return day.start + position * durations[0];
    if (position >= intervals.length) return day.end + (position - intervals.length) * durations.at(-1);
    const index = Math.floor(position);
    return timeInColumn(index, position - index);
  };
  const millisecondsPerPixel = x => {
    if (linear) return (day.end - day.start) / (width - 2 * CHART_INSET);
    const position = positionAt(x), pixelsPerColumn = (width - 2 * CHART_INSET) / intervals.length;
    if (position <= 0) return durations[0] / pixelsPerColumn;
    if (position >= intervals.length) return durations.at(-1) / pixelsPerColumn;
    const index = Math.floor(position), u = position - index;
    return ((3 * u ** 2 - 4 * u + 1) * tangents[index]
      + (-6 * u ** 2 + 6 * u) * durations[index]
      + (3 * u ** 2 - 2 * u) * tangents[index + 1]) / pixelsPerColumn;
  };
  return { xStamp, timeAt, fraction, millisecondsPerPixel, compressed: !!compressed };
}

export function dailyTimeGroups(day, width) {
  const slots = Math.max(1, Math.floor((width - 2 * CHART_INSET) / CHART_SLOT_WIDTH));
  const intervalsFor = step => {
    const intervals = [], anchor = day.midnight ?? day.start;
    let start = day.start;
    while (start < day.end) {
      let end = Math.min(day.end, anchor + (Math.floor((start - anchor) / (step * HOUR)) + 1) * step * HOUR);
      // Merge a tiny current-hour fragment with the next interval. This keeps
      // labels readable and every rain sample inside its displayed window.
      if (start === day.start && end - start < step * HOUR / 2 && end < day.end) end = Math.min(day.end, end + step * HOUR);
      intervals.push({ start, end });
      start = end;
    }
    return intervals;
  };
  const step = [1, 2, 3, 4, 6, 8, 12, 24].find(value => intervalsFor(value).length <= slots) || 24;
  const intervals = compressedTimeIntervals(day, width) || intervalsFor(step);
  const groups = [];
  for (const { start, end } of intervals) {
    const samples = day.samples.filter(sample => sample.stamp >= start && sample.stamp < end);
    if (!samples.length) continue;
    const rains = values(samples, 'rain'), clouds = values(samples, 'cloudCover');
    groups.push({ start, end, samples, index: day.samples.indexOf(samples[0]),
      rain: rains.length ? rains.reduce((sum, value) => sum + value, 0) : null,
      completeRain: rains.length === samples.length,
      cloudCover: clouds.length ? clouds.reduce((sum, value) => sum + value, 0) / clouds.length : null,
      storm: samples.some(sample => sample.storm === 1) });
  }
  return { step, groups };
}

export function dailyCurveSamples(day, width) {
  const axis = dailyTimeAxis(day, width), start = axis.timeAt(0), end = axis.timeAt(width);
  const context = [...(day.contextBefore || []), ...day.samples, ...(day.boundary ? [day.boundary] : []), ...(day.contextAfter || [])];
  const times = new Set([start, end, ...context.filter(sample => sample.stamp >= start && sample.stamp <= end).map(sample => sample.stamp),
    ...(compressedTimeIntervals(day, width) || []).flatMap(interval => [interval.start, interval.end]),
    ...[day.sunrise, day.sunset].filter(time => valid(time) && time >= start && time <= end)]);
  return [...times].sort((a, b) => a - b).map(stamp => {
    const acquired = context.find(sample => sample.stamp === stamp);
    if (acquired) return acquired;
    const sample = { stamp, time: new Date(stamp).toISOString(), sources: {} };
    for (const key of ['temperature', 'cloudCover', 'windSpeed', 'windGust']) sample[key] = continuous(context, stamp, key);
    return sample;
  });
}

export function dailyChartMarkup(day, { now = Date.now(), state = createDailyChartState(), width = 1000, viewportWidth = width, rainScale = dailyRainScale([day]), timezone = 'Europe/Paris', iconMarkup = () => '', backgroundForTime = () => '#f7fafc', compactRain = false } = {}) {
  if (day.chartRainIntervals) day = { ...day, rainIntervals: day.chartRainIntervals,
    sourceUpdates: [...(day.sourceUpdates || day.sources.map(name => ({ name }))),
      ...(day.chartRainIntervals.some(interval => interval.source === 'PIAF' && interval.end > day.start && interval.start < day.end)
        ? [{ name: 'PIAF', fetchedAt: day.chartPiafWindow.fetchedAt }] : [])] };
  width = Math.max(160, Math.round(width));
  const { height } = dailyChartSize(viewportWidth, state);
  const axis = dailyTimeAxis(day, width), { xStamp, timeAt } = axis;
  const { step, groups } = dailyTimeGroups(day, width);
  const selected = new Set(groups.map(group => day.samples[group.index].stamp));
  const dayCurveSamples = day.boundary ? [...day.samples, day.boundary] : day.samples;
  if (day.boundary) selected.add(day.boundary.stamp);
  const context = [...(day.contextBefore || []), ...dayCurveSamples, ...(day.contextAfter || [])];
  const edgeStart = timeAt(0), edgeEnd = timeAt(width);
  const edgeSample = stamp => {
    const sample = { stamp, time: new Date(stamp).toISOString(), sources: {} };
    for (const key of ['temperature', 'cloudCover', 'windSpeed', 'windGust']) sample[key] = continuous(context, stamp, key);
    return sample;
  };
  const solarSamples = [day.sunrise, day.sunset].filter(time => valid(time) && time > day.start && time < day.end
    && !dayCurveSamples.some(sample => sample.stamp === time)).map(edgeSample);
  const curveSamples = dailyCurveSamples(day, width);
  const top = 94, bottom = height - 24;
  const x = index => xStamp(curveSamples[index].stamp);
  const domain = extent(curveSamples, 'temperature', [0, 20]);
  const padding = Math.max(1.5, (domain[1] - domain[0]) * .2);
  const yTemperature = value => bottom - (value - domain[0] + padding) / (domain[1] - domain[0] + 2 * padding) * (bottom - top);
  const rainGroups = [...dailyRainDisplayBars(day, width, edgeStart, day.start).map(interval => ({ ...interval, edge: true })),
    ...dailyRainDisplayBars(day, width), ...dailyRainDisplayBars(day, width, day.end, edgeEnd).map(interval => ({ ...interval, edge: true }))];
  const hasSnow = rainGroups.some(snowPhase);
  const phaseKnown = rainGroups.every(group => !(group.rain > 0) || valid(group.liquidRain));
  const windMax = Math.max(20, Math.ceil(Math.max(extent(curveSamples, 'windGust', [0, 0])[1], extent(curveSamples, 'windSpeed', [0, 0])[1]) / 10) * 10);
  const ys = { temperature: yTemperature, wind: value => bottom - value / windMax * (bottom - top),
    gust: value => bottom - value / windMax * (bottom - top), cloudiness: value => bottom - value / 100 * (bottom - top) };
  const keys = { temperature: 'temperature', wind: 'windSpeed', gust: 'windGust', cloudiness: 'cloudCover' };
  const labels = { temperature: 'Température', rain: 'Précipitations', wind: 'Vent moyen', gust: 'Rafales', cloudiness: 'Nébulosité' };
  const units = { temperature: '°C', rain: 'mm sur 1 h', wind: 'km/h', gust: 'km/h', cloudiness: '%' };
  const timeFormat = new Intl.DateTimeFormat('fr-FR', { timeZone: timezone, hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  const tickFormat = new Intl.DateTimeFormat('fr-FR', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const zoneAt = time => timeFormat.formatToParts(time).find(part => part.type === 'timeZoneName')?.value;
  const durationLabel = duration => duration % HOUR === 0 ? number(duration / HOUR) + ' h'
    : duration % 60000 === 0 ? rainNumber(duration / 60000) + ' min' : Math.round(duration / 1000) + ' s';
  const layer = (metric, content, extra = '') => {
    const opacity = state.opacities[metric] / 100;
    return `<g class="day-combined-layer metric-layer metric-layer-${metric}${extra}" data-day-layer="${metric}" style="${opacity ? '' : 'display:none;'}" aria-hidden="${!opacity}">${content}</g>`;
  };
  const tooltip = (sample, metric) => timeFormat.format(sample.stamp) + (sample.past ? ' · prévision passée' : '') + '\n' + labels[metric] + ' : '
    + number(sample[keys[metric] || metric]) + ' ' + units[metric]
    + '\n' + (sample.sources[keys[metric] || metric] || '');
  const point = (sample, metric, content) => `<g class="chart-point" tabindex="${state.opacities[metric] ? 0 : -1}" data-tooltip="${escape(tooltip(sample, metric))}" aria-label="${escape(tooltip(sample, metric))}">${content}</g>`;
  // Evaluate daylight in real time, including the neighboring-day margins,
  // then project every stop through the same compressed axis as the curves.
  const lightId = 'daily-light-' + day.date;
  const lightTimes = new Set([edgeStart, edgeEnd, day.start, day.end, ...solarSamples.map(sample => sample.stamp)]);
  for (let time = Math.ceil(edgeStart / (HOUR / 4)) * HOUR / 4; time < edgeEnd; time += HOUR / 4) lightTimes.add(time);
  const lightStops = [...lightTimes].sort((a, b) => a - b).map(time => {
    const offset = time === edgeStart ? 0 : time === edgeEnd ? 100 : xStamp(time) / width * 100;
    const color = escape(backgroundForTime(time));
    return `<stop offset="${offset}%" ${compactRain ? 'style="stop-color:' + color + '"' : 'stop-color="' + color + '"'}/>`;
  }).join('');
  const backgrounds = `<defs><linearGradient id="${lightId}" gradientUnits="userSpaceOnUse" x1="0" x2="${width}" y1="0" y2="0">${lightStops}</linearGradient></defs><rect class="day-daylight-background" width="${width}" height="${height}" fill="url(#${lightId})"/>`
    + groups.map(group => `<line x1="${xStamp(group.start)}" x2="${xStamp(group.start)}" y1="0" y2="${height}" class="day-combined-grid"/>`).join('');
  const curveCommand = (from, to, key, y) => {
    const left = curveSamples[from], right = curveSamples[to], x0 = x(from), x1 = x(to);
    if (!axis.compressed) return `L${x1},${y(right[key])}`;
    // Values remain linear in real time. Composing with the cubic clock gives
    // an exact Bezier, without an angular shortcut through compressed columns.
    const third = (x1 - x0) / 3, slope = (y(right[key]) - y(left[key])) / (right.stamp - left.stamp);
    return `C${x0 + third},${y(left[key]) + slope * axis.millisecondsPerPixel(x0) * third} `
      + `${x1 - third},${y(right[key]) - slope * axis.millisecondsPerPixel(x1) * third} ${x1},${y(right[key])}`;
  };
  const continuousLayer = metric => {
    const key = keys[metric], y = ys[metric];
    let path = '', previous = null;
    for (let index = 0; index < curveSamples.length; index++) {
      const sample = curveSamples[index];
      if (!valid(sample[key])) { previous = null; continue; }
      if (previous) path += `<path class="day-combined-line" d="M${x(previous.index)},${y(previous.sample[key])} ${curveCommand(previous.index, index, key, y)}"/>`;
      previous = { sample, index };
    }
    const points = curveSamples.map((sample, index) => valid(sample[key]) && selected.has(sample.stamp) ? point(sample, metric,
      `<circle cx="${x(index)}" cy="${y(sample[key])}" r="3"/><text x="${x(index)}" y="${y(sample[key]) - 10}" text-anchor="middle">${metric === 'temperature' ? number(sample[key]) + '°' : number(Math.round(sample[key])) + (metric === 'cloudiness' ? '%' : '')}</text>`) : '').join('');
    return layer(metric, path + points);
  };
  // As on the 48 h timeline, cloud cover is a translucent area without a
  // stroke or visible markers. Missing readings split the area into pieces.
  let cloudAreas = '', cloudSegment = [];
  const finishCloudArea = () => {
    if (cloudSegment.length > 1) {
      const first = cloudSegment[0], last = cloudSegment.at(-1);
      const left = x(first.index);
      const right = x(last.index);
      const points = [[left, bottom], [left, ys.cloudiness(first.sample.cloudCover)],
        ...cloudSegment.map(({ sample, index }) => [x(index), ys.cloudiness(sample.cloudCover)]),
        [right, ys.cloudiness(last.sample.cloudCover)], [right, bottom]];
      if (axis.compressed) {
        const outline = cloudSegment.slice(1).map((point, i) => curveCommand(cloudSegment[i].index, point.index, 'cloudCover', ys.cloudiness)).join(' ');
        cloudAreas += `<path class="cloud-cover-overlay" d="M${left},${bottom} L${left},${ys.cloudiness(first.sample.cloudCover)} ${outline} L${right},${bottom} Z"/>`;
      } else cloudAreas += `<polygon class="cloud-cover-overlay" points="${points.map(point => point.join(',')).join(' ')}"/>`;
    }
    cloudSegment = [];
  };
  curveSamples.forEach((sample, index) => {
    if (valid(sample.cloudCover)) cloudSegment.push({ sample, index });
    else finishCloudArea();
  });
  finishCloudArea();
  const cloudiness = layer('cloudiness', cloudAreas + groups.map(group => {
    const sample = day.samples[group.index];
    return valid(sample.cloudCover) ? point(sample, 'cloudiness', `<rect x="${xStamp(group.start)}" y="${top}" width="${xStamp(group.end) - xStamp(group.start)}" height="${bottom - top}" fill="transparent"/>`) : '';
  }).join(''));
  let previousRainLabel = null;
  const dailySnowPlateaus = [];
  const precipitationBars = compactRain ? rainGroups.map(precipitation24h) : [];
  const isTrace = ({ group, rain }) => group.phase === 'rain' && rain > 0 && rain < .1 - 1e-9;
  const scales = compactRain ? precipitation24hScales(precipitationBars.filter(bar => !isTrace(bar))) : null;
  const gradient = 'day-rain-intensity-' + day.date;
  const rain = layer('rain', rainGroups.map((group, index) => {
    const precipitation = precipitationBars[index];
    const traceOnly = precipitation && isTrace(precipitation);
    if (!traceOnly && (precipitation ? !rainVisible(precipitation.rain) && !precipitation.snow : !rainVisible(group.rain))) return '';
    const hours = (group.end - group.start) / HOUR, rate = group.rain / hours;
    // Quantified rain grows linearly above the minimum reserved for traces.
    const proportionalHeight = rate / rainScale * 67;
    const trace = precipitation ? rainTrace(precipitation.rain) : rainTrace(group.rain) && !snowPhase(group);
    const bar = trace ? 5 : 5 + Math.min(67, proportionalHeight);
    const left = xStamp(group.start), right = xStamp(group.end), center = (left + right) / 2;
    let detail;
    if (precipitation) {
      const format = zoneAt(group.start) === zoneAt(group.end) ? tickFormat : timeFormat;
      const kind = group.phase === 'freezing' ? 'Pluie verglaçante' : precipitation.equivalent ? 'Précip. (équiv. eau)' : 'Pluie';
      detail = [
        format.format(group.start) + ' – ' + format.format(group.end),
        group.phase === 'mixed' && 'Pluie et neige sur ce créneau',
        (traceOnly || rainVisible(precipitation.rain)) && (traceOnly || trace ? kind + ' : gouttes'
          : kind + ' : ' + rainDetailNumber(precipitation.rain) + ' mm · ' + rainDetailNumber(precipitation.rainRate) + ' mm/h'),
        precipitation.snow > 0 && 'Neige estimée : ' + snowLabel(precipitation.snow) + ' · ' + rainDetailNumber(precipitation.snowRate) + ' cm/h'
      ].filter(Boolean).join('\n');
    } else {
      const range = timeFormat.format(group.start) + ' – ' + timeFormat.format(group.end);
      const acquired = group.components.map(part => 'Cumul ' + (part.source === 'PIAF' ? 'PIAF' : part.interpolated ? 'API horaire' : 'source') + ' : ' + rainDetailNumber(part.nativeRain) + ' mm sur '
        + durationLabel(part.nativeEnd - part.nativeStart) + ' (' + timeFormat.format(part.nativeStart) + ' – ' + timeFormat.format(part.nativeEnd) + ')').join('\n');
      detail = range + '\nPrécipitations : ' + rainDetailNumber(group.rain) + ' mm sur ' + durationLabel(group.end - group.start)
        + (group.estimated ? ' (part estimée au prorata)' : '') + '\nIntensité moyenne : ' + rainDetailNumber(rate) + ' mm/h'
        + (group.components.length > 1 ? '\nCumul agrégé pour l’affichage' : '')
        + (group.interpolated ? '\nOpen-Meteo : données horaires interpolées ; pas natif non communiqué' : '')
        + (trace ? '\nGouttes : repère fixe de 5 px, hors échelle d’intensité' : '')
        + '\n' + acquired + '\n' + group.source
        + (valid(group.liquidRain) ? '\nPluie liquide : ' + rainDetailNumber(group.liquidRain) + ' mm' : '\nRépartition pluie/neige non disponible ; cumul en équivalent eau')
        + (group.snowfall > 0 ? snowPhase(group)
          ? '\nNeige fraîche estimée' + (group.source === 'PIAF' && group.snowSource ? ' (' + group.snowSource + ')' : '') + ' : ' + snowLabel(group.snowfall) + ' ; pas une hauteur de neige au sol'
          : '\nTrace neigeuse infime non représentée (moins de 0,1 cm sur le créneau source)' : '')
        + (group.snowfall > 0 ? '\nHauteur du diagramme : intensité en équivalent eau, même échelle que la pluie' : '')
        + (group.snowfall > 0 && group.snowfallMethod === 'water-equivalent-0.7' ? '\nEstimation conventionnelle : 0,7 cm par mm d’équivalent eau neigeux (convention Open-Meteo)' : '')
        + (group.snowfall > 0 && group.snowfallMethod === 'provider-estimate' ? '\nHauteur fraîche estimée fournie par Open-Meteo' : '')
        + (group.phase === 'mixed' ? '\nPluie et neige dans le même créneau source ; simultanéité non précisée' : '');
    }
    const pointMarkup = (phaseClass, bars, label = '') =>
      `<g class="chart-point${phaseClass}"${group.edge ? ' data-adjacent-day="true"' : ''} data-rain-source="${escape(group.source)}" data-rain-amount="${group.rain}" data-rain-rate="${rate}" data-rain-hours="${hours}" tabindex="${state.opacities.rain ? 0 : -1}" data-tooltip="${escape(detail)}" aria-label="${escape(detail)}">${bars}${group.edge ? '' : label}</g>`;
    if (traceOnly) {
      const spacing = Math.min(5, (right - left) / 3);
      const dot = Math.min(1.5, spacing / 3);
      const dots = [-1, 0, 1].map(offset => {
        const x = center + offset * spacing;
        return `M${x - dot},${height - 4} a${dot},${dot} 0 1 0 ${2 * dot},0 a${dot},${dot} 0 1 0 ${-2 * dot},0 Z`;
      }).join(' ');
      return pointMarkup(' day-rain-trace-point', `<rect x="${left}" y="${height - 12}" width="${right - left}" height="12" fill="transparent"/><path d="${dots}" fill="#648fab"/>`);
    }
    if (precipitation) {
      const { rain: amount, rainRate, snowRate } = precipitation;
      const rainHeight = rainVisible(amount) ? trace ? minimumRainBarHeight
        : Math.max(minimumRainBarHeight, precipitation24hHeight(rainRate, scales.rain, height)) : 0;
      const snowHeight = precipitation24hHeight(snowRate, scales.snow, height);
      const gap = group.edge ? 0 : Math.min(.8, (right - left) / 6);
      const barLeft = left + gap, barRight = Math.max(barLeft + .1, right - gap);
      if (snowHeight > 0) {
        const previous = dailySnowPlateaus.at(-1);
        if (previous?.end === group.start && Math.abs(previous.rate - snowRate) < 1e-9) {
          previous.right = barRight;
          previous.end = group.end;
        } else dailySnowPlateaus.push({ left: barLeft, right: barRight, level: height - snowHeight - 4.25,
          stamp: group.start, end: group.end, rate: snowRate });
      }
      const labelX = Math.max(23, Math.min(width - 23, center));
      const showTrace = trace && !group.edge && (!previousRainLabel || labelX - 22 > previousRainLabel.right + 3);
      if (showTrace) previousRainLabel = { right: labelX + 22 };
      const label = showTrace ? `<text class="day-rain-label" x="${labelX}" y="${height - 11}" text-anchor="middle">gouttes</text>` : '';
      const phaseClass = snowHeight > 0 ? rainHeight > 0 ? ' day-combined-mixed' : ' day-combined-snow' : '';
      const bars = precipitation24hBarMarkup({ left: barLeft, right: barRight, baseline: height,
        rainHeight, snowHeight, rainRate, trace, gradient, edge: group.edge });
      return pointMarkup(phaseClass, bars, label);
    }
    const gap = group.edge ? 0 : Math.min(3, (right - left) * .1);
    const withUnit = !rainTrace(group.rain) && right - left - gap * 2 >= rainLabelWidth(group, true) + 6;
    const labelWidth = rainLabelWidth(group, withUnit);
    const labelParts = rainLabelParts(group, withUnit), labelHeight = labelParts.length > 1 ? 30 : 18;
    const labelX = Math.max(labelWidth / 2 + 2, Math.min(width - labelWidth / 2 - 2, center));
    let labelY = height - 7 - bar - (group.snowfall > 0 && snowPhase(group) ? 12 : 0);
    if (previousRainLabel && labelX - labelWidth / 2 < previousRainLabel.right + 3 && Math.abs(labelY - previousRainLabel.y) < Math.max(labelHeight, previousRainLabel.height)) labelY = previousRainLabel.y - previousRainLabel.height - 2;
    if (!group.edge) previousRainLabel = { right: labelX + labelWidth / 2, y: labelY, height: labelHeight };
    const labelContent = labelParts.length === 1 ? escape(labelParts[0]) : labelParts.map((text, index) => `<tspan x="${labelX}" dy="${index ? 13 : -13}">${escape(text)}</tspan>`).join('');
    const label = `<text class="day-rain-label" x="${labelX}" y="${labelY}" text-anchor="middle">${labelContent}</text>`;
    const phaseClass = group.snowfall > 0 && snowPhase(group) ? group.liquidRain > 0 ? ' day-combined-mixed' : ' day-combined-snow' : '';
    const snow = group.snowfall > 0 && snowPhase(group);
    const barLeft = left + gap, barRight = Math.max(barLeft + .1, right - gap);
    // In mixed precipitation the blue half stays visible beside the snow.
    const snowLeft = group.liquidRain > 0 ? (barLeft + barRight) / 2 : barLeft;
    if (snow) {
      const previous = dailySnowPlateaus.at(-1);
      if (previous && previous.end === group.start && Math.abs(previous.rate - rate) < 1e-9
        && !previous.mixed && !(group.liquidRain > 0)) {
        previous.right = barRight; previous.end = group.end;
      } else dailySnowPlateaus.push({ left: snowLeft, right: barRight, level: height - bar - 4.25,
        stamp: group.start, end: group.end, rate, mixed: group.liquidRain > 0 });
    }
    const rainBar = !snow || group.liquidRain > 0 ? `<rect x="${barLeft}" y="${height - bar}" width="${barRight - barLeft}" height="${bar}" class="day-combined-rain${group.edge ? ' day-adjacent-rain' : ''}"/>` : '';
    const snowBar = snow ? `<rect class="piaf-snow-bar" x="${snowLeft}" y="${height - bar}" width="${barRight - snowLeft}" height="${bar}"/><path class="piaf-snow-bar-edge" d="M${snowLeft},${height - bar - 7.1} V${height} H${barRight} V${height - bar - 7.1}" aria-hidden="true"/>` : '';
    return pointMarkup(phaseClass, rainBar + snowBar, label);
  }).join(''));
  const snowCaps = layer('rain', snowCapMarkup(dailySnowPlateaus));
  const missingIntervals = [];
  if (day.chartPiafWindow) {
    const start = Math.max(day.start, day.chartPiafWindow.start), end = Math.min(day.end, day.chartPiafWindow.end);
    let cursor = start;
    for (const interval of day.rainIntervals.filter(interval => valid(interval.rain) && interval.end > start && interval.start < end)) {
      if (interval.start > cursor) missingIntervals.push({ start: cursor, end: Math.min(end, interval.start) });
      cursor = Math.max(cursor, interval.end);
    }
    if (cursor < end) missingIntervals.push({ start: cursor, end });
  }
  const missingRain = missingIntervals.length ? layer('rain', missingIntervals.map(interval => {
    const left = xStamp(interval.start), right = xStamp(interval.end), detail = 'Précipitations indisponibles';
    // A missing rain reading must never mask the other, known weather curves.
    // Keep the indication in the precipitation baseline, without an area fill.
    return `<g class="chart-point day-rain-missing" tabindex="${state.opacities.rain ? 0 : -1}" data-tooltip="${detail}" aria-label="${detail}"><line x1="${left}" x2="${right}" y1="${height - 2}" y2="${height - 2}" stroke="#667d8d" stroke-width="2" stroke-dasharray="3 3" pointer-events="stroke"/></g>`;
  }).join('')) : '';
  const pictogramPrecipitation = (start, end) => {
    const intervals = dailyRainBars(day, start, end);
    const summary = precipitationSummary(intervals);
    const rainLevel = rainPictogramLevelForIntervals(intervals);
    if (!compactRain || summary.phase !== 'rain') return { ...summary, rainLevel };
    const overlapping = precipitationBars.filter(({ group }) => group.start < end && group.end > start);
    const hasRainBar = overlapping.some(item => !isTrace(item) && rainVisible(item.rain));
    return { ...summary, rainLevel: hasRainBar ? rainLevel : 0, rainTrace: !hasRainBar && overlapping.some(isTrace) };
  };
  // Hours and pictograms share a fixed column, as on the site timeline.
  // Moving or hiding the temperature curve does not move or hide this header.
  const evening = day.pastUntil >= localTime(day.date, 18, timezone) && day.pastUntil < day.end
    && !groups.some(group => group.start >= day.pastUntil);
  // Keep a colored pictogram for the remaining evening, even when the
  // remaining time is narrower than the icon itself. It is above the past mask.
  let eveningHeader = '';
  if (evening) {
    const remaining = day.samples.filter(sample => sample.intervalEnd > day.pastUntil);
    const rainHours = remaining.reduce((sum, sample) => sum + (sample.intervalEnd - Math.max(sample.stamp, day.pastUntil)) / HOUR, 0);
    const rain = remaining.every(sample => valid(sample.rain)) && rainHours > 0
      ? remaining.reduce((sum, sample) => sum + sample.rain * (sample.intervalEnd - Math.max(sample.stamp, day.pastUntil)) / (sample.intervalEnd - sample.stamp), 0) / rainHours : null;
    const sample = { ...pictogramPrecipitation(day.pastUntil, day.end), time: new Date(day.pastUntil).toISOString(), cloudCover: continuous(curveSamples, day.pastUntil, 'cloudCover'), rain,
      stormSignal: remaining.some(sample => sample.storm === 1) };
    const center = Math.min(width - 35, Math.max(35, xStamp((day.pastUntil + day.end) / 2)));
    eveningHeader = `<div class="day-evening-header"><div class="day-timeline-slot day-evening-slot" style="left:${center / width * 100}%"><time datetime="${sample.time}" title="De ${escape(timeFormat.format(day.pastUntil))} à minuit">Ce soir</time>${weatherPictogram(sample, iconMarkup)}</div></div>`;
  }
  const header = groups.filter(group => !evening || group !== groups.at(-1)).map(group => {
    const sample = day.samples[group.index];
    const iconSample = { ...sample, ...pictogramPrecipitation(group.start, group.end), cloudCover: valid(group.cloudCover) ? group.cloudCover : group.storm ? 100 : null, stormSignal: group.storm, rain: valid(group.rain) ? group.rain / ((group.end - group.start) / HOUR) : null };
    const label = tickFormat.format(group.start).replace(':00', 'h').replace(':', 'h');
    return `<div class="day-timeline-slot" style="left:${xStamp(group.start) / width * 100}%"><time datetime="${sample.time}">${label}</time>${weatherPictogram(iconSample, iconMarkup)}</div>`;
  }).join('');
  const caption = `<span class="day-chart-scale" data-day-layer="temperature"${state.opacities.temperature ? '' : ' style="display:none"'}>Température °C</span><span class="day-chart-scale" data-day-layer="rain"${state.opacities.rain ? '' : ' style="display:none"'}>Pluie mm/h</span><span class="day-chart-scale" data-day-layer="wind"${state.opacities.wind ? '' : ' style="display:none"'}>Vent km/h</span><span class="day-chart-scale" data-day-layer="gust"${state.opacities.gust ? '' : ' style="display:none"'}>Rafales km/h</span><span class="day-chart-scale" data-day-layer="cloudiness"${state.opacities.cloudiness ? '' : ' style="display:none"'}>Nébulosité %</span>`;
  const pastPosition = day.pastUntil > day.start ? xStamp(Math.min(day.end, day.pastUntil)) / width * 100 : 0;
  const history = pastPosition ? `<div class="day-elapsed-mask" style="width:${pastPosition}%" aria-hidden="true"></div><div class="day-now-marker" style="left:${pastPosition}%" role="note" aria-label="Maintenant : ${escape(timeFormat.format(day.pastUntil))}"></div>` : '';
  const sources = sourceUpdatesMarkup(day.sourceUpdates || day.sources.map(name => ({ name })), timezone, now);
  const precipCaption = compactRain ? precipitation24hLegend(scales, gradient)
    : hasSnow || !phaseKnown ? `Précip. 0–${number(rainScale)} mm/h équiv. eau · cumuls mm${hasSnow ? ' / neige cm' : ''}` : `Pluie 0–${number(rainScale)} mm/h · cumuls mm`;
  const rainGradient = compactRain && scales.rain ? `<defs>${precipitation24hGradient(gradient, height, scales.rain)}</defs>` : '';
  return `<div class="day-chart-key">${caption.replace('Pluie mm/h', () => precipCaption)}<span class="day-key-spacer" aria-hidden="true"></span>${sources}</div><div class="day-combined-canvas" data-display-step="${step}" style="height:${height}px"><svg class="day-combined-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="group" aria-label="Frise météo du ${day.date}">${rainGradient}${backgrounds}${cloudiness}${missingRain}${rain}${snowCaps}${continuousLayer('wind')}${continuousLayer('gust')}${continuousLayer('temperature')}</svg><div class="day-timeline-header">${header}${evening ? '' : `<time class="day-timeline-end" style="left:${xStamp(day.end) / width * 100}%">24h</time>`}</div>${history}${eveningHeader}</div>`;
}

export function dailySummarySample(day) {
  const hasSun = valid(day.sunrise) && valid(day.sunset) && day.sunrise < day.sunset;
  const start = hasSun ? Math.max(day.start, day.sunrise) : day.start;
  const end = hasSun ? Math.min(day.end, day.sunset) : day.end;
  let clouds = 0, duration = 0;
  for (const sample of day.samples) {
    const overlap = Math.max(0, Math.min(end, sample.intervalEnd) - Math.max(start, sample.stamp));
    if (!valid(sample.cloudCover) || !overlap) continue;
    clouds += sample.cloudCover * overlap;
    duration += overlap;
  }
  // Represent the most persistent phase, not a brief precipitation maximum.
  const phases = new Map();
  for (const sample of day.samples) {
    const weight = Math.max(0, Math.min(day.end, sample.intervalEnd) - Math.max(day.start, sample.stamp));
    if (!valid(sample.rain) || !weight) continue;
    const phase = sample.phase || precipitationPhase(sample);
    const group = phases.get(phase) || { phase, weight: 0, samples: [] };
    group.weight += weight;
    group.samples.push({ sample, weight });
    phases.set(phase, group);
  }
  const dominant = [...phases.values()].sort((a, b) => b.weight - a.weight || (a.phase === 'dry' ? -1 : b.phase === 'dry' ? 1 : 0))[0];
  let representative = null, elapsed = 0;
  if (dominant) for (const item of dominant.samples.sort((a, b) => a.sample.rain - b.sample.rain)) {
    elapsed += item.weight;
    if (elapsed >= dominant.weight / 2) { representative = item.sample; break; }
  }
  return { ...precipitationSummary(representative ? [representative] : day.samples), time: new Date((start + end) / 2).toISOString(), cloudCover: duration ? clouds / duration : null,
    rain: representative?.rain ?? null,
    stormSignal: day.samples.some(sample => sample.storm === 1) };
}

// Aggregate only acquired intervals inside a civil-time slot. In particular,
// the following night may contain seven hours when the clocks go back.
export function dailyPeriodSummary(day, start, end, now = Date.now()) {
  const begin = end > now ? Math.max(start, now) : start;
  const all = [...(day.contextBefore || []), ...day.samples, ...(day.boundary ? [day.boundary] : []), ...(day.contextAfter || [])];
  const samples = [...new Map(all.map(sample => [sample.stamp, sample])).values()]
    .filter(sample => sample.intervalEnd > begin && sample.stamp < end).sort((a, b) => a.stamp - b.stamp);
  const duration = sample => Math.max(0, Math.min(end, sample.intervalEnd) - Math.max(begin, sample.stamp));
  const known = key => samples.filter(sample => valid(sample[key]));
  const average = key => { const values = known(key), covered = values.reduce((sum, sample) => sum + duration(sample), 0);
    return covered ? values.reduce((sum, sample) => sum + sample[key] * duration(sample), 0) / covered : null; };
  const extremes = key => { const entries = known(key).map(sample => sample[key]); return entries.length ? [Math.min(...entries), Math.max(...entries)] : [null, null]; };
  const rains = dailyRainBars(day, begin, end);
  const covered = rains.reduce((sum, interval) => sum + interval.end - interval.start, 0);
  const rain = rains.length ? rains.reduce((sum, interval) => sum + interval.rain, 0) : null;
  const completeRain = covered >= end - begin - 1;
  const snowfall = rains.length && rains.every(interval => interval.phase === 'dry' || valid(interval.snowfall))
    ? rains.reduce((sum, interval) => sum + (interval.phase === 'dry' ? 0 : displayedSnowfall(interval)), 0) : null;
  const liquidRain = rains.length && rains.every(interval => interval.phase === 'dry' || valid(interval.liquidRain))
    ? rains.reduce((sum, interval) => sum + (interval.phase === 'dry' ? 0 : interval.liquidRain), 0) : null;
  const wet = rains.filter(interval => interval.rain >= .01 - 1e-9);
  const mass = wet.reduce((sum, interval) => sum + interval.rain, 0);
  const wetDuration = wet.reduce((sum, interval) => sum + interval.end - interval.start, 0);
  const center = mass ? wet.reduce((sum, interval) => sum + (interval.start + interval.end) / 2 * interval.rain, 0) / mass : null;
  const position = center == null ? null : (center - begin) / (end - begin);
  const rainTiming = position == null || wetDuration >= (end - begin) * .7 ? null : position < 1 / 3 ? 'start' : position > 2 / 3 ? 'end' : 'middle';
  const directions = known('windDirection');
  const direction = directions.length ? (Math.atan2(directions.reduce((sum, sample) => sum + Math.sin(sample.windDirection * Math.PI / 180) * duration(sample), 0),
    directions.reduce((sum, sample) => sum + Math.cos(sample.windDirection * Math.PI / 180) * duration(sample), 0)) * 180 / Math.PI + 360) % 360 : null;
  const stormSamples = known('storm');
  const weather = precipitationSummary(rains);
  return { ...weather, start, end, begin, samples, intervals: rains, rain, completeRain,
    estimated: rains.some(interval => interval.rain > 0 && interval.estimated), snowfall, liquidRain, rainTiming,
    temperatureMin: extremes('temperature')[0], temperatureMax: extremes('temperature')[1],
    cloudCover: average('cloudCover'), windSpeed: extremes('windSpeed')[1], windGust: extremes('windGust')[1], windDirection: direction,
    storm: stormSamples.some(sample => sample.storm === 1) ? true
      : stormSamples.reduce((sum, sample) => sum + duration(sample), 0) >= end - begin - 1 ? false : null,
    rainSources: [...new Set(rains.map(interval => interval.source))],
    sources: Object.fromEntries(['temperature', 'cloudCover', 'windSpeed', 'windGust', 'windDirection', 'storm'].map(key =>
      [key, [...new Set(known(key).map(sample => sample.sources[key]).filter(Boolean))].join(' · ')])),
    available: rains.length > 0 || samples.some(sample => ['temperature', 'cloudCover', 'windSpeed'].some(key => valid(sample[key]))) };
}

export function dailyDataUpdateTitle(day, now = Date.now()) {
  const labels = { green: 'Données récentes', orange: 'Actualisation ancienne', red: 'Données anciennes ou indisponibles' };
  const updates = (day.sourceUpdates || []).map(source => {
    const stamp = typeof source.fetchedAt === 'string' ? Date.parse(source.fetchedAt) : source.fetchedAt;
    if (!valid(stamp) || stamp <= 0) return source.name + ' : date inconnue';
    const minutes = Math.floor((now - stamp) / 60000);
    const age = minutes < 0 ? 'date future' : minutes === 0 ? 'à l’instant'
      : minutes < 60 ? 'il y a ' + minutes + ' min' : 'il y a ' + Math.floor(minutes / 60) + ' h ' + minutes % 60 + ' min';
    return source.name + ' : ' + age;
  });
  return [labels[dailyDataUpdateStatus(day, now)], ...updates].join('\n');
}

// The coloured control reports acquisition age, independently of forecast confidence.
export function dailyDataUpdateStatus(day, now = Date.now()) {
  const updates = day.sourceUpdates || [];
  const levels = updates.map(update => {
    const stamp = typeof update.fetchedAt === 'string' ? Date.parse(update.fetchedAt) : update.fetchedAt;
    const age = valid(stamp) && stamp > 0 && stamp <= now + 60000 ? Math.max(0, now - stamp) : Infinity;
    const recent = update.name === 'PIAF' ? 10 * 60000 : 90 * 60000;
    const stale = update.name === 'PIAF' ? 20 * 60000 : 3 * HOUR;
    return age <= recent ? 0 : age <= stale ? 1 : 2;
  });
  return ['green', 'orange', 'red'][levels.length ? Math.max(...levels) : 2];
}

export function dailyRowsMarkup(days, { now = Date.now(), timezone = 'Europe/Paris', rainScale = dailyRainScale(days), iconMarkup = () => '', controlsMarkup = () => '', stateForDate = () => createDailyChartState(), backgroundForTime, collapsible = false, periodsMarkup = () => '', chartIconMarkup = '', updateMarkup = () => '', alertSources = [] } = {}) {
  if (!days.length) return '<p class="week-source-message">Prévisions en attente d’actualisation.</p>';
  const today = localDateKey(now, timezone);
  const weekday = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', timeZone: timezone });
  const shortDate = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: timezone });
  const renderChart = (day, state) => dailyChartMarkup(day, { now, state, rainScale, timezone, iconMarkup, backgroundForTime });
  const rows = days.map((day, index) => {
    const state = stateForDate(day.date);
    const temps = extent(day.boundary ? [...day.samples, day.boundary] : day.samples, 'temperature', [null, null]), rains = dailyRainBars(day);
    const separated = rains.every(interval => valid(interval.liquidRain));
    const rainTotal = rains.length ? rains.reduce((sum, interval) => sum + (separated ? interval.liquidRain : interval.rain), 0) : null;
    const rainPartial = rains.reduce((sum, interval) => sum + interval.end - interval.start, 0) < day.end - day.start - 1;
    const rainEstimated = rains.some(interval => interval.rain > 0 && interval.estimated);
    const label = day.date === today ? 'Aujourd’hui' : collapsible && Date.parse(day.date) - Date.parse(today) === 24 * HOUR ? 'Demain' : weekday.format(day.start);
    const rainSummary = valid(rainTotal) && !rainVisible(rainTotal) ? '' : `<span class="daily-period-rain-volume" title="${separated ? 'Cumul de pluie liquide' : 'Précipitations totales en équivalent eau ; répartition pluie/neige inconnue'} de la journée${rainEstimated ? ' ; * partiellement estimé au prorata des intervalles source' : ''}">${separated ? '' : '<small>Précip.</small>'}<strong>${rainTrace(rainTotal) ? 'gouttes' : rainNumber(rainTotal) + ' mm'}${rainEstimated ? '*' : ''}${rainPartial ? precipitationCoverageSuffix(rains, timezone) : ''}</strong></span>`;
    const snowIntervals = rains.filter(interval => valid(interval.snowfall));
    const snowTotal = snowIntervals.reduce((sum, interval) => sum + displayedSnowfall(interval), 0);
    const snowPartial = snowIntervals.reduce((sum, interval) => sum + interval.end - interval.start, 0) < day.end - day.start - 1;
    const snowEstimated = snowIntervals.some(interval => interval.snowfall > 0 && interval.estimated);
    const snowSummary = snowTotal > 0 ? `<span class="day-snow-volume" title="Neige fraîche estimée de la journée ; pas une hauteur au sol${snowPartial ? ' ; couverture partielle' : ''}${snowEstimated ? ' ; * part estimée au prorata' : ''}"><strong>${escape(snowLabel(snowTotal))}${snowEstimated ? '*' : ''}${snowPartial ? precipitationCoverageSuffix(snowIntervals, timezone) : ''}</strong></span>` : '';
    const summary = `<div class="day-summary"><span class="daily-period-temperatures"><span><small>Min.</small><b>${number(temps[0])}°</b></span><span><small>Max.</small><strong>${number(temps[1])}°</strong></span></span>${rainSummary}${snowSummary}</div>`;
    const dateMarkup = `<time datetime="${day.date}">${escape(shortDate.format(day.start))}</time>`;
    const graphButton = `<button type="button" class="day-chart-toggle" aria-controls="day-chart-${day.date}" aria-expanded="${Boolean(state.chartOpen)}" aria-label="Afficher ou masquer la courbe du ${escape(label.toLowerCase() + ' ' + shortDate.format(day.start))}" title="Afficher ou masquer la courbe">${chartIconMarkup}</button>`;
    const headingTools = `<div class="day-heading-tools">${day.trend ? '<span class="day-trend-label">Tendance</span>' : ''}${graphButton}${updateMarkup(day)}</div>`;
    const dateHeading = collapsible ? `<div class="day-date-heading"><h3>${escape(label)} ${dateMarkup}</h3></div>`
      : `<div class="day-date-heading"><h3>${escape(label)}</h3>${dateMarkup}${day.trend ? '<span class="day-trend-label">Tendance</span>' : ''}</div>`;
    const icon = `<div class="day-summary-icon" role="img" aria-label="Résumé météo du ${day.date}" title="Résumé météo de la journée">${weatherPictogram(dailySummarySample(day), iconMarkup)}</div>`;
    const widthControl = `<label class="day-width-control" hidden title="Une heure par créneau en journée, nuit comprimée"><input type="checkbox"${state.showHourly ? ' checked' : ''} aria-label="afficher le détail par heure du ${day.date}">afficher le détail par heure</label>`;
    const chart = `<div class="day-combined-body">${controlsMarkup(state.opacities)}<div class="day-chart-scroll" role="region" tabindex="0" aria-label="Frise du ${day.date}"><div class="day-chart-content">${collapsible ? '' : renderChart(day, state)}</div></div></div>`;
    if (collapsible) {
      const rainAlert = dailyRainAlertTone(alertSources, day, now);
      const alertLabel = rainAlert ? `Avertissement ${rainAlert === 'orange' ? 'orange' : 'jaune'} pour le cumul de pluie de la journée` : '';
      const alert = rainAlert ? ` data-daily-rain-alert="${rainAlert}" title="${alertLabel}"` : '';
      const dayLabel = [label + ' ' + shortDate.format(day.start), alertLabel].filter(Boolean).join(' · ');
      return `<div class="bulletin-day forecast-day-periods" data-day-date="${day.date}"><article style="order:${index * 2}" class="daily-forecast-card${day.trend ? ' forecast-day-trend' : ''}${day.trend && !days[index - 1]?.trend ? ' forecast-trend-start' : ''}"${alert} aria-label="${escape(dayLabel)}"><header>${dateHeading}${headingTools}</header><div class="daily-period-grid">${periodsMarkup(day, state)}</div></article><section class="forecast-day-row day-chart-panel bulletin-chart-panel" id="day-chart-${day.date}" style="order:${index * 2 - 1}" aria-label="Courbe du ${escape(shortDate.format(day.start))}"${state.chartOpen ? '' : ' hidden'}><header class="forecast-day-header"><h3>${escape(label)} <time datetime="${day.date}">${escape(shortDate.format(day.start))}</time></h3><button type="button" class="day-chart-close" aria-label="Fermer la courbe du ${escape(shortDate.format(day.start))}">×</button></header><div class="day-chart-options">${widthControl}</div>${chart}</section></div>`;
    }
    return `<article class="forecast-day-row${day.trend ? ' forecast-day-trend' : ''}" data-day-date="${day.date}" aria-label="${escape(label + ' ' + shortDate.format(day.start))}"><header class="forecast-day-header">${dateHeading}${icon}${summary}${widthControl}</header>${chart}</article>`;
  }).join('');
  return `<section class="${collapsible ? 'daily-cards-view bulletin-cards-view' : 'forecast-daily-rows'}" aria-label="Prévisions quotidiennes sur ${days.length} jours"><div class="${collapsible ? 'daily-cards-grid bulletin-cards-grid' : 'daily-rows-list'}">${rows}</div></section>`;
}

// PIAF supplies an amount in water equivalent, not a precipitation type.
// When a model predicts a dry interval with explicitly known zero snow and
// liquid components, PIAF's positive amount is estimated as liquid. Never
// derive snow from temperature or replace absent phase components with zero.
function piafPrecipitationPhase(interval, amount) {
  if (amount === 0) return 'dry';
  if (!(amount > 0)) return 'unknown';
  const phase = interval?.phase === 'snow-unknown' ? 'snow' : interval?.phase;
  if (['rain', 'snow', 'mixed', 'freezing'].includes(phase)) return phase;
  return interval?.snowfall === 0 && valid(interval.liquidRain) ? 'rain' : 'unknown';
}

function piafHoverIntensity(sample) {
  if (!valid(sample?.rate)) return { text: '—', value: null, unit: 'mm/h' };
  if (sample.phase === 'dry') return { text: 'Nulle · 0 mm/h', value: 0, unit: 'mm/h' };
  const rain = (name, rate) => name + (rate < 2 ? ' faible' : rate < 10 ? ' modérée' : rate < 30 ? ' soutenue' : rate < 60 ? ' forte' : ' violente') + ' · ' + rainDetailNumber(rate) + ' mm/h';
  if (sample.phase === 'snow') {
    const rate = sample.snowRate;
    return { text: valid(rate) ? 'Neige ' + (rate < .2 ? 'faible' : rate < 1 ? 'modérée' : 'forte') + ' · ' + rainDetailNumber(rate) + ' cm/h' : 'Neige · — cm/h', value: rate, unit: 'cm/h' };
  }
  if (sample.phase === 'mixed') return { text: 'Pluie et neige · ' + (valid(sample.liquidRate) ? rainDetailNumber(sample.liquidRate) : '—') + ' mm/h + ' + (valid(sample.snowRate) ? rainDetailNumber(sample.snowRate) : '—') + ' cm/h', value: sample.rate, unit: 'mm/h' };
  return { text: sample.phase === 'rain' ? rain('Pluie', sample.rate)
    : sample.phase === 'freezing' ? rain('Pluie verglaçante', sample.rate)
      : 'Nature inconnue · ' + rainDetailNumber(sample.rate) + ' mm/h', value: sample.rate, unit: 'mm/h' };
}

function piafHoverTrend(sample, previous, next) {
  const current = piafHoverIntensity(sample);
  if (!valid(current.value)) return '—';
  const comparable = other => other && (other.phase === 'dry' || piafHoverIntensity(other).unit === current.unit)
    && valid(piafHoverIntensity(other).value);
  let difference, other;
  if (comparable(next) && Math.abs(sample.end - next.start) < 1) {
    other = piafHoverIntensity(next).value;
    difference = other - current.value;
  } else if (comparable(previous) && Math.abs(previous.end - sample.start) < 1) {
    other = piafHoverIntensity(previous).value;
    difference = current.value - other;
  } else return '—';
  const tolerance = Math.max(.01, Math.max(Math.abs(current.value), Math.abs(other)) * .05);
  return difference > tolerance ? '↗' : difference < -tolerance ? '↘' : '→';
}

function piafHoverText(sample, previous, next) {
  return 'Cumul PIAF : ' + (valid(sample?.amount) ? rainDetailNumber(sample.amount) + ' mm' : '—')
    + '\nIntensité : ' + piafHoverIntensity(sample).text
    + '\nTendance : ' + piafHoverTrend(sample, previous, next);
}

function piafWeatherStages(now, end, weatherAt, boundaries) {
  const times = [...new Set([now, ...boundaries.filter(time => time > now && time < end), end])].sort((a, b) => a - b);
  const cloudBand = cover => !valid(cover) ? -1 : cover <= 25 ? 0 : cover <= 75 ? 1 : 2;
  const phase = sample => sample.phase || precipitationPhase(sample);
  const snowLevel = sample => sample.snowfall >= 1 ? 3 : sample.snowfall >= .2 ? 2 : 1;
  const runs = [];
  for (const [index, start] of times.slice(0, -1).entries()) {
    const stop = times[index + 1];
    const sample = weatherAt((start + stop) / 2);
    const kind = sample.rain == null ? 'missing' : phase(sample);
    const intensity = Math.max(sample.rainLevel, snowPhase(sample) ? snowLevel(sample) : 0);
    const sky = intensity || sample.stormSignal ? null : cloudBand(sample.cloudCover);
    const key = [sample.stormSignal, kind, intensity, sky].join('/');
    if (runs.at(-1)?.key === key) runs.at(-1).end = stop;
    else runs.push({ start, end: stop, key, sample, kind, intensity });
  }

  const minimum = 20 * 60000;
  const changes = runs.slice(1).map((run, index) => {
    const previous = runs[index];
    const importance = run.sample.stormSignal !== previous.sample.stormSignal ? 4
      : run.kind !== previous.kind ? 3 : run.intensity !== previous.intensity ? 2 : 1;
    return { time: run.start, importance, duration: Math.min(run.end - run.start, previous.end - previous.start) };
  }).sort((a, b) => b.importance - a.importance || b.duration - a.duration || a.time - b.time);
  const breaks = [now, end];
  for (const change of changes) {
    if (breaks.length === 4) break;
    if (breaks.every(time => Math.abs(time - change.time) >= minimum)) breaks.push(change.time);
  }
  breaks.sort((a, b) => a - b);
  const stages = [];
  for (const [index, start] of breaks.slice(0, -1).entries()) {
    const stop = breaks[index + 1];
    const rank = run => run.sample.stormSignal ? 3 : run.kind === 'freezing' ? 2 : run.sample.rain > 0 ? 1 : 0;
    const overlap = run => Math.min(run.end, stop) - Math.max(run.start, start);
    const selected = runs.filter(run => overlap(run) > 0).sort((a, b) => rank(b) - rank(a)
      || b.intensity - a.intensity || overlap(b) - overlap(a))[0];
    if (stages.at(-1)?.key === selected.key) stages.at(-1).stop = stop;
    else stages.push({ start, stop, key: selected.key, representative: selected.sample });
  }
  return stages;
}

export function piafChartMarkup(forecast, { now = Date.now(), width = 600, compact = false, compactRain = false, precipitationOnly = false, showHourly = false, showSnowFlakes = false, timezone = 'Europe/Paris', dashboard = {}, week = {}, iconMarkup = () => '', backgroundForTime = () => '#f7fafc', hazardsMarkup = () => '', alertForSlot = () => ({}) } = {}) {
  const end = now + 3 * HOUR;
  const sources = forecastSources(dashboard, week);
  const precipitationIntervals = nativeRainIntervals(sources);
  const samples = (forecast?.rainSteps || []).filter(sample => !sample.baseRainSource || sample.baseRainSource === 'piaf').map(sample => {
    const start = Math.max(now, sample.intervalStart), stop = Math.min(end, sample.intervalEnd);
    const amount = sample.basePrecipitation ?? sample.precipitation;
    const duration = sample.intervalEnd - sample.intervalStart;
    return { start, end: stop, amount: valid(amount) && duration > 0 ? amount * (stop - start) / duration : null,
      rate: valid(amount) && duration > 0 ? amount * HOUR / duration : null };
  }).filter(sample => valid(sample.start) && valid(sample.end) && sample.end > sample.start && valid(sample.amount))
    .flatMap(sample => {
      if (!compact) return [sample];
      const boundaries = [...new Set([sample.start, sample.end, ...precipitationIntervals.flatMap(interval => [interval.start, interval.end])
        .filter(time => time > sample.start && time < sample.end)])].sort((a, b) => a - b);
      return boundaries.slice(0, -1).map((start, index) => {
        const stop = boundaries[index + 1];
        const interval = precipitationIntervals.find(item => item.start <= start && item.end >= stop);
        const phase = piafPrecipitationPhase(interval, sample.amount);
        return { ...sample, start, end: stop, amount: sample.amount * (stop - start) / (sample.end - sample.start),
          phase, phaseSource: interval?.source,
          snowRate: valid(interval?.snowfall) ? interval.snowfall * HOUR / (interval.end - interval.start) : null,
          liquidRate: valid(interval?.liquidRain) ? interval.liquidRain * HOUR / (interval.end - interval.start) : null,
          phaseEstimate: phase === 'rain' && interval?.phase === 'dry' ? 'PIAF positif ; pluie estimée avec le modèle sans neige prévue' : '' };
      });
    }).sort((a, b) => a.start - b.start);
  // Classify a whole wet episode, not each five-minute amount in isolation.
  // Brief intense rain and sustained light rain must keep their quantitative curve.
  const traceEpisodes = [];
  let episode = [];
  const finishEpisode = () => {
    const amount = episode.reduce((sum, sample) => sum + sample.amount, 0);
    if (amount > 0 && amount < .1 - 1e-9 && episode.every(sample => sample.rate < 1)) {
      episode.forEach(sample => { sample.trace = rainVisible(amount); sample.insignificant = !rainVisible(amount); });
      if (rainVisible(amount)) traceEpisodes.push({ start: episode[0].start, end: episode.at(-1).end, phase: episode.every(sample => sample.phase === episode[0].phase) ? episode[0].phase : 'unknown' });
    }
    episode = [];
  };
  for (const sample of samples) {
    if ((episode.length && sample.start > episode.at(-1).end + 1) || sample.amount <= 0) finishEpisode();
    if (sample.amount > 0) episode.push(sample);
  }
  finishEpisode();
  const hasQuantifiedRain = samples.some(sample => sample.amount > 0 && !sample.trace && !sample.insignificant);
  const onlyTraces = traceEpisodes.length > 0 && !hasQuantifiedRain;
  const snowIntervals = dailyRainBars({ rainIntervals: precipitationIntervals, start: now, end }, now, end, 'snowfall');
  const showSnowScale = compact && snowIntervals.some(interval => interval.rain > 0);
  if (precipitationOnly && !showSnowScale && samples.length && samples.every(sample => sample.amount === 0)) {
    // A PIAF run can end before the three-hour horizon. Use model zeros
    // to confirm uncovered time, while keeping any remaining gap unknown.
    const dryIntervals = [...samples, ...precipitationIntervals.filter(interval => interval.phase === 'dry')]
      .sort((a, b) => a.start - b.start);
    let coveredUntil = now;
    for (const interval of dryIntervals) {
      if (interval.start > coveredUntil) break;
      coveredUntil = Math.max(coveredUntil, interval.end);
      if (coveredUntil >= end) return '<p class="piaf-dry-outlook">Pas de précipitation les 3 prochaines heures.</p>';
    }
  }
  const snowOnly = showSnowScale && samples.filter(sample => sample.amount > 0).every(sample => sample.phase === 'snow');
  width = Math.max(200, Math.round(width));
  const height = compact ? (width < 480 ? 162 : 112) : 260, left = compact ? (showSnowScale && !snowOnly ? 88 : 46) : CHART_INSET, top = compact ? (precipitationOnly ? 34 : 14) : 104, bottom = height - (compact ? 22 : 0);
  const displaySteps = precipitationOnly ? [5, 10, 15, 30, 60] : [5, 15, 30];
  const minimumBarWidth = precipitationOnly ? 36 : 10;
  const automaticStep = compact ? displaySteps.find(minutes => (width - left - CHART_INSET) * minutes / 180 >= minimumBarWidth) ?? displaySteps.at(-1) : 5;
  const canExpand = precipitationOnly && automaticStep > 5 && (samples.length > 0 || showSnowScale);
  const expanded = canExpand && showHourly;
  if (expanded) width = left + 36 * minimumBarWidth + CHART_INSET;
  const right = width - CHART_INSET;
  const maxRate = Math.max(10, ...samples.filter(sample => !sample.trace && !sample.insignificant).map(sample => sample.rate));
  const x = time => left + (time - now) / (end - now) * (right - left);
  const displayStep = expanded ? 5 : automaticStep;
  const displayDuration = displayStep * 60000;
  // Coarsen only the drawing: sums and native intervals remain unchanged.
  // Preserve wet/dry transitions, phases and missing data within each bin.
  const displaySamples = [];
  for (const sample of samples) {
    for (let start = sample.start; start < sample.end;) {
      const stop = Math.min(sample.end, now + (Math.floor((start - now) / displayDuration) + 1) * displayDuration);
      const amount = sample.amount * (stop - start) / (sample.end - sample.start);
      const bin = Math.floor((start - now) / displayDuration);
      const previous = displaySamples.at(-1);
      if (previous && previous.bin === bin && previous.end === start && previous.phase === sample.phase
        && Boolean(previous.trace) === Boolean(sample.trace) && Boolean(previous.insignificant) === Boolean(sample.insignificant)
        && (previous.amount > 0) === (amount > 0)) {
        for (const key of ['snowRate', 'liquidRate']) previous[key] = valid(previous[key]) && valid(sample[key])
          ? (previous[key] * (previous.end - previous.start) + sample[key] * (stop - start)) / (stop - previous.start) : null;
        previous.end = stop;
        previous.amount += amount;
        previous.rate = previous.amount * HOUR / (stop - previous.start);
      } else displaySamples.push({ ...sample, start, end: stop, amount, bin });
      start = stop;
    }
  }
  const y = rate => compact ? bottom - Math.max(0, rate) / maxRate * (bottom - top - 5) : rate > 0 ? bottom - 5 - rate / maxRate * 85 : bottom;
  const hoverWindow = (start, stop) => {
    const parts = samples.filter(sample => sample.start < stop && sample.end > start).map(sample => {
      const duration = Math.min(stop, sample.end) - Math.max(start, sample.start);
      return { ...sample, duration, amount: sample.amount * duration / (sample.end - sample.start) };
    });
    const duration = parts.reduce((sum, sample) => sum + sample.duration, 0);
    const amount = duration ? parts.reduce((sum, sample) => sum + sample.amount, 0) : null;
    const phases = new Set(parts.filter(sample => sample.amount > 0).map(sample => sample.phase));
    const phase = !duration ? 'unknown' : amount === 0 ? 'dry' : phases.size === 1 ? [...phases][0]
      : phases.has('unknown') ? 'unknown' : phases.has('freezing') ? 'freezing' : 'mixed';
    const mean = key => duration && parts.every(sample => valid(sample[key])) ? parts.reduce((sum, sample) => sum + sample[key] * sample.duration, 0) / duration : null;
    return { start, end: stop, amount, phase, duration, rate: duration ? amount * HOUR / duration : null, snowRate: mean('snowRate'), liquidRate: mean('liquidRate') };
  };
  const windowHoverText = (start, stop) => {
    const duration = stop - start;
    return piafHoverText(hoverWindow(start, stop), hoverWindow(start - duration, start), hoverWindow(stop, stop + duration));
  };
  const format = new Intl.DateTimeFormat('fr-FR', { timeZone: timezone, hour: '2-digit', minute: '2-digit' });
  const snowPeak = Math.max(1, ...snowIntervals.map(interval => interval.rain * HOUR / (interval.end - interval.start)));
  const snowMagnitude = 10 ** Math.floor(Math.log10(snowPeak));
  const maxSnowRate = [1, 2, 5, 10].find(step => step >= snowPeak / snowMagnitude) * snowMagnitude;
  const snowY = rate => bottom - rate / maxSnowRate * (bottom - top - 5);
  const weatherAt = time => {
    const sample = { time: new Date(time).toISOString(), stamp: time, sources: {}, temperature: null, cloudCover: null, stormSignal: false };
    for (const key of compact ? ['temperature', 'cloudCover', 'windSpeed', 'windGust'] : ['temperature', 'cloudCover']) {
      for (const hours of sources) {
        const value = continuous(hours, time, key);
        if (!valid(value)) continue;
        sample[key] = value;
        sample.sources[key] = hours[0].source;
        break;
      }
    }
    for (const hours of sources) {
      const value = stormAt(hours, Math.floor(time / HOUR) * HOUR);
      if (!valid(value)) continue;
      sample.stormSignal = value === 1;
      if (sample.stormSignal) sample.sources.storm = hours[0].source;
      break;
    }
    const rain = samples.find(item => item.start <= Math.min(time, end - 1) && item.end > Math.min(time, end - 1));
    sample.rain = rain?.insignificant ? 0 : rain?.rate ?? null;
    const phaseInterval = precipitationIntervals.find(item => item.start <= Math.min(time, end - 1) && item.end > Math.min(time, end - 1));
    if (!rain) {
      sample.phase = 'unknown';
      sample.phaseDescription = 'Précipitations PIAF indisponibles à cette heure ; ce pictogramme ne signifie pas un temps sec';
    } else if (phaseInterval) {
      const dry = sample.rain === 0;
      Object.assign(sample, { phase: piafPrecipitationPhase(phaseInterval, sample.rain),
        snowfall: dry ? 0 : valid(phaseInterval.snowfall) ? phaseInterval.snowfall * HOUR / (phaseInterval.end - phaseInterval.start) : null,
        liquidRain: dry ? 0 : phaseInterval.liquidRain });
      if (!dry && phaseInterval.phase === 'dry' && sample.phase === 'rain') {
        sample.phaseDescription = 'Pluie estimée : PIAF annonce des précipitations, ' + phaseInterval.source + ' ne prévoit pas de neige ; PIAF ne fournit pas la nature';
      }
      if (phaseInterval.phase && !dry) sample.sources.phase = phaseInterval.source;
    }
    sample.rainLevel = rainIntensityPictogramLevel(sample.phase === 'mixed' ? rain?.liquidRate : sample.rain);
    return sample;
  };
  const weather = Array.from({ length: 37 }, (_, index) => weatherAt(now + index * 5 * 60000));
  const edgeTime = left / (right - left) * (end - now);
  const curveWeather = [weatherAt(now - edgeTime), ...weather, weatherAt(end + edgeTime)];
  const temperatureDomain = extent(curveWeather, 'temperature', [0, 20]);
  const temperaturePadding = Math.max(1.5, (temperatureDomain[1] - temperatureDomain[0]) * .2);
  const temperatureY = value => bottom - 24 - (value - temperatureDomain[0] + temperaturePadding)
    / (temperatureDomain[1] - temperatureDomain[0] + 2 * temperaturePadding) * (bottom - 24 - top);
  let temperatureLine = '', previousTemperature = null;
  for (const sample of compact ? [] : curveWeather) {
    if (!valid(sample.temperature)) { previousTemperature = null; continue; }
    if (previousTemperature) temperatureLine += `<path class="piaf-temperature-line" d="M${x(previousTemperature.stamp)},${temperatureY(previousTemperature.temperature)} L${x(sample.stamp)},${temperatureY(sample.temperature)}"/>`;
    previousTemperature = sample;
  }
  let lines = '', areas = '', segment = [], previousEnd = null, segmentPhase = null;
  const phaseClass = phase => compact ? ' piaf-phase-' + phase : '';
  const finish = () => {
    if (!segment.length) return;
    if (compact) { segment = []; return; }
    const path = segment.map((point, index) => (index ? 'L' : 'M') + point.join(',')).join(' ');
    lines += `<path d="${path}" class="piaf-intensity-line${phaseClass(segmentPhase)}"/>`;
    areas += `<path d="M${segment[0][0]},${bottom} L${segment.map(point => point.join(',')).join(' L')} L${segment.at(-1)[0]},${bottom} Z" class="piaf-intensity-area${phaseClass(segmentPhase)}"/>`;
    segment = [];
  };
  const points = (compact ? displaySamples : samples).map((sample, index, displayed) => {
    if (previousEnd !== null && (sample.start > previousEnd + 1 || compact && sample.phase !== segmentPhase)) finish();
    segmentPhase = sample.phase;
    if (sample.trace || sample.insignificant || sample.amount <= 0) finish();
    else segment.push([x(sample.start), y(sample.rate)], [x(sample.end), y(sample.rate)]);
    previousEnd = sample.end;
    const phaseNames = { rain: 'Pluie', snow: 'Neige', mixed: 'Pluie et neige', freezing: 'Précipitations verglaçantes', dry: 'Pas de précipitations', unknown: 'Nature indéterminée (données de phase absentes)' };
    const detail = compact ? piafHoverText(sample, displayed[index - 1], displayed[index + 1]) : format.format(sample.start) + ' – ' + format.format(sample.end)
      + (compact ? '\n' + phaseNames[sample.phase] + (sample.phaseSource ? ' · phase estimée par ' + sample.phaseSource : '') : '')
      + (sample.phaseEstimate ? '\n' + sample.phaseEstimate : '')
      + (sample.trace ? '\nPIAF : gouttes ; repère fixe hors échelle d’intensité' : '\nPIAF')
      + '\nIntensité' + (compact && displayStep > 5 ? ' moyenne' : '') + ' : ' + rainDetailNumber(sample.rate) + ' mm/h\nCumul sur ce créneau : ' + rainDetailNumber(sample.amount) + ' mm';
    return `<g class="chart-point" tabindex="0" data-tooltip="${escape(detail)}" aria-label="${escape(detail)}"><rect x="${x(sample.start)}" y="${top}" width="${Math.max(1, x(sample.end) - x(sample.start))}" height="${bottom - top}" fill="transparent"/></g>`;
  }).join('');
  finish();
  const snowPlateaus = [];
  const snowFlakes = [];
  const snowFlakeSize = Math.min(14, (x(now + displayDuration) - x(now)) * .9);
  const displaySnowIntervals = [];
  for (const interval of snowIntervals) {
    if (displayStep === 5) { displaySnowIntervals.push(interval); continue; }
    for (let start = interval.start; start < interval.end;) {
      const stop = Math.min(interval.end, now + (Math.floor((start - now) / displayDuration) + 1) * displayDuration);
      const amount = interval.rain * (stop - start) / (interval.end - interval.start);
      const bin = Math.floor((start - now) / displayDuration);
      const previous = displaySnowIntervals.at(-1);
      if (previous && previous.bin === bin && previous.end === start && previous.source === interval.source
        && previous.phase === interval.phase && (previous.rain > 0) === (amount > 0)) {
        previous.end = stop;
        previous.rain += amount;
      } else displaySnowIntervals.push({ ...interval, start, end: stop, rain: amount, bin });
      start = stop;
    }
  }
  const snowBarSymbol = compact && showSnowFlakes ? '<g id="piaf-snow-bar-flake-symbol" fill="none" stroke="#258bc0" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path transform="translate(-12 -12)" d="M12 2v20M3.34 7l17.32 10M3.34 17 20.66 7M9 4l3 3 3-3M9 20l3-3 3 3M3.5 10.5l4.1-1.1-1.1-4.1M17.5 18.7l-1.1-4.1 4.1-1.1M6.5 18.7l1.1-4.1-4.1-1.1M20.5 10.5l-4.1-1.1 1.1-4.1"/></g>' : '';
  const snowBars = showSnowScale ? displaySnowIntervals.filter(interval => interval.rain > 0).map((interval, index, displayed) => {
    const rate = interval.rain * HOUR / (interval.end - interval.start);
    const snowSample = item => item && ({ ...hoverWindow(item.start, item.end), phase: item.phase === 'mixed' ? 'mixed' : 'snow', snowRate: item.rain * HOUR / (item.end - item.start) });
    const detail = piafHoverText(snowSample(interval), snowSample(displayed[index - 1]), snowSample(displayed[index + 1]));
    const plateau = snowPlateaus.at(-1);
    if (plateau && Math.abs(plateau.rate - rate) < 1e-9 && Math.abs(plateau.end - interval.start) < 1) plateau.end = interval.end;
    else snowPlateaus.push({ start: interval.start, end: interval.end, rate });
    // The visual spacing matches rain. Each small bar retains its native
    // model interval's mean rate; splitting does not add forecast detail.
    const rectangles = [];
    for (let start = interval.start; start < interval.end;) {
      const stop = Math.min(interval.end, now + (Math.floor((start - now) / displayDuration) + 1) * displayDuration);
      const span = x(stop) - x(start), gap = Math.min(.8, span / 6);
      const barWidth = Math.max(.1, span - 2 * gap), barHeight = bottom - snowY(rate);
      rectangles.push(`<rect class="piaf-snow-bar" x="${x(start) + gap}" y="${snowY(rate)}" width="${barWidth}" height="${barHeight}"/>`);
      // Continue beneath the cap's highest undulation; the cap masks the ends.
      const edgeTop = snowY(rate) - 7.1;
      rectangles.push(`<path class="piaf-snow-bar-edge" d="M${x(start) + gap},${edgeTop} V${bottom} H${x(start) + gap + barWidth} V${edgeTop}" aria-hidden="true"/>`);
      // Stable per time step: irregular positions never flicker on redraw.
      let seed = Math.floor(start / 300000) >>> 0;
      seed = Math.imul(seed ^ (seed >>> 16), 0x7feb352d);
      seed = Math.imul(seed ^ (seed >>> 15), 0x846ca68b);
      const offset = ((seed ^ (seed >>> 16)) >>> 0) / 4294967296;
      const size = snowFlakeSize;
      const cy = snowY(rate) - 14 - size / 2 - offset * 6;
      // Pass showSnowFlakes: true to restore the decorative flakes.
      if (showSnowFlakes) snowFlakes.push(`<use class="piaf-snow-bar-flake" href="#piaf-snow-bar-flake-symbol" transform="translate(${x(start) + gap + barWidth / 2} ${cy}) scale(${size / 24})" data-flake-offset="${offset}" aria-hidden="true"/>`);
      start = stop;
    }
    return `<g class="chart-point piaf-snow-column" tabindex="0" data-tooltip="${escape(detail)}" aria-label="${escape(detail)}" data-snow-rate="${rate}" data-snow-amount="${interval.rain}">${rectangles.join('')}</g>`;
  }).join('') : '';
  const snowCaps = snowCapMarkup(snowPlateaus.map(plateau => {
    const gap = Math.min(.8, (x(plateau.end) - x(plateau.start)) / 6);
    return { left: x(plateau.start) + gap, right: x(plateau.end) - gap,
      level: snowY(plateau.rate) - 4.25, stamp: plateau.start };
  }));
  const bars = compact ? displaySamples.filter(sample => sample.amount > 0 && !sample.trace && !sample.insignificant
    && !(sample.phase === 'snow' && snowIntervals.filter(interval => interval.rain > 0).reduce((covered, interval) => covered
      + Math.max(0, Math.min(sample.end, interval.end) - Math.max(sample.start, interval.start)), 0) >= sample.end - sample.start - 1)).map(sample => {
    const span = x(sample.end) - x(sample.start), gap = Math.min(.8, span / 6);
    const barLeft = x(sample.start) + gap, barWidth = Math.max(.1, span - 2 * gap);
    const barHeight = Math.max(compactRain ? minimumRainBarHeight : 0, bottom - y(sample.rate)), barTop = bottom - barHeight;
    const overlapsSnow = snowIntervals.some(interval => interval.rain > 0 && interval.start < sample.end && interval.end > sample.start);
    const drops = compactRain && !overlapsSnow ? rainBarDropsMarkup(barLeft, barLeft + barWidth, barTop, sample.rate) : '';
    return `<rect class="piaf-rain-bar${phaseClass(sample.phase)}" x="${barLeft}" y="${barTop}" width="${barWidth}" height="${barHeight}" data-rain-rate="${sample.rate}" data-rain-amount="${sample.amount}"/>${drops}`;
  }).join('') : '';
  let lastTraceLabelRight = -Infinity;
  const traceHeight = compactRain ? minimumRainBarHeight : 5;
  const traces = traceEpisodes.map(episode => {
    if (snowOnly) return '';
    const start = x(episode.start), stop = x(episode.end), center = Math.max(23, Math.min(width - 23, (start + stop) / 2));
    const showLabel = center - 22 > lastTraceLabelRight + 3;
    if (showLabel) lastTraceLabelRight = center + 22;
    const marks = compact ? displaySamples.filter(sample => sample.trace && sample.start >= episode.start && sample.end <= episode.end).map(sample => {
      const span = x(sample.end) - x(sample.start), gap = Math.min(.8, span / 6);
      return `<rect class="piaf-trace-mark${phaseClass(sample.phase)}" x="${x(sample.start) + gap}" y="${bottom - traceHeight}" width="${Math.max(.1, span - 2 * gap)}" height="${traceHeight}"/>`;
    }).join('') : `<rect class="piaf-trace-mark${phaseClass(episode.phase)}" x="${start}" y="${bottom - traceHeight}" width="${stop - start}" height="${traceHeight}"/>`;
    return marks
      + (showLabel ? `<text class="piaf-trace-label" x="${center}" y="${bottom - 11}" text-anchor="middle">gouttes</text>` : '');
  }).join('');
  const maxIntervals = Math.max(compact ? 3 : 2, Math.floor((right - left) / (compact ? 88 : 64)));
  const step = (compact ? [15, 30, 45, 60, 90, 180] : [15, 30, 60, 90]).find(minutes => 180 / minutes <= maxIntervals) || (compact ? 180 : 90);
  const times = Array.from({ length: 180 / step + 1 }, (_, i) => now + i * step * 60000);
  const ticks = times.map(time => `<line x1="${x(time)}" x2="${x(time)}" y1="0" y2="${bottom}" class="day-combined-grid"/>${compact ? `<text x="${x(time)}" y="${bottom + 15}" text-anchor="middle">${format.format(time)}</text>` : ''}`).join('');
  const dropPath = '<path d="M12 2.8C9.5 6.4 6.8 9.7 6.8 13.2a5.2 5.2 0 0 0 10.4 0C17.2 9.7 14.5 6.4 12 2.8Z"/>';
  const drySlash = '<path fill="none" stroke="#fff" stroke-width="4" d="M5 5 19 19"/><path class="piaf-dry-rain-slash" fill="none" stroke="#21617e" stroke-width="2" stroke-linecap="round" d="M5 5 19 19"/>';
  const drySlots = precipitationOnly ? times.slice(0, -1).map((start, index) => {
    const stop = times[index + 1];
    const coverage = hoverWindow(start, stop);
    if (coverage.duration < stop - start - 1 || coverage.amount !== 0
      || snowIntervals.some(interval => interval.rain > 0 && interval.start < stop && interval.end > start)) return '';
    const label = `${format.format(start)}–${format.format(stop)} · Pas de précipitations`;
    return `<svg class="piaf-dry-slot chart-point" x="${x((start + stop) / 2) - 9}" y="${bottom - 22}" width="18" height="18" viewBox="0 0 24 24" fill="#258bc0" tabindex="0" role="img" aria-label="${label}" data-tooltip="${label}">${dropPath}${drySlash}</svg>`;
  }).join('') : '';
  const temperaturePoints = (compact ? [] : times).map(time => {
    const sample = weatherAt(time);
    if (!valid(sample.temperature)) return '';
    const detail = format.format(time) + '\nTempérature : ' + number(sample.temperature) + ' °C\n' + sample.sources.temperature;
    return `<g class="chart-point piaf-temperature-point" tabindex="0" data-tooltip="${escape(detail)}" aria-label="${escape(detail)}"><circle cx="${x(time)}" cy="${temperatureY(sample.temperature)}" r="3"/><text x="${x(time)}" y="${temperatureY(sample.temperature) - 10}" text-anchor="middle">${number(sample.temperature)}°</text></g>`;
  }).join('');
  const alertBackgrounds = [];
  const alertCauses = {};
  const alertLabels = { yellow: 'jaune', orange: 'orange', red: 'rouge' };
  const slotAlerts = (compact ? times.slice(0, -1) : []).map((start, index) => {
    const stop = times[index + 1];
    const rainRate = Math.max(0, ...samples.filter(sample => sample.phase === 'rain' && sample.start < stop && sample.end > start)
      .map(sample => sample.rate));
    const alert = alertForSlot({ start, end: stop, rainRate });
    const tone = typeof alert === 'string' ? alert : alert.tone;
    for (const [metric, value] of Object.entries(alert.causes ?? {})) {
      alertCauses[metric] = Math.max(alertCauses[metric] ?? 0, value);
    }
    const alertLabel = alertLabels[tone];
    if (alertLabel) alertBackgrounds.push(`<rect class="piaf-slot-alert piaf-slot-alert-${tone}" x="${x(start)}" y="0" width="${x(stop) - x(start)}" height="${height}" aria-hidden="true"/>`);
    return { start, stop, tone };
  });
  const boundaries = [...weather.map(sample => sample.stamp),
    ...samples.flatMap(sample => [sample.start, sample.end]),
    ...precipitationIntervals.flatMap(interval => [interval.start, interval.end]),
    ...Array.from({ length: 3 }, (_, index) => Math.floor(now / HOUR) * HOUR + (index + 1) * HOUR)];
  const alertOrder = ['red', 'orange', 'yellow'];
  const weatherSummary = compact && !precipitationOnly ? piafWeatherStages(now, end, weatherAt, boundaries).map(({ start, stop, representative }) => {
    const tone = alertOrder.find(tone => slotAlerts.some(slot => slot.tone === tone && slot.start < stop && slot.stop > start));
    const range = `${format.format(start)}–${format.format(stop)}`;
    const detail = windowHoverText(start, stop) + (tone ? '\nAvertissement du bulletin : ' + alertLabels[tone] : '');
    const pictogram = weatherPictogram({ ...representative, phaseDescription: '' }, iconMarkup).replace(/\s+title="[^"]*"/g, '');
    return `<div class="piaf-weather-slot chart-point" tabindex="0" data-tooltip="${escape(detail)}" aria-label="${escape(range + '\n' + detail)}" data-slot-start="${start}" data-slot-end="${stop}"><time datetime="${new Date(start).toISOString()}">${range}</time>${pictogram}</div>`;
  }).join('') : '';
  const header = compact ? '' : times.map(time => `<div class="day-timeline-slot" style="left:${x(time) / width * 100}%"><time datetime="${new Date(time).toISOString()}">${format.format(time)}</time>${weatherPictogram(weatherAt(time), iconMarkup)}</div>`).join('');
  const axis = [0, maxRate / 2, maxRate].map(rate => `<text x="${left - 6}" y="${Math.min(height - 4, y(rate) + 4)}" text-anchor="end">${number(rate)}</text>`).join('');
  // Colour and height share a linear intensity scale, independently of cumulative rainfall.
  const rainGradient = compactRain ? rainIntensityGradient('piaf-rain-intensity', bottom, bottom - y(maxRate), maxRate)
    : `<linearGradient id="piaf-rain-intensity" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${bottom}" y2="${y(maxRate)}"><stop offset="0%" stop-color="#dbeafe"/><stop offset="50%" stop-color="#60a5fa"/><stop offset="100%" stop-color="#1e3a8a"/></linearGradient>`;
  const blueGradient = compact ? `<defs>${rainGradient}${snowBarSymbol}</defs>` : '';
  const snowScaleBar = barX => {
    const level = y(maxRate);
    const cap = `M${barX},${level + 1} C${barX + 1},${level + 1} ${barX + 2},${level - 1} ${barX + 3},${level - 1} C${barX + 4},${level - 1} ${barX + 5},${level + .5} ${barX + 6},${level + .5} C${barX + 7},${level + .5} ${barX + 7},${level} ${barX + 8},${level}`;
    return `<g class="piaf-snow-scale-symbol" aria-hidden="true"><rect class="piaf-snow-scale-bar" x="${barX}" y="${level}" width="8" height="${bottom - level}"/><path class="piaf-snow-scale-edge piaf-snow-bar-edge" d="M${barX},${level} V${bottom} H${barX + 8} V${level}"/><path class="piaf-snow-scale-cap-outline piaf-snow-cap-outline" d="${cap}"/><path class="piaf-snow-scale-cap piaf-snow-cap" d="${cap}"/></g>`;
  };
  const scaleMarkup = (unit, maximum, barX, textX, unitX, title) => `<g class="piaf-vertical-scale${unit === 'cm/h' ? ' piaf-snow-scale' : ''}" role="img" aria-label="${escape(title)}"><text class="piaf-scale-name" x="${unitX}" y="${y(maxRate) - 27}" text-anchor="middle">${unit === 'cm/h' ? 'Neige' : 'Pluie'}</text><text class="piaf-rain-unit" x="${unitX}" y="${y(maxRate) - 10}" text-anchor="middle">${unit}</text>${unit === 'cm/h' ? snowScaleBar(barX) : `<rect x="${barX}" y="${y(maxRate)}" width="8" height="${bottom - y(maxRate)}" rx="2" fill="url(#piaf-rain-intensity)"/>`}${[0, maximum / 2, maximum].map(rate => `<text x="${textX}" y="${Math.min(height - 4, bottom - rate / maximum * (bottom - top - 5) + 4)}" text-anchor="end">${number(rate)}</text>`).join('')}</g>`;
  const snowScaleTitle = 'Neige fraîche estimée par les modèles : 0 à ' + number(maxSnowRate) + ' cm/h ; échelle indépendante de PIAF';
  const verticalLegend = compact && ((precipitationOnly ? samples.length > 0 : samples.some(sample => sample.amount > 0)) || showSnowScale) ? snowOnly
    ? scaleMarkup('cm/h', maxSnowRate, 23, 18, 22, snowScaleTitle)
    : scaleMarkup('mm/h', maxRate, 23, 18, 22, 'Précipitations PIAF : 0 à ' + number(maxRate) + ' mm/h, équivalent eau')
      + (showSnowScale ? scaleMarkup('cm/h', maxSnowRate, 65, 60, 64, snowScaleTitle) : '') : '';

  const total = samples.reduce((sum, sample) => sum + sample.amount, 0);
  const snowTotal = snowIntervals.reduce((sum, interval) => sum + interval.rain, 0);
  const snowSources = [...new Set(snowIntervals.filter(interval => interval.rain > 0).map(interval => interval.source))];
  const snowPartial = snowIntervals.reduce((sum, interval) => sum + interval.end - interval.start, 0) < end - now - 1;
  const rainStatus = (onlyTraces && rainTrace(total) ? '<span class="piaf-chart-total">gouttes</span>'
    : rainVisible(total) ? `<span class="piaf-chart-total">${rainNumber(total)} mm</span>` : '')
    + (snowTotal > 0 ? `<span class="piaf-chart-total" title="Neige fraîche estimée par ${escape(snowSources.join(' · '))}, distincte du cumul PIAF en équivalent eau ; pas une hauteur au sol${snowIntervals.some(interval => interval.estimated) ? ' ; créneaux coupés estimés au prorata' : ''}">Neige ${escape(snowSources.join(' · '))} ${escape(snowLabel(snowTotal))}${snowPartial ? precipitationCoverageSuffix(snowIntervals, timezone) : ''}</span>` : '');
  const temperatureSamples = [...weather, ...sources.flatMap(hours => hours.filter(hour => hour.stamp >= now && hour.stamp <= end).map(hour => weatherAt(hour.stamp)))];
  const temperatures = extent(temperatureSamples, 'temperature', [null, null]);
  const temperaturePartial = weather.some(sample => !valid(sample.temperature));
  const covered = samples.reduce((sum, sample) => sum + sample.end - sample.start, 0);
  const partial = covered < end - now - 1;
  const hazards = hazardsMarkup({ windSpeed: extent(temperatureSamples, 'windSpeed', [null, null])[1],
    windGust: extent(temperatureSamples, 'windGust', [null, null])[1], storm: temperatureSamples.some(sample => sample.stormSignal) }, alertCauses);
  const dry = samples.length > 0 && total === 0;
  const coverageOptions = { minuteUnit: ' min', before: end };
  const rainEnd = precipitationCoverageEnd(samples, timezone, coverageOptions);
  const snowEnd = precipitationCoverageEnd(snowIntervals, timezone, coverageOptions);
  const rainDrop = `<svg class="rain-drop" viewBox="0 0 24 24" aria-hidden="true">${dropPath}</svg>`;
  const dryLabel = `Pas de pluie${rainEnd ? ` (jusqu’à ${rainEnd})` : ''}`;
  const dryRainIcon = `<svg class="rain-drop" viewBox="0 0 24 24" role="img" aria-label="${dryLabel}"><title>${dryLabel}</title>${dropPath}${drySlash}</svg>`;
  const coverage = time => time ? `<small class="piaf-summary-coverage">(jusqu’à ${time})</small>` : '';
  const reading = (amount, unit, { highlighted = false, label = '', icon = '', until = '' } = {}) =>
    `<span class="rain-reading">${label ? `<small class="piaf-summary-label">${label}${icon} :</small>` : ''}<span class="rain-amount${highlighted ? ' alert-value' : ''}">${escape(amount)}</span>${unit ? `<span class="rain-unit">${unit}</span>` : ''}${coverage(until)}</span>`;
  const trace = total > 0 && total < .1 - 1e-9;
  const precipitationSummary = samples.length ? `<span class="piaf-precipitation-item" title="${dry ? dryLabel : `Cumul PIAF des trois prochaines heures en équivalent eau${partial ? ' ; couverture partielle' : ''}`}">${dry ? dryRainIcon
    : reading(trace ? 'gouttes' : rainDetailNumber(total), trace ? '' : 'mm', { label: 'Cumul', icon: rainDrop, until: rainEnd })}</span>` : '';
  const snowSummary = snowTotal > 0 ? `<span class="piaf-precipitation-item piaf-summary-snow" title="Neige fraîche estimée par ${escape(snowSources.join(' · '))} ; estimation distincte du cumul PIAF en équivalent eau ; pas une hauteur au sol">${reading(Math.round(snowTotal) || '< 1', 'cm', { label: 'Cumul neige', until: snowEnd })}</span>` : '';
  const alertRainMarkup = [
    ['Pic de pluie', alertCauses.rainRate, 'mm/h'],
    ['Cumul prévu', Math.max(alertCauses.rain ?? 0, alertCauses.rain3h ?? 0), 'mm'],
  ].filter(([, value]) => value > 0).map(([label, value, unit]) =>
    `<span class="piaf-precipitation-item"><small class="piaf-summary-note">${label}</small>${reading(rainDetailNumber(value), unit, { highlighted: true })}</span>`).join('');
  const precipitationMetrics = precipitationSummary + snowSummary + alertRainMarkup;
  const [minimum, maximum] = temperatures.map(value => valid(value) ? number(value) + '°' : '—');
  const summary = compact && !precipitationOnly ? `<div class="piaf-three-hour-summary forecast-metrics">
    <span class="temperatures"><span class="temperature-values" role="group" aria-label="Température minimale ${minimum}, maximale ${maximum}${temperaturePartial ? ' ; données partielles' : ''}"><span class="min" aria-hidden="true">${minimum}</span><span class="temperature-divider" aria-hidden="true">/</span><span class="max" aria-hidden="true">${maximum}</span></span></span>
    ${precipitationMetrics ? `<span class="rain-total">${precipitationMetrics}</span>` : ''}
    ${hazards}
  </div>` : '';
  const usedSources = [...new Set(weather.flatMap(sample => Object.values(sample.sources)))];
  for (const source of snowSources) if (!usedSources.includes(source)) usedSources.push(source);
  if (samples.length) usedSources.push('PIAF');
  const metadata = { AROME: dashboard.arome, ARPEGE: week, 'Open-Meteo': dashboard.openMeteo, PIAF: dashboard.piaf };
  const sourceLine = sourceUpdatesMarkup(usedSources.map(name => ({ name, fetchedAt: metadata[name]?.fetchedAt })), timezone, now);
  const rainLegend = !samples.length ? 'Précip. PIAF indisponibles' : onlyTraces ? 'Précip. PIAF' : 'Précip. PIAF mm/h équiv. eau';
  const lightStops = weather.map(sample => `<stop offset="${(sample.stamp - now) / (end - now) * 100}%" stop-color="${escape(backgroundForTime(sample.stamp))}"/>`).join('');
  const background = compact ? alertBackgrounds.join('') : `<defs><linearGradient id="piaf-daylight" gradientUnits="userSpaceOnUse" x1="${left}" x2="${right}" y1="0" y2="0">${lightStops}</linearGradient></defs><rect width="${width}" height="${height}" fill="url(#piaf-daylight)"/>`;
  const legend = compact ? (samples.length || showSnowScale ? '' : '<div class="day-chart-key">Précip. PIAF indisponibles</div>') : `<div class="day-chart-key"><span class="piaf-legend-temperature">Température °C</span><span class="piaf-legend-rain"${samples.length ? '' : ' aria-label="PIAF indisponible" aria-disabled="true" title="PIAF indisponible"'}>${rainLegend}</span>${rainStatus}<span class="day-key-spacer" aria-hidden="true"></span>${sourceLine}</div>`;
  const summaryMarkup = summary.replace(/ title="/g, ' aria-description="');
  const hourlyControl = canExpand
    ? `<div class="day-chart-options"><label class="day-width-control"><input type="checkbox"${expanded ? ' checked' : ''}>afficher le détail par 5 min</label></div>` : '';
  const weatherMarkup = weatherSummary ? `<div class="piaf-weather-summary" role="group" aria-label="Résumé météo des trois prochaines heures">${weatherSummary}</div>` : '';
  const diagram = expanded ? '<div class="piaf-diagram piaf-diagram-expanded" role="region" aria-label="Diagramme détaillé des précipitations" tabindex="0">' : '<div class="piaf-diagram">';
  return `<section class="piaf-three-hour-view${compact ? ' piaf-precipitation-view' : ''}">${summaryMarkup}${weatherMarkup}${hourlyControl}${compact ? diagram : ''}${legend}<div class="day-combined-canvas piaf-timeline-canvas" style="height:${height}px${expanded ? `;width:${width}px` : ''}"><svg class="piaf-intensity-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="group" aria-label="${compact ? `Frise des trois prochaines heures : précipitations PIAF${samples.length ? '' : ' indisponibles'}` : 'Frise des trois prochaines heures : température, précipitations PIAF et pictogrammes'}">${background}${blueGradient}${ticks}${compact ? verticalLegend : hasQuantifiedRain ? axis : ''}${areas}${lines}${snowBars}${bars}${traces}${snowCaps}${snowFlakes.join('')}${points}${drySlots}${temperatureLine}${temperaturePoints}</svg>${compact ? '' : `<div class="day-timeline-header">${header}</div>`}</div>${compact ? '</div>' : ''}</section>`;
}
