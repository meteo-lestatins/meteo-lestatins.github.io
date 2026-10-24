import { fromArrayBuffer } from "geotiff";
import { mapPool } from "../async-pool.mjs";
import { nativeSnowAmounts } from './precipitation.mjs';

// Shared by the live server and scheduled static-site collection. No server startup or secrets on import.
export const vigilancePhenomena = {
  1: "Vent violent", 2: "Pluie-inondation", 3: "Orages", 4: "Crues", 5: "Neige-verglas",
  6: "Canicule", 7: "Grand froid", 8: "Avalanches", 9: "Vagues-submersion"
};
export const vigilanceColors = { 1: "vert", 2: "jaune", 3: "orange", 4: "rouge" };
export const vigilanceTimelineColors = { 1: "vert", 2: "jaune", 3: "orange", 4: "rouge" };

export function parseRunTime(coverageId) {
  const raw = coverageId?.match(/___(\d{4}-\d{2}-\d{2}T\d{2}\.\d{2}\.\d{2}Z)/)?.[1];
  return raw ? new Date(raw.replace(/T(\d{2})\.(\d{2})\.(\d{2})Z$/, "T$1:$2:$3Z")) : null;
}

export function coverageIds(xml) {
  return xml.split("<wcs:CoverageId>").slice(1).map(part => part.split("</wcs:CoverageId>")[0]);
}

export function selectLatest(ids, prefix, suffix = "") {
  return ids.map(id => ({ id, run: parseRunTime(id) }))
    .filter(item => item.id.startsWith(prefix) && (!suffix || item.id.endsWith(suffix)) && item.run && item.run.getTime() <= Date.now() + 5 * 60000)
    .sort((a, b) => a.run - b.run)
    .at(-1);
}

export function selectRun(ids, prefix, run, suffix = "") {
  const runTime = run?.getTime();
  return ids.map(id => ({ id, run: parseRunTime(id) }))
    .find(item => item.id.startsWith(prefix) && (!suffix || item.id.endsWith(suffix)) && item.run?.getTime() === runTime);
}

export function pointUrl(base, coverageId, lat, lon, leadSeconds, height) {
  const url = new URL(`${base}/GetCoverage`);
  [["service", "WCS"], ["version", "2.0.1"], ["coverageid", coverageId]].forEach(([key, value]) => url.searchParams.set(key, value));
  [`long(${lon})`, `lat(${lat})`, height != null ? `height(${height})` : null, `time(${leadSeconds})`]
    .filter(Boolean).forEach(value => url.searchParams.append("subset", value));
  return url;
}

export function tupleValue(xml) {
  const value = Number(xml.match(/<gml:tupleList>\s*([^<\s]+)/)?.[1]);
  if (!Number.isFinite(value)) throw new Error("Valeur numérique absente dans la réponse WCS.");
  return value;
}

export function setStage(state, stage, total) {
  state.stage = stage;
  state.done = 0;
  state.total = total;
  state.error = null;
}

export function meteoconName(time, rain, cloud) {
  const hour = new Date(time).toLocaleString("fr-FR", { hour: "numeric", hour12: false, timeZone: "Europe/Paris" });
  const period = Number(hour) < 7 || Number(hour) >= 21 ? "night" : "day";
  if (rain >= 10) return `extreme-${period}-rain`;
  let icon;
  if (cloud >= 75) icon = `overcast-${period}`;
  else if (cloud >= 45) icon = `partly-cloudy-${period}`;
  else if (cloud >= 15 || rain >= 0.01) icon = `mostly-clear-${period}`;
  else icon = `clear-${period}`;
  if (rain >= 0.5) return `${icon}-rain`;
  if (rain >= 0.01) return `${icon}-drizzle`;
  return icon;
}

export function parisDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function parisDateTimeKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

export function forecastParisDates(count = 4) {
  const dates = [];
  for (let day = 0; dates.length < count && day <= count + 3; day++) {
    const key = parisDateKey(Date.now() + day * 86400000);
    if (!dates.includes(key)) dates.push(key);
  }
  return dates;
}

export function parisLocalTime(date, hour, minute = 0) {
  const assumedUtc = Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    hourCycle: "h23", timeZone: "Europe/Paris"
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(assumedUtc)).map(part => [part.type, part.value]));
  const representedAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return assumedUtc - (representedAsUtc - assumedUtc);
}

export function noaaSunTimes(date, latitudeDegrees, longitudeDegrees) {
  const radians = Math.PI / 180;
  const day = 86400000;
  const julian1970 = 2440588;
  const julian2000 = 2451545;
  const toJulian = value => value.valueOf() / day - .5 + julian1970;
  const fromJulian = value => new Date((value + .5 - julian1970) * day);
  const days = toJulian(date) - julian2000;
  const longitudeWest = -Number(longitudeDegrees) * radians;
  const latitude = Number(latitudeDegrees) * radians;
  const cycle = Math.round(days - .0009 - longitudeWest / (2 * Math.PI));
  const transitApproximation = .0009 + longitudeWest / (2 * Math.PI) + cycle;
  const meanAnomaly = radians * (357.5291 + .98560028 * transitApproximation);
  const equationCenter = radians * (1.9148 * Math.sin(meanAnomaly) + .02 * Math.sin(2 * meanAnomaly) + .0003 * Math.sin(3 * meanAnomaly));
  const eclipticLongitude = meanAnomaly + equationCenter + radians * 102.9372 + Math.PI;
  const solarTransit = julian2000 + transitApproximation + .0053 * Math.sin(meanAnomaly) - .0069 * Math.sin(2 * eclipticLongitude);
  const declination = Math.asin(Math.sin(eclipticLongitude) * Math.sin(radians * 23.4397));
  const altitude = -.833 * radians;
  const hourAngle = Math.acos((Math.sin(altitude) - Math.sin(latitude) * Math.sin(declination)) / (Math.cos(latitude) * Math.cos(declination)));
  const setApproximation = .0009 + (hourAngle + longitudeWest) / (2 * Math.PI) + cycle;
  const sunsetJulian = julian2000 + setApproximation + .0053 * Math.sin(meanAnomaly) - .0069 * Math.sin(2 * eclipticLongitude);
  return { sunrise: fromJulian(solarTransit - (sunsetJulian - solarTransit)), sunset: fromJulian(sunsetJulian) };
}

export function forecastPeriodKey(time) {
  const hour = Number(parisDateTimeKey(new Date(time)).slice(11, 13));
  return hour < 6 ? "night" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
}

export function coverageTimeSeconds(xml) {
  return [...xml.matchAll(/<gmlrgrid:coefficients>([\s\S]*?)<\/gmlrgrid:coefficients>/g)]
    .map(match => match[1].trim().split(/\s+/).map(Number).filter(Number.isFinite))
    .sort((a, b) => b.length - a.length)[0] || [];
}

export function describeCoverageUrl(base, coverageId) {
  const url = new URL(`${base}/DescribeCoverage`);
  [["service", "WCS"], ["version", "2.0.1"], ["coverageid", coverageId]].forEach(([key, value]) => url.searchParams.set(key, value));
  return url;
}

