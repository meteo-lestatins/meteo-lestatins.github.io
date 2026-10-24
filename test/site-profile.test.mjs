import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSiteProfile } from '../sites/profiles.mjs';
import { siteProfile } from './site-fixture.mjs';
import { publicWeatherFiles } from '../weather/state.mjs';
import { restorePublishedWeather } from '../weather/published-state.mjs';

const input = () => {
  const { id, name, place, latitude, longitude, department, timezone, headerAltitude } = siteProfile();
  return { id, name, place, latitude, longitude, department, timezone, headerAltitude };
};

test('le profil externe conserve les paramètres du lieu et les fonctions du socle', () => {
  const profile = normalizeSiteProfile({ ...input(), id: 'exemple', headingPrefix: 'Bulletin', publicUrl: 'https://weather.example/bulletin' });
  assert.equal(profile.id, 'exemple');
  assert.equal(profile.publicUrl, 'https://weather.example/bulletin/');
  assert.equal(profile.forecastDays, 16);
  assert.equal(profile.features.nowcasting, false);
});

test('le profil refuse coordonnées, fuseau, secrets et modules non pris en charge', () => {
  for (const changes of [
    { latitude: null }, { latitude: 91 }, { longitude: -181 },
    { timezone: 'invalide' }, { headerAltitude: '100' }, { id: '../autre' },
    { token: 'inattendu' }, { features: { radar: true } },
    { publicUrl: 'http://weather.example/' }, { publicUrl: 'https://user:secret@weather.example/' }
  ]) assert.throws(() => normalizeSiteProfile({ ...input(), ...changes }));
});

test('la restauration utilise uniquement l’adresse publique du lieu, sans transmettre de secret', async () => {
  const profile = normalizeSiteProfile({ ...input(), publicUrl: 'https://weather.example/bulletin/' });
  const data = { siteId: profile.id, latitude: profile.latitude, longitude: profile.longitude,
    piaf: { fetchedAt: 100, values: [{ seconds: 300, precipitation: .1 }] } };
  const files = publicWeatherFiles(profile, data);
  const calls = [];
  const result = await restorePublishedWeather({ profile, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return { ok: true, json: async () => files[new URL(url).pathname.split('/').at(-1)] };
  } });
  assert.equal(result.entry.piaf.fetchedAt, 100);
  assert.equal(calls.length, 2);
  for (const { url, options } of calls) {
    assert.equal(new URL(url).origin, 'https://weather.example');
    assert.ok(new URL(url).pathname.startsWith('/bulletin/data/'));
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers, undefined);
  }
});

test('la restauration refuse les données d’un autre lieu et conserve le cache si la source est en panne', async () => {
  const profile = normalizeSiteProfile({ ...input(), publicUrl: 'https://weather.example/' });
  await assert.rejects(restorePublishedWeather({ profile, fetchImpl: async () => ({
    ok: true, json: async () => ({ data: { latitude: 0, longitude: 0 } })
  }) }), /autre lieu/);
  const cached = { siteId: profile.id, latitude: profile.latitude, longitude: profile.longitude };
  const result = await restorePublishedWeather({ profile, entry: cached, fetchImpl: async () => { throw new Error('panne'); } });
  assert.deepEqual(result.entry, cached);
  assert.equal(result.warnings.length, 2);
});
