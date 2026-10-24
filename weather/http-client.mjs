const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function createWeatherHttpClient({ token, fetchImpl = fetch, limits = {}, onRequest = () => {} }) {
  if (!token) throw new Error('Le jeton Météo-France doit être fourni dans METEO_FRANCE_API_KEY.');
  const slots = new Map();
  async function request(url, _key, label, retries = 2, bucket = 'arome', binary = false) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const reserved = Math.max(Date.now(), slots.get(bucket) || 0);
      slots.set(bucket, reserved + 60000 / (limits[bucket] || 80));
      await wait(Math.max(0, reserved - Date.now()));
      onRequest(bucket);
      let response;
      try { response = await fetchImpl(url, { headers: { apikey: token }, signal: AbortSignal.timeout(binary ? 25000 : 20000) }); }
      catch { if (attempt < retries) { await wait(5000); continue; } throw new Error(`${label} : délai réseau dépassé.`); }
      if (response.ok) return binary ? response.arrayBuffer() : response.text();
      // Do not log response bodies or credentials, including on authentication errors.
      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        const retry = Number(response.headers.get('retry-after'));
        await wait(response.status === 429 ? Math.max(65000, Number.isFinite(retry) ? retry * 1000 : 0) : 3000);
        continue;
      }
      throw new Error(`${label} : HTTP ${response.status}.`);
    }
  }
  return {
    mfText: (...args) => request(...args),
    mfArrayBuffer: (url, key, label, retries, bucket) => request(url, key, label, retries, bucket, true)
  };
}
