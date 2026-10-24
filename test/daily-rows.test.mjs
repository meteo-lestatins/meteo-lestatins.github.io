import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyRows, dailyRainBars, dailyRainDisplayBars, dailyRainScale, dailyCurveSamples, dailyRowsMarkup, localDateKey, createDailyChartState, dailyChartMarkup, dailyChartSize, dailyHourlyWidth, dailyTimeAxis, dailySummarySample, dailyPeriodSummary, dailyDataUpdateStatus, dailyTimeGroups, piafChartMarkup, precipitationPhase } from '../public/daily-rows.js';
import { nativeSnowAmounts } from '../weather/precipitation.mjs';
import { createForecastCollectors } from '../weather/collectors.mjs';
import { prepareBasicForecast } from '../public/forecast-core.js';
import { collectOpenMeteo } from '../weather/open-meteo.mjs';
import { collectWeather } from '../scripts/collect-weather.mjs';
import { siteProfile } from './site-fixture.mjs';
import { mergeWeatherState, publicWeatherFiles, sourceDue } from '../weather/state.mjs';

const HOUR = 3600000;
const now = Date.parse('2026-10-20T22:00:00Z');
const stamp = Date.parse('2026-10-20T22:00:00Z');
const hour = (time, extra = {}) => ({ time: new Date(time).toISOString(), temperature: 12, rain: 1,
  cloudCover: 60, windSpeed: 10, windGust: 25, weatherCode: 3, ...extra });

test('neige native : équivalent eau conservé et cm explicitement estimés, sans température seuil', () => {
  assert.deepEqual(nativeSnowAmounts(3, 2), { liquidRain: 1, snowfall: 1.4, snowWaterEquivalent: 2, snowfallMethod: 'water-equivalent-0.7' });
  for (const value of [null, undefined, -1, 5, NaN]) assert.equal(nativeSnowAmounts(3, value).snowfall, null);
  assert.equal(nativeSnowAmounts(0, 0).snowfall, 0);
  assert.equal(precipitationPhase({ rain: 3, ...nativeSnowAmounts(3, 2), temperature: 6 }), 'mixed');
  assert.equal(precipitationPhase({ rain: 2, ...nativeSnowAmounts(2, 2), temperature: 3 }), 'snow');
  assert.equal(precipitationPhase({ rain: 1, temperature: -5 }), 'unknown');
  assert.equal(precipitationPhase({ rain: 1, weatherCode: 66 }), 'freezing');
});

test('Open-Meteo acquiert pluie liquide et cm séparés, avec absence distincte de zéro', async () => {
  let query;
  const result = await collectOpenMeteo(siteProfile(), { fetchImpl: async url => {
    query = url;
    return { ok: true, json: async () => ({ hourly: { time: [stamp / 1000, stamp / 1000 + 3600],
      temperature_2m: [2, -2], precipitation: [2, 1], rain: [.5, null], showers: [.2, 0], snowfall: [.91, null], weather_code: [73, 71] } }) };
  } });
  for (const field of ['rain', 'showers', 'snowfall']) assert.ok(query.searchParams.get('hourly').split(',').includes(field));
  assert.equal(result.hours[0].liquidRain, .7);
  assert.equal(result.hours[0].snowfall, .91);
  assert.equal(result.hours[0].rain, 2);
  assert.equal(result.hours[1].liquidRain, null);
  assert.equal(result.hours[1].snowfall, null);
});

test('un seul diagramme pluie/neige : mm équivalent eau pour la hauteur, cm pour la neige', () => {
  const quantities = [nativeSnowAmounts(1, 0), nativeSnowAmounts(1, 1), nativeSnowAmounts(1, .5)];
  const [day] = buildDailyRows({ now, dashboard: { openMeteo: { hours: quantities.map((q, i) => hour(stamp + (i + 10) * HOUR, { rain: 1, ...q })) } } });
  assert.deepEqual(day.samples.slice(9, 12).map(sample => sample.phase), ['rain', 'snow', 'mixed']);
  const groups = dailyRainDisplayBars(day, 1800);
  assert.equal(groups.length, 3, 'un regroupement ne mélange pas des phases différentes');
  const html = dailyChartMarkup(day, { width: 1800, iconMarkup: () => '<span class="test-cloud"></span>' });
  assert.equal((html.match(/class="day-combined-svg"/g) || []).length, 1);
  assert.equal((html.match(/class="day-combined-rain"/g) || []).length, 3);
  assert.ok(html.includes('calque-neige-'));
  assert.ok(html.includes('calque-pluie-neige.svg'));
  assert.ok(html.includes('>1 cm</text>'));
  assert.ok(html.includes('0,5 mm'));
  assert.ok(html.includes('&lt; 1 cm</tspan>'));
  assert.ok(!html.includes('≈'));
  assert.ok(html.includes('simultanéité non précisée'));
  assert.ok(html.includes('mm/h équiv. eau · cumuls mm / neige cm'));
  assert.ok(html.includes('pas une hauteur de neige au sol'));
  const heights = [...html.matchAll(/height="([^"]+)" class="day-combined-rain"/g)].map(match => +match[1]);
  assert.equal(new Set(heights).size, 1, 'même intensité eau => même hauteur pour pluie, neige et mélange');
  const summary = dailyRowsMarkup([day], { now });
  assert.ok(summary.includes('>1 cm (partiel)</strong>'));
  assert.ok(summary.includes('1,5 mm (partiel)'));
  for (const width of [160, 280, 1000, 1800]) {
    const rendered = dailyChartMarkup(day, { width });
    assert.ok(!rendered.includes('NaN'));
    assert.ok(rendered.includes('cm'));
    assert.equal(dailyChartSize(width, createDailyChartState(), day).height,
      dailyChartSize(width, createDailyChartState(), { ...day, rainIntervals: [] }).height);
  }
});

test('une trace neigeuse infime dans la pluie ne transforme pas le dimanche à 7 degrés en neige', () => {
  const total = 4.9814453125, snow = .0013671875, liquid = 4.9794921875;
  const sample = { rain: total, snowfall: snow, liquidRain: liquid, temperature: 7.2589 };
  assert.equal(precipitationPhase(sample), 'rain');
  assert.equal(precipitationPhase({ ...sample, snowfall: .1 }), 'mixed');
  assert.equal(precipitationPhase({ ...sample, liquidRain: 0 }), 'unknown');
  assert.equal(precipitationPhase({ ...sample, liquidRain: 0, snowfall: .1 }), 'snow');
  assert.equal(precipitationPhase({ ...sample, weatherCode: 73 }), 'mixed');
  const dashboard = { arome: { hours: [hour(stamp + HOUR, sample)] } };
  const [day] = buildDailyRows({ now, dashboard });
  assert.equal(dailySummarySample(day).phase, 'rain');
  for (const width of [280, 1800]) {
    const html = dailyRowsMarkup([day], { now, width });
    assert.ok(!html.includes('calque-neige-'));
    assert.ok(!html.includes('calque-pluie-neige'));
    assert.ok(!html.includes('class="day-snow-volume"'));
    assert.ok(!html.includes('class="chart-point day-combined-mixed"'));
    assert.ok(html.includes('Trace neigeuse infime'));
  }
  const short = piafChartMarkup({ rainSteps: [{ intervalStart: now, intervalEnd: now + HOUR, precipitation: total }] }, { now, dashboard });
  assert.ok(!short.includes('Neige AROME'));
  assert.ok(!short.includes('calque-pluie-neige'));
  assert.equal(dailyRainBars(day)[0].snowfall, snow, 'la donnée brute est conservée');
  assert.equal(dailyRainBars(day)[0].rain, total);
});

test('la neige est arrondie au cm sans signe environ ni mm neige, sans arrondir les données', () => {
  for (const [amount, label] of [[.35, '&lt; 1 cm'], [.5, '1 cm'], [1.49, '1 cm'], [1.5, '2 cm']]) {
    const [day] = buildDailyRows({ now, dashboard: { arome: { hours: [hour(stamp + 11 * HOUR,
      { rain: 2, liquidRain: 0, snowfall: amount })] } } });
    const html = dailyChartMarkup(day, { width: 1800 });
    const labels = [...html.matchAll(/<text class="day-rain-label"[^>]*>(.*?)<\/text>/g)].map(match => match[1]);
    assert.deepEqual(labels, [label]);
    const summary = dailyRowsMarkup([day], { now });
    assert.ok(summary.includes(`<strong>${label} (partiel)</strong>`));
    assert.ok(!summary.includes('≈'));
    assert.equal(dailyRainBars(day)[0].snowfall, amount);
  }
  const [unknown] = buildDailyRows({ now, dashboard: { arome: { hours: [hour(stamp + 11 * HOUR,
    { weatherCode: 73, liquidRain: null, snowfall: null })] } } });
  const html = dailyChartMarkup(unknown, { width: 1800 });
  assert.match(html, /class="day-rain-label"[^>]*>Neige<\/text>/);
  assert.ok(!html.includes('mm éq.'));
});

test('la trace neige seule du lundi ne déclenche pas un pictogramme neige ni un cumul en cm', () => {
  const data = { rain: .0015, liquidRain: 0, snowfall: .00105, temperature: 10 };
  const dashboard = { arome: { hours: [hour(stamp + 12 * HOUR, data)] } };
  const [day] = buildDailyRows({ now, dashboard });
  assert.equal(precipitationPhase(data), 'unknown');
  assert.equal(dailySummarySample(day).phase, 'unknown');
  const html = dailyRowsMarkup([day], { now });
  assert.ok(!html.includes('calque-neige-'));
  assert.ok(!html.includes('class="day-snow-volume"'));
  assert.ok(!html.includes('>gouttes</text>'));
  assert.ok(!html.includes('class="day-combined-rain"'));
  assert.equal(dailyRainBars(day)[0].snowfall, .00105);
  assert.equal(precipitationPhase({ ...data, snowfall: .35 }), 'snow');
  assert.equal(precipitationPhase({ ...data, weatherCode: 73 }), 'snow');
});

test('la neige suit la source des précipitations, conserve les fragments et ne devient jamais une quantité inventée', () => {
  const [day] = buildDailyRows({ now, dashboard: {
    arome: { hours: [hour(stamp + 11 * HOUR, { ...nativeSnowAmounts(1, 1) })] },
    openMeteo: { hours: [hour(stamp + 11 * HOUR, { rain: 99, snowfall: 99, liquidRain: 0 })] }
  }, week: { hours: [hour(stamp + 12 * HOUR, { rain: 6, ...nativeSnowAmounts(6, 3),
    rainIntervalStart: new Date(stamp + 9 * HOUR).toISOString(), rainIntervalEnd: new Date(stamp + 12 * HOUR).toISOString() })] } });
  const bars = dailyRainBars(day);
  assert.ok(Math.abs(bars.reduce((sum, bar) => sum + bar.snowfall, 0) - 2.1) < 1e-9);
  assert.ok(bars.every(bar => bar.snowfall < 99));
  assert.ok(bars.filter(bar => bar.source === 'ARPEGE').every(bar => bar.estimated));
  const [unknown] = buildDailyRows({ now, dashboard: { arome: { hours: [hour(stamp + 11 * HOUR, { weatherCode: 73, liquidRain: null, snowfall: null })] },
    openMeteo: { hours: [hour(stamp + 11 * HOUR, { rain: 99, snowfall: 99, liquidRain: 0 })] } } });
  assert.equal(unknown.samples[10].phase, 'snow');
  assert.equal(unknown.samples[10].snowfall, null);
  const rendered = dailyRowsMarkup([unknown], { now, iconMarkup: () => '<span></span>' });
  assert.ok(rendered.includes('calque-neige-'));
  assert.ok(!rendered.includes('class="day-snow-volume"'));
  assert.ok(rendered.includes('répartition pluie/neige inconnue'));
});

test('le résumé et les créneaux regroupés n’inventent pas un mélange à partir de pluie puis neige', () => {
  const [day] = buildDailyRows({ now, dashboard: { openMeteo: { hours: [
    hour(stamp + HOUR, { ...nativeSnowAmounts(1, 0) }), hour(stamp + 2 * HOUR, { ...nativeSnowAmounts(1, 1) })] } } });
  const html = dailyChartMarkup(day, { width: 160, iconMarkup: () => '<span></span>' });
  assert.ok(!html.includes('calque-pluie-neige.svg'));
  assert.ok(html.includes('selon les créneaux'));
  assert.equal(dailySummarySample(day).phase, 'rain');
});

test('les trois heures affichent une phase et un cumul neige sourcés sans convertir PIAF en cm', () => {
  const dashboard = { arome: { fetchedAt: now, hours: Array.from({ length: 5 }, (_, i) => hour(stamp + i * HOUR, { ...nativeSnowAmounts(1, 1) })) } };
  const html = piafChartMarkup({ rainSteps: [{ intervalStart: now, intervalEnd: now + 3 * HOUR, baseRainSource: 'piaf', precipitation: 90 }] },
    { now, dashboard, iconMarkup: () => '<span></span>' });
  assert.ok(html.includes('calque-neige-'));
  assert.ok(html.includes('Neige AROME 2 cm'));
  assert.ok(!html.includes('≈'));
  assert.ok(html.includes('90 mm'));
  assert.ok(!html.includes('63 cm'));
  assert.ok(html.includes('Précip. PIAF mm/h équiv. eau'));
});

