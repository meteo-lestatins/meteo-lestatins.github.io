// Public forecast: no Météo-France credential is sent to this service.
export async function collectOpenMeteo(profile, { fetchImpl = fetch } = {}) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  for (const [key, value] of Object.entries({
    latitude: profile.latitude, longitude: profile.longitude, timezone: profile.timezone,
    forecast_days: 16, timeformat: 'unixtime', wind_speed_unit: 'kmh', temporal_resolution: 'hourly', cell_selection: 'land',
    hourly: 'temperature_2m,precipitation,rain,showers,snowfall,precipitation_probability,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day'
  })) url.searchParams.set(key, String(value));
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`Open-Meteo : HTTP ${response.status}.`);
  const data = await response.json();
  const hourly = data.hourly;
  if (!Array.isArray(hourly?.time) || !hourly.time.length) throw new Error('Open-Meteo : prévisions horaires absentes.');
  const fields = { temperature: 'temperature_2m', rain: 'precipitation', probability: 'precipitation_probability',
    weatherCode: 'weather_code', cloudCover: 'cloud_cover', windSpeed: 'wind_speed_10m',
    windDirection: 'wind_direction_10m', windGust: 'wind_gusts_10m', isDay: 'is_day', snowfall: 'snowfall' };
  const hours = hourly.time.map((time, index) => ({
    time: new Date(time * 1000).toISOString(),
    ...Object.fromEntries(Object.entries(fields).map(([key, field]) => [key,
      Number.isFinite(hourly[field]?.[index]) ? hourly[field][index] : null])),
    liquidRain: Number.isFinite(hourly.rain?.[index]) && Number.isFinite(hourly.showers?.[index])
      ? Math.max(0, hourly.rain[index]) + Math.max(0, hourly.showers[index]) : null,
    snowfallMethod: 'provider-estimate'
  }));
  if (!hours.some(hour => hour.temperature !== null)) throw new Error('Open-Meteo : températures absentes.');
  return { fetchedAt: Date.now(), model: 'Open-Meteo · sélection automatique', forecastDays: 16,
    rainResolution: 'hourly-interpolated', location: { requestedLatitude: profile.latitude, requestedLongitude: profile.longitude,
      gridLatitude: Number.isFinite(data.latitude) ? data.latitude : null, gridLongitude: Number.isFinite(data.longitude) ? data.longitude : null,
      elevation: Number.isFinite(data.elevation) ? data.elevation : null }, hours };
}
