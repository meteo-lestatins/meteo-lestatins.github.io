import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSiteProfile } from '../sites/profiles.mjs';
import { publicWeatherFiles } from '../weather/state.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'dist');
const profilePath = process.argv.find(value => value.startsWith('--profile='))?.slice(10);
const profile = await readSiteProfile(profilePath);
const statePath = process.argv.find(value => value.startsWith('--state='))?.slice(8);
const entry = statePath ? JSON.parse(await readFile(path.resolve(statePath), 'utf8')) : {};
if (statePath && (entry.siteId !== profile.id || entry.latitude !== profile.latitude || entry.longitude !== profile.longitude)) {
  throw new Error('Les données ne correspondent pas au lieu initial.');
}
const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
const version = [...changelog.matchAll(/— v(\d+\.\d{3}) —/g)].at(-1)?.[1];
if (!version) throw new Error('Version absente du journal.');
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const pageTitle = profile.headingPrefix ? profile.headingPrefix + '>' + profile.place : profile.name;
const heading = profile.headingPrefix ? escape(profile.headingPrefix) + '<span class="site-title-separator" aria-hidden="true">&gt;</span><wbr><span class="site-title-place">' + escape(profile.place) + '</span>' : escape(profile.name);
const configured = Number.isFinite(profile.latitude) && Number.isFinite(profile.longitude);
const coordinate = (value, positive, negative) => Math.abs(value).toLocaleString('fr-FR', { maximumFractionDigits: 6 }) + '° ' + (value >= 0 ? positive : negative);
const location = configured ? coordinate(profile.latitude, 'N', 'S') + ' · ' + coordinate(profile.longitude, 'E', 'O') + (Number.isFinite(profile.headerAltitude) ? ' · ' + profile.headerAltitude.toLocaleString('fr-FR') + ' m' : '') : 'Lieu à définir';
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(path.join(root, 'public'), target, { recursive: true });
for (const file of ['index.html', 'service-worker.js']) {
  const content = (await readFile(path.join(target, file), 'utf8'))
    .replaceAll('__RELEASE__', version).replaceAll('__ASSET_VERSION__', version.replaceAll('.', ''))
    .replaceAll('__SITE_TITLE__', () => escape(pageTitle)).replaceAll('__SITE_HEADING__', () => heading).replaceAll('__SITE_LOCATION__', () => location);
  await writeFile(path.join(target, file), content);
}
const manifest = JSON.parse(await readFile(path.join(target, 'manifest.webmanifest'), 'utf8'));
Object.assign(manifest, { name: profile.name, short_name: profile.place || 'Météo locale' });
await writeFile(path.join(target, 'manifest.webmanifest'), JSON.stringify(manifest));
let repository = profile.githubRepository || '';
if (!repository && profile.publicUrl) {
  const owner = new URL(profile.publicUrl).hostname.match(/^([a-z0-9-]+)\.github\.io$/i)?.[1];
  if (owner) repository = owner + '/' + owner + '.github.io';
}
let revision = '';
try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch {}
const management = { repository, branch: profile.githubBranch || 'main', revision };
const runtime = { management, apiBase: './', dataMode: 'static', site: profile, changelogUrl: 'changelog.html', releaseNumber: version };
await writeFile(path.join(target, 'runtime-config.js'), 'window.METEO_RUNTIME_CONFIG = Object.freeze(' + JSON.stringify(runtime, null, 2) + ');\n');
await mkdir(path.join(target, 'data'), { recursive: true });
for (const [file, data] of Object.entries(publicWeatherFiles(profile, entry, version))) {
  await writeFile(path.join(target, 'data', file), JSON.stringify(data));
}
const escaped = changelog.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
await writeFile(path.join(target, 'changelog.html'), '<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Historique</title><pre>' + escaped + '</pre></html>');
await writeFile(path.join(target, '.nojekyll'), '');
await writeFile(path.join(target, 'robots.txt'), 'User-agent: *\nAllow: /\n');
console.log('Base météo v' + version + ' préparée dans dist/ (aucun déploiement).');