test('la collecte AROME garde le même run et pas neige, une panne neige ne supprime pas la météo', async () => {
  const run = new Date(Math.floor(Date.now() / HOUR) * HOUR - HOUR);
  const runId = run.toISOString().slice(0, 19).replaceAll(':', '.') + 'Z';
  const prefixes = ['TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND', 'TOTAL_PRECIPITATION__GROUND_OR_WATER_SURFACE',
    'U_COMPONENT_OF_WIND__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND', 'V_COMPONENT_OF_WIND__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND',
    'WIND_SPEED_GUST__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND', 'TOTAL_CLOUD_COVER__GROUND_OR_WATER_SURFACE', 'TOTAL_SNOW_PRECIPITATION__GROUND_OR_WATER_SURFACE'];
  const ids = prefixes.map(prefix => prefix + '___' + runId + (prefix.includes('PRECIPITATION') ? '_PT1H' : ''));
  const snowRequests = [];
  const api = createForecastCollectors({ aromeWcs: 'https://example.test', mfText: async input => {
    const url = new URL(input), id = url.searchParams.get('coverageid') || '';
    if (url.pathname.endsWith('GetCapabilities')) return ids.map(id => `<wcs:CoverageId>${id}</wcs:CoverageId>`).join('');
    if (url.pathname.endsWith('DescribeCoverage')) return '<gmlrgrid:coefficients>' + Array.from({ length: 51 }, (_, i) => (i + 1) * 3600).join(' ') + '</gmlrgrid:coefficients>';
    let value = id.startsWith('TEMPERATURE') ? 273 : id.startsWith('TOTAL_PRECIPITATION') ? 3 : 1;
    if (id.startsWith('TOTAL_SNOW')) {
      snowRequests.push(id);
      if (url.searchParams.getAll('subset').includes('time(7200)')) throw Error('neige indisponible');
      value = 2;
    }
    return `<gml:tupleList>${value}</gml:tupleList>`;
  } });
  const result = await api.buildArome(44, 5, { done: 0 });
  assert.equal(result.hours.length, 48);
  assert.equal(result.hours[0].snowfall, 1.4);
  assert.equal(result.hours[0].liquidRain, 1);
  assert.equal(result.hours[1].snowfall, null);
  assert.equal(result.hours[1].rain, 3);
  assert.equal(new Set(snowRequests).size, 1);
  assert.ok(snowRequests.every(id => id.includes(runId) && id.endsWith('_PT1H')));
});

test('ARPEGE acquiert la neige PT3H du même run et conserve ses intervalles', async () => {
  const run = new Date(Math.floor(Date.now() / (3 * HOUR)) * 3 * HOUR);
  const runId = run.toISOString().slice(0, 19).replaceAll(':', '.') + 'Z';
  const ids = ['TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND', 'U_COMPONENT_OF_WIND__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND',
    'V_COMPONENT_OF_WIND__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND', 'WIND_SPEED_GUST__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND',
    'TOTAL_CLOUD_COVER__GROUND_OR_WATER_SURFACE', 'TOTAL_WATER_PRECIPITATION__GROUND_OR_WATER_SURFACE|P1D',
    'TOTAL_WATER_PRECIPITATION__GROUND_OR_WATER_SURFACE|PT3H', 'TOTAL_SNOW_PRECIPITATION__GROUND_OR_WATER_SURFACE|PT3H']
    .map(field => { const [prefix, suffix] = field.split('|'); return prefix + '___' + runId + (suffix ? '_' + suffix : ''); });
  const snowRequests = [];
  const api = createForecastCollectors({ arpegeWcs: 'https://example.test', mfText: async input => {
    const url = new URL(input), id = url.searchParams.get('coverageid') || '';
    if (url.pathname.endsWith('GetCapabilities')) return ids.map(id => `<wcs:CoverageId>${id}</wcs:CoverageId>`).join('');
    if (url.pathname.endsWith('DescribeCoverage')) return '<gmlrgrid:coefficients>' + Array.from({ length: 32 }, (_, i) => (i + 1) * 10800).join(' ') + '</gmlrgrid:coefficients>';
    let value = id.startsWith('TEMPERATURE') ? 273 : id.startsWith('TOTAL_WATER') ? 6 : 1;
    if (id.startsWith('TOTAL_SNOW')) { snowRequests.push(id); value = 3; }
    return `<gml:tupleList>${value}</gml:tupleList>`;
  } });
  const result = await api.buildArpegeDeterministic(44, 5, { done: 0 });
  assert.ok(result.hours.length > 20);
  for (const sample of result.hours) {
    const duration = Date.parse(sample.rainIntervalEnd) - Date.parse(sample.rainIntervalStart);
    assert.ok(Math.abs(sample.snowfall - 2.1 * duration / (3 * HOUR)) < 1e-9);
    assert.ok(Math.abs(sample.liquidRain - sample.rain / 2) < 1e-9);
  }
  assert.ok(snowRequests.every(id => id.includes(runId) && id.endsWith('_PT3H')));
});

test('la neige à minuit et au changement d’heure conserve ses cumuls, sans extrapolation dans les trous', () => {
  const start = Date.parse('2026-10-24T21:00:00Z'), end = start + 6 * HOUR;
  const native = hour(end, { rain: 6, ...nativeSnowAmounts(6, 6), rainIntervalStart: new Date(start).toISOString(), rainIntervalEnd: new Date(end).toISOString() });
  const days = buildDailyRows({ now: start - HOUR, week: { hours: [native] } });
  assert.equal(days.find(day => day.date === '2026-10-25').samples.length, 25);
  const sum = days.flatMap(day => dailyRainBars(day)).reduce((total, bar) => total + bar.snowfall, 0);
  assert.ok(Math.abs(sum - 4.2) < 1e-9);
  assert.ok(days.flatMap(day => day.samples).filter(sample => sample.stamp >= end).every(sample => sample.snowfall === null));
});

test('Open-Meteo est collecté sur 16 jours aux coordonnées du profil sans transmettre de jeton', async () => {
  let target, options;
  const profile = siteProfile();
  const result = await collectOpenMeteo(profile, { fetchImpl: async (url, opts) => {
    target = url; options = opts;
    return { ok: true, json: async () => ({ hourly: { time: [stamp / 1000], temperature_2m: [8], precipitation: [null], weather_code: [95] } }) };
  } });
  assert.equal(target.searchParams.get('forecast_days'), '16');
  assert.equal(target.searchParams.get('latitude'), String(profile.latitude));
  assert.equal(target.searchParams.get('longitude'), String(profile.longitude));
  assert.equal(target.searchParams.get('timeformat'), 'unixtime');
  assert.equal(target.searchParams.get('models'), null, 'sélection automatique pour atteindre 16 jours');
  assert.equal(target.searchParams.get('temporal_resolution'), 'hourly');
  assert.equal(target.searchParams.get('cell_selection'), 'land');
  assert.equal(result.rainResolution, 'hourly-interpolated');
  assert.equal(result.location.requestedLatitude, profile.latitude);
  assert.equal(result.location.elevation, null, 'ne pas inventer une altitude absente de la réponse');
  assert.equal(options.headers, undefined);
  assert.equal(result.hours[0].rain, null);
  assert.equal(result.hours[0].time, new Date(stamp).toISOString());
  await assert.rejects(collectOpenMeteo(profile, { fetchImpl: async () => ({ ok: false, status: 429 }) }), /HTTP 429/);
  await assert.rejects(collectOpenMeteo(profile, { fetchImpl: async () => ({ ok: true, json: async () => ({ hourly: {} }) }) }), /absentes/);
});

test('les 16 dates et le changement d’heure conservent les 25 heures du 25 octobre', () => {
  const hours = Array.from({ length: 16 * 24 + 2 }, (_, i) => hour(stamp + i * HOUR));
  const days = buildDailyRows({ dashboard: { openMeteo: { hours } }, now });
  assert.equal(days.length, 16);
  assert.equal(days[0].date, '2026-10-21');
  assert.equal(days.at(-1).date, '2026-11-05');
  const change = days.find(day => day.date === '2026-10-25');
  assert.equal(change.samples.length, 25);
  assert.equal(change.samples.reduce((sum, sample) => sum + sample.rain, 0), 25);
  assert.ok(change.samples.every(sample => localDateKey(sample.stamp) === change.date));
});

test('la collecte conserve l’altitude cible et la maille renvoyées sans les confondre avec le point demandé', async () => {
  const profile = siteProfile();
  const result = await collectOpenMeteo(profile, { fetchImpl: async () => ({ ok: true, json: async () => ({
    latitude: 48.85, longitude: 2.35, elevation: 40,
    hourly: { time: [stamp / 1000], temperature_2m: [8], precipitation: [.1] } }) }) });
  assert.deepEqual(result.location, { requestedLatitude: profile.latitude, requestedLongitude: profile.longitude,
    gridLatitude: 48.85, gridLongitude: 2.35, elevation: 40 });
});

test('AROME puis ARPEGE ont priorité ; un champ absent est complété par Open-Meteo', () => {
  const dashboard = { arome: { hours: [hour(stamp, { temperature: 4, cloudCover: null, stormSignal: true }), hour(stamp + HOUR, { rain: 3 })] },
    openMeteo: { hours: Array.from({ length: 25 }, (_, i) => hour(stamp + i * HOUR, { temperature: 18 })) } };
  const week = { hours: [hour(stamp, { temperature: 8, cloudCover: null }), hour(stamp + 3 * HOUR, {
    temperature: 11, cloudCover: null, rain: 9, rainIntervalStart: new Date(stamp).toISOString(), rainIntervalEnd: new Date(stamp + 3 * HOUR).toISOString() })] };
  const [day] = buildDailyRows({ dashboard, week, now });
  assert.equal(day.samples[0].temperature, 4);
  assert.equal(day.samples[0].sources.temperature, 'AROME');
  assert.equal(day.samples[0].cloudCover, 60);
  assert.equal(day.samples[0].sources.cloudCover, 'Open-Meteo');
  assert.equal(day.samples[0].rain, 3, 'les pluies AROME et ARPEGE ne sont pas additionnées');
  assert.equal(day.samples[2].rain, 3, 'répartition interne pour les cumuls, pas pour les barres affichées');
  assert.equal(day.samples[2].sources.rain, 'ARPEGE');
  assert.equal(day.samples[2].temperature, 10, 'interpolation entre points ARPEGE');
  assert.equal(day.samples[5].temperature, 18);
  assert.equal(day.samples[0].storm, 1);
  const bars = dailyRainBars(day);
  assert.deepEqual(bars.slice(0, 2).map(bar => [bar.source, bar.rain, (bar.end - bar.start) / HOUR, bar.estimated]),
    [['AROME', 3, 1, false], ['ARPEGE', 6, 2, true]]);
  assert.equal(bars[1].nativeRain, 9);
  assert.ok(dailyChartMarkup(day).includes('part estimée au prorata'));
});

test('les intervalles acquis sont conservés ; seuls les cumuls affichés sont regroupés si la place manque', () => {
  const hours = Array.from({ length: 9 }, (_, i) => hour(stamp + i * 3 * HOUR, {
    rain: 9, rainIntervalStart: new Date(stamp + (i - 1) * 3 * HOUR).toISOString(), rainIntervalEnd: new Date(stamp + i * 3 * HOUR).toISOString() }));
  const [day] = buildDailyRows({ week: { hours }, now });
  const bars = dailyRainBars(day);
  assert.equal(bars.length, 8);
  assert.ok(bars.every(bar => bar.rain === 9 && bar.end - bar.start === 3 * HOUR && !bar.estimated));
  for (const width of [280, 1000, 1800]) {
    const html = dailyChartMarkup(day, { width });
    assert.equal((html.match(/class="day-combined-rain"/g) || []).length, dailyRainDisplayBars(day, width).length);
    assert.equal(dailyRainDisplayBars(day, width).reduce((sum, bar) => sum + bar.rain, 0), 72);
    assert.ok(html.includes('Cumul source : 9 mm sur 3 h'));
    assert.ok(html.includes('mm/h équiv. eau · cumuls mm'));
    assert.ok(!html.includes('>3</text>'));
  }
  const hourly = buildDailyRows({ now, dashboard: { openMeteo: { hours: Array.from({ length: 25 }, (_, i) => hour(stamp + i * HOUR)) } } })[0];
  assert.equal(dailyRainBars(hourly).length, 24, 'des cumuls horaires identiques restent des intervalles distincts');
});

