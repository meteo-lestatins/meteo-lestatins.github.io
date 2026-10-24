import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSiteProfile } from '../sites/profiles.mjs';
import { createForecastCollectors } from '../weather/collectors.mjs';
import { createWeatherHttpClient } from '../weather/http-client.mjs';
import { sourceDue } from '../weather/state.mjs';
import { collectOpenMeteo } from '../weather/open-meteo.mjs';

export async function collectWeather({ profile, entry = {}, token, group = 'all', checkpoint = async () => {}, onRequest, collectors: injected }) {
  if (!Number.isFinite(profile.latitude) || Math.abs(profile.latitude) > 90 || !Number.isFinite(profile.longitude) || Math.abs(profile.longitude) > 180) throw new Error('Les coordonnées du lieu doivent être renseignées avant la collecte.');
  if (!['all', 'piaf', 'forecast'].includes(group)) throw new Error('Groupe de collecte inconnu.');
  if (entry.siteId && (entry.siteId !== profile.id || entry.latitude !== profile.latitude || entry.longitude !== profile.longitude)) throw new Error('Le cache appartient à un autre lieu.');
  entry = { ...entry, siteId: profile.id, latitude: profile.latitude, longitude: profile.longitude };
  const config = {
    ...(injected ? {} : createWeatherHttpClient({ token, onRequest, limits: { pearome: 500, pearpege: 40 } })),
    aromeWcs: 'https://public-api.meteofrance.fr/public/arome/1.0/wcs/MF-NWP-HIGHRES-AROME-001-FRANCE-WCS',
    arpegeWcs: 'https://public-api.meteofrance.fr/public/arpege/1.0/wcs/MF-NWP-GLOBAL-ARPEGE-005-EURAT-WCS',
    piafWcs: 'https://api.meteofrance.fr/pro/piaf/1.0/wcs/MF-NWP-HIGHRES-PIAF-001-FRANCE-WCS',
    pearomeWcs: m => `https://public-api.meteofrance.fr/public/pearome/1.0/wcs/MF-NWP-HIGHRES-PEARO${String(m).padStart(3, '0')}-0025-FRANCE-WCS`,
    pearpegeWcs: m => `https://public-api.meteofrance.fr/public/pearpege/1.0/wcs/MF-NWP-GLOBAL-PEARP${String(m).padStart(3, '0')}-01-EUROPE-WCS`,
    vigilanceUrl: 'https://public-api.meteofrance.fr/public/DPVigilance/v1/cartevigilance/encours',
    aromeApiKey: token, piafApiKey: token, arpegeApiKey: token, pearomeApiKey: token, pearpegeApiKey: token, vigilanceToken: token,
    vigilanceDepartment: profile.department, pearomeConcurrency: 8,
    cacheExpired: (v, ttl) => !v || Date.now() - v.fetchedAt > ttl,
    savePersisted: () => checkpoint(entry)
  };
  const api = injected || createForecastCollectors(config);
  const state = { done: 0, total: 0 };
  const errors = [];
  const jobs = [
    ['openMeteo', 'openMeteo', () => { onRequest?.('openMeteo'); return injected ? api.buildOpenMeteo(profile) : collectOpenMeteo(profile); }],
    ['piaf', 'piaf', () => api.buildPiaf(profile.latitude, profile.longitude, state)],
    ['arome', 'arome', () => api.buildArome(profile.latitude, profile.longitude, state)],
    ['arpegeWeek', 'arpege', () => api.buildArpegeWeek(profile.latitude, profile.longitude, state, entry.arpegeWeek)],
    ['pearome', 'pearome', () => api.buildPearome(profile.latitude, profile.longitude, state, entry.pearome, entry.arome)],
    ['ensemble', 'pearome', () => api.buildPearomeEnsemble(profile.latitude, profile.longitude, state, entry, entry.pearome)],
    ['vigilance', 'vigilance', () => api.buildVigilance()]
  ];
  for (const [name, feature, run] of jobs) {
    if (name === 'vigilance' && !profile.department) continue;
    if ((group === 'piaf' && name !== 'piaf') || (group === 'forecast' && name === 'piaf') || !profile.features[feature] || !sourceDue(name, entry)) continue;
    if (name === 'ensemble' && !entry.pearome) continue;
    try {
      const value = await run();
      if (value) entry[name] = value;
      await checkpoint(entry);
    } catch (error) { errors.push({ source: name, message: String(error.message).split(token || '\0').join('[masqué]') }); }
  }
  return { entry, errors };
}

async function main() {
  const arg = (name, fallback) => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
  const profile = await readSiteProfile(arg('profile'));
  const input = path.resolve(arg('state', `.cache/weather/${profile.id}.json`));
  const output = path.resolve(arg('output', `.cache/weather-updates/${profile.id}.json`));
  const previous = await readFile(input, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return {}; throw error; });
  await mkdir(path.dirname(output), { recursive: true });
  const requests = {};
  const started = Date.now();
  const checkpoint = async entry => {
    await writeFile(output + '.tmp', JSON.stringify(entry));
    await rename(output + '.tmp', output);
  };
  const result = await collectWeather({ profile, entry: previous, token: process.env.METEO_FRANCE_API_KEY, group: arg('group', 'all'), checkpoint, onRequest: bucket => { requests[bucket] = (requests[bucket] || 0) + 1; } });
  await checkpoint(result.entry);
  console.log(JSON.stringify({ site: profile.id, requests, elapsedSeconds: Math.round((Date.now() - started) / 1000), errors: result.errors }));
  if (result.errors.length) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
