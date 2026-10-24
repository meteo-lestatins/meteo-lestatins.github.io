import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const upstreamUrl = 'https://github.com/nicklausFR/bulletin-local-meteo-france.git';
export async function updateSource({ cwd, source = upstreamUrl, branch = 'main' }) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const profile = await readFile(path.join(cwd, 'site.json'), 'utf8');
  if (git('status', '--porcelain')) throw new Error('Le dépôt contient des modifications locales.');
  const before = git('rev-parse', 'HEAD');
  git('fetch', '--no-tags', source, branch);
  try {
    git('merge', '--no-edit', 'FETCH_HEAD');
    if (await readFile(path.join(cwd, 'site.json'), 'utf8') !== profile) throw new Error('Le profil du site a été modifié par la source.');
  } catch (error) {
    try { git('merge', '--abort'); } catch {}
    // Only a clean checkout is accepted above; restore it if the source changed site.json.
    if (git('rev-parse', 'HEAD') !== before) git('reset', '--hard', before);
    throw new Error(error.stderr?.toString().trim() || error.stdout?.toString().trim() || error.message, { cause: error });
  }
  return { before, after: git('rev-parse', 'HEAD') };
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await updateSource({ cwd: process.cwd() });
  console.log(result.before === result.after ? 'Le code commun est déjà à jour.' : 'Code commun mis à jour ; configuration conservée.');
}