test('les trous de pluie restent inconnus et les chevauchements ne doublent pas les cumuls', () => {
  const interval = (start, end, rain) => hour(end, { rain, rainIntervalStart: new Date(start).toISOString(), rainIntervalEnd: new Date(end).toISOString() });
  const [day] = buildDailyRows({ now, week: { hours: [interval(stamp, stamp + 3 * HOUR, 9), interval(stamp, stamp + 3 * HOUR, 9),
    interval(stamp + 4 * HOUR, stamp + 7 * HOUR, 6)] } });
  assert.equal(dailyRainBars(day).length, 2);
  assert.equal(day.samples[3].rain, null);
  assert.equal(dailyRainBars(day).reduce((sum, bar) => sum + bar.rain, 0), 15);
});

test('Open-Meteo est agrégé par périodes UTC de 3 h, sans déduire le pas natif des valeurs répétées', () => {
  const start = Date.parse('2026-10-21T06:00:00Z');
  const hours = Array.from({ length: 6 }, (_, i) => hour(start + (i + 1) * HOUR, { rain: [.1, .2, .3, .4, .4, .4][i] }));
  const [day] = buildDailyRows({ now, dashboard: { openMeteo: { hours } } });
  const bars = dailyRainDisplayBars(day, 1800);
  assert.equal(bars.length, 2);
  assert.ok(bars.every(bar => bar.end - bar.start === 3 * HOUR && bar.components.length === 3 && bar.interpolated));
  assert.ok(Math.abs(bars[0].rain - .6) < 1e-10, 'les valeurs différentes sont aussi agrégées');
  assert.ok(Math.abs(bars[1].rain - 1.2) < 1e-10);
  const html = dailyChartMarkup(day, { width: 1800 });
  assert.ok(html.includes('pas natif non communiqué'));
  assert.ok(html.includes('Cumul API horaire'));
  assert.ok(!html.includes('Pluie Open-Meteo agrégée'), 'les détails techniques restent en infobulle');
  const [missing] = buildDailyRows({ now, dashboard: { openMeteo: { hours: hours.filter((_, i) => i !== 1) } } });
  const sparse = dailyRainDisplayBars(missing, 1800);
  assert.ok(sparse.every(bar => !(bar.start < start + 2 * HOUR && bar.end > start + HOUR)), 'aucun regroupement ne traverse un trou');
});

test('zéro sans barre, gouttes au niveau minimal et pluie chiffrée au-dessus', () => {
  const fixture = rain => buildDailyRows({ now, week: { hours: [hour(stamp + 12 * HOUR, { rain })] } })[0];
  for (const width of [160, 280, 1000, 1800]) {
    for (const amount of [0, .0001, .005, .0099, .01, .03, .099, .1, 1]) {
      const html = dailyChartMarkup(fixture(amount), { width });
      const bars = (html.match(/class="day-combined-rain"/g) || []).length;
      assert.equal(bars, amount >= .01 ? 1 : 0);
      assert.equal((html.match(/class="day-rain-label"/g) || []).length, bars);
      const labels = [...html.matchAll(/class="day-rain-label"[^>]*>([^<]*)<\/text>/g)].map(match => match[1]);
      assert.equal(labels.some(label => label.startsWith('gouttes')), amount >= .01 && amount < .1);
      assert.ok(labels.every(label => !label.includes('/') && !label.includes(' h')));
      assert.ok(!html.includes('class="day-rain-trace"'));
      const heights = [...html.matchAll(/height="([^"]+)" class="day-combined-rain"/g)].map(match => Number(match[1]));
      assert.ok(heights.every(height => Math.abs(height - (amount < .1 ? 5 : 5 + amount / 10 * 67)) < 1e-9));
      if (amount >= .01 && amount < .1) assert.ok(html.includes('repère fixe de 5 px'));
      assert.equal(dailyRainBars(fixture(amount))[0].rain, amount, 'le seuil est uniquement visuel');
      if (amount > 0) assert.ok(!html.includes('Intensité moyenne : 0 mm/h'));
    }
  }
});

test('les gouttes sont toujours sous les pluies chiffrées, qui progressent linéairement au-dessus', () => {
  const fixture = rain => buildDailyRows({ now, week: { hours: [hour(stamp + 12 * HOUR, { rain })] } })[0];
  const height = html => Number(html.match(/height="([^"]+)" class="day-combined-rain"/)[1]);
  for (const width of [280, 1800]) {
    for (const rainScale of [10, 20, 50]) {
      const options = { width, rainScale };
      assert.equal(height(dailyChartMarkup(fixture(.03), options)), 5);
      assert.equal(height(dailyChartMarkup(fixture(.099), options)), 5);
      for (const amount of [.1, .3, .9, 1, 1.9]) {
        const html = dailyChartMarkup(fixture(amount), options);
        assert.ok(height(html) > height(dailyChartMarkup(fixture(.099), options)));
        assert.ok(Math.abs(height(html) - 5 - amount / rainScale * 67) < 1e-9);
        assert.ok(!html.includes('Hauteur minimale'));
      }
      assert.ok(Math.abs((height(dailyChartMarkup(fixture(.9), options)) - 5) / (height(dailyChartMarkup(fixture(.3), options)) - 5) - 3) < 1e-9);
    }
  }
});

test('une échelle commune compare les intensités, pas des cumuls de durées différentes', () => {
  const fixture = duration => buildDailyRows({ now, week: { hours: [hour(stamp + 12 * HOUR, { rain: 3,
    rainIntervalStart: new Date(stamp + (12 - duration) * HOUR).toISOString(), rainIntervalEnd: new Date(stamp + 12 * HOUR).toISOString() })] } })[0];
  const hourly = fixture(1), threeHours = fixture(3), scale = dailyRainScale([hourly, threeHours]);
  assert.equal(scale, 10);
  const height = html => Number(html.match(/height="([^"]+)" class="day-combined-rain"/)[1]);
  for (const viewportWidth of [280, 1000, 1800]) {
    const options = { width: 1800, viewportWidth, rainScale: scale };
    const one = dailyChartMarkup(hourly, options), three = dailyChartMarkup(threeHours, options);
    assert.ok(Math.abs((height(one) - 5) / (height(three) - 5) - 3) < 1e-9);
    assert.ok(one.includes('Précip. 0–10 mm/h'));
    assert.ok(three.includes('Intensité moyenne : 1 mm/h'));
  }
});

test('régression capture : gouttes sous 0,22, 0,82 et 0,85 mm sur le même graphique', () => {
  const amounts = [.03, .05, .82, .85, .22];
  const hours = amounts.map((rain, index) => hour(stamp + (index * 4 + 3) * HOUR, { rain,
    rainIntervalStart: new Date(stamp + index * 4 * HOUR).toISOString(),
    rainIntervalEnd: new Date(stamp + (index * 4 + 3) * HOUR).toISOString() }));
  const [day] = buildDailyRows({ now, week: { hours } });
  for (const width of [280, 800, 1800]) {
    for (const rainScale of [10, 50]) {
      const html = dailyChartMarkup(day, { width, rainScale });
      const bars = [...html.matchAll(/data-rain-amount="([^"]+)" data-rain-rate="([^"]+)" data-rain-hours="([^"]+)"[^>]*><rect[^>]*height="([^"]+)" class="day-combined-rain"/g)]
        .map(match => ({ amount: Number(match[1]), rate: Number(match[2]), height: Number(match[4]) }));
      assert.equal(bars.length, amounts.length);
      const traces = bars.filter(bar => bar.amount < .1), quantified = bars.filter(bar => bar.amount >= .1);
      assert.ok(traces.length && quantified.length);
      assert.ok(Math.max(...traces.map(bar => bar.height)) < Math.min(...quantified.map(bar => bar.height)));
      quantified.sort((a, b) => a.rate - b.rate);
      for (let index = 1; index < quantified.length; index++) {
        assert.ok(quantified[index].height > quantified[index - 1].height, 'les quantités différentes ne sont pas aplaties');
      }
    }
  }
});

