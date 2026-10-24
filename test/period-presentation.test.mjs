import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as dailyRowsTools from '../public/daily-rows.js';

const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const fn = name => {
  const start = script.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  const end = script.indexOf('\n}', start) + 2;
  return script.slice(start, end);
};
const constant = (name, multiline = false) => {
  const start = script.indexOf('const ' + name + ' =');
  assert.ok(start >= 0, name);
  const end = multiline ? script.indexOf('\n};', start) + 3 : script.indexOf('\n', start);
  return script.slice(start, end);
};
const local = name => {
  const start = script.indexOf('  const ' + name + ' =', script.indexOf('function renderTestingDailyForecast'));
  const end = script.indexOf('\n  };', start) + 5;
  return script.slice(start, end);
};
const functions = ['escapeText', 'backgroundTrendArrow', 'rainProbabilitySummary', 'weekRainBelowDisplayThreshold',
  'conciseRainSummary', 'cloudCoverBand', 'cloudCoverPresentation', 'conciseSkySummary', 'conciseWindSummary',
  'forecastPeriodSummaryText', 'forecastPeriodText', 'forecastSourceAlertTone', 'forecastSlotAlertTone', 'shortTermGustLabel', 'stormSignalPictogram',
  'weekWeightedValue', 'forecastPeriodAvailable', 'periodSourceDetails', 'forecastPeriodDetailsMarkup', 'forecastPeriodHighlights', 'dailyRowPeriodsMarkup'];
const code = [constant('rainPictogramStep'), constant('meanWindIntensityLevel', true), constant('gustIntensityLevel', true),
  constant('forecastPeriodOrder'), constant('cloudCoverLabels'), constant('periodMetricIcons', true),
  constant('periodMetricPictogram', true), constant('periodMetricRow'), ...functions.map(fn),
  local('periodCard')].join('\n');
const HOUR = 3600000, now = Date.parse('2026-10-24T00:00:00Z');
const slot = { key: 'morning', label: 'Matin', startHour: 2, endHour: 8, dayOffset: 0 };
function engine(dashboard = {}) {
  return runInNewContext(code + '\n({periodCard, dailyRowPeriodsMarkup, forecastPeriodDetailsMarkup, forecastPeriodHighlights, periodSourceDetails, forecastSlotAlertTone, rainProbabilitySummary})', {
    dailyRowsTools, appNow: () => now, latestForecastData: dashboard, rainRiskDisplayThreshold: 20,
    forecastDailySlots: [slot], forecastSlotTimeRange: () => ({ start: now, end: now + 6 * HOUR }),
    slotDateKey: date => date, forecastLocalDateTime: () => new Date(now + 6 * HOUR),
    forecastSlotMidpointDate: () => new Date(now + 3 * HOUR), displayIcon: () => '<img alt="météo"/>',
    weekStormRisk: () => ({ level: 3 }), vigilanceSlotIcons: () => '',
    format: (value, digits = 1) => value != null ? value.toLocaleString('fr-FR', { maximumFractionDigits: digits }) : '—'
  });
}
const panel = html => html.slice(html.indexOf('<div class="daily-period-details">'));

