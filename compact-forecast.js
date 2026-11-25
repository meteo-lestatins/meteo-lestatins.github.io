import { cardPeriods } from './card-periods.js?v=1.24';

const temperature = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const rainfall = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
const roundedRainfall = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const HOUR = 3600000;
const rainIsTrace = amount => amount > 0 && amount <= .1 + 1e-9;
const notableMeanWind = 20;
const skyLabels = ['Dégagé', 'Peu nuageux', 'Éclaircies', 'Nuageux', 'Très nuageux', 'Couvert'];
const skyBand = cloud => [5, 25, 50, 75, 90, Infinity].findIndex(limit => cloud <= limit);
const snowPhases = ['snow', 'snow-unknown', 'mixed'];
const formatTemp = value => value == null ? '—' : temperature.format(Math.abs(value) < .5 ? 0 : value).replace('-', '−') + '°';
const alertLabels = { yellow: 'Alerte du bulletin jaune', orange: 'Alerte du bulletin orange', red: 'Alerte du bulletin rouge' };

function image(path, className = '') {
  return '<img alt=""' + (className ? ' class="' + className + '"' : '') + ' src="' + path + '">';
}

function trendArrow(direction, metric, description) {
  return `<span class="trend-arrow trend-${metric} trend-${direction}" role="img" aria-label="${description}" title="${description}"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 10V2M2.5 5.5 6 2l3.5 3.5"/></svg></span>`;
}

function comparableSeries(periods, sourceOf, valueOf) {
  const { period: current, sources } = periods.at(-1) ?? {};
  const model = current && sourceOf(current);
  if (!model || model.includes(' · ') || !Number.isFinite(valueOf(current))) return [];
  const currentRun = new Date(sources[model]?.runTime ?? NaN).valueOf();
  if (!Number.isFinite(currentRun)) return [];
  const byRun = new Map();
  for (const { period, sources } of periods) {
    if (!period || sourceOf(period) !== model) continue;
    const value = valueOf(period);
    const source = sources[model];
    const timestamp = new Date(source?.runTime ?? source?.fetchedAt ?? NaN).valueOf();
    if (Number.isFinite(value) && timestamp <= currentRun) byRun.set(timestamp, value);
  }
  return [...byRun].sort((left, right) => left[0] - right[0]).slice(-8).map(([, value]) => value);
}

function globalDirection(series, threshold) {
  if (series.length < 3) return '';
  const median = values => {
    const sorted = values.slice().sort((a, b) => a - b);
    return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
  };
  const half = Math.floor(series.length / 2);
  const earlier = series.slice(0, half);
  const recent = series.slice(-half);
  const difference = median(recent) - median(earlier);
  if (Math.abs(difference) < threshold) return '';
  const agrees = change => Math.sign(difference) * change >= threshold / 4;
  // A single jump or a lone outlier is not enough to confirm a direction.
  if (series.length === 3) {
    if (!agrees(series[1] - series[0]) || !agrees(series[2] - series[1])) return '';
  } else {
    const comparisons = earlier.flatMap(before => recent.map(after => agrees(after - before)));
    if (comparisons.filter(Boolean).length < .75 * comparisons.length) return '';
  }
  return difference > 0 ? 'up' : 'down';
}

function trend(series, threshold, metric, label) {
  const direction = globalDirection(series, threshold);
  if (!direction) return '';
  const movement = direction === 'up' ? 'à la hausse' : 'à la baisse';
  return trendArrow(direction, metric, `${label} ${movement} sur ${series.length} relevés comparables`);
}

const precipitationSource = period => period.completeRain && period.rainSources.length === 1 ? period.rainSources[0] : '';

function weatherTrends(periods) {
  const snow = comparableSeries(periods, precipitationSource, period => period.snowfall);
  const storm = comparableSeries(periods, period => period.sources.storm, period => period.storm == null ? null : Number(period.storm));
  return trend(snow, .5, 'snow', 'Tendance neige') + trend(storm, .5, 'storm', 'Tendance du signal orageux');
}