export function fullFieldUrl(base, coverageId, leadSeconds, height) {
  const url = new URL(`${base}/GetCoverage`);
  [["service", "WCS"], ["version", "2.0.1"], ["coverageid", coverageId], ["format", "image/tiff"]]
    .forEach(([key, value]) => url.searchParams.set(key, value));
  [height != null ? `height(${height})` : null, `time(${leadSeconds})`].filter(Boolean)
    .forEach(value => url.searchParams.append("subset", value));
  return url;
}

export async function geotiffPointValue(buffer, lon, lat) {
  const tiff = await fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  const [minLon, minLat, maxLon, maxLat] = image.getBoundingBox();
  const width = image.getWidth();
  const height = image.getHeight();
  const x = Math.max(0, Math.min(width - 1, Math.round((lon - minLon) / (maxLon - minLon) * (width - 1))));
  const y = Math.max(0, Math.min(height - 1, Math.round((maxLat - lat) / (maxLat - minLat) * (height - 1))));
  const rasters = await image.readRasters({ window: [x, y, x + 1, y + 1] });
  const value = Number(rasters[0]?.[0]);
  if (!Number.isFinite(value)) throw new Error("Valeur GeoTIFF absente au point demandé.");
  return value;
}

export function closestLead(leads, run, targetTime) {
  return leads.reduce((closest, lead) => Math.abs(run.getTime() + lead * 1000 - targetTime) < Math.abs(run.getTime() + closest * 1000 - targetTime) ? lead : closest, leads[0]);
}

export function quantile(values, ratio) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower + 1] == null ? sorted[lower] : sorted[lower] + fraction * (sorted[lower + 1] - sorted[lower]);
}

export function arpegeWeatherCode(rain, probability, cloud) {
  if (rain >= 5) return 63;
  if (rain >= .2) return 61;
  if (probability >= 45) return 80;
  if (cloud >= 85) return 3;
  if (cloud >= 45) return 2;
  if (cloud >= 15) return 1;
  return 0;
}

export function percentile(values, ratio) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function ensembleInterval(values, scale = 1) {
  const low = percentile(values, .1);
  const high = percentile(values, .9);
  return low == null || high == null ? null : {
    low: Math.round(low * scale) / scale,
    high: Math.round(high * scale) / scale
  };
}