for (const scenario of [
  { name: 'sec et vent faible', rain: 0, probability: 0, cloudCover: 20, windSpeed: 10, windGust: 25, storm: false },
  { name: 'pluie probable et rafales', rain: 3, probability: 94, cloudCover: 100, windSpeed: 40, windGust: 65, storm: false },
  { name: 'averses', rain: 2, probability: 70, cloudCover: 90, windSpeed: 20, windGust: 35, storm: false, weatherCode: 81 },
  { name: 'orage violent', rain: 5, probability: 95, cloudCover: 100, windSpeed: 60, windGust: 85, storm: true, weatherCode: 96 },
  { name: 'orage et vent fort', rain: 6, probability: 95, cloudCover: 100, windSpeed: 60, windGust: 85, storm: true }
]) test('Carte et ligne quotidienne : détails identiques pour ' + scenario.name, () => {
  const hours = Array.from({ length: 25 }, (_, i) => ({ time: new Date(now + i * HOUR).toISOString(),
    temperature: 12, rain: scenario.rain, probability: scenario.probability, cloudCover: scenario.cloudCover,
    windSpeed: scenario.windSpeed, windGust: scenario.windGust, windDirection: 0,
    weatherCode: scenario.weatherCode ?? (scenario.storm ? 95 : scenario.rain ? 61 : 3) }));
  const dashboard = { openMeteo: { hours } };
  const day = dailyRowsTools.buildDailyRows({ dashboard, now })[0];
  const summary = dailyRowsTools.dailyPeriodSummary(day, now, now + 6 * HOUR, now);
  const e = engine(dashboard);
  const periodCard = e.periodCard({ temperatureMin: 12, temperatureMax: 12, precipitationSum: summary.rain,
    precipitationProbabilityMax: scenario.probability, cloudCover: summary.cloudCover, windSpeedMax: summary.windSpeed,
    windGustMax: summary.windGust, windDirection: 0, storm: scenario.storm, weatherCode: scenario.weatherCode ?? (scenario.storm ? 95 : scenario.rain ? 61 : 3),
    peakRain3h: scenario.rain * 3, rainTiming: summary.rainTiming, stormRainOverlap: scenario.storm && scenario.rain >= 5,
    stormRainWindOverlap: scenario.storm && scenario.rain >= 1 }, 'Matin', '', slot, day.date, day.date + ':morning');
  const dailyCard = e.dailyRowPeriodsMarkup(day, {}, dailyRowsTools.buildDailySourceRows({ dashboard, now }));
  assert.equal(panel(dailyCard), panel(periodCard));
  const notable = html => html.match(/<span class="daily-period-copy">(.*?)<\/span>/)?.[1] || '';
  assert.equal(notable(dailyCard), notable(periodCard));
  const alert = html => html.match(/daily-period-alert-(yellow|orange|red)/)?.[1] || '';
  assert.equal(alert(dailyCard), alert(periodCard));
  assert.equal(dailyCard.includes('daily-period-gust-volume'), periodCard.includes('daily-period-gust-volume'));
  assert.equal(dailyCard.includes('daily-hazard-symbol wind'), periodCard.includes('daily-hazard-symbol wind'));
  assert.equal(dailyCard.includes('daily-hazard-symbol storm'), periodCard.includes('daily-hazard-symbol storm'));
});

test('les seuils des rafales et les trois couleurs sont communs, sans mélange de modèles', () => {
  const e = engine();
  assert.equal(e.forecastPeriodHighlights({ gust: 49 }).gustVolume, '');
  assert.match(e.forecastPeriodHighlights({ gust: 50 }).gustVolume, /50 km\/h/);
  assert.equal(e.forecastPeriodHighlights({ gust: 54 }).hazardMarkup, '');
  assert.match(e.forecastPeriodHighlights({ gust: 55 }).hazardMarkup, /daily-hazard-symbol wind/);
  for (const [gust, color] of [[59, ''], [60, 'yellow'], [80, 'orange'], [100, 'red']])
    assert.equal(e.forecastSlotAlertTone([{ gust }]), color);
  assert.equal(e.forecastSlotAlertTone([{ probability: 95, rain: 1 }, { probability: 10, rain: 40 }]), '');
});

test('le survol commun conserve valeurs par source, probabilité et flèches sans dates', () => {
  const e = engine();
  const detail = e.periodSourceDetails([{ name: 'AROME', rain: 1.4, trends: { rain: '↗' } },
    { name: 'Open-Meteo', rain: 2.9, probability: 92, trends: { rain: '↘' } }], 'rain');
  assert.equal(detail.join('\n'), 'AROME : 1,4 mm ↗\nOpen-Meteo : 2,9 mm · 92 % ↘');
});