function liquidRainText(period) {
  if (!period.completeRain && !(period.liquidRain > 0)) return null;
  if (Number.isFinite(period.liquidRain)) {
    if (rainIsTrace(period.liquidRain)) return 'gouttes';
    const value = rainfall.format(period.liquidRain);
    return value === '0,1' ? '&gt; 0,1' : value;
  }
  let known = 0;
  let unclassified = 0;
  for (const interval of period.intervals) {
    if (Number.isFinite(interval.liquidRain)) known += interval.liquidRain;
    else unclassified += interval.rain;
  }
  const upper = known + unclassified;
  if (rainIsTrace(known) && rainIsTrace(upper)) return 'gouttes';
  const lower = roundedRainfall.format(known);
  // Keep a value only when the unclassified amount cannot change the displayed precision.
  if (known <= .1 + 1e-9 || lower !== roundedRainfall.format(upper)) return null;
  return lower === '0,1' ? '&gt; 0,1' : lower;
}

function dailyRainMarkup(dayTotal, periods, highlighted, rainTone) {
  const liquid = liquidRainText(dayTotal);
  const equivalent = liquid == null && dayTotal.rain > 0 && !Number.isFinite(dayTotal.liquidRain);
  const value = equivalent ? (dayTotal.rain < .01 ? '&lt; 0,01' : rainfall.format(dayTotal.rain)) : liquid;
  const dry = dayTotal.completeRain && dayTotal.liquidRain === 0;
  if (dry) return rainTone ? `<span class="rain-total">${rainAlertMarkup(rainTone)}</span>` : '';
  const available = value != null;
  const trace = value === 'gouttes';
  const rain = comparableSeries(periods, precipitationSource, period => period.liquidRain);
  const partial = available && !dayTotal.completeRain;
  const qualifier = partial ? ' · données partielles' : '';
  const label = equivalent ? 'Précipitations prévues en équivalent eau · répartition pluie/neige incomplète' + qualifier
    : trace ? 'Traces de pluie prévues' + qualifier
    : available ? (partial ? 'Cumul de pluie sur la période disponible' : 'Cumul de pluie de minuit à minuit')
    : 'Cumul de pluie de minuit à minuit indisponible';
  const drop = equivalent ? '<span class="precipitation-equivalent">Éq. eau</span>'
    : available ? `<svg class="rain-drop" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8C9.5 6.4 6.8 9.7 6.8 13.2a5.2 5.2 0 0 0 10.4 0C17.2 9.7 14.5 6.4 12 2.8Z"/></svg>` : '';
  const unit = available && !trace ? 'mm' : '';
  return `<span class="rain-total${trace ? ' rain-total-trace' : ''}" title="${label}">
    ${drop}
    <span class="rain-reading" aria-label="${unit ? label + ' ' + value + ' mm' : label}"><span class="rain-amount${available && highlighted ? ' alert-value' : ''}">${value ?? '—'}</span>${unit || partial ? '<span class="rain-unit">' + unit + (partial ? '*' : '') + '</span>' : ''}</span>
    ${trend(rain, 2, 'rain', 'Tendance du cumul de pluie')}
    ${rainAlertMarkup(rainTone)}
  </span>`;
}

function dailySnowMarkup(day, total, dailyRainBars) {
  const amount = dailyRainBars(day, day.start, day.end, 'snowfall').reduce((sum, interval) => sum + interval.rain, 0);
  if (amount <= 0) return '';
  const partial = !total.completeRain || total.intervals.some(interval => interval.rain > 0 && !Number.isFinite(interval.snowfall));
  const label = 'Cumul de neige fraîche estimée de minuit à minuit' + (partial ? ' ; données partielles' : '');
  const value = temperature.format(amount) === '0' ? '&lt; 1' : temperature.format(amount);
  return `<span class="rain-reading snow-total" title="${label}" aria-label="${label} : ${value} cm"><span class="rain-amount">${value}</span><span class="rain-unit">cm${partial ? '*' : ''}</span></span>`;
}

function rainAlertMarkup(tone) {
  if (!tone) return '';
  const level = { yellow: 'jaune', orange: 'orange', red: 'rouge' }[tone];
  const description = `Alerte pluie du bulletin · niveau ${level}`;
  const mark = '<svg class="card-rain-alert-mark" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="currentColor"/><path d="M4.5 8h7M8 4.5v7" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>';
  return `<span class="card-rain-alert" data-level="${tone}" role="img" aria-label="${description}" title="${description}">${mark.repeat(tone === 'yellow' ? 2 : 3)}</span>`;
}