test('l’échelle quotidienne garde 1 mm/h modeste et s’étend pour les fortes précipitations', () => {
  const fixture = rain => buildDailyRows({ now, week: { hours: [hour(stamp + 12 * HOUR, { rain })] } })[0];
  for (const amount of [0, .1, 1, 9, 10, 11, 30, 100]) {
    const day = fixture(amount), scale = dailyRainScale([day]);
    assert.ok(scale >= 10 && scale >= amount);
    if (amount <= 10) assert.equal(scale, 10);
    if (amount === 1) {
      const html = dailyChartMarkup(day);
      assert.ok(Math.abs(Number(html.match(/height="([^"]+)" class="day-combined-rain"/)[1]) - 11.7) < 1e-9);
    }
  }
});

test('les valeurs de pluie portent mm seulement si la barre offre la place, sans changer les données', () => {
  const [day] = buildDailyRows({ now, week: { hours: [hour(stamp + 12 * HOUR, { rain: 1 })] } });
  const label = width => [...dailyChartMarkup(day, { width }).matchAll(/class="day-rain-label"[^>]*>([^<]*)<\/text>/g)].map(match => match[1]);
  assert.deepEqual(label(1800), ['1 mm']);
  assert.deepEqual(label(280), ['1']);
  assert.equal(dailyRainDisplayBars(day, 1800).length, dailyRainDisplayBars(day, 280).length, 'ne pas regrouper uniquement pour ajouter une unité');
  assert.equal(dailyRainBars(day)[0].rain, 1);
});

test('les transitions et marges gardent chaque point temporel, sans raccourci entre pictogrammes', () => {
  const hours = Array.from({ length: 73 }, (_, i) => hour(stamp + (i - 24) * HOUR, { temperature: i === 22 || i === 44 ? 30 : i / 2 }));
  const [day] = buildDailyRows({ now, dashboard: { openMeteo: { hours } },
    sunTimesForDate: () => ({ sunrise: new Date(stamp + 8.4 * HOUR), sunset: new Date(stamp + 17.6 * HOUR) }) });
  for (const width of [160, 280, 1000, 1800]) {
    const samples = dailyCurveSamples(day, width), axis = dailyTimeAxis(day, width);
    const stamps = new Set(samples.map(sample => sample.stamp));
    for (const acquired of [...day.contextBefore, ...day.samples, day.boundary, ...day.contextAfter]) {
      if (acquired.stamp >= axis.timeAt(0) && acquired.stamp <= axis.timeAt(width)) {
        assert.ok(stamps.has(acquired.stamp), 'point intermédiaire conservé, même dans les marges comprimées');
        assert.equal(samples.find(sample => sample.stamp === acquired.stamp).temperature, acquired.temperature);
      }
    }
    for (const time of [day.sunrise, day.sunset]) {
      const before = day.samples.findLast(sample => sample.stamp <= time), after = day.samples.find(sample => sample.stamp > time);
      const expected = before.temperature + (after.temperature - before.temperature) * (time - before.stamp) / HOUR;
      assert.equal(samples.find(sample => sample.stamp === time).temperature, expected, 'interpolation dans le temps réel, pas dans les pixels');
    }
    assert.ok(dailyTimeGroups(day, width).groups.length < samples.length);
  }
  const broken = { ...day, samples: day.samples.map(sample => sample.stamp === stamp + 8 * HOUR ? { ...sample, temperature: null } : sample) };
  assert.equal(dailyCurveSamples(broken, 1000).find(sample => sample.stamp === day.sunrise).temperature, null, 'ne pas interpoler à travers une valeur inconnue');
});

test('l’axe comprimé reste réversible et sa vitesse est continue à chaque transition', () => {
  const [day] = buildDailyRows({ now, dashboard: { openMeteo: { hours: Array.from({ length: 49 }, (_, i) => hour(stamp + (i - 12) * HOUR)) } },
    sunTimesForDate: () => ({ sunrise: new Date(stamp + 8.4 * HOUR), sunset: new Date(stamp + 17.6 * HOUR) }) });
  for (const width of [160, 280, 390, 1000, 1800]) {
    const axis = dailyTimeAxis(day, width), groups = dailyTimeGroups(day, width).groups;
    let previous = -Infinity;
    for (let time = day.start - 3 * HOUR; time <= day.end + 3 * HOUR; time += HOUR / 12) {
      const x = axis.xStamp(time);
      assert.ok(x > previous, 'aucun repli ni dépassement temporel');
      assert.ok(Math.abs(axis.timeAt(x) - time) < 1);
      assert.ok(axis.millisecondsPerPixel(x) > 0);
      previous = x;
    }
    for (const group of groups) {
      const x = axis.xStamp(group.start), left = axis.millisecondsPerPixel(x - .0001), right = axis.millisecondsPerPixel(x + .0001);
      assert.ok(Math.abs(left - right) / Math.max(left, right) < .0001, 'pas de changement brutal d’échelle');
    }
  }
});

test('les courbes de Bézier suivent exactement les valeurs temporelles, sans fausse cassure ni dépassement', () => {
  const hours = Array.from({ length: 73 }, (_, i) => hour(stamp + (i - 24) * HOUR, { temperature: i - 24, cloudCover: i === 35 ? null : 50 }));
  const [day] = buildDailyRows({ now, dashboard: { openMeteo: { hours } },
    sunTimesForDate: () => ({ sunrise: new Date(stamp + 8.4 * HOUR), sunset: new Date(stamp + 17.6 * HOUR) }) });
  for (const width of [280, 1000, 1800]) {
    const axis = dailyTimeAxis(day, width), html = dailyChartMarkup(day, { width });
    const temperature = html.slice(html.indexOf('<g class="day-combined-layer metric-layer metric-layer-temperature"'), html.indexOf('</svg>'));
    const curves = [...temperature.matchAll(/class="day-combined-line" d="M([^,]+),([^ ]+) C([^,]+),([^ ]+) ([^,]+),([^ ]+) ([^,]+),([^"]+)"/g)].map(match => match.slice(1).map(Number));
    assert.ok(curves.length >= 24);
    for (const [x0, y0, c1x, c1y, c2x, c2y, x1, y1] of curves) {
      assert.ok(Math.abs(c1x - x0 - (x1 - x0) / 3) < 1e-8);
      assert.ok(Math.abs(x1 - c2x - (x1 - x0) / 3) < 1e-8);
      for (const u of [.1, .25, .5, .75, .9]) {
        const time = axis.timeAt(x0 + u * (x1 - x0));
        const expected = y0 + (y1 - y0) * (time - axis.timeAt(x0)) / (axis.timeAt(x1) - axis.timeAt(x0));
        const actual = (1 - u) ** 3 * y0 + 3 * (1 - u) ** 2 * u * c1y + 3 * (1 - u) * u ** 2 * c2y + u ** 3 * y1;
        assert.ok(Math.abs(expected - actual) < 1e-4, 'projection exacte entre deux valeurs horaires');
        assert.ok(actual >= Math.min(y0, y1) - 1e-5 && actual <= Math.max(y0, y1) + 1e-5);
      }
    }
    for (let i = 1; i < curves.length; i++) {
      const left = curves[i - 1], right = curves[i];
      const leftSlope = (left[7] - left[5]) / (left[6] - left[4]);
      const rightSlope = (right[3] - right[1]) / (right[2] - right[0]);
      assert.ok(Math.abs(leftSlope - rightSlope) < 1e-5, 'une température régulière ne présente aucune cassure artificielle');
    }
    assert.equal((html.match(/<path class="cloud-cover-overlay"/g) || []).length, 2, 'le fond nuageux suit le même axe sans combler les trous');
  }
});

test('un cumul ARPEGE à cheval sur minuit est réparti sans perte ni double comptage', () => {
  const end = Date.parse('2026-10-21T23:00:00Z'); // 1 h le 22, heure locale
  const week = { hours: [hour(end, { rain: 12, rainIntervalStart: new Date(end - 3 * HOUR).toISOString(), rainIntervalEnd: new Date(end).toISOString() })] };
  const days = buildDailyRows({ week, now });
  const rains = days.map(day => day.samples.filter(sample => sample.stamp >= end - 3 * HOUR && sample.stamp < end).reduce((sum, sample) => sum + (sample.rain || 0), 0));
  assert.deepEqual(rains, [8, 4]);
  const bars = days.flatMap(day => dailyRainBars(day).filter(bar => bar.nativeRain === 12));
  assert.deepEqual(bars.map(bar => bar.rain), [8, 4]);
  assert.ok(bars.every(bar => bar.estimated && bar.nativeRain === 12));
  const html = dailyRowsMarkup(days, { now });
  assert.ok(html.includes('8 mm* (partiel)'));
  assert.ok(html.includes('4 mm* (partiel)'));
});

test('un changement de source au milieu d’un intervalle conserve les deux fragments et leur estimation', () => {
  const [day] = buildDailyRows({ now, dashboard: { arome: { hours: [hour(stamp + 2 * HOUR, { rain: 1 })] } },
    week: { hours: [hour(stamp + 3 * HOUR, { rain: 9, rainIntervalStart: new Date(stamp).toISOString(), rainIntervalEnd: new Date(stamp + 3 * HOUR).toISOString() })] } });
  assert.deepEqual(dailyRainBars(day).map(bar => [bar.source, bar.rain, bar.estimated]),
    [['ARPEGE', 3, true], ['AROME', 1, false], ['ARPEGE', 3, true]]);
  assert.equal(dailyRainBars(day).reduce((sum, bar) => sum + bar.rain, 0), 7);
});

test('les valeurs inconnues et le signal orageux ne deviennent ni zéro ni pourcentage inventé', () => {
  const days = buildDailyRows({ dashboard: { openMeteo: { hours: [hour(stamp, { rain: null, cloudCover: null, weatherCode: 95 })] } }, now });
  assert.equal(days[0].samples[0].rain, null);
  assert.equal(days[0].samples[0].storm, 1);
  assert.equal(days[0].samples[3].storm, null);
  const html = dailyRowsMarkup(days, { now });
  assert.ok(html.includes('Orage possible'));
  assert.ok(!html.includes('data-day-layer="storm"'));
  assert.ok(!html.includes('Risque orageux'));
  assert.ok(html.includes('(partiel)'));
  assert.ok(!html.includes('NaN'));
  assert.ok(!html.includes('undefined'));
  assert.equal((html.match(/class="day-combined-svg"/g) || []).length, 1);
  assert.equal(buildDailyRows({ now }).length, 0);
});

test('une seule frise superpose température et pluie par défaut, avec horaires et pictogrammes dans un en-tête fixe', () => {
  const state = createDailyChartState();
  assert.deepEqual(Object.keys(state.opacities).filter(key => state.opacities[key] > 0), ['temperature', 'rain']);
  const [day] = buildDailyRows({ dashboard: { openMeteo: { hours: Array.from({ length: 25 }, (_, i) => hour(stamp + i * HOUR)) } }, now });
  const html = dailyChartMarkup(day, { state, iconMarkup: () => '<img src="weather-test.svg" alt="Ciel">' });
  assert.equal((html.match(/class="day-combined-svg"/g) || []).length, 1);
  assert.equal((html.match(/src="weather-test.svg"/g) || []).length, dailyTimeGroups(day, 1000).groups.length);
  assert.ok(html.includes('class="day-timeline-header"'));
  assert.equal((html.match(/class="day-timeline-slot"/g) || []).length, dailyTimeGroups(day, 1000).groups.length);
  assert.ok(!html.includes('day-on-curve'));
  const header = html.slice(html.indexOf('<div class="day-timeline-header">'), html.indexOf('<p class="day-time-resolution">'));
  state.opacities.temperature = 0;
  state.offsets.temperature = -40;
  const hiddenTemperature = dailyChartMarkup(day, { state, iconMarkup: () => '<img src="weather-test.svg" alt="Ciel">' });
  assert.equal(hiddenTemperature.slice(hiddenTemperature.indexOf('<div class="day-timeline-header">'), hiddenTemperature.indexOf('<p class="day-time-resolution">')), header);
  assert.match(header, /class="day-timeline-slot"[^>]*><time[^>]*>00h<\/time><span class="weather-icon"[^>]*>/);
  for (const key of ['wind', 'gust', 'cloudiness']) {
    assert.ok(html.includes(`data-day-layer="${key}" style="display:none;" aria-hidden="true"`), key);
  }
  const second = createDailyChartState();
  state.opacities.wind = 60;
  state.offsets.temperature = -40;
  state.showHourly = true;
  assert.equal(second.showHourly, false, 'les jours ont leurs réglages indépendants');
  assert.equal(second.opacities.wind, 0);
  const enlarged = dailyChartMarkup(day, { state, width: 2000, viewportWidth: 1000 });
  assert.ok(enlarged.includes('height:260px'));
  assert.ok(enlarged.includes('data-day-layer="wind" style="" aria-hidden="false"'));
});

test('l’orage est intégré au pictogramme du créneau concerné, sans commande ni courbe dédiée', () => {
  const [day] = buildDailyRows({ dashboard: { openMeteo: { hours: Array.from({ length: 25 }, (_, i) => hour(stamp + i * HOUR, { weatherCode: i === 5 ? 95 : 3, cloudCover: null, rain: 0 })) } }, now });
  const renderedIcons = [];
  const html = dailyChartMarkup(day, { width: 280, iconMarkup: sample => { renderedIcons.push(sample); return '<span class="test-cloud">Nuage</span>'; } });
  assert.equal((html.match(/class="day-weather-storm"/g) || []).length, 1);
  assert.match(html, /class="weather-icon"[^>]* role="img" aria-label="Orage possible">.*class="test-cloud">Nuage<\/span><img class="day-weather-storm"/);
  assert.equal(renderedIcons.length, 1, 'un orage reste représenté même si la nébulosité est absente');
  assert.equal(renderedIcons[0].stormSignal, true, 'le signal d’une heure du créneau est conservé');
  assert.ok(!html.includes('metric-layer-storm'));
  assert.ok(!('storm' in createDailyChartState().opacities));
  const dry = { ...day, samples: day.samples.map(sample => ({ ...sample, storm: 0 })) };
  assert.ok(!dailyChartMarkup(dry).includes('class="day-weather-storm"'));
});

test('le fondu jour/nuit conserve ses couleurs horaires et ses références propres à chaque jour, même sur mobile', () => {
  const days = buildDailyRows({ dashboard: { openMeteo: { hours: Array.from({ length: 49 }, (_, i) => hour(stamp + i * HOUR)) } }, now });
  const backgroundForTime = time => `rgb(${Math.floor((time - stamp) / HOUR + 1e-6)},100,150)`;
  const render = width => dailyChartMarkup(days[0], { width, backgroundForTime });
  const wide = render(1400), mobile = render(280);
  const stops = html => [...html.matchAll(/<stop offset="([^"]+)" stop-color="([^"]+)"\/>/g)].map(match => match.slice(1));
  for (const width of [1400, 280]) {
    const entries = stops(render(width)), axis = dailyTimeAxis(days[0], width);
    assert.ok(entries.length >= 97, 'fondu évalué tous les quarts d’heure et dans les marges');
    assert.equal(entries[0][0], '0%');
    assert.equal(entries.at(-1)[0], '100%');
    for (const [offset, color] of entries) {
      const time = axis.timeAt(parseFloat(offset) / 100 * width);
      assert.equal(color, backgroundForTime(time), 'chaque couleur correspond à son heure réelle projetée');
    }
  }
  assert.equal((wide.match(/class="day-daylight-background"/g) || []).length, 1, 'un seul fond continu, sans aplats horaires');
  assert.ok(wide.includes('fill="url(#daily-light-2026-10-21)"'));
  assert.ok(dailyChartMarkup(days[1], { backgroundForTime }).includes('id="daily-light-2026-10-22"'));
});

test('la nébulosité est une zone translucide sans ligne ni points, interrompue aux données manquantes', () => {
  const [day] = buildDailyRows({ dashboard: { openMeteo: { hours: Array.from({ length: 25 }, (_, i) => hour(stamp + i * HOUR, { cloudCover: i === 12 ? null : 60 + i })) } }, now });
  const state = createDailyChartState();
  state.opacities.cloudiness = 100;
  const html = dailyChartMarkup(day, { state });
  const cloud = html.slice(html.indexOf('<g class="day-combined-layer metric-layer metric-layer-cloudiness"'), html.indexOf('<g class="day-combined-layer metric-layer metric-layer-rain"'));
  assert.equal((cloud.match(/<polygon class="cloud-cover-overlay"/g) || []).length, 2);
  assert.ok(!/<path|<circle|<text/.test(cloud));
  assert.ok(cloud.includes('Nébulosité : 60 %'), 'les valeurs restent consultables en infobulle');
  const polygons = [...cloud.matchAll(/points="([^"]+)"/g)].map(match => match[1].split(' ').map(point => Number(point.split(',')[0])));
  assert.ok(Math.max(...polygons[0]) < Math.min(...polygons[1]), 'la zone ne recouvre pas le trou');
});

test('aujourd’hui garde toute la journée et ses cumuls ; le grisé s’arrête à l’heure exacte', () => {
  const current = stamp + 8 * HOUR + 15 * 60000;
  const hours = Array.from({ length: 25 }, (_, i) => hour(stamp + i * HOUR));
  const [day] = buildDailyRows({ dashboard: { openMeteo: { hours } }, now: current });
  assert.equal(day.start, stamp);
  assert.equal(day.pastUntil, current);
  assert.equal(day.samples.length, 24);
  assert.equal(day.samples[0].stamp, stamp);
  assert.equal(day.samples[0].rain, 1);
  assert.equal(day.samples.filter(sample => sample.past).length, 8);
  assert.equal(day.samples[8].past, false, 'l’heure en cours est coupée visuellement au bon instant');
  assert.equal(day.samples.reduce((sum, sample) => sum + sample.rain, 0), 24);
  assert.equal(day.boundary.stamp, day.end);
  assert.equal(day.boundary.temperature, 12, 'la courbe se termine avec le point acquis à minuit, sans extrapolation');
  for (const width of [240, 390, 1000]) {
    for (const group of dailyTimeGroups(day, width).groups) {
      assert.ok(group.samples.every(sample => sample.stamp >= group.start && sample.intervalEnd <= group.end));
    }
    const html = dailyChartMarkup(day, { width });
    const expected = (30 + (current - day.start) / (day.end - day.start) * (width - 60)) / width * 100;
    assert.ok(html.includes(`class="day-elapsed-mask" style="width:${expected}%"`));
    assert.ok(html.includes(`class="day-now-marker" style="left:${expected}%"`));
    assert.ok(html.includes('prévision passée'));
  }
  const [late] = buildDailyRows({ dashboard: { openMeteo: { hours } }, now: stamp + 24 * HOUR - 60000 });
  assert.equal(late.samples.length, 24);
  assert.equal(late.samples.reduce((sum, sample) => sum + sample.rain, 0), 24);
  const [noBoundary] = buildDailyRows({ dashboard: { openMeteo: { hours: hours.slice(0, -1) } }, now: current });
  assert.equal(noBoundary.boundary.temperature, null, 'aucun prolongement au-delà du dernier point acquis');
  const [future] = buildDailyRows({ dashboard: { openMeteo: { hours: Array.from({ length: 25 }, (_, i) => hour(stamp + (24 + i) * HOUR, { rain: i ? 1 : null })) } }, now: current });
  assert.equal(future.pastUntil, future.start);
  assert.ok(!dailyChartMarkup(future).includes('class="day-elapsed-mask"'));
  const [missingPast] = buildDailyRows({ dashboard: { openMeteo: { hours: hours.slice(12) } }, now: current });
  assert.equal(missingPast.samples[0].temperature, null, 'la journée est conservée sans inventer les données absentes');
  assert.ok(dailyChartMarkup(missingPast).includes('class="day-elapsed-mask"'));
  const summary = dailyRowsMarkup([day], { now: current });
  assert.ok(!summary.includes('day-time-resolution'));
  assert.ok(!summary.includes('Clic sur une commande'));
  assert.ok(!summary.includes('daily-rows-footnote'));
  assert.ok(summary.includes('24 mm'));
  const [midnight] = buildDailyRows({ dashboard: { openMeteo: { hours } }, now: stamp });
  assert.ok(!dailyChartMarkup(midnight).includes('class="day-elapsed-mask"'));
  const changeNow = Date.parse('2026-10-25T02:30:00Z');
  const [change] = buildDailyRows({ dashboard: { openMeteo: { hours: Array.from({ length: 27 }, (_, i) => hour(Date.parse('2026-10-24T22:00:00Z') + i * HOUR)) } }, now: changeNow });
  assert.equal(change.samples.length, 25);
  assert.equal(change.pastUntil - change.start, 4.5 * HOUR, 'le repère respecte le changement d’heure');
});

test('le pas dépend uniquement de la largeur ; les cumuls sont conservés à chaque largeur', () => {
  const hours = Array.from({ length: 25 }, (_, i) => hour(stamp + i * HOUR));
  const [day] = buildDailyRows({ dashboard: { openMeteo: { hours } }, now });
  const wide = dailyTimeGroups(day, 1800), small = dailyTimeGroups(day, 280);
  assert.equal(wide.step, 1);
  assert.ok(small.step > wide.step);
  for (const width of [200, 280, 340, 768, 1400]) {
    const grouped = dailyTimeGroups(day, width);
    assert.equal(grouped.groups.reduce((sum, group) => sum + group.rain, 0), 24);
    assert.ok(!dailyChartMarkup(day, { width }).includes('min-width:'));
    assert.ok(!dailyChartMarkup(day, { width }).includes('NaN'));
  }
  assert.equal(dailyTimeGroups({ ...day, sources: ['ARPEGE'] }, 280).step, small.step);
});

test('le pictogramme de ce soir reste coloré et présent jusque dans la dernière minute, à toutes les largeurs', () => {
  const hours = Array.from({ length: 27 }, (_, i) => hour(stamp + i * HOUR, { cloudCover: 80 }));
  for (const current of [stamp + 22.5 * HOUR, stamp + 24 * HOUR - 60000]) {
    const [day] = buildDailyRows({ dashboard: { openMeteo: { hours } }, now: current });
    for (const width of [240, 390, 1000]) {
      const html = dailyChartMarkup(day, { width, iconMarkup: () => '<img src="evening-test.svg" alt="Ciel">' });
      assert.ok(html.includes('class="day-evening-header"'));
      assert.match(html, />Ce soir<\/time><span class="weather-icon"[^>]*><img src="evening-test.svg"/);
      assert.ok(html.indexOf('class="day-evening-header"') > html.indexOf('class="day-elapsed-mask"'), 'le dernier pictogramme est placé après le voile grisé');
      const header = html.slice(html.indexOf('class="day-evening-header"'));
      const left = Number(header.match(/style="left:([^%]+)%"/)[1]) / 100 * width;
      assert.ok(left >= 34.5 && left + 34.5 <= width, 'le pictogramme de 69 px reste dans le graphique');
    }
  }
});

test('les points acquis des jours voisins prolongent les courbes et la pluie aux bords, sans modifier les totaux du jour', () => {
  const hours = Array.from({ length: 73 }, (_, i) => hour(stamp + (i - 24) * HOUR, { temperature: i - 24 }));
  const [day] = buildDailyRows({ dashboard: { openMeteo: { hours } }, now });
  for (const width of [160, 280, 1000, 1800]) {
    const html = dailyChartMarkup(day, { width });
    const start = html.indexOf('<g class="day-combined-layer metric-layer metric-layer-temperature"');
    const temperature = html.slice(start, html.indexOf('</svg>', start));
    const segments = [...temperature.matchAll(/class="day-combined-line" d="M([^,]+),([^ ]+) L([^,]+),([^"]+)"/g)];
    assert.ok(Math.abs(Number(segments[0][1])) < 1e-8);
    assert.ok(Math.abs(Number(segments.at(-1)[3]) - width) < 1e-8);
    assert.notEqual(segments[0][2], segments[0][4], 'la pente provient des données de la veille, sans prolongement horizontal inventé');
    assert.notEqual(segments.at(-1)[2], segments.at(-1)[4], 'la pente utilise les données du lendemain');
    const adjacent = [...html.matchAll(/data-adjacent-day="true"[^>]*><rect x="([^"]+)"[^>]*width="([^"]+)"/g)];
    assert.ok(adjacent.length >= 2);
    assert.ok(Math.abs(Number(adjacent[0][1])) < 1e-8);
    assert.ok(Math.abs(Number(adjacent.at(-1)[1]) + Number(adjacent.at(-1)[2]) - width) < 1e-8);
  }
  assert.equal(day.samples.reduce((sum, sample) => sum + sample.rain, 0), 24);
  const [withoutContext] = buildDailyRows({ dashboard: { openMeteo: { hours: hours.filter(sample => Date.parse(sample.time) >= stamp && Date.parse(sample.time) <= stamp + 24 * HOUR) } }, now });
  const html = dailyChartMarkup(withoutContext, { width: 280 });
  const temperature = html.slice(html.indexOf('<g class="day-combined-layer metric-layer metric-layer-temperature"'));
  assert.ok(temperature.includes('d="M30,'), 'la courbe ne déborde pas sur des données inconnues');
});

test('les pictogrammes ont des colonnes régulièrement espacées ; la pluie reste ancrée en bas avec une hauteur automatique', () => {
  const [day] = buildDailyRows({ dashboard: { openMeteo: { hours: Array.from({ length: 25 }, (_, i) => hour(stamp + i * HOUR, { rain: i % 2 })) } }, now });
  for (const width of [280, 390, 1000, 1800]) {
    const { groups } = dailyTimeGroups(day, width);
    const space = (width - 60) * (groups[0].end - groups[0].start) / (day.end - day.start);
    assert.ok(space >= 64, `espace suffisant pour les grands pictogrammes à ${width}px`);
    const intervals = groups.map(group => group.start);
    assert.ok(intervals.slice(1).every((time, index) => time - intervals[index] === groups[0].end - groups[0].start));
    for (const viewportWidth of [280, 1000, 1800]) {
      const { height } = dailyChartSize(viewportWidth);
      const html = dailyChartMarkup(day, { width, viewportWidth });
      const bars = [...html.matchAll(/<rect x="[^"]+" y="([^"]+)" width="[^"]+" height="([^"]+)" class="day-combined-rain"\/>/g)];
      assert.equal(bars.length, dailyRainDisplayBars(day, width).filter(bar => bar.rain > 0).length);
      assert.equal((html.match(/class="day-rain-label"/g) || []).length, bars.length, 'chaque barre positive de la journée a sa valeur ou sa goutte');
      assert.ok(bars.every(match => Math.abs(Number(match[1]) + Number(match[2]) - height) < 1e-8), 'chaque barre touche le bas du graphique');
    }
  }
});

test('les nuits sont comprimées selon les levers et couchers, avec un axe réversible et des cumuls inchangés', () => {
  for (const [date, riseHour, setHour, timezone] of [
    ['2026-06-21T22:00:00Z', 5, 21, 'Europe/Paris'],
    ['2026-12-20T23:00:00Z', 8, 17, 'Europe/Paris'],
    ['2026-10-24T22:00:00Z', 9, 19, 'Europe/Paris']
  ]) {
    const start = Date.parse(date);
    const sunTimesForDate = midday => {
      assert.equal(localDateKey(midday, timezone), localDateKey(start, timezone));
      return { sunrise: new Date(start + riseHour * HOUR), sunset: new Date(start + setHour * HOUR) };
    };
    const [day] = buildDailyRows({ now: start, count: 1, timezone, sunTimesForDate,
      dashboard: { openMeteo: { hours: Array.from({ length: 27 }, (_, i) => hour(start + i * HOUR)) } } });
    for (const width of [200, 390, 1000, 2200]) {
      const axis = dailyTimeAxis(day, width);
      for (const time of [start - 4 * HOUR, start, day.sunrise, day.sunset, day.end, day.end + 4 * HOUR]) {
        assert.ok(Math.abs(axis.timeAt(axis.xStamp(time)) - time) < 1);
      }
      const { groups } = dailyTimeGroups(day, width);
      const columnWidth = (width - 60) / groups.length;
      assert.ok(groups.every(group => Math.abs(axis.xStamp(group.end) - axis.xStamp(group.start) - columnWidth) < 1e-6),
        'toutes les colonnes ont la même largeur, y compris aux transitions');
      assert.equal(groups.reduce((sum, group) => sum + group.rain, 0), day.samples.length);
      assert.ok(groups.every(group => axis.xStamp(group.end) - axis.xStamp(group.start) >= 69 - 1e-6));
      assert.ok(groups.slice(1).every((group, i) => groups[i].end === group.start));
      const current = start + 10.25 * HOUR;
      const html = dailyChartMarkup({ ...day, pastUntil: current }, { width });
      assert.ok(!/NaN|undefined/.test(html));
      assert.ok(html.includes(`class="day-now-marker" style="left:${axis.xStamp(current) / width * 100}%"`));
      assert.ok(html.includes(`<stop offset="${axis.xStamp(day.sunrise) / width * 100}%"`));
    }
  }
});

test('le résumé utilise la nébulosité diurne, la phase dominante en durée et conserve les orages même nocturnes', () => {
  const [day] = buildDailyRows({ now, dashboard: { openMeteo: { hours: Array.from({ length: 25 }, (_, i) => hour(stamp + i * HOUR,
    { cloudCover: i >= 8 && i < 18 ? 20 : 100, rain: i === 2 ? 3 : 0, stormSignal: i === 2 })) } },
    sunTimesForDate: () => ({ sunrise: new Date(stamp + 8 * HOUR), sunset: new Date(stamp + 18 * HOUR) }) });
  const summary = dailySummarySample(day);
  assert.equal(summary.cloudCover, 20);
  assert.equal(summary.rain, 0);
  assert.equal(summary.phase, 'dry');
  assert.equal(summary.stormSignal, true);
  assert.equal(Date.parse(summary.time), stamp + 13 * HOUR);
  const html = dailyRowsMarkup([day], { now, iconMarkup: () => '<img src="summary.svg" alt="Ciel">' });
  assert.match(html, /class="day-summary-icon"[^>]*Résumé météo[^>]*>.*src="summary.svg"/);
  assert.ok(!html.includes('Hauteur'));
  assert.ok(html.includes('Afficher le détail heure par heure'));
  assert.ok(html.includes('<small>Min.</small>'));
  assert.ok(html.includes('<small>Max.</small>'));
  assert.match(html, /class="daily-period-rain-volume"[^>]*><small>Précip.<\/small>/);
  const missing = dailySummarySample({ ...day, samples: day.samples.map(sample => ({ ...sample, cloudCover: null, rain: null, storm: null })) });
  assert.equal(missing.cloudCover, null);
  assert.equal(missing.rain, null);
  assert.equal(missing.stormSignal, false);
});

test('le résumé distingue une averse ponctuelle et une pluie répartie sur la journée à cumul identique', () => {
  const fixture = amounts => buildDailyRows({ now, dashboard: { arome: { hours: amounts.map((rain, index) =>
    hour(stamp + (index + 1) * HOUR, { rain, liquidRain: rain, snowfall: 0 })) } } })[0];
  const brief = fixture(Array.from({ length: 24 }, (_, index) => index === 12 ? 1.2 : 0));
  const spread = fixture(Array.from({ length: 24 }, (_, index) => index < 18 ? 1.2 / 18 : 0));
  const total = day => dailyRainBars(day).reduce((sum, bar) => sum + bar.rain, 0);
  assert.ok(Math.abs(total(brief) - total(spread)) < 1e-9);
  assert.equal(dailySummarySample(brief).phase, 'dry');
  assert.equal(dailySummarySample(brief).rain, 0);
  assert.equal(dailySummarySample(spread).phase, 'rain');
  assert.ok(dailySummarySample(spread).rain >= .05);
  assert.equal(Math.max(...brief.samples.map(sample => sample.rain)), 1.2, 'l’averse n’est pas supprimée des données ni de la frise');
  assert.ok(dailyChartMarkup(brief).includes('1,2 mm'));
  const partial = fixture([.2]);
  assert.equal(dailySummarySample(partial).phase, 'rain', 'une heure inconnue ne compte pas comme sèche');
});

test('l’option horaire apparaît seulement si nécessaire et élargit juste assez la frise sans changer sa hauteur', () => {
  const state = createDailyChartState();
  const [day] = buildDailyRows({ now, dashboard: { openMeteo: { hours: Array.from({ length: 25 }, (_, i) => hour(stamp + i * HOUR)) } },
    sunTimesForDate: () => ({ sunrise: new Date(stamp + 8 * HOUR), sunset: new Date(stamp + 18 * HOUR) }) });
  const required = dailyHourlyWidth(day);
  for (const viewport of [240, 390, 1000, 1800]) {
    state.showHourly = false;
    const normal = dailyChartSize(viewport, state, day);
    state.showHourly = true;
    const hourly = dailyChartSize(viewport, state, day);
    assert.equal(normal.width, viewport);
    assert.equal(hourly.width, Math.max(viewport, required));
    assert.equal(hourly.canExpand, viewport < required);
    assert.equal(hourly.height, normal.height);
    assert.ok(normal.height >= 220 && normal.height <= 300);
  }
  assert.equal(dailyChartSize(required, state, day).canExpand, false);
  assert.equal(dailyChartSize(required - 1, state, day).canExpand, true);
  assert.ok(dailyChartSize(390).height < dailyChartSize(1000).height);
  assert.equal(createDailyChartState().showHourly, false);
});

test('toutes les heures diurnes sont affichées, les pictogrammes nocturnes restent espacés et les cumuls sont conservés', () => {
  const [base] = buildDailyRows({ now, dashboard: { openMeteo: { hours: Array.from({ length: 25 }, (_, i) => hour(stamp + i * HOUR)) } } });
  for (const [rise, set] of [[5, 21], [8, 17], [8.25, 17.75], [7.9, 19.1]]) {
    const day = { ...base, sunrise: stamp + rise * HOUR, sunset: stamp + set * HOUR };
    for (const width of [dailyHourlyWidth(day), 2200]) {
      const axis = dailyTimeAxis(day, width);
      const { groups } = dailyTimeGroups(day, width);
      const daytime = day.samples.filter(sample => sample.stamp >= day.sunrise && sample.intervalEnd <= day.sunset);
      assert.ok(daytime.every(sample => groups.some(group => group.start === sample.stamp && group.end === sample.intervalEnd)));
      const positions = groups.map(group => axis.xStamp(group.start));
      assert.ok(positions.slice(1).every((left, i) => left - positions[i] >= 69 - 1e-6), 'les pictogrammes de 69 px ne se chevauchent pas, y compris près du lever et du coucher');
      assert.ok(groups.filter(group => group.end <= day.sunrise || group.start >= day.sunset).every(group => group.end - group.start >= 3 * HOUR));
      assert.equal(groups.reduce((sum, group) => sum + group.rain, 0), 24);
    }
  }
});

test('la marge entre pictogrammes ne force pas aujourd’hui à regrouper deux heures sur grand écran', () => {
  const [day] = buildDailyRows({ now: stamp + 20 * HOUR,
    dashboard: { openMeteo: { hours: Array.from({ length: 25 }, (_, i) => hour(stamp + i * HOUR)) } },
    sunTimesForDate: () => ({ sunrise: new Date(stamp + 8.1 * HOUR), sunset: new Date(stamp + 18.79 * HOUR) }) });
  const width = 1108;
  assert.equal(dailyChartSize(width, createDailyChartState(), day).canExpand, false);
  const { groups } = dailyTimeGroups(day, width);
  const daytime = day.samples.filter(sample => sample.stamp >= day.sunrise && sample.intervalEnd <= day.sunset);
  assert.ok(daytime.every(sample => groups.some(group => group.start === sample.stamp && group.end === sample.intervalEnd)));
});

test('la légende indique l’âge de chaque collecte utilisée, avec la date exacte au survol', () => {
  const aromeTime = Date.parse('2026-10-20T18:15:00Z');
  const weekTime = Date.parse('2026-10-20T19:20:00Z');
  const [day] = buildDailyRows({ now, dashboard: {
    arome: { fetchedAt: aromeTime, hours: [hour(stamp), hour(stamp + HOUR)] },
    openMeteo: { fetchedAt: stamp, hours: [hour(stamp, { temperature: 99 })] }
  }, week: { fetchedAt: weekTime, hours: Array.from({ length: 25 }, (_, i) => hour(stamp + i * HOUR)) } });
  assert.deepEqual(day.sourceUpdates, [{ name: 'AROME', fetchedAt: aromeTime }, { name: 'ARPEGE', fetchedAt: weekTime }]);
  const html = dailyRowsMarkup([day], { now });
  assert.match(html, /AROME · <time datetime="2026-10-20T18:15:00.000Z" title="20\/10\/2026 20:15">il y a 3h, 45min<\/time>/);
  assert.match(html, /ARPEGE · <time datetime="2026-10-20T19:20:00.000Z" title="20\/10\/2026 21:20">il y a 2h, 40min<\/time>/);
  assert.ok(!html.includes('Open-Meteo'));
  assert.ok(!html.includes('Réinitialiser'));
  assert.ok(!html.includes('Jour par jour'));
  assert.ok(!html.includes('daily-rows-intro'));
  const legend = html.slice(html.indexOf('<div class="day-chart-key">'), html.indexOf('<div class="day-combined-canvas"'));
  assert.ok(legend.includes('class="day-source"'));
  assert.ok(legend.includes('AROME'));
  assert.ok(!html.slice(0, html.indexOf('</header>')).includes('class="day-source"'));
  const unknown = dailyRowsMarkup([{ ...day, sourceUpdates: [{ name: 'AROME', fetchedAt: null }] }], { now });
  assert.ok(unknown.includes('AROME · date inconnue'));
});

test('l’âge des sources suit l’horloge du site sans rajeunir le cache ni masquer une date invalide', () => {
  const [day] = buildDailyRows({ now, week: { fetchedAt: now - 49 * HOUR - 7 * 60000, hours: [hour(stamp)] } });
  const options = { now };
  assert.ok(dailyChartMarkup(day, options).includes('il y a 49h, 7min'));
  assert.ok(dailyChartMarkup(day, { now: now + 60000 }).includes('il y a 49h, 8min'));
  const render = fetchedAt => dailyChartMarkup({ ...day, sourceUpdates: [{ name: 'ARPEGE', fetchedAt }] }, options);
  assert.ok(render(now - 59000).includes('>à l’instant</time>'));
  for (const minutes of [1, 12, 59]) {
    const html = render(now - minutes * 60000);
    assert.ok(html.includes(`>il y a ${minutes}min</time>`));
    assert.ok(!html.includes('il y a 0h'));
  }
  assert.ok(render(new Date(now - HOUR)).includes('>il y a 1h, 0min</time>'));
  assert.ok(render(new Date(now - HOUR).toISOString()).includes('>il y a 1h, 0min</time>'));
  assert.ok(render(now + HOUR).includes('>date future</time>'));
  for (const date of [null, 0, 'invalide', NaN]) assert.ok(render(date).includes('date inconnue'));
  const piaf = piafChartMarkup(null, { now, dashboard: { arome: { fetchedAt: now - 2 * HOUR - 15 * 60000,
    hours: [hour(stamp), hour(stamp + 3 * HOUR)] } } });
  assert.ok(piaf.includes('>il y a 2h, 15min</time>'), 'même présentation dans les trois prochaines heures');
  const recent = piafChartMarkup(null, { now, dashboard: { arome: { fetchedAt: now - 12 * 60000,
    hours: [hour(stamp), hour(stamp + 3 * HOUR)] } } });
  assert.ok(recent.includes('>il y a 12min</time>'));
  assert.ok(!recent.includes('il y a 0h'));
});

test('PIAF : faibles épisodes en gouttes hors échelle, sans masquer pluie soutenue ni averse brève intense', () => {
  const step = (index, amount) => ({ intervalStart: now + index * 300000, intervalEnd: now + (index + 1) * 300000,
    baseRainSource: 'piaf', basePrecipitation: amount });
  const amounts = [.010009765625, 0, .0174560546875, .0264892578125, .04022216796875];
  const forecast = { rainSteps: amounts.map((amount, index) => step(index, amount)) };
  const original = structuredClone(forecast);
  for (const width of [280, 1000]) {
    const html = piafChartMarkup(forecast, { now, width });
    assert.equal((html.match(/class="piaf-trace-mark"/g) || []).length, 2);
    const labelCount = (html.match(/class="piaf-trace-label"/g) || []).length;
    assert.ok(labelCount >= 1 && labelCount <= 2, 'les mots gouttes voisins ne se chevauchent pas');
    assert.ok(html.includes('class="piaf-chart-total">gouttes</span>'));
    assert.ok(!html.includes('Précip. PIAF mm/h'));
    assert.ok(!/<text x=/.test(html), 'aucun axe numérique pour les seules gouttes');
    const marks = [...html.matchAll(/class="piaf-trace-mark"[^>]*height="([^"]+)"/g)];
    assert.ok(marks.every(match => Number(match[1]) === 5));
    for (const match of html.matchAll(/<path d="([^"]+)" class="piaf-intensity-line"/g)) {
      assert.ok([...match[1].matchAll(/,([\d.]+)/g)].every(point => Number(point[1]) === 260), 'pas de pic amplifié pour les gouttes');
    }
  }
  assert.deepEqual(forecast, original, 'aucune modification des quantités sources');
  const steady = piafChartMarkup({ rainSteps: Array.from({ length: 36 }, (_, i) => step(i, .05)) }, { now });
  assert.ok(!steady.includes('piaf-trace-mark'));
  assert.ok(steady.includes('1,8 mm'));
  const intense = piafChartMarkup({ rainSteps: [{ intervalStart: now, intervalEnd: now + 60000, precipitation: .05 }] }, { now });
  assert.ok(!intense.includes('piaf-trace-mark'));
  assert.ok(!intense.includes('>gouttes<'));
  assert.ok(intense.includes('3 mm/h'));
  const mixed = piafChartMarkup({ rainSteps: [step(0, .01), step(1, 0), step(2, 1)] }, { now });
  assert.ok(mixed.includes('piaf-trace-mark'));
  assert.ok(mixed.includes('12 mm/h'));
  assert.ok(mixed.includes('Précip. PIAF mm/h'));
});

test('PIAF : aucune ligne bleue à zéro ni entre deux épisodes humides séparés', () => {
  const forecast = { rainSteps: Array.from({ length: 7 }, (_, index) => ({
    intervalStart: now + index * 300000, intervalEnd: now + (index + 1) * 300000,
    precipitation: index === 1 || index === 5 ? .2 : 0 })) };
  const html = piafChartMarkup(forecast, { now });
  const paths = [...html.matchAll(/<path d="([^"]+)" class="piaf-intensity-line"/g)];
  assert.equal(paths.length, 2);
  for (const path of paths) for (const point of path[1].matchAll(/,([\d.]+)/g)) {
    assert.ok(Number(point[1]) < 260, 'aucun segment de précipitation dessiné sur la ligne zéro');
  }
});

test('PIAF : sous 0,01 mm, pas de gouttes ni de courbe, sans effacer une pluie soutenue à petits pas', () => {
  const steps = amounts => ({ rainSteps: amounts.map((precipitation, index) => ({
    intervalStart: now + index * 300000, intervalEnd: now + (index + 1) * 300000, precipitation })) });
  for (const amount of [.0001, .0015, .005, .0099, .01]) {
    const forecast = steps([0, amount, 0]);
    const original = structuredClone(forecast);
    const html = piafChartMarkup(forecast, { now });
    assert.equal(html.includes('piaf-trace-mark'), amount >= .01);
    assert.equal(html.includes('>gouttes<'), amount >= .01);
    assert.ok(!html.includes('piaf-intensity-line'));
    assert.ok(!html.includes('piaf-intensity-area'));
    if (amount < .01) assert.ok(!html.includes('class="piaf-chart-total"'));
    assert.deepEqual(forecast, original);
  }
  const sustained = piafChartMarkup(steps(Array(36).fill(.009)), { now });
  assert.ok(sustained.includes('piaf-intensity-line'), 'le cumul significatif d’un épisode continu reste représenté');
});

test('PIAF : les hauteurs quantitatives progressent linéairement au-dessus des gouttes et 1 mm/h reste modeste', () => {
  for (const width of [280, 1000]) {
    for (const rate of [.3, .9, 1, 1.9, 12]) {
      const rainSteps = Array.from({ length: 36 }, (_, index) => ({ intervalStart: now + index * 300000,
        intervalEnd: now + (index + 1) * 300000, baseRainSource: 'piaf', basePrecipitation: rate / 12 }));
      const html = piafChartMarkup({ rainSteps }, { now, width });
      assert.ok(!html.includes('piaf-trace-mark'), 'la pluie soutenue n’est pas classée gouttes');
      const path = html.match(/<path d="([^"]+)" class="piaf-intensity-line"/)[1];
      const expectedY = 260 - 5 - rate / Math.max(10, rate) * 85;
      assert.ok(expectedY < 255, 'la pluie chiffrée dépasse toujours les gouttes à 5 px');
      for (const point of path.matchAll(/,([\d.]+)/g)) assert.ok(Math.abs(Number(point[1]) - expectedY) < 1e-9);
    }
  }
});

test('PIAF conserve le pas 5 min, les cumuls restants et les trous sans prolonger les données', () => {
  const piaf = { fetchedAt: now, coverageId: 'RAIN___2026-10-20T22.00.00Z_PT5M',
    values: Array.from({ length: 36 }, (_, i) => ({ seconds: (i + 1) * 300, precipitation: .1 })) };
  const current = now + 2 * 60000;
  const forecast = prepareBasicForecast({ piaf }, current);
  const html = piafChartMarkup(forecast, { now: current, width: 300 });
  assert.ok(html.includes('3,56 mm'));
  assert.ok(html.includes('1,2 mm/h'));
  assert.equal((html.match(/class="chart-point"/g) || []).length, 36);
  assert.equal((html.match(/class="piaf-intensity-line"/g) || []).length, 1);
  const missing = { ...forecast, rainSteps: forecast.rainSteps.filter((_, i) => i !== 10) };
  assert.equal((piafChartMarkup(missing, { now: current }).match(/class="piaf-intensity-line"/g) || []).length, 2);
  const expired = piafChartMarkup(prepareBasicForecast({ piaf }, now + 4 * HOUR), { now: now + 4 * HOUR });
  assert.ok(expired.includes('aria-label="PIAF indisponible"'));
  assert.ok(!expired.includes('piaf-intensity-line'));
  const dry = piafChartMarkup({ rainSteps: forecast.rainSteps.map(sample => ({ ...sample, basePrecipitation: 0, precipitation: 0 })) }, { now: current });
  assert.ok(!dry.includes('class="piaf-chart-total"'));
  assert.ok(!dry.includes('piaf-intensity-line'));
  assert.ok(!dry.includes('piaf-intensity-area'));
});

test('les cumuls nuls disparaissent du résumé, sans masquer les pluies positives ou les données inconnues', () => {
  const fixture = rain => buildDailyRows({ now, dashboard: { openMeteo: { hours: Array.from({ length: 25 }, (_, i) => hour(stamp + i * HOUR, { rain })) } } })[0];
  const base = fixture(1), dry = fixture(0), trace = fixture(.0001), unknown = fixture(null);
  assert.ok(!dailyRowsMarkup([dry], { now }).includes('daily-period-rain-volume'));
  assert.ok(!dailyRowsMarkup([trace], { now }).includes('daily-period-rain-volume'), 'une trace arrondie à zéro ne produit pas 0 mm');
  assert.equal(trace.samples[0].rain, .0001, 'les données acquises restent conservées');
  assert.ok(dailyRowsMarkup([base], { now }).includes('daily-period-rain-volume'));
  assert.ok(dailyRowsMarkup([unknown], { now }).includes('— mm (partiel)'));
});

test('Tendance apparaît dans l’en-tête dès J+8, sans classification technique dans la légende', () => {
  const days = buildDailyRows({ now, dashboard: { openMeteo: {
    hours: Array.from({ length: 16 * 24 + 2 }, (_, i) => hour(stamp + i * HOUR, { probability: 75 })) },
    ensemble: { hours: [{ time: new Date(stamp).toISOString(), probability: 90 }] } } });
  assert.equal(days.length, 16);
  assert.ok(!days[7].trend);
  assert.ok(days[8].trend);
  assert.ok(!dailyRowsMarkup(days.slice(0, 8), { now }).includes('class="day-trend-label"'));
  for (const day of days.slice(8)) {
    const html = dailyRowsMarkup([day], { now });
    assert.ok(html.slice(0, html.indexOf('</header>')).includes('class="day-trend-label">Tendance</span>'));
    assert.ok(!/déterministe|probabiliste|day-forecast-kind|Pluie Open-Meteo agrégée/i.test(html));
    assert.ok(!html.includes('75 %'), 'la probabilité de pluie acquise n’est pas une dispersion des courbes');
  }
  const thursday = Date.parse('2026-10-22T10:00:00Z');
  const current = buildDailyRows({ now: thursday, dashboard: { openMeteo: { hours: days.flatMap(day => day.samples) } } });
  assert.ok(!current.find(day => day.date === '2026-10-29').trend);
  assert.ok(current.find(day => day.date === '2026-10-30').trend);
});

test('la frise 3 h combine PIAF, températures et pictogrammes ; une panne PIAF conserve les données météo valides', () => {
  const dashboard = { piaf: { fetchedAt: now }, arome: { fetchedAt: now - HOUR, hours: Array.from({ length: 7 }, (_, i) => hour(stamp + (i - 1) * HOUR, { temperature: 9 + i, stormSignal: i === 2 })) },
    openMeteo: { hours: Array.from({ length: 7 }, (_, i) => hour(stamp + (i - 1) * HOUR, { temperature: 99 })) } };
  const forecast = { rainSteps: Array.from({ length: 36 }, (_, i) => ({ intervalStart: now + i * 300000, intervalEnd: now + (i + 1) * 300000, baseRainSource: 'piaf', basePrecipitation: .1 })) };
  const options = { now, width: 300, dashboard, iconMarkup: () => '<img src="piaf-weather.svg" alt="Ciel">' };
  const html = piafChartMarkup(forecast, options);
  assert.equal((html.match(/src="piaf-weather.svg"/g) || []).length, 4);
  assert.ok(html.includes('class="piaf-temperature-line"'));
  assert.ok(html.includes('class="piaf-intensity-line"'));
  assert.ok(html.includes('>10°</text>'));
  assert.ok(html.includes('>13°</text>'));
  assert.ok(!html.includes('99°'));
  assert.ok(html.includes('class="day-weather-storm"'));
  assert.ok(html.includes('°C\nAROME'));
  const sources = html.slice(html.indexOf('<span class="day-source"'), html.indexOf('<div class="day-combined-canvas"'));
  assert.ok(sources.includes('AROME · <time'));
  assert.ok(sources.includes('PIAF · <time'));
  assert.ok(!sources.includes('Open-Meteo'));
  const missing = piafChartMarkup(null, options);
  assert.ok(missing.includes('aria-label="PIAF indisponible"'));
  assert.ok(!missing.includes('Actualisation des données nécessaire'));
  assert.ok(missing.includes('class="piaf-temperature-line"'));
  assert.equal((missing.match(/src="piaf-weather.svg"/g) || []).length, 4);
  assert.ok(!missing.includes('class="piaf-intensity-line"'));
  const empty = piafChartMarkup(null, { now, width: 240 });
  assert.ok(!empty.includes('class="piaf-temperature-line"'));
  assert.ok(!/NaN|undefined/.test(empty));
});

test('le cache public et la fusion conservent Open-Meteo ; un échec garde la dernière collecte', async () => {
  const profile = siteProfile();
  const previous = { fetchedAt: now, hours: [hour(stamp)] };
  const entry = { siteId: profile.id, latitude: profile.latitude, longitude: profile.longitude, openMeteo: previous };
  assert.ok(!sourceDue('openMeteo', entry, now + 60000));
  assert.ok(sourceDue('openMeteo', entry, now + 2 * HOUR));
  const merged = mergeWeatherState(entry, { ...entry, openMeteo: { ...previous, fetchedAt: now - 1 } });
  assert.equal(merged.openMeteo, previous);
  const file = publicWeatherFiles(profile, entry)['dashboard.json'];
  assert.equal(file.status, 'ready');
  assert.equal(file.data.openMeteo, previous);
  const onlyOpen = { ...profile, features: { openMeteo: true } };
  const result = await collectWeather({ profile: onlyOpen, entry, group: 'forecast', collectors: { buildOpenMeteo: async () => { throw new Error('Hors ligne'); } } });
  assert.equal(result.entry.openMeteo, previous);
  assert.deepEqual(result.errors, [{ source: 'openMeteo', message: 'Hors ligne' }]);
});


test('PIAF expiré est visiblement indisponible, jamais assimilé au sec ni remplacé par AROME', () => {
  const current = Date.parse('2026-10-23T12:26:00Z');
  const piaf = { coverageId: 'RAIN___2026-10-23T02.45.00Z_PT5M',
    values: Array.from({ length: 36 }, (_, i) => ({ seconds: (i + 1) * 300, precipitation: 0 })) };
  const dashboard = { piaf, arome: { hours: [hour(current - HOUR), hour(current),
    hour(Date.parse('2026-10-23T15:00:00Z'), { rain: 1.15, liquidRain: 1.15, snowfall: 0 })] } };
  const options = { now: current, dashboard };
  const expired = piafChartMarkup(prepareBasicForecast(dashboard, current), options);
  assert.ok(expired.includes('>Précip. PIAF indisponibles</span>'));
  assert.ok(expired.includes('ce pictogramme ne signifie pas un temps sec'));
  assert.ok(!expired.includes('piaf-intensity-line'));
  const dry = piafChartMarkup({ rainSteps: [{ intervalStart: current, intervalEnd: current + 3 * HOUR, precipitation: 0 }] }, options);
  assert.ok(!dry.includes('PIAF indisponibles'));
  assert.ok(!dry.includes('piaf-intensity-line'));
  const gap = piafChartMarkup({ rainSteps: [{ intervalStart: current, intervalEnd: current + HOUR, precipitation: 0 }] }, options);
  assert.ok(gap.includes('Précipitations PIAF indisponibles à cette heure'));
  const modelSnow = { ...dashboard, arome: { hours: [hour(current + HOUR, nativeSnowAmounts(1, 1))] } };
  const missing = piafChartMarkup(null, { ...options, dashboard: modelSnow });
  assert.ok(!missing.includes('calque-neige-'), 'une phase du modèle ne remplit pas un trou PIAF');
});


test('les cartes quotidiennes partagent la grille et gardent la courbe séparée', () => {
  const days = buildDailyRows({ now, dashboard: { arome: { hours: Array.from({ length: 49 }, (_, i) => hour(stamp + i * HOUR, { rain: .25, liquidRain: .25, snowfall: 0 })) } } });
  const state = createDailyChartState(), dates = [];
  const html = dailyRowsMarkup(days.slice(0, 2), { now, collapsible: true, stateForDate: () => state,
    periodsMarkup: day => { dates.push(day.date); return ['morning','afternoon','evening','night'].map(key => '<details data-slot-key="' + key + '"><summary>' + key + '</summary></details>').join(''); } });
  assert.equal(dates.length, 2);
  assert.equal((html.match(/class="daily-forecast-card/g) || []).length, 2);
  assert.equal((html.match(/data-slot-key=/g) || []).length, 8);
  assert.equal((html.match(/class="daily-period-grid"/g) || []).length, 2);
  assert.ok(html.includes('daily-cards-grid bulletin-cards-grid'));
  assert.ok(!html.includes('day-combined-svg'), 'le graphique attend l’ouverture par son bouton');
  assert.equal((html.match(/class="day-chart-toggle"/g) || []).length, 2);
  assert.equal((html.match(/class="[^"]*day-chart-panel[^"]*"[^>]* hidden/g) || []).length, 2);
  state.chartOpen = true;
  const reopened = dailyRowsMarkup(days.slice(0, 1), { now, collapsible: true, stateForDate: () => state });
  assert.match(reopened, /class="day-chart-toggle"[^>]*aria-expanded="true"/);
  assert.doesNotMatch(reopened, /class="[^"]*day-chart-panel[^"]*"[^>]* hidden/);
  assert.ok(!dailyRowsMarkup(days.slice(0, 1), { now }).includes('daily-period-grid'));
});

test('les créneaux gardent leurs cumuls natifs et la nuit suivante, sans transformer les inconnues en zéro', () => {
  const days = buildDailyRows({ now, dashboard: { arome: { hours: Array.from({ length: 49 }, (_, i) => hour(stamp + i * HOUR,
    { rain: .25, liquidRain: .25, snowfall: 0, temperature: i < 24 ? 12 : 24 })) } } });
  const morning = dailyPeriodSummary(days[0], stamp + 6 * HOUR, stamp + 12 * HOUR, now);
  const night = dailyPeriodSummary(days[0], stamp + 24 * HOUR, stamp + 30 * HOUR, now);
  assert.equal(morning.rain, 1.5);
  assert.equal(morning.temperatureMax, 12);
  assert.equal(night.rain, 1.5);
  assert.equal(night.temperatureMin, 24);
  assert.ok(night.completeRain);
  assert.deepEqual(night.rainSources, ['AROME']);
  const missing = dailyPeriodSummary(days[0], stamp + 100 * HOUR, stamp + 106 * HOUR, now);
  assert.equal(missing.rain, null);
  assert.equal(missing.storm, null);
  assert.equal(missing.cloudCover, null);
  assert.equal(missing.available, false);
});

test('la nuit du changement d’heure conserve ses sept heures et chaque prorata de pluie', () => {
  const base = Date.parse('2026-10-24T00:00:00Z');
  const [day] = buildDailyRows({ now: base, dashboard: { arome: { hours: Array.from({ length: 48 }, (_, i) => hour(base + i * HOUR, { rain: 1 })) } } });
  const start = Date.parse('2026-10-24T22:00:00Z'), end = Date.parse('2026-10-25T05:00:00Z');
  const night = dailyPeriodSummary(day, start, end, base);
  assert.equal(night.rain, 7);
  assert.equal(night.samples.length, 7);
  const partial = dailyPeriodSummary(day, start, end, start + HOUR / 2);
  assert.equal(partial.rain, 6.5);
  assert.ok(partial.estimated);
});


test('frise compacte : min/max de la source prioritaire, cumul PIAF conservé et courbe de température supprimée', () => {
  const dashboard = { arome: { hours: [hour(now - HOUR, { temperature: 9, rain: 0 }),
    hour(now, { temperature: 10, rain: 0 }), hour(now + HOUR, { temperature: 15, rain: 1, liquidRain: 1, snowfall: 0 }),
    hour(now + 2 * HOUR, { temperature: 5, rain: 1, liquidRain: 0, snowfall: 1 }),
    hour(now + 3 * HOUR, { temperature: 12, rain: 1, liquidRain: 1, snowfall: 0 }), hour(now + 4 * HOUR, { temperature: 99 })] },
    openMeteo: { hours: Array.from({ length: 5 }, (_, i) => hour(now + i * HOUR, { temperature: -99 })) } };
  // The single PIAF interval crosses all three model phase intervals.
  const forecast = { rainSteps: [{ intervalStart: now, intervalEnd: now + 3 * HOUR, precipitation: 3 }] };
  const html = piafChartMarkup(forecast, { now, dashboard, compact: true });
  assert.match(html, /<small>Min\.<\/small><b>5°<\/b>/);
  assert.match(html, /<small>Max\.<\/small><b>15°<\/b>/);
  assert.match(html, /<small>Cumul<\/small><b>3 mm<\/b>/);
  assert.ok(!html.includes('piaf-temperature-line'));
  assert.ok(!html.includes('piaf-temperature-point'));
  assert.ok(html.includes('piaf-intensity-line piaf-phase-rain'));
  assert.ok(html.includes('piaf-intensity-line piaf-phase-snow'));
  assert.ok(html.includes('<small>Neige</small>'));
  assert.ok(html.includes('Neige fraîche estimée par AROME'));
  assert.ok(!html.includes('Précip. PIAF mm/h équiv. eau'));
  assert.ok(!html.includes('class="day-source"'));
  assert.ok(html.includes('estimation distincte du cumul PIAF'));
  assert.ok(!/NaN|undefined/.test(html));
});

test('frise compacte : un cumul sec connu, un cumul partiel et une absence PIAF restent distincts', () => {
  const options = { now, compact: true };
  const step = (duration, precipitation) => ({ rainSteps: [{ intervalStart: now, intervalEnd: now + duration, precipitation }] });
  const dry = piafChartMarkup(step(3 * HOUR, 0), options);
  assert.match(dry, /<b>Pas de pluie<\/b>/);
  assert.ok(!dry.includes('piaf-daylight'));
  assert.match(piafChartMarkup(step(HOUR, 0), options), /<b>Pas de pluie<\/b>/);
  assert.match(piafChartMarkup(step(HOUR, 0), options), /couverture partielle/);
  assert.ok(!dry.includes('piaf-intensity-line'));
  const partial = piafChartMarkup(step(HOUR, .25), options);
  assert.match(partial, /<small>Cumul<\/small><b>0,25 mm \(partiel\)<\/b>/);
  const missing = piafChartMarkup(null, options);
  assert.match(missing, /<small>Cumul<\/small><b>— mm<\/b>/);
  assert.ok(missing.includes('PIAF indisponibles'));
  assert.ok(!missing.includes('piaf-intensity-line'));
  assert.ok(!missing.includes('piaf-temperature-line'));
});


test('le contrôle coloré dépend de la date d’acquisition des sources réellement utilisées', () => {
  const day = (...timestamps) => ({ sourceUpdates: timestamps.map((fetchedAt, i) => ({ name: 'source' + i, fetchedAt })) });
  assert.equal(dailyDataUpdateStatus(day(now - 30 * 60000), now), 'green');
  assert.equal(dailyDataUpdateStatus(day(new Date(now - 60 * 60000).toISOString()), now), 'green');
  assert.equal(dailyDataUpdateStatus(day(now - 2 * HOUR), now), 'orange');
  assert.equal(dailyDataUpdateStatus(day(now - 4 * HOUR, now - 60000), now), 'red');
  assert.equal(dailyDataUpdateStatus(day(null), now), 'red');
  assert.equal(dailyDataUpdateStatus(day(), now), 'red');
  assert.equal(dailyDataUpdateStatus(day(now + HOUR), now), 'red');
});


test('frise 3 h : vent et rafales restent prioritaires, avec signal d’orage sur la seule fenêtre affichée', () => {
  const dashboard = { arome: { hours: [hour(now, { windSpeed: 12, windGust: 25 }),
    hour(now + HOUR, { windSpeed: 22, windGust: 40, stormSignal: true }),
    hour(now + 2 * HOUR, { windSpeed: 15, windGust: 30 }),
    hour(now + 3 * HOUR, { windSpeed: 18, windGust: 35 }), hour(now + 4 * HOUR, { windSpeed: 120, windGust: 160 })] },
    openMeteo: { hours: Array.from({ length: 5 }, (_, i) => hour(now + i * HOUR, { windSpeed: 200, windGust: 250 })) } };
  let hazards;
  const html = piafChartMarkup(null, { now, compact: true, dashboard, hazardsMarkup: period => { hazards = period; return '<span>résumé vent et orage</span>'; } });
  assert.deepEqual(hazards, { windSpeed: 22, windGust: 40, storm: true });
  assert.ok(html.includes('résumé vent et orage'));
  let updates;
  piafChartMarkup(null, { now, compact: true, dashboard, updateMarkup: data => { updates = data.sourceUpdates; return ''; } });
  assert.ok(updates.some(update => update.name === 'PIAF'), 'une absence PIAF doit peser dans son indicateur');
});

test('la fraîcheur PIAF emploie ses seuils courts et les jours lointains placent la date dans le titre', () => {
  const status = minutes => dailyDataUpdateStatus({ sourceUpdates: [{ name: 'PIAF', fetchedAt: now - minutes * 60000 }] }, now);
  assert.equal(status(5), 'green'); assert.equal(status(15), 'orange'); assert.equal(status(25), 'red');
  const days = buildDailyRows({ now, dashboard: { openMeteo: { hours: Array.from({ length: 16 * 24 }, (_, i) => hour(now + i * HOUR)) } } });
  const html = dailyRowsMarkup(days, { now, collapsible: true, updateMarkup: () => '<span>actualisation</span>' });
  assert.match(html, /<h3>jeudi <time datetime="2026-10-29">29 oct\.<\/time><\/h3>/);
  assert.match(html, /class="day-heading-tools"><span class="day-trend-label">Tendance<\/span><button[\s\S]*?actualisation/);
  assert.match(html, /<h3>Aujourd’hui <time datetime="2026-10-21">21 oct\.<\/time><\/h3>/);
});

test('le survol d’actualisation affiche uniquement minutes et heures sans date ni parenthèses', async () => {
  const { dailyDataUpdateTitle } = await import('../public/daily-rows.js');
  const day = fetchedAt => ({ sourceUpdates: [{ name: 'PIAF', fetchedAt }] });
  assert.equal(dailyDataUpdateTitle(day(now - 12 * 60000), now), 'Actualisation ancienne\nPIAF : il y a 12 min');
  assert.equal(dailyDataUpdateTitle(day(now - 135 * 60000), now), 'Données anciennes ou indisponibles\nPIAF : il y a 2 h 15 min');
  assert.ok(dailyDataUpdateTitle(day(new Date(now - HOUR).toISOString()), now).includes('il y a 1 h 0 min'));
  assert.ok(dailyDataUpdateTitle(day(now - 12 * 60000), now + 60000).includes('il y a 13 min'));
  assert.ok(dailyDataUpdateTitle(day(null), now).includes('date inconnue'));
  assert.ok(dailyDataUpdateTitle(day(now + HOUR), now).includes('date future'));
  assert.ok(dailyDataUpdateTitle(day(now), now).includes('à l’instant'));
});

test('les survols gardent les scénarios des trois sources indépendants et leurs probabilités acquises', async () => {
  const { buildDailySourceRows, dailyPeriodSourceSummaries } = await import('../public/daily-rows.js');
  const makeHours = extra => Array.from({ length: 25 }, (_, i) => hour(stamp + i * HOUR, extra));
  const dashboard = {
    arome: { hours: makeHours({ rain: 1, cloudCover: 20, windSpeed: 12, windGust: 25, stormSignal: false }) },
    openMeteo: { hours: makeHours({ rain: 3, probability: 94, cloudCover: 80, windSpeed: 30, windGust: 65, weatherCode: 95 }) }
  };
  const week = { hours: makeHours({ rain: 2, cloudCover: 50, windSpeed: 20, windGust: 40, stormSignal: true }) };
  const before = structuredClone({ dashboard, week });
  const rows = buildDailySourceRows({ dashboard, week, now });
  const summaries = dailyPeriodSourceSummaries(rows, '2026-10-21', stamp, stamp + 6 * HOUR, now);
  assert.deepEqual(summaries.map(item => item.name), ['AROME', 'ARPEGE', 'Open-Meteo']);
  assert.deepEqual(summaries.map(item => item.rain), [6, 12, 18]);
  assert.deepEqual(summaries.map(item => item.cloudCover), [20, 50, 80]);
  assert.deepEqual(summaries.map(item => item.windGust), [25, 40, 65]);
  assert.deepEqual(summaries.map(item => item.storm), [false, true, true]);
  assert.deepEqual(summaries.map(item => item.probability), [null, null, 94]);
  assert.equal(buildDailyRows({ dashboard, week, now })[0].samples[1].windSpeed, 12);
  assert.deepEqual({ dashboard, week }, before);
  assert.deepEqual(dailyPeriodSourceSummaries(rows, '2026-11-10', stamp, stamp + HOUR, now), []);
});

test('les détails par source ne transforment pas une absence en zéro ou probabilité inventée', async () => {
  const { buildDailySourceRows, dailyPeriodSourceSummaries } = await import('../public/daily-rows.js');
  const hours = Array.from({ length: 4 }, (_, i) => hour(stamp + i * HOUR, { rain: null, cloudCover: null, windGust: null, probability: null }));
  const rows = buildDailySourceRows({ now, dashboard: { openMeteo: { hours } } });
  const [detail] = dailyPeriodSourceSummaries(rows, '2026-10-21', stamp, stamp + 3 * HOUR, now);
  assert.equal(detail.rain, null);
  assert.equal(detail.cloudCover, null);
  assert.equal(detail.windGust, null);
  assert.equal(detail.probability, null);
});

test('les alertes par source respectent un cumul natif de trois heures et son chevauchement orageux', async () => {
  const { buildDailySourceRows, dailyPeriodSourceSummaries } = await import('../public/daily-rows.js');
  const hours = [hour(stamp, { rain: null, windSpeed: 30, windGust: 50 }),
    hour(stamp + 3 * HOUR, { rain: 6, rainIntervalStart: new Date(stamp).toISOString(), rainIntervalEnd: new Date(stamp + 3 * HOUR).toISOString(), stormSignal: true, windSpeed: 30, windGust: 50 }),
    hour(stamp + 6 * HOUR, { rain: 0, rainIntervalStart: new Date(stamp + 3 * HOUR).toISOString(), rainIntervalEnd: new Date(stamp + 6 * HOUR).toISOString(), stormSignal: false, windSpeed: 30, windGust: 50 })];
  const rows = buildDailySourceRows({ now, week: { hours } });
  const [summary] = dailyPeriodSourceSummaries(rows, '2026-10-21', stamp, stamp + 6 * HOUR, now);
  assert.equal(summary.rain3h, 6);
  assert.equal(summary.stormRainOverlap, true);
  assert.equal(summary.stormRainWindOverlap, true);
  assert.equal(summary.probability, null);
});