export function createForecastCollectors({ mfText, mfArrayBuffer, recordApiEvent = () => {}, savePersisted = async () => {}, cacheExpired, aromeWcs, arpegeWcs, piafWcs, pearomeWcs, pearpegeWcs, vigilanceUrl, aromeApiKey, arpegeApiKey, piafApiKey, pearomeApiKey, pearpegeApiKey, vigilanceToken, vigilanceDepartment = null, aromeMinimumDisplayHours = 42, aromeLightningRateThreshold = .01, aromeStormRain3hThreshold = .1, piafVersion = 3, arpegeWeekVersion = 23, arpegeWeekTtl = 21600000, pearpegeWeekEnabled = false, pearpegeMembers = 35, pearomeMembers = 25, pearomeConcurrency = 4, pearpegeConcurrency = 1 }) {
async function buildPiaf(lat, lon, state) {
  setStage(state, "PIAF · pluie à 5 minutes", 37);
  const capabilities = await mfText(`${piafWcs}/GetCapabilities?service=WCS&version=2.0.1`, piafApiKey, "PIAF", 2, "piaf");
  state.done++;
  // Le catalogue WCS n'est pas garanti dans l'ordre chronologique. Prendre
  // son dernier élément peut donc maintenir l'affichage sur un ancien run.
  const id = coverageIds(capabilities)
    .filter(value => value.endsWith("PT5M"))
    .map(value => ({ value, run: parseRunTime(value) }))
    .filter(item => item.run && item.run.getTime() <= Date.now() + 5 * 60000)
    .sort((left, right) => left.run - right.run)
    .at(-1)?.value;
  if (!id) throw new Error("Couverture PIAF PT5M introuvable.");
  const seconds = Array.from({ length: 36 }, (_, index) => (index + 1) * 300);
  const values = await mapPool(seconds, 4, async value => {
    const xml = await mfText(pointUrl(piafWcs, id, lat, lon, value), piafApiKey, `PIAF +${value / 60} min`, 2, "piaf");
    state.done++;
    // La couverture PT5M fournit déjà le cumul de la tranche de cinq minutes.
    // Le diviser par 12 sous-estimerait donc tous les cumuls PIAF d'un facteur 12.
    return { seconds: value, precipitation: tupleValue(xml) };
  });
  return { version: piafVersion, fetchedAt: Date.now(), coverageId: id, values };
}

async function buildArome(lat, lon, state) {
  setStage(state, "AROME · frise sur 48 heures", 1);
  const capabilities = await mfText(`${aromeWcs}/GetCapabilities?service=WCS&version=2.0.1&language=eng`, aromeApiKey, "AROME");
  state.done++;
  const ids = coverageIds(capabilities);
  const fieldSpecs = {
    temperature: ["TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND", ""],
    rain: ["TOTAL_PRECIPITATION__GROUND_OR_WATER_SURFACE", "_PT1H"],
    u: ["U_COMPONENT_OF_WIND__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND", ""],
    v: ["V_COMPONENT_OF_WIND__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND", ""],
    gust: ["WIND_SPEED_GUST__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND", ""],
    cloud: ["TOTAL_CLOUD_COVER__GROUND_OR_WATER_SURFACE", ""]
  };
  const candidateRuns = ids
    .filter(id => id.startsWith(fieldSpecs.temperature[0]))
    .map(parseRunTime)
    .filter(run => run && run.getTime() <= Date.now() + 5 * 60000)
    .sort((left, right) => right - left);
  let selected = null;
  let run = null;
  let describedLeads = null;
  for (const candidateRun of candidateRuns) {
    const candidate = Object.fromEntries(Object.entries(fieldSpecs).map(([name, [prefix, suffix]]) => [name, selectRun(ids, prefix, candidateRun, suffix)]));
    if (!Object.values(candidate).every(Boolean)) continue;
    const candidateEntries = Object.entries(candidate);
    let candidateLeads;
    try {
      candidateLeads = Object.fromEntries(await mapPool(candidateEntries, 4, async ([name, coverage]) => {
        const description = await mfText(describeCoverageUrl(aromeWcs, coverage.id), aromeApiKey, `AROME échéances ${name}`);
        state.done++;
        return [name, new Set(coverageTimeSeconds(description))];
      }));
    } catch (error) {
      recordApiEvent("error", "AROME run illisible ignoré", `${candidateRun.toISOString()} · ${error.message}`);
      continue;
    }
    // L'échéance de l'heure courante reste nécessaire jusqu'à la prochaine
    // heure pleine : elle alimente notamment le premier quart d'heure affiché.
    const candidateFirstLead = Math.max(0, Math.floor((Date.now() - candidateRun.getTime()) / 3600000));
    const candidateLastLead = Math.min(51, candidateFirstLead + 47);
    const candidateHourlyLeads = [...(candidateLeads.temperature || [])]
      .map(seconds => seconds / 3600)
      .filter(lead => Number.isInteger(lead) && lead >= candidateFirstLead && lead <= candidateLastLead)
      .filter(lead => ["rain", "u", "v", "gust", "cloud"].every(name => candidateLeads[name]?.has(lead * 3600)));
    if (candidateHourlyLeads.length < aromeMinimumDisplayHours) {
      recordApiEvent("error", "AROME run incomplet ignoré", `${candidateRun.toISOString()} · ${candidateHourlyLeads.length}/${aromeMinimumDisplayHours} échéances`);
      continue;
    }
    selected = candidate;
    run = candidateRun;
    describedLeads = candidateLeads;
    break;
  }
  if (!selected || !run) throw new Error("Aucun run AROME complet et cohérent n’est disponible.");
  selected.lightning = selectRun(ids, "AVERAGE_LIGHTNING_STRIKE_DENSITY_OVER_3HOURS__GROUND_OR_WATER_SURFACE", run);
  const snowCoverage = selectRun(ids, 'TOTAL_SNOW_PRECIPITATION__GROUND_OR_WATER_SURFACE', run, '_PT1H');
  let snowLeads = new Set();
  if (snowCoverage) {
    try {
      snowLeads = new Set(coverageTimeSeconds(await mfText(describeCoverageUrl(aromeWcs, snowCoverage.id), aromeApiKey, 'AROME échéances neige')));
      state.done++;
    } catch (error) { recordApiEvent('error', 'AROME échéances neige', error.message); }
  }

  const firstLeadHour = Math.max(0, Math.floor((Date.now() - run.getTime()) / 3600000));
  const lastLeadHour = Math.min(51, firstLeadHour + 47);
  let lightningLeads = null;
  if (selected.lightning) {
    try {
      const description = await mfText(describeCoverageUrl(aromeWcs, selected.lightning.id), aromeApiKey, "AROME échéances signal orage");
      state.done++;
      lightningLeads = new Set(coverageTimeSeconds(description));
    } catch (error) {
      recordApiEvent("error", "AROME échéances signal orage", error.message);
    }
  }
  const withinDisplayedRange = lead => Number.isInteger(lead) && lead >= firstLeadHour && lead <= lastLeadHour;
  const commonLeadHours = names => [...(describedLeads[names[0]] || [])]
    .map(seconds => seconds / 3600)
    .filter(withinDisplayedRange)
    .filter(lead => names.every(name => describedLeads[name]?.has(lead * 3600)))
    .sort((left, right) => left - right);
  const leadHours = commonLeadHours(["temperature", "rain", "u", "v", "gust", "cloud"]).slice(0, 48);
  if (!leadHours.length) throw new Error("Aucune échéance horaire AROME commune aux paramètres de la frise.");
  const lightningRequestCount = lightningLeads ? leadHours.filter(lead => lightningLeads.has(lead * 3600)).length : 0;
  state.total = state.done + leadHours.length * 6 + lightningRequestCount + leadHours.filter(lead => snowLeads.has(lead * 3600)).length;

  const getPoint = async (coverage, leadHour, height, label) => {
    const xml = await mfText(pointUrl(aromeWcs, coverage.id, lat, lon, leadHour * 3600, height), aromeApiKey, label);
    state.done++;
    return tupleValue(xml);
  };

  const hourlyValues = (await mapPool(leadHours, 4, async lead => {
    try {
      const [temperature, rain, u, v, gust, cloudValue] = await Promise.all([
        getPoint(selected.temperature, lead, 2, `AROME température H+${lead}`),
        getPoint(selected.rain, lead, null, `AROME pluie H+${lead}`),
        getPoint(selected.u, lead, 10, `AROME vent U H+${lead}`),
        getPoint(selected.v, lead, 10, `AROME vent V H+${lead}`),
        getPoint(selected.gust, lead, 10, `AROME rafale H+${lead}`),
        getPoint(selected.cloud, lead, null, `AROME nuages H+${lead}`)
      ]);
      const snow = snowLeads.has(lead * 3600)
        ? await getPoint(snowCoverage, lead, null, `AROME neige H+${lead}`).catch(error => {
          recordApiEvent('error', `AROME neige H+${lead}`, error.message); return null;
        }) : null;
      return { leadHour: lead, temperature, rain, snow, u, v, gust, cloud: cloudValue <= 1 ? cloudValue * 100 : cloudValue };
    } catch (error) {
      recordApiEvent("error", `AROME échéance H+${lead} ignorée`, error.message);
      return null;
    }
  })).filter(Boolean);
  const minimumHourlyValues = Math.min(aromeMinimumDisplayHours, leadHours.length);
  if (hourlyValues.length < minimumHourlyValues) throw new Error(`Prévision AROME trop incomplète : ${hourlyValues.length}/${leadHours.length} échéances horaires.`);
  const usableLeadHours = hourlyValues.map(item => item.leadHour);
  const lightningDensities = selected.lightning
    ? await mapPool(usableLeadHours, 4, async lead => {
        if (!lightningLeads?.has(lead * 3600)) return 0;
        try {
          return Math.max(0, await getPoint(selected.lightning, lead, null, `AROME signal orage H+${lead}`));
        } catch (error) {
          recordApiEvent("error", `AROME signal orage H+${lead}`, error.message);
          return 0;
        }
      })
    : usableLeadHours.map(() => 0);
  const hours = hourlyValues.map((hourly, index) => {
    const leadHour = hourly.leadHour;
    const rain = Math.max(0, hourly.rain);
    const rain3h = hourlyValues
      .filter(item => item.leadHour > leadHour - 3 && item.leadHour <= leadHour)
      .reduce((sum, item) => sum + Math.max(0, item.rain), 0);
    const lightningDensity = lightningDensities[index];
    const lightningRate = lightningDensity * 100 / 24;
    const cloud = Math.max(0, Math.min(100, hourly.cloud));
    const time = new Date(run.getTime() + leadHour * 3600000).toISOString();
    return {
      leadHour,
      time,
      temperature: Math.round((hourly.temperature - 273.15) * 10) / 10,
      windSpeed: Math.round(Math.hypot(hourly.u, hourly.v) * 3.6),
      windDirection: Math.round((Math.atan2(-hourly.u, -hourly.v) * 180 / Math.PI + 360) % 360),
      windGust: Math.round(hourly.gust * 3.6),
      cloudCover: Math.round(cloud),
      rain: Math.round(rain * 100) / 100,
      ...nativeSnowAmounts(rain, hourly.snow),
      lightningDensity,
      lightningRate: Math.round(lightningRate * 10000) / 10000,
      stormRain3h: Math.round(rain3h * 100) / 100,
      stormSignal: lightningRate >= aromeLightningRateThreshold && rain3h >= aromeStormRain3hThreshold,
      icon: meteoconName(time, rain, cloud)
    };
  });
  return { fetchedAt: Date.now(), runTime: run.toISOString(), requestedHours: 48, availableHours: hours.length, complete: hours.length >= aromeMinimumDisplayHours, hours };
}

async function buildArpegeDeterministic(lat, lon, state) {
  const forecastStart = parisDateTimeKey();
  const forecastStartDate = forecastStart.slice(0, 10);
  setStage(state, "ARPEGE · prévision déterministe sur 4 jours", 1);
  const capabilities = await mfText(`${arpegeWcs}/GetCapabilities?service=WCS&version=2.0.1&language=fre`, arpegeApiKey, "ARPEGE", 2, "arpege");
  state.done++;
  const ids = coverageIds(capabilities);
  const temperature = selectLatest(ids, "TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND");
  if (!temperature) throw new Error("Température ARPEGE indisponible.");
  const run = temperature.run;
  const selected = {
    temperature,
    u: selectRun(ids, "U_COMPONENT_OF_WIND__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND", run),
    v: selectRun(ids, "V_COMPONENT_OF_WIND__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND", run),
    gust: selectRun(ids, "WIND_SPEED_GUST__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND", run),
    cloud: selectRun(ids, "TOTAL_CLOUD_COVER__GROUND_OR_WATER_SURFACE", run),
    rain: selectRun(ids, "TOTAL_WATER_PRECIPITATION__GROUND_OR_WATER_SURFACE", run, "_P1D"),
    rainPeriod: selectRun(ids, "TOTAL_WATER_PRECIPITATION__GROUND_OR_WATER_SURFACE", run, "_PT3H")
  };
  for (const [name, item] of Object.entries(selected)) if (!item) throw new Error(`Champ ARPEGE ${name} indisponible.`);
  const stormFields = {
    cape: selectRun(ids, "CONVECTIVE_AVAILABLE_POTENTIAL_ENERGY_MAX__GROUND_OR_WATER_SURFACE", run),
    convectiveRain: selectRun(ids, "CONVECTIVE_PRECIPITATION__GROUND_OR_WATER_SURFACE", run, "_PT3H")
  };
  const snowCoverage = selectRun(ids, 'TOTAL_SNOW_PRECIPITATION__GROUND_OR_WATER_SURFACE', run, '_PT3H');
  let snowLeads = new Set();
  if (snowCoverage) {
    try {
      snowLeads = new Set(coverageTimeSeconds(await mfText(describeCoverageUrl(arpegeWcs, snowCoverage.id), arpegeApiKey, 'ARPEGE échéances neige', 2, 'arpege')));
      state.done++;
    } catch (error) { recordApiEvent('error', 'ARPEGE échéances neige', error.message); }
  }

  const [temperatureDescription, rainDescription] = await Promise.all([
    mfText(describeCoverageUrl(arpegeWcs, selected.temperature.id), arpegeApiKey, "ARPEGE échéances", 2, "arpege"),
    mfText(describeCoverageUrl(arpegeWcs, selected.rain.id), arpegeApiKey, "ARPEGE échéances pluie", 2, "arpege")
  ]);
  state.done += 2;
  const temperatureLeads = coverageTimeSeconds(temperatureDescription);
  const rainLeads = coverageTimeSeconds(rainDescription);
  const dates = forecastParisDates(5);
  const [forecastDate, forecastClock] = forecastStart.split("T");
  const [forecastHour, forecastMinute] = forecastClock.split(":").map(Number);
  const forecastStartTimestamp = parisLocalTime(forecastDate, forecastHour, forecastMinute);
  const sampledLeads = temperatureLeads.filter(lead => {
    const validTime = new Date(run.getTime() + lead * 1000);
    return lead > 0 && lead % 10800 === 0 && parisDateTimeKey(validTime) > forecastStart && dates.includes(parisDateKey(validTime));
  });
  if (!sampledLeads.length || !rainLeads.length) throw new Error("Échéances ARPEGE quatre jours indisponibles.");
  const hasConvectiveRain = Boolean(stormFields.convectiveRain);
  state.total = state.done + sampledLeads.length * (6 + Number(hasConvectiveRain)) + dates.length + sampledLeads.filter(lead => snowLeads.has(lead)).length;

  const getPoint = async (coverage, lead, height, label) => {
    const xml = await mfText(pointUrl(arpegeWcs, coverage.id, lat, lon, lead, height), arpegeApiKey, label, 2, "arpege");
    state.done++;
    return tupleValue(xml);
  };
  const samples = await mapPool(sampledLeads, 8, async lead => {
    const [temperatureValue, u, v, gust, cloudValue, periodRain, convectiveRain, snow] = await Promise.all([
      getPoint(selected.temperature, lead, 2, `ARPEGE température +${lead / 3600} h`),
      getPoint(selected.u, lead, 10, `ARPEGE vent U +${lead / 3600} h`),
      getPoint(selected.v, lead, 10, `ARPEGE vent V +${lead / 3600} h`),
      getPoint(selected.gust, lead, 10, `ARPEGE rafales +${lead / 3600} h`),
      getPoint(selected.cloud, lead, null, `ARPEGE nébulosité +${lead / 3600} h`),
      getPoint(selected.rainPeriod, lead, null, `ARPEGE pluie 3 h +${lead / 3600} h`),
      stormFields.convectiveRain ? getPoint(stormFields.convectiveRain, lead, null, `ARPEGE pluie convective +${lead / 3600} h`).catch(() => null) : null,
      snowLeads.has(lead) ? getPoint(snowCoverage, lead, null, `ARPEGE neige +${lead / 3600} h`).catch(error => {
        recordApiEvent('error', `ARPEGE neige +${lead / 3600} h`, error.message); return null;
      }) : null
    ]);
    const cloud = Math.max(0, Math.min(100, cloudValue <= 1 ? cloudValue * 100 : cloudValue));
    const validTime = run.getTime() + lead * 1000;
    // La pluie PT3H est horodatée à la fin du créneau. Un point à 18 h
    // représente donc 15–18 h et ne doit pas être décrit comme « le soir ».
    // Pour aujourd'hui, ne retenir que le milieu de la partie encore à venir.
    const rainPeriodStart = Math.max(forecastStartTimestamp, validTime - 3 * 3600000);
    const rainPeriodRepresentativeTime = rainPeriodStart + (validTime - rainPeriodStart) / 2;
    const futureRainFraction = Math.max(0, Math.min(1, (validTime - rainPeriodStart) / (3 * 3600000)));
    return {
      date: parisDateKey(validTime),
      validTime: parisDateTimeKey(validTime),
      timestamp: validTime,
      period: forecastPeriodKey(rainPeriodRepresentativeTime),
      stormTimestamp: rainPeriodRepresentativeTime,
      rainIntervalStart: rainPeriodStart,
      rainIntervalEnd: validTime,
      periodRain: Math.max(0, periodRain) * futureRainFraction,
      ...nativeSnowAmounts(Math.max(0, periodRain) * futureRainFraction,
        Number.isFinite(snow) ? snow * futureRainFraction : null),
      lead,
      cape: null,
      convectiveRain: Number.isFinite(convectiveRain) ? Math.max(0, convectiveRain) : null,
      stormSignal: false,
      temperature: temperatureValue - 273.15,
      windSpeed: Math.hypot(u, v) * 3.6,
      windDirection: (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360,
      windGust: gust * 3.6,
      cloud
    };
  });

  // La CAPE ne peut produire un signal orageux que si une pluie convective
  // est déjà prévue. Ne télécharger ce champ que pour ces échéances conserve
  // exactement le même critère tout en supprimant la majorité des appels secs.
  const capeCandidates = stormFields.cape && stormFields.convectiveRain
    ? samples.filter(sample => sample.convectiveRain >= .1)
    : [];
  state.total += capeCandidates.length;
  await mapPool(capeCandidates, 8, async sample => {
    const cape = await getPoint(stormFields.cape, sample.lead, null, `ARPEGE CAPE +${sample.lead / 3600} h`).catch(() => null);
    sample.cape = Number.isFinite(cape) ? Math.max(0, cape) : null;
    sample.stormSignal = Number.isFinite(cape) && cape >= 100;
  });

  const rainByDate = new Map(await mapPool(dates, 4, async date => {
    const lead = closestLead(rainLeads, run, parisLocalTime(date, 23, 59));
    const value = await getPoint(selected.rain, lead, null, `ARPEGE cumul quotidien ${date}`);
    return [date, Math.max(0, value)];
  }));
  const days = dates.map(date => {
    const daySamples = samples.filter(sample => sample.date === date);
    if (!daySamples.length) return null;
    const average = field => daySamples.reduce((sum, sample) => sum + sample[field], 0) / daySamples.length;
    const noon = daySamples[Math.floor(daySamples.length / 2)];
    const remainingToday = date === forecastStartDate;
    const rain = remainingToday ? daySamples.reduce((sum, sample) => sum + sample.periodRain, 0) : rainByDate.get(date) || 0;
    const cloud = average("cloud");
    // La plage affichée porte sur toutes les échéances de la journée. Les
    // moyennes matin/après-midi servent uniquement au texte d'évolution;
    // P20/P80 réservent « variable » aux variations durables.
    const solar = noaaSunTimes(new Date(parisLocalTime(date, 12)), lat, lon);
    const solarStart = solar.sunrise.getTime();
    const solarEnd = solar.sunset.getTime();
    const solarMidpoint = (solarStart + solarEnd) / 2;
    const cloudPoints = daySamples.map(sample => ({ time: Number(sample.timestamp), value: Number(sample.cloud) }))
      .filter(point => Number.isFinite(point.time) && Number.isFinite(point.value)).sort((left, right) => left.time - right.time);
    const spacings = cloudPoints.slice(1).map((point, index) => point.time - cloudPoints[index].time).filter(value => value > 0).sort((left, right) => left - right);
    const typicalSpacing = spacings.length ? spacings[Math.floor(spacings.length / 2)] : 3 * 3600000;
    const availableStart = Math.max(solarStart, cloudPoints[0].time - typicalSpacing / 2);
    const availableEnd = Math.min(solarEnd, cloudPoints.at(-1).time + typicalSpacing / 2);
    const integratedCloudMean = (start, end) => {
      if (!(end > start)) return null;
      let weighted = 0;
      let duration = 0;
      cloudPoints.forEach((point, index) => {
        const left = index ? (cloudPoints[index - 1].time + point.time) / 2 : point.time - typicalSpacing / 2;
        const right = index < cloudPoints.length - 1 ? (point.time + cloudPoints[index + 1].time) / 2 : point.time + typicalSpacing / 2;
        const overlap = Math.max(0, Math.min(end, right) - Math.max(start, left));
        weighted += point.value * overlap;
        duration += overlap;
      });
      return duration ? weighted / duration : null;
    };
    const integratedDayMean = integratedCloudMean(availableStart, availableEnd);
    const cloudMean = Number.isFinite(integratedDayMean) ? integratedDayMean : cloud;
    const cloudMorningMean = integratedCloudMean(availableStart, Math.min(availableEnd, solarMidpoint));
    const cloudAfternoonMean = integratedCloudMean(Math.max(availableStart, solarMidpoint), availableEnd);
    const daylightCloudValues = cloudPoints.filter(point => point.time >= availableStart && point.time <= availableEnd).map(point => point.value);
    const cloudValues = daylightCloudValues.length ? daylightCloudValues : daySamples.map(sample => sample.cloud);
    const integratedHalfValues = [cloudMorningMean, cloudAfternoonMean].filter(Number.isFinite);
    const integratedRangeValues = integratedHalfValues.length ? integratedHalfValues : [cloudMean];
    const cloudLow = percentile(cloudValues, .2);
    const cloudHigh = percentile(cloudValues, .8);
    const cloudBand = value => value <= 5 ? 0 : value <= 25 ? 1 : value <= 50 ? 2 : value <= 75 ? 3 : value <= 90 ? 4 : 5;
    const cloudSpread = cloudHigh - cloudLow;
    const cloudVariable = cloudValues.length >= 4 && cloudSpread >= 30 && Math.abs(cloudBand(cloudHigh) - cloudBand(cloudLow)) >= 2;
    const rainPeriods = [...new Set(daySamples.filter(sample => sample.periodRain >= .02).map(sample => sample.period))];
    const stormSignalPeriods = [...new Set(daySamples.filter(sample => sample.stormSignal).map(sample => sample.period))];
    const lateAfternoonStart = solarMidpoint + (solarEnd - solarMidpoint) * .6;
    const solarWindPeriod = sample => sample.timestamp < solarStart ? "night"
      : sample.timestamp < solarMidpoint ? "morning"
      : sample.timestamp < lateAfternoonStart ? "afternoon"
      : sample.timestamp < solarEnd ? "late_afternoon" : "evening";
    const characteristicPeriod = (field, minimumGap) => {
      const maxima = ["night", "morning", "afternoon", "late_afternoon", "evening"].map(period => ({
        period,
        value: Math.max(...daySamples.filter(sample => solarWindPeriod(sample) === period).map(sample => Number(sample[field])).filter(Number.isFinite), -Infinity)
      })).filter(item => Number.isFinite(item.value)).sort((left, right) => right.value - left.value);
      if (!maxima.length) return null;
      if (maxima.length === 1) return maxima[0].period;
      const gap = maxima[0].value - maxima[1].value;
      return gap >= Math.max(minimumGap, maxima[0].value * .2) ? maxima[0].period : null;
    };
    const windPeriod = characteristicPeriod("windSpeed", 5);
    const gustPeriod = characteristicPeriod("windGust", 8);
    return {
      date,
      time: `${date}T12:00:00`,
      forecastStart: remainingToday ? forecastStart : null,
      weatherCode: arpegeWeatherCode(rain, 0, cloud),
      temperatureMax: Math.max(...daySamples.map(sample => sample.temperature)),
      temperatureMin: Math.min(...daySamples.map(sample => sample.temperature)),
      apparentTemperatureMax: null,
      apparentTemperatureMin: null,
      precipitationSum: rain,
      precipitationProbabilityMax: null,
      stormSignal: stormSignalPeriods.length > 0,
      stormSignalPeriods,
      cloudCover: cloud,
      cloudCoverMean: cloudMean,
      cloudCoverMorningMean: cloudMorningMean,
      cloudCoverAfternoonMean: cloudAfternoonMean,
      cloudCoverMorningMin: cloudMorningMean,
      cloudCoverMorningMax: cloudMorningMean,
      cloudCoverAfternoonMin: cloudAfternoonMean,
      cloudCoverAfternoonMax: cloudAfternoonMean,
      cloudCoverMin: Math.min(...integratedRangeValues),
      cloudCoverMax: Math.max(...integratedRangeValues),
      cloudCoverLow: cloudLow,
      cloudCoverHigh: cloudHigh,
      cloudVariable,
      windSpeedMax: Math.max(...daySamples.map(sample => sample.windSpeed)),
      windGustMax: Math.max(...daySamples.map(sample => sample.windGust)),
      windDirection: noon?.windDirection ?? null,
      rainPeriods,
      windPeriod,
      gustPeriod
    };
  }).filter(Boolean).slice(0, 4);
  const activeDaySamples = samples.filter(sample => sample.date === forecastStartDate && sample.validTime >= forecastStart);
  const activeDayValidUntil = activeDaySamples.length
    ? new Date(Math.min(...activeDaySamples.map(sample => sample.timestamp))).toISOString()
    : new Date(Date.now() + 30 * 60000).toISOString();
  // Ces points ont déjà été acquis pour construire les agrégats quotidiens.
  // Les exposer permet au client de prolonger les créneaux détaillés après
  // AROME sans effectuer le moindre appel supplémentaire à Météo-France.
  const hours = samples.map(sample => ({
    time: new Date(sample.timestamp).toISOString(),
    stormTime: new Date(sample.stormTimestamp).toISOString(),
    rainIntervalStart: new Date(sample.rainIntervalStart).toISOString(),
    rainIntervalEnd: new Date(sample.rainIntervalEnd).toISOString(),
    rain: sample.periodRain,
    liquidRain: sample.liquidRain,
    snowfall: sample.snowfall,
    snowWaterEquivalent: sample.snowWaterEquivalent,
    snowfallMethod: sample.snowfallMethod,
    temperature: sample.temperature,
    windSpeed: sample.windSpeed,
    windDirection: sample.windDirection,
    windGust: sample.windGust,
    cloudCover: sample.cloud,
    stormSignal: sample.stormSignal
  }));
  return { runTime: run.toISOString(), activeDayValidUntil, days, hours };
}

async function buildPearpegePrecipitation(lat, lon, state, dates, { metadataRetries = 2, workEntry = null, targetRunTime = null } = {}) {
  setStage(state, "PE-ARPEGE · risque et confiance pluie", 1);
  const base = pearpegeWcs(0);
  let work = workEntry?.pearpegeWeekWork;
  const reusableCatalog = work?.version === 1
    && work.targetRunTime === targetRunTime
    && work.coverageId
    && work.rainRunTime
    && Array.isArray(work.leads)
    && work.leads.length;
  let rain;
  let leads;
  if (reusableCatalog) {
    rain = { id: work.coverageId, run: new Date(work.rainRunTime) };
    leads = work.leads;
  } else {
    const capabilities = await mfText(`${base}/GetCapabilities?service=WCS&version=2.0.1&language=fre`, pearpegeApiKey, "PE-ARPEGE", metadataRetries, "pearpege");
    const ids = coverageIds(capabilities);
    rain = selectLatest(ids, "TOTAL_WATER_PRECIPITATION__GROUND_OR_WATER_SURFACE", "_P1D");
    if (!rain) throw new Error("Cumul quotidien PE-ARPEGE indisponible.");
    const description = await mfText(describeCoverageUrl(base, rain.id), pearpegeApiKey, "PE-ARPEGE échéances pluie", metadataRetries, "pearpege");
    leads = coverageTimeSeconds(description);
    if (!leads.length) throw new Error("Échéances de pluie PE-ARPEGE indisponibles.");
    if (workEntry) {
      work = {
        version: 1,
        targetRunTime,
        coverageId: rain.id,
        rainRunTime: rain.run.toISOString(),
        leads,
        dates: [...dates],
        samples: {},
        updatedAt: new Date().toISOString()
      };
      workEntry.pearpegeWeekWork = work;
      await savePersisted();
    }
  }
  if (work) {
    work.samples ||= {};
    work.dates = [...new Set([...(work.dates || []), ...dates])];
  }
  const plans = dates.map(date => ({ date, lead: closestLead(leads, rain.run, parisLocalTime(date, 23, 59)) }));
  state.total = 2 + pearpegeMembers * plans.length;
  const cachedSamples = work ? plans.reduce((count, plan) => count + Object.values(work.samples?.[plan.date] || {}).filter(Number.isFinite).length, 0) : 0;
  state.done = 2 + cachedSamples;

  let quotaError = null;
  const members = await mapPool(Array.from({ length: pearpegeMembers }, (_, index) => index), pearpegeConcurrency, async member => {
    if (quotaError) return [];
    const memberBase = pearpegeWcs(member);
    return mapPool(plans, 1, async plan => {
      if (quotaError) return null;
      const cachedRain = Number(work?.samples?.[plan.date]?.[member]);
      if (Number.isFinite(cachedRain)) return { date: plan.date, rain: cachedRain };
      try {
        const buffer = await mfArrayBuffer(fullFieldUrl(memberBase, rain.id, plan.lead, null), pearpegeApiKey, `PE-ARPEGE pluie m${member} ${plan.date}`, 1, "pearpege");
        const value = await geotiffPointValue(buffer, lon, lat);
        const rainValue = Math.max(0, value);
        if (work) {
          (work.samples[plan.date] ||= {})[member] = rainValue;
          work.updatedAt = new Date().toISOString();
          await savePersisted();
        }
        state.done++;
        return { date: plan.date, rain: rainValue };
      } catch (error) {
        recordApiEvent("error", `PE-ARPEGE m${member} ${plan.date}`, error.message);
        if (/quota|429|trop de requêtes/i.test(error.message)) quotaError ||= error;
        return null;
      }
    });
  });
  // Ne pas transformer un quota atteint en simple ensemble incomplet : le
  // niveau supérieur applique alors le vrai délai de reprise d'une heure.
  if (quotaError) throw quotaError;
  const result = dates.map((date, dayIndex) => {
    const rains = members.map(member => member.find(item => item?.date === date)?.rain).filter(Number.isFinite);
    if (rains.length < 20) throw new Error(`PE-ARPEGE incomplet le ${date} : ${rains.length}/${pearpegeMembers} membres.`);
    const spread = quantile(rains, .9) - quantile(rains, .1);
    const horizonPenalty = dayIndex * .12;
    const uncertainty = spread + horizonPenalty;
    const level = uncertainty <= 1 ? "strong" : uncertainty <= 3 ? "medium" : "low";
    return {
      date,
      probability: Math.round(rains.filter(value => value >= .1).length / rains.length * 100),
      confidence: {
        level,
        label: level === "strong" ? "forte" : level === "medium" ? "moyenne" : "faible",
        temperatureSpread: null,
        windSpread: null,
        precipitationSpread: spread,
        members: rains.length
      }
    };
  });
  if (workEntry) {
    delete workEntry.pearpegeWeekWork;
    await savePersisted();
  }
  return result;
}

async function buildArpegeWeek(lat, lon, state, previous) {
  const reusable = previous?.runTime && previous?.days?.length === 4 && previous?.hours?.length && !cacheExpired(previous, arpegeWeekTtl) && new Date(previous.activeDayValidUntil).getTime() > Date.now();
  const deterministic = reusable
    ? {
        runTime: previous.runTime,
        activeDayValidUntil: previous.activeDayValidUntil,
        days: previous.days.map(day => ({ ...day, confidence: null, precipitationProbabilityMax: null })),
        hours: previous.hours
      }
    : await buildArpegeDeterministic(lat, lon, state);
  let ensemble = [];
  let ensembleError = pearpegeWeekEnabled ? null : "Acquisition PE-ARPEGE 2D désactivée : service trop lent pour l’affichage public.";
  if (pearpegeWeekEnabled) {
    try {
      ensemble = await buildPearpegePrecipitation(lat, lon, state, deterministic.days.map(day => day.date));
    } catch (error) {
      ensembleError = error.message;
      recordApiEvent("error", "PE-ARPEGE semaine", error.message);
    }
  }
  const byDate = new Map(ensemble.map(day => [day.date, day]));
  const days = deterministic.days.map(day => {
    const probabilistic = byDate.get(day.date);
    const probability = probabilistic?.probability ?? null;
    return {
      ...day,
      precipitationProbabilityMax: probability,
      weatherCode: arpegeWeatherCode(day.precipitationSum, probability || 0, day.cloudCover),
      confidence: probabilistic?.confidence || null
    };
  });
  state.stage = ensemble.length ? "ARPEGE et PE-ARPEGE · prévision prête" : "ARPEGE · prévision 4 jours prête";
  state.done = state.total;
  return {
    version: arpegeWeekVersion,
    fetchedAt: Date.now(),
    model: ensemble.length ? "ARPEGE / PE-ARPEGE" : "ARPEGE",
    runTime: deterministic.runTime,
    activeDayValidUntil: deterministic.activeDayValidUntil,
    hours: deterministic.hours,
    ensembleError,
    ensembleMembers: ensemble[0]?.confidence?.members || 0,
    days
  };
}

async function buildPearome(lat, lon, state, previous, arome, { forceAll = false } = {}) {
  setStage(state, "PEAROME · probabilité de pluie ciblée", 1);
  const base = pearomeWcs(0);
  const capabilities = await mfText(`${base}/GetCapabilities?service=WCS&version=2.0.1&language=eng`, pearomeApiKey, "PEAROME", 2, "pearome");
  state.done++;
  const ids = coverageIds(capabilities);
  const precipitation = selectLatest(ids, "TOTAL_PRECIPITATION__GROUND_OR_WATER_SURFACE", "_PT1H");
  if (!precipitation) throw new Error("Précipitation horaire PEAROME indisponible.");
  if (!forceAll && previous?.runTime === precipitation.run.toISOString() && previous.resolutionVersion === 6 && previous.members === pearomeMembers && previous.hours?.length) {
    return { ...previous, fetchedAt: Date.now(), checkedAt: Date.now() };
  }
  const firstLeadHour = Math.max(1, Math.ceil((Date.now() - precipitation.run.getTime()) / 3600000));
  const lastLeadHour = Math.min(51, firstLeadHour + 47);
  const leads = [];
  for (let lead = firstLeadHour; lead <= lastLeadHour; lead++) {
    if (lead < firstLeadHour + 3 || (lead - firstLeadHour) % 3 === 0) leads.push(lead);
  }
  if (!leads.length) throw new Error("Aucune échéance PEAROME disponible sur ce cycle.");
  const riskLeads = forceAll ? leads : leads.filter(lead => {
    const start = precipitation.run.getTime() + lead * 3600000;
    const duration = lead < firstLeadHour + 3 ? 1 : 3;
    const end = start + duration * 3600000;
    return arome?.hours?.some(item => {
      const time = new Date(item.time).getTime();
      return time >= start && time < end && item.rain >= 0.01;
    });
  });
  if (!riskLeads.length) {
    state.total = 1;
    return {
      fetchedAt: Date.now(), runTime: precipitation.run.toISOString(), threshold: 0.1,
      members: 0, stepHours: 3, resolutionVersion: 6,
      hours: leads.map(leadHour => ({
        leadHour, time: new Date(precipitation.run.getTime() + leadHour * 3600000).toISOString(),
        durationHours: leadHour < firstLeadHour + 3 ? 1 : 3, probability: 0, ensembleMean: 0, interval: { low: 0, high: 0 }
      }))
    };
  }
  const durationForLead = lead => lead < firstLeadHour + 3 ? 1 : 3;
  state.total = 1 + pearomeMembers * riskLeads.reduce((total, lead) => total + durationForLead(lead), 0);
  const members = Array.from({ length: pearomeMembers }, (_, index) => index);
  const memberValues = await mapPool(members, pearomeConcurrency, async member => {
    return mapPool(riskLeads, 1, async lead => {
      const baseUrl = pearomeWcs(member);
      const durationHours = durationForLead(lead);
      let accumulation = 0;
      for (let offset = 0; offset < durationHours; offset++) {
        const hourlyLead = lead + offset;
        const xml = await mfText(pointUrl(baseUrl, precipitation.id, lat, lon, hourlyLead * 3600), pearomeApiKey, `PEAROME membre ${member} H+${hourlyLead}`, 2, "pearome");
        state.done++;
        accumulation += Math.max(0, tupleValue(xml));
      }
      return accumulation;
    });
  });
  const hours = leads.map(leadHour => {
    const riskIndex = riskLeads.indexOf(leadHour);
    if (riskIndex === -1) {
      return {
        leadHour,
        time: new Date(precipitation.run.getTime() + leadHour * 3600000).toISOString(),
        durationHours: leadHour < firstLeadHour + 3 ? 1 : 3,
        probability: 0,
        ensembleMean: 0,
        interval: { low: 0, high: 0 }
      };
    }
    const values = memberValues.map(member => member[riskIndex]);
    const wetMembers = values.filter(value => value >= 0.1).length;
    return {
      leadHour,
      time: new Date(precipitation.run.getTime() + leadHour * 3600000).toISOString(),
      durationHours: leadHour < firstLeadHour + 3 ? 1 : 3,
      probability: Math.round(wetMembers / values.length * 100),
      ensembleMean: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 100) / 100,
      interval: ensembleInterval(values, 100)
    };
  });
  return { fetchedAt: Date.now(), runTime: precipitation.run.toISOString(), threshold: 0.1, members: pearomeMembers, stepHours: 3, resolutionVersion: 6, hours };
}

async function buildPearomeEnsemble(lat, lon, state, entry, pearome) {
  setStage(state, "PEAROME · intervalles d’incertitude", 1);
  const base = pearomeWcs(0);
  const capabilities = await mfText(`${base}/GetCapabilities?service=WCS&version=2.0.1&language=eng`, pearomeApiKey, "PEAROME ensemble", 2, "pearome");
  state.done++;
  const ids = coverageIds(capabilities);
  const run = pearome?.runTime ? new Date(pearome.runTime) : selectLatest(ids, "TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND")?.run;
  const fields = {
    temperature: { coverage: selectRun(ids, "TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND", run), height: 2 },
    windU: { coverage: selectRun(ids, "U_COMPONENT_OF_WIND__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND", run), height: 10 },
    windV: { coverage: selectRun(ids, "V_COMPONENT_OF_WIND__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND", run), height: 10 },
    gust: { coverage: selectRun(ids, "WIND_SPEED_GUST__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND", run), height: 10 },
    cloud: { coverage: selectRun(ids, "TOTAL_CLOUD_COVER__GROUND_OR_WATER_SURFACE", run), height: null }
  };
  // Cloud cover is not exposed by every PEAROME publication.  It must not
  // prevent the ensemble temperature and wind intervals from being cached.
  if (!fields.cloud.coverage) delete fields.cloud;
  if (!fields.gust.coverage) delete fields.gust;
  const missing = Object.entries(fields).filter(([, field]) => !field.coverage).map(([name]) => name);
  if (!run || missing.length) throw new Error("Champs d’ensemble PEAROME indisponibles : " + missing.join(", ") + ".");
  const firstLeadHour = Math.max(1, Math.ceil((Date.now() - run.getTime()) / 3600000));
  const lastLeadHour = Math.min(51, firstLeadHour + 47);
  // Six-hour anchors keep the ensemble acquisition within the API quota. The
  // client interpolates only the interval display between these cached anchors.
  const leads = [];
  for (let lead = firstLeadHour; lead <= lastLeadHour; lead++) {
    if (lead === firstLeadHour || (lead - firstLeadHour) % 6 === 0 || lead === lastLeadHour) leads.push(lead);
  }
  const members = Array.from({ length: pearomeMembers }, (_, index) => index);
  const fieldNames = Object.keys(fields);
  const signature = JSON.stringify({ runTime: run.toISOString(), members, leads, fieldNames });
  let work = entry.ensembleWork;
  if (!work || work.version !== 1 || work.signature !== signature) {
    work = {
      version: 1,
      signature,
      runTime: run.toISOString(),
      members: members.length,
      leads,
      fieldNames,
      samples: {},
      errors: {},
      updatedAt: new Date().toISOString()
    };
    entry.ensembleWork = work;
    await savePersisted();
  }
  work.samples ||= {};
  work.errors ||= {};
  const completedBlocks = () => members.reduce((count, member) => count + leads.filter(lead => {
    const reading = work.samples?.[member]?.[lead];
    return reading && fieldNames.every(name => Number.isFinite(reading[name]));
  }).length, 0);
  state.total = 1 + members.length * leads.length * fieldNames.length;
  state.done = 1 + completedBlocks() * fieldNames.length;
  const memberSamples = await mapPool(members, pearomeConcurrency, async member => {
    const memberBase = pearomeWcs(member);
    return mapPool(leads, 1, async leadHour => {
      const cached = work.samples?.[member]?.[leadHour];
      if (cached && fieldNames.every(name => Number.isFinite(cached[name]))) return cached;
      const readings = {};
      try {
        for (const [name, field] of Object.entries(fields)) {
          const xml = await mfText(pointUrl(memberBase, field.coverage.id, lat, lon, leadHour * 3600, field.height), pearomeApiKey, `PEAROME ${name} membre ${member} H+${leadHour}`, 2, "pearome");
          readings[name] = tupleValue(xml);
        }
        (work.samples[member] ||= {})[leadHour] = readings;
        delete work.errors[`${member}:${leadHour}`];
        work.updatedAt = new Date().toISOString();
        state.done += fieldNames.length;
        await savePersisted();
        return readings;
      } catch (error) {
        work.errors[`${member}:${leadHour}`] = { at: new Date().toISOString(), message: error.message };
        work.updatedAt = new Date().toISOString();
        await savePersisted();
        return null;
      }
    });
  });
  const missingBlocks = [];
  members.forEach((member, memberIndex) => leads.forEach((leadHour, leadIndex) => {
    const reading = memberSamples[memberIndex]?.[leadIndex];
    if (!reading || !fieldNames.every(name => Number.isFinite(reading[name]))) missingBlocks.push(`${member}:${leadHour}`);
  }));
  if (missingBlocks.length) {
    throw new Error(`Intervalles PEAROME incomplets : ${missingBlocks.length} bloc(s) seront repris automatiquement.`);
  }
  const hours = leads.map((leadHour, index) => {
    const values = name => memberSamples.map(member => member[index][name]);
    const wind = memberSamples.map(member => Math.hypot(member[index].windU, member[index].windV) * 3.6);
    const cloud = fields.cloud ? values("cloud").map(value => value <= 1 ? value * 100 : value) : null;
    return {
      leadHour,
      time: new Date(run.getTime() + leadHour * 3600000).toISOString(),
      temperature: ensembleInterval(values("temperature").map(value => value - 273.15), 10),
      wind: ensembleInterval(wind, 1),
      gust: fields.gust ? ensembleInterval(values("gust").map(value => value * 3.6), 1) : null,
      cloud: cloud ? ensembleInterval(cloud, 1) : null
    };
  });
  delete entry.ensembleWork;
  return { fetchedAt: Date.now(), runTime: run.toISOString(), members: members.length, stepHours: 6, version: 2, hours };
}

async function buildVigilance() {
  if (!vigilanceToken) return null;
  const response = await fetch(vigilanceUrl, {
    headers: { accept: "application/json", apikey: vigilanceToken },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Vigilance a répondu ${response.status}.`);
  const source = await response.json();
  const alerts = new Map();
  for (const period of source?.product?.periods || []) {
    const department = period?.timelaps?.domain_ids?.find(item => String(item.domain_id) === String(vigilanceDepartment));
    const commentary = Array.isArray(period?.text_items?.text) ? period.text_items.text.filter(Boolean).join(" ") : "";
    for (const phenomenon of department?.phenomenon_items || []) {
      const color = Number(phenomenon.phenomenon_max_color_id);
      const id = Number(phenomenon.phenomenon_id);
      if (!vigilancePhenomena[id] || id === 4) continue;
      const timeline = (phenomenon.timelaps_items || []).map(item => ({
        color: vigilanceTimelineColors[Number(item.color_id)] || "vert",
        colorId: Number(item.color_id), start: item.begin_time || null, end: item.end_time || null
      }));
      const previous = alerts.get(id);
      const combinedTimeline = [...(previous?.timeline || []), ...timeline]
        .filter((item, index, items) => index === items.findIndex(candidate => candidate.colorId === item.colorId && candidate.start === item.start && candidate.end === item.end))
        .sort((left, right) => new Date(left.start || 0) - new Date(right.start || 0));
      const warningTimeline = combinedTimeline.filter(item => item.colorId >= 2);
      const colorId = Math.max(color, previous?.colorId || 0, ...combinedTimeline.map(item => item.colorId));
      alerts.set(id, {
        id,
        label: vigilancePhenomena[id], color: vigilanceColors[colorId] || "jaune", colorId,
        start: warningTimeline[0]?.start || previous?.start || period.begin_validity_time || null,
        end: warningTimeline.at(-1)?.end || previous?.end || period.end_validity_time || null,
        commentary: previous?.commentary || commentary,
        timeline: combinedTimeline
      });
    }
  }
  return {
    fetchedAt: Date.now(), version: 5, updatedAt: source?.product?.update_time || null, department: vigilanceDepartment,
    alerts: [...alerts.values()].sort((a, b) => b.colorId - a.colorId)
  };
}

return { buildPiaf, buildArome, buildArpegeDeterministic, buildPearpegePrecipitation, buildArpegeWeek, buildPearome, buildPearomeEnsemble, buildVigilance };
}