function temperatureMean(period) {
  if ("meanTemperature" in period) return period.meanTemperature;
  let duration = 0;
  let total = 0;
  for (const sample of period.samples) {
    if (!Number.isFinite(sample.temperature)) continue;
    const elapsed = Math.min(period.end, sample.intervalEnd) - Math.max(period.begin, sample.stamp);
    duration += elapsed;
    total += elapsed * sample.temperature;
  }
  return duration && duration >= period.end - period.begin ? total / duration : null;
}

function conditionPrecipitation(period, rainPictogramLevelForIntervals) {
  const liquid = period.liquidRain ?? period.intervals.reduce((sum, interval) =>
    sum + (interval.liquidRain ?? (interval.phase === 'rain' ? interval.rain : 0)), 0);
  const wetIntervals = period.intervals.filter(interval => interval.rain > 0);
  // A long model step can add several hours of traces to the same pictogram.
  const coarseTraces = wetIntervals.length > 0 && wetIntervals.every(interval => {
    const hours = (interval.nativeEnd - interval.nativeStart) / HOUR;
    return hours > 1 && rainIsTrace((interval.nativeLiquidRain ?? interval.nativeRain) / hours);
  });
  const snow = wetIntervals.some(interval => snowPhases.includes(interval.phase));
  const mixed = snow && liquid > 0;
  const freezing = wetIntervals.some(interval => interval.phase === 'freezing');
  const trace = !snow && period.phase === 'rain' && (rainIsTrace(liquid) || coarseTraces);
  const rain = !trace && liquid >= .01 ? rainPictogramLevelForIntervals(period.intervals) : 0;
  return { rain, trace, snow, mixed, freezing };
}

function conditionPictogram(period, { rainPictogramLevelForIntervals, mixedPrecipitationMarkup, notableGust }, night) {
  const { rain, trace, snow, mixed, freezing } = conditionPrecipitation(period, rainPictogramLevelForIntervals);
  const unclassifiedAmount = period.intervals.reduce((total, interval) =>
    total + (interval.phase === 'unknown' ? interval.rain : 0), 0);
  const unclassified = !rain && !trace && !snow && !freezing && unclassifiedAmount >= .01;
  const showTraces = trace || (unclassified && rainIsTrace(unclassifiedAmount));
  const dropLevel = unclassified && !showTraces
    ? rainPictogramLevelForIntervals(period.intervals, { includeUnclassified: true })
    : rain;
  const cloud = period.cloudCover ?? (period.rain > 0 ? 100 : null);
  const snowLevel = period.snowfall > 15 + 1e-9 ? 3 : period.snowfall > 5 + 1e-9 ? 2 : 1;
  const band = cloud == null ? -1 : Math.max(dropLevel ? 1 : 0, skyBand(cloud));
  const sky = band < 0 ? '' : image('vendor/weather-variants/cloud-' + (night ? 'night' : 'day') + '-' + band + '.svg');
  const layer = freezing ? 'pictogrammes/pluie-verglacante.svg'
    : snow ? 'pictogrammes/calque-neige-' + snowLevel + '.svg'
    : showTraces ? 'pictogrammes/calque-traces-pluie.svg' : dropLevel ? 'pictogrammes/calque-pluie-' + dropLevel + '.svg' : '';
  const weather = period.storm ? 'Orage possible' : freezing ? 'Pluie verglaçante'
    : snow ? (mixed ? 'Pluie et neige' : 'Neige') : trace ? 'Traces de pluie prévues' : rain ? 'Pluie' : band < 0 ? 'Indisponible' : skyLabels[band];
  const wind = period.windGust >= notableGust ? image('pictogrammes/calque-vent.svg', 'wind-layer') : '';
  const dry = period.completeRain && period.phase === 'dry' && !period.storm;
  const description = [weather, unclassified ? 'précipitations de nature indéterminée' : '', dry ? 'temps sec' : '', wind ? 'rafales' : ''].filter(Boolean).join(', ');
  const precipitation = mixed ? mixedPrecipitationMarkup(rain, snowLevel)
    : layer ? image(layer, dropLevel > 0 || showTraces ? 'rain-layer' : '') : '';
  const layers = (freezing ? '' : sky) + precipitation + (period.storm ? image('pictogrammes/calque-orage.svg') : '') + wind;
  return { description, layers };
}

