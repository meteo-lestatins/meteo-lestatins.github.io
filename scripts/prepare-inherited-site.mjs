import { realpathSync } from 'node:fs';
import { readFile, writeFile, mkdir, rename, appendFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readSiteProfile } from '../sites/profiles.mjs';
import { restorePublishedWeather } from '../weather/published-state.mjs';
import { collectWeather } from './collect-weather.mjs';
import { mergeWeatherState } from '../weather/state.mjs';

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function prepareInheritedSite({
  workspace, profilePath, statePath = '.cache/weather/site.json',
  collect = false, group = 'all', updates = [], token, outputFile, fetchImpl
}) {
  if (!workspace || !profilePath) throw new Error('Dossier de travail et profil requis.');
  const profileFile = path.resolve(workspace, profilePath);
  const profile = await readSiteProfile(profileFile);
  const stateFile = path.resolve(workspace, statePath);
  const relative = path.relative(path.resolve(workspace), stateFile);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || stateFile === profileFile) throw new Error('Le cache doit rester dans le dossier de travail et être distinct du profil.');
  let entry = await readFile(stateFile, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return {}; throw error; });
  if (entry.siteId && (entry.siteId !== profile.id || entry.latitude !== profile.latitude || entry.longitude !== profile.longitude)) throw new Error('Le cache appartient à un autre lieu.');
  const restored = await restorePublishedWeather({ profile, entry, fetchImpl });
  entry = restored.entry;
  const mergeUpdates = async target => {
    const relativePath = path.relative(path.resolve(workspace), target);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) throw new Error('Les mises à jour doivent rester dans le dossier de travail.');
    const info = await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error('Lien symbolique de mise à jour refusé.');
    if (info.isDirectory()) {
      for (const name of (await readdir(target)).sort()) await mergeUpdates(path.join(target, name));
      return;
    }
    if (!info.isFile() || !target.endsWith('.json') || target === stateFile) return;
    const incoming = JSON.parse(await readFile(target, 'utf8'));
    if (incoming.siteId !== profile.id || incoming.latitude !== profile.latitude || incoming.longitude !== profile.longitude) throw new Error('Une mise à jour appartient à un autre lieu.');
    entry = mergeWeatherState(entry, incoming);
  };
  for (const update of typeof updates === 'string' ? updates.split(/\r?\n/).filter(Boolean) : updates) {
    await mergeUpdates(path.resolve(workspace, update));
  }
  const checkpoint = async value => {
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(stateFile + '.tmp', JSON.stringify(value));
    await rename(stateFile + '.tmp', stateFile);
  };
  let errors = [];
  if (collect) {
    const result = await collectWeather({ profile, entry, token, group, checkpoint });
    entry = result.entry;
    errors = result.errors;
  }
  if (!entry.siteId) entry = { ...entry, siteId: profile.id, latitude: profile.latitude, longitude: profile.longitude };
  await checkpoint(entry);
  execFileSync(process.execPath, [path.join(engineRoot, 'scripts/build.mjs'), '--profile=' + profileFile, '--state=' + stateFile], { cwd: engineRoot, stdio: 'inherit' });
  const siteDirectory = path.join(engineRoot, 'dist');
  if (outputFile) await appendFile(outputFile, 'site-directory=' + siteDirectory + '\nstate-file=' + stateFile + '\n');
  return { siteDirectory, stateFile, warnings: restored.warnings, errors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const result = await prepareInheritedSite({
    workspace: process.env.GITHUB_WORKSPACE || process.cwd(),
    profilePath: process.env.METEO_PROFILE_PATH,
    statePath: process.env.METEO_STATE_PATH || '.cache/weather/site.json',
    collect: process.env.METEO_COLLECT === 'true',
    group: process.env.METEO_GROUP || 'all',
    updates: process.env.METEO_UPDATES || '',
    token: process.env.METEO_FRANCE_API_KEY,
    outputFile: process.env.GITHUB_OUTPUT
  });
  for (const warning of result.warnings) console.warn(warning);
  if (result.errors.length) {
    console.error(JSON.stringify(result.errors));
    process.exitCode = 1;
  }
}
