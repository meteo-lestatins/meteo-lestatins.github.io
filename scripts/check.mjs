import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (/\.(?:mjs|js)$/.test(file)) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  }
}
for (const directory of ['scripts', 'sites', 'weather', 'test']) await walk(path.join(root, directory));
for (const file of ['async-pool.mjs', 'public/app.js', 'public/admin.js', 'public/admin-api.js', 'public/daily-rows.js', 'public/forecast-core.js', 'public/service-worker.js', 'public/nowcast/engine.js', 'public/nowcast/map.js']) {
  execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
}
console.log('Syntaxe vérifiée.');