function condition({ label, night, presentation: { description, layers, arrows, tone } }) {
  const title = night && label !== 'Nuit' ? 'Nuit, ' + description : description;
  const alert = tone ? ` data-period-alert="${tone}" role="group" aria-label="${label ? label + '. ' : ''}${alertLabels[tone]}"` : '';
  return `<div class="condition"${alert}>${label ? `<span class="period">${label}</span>` : ''}
    <span class="weather-summary">${layers ? `<span class="pictogram" role="img" aria-label="${title}" title="${title}">${layers}</span>` : '<span class="period">Indisponible</span>'}${arrows ? `<span class="weather-trends">${arrows}</span>` : ''}</span></div>`;
}

function temperaturesMarkup(min, max, arrows = '') {
  return `<div class="temperatures">
    <span class="temperature-values" role="group" aria-label="Température minimale ${formatTemp(min)}, maximale ${formatTemp(max)}"><span class="min" aria-hidden="true">${formatTemp(min)}</span><span class="temperature-divider" aria-hidden="true">/</span><span class="max" aria-hidden="true">${formatTemp(max)}</span></span>
    ${arrows}
  </div>`;
}

function dailySummaryCard(day, { today, tomorrow, dates, precipitationPhase, windSummaryMarkup, weatherCodeLabel }) {
  const { weekday, day: number, month } = Object.fromEntries(dates.formatToParts(Date.parse(day.date)).map(part => [part.type, part.value]));
  const dayLabel = day.date === today ? 'Aujourd’hui' : day.date === tomorrow ? 'Demain' : weekday;
  const liquidRain = Number.isFinite(day.rainSum) && Number.isFinite(day.showersSum) ? day.rainSum + day.showersSum : null;
  const phase = precipitationPhase({ rain: day.precipitationSum, weatherCode: day.weatherCode, liquidRain, snowfall: day.snowfallSum });
  const storm = [95, 96, 99].includes(day.weatherCode);
  const fog = [45, 48].includes(day.weatherCode);
  const sky = Number.isFinite(day.cloudCover) ? image('vendor/weather-variants/cloud-day-' + skyBand(day.cloudCover) + '.svg') : '';
  const layer = fog ? 'brouillard.svg' : phase === 'freezing' ? 'pluie-verglacante.svg' : phase === 'mixed' ? 'pluie-neige.svg'
    : snowPhases.includes(phase) ? 'calque-neige-1.svg' : rainIsTrace(liquidRain) ? 'calque-traces-pluie.svg'
    : liquidRain > 0 || phase === 'rain' ? 'calque-pluie-1.svg' : '';
  const label = storm ? 'Orage possible' : weatherCodeLabel(day.weatherCode);
  const rain = liquidRain == null ? '' : dailyRainMarkup({ completeRain: true, liquidRain }, [], false, '');
  const wind = windSummaryMarkup(null, day.windGustMax, {});
  const metricCount = 1 + [wind, rain].filter(Boolean).length;
  return `<li><article class="card card-summary" data-pictograms="1">
    <h2 class="card-heading"><time datetime="${day.date}"><span>${dayLabel}</span><small>${number} ${month}</small></time></h2>
    <div class="conditions"><div class="condition"><span class="period">Prévision du jour · Open-Meteo</span>
      <span class="weather-summary"><span class="pictogram" role="img" aria-label="${label}" title="${label}">${sky}${layer ? image('pictogrammes/' + layer) : ''}${storm ? image('pictogrammes/calque-orage.svg') : ''}</span></span>
    </div></div>
    <div class="card-metrics forecast-metrics card-metrics-${metricCount}">${temperaturesMarkup(day.temperatureMin, day.temperatureMax)}${wind}${rain ? '<div class="daily-precipitation-totals">' + rain + '</div>' : ''}</div>
  </article></li>`;
}

