export const refreshPolicy = Object.freeze({ piaf: 4 * 60000, arome: 3600000, pearome: 3 * 3600000, ensemble: 6 * 3600000, arpegeWeek: 6 * 3600000, vigilance: 30 * 60000, openMeteo: 3600000 });
export const sourceNames = Object.freeze(Object.keys(refreshPolicy));
export function sourceDue(name, entry, now = Date.now()) {
  const value = entry[name];
  if (!value || !Number.isFinite(value.fetchedAt) || now - value.fetchedAt > refreshPolicy[name]) return true;
  if (name === 'arome' && Number(value.availableHours ?? value.hours?.length ?? 0) < 42) return true;
  if (name === 'arpegeWeek' && !(new Date(value.activeDayValidUntil).getTime() > now)) return true;
  if (name === 'ensemble' && entry.pearome?.runTime !== value.runTime) return true;
  return false;
}

function cycle(value) {
  const piaf = value?.coverageId?.match(/___(\d{4}-\d{2}-\d{2}T\d{2}\.\d{2}\.\d{2}Z)/)?.[1]?.replace(/T(\d{2})\.(\d{2})\.(\d{2})Z$/, 'T$1:$2:$3Z');
  return new Date(value?.runTime || piaf || 0).getTime() || 0;
}

export function mergeWeatherState(previous = {}, incoming = {}) {
  if (previous.siteId && previous.siteId !== incoming.siteId) throw new Error('Les données de deux lieux ne peuvent pas être fusionnées.');
  if (previous.siteId && (previous.latitude !== incoming.latitude || previous.longitude !== incoming.longitude)) throw new Error('Les coordonnées ont changé : une nouvelle collecte complète est nécessaire.');
  const merged = { ...previous, siteId: incoming.siteId, latitude: incoming.latitude, longitude: incoming.longitude };
  for (const name of sourceNames) {
    const value = incoming[name], old = previous[name];
    if (!value || !Number.isFinite(value.fetchedAt)) continue;
    if (!old || (cycle(value) >= cycle(old) && value.fetchedAt >= old.fetchedAt)) merged[name] = value;
  }
  return merged;
}

export function publicWeatherFiles(profile, entry = {}, releaseNumber = '') {
  const data = { latitude: profile.latitude, longitude: profile.longitude };
  for (const key of ['piaf', 'arome', 'pearome', 'ensemble', 'vigilance']) data[key] = entry[key] || null;
  if (profile.features.openMeteo) data.openMeteo = entry.openMeteo || null;
  const week = entry.arpegeWeek || null;
  return {
    'dashboard.json': { status: data.arome || data.piaf || data.openMeteo ? 'ready' : 'loading', stage: 'Prévisions météo', data },
    'week.json': { status: week?.days?.length ? 'ready' : 'loading', ensemble: { status: 'disabled' }, history: [], data: week },
    'config.json': { latitude: profile.latitude, longitude: profile.longitude, releaseNumber, news: null }
  };
}
