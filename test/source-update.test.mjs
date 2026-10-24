import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { updateSource } from '../scripts/update-source.mjs';

test('shared source updates retain configuration, are repeatable and stop on conflicts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bulletin-inheritance-'));
  const source = path.join(root, 'source');
  const site = path.join(root, 'site');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  const identity = cwd => {
    git(cwd, 'config', 'user.name', 'Test');
    git(cwd, 'config', 'user.email', 'test@example.invalid');
    git(cwd, 'config', 'core.autocrlf', 'false');
  };
  const commit = (cwd, message) => { git(cwd, 'add', '.'); git(cwd, 'commit', '-m', message); };
  try {
    await mkdir(source);
    git(source, 'init', '-b', 'main');
    identity(source);
    await writeFile(path.join(source,'app.js'), 'version 1\n');
    commit(source,'initial source');
    git(root, '-c', 'core.autocrlf=false', 'clone', source, site);
    identity(site);
    const profile = '{"id":"example","latitude":48.8566,"longitude":2.3522}\n';
    await writeFile(path.join(site,'site.json'),profile);
    commit(site,'local configuration');
    await writeFile(path.join(source,'app.js'),'version 2\n');
    commit(source,'common improvement');
    const updated = await updateSource({ cwd: site, source });
    assert.notEqual(updated.before, updated.after);
    assert.equal(await readFile(path.join(site,'site.json'),'utf8'),profile);
    assert.equal(await readFile(path.join(site,'app.js'),'utf8'),'version 2\n');
    assert.equal(git(site,'status','--porcelain'),'');
    const repeated = await updateSource({ cwd: site, source });
    assert.equal(repeated.before,repeated.after);
    await writeFile(path.join(source,'app.js'),'version upstream\n');
    commit(source,'upstream change');
    await writeFile(path.join(site,'app.js'),'version local\n');
    commit(site,'local divergence');
    const before = git(site,'rev-parse','HEAD');
    await assert.rejects(updateSource({ cwd: site, source }));
    assert.equal(git(site,'rev-parse','HEAD'),before);
    assert.equal(git(site,'status','--porcelain'),'');
    assert.equal(await readFile(path.join(site,'site.json'),'utf8'),profile);
  } finally { await rm(root,{ recursive:true,force:true }); }
});

test('configuration from upstream cannot replace the local profile', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bulletin-profile-'));
  const git = (cwd,...args) => execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const source = path.join(root,'source'), site=path.join(root,'site');
  try {
    await mkdir(source);
    git(source,'init','-b','main');
    git(source,'config','user.name','Test');
    git(source,'config','user.email','test@example.invalid');
    await writeFile(path.join(source,'app.js'),'initial');
    git(source,'add','.');git(source,'commit','-m','source');
    git(root,'-c','core.autocrlf=false','clone',source,site);
    git(site,'config','user.name','Test');git(site,'config','user.email','test@example.invalid');
    await writeFile(path.join(site,'site.json'),'local');
    git(site,'add','.');git(site,'commit','-m','profile');
    await writeFile(path.join(source,'site.json'),'upstream');
    git(source,'add','.');git(source,'commit','-m','upstream profile');
    const before=git(site,'rev-parse','HEAD');
    await assert.rejects(updateSource({cwd:site,source}));
    assert.equal(git(site,'rev-parse','HEAD'),before);
    assert.equal(await readFile(path.join(site,'site.json'),'utf8'),'local');
    await writeFile(path.join(site,'app.js'),'uncommitted');
    await assert.rejects(updateSource({cwd:site,source}),/modifications locales/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