function card(day, options) {
  const { now, today, tomorrow, dates, localHour, clock, alertSources, history, forecastSlotAlertTone,
    dailyPeriodAlertSummaries, dailyPeriodSummary, dailyRainAlertTone, dailyRainBars } = options;
  const { weekday, day: number, month } = Object.fromEntries(dates.formatToParts(day.start).map(part => [part.type, part.value]));
  const dayLabel = day.date === today ? 'Aujourd’hui' : day.date === tomorrow ? 'Demain' : weekday;
  const leadDays = (Date.parse(day.date) - Date.parse(today)) / (24 * HOUR);
  const chartTitle = `${weekday.charAt(0).toLocaleUpperCase('fr-FR')}${weekday.slice(1)} ${number} ${month}`;
  const localHours = new Map(day.samples.map(sample => [
    Number(localHour.formatToParts(sample.stamp).find(part => part.type === 'hour').value), sample.stamp,
  ]));
  const at = hour => hour === 24 ? day.end : hour === 0 ? day.start : localHours.get(hour);
  const summarize = (row, start, end) => dailyPeriodSummary(row, start, end, Math.min(now, day.start));
  const periods = (start, end) => history.map(({ days, sources }) => ({
    period: days[day.date]?.[start + '-' + end], sources,
  }));
  const totals = summarize(day, day.start, day.end);
  const dailyHistory = periods(day.start, day.end);
  const meanTemperatures = comparableSeries(dailyHistory, period => period.sources.temperature, temperatureMean);
  const usesPiaf = day.chartRainIntervals?.some(interval => interval.source === 'PIAF'
    && interval.start < day.end && interval.end > day.start);
  const conditionsDay = usesPiaf ? { ...day, rainIntervals: day.chartRainIntervals } : day;
  const conditionsTotal = conditionsDay === day ? totals : summarize(conditionsDay, day.start, day.end);
  const daytime = summarize(conditionsDay, at(6), at(18));
  const alertWindows = [0, 6, 12, 18].map(hour => ({ start: at(hour), end: at(hour + 6), date: day.date }));
  const alertsBetween = (windows, start, end) => windows.flatMap(window => {
    const from = Math.max(start, window.start, now);
    const to = Math.min(end, window.end);
    return to > from ? dailyPeriodAlertSummaries(alertSources, window.date, from, to, now)
      .map(item => ({ ...item, wind: item.windSpeed, gust: item.windGust })) : [];
  });
  const alerts = alertsBetween(alertWindows, day.start, day.end);
  const selectedConditions = cardPeriods(day, {
    total: conditionsTotal, daytime, at, leadDays, clock, notableGust: options.notableGust,
    summarize: (start, end) => summarize(conditionsDay, start, end),
    describe: (period, night) => {
      const { start, end } = period;
      const localAlerts = start === day.start && end === day.end ? alerts : alertsBetween(alertWindows, start, end);
      return { ...conditionPictogram(period, options, night), arrows: weatherTrends(periods(start, end)),
        tone: forecastSlotAlertTone(localAlerts) };
    },
  });
  const conditions = selectedConditions.map(condition).join('');
  const dailyTone = dailyRainAlertTone(alertSources, day, now);
  const { tone, causes, rainTone } = forecastSlotAlertTone(alerts, dailyTone, true);
  const meanWind = totals.windSpeed ?? causes.wind;
  const visibleMeanWind = meanWind >= notableMeanWind || causes.wind ? meanWind : null;
  const wind = options.windSummaryMarkup(visibleMeanWind, totals.windGust ?? causes.gust, causes);
  const snow = dailySnowMarkup(day, totals, dailyRainBars);
  const rain = dailyRainMarkup(totals, dailyHistory, Boolean(dailyTone), rainTone);
  const metricCount = 1 + [wind, snow, rain].filter(Boolean).length;
  const metricsClass = metricCount === 3 && wind && Number.isFinite(visibleMeanWind)
    ? ' card-metrics-3-wide' : metricCount <= 3 ? ` card-metrics-${metricCount}` : '';
  const alert = tone ? ` data-alert="${tone}"${dailyTone ? ` data-daily-rain-alert="${dailyTone}"` : ''} aria-label="${dayLabel} ${number} ${month}. ${alertLabels[tone]}."` : '';
  return `<li><article class="card${selectedConditions.length > 1 ? ' card-transition' : ''}${day.trend ? ' card-outlook' : ''}" data-pictograms="${selectedConditions.length}"${alert}>
    <h2 class="card-heading">${day.trend ? '<span class="outlook-label"><span>Tendance</span></span>' : ''}<time datetime="${day.date}"><span>${dayLabel}</span><small>${number} ${month}</small></time></h2>
    <div class="conditions">${conditions}</div>
    <div class="card-metrics forecast-metrics${metricsClass}">
      ${temperaturesMarkup(totals.temperatureMin, totals.temperatureMax, trend(meanTemperatures, 1, 'temperature', 'Tendance de la température moyenne'))}
      ${wind}
      ${snow || rain ? `<div class="daily-precipitation-totals">${snow}${rain}</div>` : ''}
    </div>
    <button type="button" class="card-chart-hit" data-date="${day.date}" data-title="${chartTitle}" aria-haspopup="dialog" aria-label="Ouvrir le graphique du ${number} ${month}"></button>
  </article></li>`;
}


