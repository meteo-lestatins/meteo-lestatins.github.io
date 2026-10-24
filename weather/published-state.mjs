import { mergeWeatherState } from './state.mjs';

// Restauration depuis l'adresse publique de l'installation, sans jeton d'API.
export async function restorePublishedWeather({ profile, entry = {}, fetchImpl = fetch }) {
  if (!profile.publicUrl) return { entry, warnings: [] };
  const base = new URL('data/', profile.publicUrl);
  if (base.protocol !== 'https:') throw new Error('Restauration publique HTTPS requise.');
  const warnings = [];
  const get = async name => {
    try {
      const url = new URL(name, base);
      url.searchParams.set('restore', String(Date.now()));
      const response = await fetchImpl(url, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.json();
    } catch {
      warnings.push(name + ' inaccessible ; conservation des acquisitions en cache.');
      return null;
    }
  };
  const [dashboard, week] = await Promise.all([get('dashboard.json'), get('week.json')]);
  const data = dashboard?.data;
  if (!data) return { entry, warnings };
  if (data.latitude !== profile.latitude || data.longitude !== profile.longitude) throw new Error('Les données publiques correspondent à un autre lieu.');
  const incoming = { ...data, siteId: profile.id, latitude: profile.latitude, longitude: profile.longitude };
  if (week?.data) incoming.arpegeWeek = week.data;
  return { entry: mergeWeatherState(entry, incoming), warnings };
}
