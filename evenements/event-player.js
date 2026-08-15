(() => {
  const dayStart = Date.parse("2026-08-04T00:00:00+02:00");
  const hailStart = Date.parse("2026-08-04T16:40:00+02:00");
  const hailEnd = Date.parse("2026-08-04T17:10:00+02:00");
  const minute = 60_000;
  const state = { minuteOfDay: 1000, data: null, applyDashboardPayload: null };
  const dataPromise = Promise.all([
    fetch("data/2026-08-04-grele-les-tatins.json", { cache: "no-store" }),
    fetch("data/2026-08-04-grele-les-tatins-radar.json", { cache: "no-store" })
  ]).then(async responses => {
    if (responses.some(response => !response.ok)) throw new Error("Archive de l’événement indisponible");
    const [data, radar] = await Promise.all(responses.map(response => response.json()));
    state.data = data;
    state.radar = radar;
    return data;
  });

  const currentTime = () => dayStart + state.minuteOfDay * minute;
  const isoLocal = timestamp => {
    const date = new Date(timestamp);
    const parts = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  };
  const formatTime = timestamp => new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit"
  }).format(new Date(timestamp)).replace(":", " h ");
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

  function forecastHours(data) {
    return (data.hourly?.samples || []).map(sample => ({
      time: sample.timeLocal.slice(0, 16),
      temperature: Number(sample.temperatureC),
      apparentTemperature: Number(sample.temperatureC),
      rain: Number(sample.precipitationMm) || 0,
      precipitation: Number(sample.precipitationMm) || 0,
      showers: Number(sample.precipitationMm) || 0,
      probability: null,
      weatherCode: Number(sample.weatherCode) || 0,
      cloudiness: Number(sample.cloudCoverPct) || 0,
      windSpeed: Number(sample.windKmh) || 0,
      windDirection: Number(sample.windDirectionDeg) || 0,
      windGust: Number(sample.gustKmh) || 0
    }));
  }

  function forecastDays(hours) {
    const groups = new Map();
    hours.forEach(hour => {
      const date = hour.time.slice(0, 10);
      if (!groups.has(date)) groups.set(date, []);
      groups.get(date).push(hour);
    });
    return [...groups.entries()].map(([date, items]) => {
      const rainSum = items.reduce((sum, item) => sum + item.rain, 0);
      const strongestCode = items.reduce((code, item) => Math.max(code, item.weatherCode), 0);
      return {
        date,
        time: date,
        weatherCode: strongestCode,
        temperatureMax: Math.max(...items.map(item => item.temperature)),
        temperatureMin: Math.min(...items.map(item => item.temperature)),
        apparentTemperatureMax: Math.max(...items.map(item => item.apparentTemperature)),
        apparentTemperatureMin: Math.min(...items.map(item => item.apparentTemperature)),
        precipitationSum: rainSum,
        rainSum,
        showersSum: rainSum,
        precipitationProbabilityMax: null,
        cloudCover: Math.round(items.reduce((sum, item) => sum + item.cloudiness, 0) / items.length),
        windSpeedMax: Math.max(...items.map(item => item.windSpeed)),
        windGustMax: Math.max(...items.map(item => item.windGust)),
        windDirection: 0,
        sunrise: `${date}T06:25`,
        sunset: `${date}T21:00`
      };
    });
  }

  function quarterHours(hours) {
    return hours.flatMap(hour => Array.from({ length: 4 }, (_, index) => ({
      time: isoLocal(Date.parse(`${hour.time}:00+02:00`) + index * 15 * minute),
      precipitation: hour.precipitation / 4,
      rain: hour.rain / 4,
      showers: hour.showers / 4,
      weatherCode: hour.weatherCode
    })));
  }

  function radarPayload(timestamp) {
    const frames = state.radar?.frames || [];
    const frame = [...frames].reverse().find(item => Date.parse(item.observedAt) <= timestamp)
      || frames[0]
      || null;
    const inArchiveWindow = frame && Math.abs(timestamp - Date.parse(frame.observedAt)) <= 10 * minute;
    const cells = inArchiveWindow ? frame.cells : [];
    return {
      fetchedAt: new Date().toISOString(),
      dataUpdatedAt: inArchiveWindow ? frame.observedAt : new Date(timestamp).toISOString(),
      observedAt: inArchiveWindow ? frame.observedAt : new Date(timestamp).toISOString(),
      source: "Météo-France Open Data · archive radar Meteociel 5 min",
      frames: [],
      quality: inArchiveWindow ? "archive" : "outside-local-window",
      currentPrecipitation: inArchiveWindow ? frame.currentPrecipitation : null,
      nearestRainKm: inArchiveWindow ? frame.nearestRainKm : null,
      etaSeconds: null,
      trend: "stable",
      trendRatio: null,
      riskTrend: "stable",
      motion: null,
      threat: inArchiveWindow && frame.threatId ? { id: frame.threatId } : null,
      cells,
      disappearedCells: [],
      mapRadiusKm: 60,
      values: []
    };
  }

  function dashboard(data) {
    const timestamp = currentTime();
    const hours = forecastHours(data);
    const openMeteo = {
      fetchedAt: new Date().toISOString(),
      model: "Archive Open‑Meteo disponible le 4 août 2026",
      hours,
      minutely15: quarterHours(hours),
      days: forecastDays(hours)
    };
    return {
      status: "ready",
      data: {
        openMeteo,
        lightning: null,
        radar: radarPayload(timestamp),
        piaf: null,
        arome: null,
        pearome: null,
        ensemble: null,
        vigilance: null
      }
    };
  }

  function openMeteoApi(data) {
    const hours = forecastHours(data);
    const days = forecastDays(hours);
    return {
      latitude: data.event.location.latitude,
      longitude: data.event.location.longitude,
      timezone: "Europe/Paris",
      hourly: {
        time: hours.map(item => item.time),
        temperature_2m: hours.map(item => item.temperature),
        apparent_temperature: hours.map(item => item.apparentTemperature),
        precipitation: hours.map(item => item.precipitation),
        rain: hours.map(item => item.rain),
        showers: hours.map(item => item.showers),
        precipitation_probability: hours.map(() => null),
        weather_code: hours.map(item => item.weatherCode),
        cloud_cover: hours.map(item => item.cloudiness),
        wind_speed_10m: hours.map(item => item.windSpeed),
        wind_direction_10m: hours.map(item => item.windDirection),
        wind_gusts_10m: hours.map(item => item.windGust)
      },
      daily: {
        time: days.map(item => item.date),
        weather_code: days.map(item => item.weatherCode),
        temperature_2m_max: days.map(item => item.temperatureMax),
        temperature_2m_min: days.map(item => item.temperatureMin),
        apparent_temperature_max: days.map(item => item.apparentTemperatureMax),
        apparent_temperature_min: days.map(item => item.apparentTemperatureMin),
        precipitation_sum: days.map(item => item.precipitationSum),
        rain_sum: days.map(item => item.rainSum),
        showers_sum: days.map(item => item.showersSum),
        precipitation_probability_max: days.map(() => null),
        cloud_cover_mean: days.map(item => item.cloudCover),
        wind_speed_10m_max: days.map(item => item.windSpeedMax),
        wind_gusts_10m_max: days.map(item => item.windGustMax),
        wind_direction_10m_dominant: days.map(item => item.windDirection),
        sunrise: days.map(item => item.sunrise),
        sunset: days.map(item => item.sunset)
      }
    };
  }

  function updateController() {
    const timestamp = currentTime();
    const output = document.querySelector("#selected-time");
    const note = document.querySelector("#event-replay-state");
    const progress = document.querySelector(".event-replay-progress");
    const cursor = document.querySelector(".event-replay-cursor");
    const percent = state.minuteOfDay / 1439 * 100;
    if (output) output.textContent = formatTime(timestamp);
    if (progress) progress.style.width = `${percent}%`;
    if (cursor) cursor.style.left = `${percent}%`;
    if (note) note.textContent = timestamp < hailStart ? "Avant l’épisode observé" : timestamp <= hailEnd ? "Pendant l’épisode observé" : "Après l’épisode observé";
  }

  async function render() {
    const data = await dataPromise;
    updateController();
    state.applyDashboardPayload?.(dashboard(data));
  }

  window.METEO_REPLAY = {
    currentTime,
    async request(url) {
      const data = await dataPromise;
      if (/api\/config/.test(url)) return { status: "ready", data: { location: data.event.location } };
      if (/api\/dashboard/.test(url)) return dashboard(data);
      if (/api\/week/.test(url)) return { status: "error", error: "Prévision Météo‑France semaine non archivée" };
      if (/api\.open-meteo\.com/.test(url)) return openMeteoApi(data);
      if (/ensemble-api\.open-meteo\.com/.test(url)) throw new Error("Ensemble Open‑Meteo non archivé");
      throw new Error(`Source non archivée pour la relecture : ${url}`);
    },
    async start({ applyDashboardPayload }) {
      state.applyDashboardPayload = applyDashboardPayload;
      const slider = document.querySelector("#day-position");
      if (slider) {
        state.minuteOfDay = Number(slider.value);
        slider.addEventListener("input", () => {
          state.minuteOfDay = clamp(Number(slider.value), 0, 1439);
          render();
        });
      }
      await render();
    }
  };
})();
