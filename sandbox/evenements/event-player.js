(() => {
  const dayStart = Date.parse("2026-08-04T00:00:00+02:00");
  const hailStart = Date.parse("2026-08-04T16:40:00+02:00");
  const hailEnd = Date.parse("2026-08-04T17:10:00+02:00");
  const minute = 60_000;
  const state = { minuteOfDay: 1000, data: null, applyDashboardPayload: null };
  const dataPromise = fetch("data/2026-08-04-grele-les-tatins.json", { cache: "no-store" })
    .then(response => {
      if (!response.ok) throw new Error("Archive de l’événement indisponible");
      return response.json();
    })
    .then(data => (state.data = data));

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
  const flashesBetween = (from, to, radius = 120) => (state.data?.lightning?.flashes || [])
    .filter(flash => Date.parse(flash.t) > from && Date.parse(flash.t) <= to && Number(flash.d) <= radius);
  const centroid = flashes => flashes.length ? {
    eastKm: flashes.reduce((sum, flash) => sum + Number(flash.x), 0) / flashes.length,
    northKm: flashes.reduce((sum, flash) => sum + Number(flash.y), 0) / flashes.length
  } : null;

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

  function lightningPayload(timestamp) {
    const recent = flashesBetween(timestamp - 10 * minute, timestamp, 120);
    const counts = Object.fromEntries([20, 40, 80, 120].map(radius => [radius, recent.filter(flash => Number(flash.d) <= radius).length]));
    return {
      fetchedAt: new Date().toISOString(),
      observedFrom: new Date(timestamp - 10 * minute).toISOString(),
      observedAt: new Date(timestamp).toISOString(),
      source: "EUMETSAT MTG Lightning Imager · archive réelle",
      radiusKm: 120,
      flashCount: recent.length,
      counts,
      nearestKm: recent.length ? Math.min(...recent.map(flash => Number(flash.d))) : null,
      risk: recent.length ? (counts[20] ? 99 : counts[40] ? 76 : counts[80] ? 42 : 18) : 0,
      flashes: recent.map(flash => ({
        time: flash.t,
        eastKm: Number(flash.x),
        northKm: Number(flash.y),
        distanceKm: Number(flash.d)
      }))
    };
  }

  function connectedClusters(flashes, maximumGapKm = 12, minimumFlashes = 3) {
    const remaining = new Set(flashes.map((_, index) => index));
    const clusters = [];
    while (remaining.size) {
      const seed = remaining.values().next().value;
      remaining.delete(seed);
      const indexes = [seed];
      for (let cursor = 0; cursor < indexes.length; cursor += 1) {
        const current = flashes[indexes[cursor]];
        [...remaining].forEach(index => {
          const candidate = flashes[index];
          if (Math.hypot(Number(candidate.x) - Number(current.x), Number(candidate.y) - Number(current.y)) <= maximumGapKm) {
            remaining.delete(index);
            indexes.push(index);
          }
        });
      }
      if (indexes.length >= minimumFlashes) clusters.push(indexes.map(index => flashes[index]));
    }
    return clusters;
  }

  function electricalCells(timestamp) {
    const recentClusters = connectedClusters(flashesBetween(timestamp - 10 * minute, timestamp, 80));
    const previousClusters = connectedClusters(flashesBetween(timestamp - 20 * minute, timestamp - 10 * minute, 80));
    const previousCentres = previousClusters.map(flashes => ({ flashes, ...centroid(flashes) }));
    return recentClusters.map(flashes => {
      const centre = centroid(flashes);
      const spread = Math.sqrt(flashes.reduce((sum, flash) => sum + (Number(flash.x) - centre.eastKm) ** 2 + (Number(flash.y) - centre.northKm) ** 2, 0) / flashes.length);
      const radiusKm = clamp(spread * 1.35, 4, 14);
      const previous = previousCentres
        .map(candidate => ({ ...candidate, gap: Math.hypot(candidate.eastKm - centre.eastKm, candidate.northKm - centre.northKm) }))
        .filter(candidate => candidate.gap <= 30)
        .sort((left, right) => left.gap - right.gap)[0] || null;
      const velocityEast = previous ? (centre.eastKm - previous.eastKm) / 10 : 0;
      const velocityNorth = previous ? (centre.northKm - previous.northKm) / 10 : 0;
      const speedKmh = Math.hypot(velocityEast, velocityNorth) * 60;
      const points = [0, 15, 30, 45, 60].map(minutesAhead => ({
        minutes: minutesAhead,
        eastKm: centre.eastKm + velocityEast * minutesAhead,
        northKm: centre.northKm + velocityNorth * minutesAhead,
        uncertaintyKm: radiusKm + minutesAhead * (previous ? .08 : .2)
      }));
      const closest = Math.min(...points.map(point => Math.hypot(point.eastKm, point.northKm)));
      const passage = closest - radiusKm > 60 ? 0 : clamp(Math.round(100 - Math.max(0, closest - radiusKm) * 2), 5, 95);
      return {
        eastKm: centre.eastKm,
        northKm: centre.northKm,
        radiusKm,
        areaKm2: Math.PI * radiusKm ** 2,
        trackedSince: new Date(timestamp - (previous ? 20 : 10) * minute).toISOString(),
        source: "Cellule électrique LI EUMETSAT",
        flashCount: flashes.length,
        etaMinutes: null,
        risks: {
          passage,
          storm: clamp(Math.round(25 + flashes.length * 4), 30, 100),
          hail: 0,
          intenseRain: 0
        },
        track: {
          points,
          speedKmh,
          confidence: previous ? clamp(45 + flashes.length * 3, 50, 90) : 30
        }
      };
    }).sort((left, right) => Number(right.risks.passage) - Number(left.risks.passage) || Math.hypot(left.eastKm, left.northKm) - Math.hypot(right.eastKm, right.northKm))
      .map((cell, index) => ({ ...cell, id: `LI-${String.fromCharCode(65 + index)}` }));
  }

  function radarPlaceholder(timestamp, lightning) {
    const cells = electricalCells(timestamp);
    return {
      fetchedAt: new Date().toISOString(),
      dataUpdatedAt: new Date(timestamp).toISOString(),
      observedAt: new Date(timestamp).toISOString(),
      source: "Cellules électriques reconstituées depuis l’archive réelle EUMETSAT LI · radar/PIAF non archivés",
      frames: [],
      quality: "unavailable",
      currentPrecipitation: null,
      nearestRainKm: null,
      etaSeconds: null,
      trend: "unknown",
      trendRatio: null,
      riskTrend: "stable",
      motion: null,
      threat: cells[0] ? { id: cells[0].id } : null,
      cells,
      disappearedCells: [],
      mapRadiusKm: 60,
      values: [],
      lightningOnly: true
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
    const lightning = lightningPayload(timestamp);
    return {
      status: "ready",
      data: {
        openMeteo,
        lightning,
        radar: radarPlaceholder(timestamp, lightning),
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