export function forecastRevision(days, { sources, now, timezone, dailyPeriodSummary }) {
  const current = { sources, days: {} };
  const localHour = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: timezone });
  for (const day of days) {
    const hours = new Map(day.samples.map(sample => [Number(localHour.format(sample.stamp)), sample.stamp]));
    hours.set(0, day.start);
    hours.set(24, day.end);
    const periods = current.days[day.date] = {};
    for (const [from, to] of [[0,24], [6,12], [12,18], [6,18], [18,24]]) {
      const start = hours.get(from), end = hours.get(to);
      if (start == null || end == null) continue;
      const period = dailyPeriodSummary(day, start, end, Math.min(now, day.start));
      periods[start + '-' + end] = {
        sources: period.sources, rainSources: period.rainSources, completeRain: period.completeRain,
        liquidRain: period.liquidRain, snowfall: period.snowfall, storm: period.storm, meanTemperature: temperatureMean(period)
      };
    }
  }
  return current;
}

function forecastHistory(days, { dashboard, week, now, timezone, siteId, dailyPeriodSummary }) {
  const datasets = { AROME: dashboard.arome, ARPEGE: week, 'Open-Meteo': dashboard.openMeteo };
  const sources = Object.fromEntries(Object.entries(datasets).flatMap(([name, data]) => {
    const runTime = data?.runTime ?? data?.fetchedAt;
    return runTime ? [[name, { runTime }]] : [];
  }));
  const current = forecastRevision(days, { sources, now, timezone, dailyPeriodSummary });
  const key = 'meteo-compact-history-' + siteId;
  let history = [];
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (Array.isArray(saved)) history = saved.filter(item => item?.days && item.sources);
  } catch {}
  const id = JSON.stringify(sources);
  // Replace an incomplete copy of the same model runs and keep recent revisions.
  history = [...history.filter(item => JSON.stringify(item.sources) !== id), current].slice(-8);
  try { localStorage.setItem(key, JSON.stringify(history)); } catch {}
  const published = Array.isArray(dashboard.forecastHistory) ? dashboard.forecastHistory : [];
  return [...history.slice(0, -1), ...published.filter(item => item?.days && item.sources), current];
}

export function compactCardsMarkup(days, options) {
  const { now, timezone, localDateKey, forecastDays = 16, dashboard } = options;
  const today = localDateKey(now, timezone);
  const tomorrow = new Date(Date.parse(today + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  const dates = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: timezone });
  const localHour = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', hourCycle: 'h23', timeZone: timezone });
  const clock = new Intl.DateTimeFormat('fr-FR', { hour: 'numeric', minute: '2-digit', timeZone: timezone });
  const history = forecastHistory(days, options);
  const cards = new Map(days.map(day => [day.date, card(day, { ...options, today, tomorrow, dates, localHour, clock, history })]));
  const limit = new Date(Date.parse(today) + forecastDays * 24 * HOUR).toISOString().slice(0, 10);
  const civilDates = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  for (const day of dashboard.openMeteo?.days || []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day?.date) || !Number.isFinite(Date.parse(day.date))
      || day.date < today || day.date >= limit || cards.has(day.date)) continue;
    cards.set(day.date, dailySummaryCard(day, { ...options, today, tomorrow, dates: civilDates }));
  }
  if (!cards.size) return '<p class="week-source-message">Prévisions en attente d’actualisation.</p>';
  return '<ul class="week">' + [...cards.keys()].sort().map(date => cards.get(date)).join('') + '</ul>';
}
