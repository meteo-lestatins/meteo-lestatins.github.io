const $ = id => document.getElementById(id);
const runtimeConfig = window.METEO_RUNTIME_CONFIG && typeof window.METEO_RUNTIME_CONFIG === "object"
  ? window.METEO_RUNTIME_CONFIG
  : {};
const apiBaseUrl = new URL(runtimeConfig.apiBase || "./", document.baseURI);
const apiUrl = path => new URL(String(path).replace(/^\/+/, ""), apiBaseUrl);
const appNow = () => Number(window.METEO_REPLAY?.currentTime?.()) || Date.now();
const replayEngineUrl = new URL("nowcast/engine.js", document.currentScript?.src || document.baseURI);
const point = { lat: 44.6538, lon: 5.5995 };
const hourFormat = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
const forecastHourValue = date => Number(hourFormat.format(date).slice(0, 2));
const forecastHourLabel = date => Number(hourFormat.format(date).slice(0, 2)) + "h";
const forecastWeekdayFormat = new Intl.DateTimeFormat("fr-FR", { weekday: "long", timeZone: "Europe/Paris" });
const forecastWeekdayLabel = date => {
  const label = forecastWeekdayFormat.format(date);
  return label.charAt(0).toUpperCase() + label.slice(1);
};
const dayFormat = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "Europe/Paris" });
const weekDayFormat = new Intl.DateTimeFormat("fr-FR", { weekday: "long", timeZone: "Europe/Paris" });
const shortDateFormat = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", timeZone: "Europe/Paris" });
const dateTimeFormat = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
const nightPeriodDateFormat = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Paris" });
let lastAromeStamp = 0;
let lastPiafStamp = 0;
let lastRadarStamp = 0;
let lastPearomeStamp = 0;
let lastEnsembleStamp = 0;
let lastVigilanceStamp = 0;
let lastOpenMeteoStamp = 0;
let refreshTimer = 0;
let nowcastExpiryTimer = 0;
// Le mécanisme de rotation reste disponible pour une reprise ultérieure, mais
// l'encadré affiche pour l'instant un seul message stable.
const threeHourMessageRotationEnabled = false;
let threeHourMessageSequenceTimer = 0;
let threeHourMessageSequenceState = { signature: "", index: 0 };
let dashboardSync = { status: "loading", error: null };
const defaultForecastSource = window.METEO_REPLAY ? "openmeteo" : "meteofrance";
let activeForecastSource = defaultForecastSource;
let latestForecastData = null;
let latestWeekForecast = null;
let latestOpenMeteoWeekRaw = null;
let latestMeteoFranceWeek = null;
let temperatureNormals = null;
let temperatureNormalsPromise = null;
let weekForecastPromise = null;
let weekForecastRetryTimer = 0;
let weekForecastErrors = {};
let meteoFranceWeekPollTimer = 0;
let weekActiveDayTimer = 0;
let latestWeekEvolutionHistory = [];
let dashboardCacheHydrated = false;
let weekCacheHydrated = false;
const nowcastMapRadiusSessionKey = "meteo-nowcast-map-radius";
function savedNowcastMapRadius() {
  try {
    const value = Number(sessionStorage.getItem(nowcastMapRadiusSessionKey));
    return value === 20 || value === 60 ? value : null;
  } catch {
    return null;
  }
}
const initialNowcastMapRadius = savedNowcastMapRadius();
let activeNowcastMapRadius = initialNowcastMapRadius || 60;
let nowcastMapRadiusManuallySelected = initialNowcastMapRadius !== null;
let nowcastMapAutoExpanded = false;
let nowcastLeafletMap = null;
let nowcastLeafletResizeObserver = null;
let nowcastCellOverlayResizeObserver = null;
let nowcastMapRequest = 0;
let leafletAssetsPromise = null;
let nowcastMapAssetsPromise = null;
let weekEvolutionState = { signature: "", byDate: new Map() };
const weekDaySourceSelection = new Map();
let latestOpenMeteoEnsemble = null;
let openMeteoEnsemblePromise = null;
const selectedMetrics = new Set(["temperature", "rain", "wind", "gust", "cloudiness"]);
const metricOpacities = { temperature: 100, rain: 100, wind: 0, gust: 0, cloudiness: 0 };
const metricOffsets = { temperature: 0, rain: 0, wind: 0, gust: 0, cloudiness: 0 };
const possibleDrizzleThreshold = .01;
const measurableRainThreshold = .05;
// Seuil de lisibilité des risques sans cumul, indépendant du seuil en mm de l’API.
const rainRiskDisplayThreshold = 20;
// Échelle commune des pictogrammes de pluie. Elle exprime une quantité
// réellement affichée, sans transformer quelques millimètres en pluie forte.
const rainPictogramStep = value => value <= 0 ? 0 : value < 3 ? 1 : value < 8 ? 2 : value < 15 ? 3 : value < 30 ? 4 : 5;
// Le vent moyen reste sensible aux conditions locales. Dans le résumé à trois
// heures, son niveau est combiné à celui des rafales sur une échelle commune.
const meanWindIntensityLevel = value => {
  const speed = Math.max(0, Number(value) || 0);
  return speed <= 0 ? 0 : speed < 12 ? 1 : speed < 20 ? 2 : speed < 30 ? 3 : speed < 40 ? 4 : 5;
};
const gustIntensityLevel = value => {
  const speed = Math.max(0, Number(value) || 0);
  return speed <= 0 ? 0 : speed < 35 ? 1 : speed < 55 ? 2 : speed < 75 ? 3 : speed < 100 ? 4 : 5;
};
const shortTermWindIntensityLevel = (meanWind, gust) => {
  const meanSpeed = Math.max(0, Number(meanWind) || 0);
  const gustSpeed = Math.max(0, Number(gust) || 0);
  if (meanSpeed < 5 && gustSpeed < 15) return 0;
  return Math.max(meanWindIntensityLevel(meanSpeed), gustIntensityLevel(gustSpeed));
};

function forecastSourceAlertTone({ wind = 0, gust = 0, probability = 0, rain = 0, rain3h = 0, stormRainOverlap = false, stormRainWindOverlap = false } = {}) {
  const windValue = Math.max(0, Number(wind) || 0);
  const gustValue = Math.max(0, Number(gust) || 0);
  const probabilityValue = Math.max(0, Number(probability) || 0);
  const rainValue = Math.max(0, Number(rain) || 0);
  const rain3hValue = Math.max(0, Number(rain3h) || 0);
  const rainAttention = probabilityValue >= 70 && (rain3hValue >= 10 || rainValue >= 15);
  const rainSerious = probabilityValue >= 70 && (rain3hValue >= 20 || rainValue >= 30);
  const rainAlert = probabilityValue >= 80 && (rain3hValue >= 40 || rainValue >= 60);
  const windAttention = windValue >= 40 || gustValue >= 60;
  const windSerious = windValue >= 60 || gustValue >= 80;
  const windAlert = windValue >= 80 || gustValue >= 100;
  if (windAlert || rainAlert || (windSerious && rainSerious)) return "red";
  if (windSerious || rainSerious || (stormRainOverlap && rainAttention)) return "orange";
  if (windAttention || rainAttention || stormRainWindOverlap) return "yellow";
  return "";
}

function forecastSlotAlertTone(sources = []) {
  const ranks = { "": 0, yellow: 1, orange: 2, red: 3 };
  return (Array.isArray(sources) ? sources : [sources]).reduce((selected, source) => {
    const tone = forecastSourceAlertTone(source);
    return ranks[tone] > ranks[selected] ? tone : selected;
  }, "");
}

function graphIconMarkup(className) {
  return '<span class="' + className + '" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 3v18h18M5 17l4-5 4 3 6-8"/></svg></span>';
}

function ensureLeafletAssets() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletAssetsPromise) return leafletAssetsPromise;
  leafletAssetsPromise = new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-leaflet-lazy]')) {
      const style = document.createElement("link");
      style.rel = "stylesheet";
      style.href = new URL("vendor/leaflet/leaflet.css", document.baseURI).href;
      style.dataset.leafletLazy = "true";
      document.head.append(style);
    }
    const script = document.createElement("script");
    script.src = new URL("vendor/leaflet/leaflet.js", document.baseURI).href;
    script.async = true;
    script.dataset.leafletLazy = "true";
    script.addEventListener("load", () => window.L ? resolve(window.L) : reject(new Error("Leaflet indisponible")), { once: true });
    script.addEventListener("error", () => reject(new Error("Chargement de Leaflet impossible")), { once: true });
    document.head.append(script);
  }).catch(error => {
    leafletAssetsPromise = null;
    throw error;
  });
  return leafletAssetsPromise;
}

function ensureNowcastMapAssets() {
  if (window.L?.maplibreGL && window.maplibregl) return Promise.resolve(window.L);
  if (nowcastMapAssetsPromise) return nowcastMapAssetsPromise;
  nowcastMapAssetsPromise = ensureLeafletAssets().then(() => new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-maplibre-lazy]')) {
      const style = document.createElement("link");
      style.rel = "stylesheet";
      style.href = new URL("vendor/maplibre/maplibre-gl.css", document.baseURI).href;
      style.dataset.maplibreLazy = "true";
      document.head.append(style);
    }
    const loadBridge = () => {
      if (window.L?.maplibreGL) return resolve(window.L);
      const bridge = document.createElement("script");
      bridge.src = new URL("vendor/maplibre/leaflet-maplibre-gl.js", document.baseURI).href;
      bridge.async = true;
      bridge.dataset.maplibreLeafletLazy = "true";
      bridge.addEventListener("load", () => window.L?.maplibreGL ? resolve(window.L) : reject(new Error("Pont Leaflet–MapLibre indisponible")), { once: true });
      bridge.addEventListener("error", () => reject(new Error("Chargement du pont Leaflet–MapLibre impossible")), { once: true });
      document.head.append(bridge);
    };
    if (window.maplibregl) return loadBridge();
    const script = document.createElement("script");
    script.src = new URL("vendor/maplibre/maplibre-gl-csp.js", document.baseURI).href;
    script.async = true;
    script.dataset.maplibreLazy = "true";
    script.addEventListener("load", () => {
      if (!window.maplibregl) return reject(new Error("MapLibre indisponible"));
      window.maplibregl.workerUrl = new URL("vendor/maplibre/maplibre-gl-csp-worker.js", document.baseURI).href;
      loadBridge();
    }, { once: true });
    script.addEventListener("error", () => reject(new Error("Chargement de MapLibre impossible")), { once: true });
    document.head.append(script);
  })).catch(error => {
    nowcastMapAssetsPromise = null;
    throw error;
  });
  return nowcastMapAssetsPromise;
}

const sourceFreshness = { arome: 3 * 3600000, pearome: 3 * 3600000, ensemble: 3 * 3600000, piaf: 20 * 60000, radar: 15 * 60000, lightning: 20 * 60000, vigilance: 30 * 60000, openMeteo: 60 * 60000 };
const sourceLabels = { arome: "AROME", pearome: "AROME-PI", ensemble: "PEAROME", piaf: "PIAF", radar: "Radar", lightning: "EUMETSAT LI", vigilance: "Vigilance", openMeteo: "Open-Meteo" };

function sourceSyncState(key) {
  const source = latestForecastData?.[key];
  const fetchedAt = Number(source?.fetchedAt) || 0;
  if (!fetchedAt) return dashboardSync.status === "loading" ? "loading" : "error";
  if (Date.now() - fetchedAt > (sourceFreshness[key] || 60 * 60000)) return dashboardSync.status === "loading" ? "loading" : "error";
  return "ready";
}

function sourceSyncTitle(key) {
  const state = sourceSyncState(key);
  const label = sourceLabels[key] || "Source";
  if (state === "ready") return label + " à jour";
  if (state === "loading") return label + " : synchronisation en cours";
  return label + " : données à actualiser";
}

function refreshSourceIndicators() {
  document.querySelectorAll("[data-source-status]").forEach(link => {
    const key = link.dataset.sourceStatus;
    const state = sourceSyncState(key);
    link.dataset.sync = state;
    const label = link.textContent.trim();
    link.title = "Voir " + label + " dans About · " + sourceSyncTitle(key);
    link.setAttribute("aria-label", label + " — " + link.title);
  });
}

function sourceLink(key, section, label) {
  const state = sourceSyncState(key);
  const href = (window.METEO_REPLAY?.aboutBase ?? (window.METEO_REPLAY ? "../" : "")) + "about.html#" + section;
  return '<a class="source-link" data-source-status="' + key + '" data-sync="' + state + '" href="' + href + '" title="Voir ' + escapeText(label) + ' dans About · ' + escapeText(sourceSyncTitle(key)) + '">' + label + '</a>';
}

const meteoFranceLinks = () => sourceLink("arome", "api-arome", "AROME")
  + sourceLink("piaf", "api-piaf", "PIAF")
  + sourceLink("pearome", "api-pe-arome", "AROME-PI");
const openMeteoLink = () => sourceLink("openMeteo", "api-open-meteo", "Open-Meteo");
const radarLink = () => sourceLink("radar", "api-radar", window.METEO_REPLAY ? "Radar archivé" : "Radar v1");
const lightningLink = () => sourceLink("lightning", "api-eumetsat-li", "EUMETSAT LI");
const vigilanceLink = () => sourceLink("vigilance", "api-vigilance", "Vigilance");
const nowcastDisplayLink = () => '<a class="source-link source-link-nowcast" href="#nowcast-details" data-open-nowcast-link="true" title="Ouvrir l’affichage nowcasting">Nowcasting</a>';
const shortRainLinks = () => window.METEO_REPLAY
  ? (window.METEO_REPLAY.archiveTesting ? radarLink() : openMeteoLink()) + nowcastDisplayLink()
  : sourceLink("piaf", "api-piaf", "Météo-France") + nowcastDisplayLink();
const threeHourLinks = () => window.METEO_REPLAY ? radarLink() + nowcastDisplayLink() : radarLink()
  + nowcastDisplayLink()
  + sourceLink("piaf", "api-piaf", "PIAF")
  + sourceLink("arome", "api-arome", "AROME")
  + lightningLink()
  + vigilanceLink();

function renderRainApiLinks() {
  if ($("three-hour-api-links")) $("three-hour-api-links").innerHTML = threeHourLinks();
  if ($("rain-api-links")) $("rain-api-links").innerHTML = shortRainLinks();
  if ($("nowcast-api-links")) $("nowcast-api-links").innerHTML = radarLink() + (window.METEO_REPLAY ? "" : lightningLink());
  refreshSourceIndicators();
}

function renderForecastApiLinks() {
  const container = $("forecast-api-links");
  if (!container) return;
  container.innerHTML = (activeForecastSource === "openmeteo" ? openMeteoLink()
    : activeForecastSource === "comparison" ? meteoFranceLinks() + openMeteoLink() + nowcastDisplayLink()
    : meteoFranceLinks() + nowcastDisplayLink());
  refreshSourceIndicators();
}

function renderWeekApiLinks() {
  const container = $("week-api-links");
  if (!container) return;
  container.innerHTML = sourceLink("arome", "api-arpege", "ARPEGE")
    + sourceLink("ensemble", "api-pe-arpege", "PE-ARPEGE")
    + sourceLink("openMeteo", "api-open-meteo", "Open-Meteo");
  container.hidden = true;
  refreshSourceIndicators();
}

function temperatureNormalAt(time) {
  if (!temperatureNormals?.days || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(time || ""))) return null;
  const values = temperatureNormals.days[String(time).slice(5, 10)]?.[Number(String(time).slice(11, 13))];
  if (!Array.isArray(values) || values.length !== 3 || !values.every(Number.isFinite)) return null;
  return { low: values[0], median: values[1], high: values[2] };
}

function loadTemperatureNormals() {
  if (temperatureNormalsPromise) return temperatureNormalsPromise;
  temperatureNormalsPromise = fetch(new URL("data/temperature-normals.json", document.baseURI), { cache: "force-cache" })
    .then(response => {
      if (!response.ok) throw new Error(`Référentiel de température indisponible (${response.status})`);
      return response.json();
    })
    .then(value => {
      if (value?.meta?.baseline !== "1991-2020" || Object.keys(value?.days || {}).length !== 366) {
        throw new Error("Référentiel de température invalide");
      }
      temperatureNormals = value;
      if (latestOpenMeteoWeekRaw) refreshActiveOpenMeteoWeek();
      renderWeekForecast();
      return value;
    })
    .catch(error => {
      console.warn(error.message);
      return null;
    });
  return temperatureNormalsPromise;
}

function forecastSourceControlsMarkup() {
  const unavailable = window.METEO_REPLAY ? ' disabled title="Source non archivée pour cette date"' : '';
  return '<div class="forecast-source-selector" aria-label="Source des prévisions"><button class="forecast-source-button' + (activeForecastSource === "meteofrance" ? " active" : "") + '" type="button" data-source="meteofrance" aria-pressed="' + (activeForecastSource === "meteofrance") + '"' + unavailable + '>Météo-France</button><button class="forecast-source-button' + (activeForecastSource === "openmeteo" ? " active" : "") + '" type="button" data-source="openmeteo" aria-pressed="' + (activeForecastSource === "openmeteo") + '">Open-Meteo</button><button class="forecast-source-button' + (activeForecastSource === "comparison" ? " active" : "") + '" type="button" data-source="comparison" aria-pressed="' + (activeForecastSource === "comparison") + '"' + unavailable + '>Synthèse</button></div>';
}

function forecastMetricControlsMarkup() {
  const icons = {
    temperature: '<path d="M10 4a2 2 0 0 1 4 0v9.2a4 4 0 1 1-4 0V4Z"/><path d="M12 7v9"/>',
    rain: '<path d="M12 2.8C9.5 6.4 6.8 9.7 6.8 13.2a5.2 5.2 0 0 0 10.4 0C17.2 9.7 14.5 6.4 12 2.8Z"/>',
    wind: '<path d="M3 7h12c4 0 4-5 .7-5-1.5 0-2.5.8-2.9 2M3 12h17M3 17h10c4 0 4 5 .7 5-1.5 0-2.5-.8-2.9-2"/>',
    gust: '<path d="M3 6h14c4 0 4-5 .7-5-1.5 0-2.5.8-2.9 2M3 12h18M3 18h12"/><path d="m12 15 3 3-3 3"/>',
    cloudiness: '<path d="M5.5 18a4.5 4.5 0 0 1-.6-9A6.2 6.2 0 0 1 16.7 8a5 5 0 1 1 .8 10H5.5Z"/>'
  };
  return '<div class="metric-controls-rail"><div class="forecast-metric-controls" aria-label="Courbes affichées">' + [{ key: "cloudiness", label: "Nébulosité" }, { key: "temperature", label: "Température" }, { key: "gust", label: "Rafales" }, { key: "wind", label: "Vent moyen" }, { key: "rain", label: "Précipitations" }].map(metric => '<button class="metric-opacity-control" type="button" data-metric-opacity="' + metric.key + '" aria-label="' + metric.label + '" aria-pressed="' + (metricOpacities[metric.key] > 0) + '" title="' + metric.label + '"><span class="metric-symbol" aria-hidden="true"><span class="metric-symbol-part metric-symbol-on-color"><svg viewBox="0 0 24 24">' + icons[metric.key] + '</svg></span><span class="metric-symbol-part metric-symbol-on-white"><svg viewBox="0 0 24 24">' + icons[metric.key] + '</svg></span></span></button>').join("") + '</div></div>';
}

function applyMetricOpacities() {
  const section = $("panel-48h");
  if (!section) return;
  Object.entries(metricOpacities).forEach(([metric, value]) => {
    section.style.setProperty("--metric-opacity-" + metric, String(value / 100));
    section.style.setProperty("--metric-offset-" + metric, (metric === "rain" || metric === "cloudiness" ? 0 : metricOffsets[metric]) + "px");
  });
  section.querySelectorAll("[data-metric-opacity]").forEach(button => {
    const metric = button.dataset.metricOpacity;
    const opacity = metricOpacities[metric];
    button.style.setProperty("--metric-control-offset", metricOffsets[metric] + "px");
    button.style.setProperty("--metric-level", opacity + "%");
    button.dataset.opacityContrast = opacity >= 55 ? "light" : "dark";
    button.setAttribute("aria-pressed", String(opacity > 0));
    button.title = metric === "cloudiness" ? "Nébulosité · cliquer pour afficher ou masquer" : button.getAttribute("aria-label") + " · opacité " + opacity + " % · glisser horizontalement pour la transparence · verticalement " + (metric === "rain" ? "pour déplacer le bouton" : "pour la courbe");
  });
  section._updateMetricLabels?.();
}

function bindForecastControlButtons() {
  const controls = $("forecast-controls");
  controls.querySelectorAll("[data-source]").forEach(button => button.onclick = () => {
    activeForecastSource = button.dataset.source;
    renderForecastApiLinks();
    renderActiveForecast();
    if (activeForecastSource === "openmeteo") ensureOpenMeteoEnsemble();
  });
  document.querySelectorAll("[data-metric-opacity]").forEach(button => {
    const metric = button.dataset.metricOpacity;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragStartOffset = 0;
    let dragStartOpacity = 0;
    let dragAxis = "";
    let dragged = false;
    const beginDrag = (clientX, clientY) => {
      document.querySelectorAll("[data-metric-opacity]").forEach(candidate => candidate.style.zIndex = candidate === button ? "2" : "1");
      dragStartX = clientX;
      dragStartY = clientY;
      dragStartOffset = metricOffsets[metric];
      dragStartOpacity = metricOpacities[metric];
      dragAxis = "";
      dragged = false;
    };
    const moveDrag = (clientX, clientY) => {
      const movementX = clientX - dragStartX;
      const movementY = clientY - dragStartY;
      if (!dragAxis && Math.hypot(movementX, movementY) > 6) {
        if (Math.abs(movementX) > Math.abs(movementY) * 1.2) dragAxis = "horizontal";
        else if (Math.abs(movementY) > Math.abs(movementX) * 1.2) dragAxis = "vertical";
        else return;
        dragged = true;
      }
      if (!dragged) return;
      if (dragAxis === "horizontal") {
        if (metric === "cloudiness") return;
        const shadingWidth = Math.max(1, parseFloat(getComputedStyle(button, "::before").width) || button.clientWidth - 10);
        metricOpacities[metric] = Math.max(0, Math.min(100, Math.round(dragStartOpacity + movementX * 100 / shadingWidth)));
        applyMetricOpacities();
        return;
      }
      const rail = button.closest(".metric-controls-rail").getBoundingClientRect();
      const offsetBounds = candidate => {
        const candidateMetric = candidate.dataset.metricOpacity;
        const current = candidate.getBoundingClientRect();
        const baseTop = current.top - metricOffsets[candidateMetric];
        return {
          minimum: rail.top + 7 - baseTop,
          maximum: rail.bottom - 7 - current.height - baseTop
        };
      };
      const bounds = offsetBounds(button);
      let nextOffset = Math.max(bounds.minimum, Math.min(bounds.maximum, Math.round(dragStartOffset + movementY)));
      if (metric === "gust" && nextOffset > metricOffsets.wind) {
        const windButton = document.querySelector('[data-metric-opacity="wind"]');
        const windBounds = offsetBounds(windButton);
        nextOffset = Math.min(nextOffset, windBounds.maximum);
        metricOffsets.wind = nextOffset;
      } else if (metric === "wind" && nextOffset < metricOffsets.gust) {
        const gustButton = document.querySelector('[data-metric-opacity="gust"]');
        const gustBounds = offsetBounds(gustButton);
        nextOffset = Math.max(nextOffset, gustBounds.minimum);
        metricOffsets.gust = nextOffset;
      }
      metricOffsets[metric] = nextOffset;
      applyMetricOpacities();
    };
    const finishDrag = () => {
      if (!dragged) return;
      button.dataset.suppressClick = "true";
      setTimeout(() => { button.dataset.suppressClick = "false"; }, 0);
    };
    button.onclick = () => {
      if (button.dataset.suppressClick === "true") {
        button.dataset.suppressClick = "false";
        return;
      }
      const activationOpacity = metric === "wind" || metric === "gust" ? 60 : 100;
      metricOpacities[metric] = metricOpacities[metric] > 0 ? 0 : activationOpacity;
      button.setAttribute("aria-pressed", String(metricOpacities[metric] > 0));
      applyMetricOpacities();
    };
    button.onpointerdown = event => {
      if (event.pointerType === "mouse" || event.button !== 0) return;
      beginDrag(event.clientX, event.clientY);
      button.setPointerCapture(event.pointerId);
    };
    button.onpointermove = event => {
      if (!button.hasPointerCapture(event.pointerId)) return;
      moveDrag(event.clientX, event.clientY);
    };
    button.onpointerup = event => {
      if (!button.hasPointerCapture(event.pointerId)) return;
      button.releasePointerCapture(event.pointerId);
      finishDrag();
    };
    button.onpointercancel = () => { dragged = false; };
    button.onmousedown = event => {
      if (event.button !== 0) return;
      beginDrag(event.clientX, event.clientY);
      const move = moveEvent => moveDrag(moveEvent.clientX, moveEvent.clientY);
      const end = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", end);
        finishDrag();
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", end);
    };
  });
  applyMetricOpacities();
}

function bindForecastLayout() {
  renderRainApiLinks();
  renderForecastApiLinks();
  renderWeekApiLinks();
  bind48HourForecastTitle();
  ensureWeekForecast();
}

function forecast48HourRangeTitle() {
  const start = new Date(todayDateKey() + "T12:00:00");
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return "Prévisions " + shortDateFormat.format(start) + " au " + shortDateFormat.format(end);
}

function set48HourForecastContentOpen(open) {
  const panel = $("panel-48h");
  const content = $("forecast-48h-content");
  const toggle = $("forecast-48h-title-toggle");
  if (!content || !toggle) return;
  content.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute("aria-label", (open ? "Replier " : "Déplier ") + forecast48HourRangeTitle().toLowerCase());
  toggle.title = open ? "Replier les prévisions" : "Déplier les prévisions";
  const chevron = toggle.querySelector(".forecast-title-chevron");
  if (chevron) chevron.textContent = open ? "⌃" : "⌄";
  if (!open && panel) {
    panel.hidden = true;
    panel.removeAttribute("data-focus-date");
    panel.removeAttribute("data-focus-hour");
    panel.removeAttribute("data-focus-metric");
    document.querySelectorAll("[data-open-48h-date]").forEach(item => item.setAttribute("aria-expanded", "false"));
    document.querySelector('[data-summary-target="wind48"]')?.setAttribute("aria-expanded", "false");
  }
}

function bind48HourForecastTitle() {
  const toggle = $("forecast-48h-title-toggle");
  const label = $("forecast-48h-title-label");
  if (!toggle || !label) return;
  label.textContent = forecast48HourRangeTitle();
  set48HourForecastContentOpen(true);
  toggle.addEventListener("click", () => set48HourForecastContentOpen(toggle.getAttribute("aria-expanded") !== "true"));
}

function sync48HourForecastFocus(scrollPage = false) {
  const panel = $("panel-48h");
  const dateKey = panel?.dataset.focusDate;
  if (!panel || panel.hidden || !dateKey) return;
  const focusHour = panel.dataset.focusHour;
  const marker = (focusHour ? panel.querySelector('[data-forecast-date="' + dateKey + '"][data-forecast-hour="' + focusHour + '"]') : null)
    || panel.querySelector('[data-forecast-date="' + dateKey + '"]');
  const master = $("forecast-horizontal-scroll");
  if (marker && master) {
    const scrollable = marker.closest(".overview-scroll, .chart-scroll");
    const left = Math.max(0, marker.offsetLeft - (focusHour ? 0 : Math.min(88, (scrollable?.clientWidth || master.clientWidth) * .08)));
    master.scrollLeft = left;
    master.dispatchEvent(new Event("scroll"));
  }
  if (scrollPage) panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function toggleDaily48HourForecast(button) {
  const panel = $("panel-48h");
  if (!panel) return;
  const dateKey = button.getAttribute("data-open-48h-date");
  const alreadyOpen = !panel.hidden && panel.dataset.focusDate === dateKey;
  document.querySelectorAll("[data-open-48h-date]").forEach(item => item.setAttribute("aria-expanded", "false"));
  if (alreadyOpen) {
    panel.hidden = true;
    panel.removeAttribute("data-focus-date");
    panel.removeAttribute("data-focus-hour");
    panel.removeAttribute("data-focus-metric");
    return;
  }
  const tomorrow = new Date(todayDateKey() + "T12:00:00");
  tomorrow.setDate(tomorrow.getDate() + 1);
  activeForecastSource = defaultForecastSource;
  Object.keys(metricOpacities).forEach(metric => { metricOpacities[metric] = 100; });
  panel.dataset.focusDate = dateKey;
  panel.dataset.focusHour = dateKey === forecastDateKey(tomorrow) ? "7" : "";
  panel.removeAttribute("data-focus-metric");
  panel.hidden = false;
  button.setAttribute("aria-expanded", "true");
  $("forecast-48h-title-label").textContent = forecast48HourRangeTitle();
  set48HourForecastContentOpen(true);
  renderActiveForecast();
  requestAnimationFrame(() => sync48HourForecastFocus(true));
}

function open48HourWindForecast() {
  const panel = $("panel-48h");
  if (!panel) return;
  if (!panel.hidden && panel.dataset.focusMetric === "wind") {
    set48HourForecastContentOpen(false);
    return;
  }
  Object.keys(metricOpacities).forEach(metric => {
    metricOpacities[metric] = metric === "wind" || metric === "gust" ? 100 : 0;
  });
  document.querySelectorAll("[data-open-48h-date]").forEach(item => item.setAttribute("aria-expanded", "false"));
  panel.dataset.focusDate = todayDateKey();
  panel.dataset.focusHour = "";
  panel.dataset.focusMetric = "wind";
  panel.hidden = false;
  document.querySelector('[data-summary-target="wind48"]')?.setAttribute("aria-expanded", "true");
  $("forecast-48h-title-label").textContent = forecast48HourRangeTitle();
  set48HourForecastContentOpen(true);
  renderActiveForecast();
  applyMetricOpacities();
  requestAnimationFrame(() => sync48HourForecastFocus(true));
}

const vigilancePhenomenonIds = {
  "Vent violent": 1,
  "Pluie-inondation": 2,
  Orages: 3,
  Crues: 4,
  "Neige-verglas": 5,
  Canicule: 6,
  "Grand froid": 7,
  Avalanches: 8,
  "Vagues-submersion": 9
};

function isLocalVigilanceAlert(alert) {
  const phenomenonId = Number(alert?.id) || vigilancePhenomenonIds[alert?.label] || 0;
  return phenomenonId !== 4 && alert?.label !== "Crues";
}

function vigilanceAlertsForSlot(vigilance, dateKey, startHour, endHour) {
  const slotStart = new Date(dateKey + "T" + String(startHour).padStart(2, "0") + ":00:00").getTime();
  const slotEnd = new Date(dateKey + "T" + String(endHour).padStart(2, "0") + ":00:00").getTime();
  if (!Number.isFinite(slotStart) || !Number.isFinite(slotEnd)) return [];
  return (vigilance?.alerts || []).filter(isLocalVigilanceAlert).map(alert => {
    const periods = (Array.isArray(alert.timeline) && alert.timeline.length
      ? alert.timeline
      : [{ colorId: alert.colorId, start: alert.start, end: alert.end }])
      .filter(period => {
        const start = new Date(period.start).getTime();
        const end = new Date(period.end).getTime();
        return Number(period.colorId) >= 2 && Number.isFinite(start) && Number.isFinite(end) && start < slotEnd && end > slotStart;
      });
    if (!periods.length) return null;
    const strongest = periods.reduce((selected, period) => Number(period.colorId) > Number(selected.colorId) ? period : selected);
    return {
      phenomenonId: Number(alert.id) || vigilancePhenomenonIds[alert.label] || 0,
      label: alert.label || "Phénomène",
      colorId: Number(strongest.colorId),
      start: strongest.start,
      end: strongest.end
    };
  }).filter(alert => alert?.phenomenonId)
    .sort((left, right) => right.colorId - left.colorId || left.phenomenonId - right.phenomenonId);
}

function vigilanceSlotIcons(alerts) {
  if (!alerts.length) return "";
  const levels = { 2: "jaune", 3: "orange", 4: "rouge" };
  return '<span class="daily-vigilance-icons">' + alerts.map(alert => {
    const level = levels[alert.colorId] || "jaune";
    const period = alert.start && alert.end ? " · Du " + dateTimeFormat.format(new Date(alert.start)) + " au " + dateTimeFormat.format(new Date(alert.end)) : "";
    const description = "Vigilance " + level + " " + alert.label + period;
    return '<a class="daily-vigilance-badge" href="https://vigilance.meteofrance.fr/fr/drome" target="_blank" rel="noopener noreferrer" data-level="' + level + '" aria-label="' + escapeText(description + " · Consulter Météo-France (nouvel onglet)") + '" title="' + escapeText(description) + '"><strong>DRÔME</strong><span class="daily-vigilance-icon type-' + alert.phenomenonId + '" data-level="' + level + '" aria-hidden="true"><i></i></span></a>';
  }).join("") + "</span>";
}

const eclipsePeak = new Date("2026-08-12T20:23:00+02:00").getTime();
const eclipseWindow = { start: new Date("2026-08-12T19:20:00+02:00").getTime(), end: new Date("2026-08-12T21:20:00+02:00").getTime() };
function isEclipsePeakSlot(date, duration = 3600000) {
  const start = date.getTime();
  return start <= eclipsePeak && eclipsePeak < start + duration;
}

function eclipseOverlayMarkup(timelineStart, timelineEnd, timelineWidth) {
  const start = Math.max(timelineStart, eclipseWindow.start);
  const end = Math.min(timelineEnd, eclipseWindow.end);
  if (end <= start) return "";
  const duration = timelineEnd - timelineStart;
  const left = (start - timelineStart) / duration * timelineWidth;
  const overlayWidth = (end - start) / duration * timelineWidth;
  const peak = Math.max(0, Math.min(100, (eclipsePeak - start) / (end - start) * 100));
  return '<div class="eclipse-timeline-wash" style="left:' + left.toFixed(2) + 'px;width:' + overlayWidth.toFixed(2) + 'px;--eclipse-peak:' + peak.toFixed(2) + '%" title="Éclipse solaire · maximum vers 20 h 23"></div>';
}


function compactMinutesLabel(minutes) {
  const rounded = Math.max(0, Math.round(Number(minutes) || 0));
  if (rounded < 60) return rounded + "min";
  const hours = Math.floor(rounded / 60);
  const remaining = rounded % 60;
  return hours + "h" + (remaining ? String(remaining).padStart(2, "0") : "");
}

function shortEtaLabel(minutes) {
  if (!Number.isFinite(minutes)) return "à confirmer";
  if (minutes <= 0) return "en cours";
  if (minutes < 1) return "moins d’une minute";
  return compactMinutesLabel(minutes);
}

// Calcul transféré au moteur : nowcastCellContainsPoint.

// Calcul transféré au moteur : nowcastCellTraversal.

// Calcul transféré au moteur : nowcastCellProjectedPassages.

// Calcul transféré au moteur : nowcastCellRainProfilePassages.

// Calcul transféré au moteur : nowcastCellPostContactDeparture.

// Calcul transféré au moteur : nowcastCellProjectionQuality.

// Calcul transféré au moteur : nowcastPreviousProjection.

// Calcul transféré au moteur : nowcastProjectionFingerprint.

// Calcul transféré au moteur : nowcastProjectionProfileSignature.

// Calcul transféré au moteur : nowcastProjectionFresh.

// Calcul transféré au moteur : nowcastProjectionHistory.

// Calcul transféré au moteur : nowcastArrivalProjectionQuality.

// Calcul transféré au moteur : nowcastMedian.

// Calcul transféré au moteur : nowcastPresenceAssessment.

// Calcul transféré au moteur : nowcastProjectionAssessment.

// Calcul transféré au moteur : nowcastProjectionSnapshot.

// Calcul transféré au moteur : nowcastNextProjectionHistory.

function nowcastEtaRainEvents(radar) {
  return currentNowcast()?.etaRainEvents || [];
}

// Calcul transféré au moteur : nowcastEtaRainEligible.

// Calcul transféré au moteur : nowcastPresenceRainEligible.

// Calcul transféré au moteur : nowcastReliablePassageEventForCell.

// Calcul transféré au moteur : nowcastCellLocallyObservedInterior.

// Calcul transféré au moteur : nowcastAnnouncedCellPassageRisk.

// Calcul transféré au moteur : nowcastCellPassageObserved.

// Calcul transféré au moteur : nowcastDisplayedCellPassageRisk.

// Calcul transféré au moteur : nowcastEtaRainRateAt.

// Calcul transféré au moteur : nowcastEtaRainAmount.

// Calcul transféré au moteur : shortTermRainTrend.

function stormRiskIntensityStep(riskLevel, intensityLevel) {
  const risk = Math.max(0, Math.min(5, Math.round(Number(riskLevel) || 0)));
  const intensity = Math.max(0, Math.min(5, Math.round(Number(intensityLevel) || 0)));
  if (risk >= 5 && intensity >= 5) return 5;
  if (risk >= 4 && intensity >= 4) return 4;
  if (risk >= 3 || (risk > 0 && intensity >= 3)) return 3;
  return risk;
}

// Calcul transféré au moteur : stormHazardIntensityStep.

// Calcul transféré au moteur : rainRateFromAccumulation.

// Calcul transféré au moteur : rainIntensityStep.

// Calcul transféré au moteur : onlyDrizzleInThreeHours.

function rainIntensityLabel(intensityLevel = 0) {
  const level = Math.max(0, Math.min(5, Math.round(Number(intensityLevel) || 0)));
  return level >= 5 ? "Pluie violente" : level >= 4 ? "Pluie forte" : level >= 3 ? "Pluie soutenue" : level >= 2 ? "Pluie" : "Pluie faible";
}

// Calcul transféré au moteur : rainPhaseForStep.

// Calcul transféré au moteur : rainPhaseLabel.

// Calcul transféré au moteur : rainPhaseRank.

// Calcul transféré au moteur : nextRainPhaseTransition.

// Calcul transféré au moteur : shortTermRainTransitionLabel.

function shortTermRiskQualifier(risk) {
  if (risk == null || !Number.isFinite(Number(risk))) return "";
  const probability = Math.max(0, Number(risk) || 0);
  return probability >= 80 ? "" : probability >= 55 ? " probable" : " possible";
}

// Calcul transféré au moteur : shortTermHailQualifier.

function threeHourTrendIsSignificant(kind, trend) {
  if (!trend || trend.label === "stable") return false;
  const change = Math.abs(Number(trend.change) || 0);
  if (kind === "rain") return change >= .5;
  if (kind === "wind") return change >= 1;
  if (kind === "gust") return change >= 15;
  if (kind === "storm") return change >= (trend.basis === "displayed-level" ? 2 : 30);
  return false;
}

function shortTermEventLabel(kind, etaMinutes, activeCount = 0) {
  const rain = kind === "rain";
  const eta = etaMinutes == null ? null : Number(etaMinutes);
  if (!Number.isFinite(eta) || eta < 0) return rain ? "pas de pluie" : "pas d’orage";
  if (eta < 1) {
    if (!rain && Number(activeCount) > 0) {
      const count = Math.max(1, Math.round(Number(activeCount)));
      return count + (count > 1 ? " orages" : " orage");
    }
    return rain ? "Pluie" : "Orage";
  }
  return (rain ? "Pluie" : "Orage") + " dans " + compactMinutesLabel(Math.max(1, eta));
}

// Calcul transféré au moteur : shortTermRainLabel.

// Calcul transféré au moteur : shortTermRainSequenceLabel.

// Calcul transféré au moteur : shortTermRainCellLabel.

// Calcul transféré au moteur : shortTermStormLabel.

function shortTermGustLabel(intensityLevel) {
  const level = Math.max(0, Math.min(5, Math.round(Number(intensityLevel) || 0)));
  return level >= 5 ? "Rafales violentes"
    : level >= 4 ? "Rafales très fortes"
    : level >= 3 ? "Rafales fortes"
    : level >= 2 ? "Rafales modérées"
    : level >= 1 ? "Rafales faibles"
    : "Pas de rafales";
}

function shortTermWindLabel(intensityLevel) {
  const level = Math.max(0, Math.min(5, Math.round(Number(intensityLevel) || 0)));
  return level >= 5 ? "Vent violent"
    : level >= 4 ? "Vent très fort"
    : level >= 3 ? "Vent fort"
    : level >= 2 ? "Vent modéré"
    : level >= 1 ? "Vent faible"
    : "Pas de vent";
}

// Calcul transféré au moteur : nowcastStormEtaSelection.

// Calcul transféré au moteur : nowcastUncertainRainBorder.

// Calcul transféré au moteur : formatRainAmount.

function renderApproachingCellsAlert(radar) {
  const banner = $("cell-approach-alert");
  const referenceTime = typeof appNow === "function" ? Number(appNow()) : Date.now();
  const events = nowcastEtaRainEvents(radar);
  const approaching = (radar?.cells || [])
    .filter(cell => Math.hypot(Number(cell.eastKm || 0), Number(cell.northKm || 0)) < 60)
    .map((cell, index) => {
    const distance = Math.hypot(Number(cell.eastKm || 0), Number(cell.northKm || 0));
    const point15 = cell.track?.points?.find(point => point.minutes === 15);
    if (!point15) return null;
    const distance15 = Math.hypot(Number(point15.eastKm || 0), Number(point15.northKm || 0));
    const radialSpeed = Math.round((distance15 - distance) * 4);
    if (radialSpeed >= -1) return null;
    const reliableEvent = nowcastReliablePassageEventForCell(events, cell, referenceTime);
    const passageRisk = nowcastAnnouncedCellPassageRisk(cell, reliableEvent, radar);
    if (!Number.isFinite(passageRisk) || passageRisk <= 0 || !reliableEvent) return null;
    const etaMinutes = Math.max(0, (Number(reliableEvent.eventStart) - referenceTime) / 60000);
    const eta = shortEtaLabel(etaMinutes);
    return { id: cell.id || String.fromCharCode(65 + index), distance, speed: Math.abs(radialSpeed), eta, etaMinutes, passageRisk };
  }).filter(Boolean);
  banner.hidden = !approaching.length;
  if (!approaching.length) return;
  const maximumRisk = Math.max(...approaching.map(cell => cell.passageRisk));
  const level = maximumRisk >= 60 ? "red" : maximumRisk >= 30 ? "orange" : "yellow";
  banner.dataset.level = level;
  const title = "Perturbation en approche";
  const nearest = [...approaching].sort((left, right) => left.distance - right.distance)[0];
  const passageLabel = nearest.passageRisk >= 60 ? "passage probable" : "passage possible";
  const passageTiming = nearest.etaMinutes <= 0
    ? "en cours"
    : nearest.etaMinutes < 1 ? "dans moins d’une minute" : "dans environ " + compactMinutesLabel(nearest.etaMinutes);
  const summary = nearest.passageRisk > 0 && Number.isFinite(nearest.etaMinutes)
    ? "À " + nearest.distance.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " km · " + passageLabel + " " + passageTiming
    : "À " + nearest.distance.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " km · rapprochement à " + nearest.speed + " km/h";
  const details = approaching.map(cell => {
    const itemLevel = cell.passageRisk >= 60 ? "rouge" : cell.passageRisk >= 30 ? "orange" : "jaune";
    return '<li data-alert-level="' + itemLevel + '"><strong>Cellule ' + escapeText(cell.id) + ' · rapprochement ' + cell.speed + ' km/h</strong><span>Distance : ' + cell.distance.toFixed(1) + ' km · ETA : ' + escapeText(cell.eta) + ' · risque de passage : ' + cell.passageRisk + ' %</span></li>';
  }).join("");
  banner.innerHTML = '<button type="button" class="approach-nowcast-button" aria-label="' + escapeText(title) + ' : ouvrir le nowcasting"><span class="vigilance-summary-title">' + escapeText(title) + '</span><span class="approach-nowcast-meta">' + escapeText(summary) + '</span><span class="vigilance-chevron" aria-hidden="true">↘</span></button>';
  banner.querySelector(".approach-nowcast-button").addEventListener("click", () => {
    $("tab-rain").click();
    requestAnimationFrame(() => $("radar-nowcast").scrollIntoView({ behavior: "smooth", block: "start" }));
  });
}

const rad = Math.PI / 180;
const dayMilliseconds = 86400000;
const julian1970 = 2440588;
const julian2000 = 2451545;

function sunTimes(date) {
  const toJulian = value => value.valueOf() / dayMilliseconds - 0.5 + julian1970;
  const fromJulian = value => new Date((value + 0.5 - julian1970) * dayMilliseconds);
  const days = toJulian(date) - julian2000;
  const longitudeWest = -point.lon * rad;
  const latitude = point.lat * rad;
  const cycle = Math.round(days - 0.0009 - longitudeWest / (2 * Math.PI));
  const transitApproximation = 0.0009 + (longitudeWest / (2 * Math.PI)) + cycle;
  const meanAnomaly = rad * (357.5291 + 0.98560028 * transitApproximation);
  const equationCenter = rad * (1.9148 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly) + 0.0003 * Math.sin(3 * meanAnomaly));
  const eclipticLongitude = meanAnomaly + equationCenter + rad * 102.9372 + Math.PI;
  const solarTransit = julian2000 + transitApproximation + 0.0053 * Math.sin(meanAnomaly) - 0.0069 * Math.sin(2 * eclipticLongitude);
  const declination = Math.asin(Math.sin(eclipticLongitude) * Math.sin(rad * 23.4397));
  const altitude = -0.833 * rad;
  const hourAngle = Math.acos((Math.sin(altitude) - Math.sin(latitude) * Math.sin(declination)) / (Math.cos(latitude) * Math.cos(declination)));
  const setApproximation = 0.0009 + (hourAngle + longitudeWest) / (2 * Math.PI) + cycle;
  const sunsetJulian = julian2000 + setApproximation + 0.0053 * Math.sin(meanAnomaly) - 0.0069 * Math.sin(2 * eclipticLongitude);
  return { sunrise: fromJulian(solarTransit - (sunsetJulian - solarTransit)), sunset: fromJulian(sunsetJulian) };
}

function nightLevel(timestamp, referenceDate) {
  const { sunrise, sunset } = sunTimes(referenceDate);
  const rise = sunrise.getTime();
  const set = sunset.getTime();
  const fade = 90 * 60000;
  if (timestamp <= rise - fade || timestamp >= set + fade) return 1;
  if (timestamp < rise + fade) return (rise + fade - timestamp) / (2 * fade);
  if (timestamp <= set - fade) return 0;
  return (timestamp - (set - fade)) / (2 * fade);
}

function daylightColor(timestamp, referenceDate) {
  const level = Math.max(0, Math.min(1, nightLevel(timestamp, referenceDate)));
  const day = [252, 252, 250];
  const night = [162, 175, 185];
  const channels = day.map((value, index) => Math.round(value + (night[index] - value) * level));
  return "rgb(" + channels.join(",") + ")";
}

function daylightStyle(date, timeAxis = false) {
  const start = date.getTime();
  const end = start + 3600000;
  const foreground = nightLevel(start + 1800000, date) >= .48 ? "#102f46" : "#102e52";
  const secondary = nightLevel(start + 1800000, date) >= .48 ? "#29495d" : "#435867";
  return "background:linear-gradient(90deg," + daylightColor(start, date) + " 0%," + daylightColor(end, date) + " 100%);--slot-foreground:" + foreground + ";--slot-secondary:" + secondary;
}

function forecastTextColor(date) {
  return nightLevel(date.getTime() + 1800000, date) >= .48 ? "#18394f" : "#4d5358";
}

function isNight(date) {
  const { sunrise, sunset } = sunTimes(date);
  return date < sunrise || date >= sunset;
}

const publicDataCacheName = "meteo-public-data-v1";

function cacheableApiTarget(target) {
  try {
    const url = new URL(target, document.baseURI);
    return url.origin === apiBaseUrl.origin && /\/api\/(dashboard|week)$/.test(url.pathname)
      || ["api.open-meteo.com", "ensemble-api.open-meteo.com"].includes(url.hostname);
  } catch {
    return false;
  }
}

async function readCachedJson(target, maximumAge) {
  if (!("caches" in window) || !cacheableApiTarget(target)) return null;
  try {
    const response = await (await caches.open(publicDataCacheName)).match(String(target));
    const cachedAt = Number(response?.headers.get("x-meteo-cached-at")) || 0;
    if (!response || !cachedAt || Date.now() - cachedAt > maximumAge) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function writeCachedJson(target, data) {
  if (!("caches" in window) || !cacheableApiTarget(target)) return;
  try {
    const response = new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json", "x-meteo-cached-at": String(Date.now()) }
    });
    await (await caches.open(publicDataCacheName)).put(String(target), response);
  } catch {}
}

async function json(url) {
  if (window.METEO_REPLAY?.request) return window.METEO_REPLAY.request(String(url));
  const target = typeof url === "string" && /^\/?api\//.test(url) ? apiUrl(url) : url;
  const isPreparedDashboard = /\/api\/dashboard(?:\?|$)/.test(String(target));
  const response = await fetch(target, { cache: isPreparedDashboard ? "default" : "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Erreur " + response.status);
  void writeCachedJson(target, data);
  return data;
}

function escapeText(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function moonPhaseIcon(date) {
  const synodicMonth = 29.530588853;
  const knownNewMoon = Date.UTC(2000, 0, 6, 18, 14);
  const elapsedDays = (date.getTime() - knownNewMoon) / dayMilliseconds;
  const phase = ((elapsedDays / synodicMonth) % 1 + 1) % 1;
  const angle = phase * Math.PI * 2;
  const radius = 14;
  const center = 16;
  const waxing = phase < 0.5;
  const limb = [];
  const terminator = [];
  const steps = 28;
  for (let index = 0; index <= steps; index++) {
    const y = -radius + radius * 2 * index / steps;
    const edge = Math.sqrt(Math.max(0, radius * radius - y * y));
    limb.push([center + (waxing ? edge : -edge), center + y]);
  }
  for (let index = steps; index >= 0; index--) {
    const y = -radius + radius * 2 * index / steps;
    const edge = Math.sqrt(Math.max(0, radius * radius - y * y));
    const terminatorX = waxing ? Math.cos(angle) * edge : -Math.cos(angle) * edge;
    terminator.push([center + terminatorX, center + y]);
  }
  const points = [...limb, ...terminator];
  const path = points.map((point, index) => (index ? "L" : "M") + point[0].toFixed(2) + " " + point[1].toFixed(2)).join(" ") + " Z";
  const illumination = Math.round((1 - Math.cos(angle)) * 50);
  return '<svg class="moon-phase" viewBox="0 0 32 32" role="img" aria-label="Lune éclairée à ' + illumination + '%"><circle class="moon-disk" cx="16" cy="16" r="14"/><path class="moon-light" d="' + path + '"/></svg>';
}

function moonPhaseMeteoconName(date) {
  const julian = date.getTime() / dayMilliseconds + 2440587.5;
  const phase = ((julian - 2451550.1) / 29.530588853 % 1 + 1) % 1;
  if (phase < .0625 || phase >= .9375) return "moon-new";
  if (phase < .1875) return "moon-waxing-crescent";
  if (phase < .3125) return "moon-first-quarter";
  if (phase < .4375) return "moon-waxing-gibbous";
  if (phase < .5625) return "moon-full";
  if (phase < .6875) return "moon-waning-gibbous";
  if (phase < .8125) return "moon-last-quarter";
  return "moon-waning-crescent";
}

function displayIcon(item) {
  const date = new Date(item.time);
  const night = item.forceDay === true ? false : isNight(date);
  const period = night ? "night" : "day";
  const cloud = cloudiness(item);
  const rain = Math.max(0, Number(item.rain) || 0);
  const rawCloudLevel = cloudCoverBand(cloud);
  const inferredRainLevel = rain < measurableRainThreshold ? 0 : rainPictogramStep(rain);
  const rainLevel = Math.max(0, Math.min(5, Math.round(item.rainLevel == null ? inferredRainLevel : Number(item.rainLevel) || 0)));
  const cloudLevel = rainLevel > 0 ? Math.max(1, rawCloudLevel) : rawCloudLevel;
  const cloudLabel = cloudCoverLabels[cloudLevel];
  const rainLabel = rainLevel >= 5 ? ", pluie forte" : rainLevel >= 3 ? ", pluie" : rainLevel === 2 ? ", pluie faible" : rainLevel === 1 ? ", bruine" : "";
  const label = (night ? "Nuit, ciel " : "Ciel ") + cloudLabel + rainLabel;
  const base = night && cloudLevel === 0 && rainLevel === 0
    ? "vendor/meteocons/" + moonPhaseMeteoconName(date) + ".svg"
    : "vendor/weather-variants/cloud-" + period + "-" + cloudLevel + ".svg";
  const rainMarkup = rainLevel ? '<img class="weather-rain-layer" src="vendor/weather-variants/rain-' + rainLevel + '.svg" alt="" loading="lazy" decoding="async">' : '';
  return '<span class="weather-variant-icon" role="img" aria-label="' + escapeText(label) + '"><img class="weather-cloud-layer" src="' + base + '" alt="" loading="lazy" decoding="async">' + rainMarkup + '</span>';
}

function stormSignalPictogram(detail, extraClass = "", withCloud = false) {
  const symbol = withCloud
    ? '<path class="storm-signal-cloud" d="M4.8 15.5a3.7 3.7 0 0 1 .4-7.4A5.7 5.7 0 0 1 16.4 6.8a4 4 0 0 1 3.3 1.7 3.6 3.6 0 0 1 .7 7H4.8Z"/><path class="storm-signal-bolt" d="m13.2 10.4-3.8 6h3.2l-1.5 6.5 8-9.8h-3.5l1.7-2.7h-4.1Z"/>'
    : '<path class="storm-signal-bolt" d="M13.5 2 6.8 13h5l-1.2 9L18 10.5h-5L13.5 2Z"/>';
  return '<span class="storm-signal-pictogram chart-point' + (extraClass ? " " + extraClass : "") + '" tabindex="0" role="img" aria-label="Orage possible" data-tooltip="' + escapeText(detail) + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + symbol + '</svg></span>';
}

function forecastStormPictogram(sourceLabel, item, periodLabel = "", extraClass = "") {
  if (!item) return "";
  const probability = Number(item.probability ?? item.precipitationProbabilityMax);
  const lightningDensity = Number(item.lightningDensity);
  const detail = "Orage possible — source " + sourceLabel
    + (periodLabel ? " · " + periodLabel : "")
    + (Number.isFinite(lightningDensity) && lightningDensity > 0 ? " · signal de foudre prévu" : "")
    + (Number.isFinite(probability) ? " · probabilité de précipitations " + Math.round(probability) + " %" : "");
  return stormSignalPictogram(detail, extraClass);
}

function cloudiness(item) {
  return Math.round(Math.max(0, Math.min(100, item.cloudCover)));
}

function weatherCodeLabel(code) {
  if (code === 0) return "Ensoleillé";
  if (code === 1) return "Peu nuageux";
  if (code === 2) return "Partiellement nuageux";
  if (code === 3) return "Couvert";
  if (code === 45 || code === 48) return "Brouillard";
  if (code >= 51 && code <= 57) return "Bruine";
  if (code >= 61 && code <= 67) return "Pluie";
  if (code >= 71 && code <= 77) return "Neige";
  if (code >= 80 && code <= 82) return "Averses";
  if (code === 85 || code === 86) return "Averses de neige";
  if (code >= 95) return "Orages";
  return "Conditions variables";
}

function dailyWeatherLabel(day) {
  const precipitation = Math.max(0, Number(day.precipitationSum) || 0);
  const code = Number(day.weatherCode);
  if (precipitation > 0 && precipitation < 1 && (code >= 51 && code <= 67 || code >= 80 && code <= 82)) {
    return "Faibles précipitations";
  }
  return weatherCodeLabel(code);
}

function todayDateKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/Paris"
  }).formatToParts(new Date(appNow()));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return values.year + "-" + values.month + "-" + values.day;
}

function forecastDateKey(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/Paris"
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return values.year + "-" + values.month + "-" + values.day;
}

function shiftForecastDateKey(dateKey, days) {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return String(dateKey);
  return new Date(Date.UTC(year, month - 1, day + Number(days || 0))).toISOString().slice(0, 10);
}

function weekForecastStartKey(now = new Date(appNow())) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    hourCycle: "h23", timeZone: "Europe/Paris"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  // Open-Meteo fournit des pas horaires. Conserver l'heure entamée évite
  // qu'à 23 h 01, le dernier point de 23 h soit déjà considéré comme passé.
  return values.year + "-" + values.month + "-" + values.day + "T" + values.hour + ":00";
}

const forecastPeriodOrder = ["night", "morning", "afternoon", "late_afternoon", "evening"];
const forecastDailySlots = Object.freeze([
  { key: "morning", label: "Matin", startHour: 6, endHour: 12, dayOffset: 0 },
  { key: "afternoon", label: "Après-midi", startHour: 12, endHour: 18, dayOffset: 0 },
  { key: "evening", label: "Soir", startHour: 18, endHour: 24, dayOffset: 0 },
  { key: "night", label: "Nuit", startHour: 0, endHour: 6, dayOffset: 1 }
]);

function forecastPeriodKey(hour) {
  return hour < 6 ? "night" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
}

function forecastPeriodText(periods) {
  const selected = [...new Set((periods || []).filter(period => forecastPeriodOrder.includes(period)))].sort((left, right) => forecastPeriodOrder.indexOf(left) - forecastPeriodOrder.indexOf(right));
  if (!selected.length) return "";
  const dayPeriods = ["morning", "afternoon", "evening"];
  if (selected.includes("night") && dayPeriods.every(period => selected.includes(period))) return "la nuit et toute la journée";
  if (dayPeriods.every(period => selected.includes(period)) && selected.every(period => dayPeriods.includes(period) || period === "late_afternoon")) return "toute la journée";
  if (!selected.includes("night") && selected.includes("morning") && selected.includes("afternoon") && selected.some(period => period === "late_afternoon" || period === "evening")) return "toute la journée";
  if (selected.join(",") === "night,morning") return "entre la nuit et la matinée";
  if (selected.join(",") === "morning,afternoon") return "du matin à l’après-midi";
  if (selected.join(",") === "afternoon,evening") return "de l’après-midi au soir";
  const labels = { night: "la nuit", morning: "le matin", afternoon: "l’après-midi", late_afternoon: "en fin de journée", evening: "le soir" };
  const words = selected.map(period => labels[period]);
  return words.length === 1 ? words[0] : words.slice(0, -1).join(", ") + " et " + words.at(-1);
}

function forecastSharedPeriods(leftPeriods, rightPeriods) {
  const left = [...new Set((leftPeriods || []).filter(period => forecastPeriodOrder.includes(period)))];
  const right = [...new Set((rightPeriods || []).filter(period => forecastPeriodOrder.includes(period)))];
  if (!left.length && !right.length) return [];
  if (!left.length || !right.length) return left.length ? left : right;
  const overlap = left.filter(period => right.includes(period));
  return overlap;
}

function forecastRainPeriods(leftPeriods, rightPeriods) {
  const shared = forecastSharedPeriods(leftPeriods, rightPeriods);
  if (shared.length) return shared;
  const left = [...new Set((leftPeriods || []).filter(period => forecastPeriodOrder.includes(period)))];
  const right = [...new Set((rightPeriods || []).filter(period => forecastPeriodOrder.includes(period)))];
  if (!left.length || !right.length) return [];
  const closestGap = Math.min(...left.flatMap(leftPeriod => right.map(rightPeriod =>
    Math.abs(forecastPeriodOrder.indexOf(leftPeriod) - forecastPeriodOrder.indexOf(rightPeriod))
  )));
  const combined = [...new Set([...left, ...right])].sort((first, second) => forecastPeriodOrder.indexOf(first) - forecastPeriodOrder.indexOf(second));
  // ARPEGE distingue seulement après-midi/soir tandis qu'Open-Meteo ajoute
  // une fin de journée solaire. Quand le désaccord reste dans cette zone,
  // « en fin de journée » exprime le meilleur compromis entre les modèles.
  const lateDayPeriods = new Set(["afternoon", "late_afternoon", "evening"]);
  if (combined.every(period => lateDayPeriods.has(period))) return ["late_afternoon"];
  return closestGap <= 1 ? combined : [];
}

function futureActiveWeekDay(day, now = new Date(appNow())) {
  if (!day || day.date !== todayDateKey()) return day;
  const forecastStart = weekForecastStartKey(now);
  return {
    ...day,
    time: forecastStart,
    forecastStart,
    windPeriod: null,
    gustPeriod: null,
    cloudCoverMorningMean: null,
    cloudCoverMorningMin: null,
    cloudCoverMorningMax: null,
    cloudCoverAfternoonMean: null,
    cloudCoverAfternoonMin: null,
    cloudCoverAfternoonMax: null
  };
}

function rainProbabilitySummary(values) {
  const valid = (Array.isArray(values) ? values : [values]).map(item => {
    const named = item && typeof item === "object";
    const rawValue = named ? item.value ?? item.probability : item;
    const value = rawValue == null || rawValue === "" ? NaN : Number(rawValue);
    return { value, name: named ? String(item.name || "") : "" };
  }).filter(item => Number.isFinite(item.value)).sort((left, right) => left.value - right.value);
  if (!valid.length) return { text: "À confirmer", detail: "probabilité à confirmer", average: null, kind: "unknown" };
  const lowEntry = valid[0];
  const highEntry = valid.at(-1);
  const low = lowEntry.value;
  const high = highEntry.value;
  const spread = high - low;
  const average = valid.reduce((sum, item) => sum + item.value, 0) / valid.length;
  const extremeContradiction = valid.length > 1 && low <= 10 && high >= 80;
  const kind = extremeContradiction ? "contradiction" : valid.length > 1 && spread >= 25 ? "disagreement" : valid.length > 1 && spread >= 15 ? "shared" : "likelihood";
  const likelihoodFor = value => value >= 90 ? "Prévue"
    : value >= 75 ? "Très probable"
    : value >= 55 ? "Probable"
    : value >= 35 ? "Possible"
    : value >= 20 ? "Envisagée"
    : value >= 5 ? "Peu probable" : "Très peu probable";
  // En synthèse, la qualification repose sur la borne basse : 37–74 % reste
  // « possible ». L'écart exact entre modèles est conservé dans le détail.
  const text = extremeContradiction ? "Incertain" : likelihoodFor(valid.length > 1 ? low : average);
  const namedDetail = valid.length > 1 && valid.every(item => item.name)
    ? valid.map(item => item.name + " " + Math.round(item.value) + " %").join(" · ")
    : null;
  const detail = namedDetail || (valid.length > 1 && high !== low ? Math.round(low) + " à " + Math.round(high) + " %" : Math.round(low) + " %");
  return { text, detail, average, kind, low, high, lowName: lowEntry.name, highName: highEntry.name };
}

function weekRainBelowDisplayThreshold(values, storm = false) {
  if (storm) return false;
  const summary = rainProbabilitySummary(values);
  return Number.isFinite(summary.high) && summary.high < rainRiskDisplayThreshold;
}

function conciseRainSummary(amount, probabilities, periods, showers = false, storm = false, probabilitySummary = null) {
  const rain = Math.max(0, Number(amount) || 0);
  const probability = probabilitySummary || rainProbabilitySummary(probabilities);
  const risk = Math.max(0, Number(probability.average) || 0);
  if (rain <= 0 && risk < 40 && !storm) return "";
  const timing = forecastPeriodText(periods);
  const quantity = rain <= 0 ? "sans cumul défini"
    : rain < .1 ? "sous forme de quelques gouttes"
    : rain < 1 ? "en très faible quantité"
    : rain < 5 ? "en faible quantité"
    : rain < 15 ? "en quantité modérée"
    : rain < 30 ? "en forte quantité" : "en très forte quantité";
  const plural = showers && !storm;
  const likelihood = probability.kind === "unknown" && rain > 0 ? "" : plural ? {
    "Prévue": "", "Très probable": "très probables", "Probable": "probables", "Possible": "possibles", "Envisagée": "envisagées", "Peu probable": "peu probables", "Très peu probable": "très peu probables", "Incertain": "incertaines", "À confirmer": "à confirmer"
  }[probability.text] : {
    "Prévue": "", "Très probable": "très probable", "Probable": "probable", "Possible": "possible", "Envisagée": "envisagée", "Peu probable": "peu probable", "Très peu probable": "très peu probable", "Incertain": "incertaine", "À confirmer": "à confirmer"
  }[probability.text];
  const subject = storm ? "Pluie orageuse" : showers ? "Averses" : "Pluie";
  return subject + (likelihood ? " " + likelihood : "") + " " + quantity + (timing ? " " + timing : "") + ".";
}

const cloudCoverLabels = ["dégagé", "très peu nuageux", "peu nuageux", "nuageux", "très nuageux", "couvert"];

function cloudCoverBand(value) {
  const cloud = Math.max(0, Math.min(100, Number(value)));
  return cloud <= 5 ? 0 : cloud <= 25 ? 1 : cloud <= 50 ? 2 : cloud <= 75 ? 3 : cloud <= 90 ? 4 : 5;
}

function cloudPercentile(values, ratio) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function dailyCloudProfile(samples, sunriseValue = null, sunsetValue = null) {
  const referenceDate = samples[0]?.time?.slice(0, 10);
  const fallbackSun = referenceDate ? sunTimes(new Date(referenceDate + "T12:00:00")) : null;
  const minuteOfDay = value => {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
      return Number(value.slice(11, 13)) * 60 + Number(value.slice(14, 16));
    }
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Europe/Paris"
    }).formatToParts(date).map(part => [part.type, part.value]));
    return Number(parts.hour) * 60 + Number(parts.minute);
  };
  const sampleMinute = sample => Number(sample.time.slice(11, 13)) * 60 + Number(sample.time.slice(14, 16));
  const sunrise = minuteOfDay(sunriseValue || fallbackSun?.sunrise);
  const sunset = minuteOfDay(sunsetValue || fallbackSun?.sunset);
  const solarMidpoint = Number.isFinite(sunrise) && Number.isFinite(sunset) ? (sunrise + sunset) / 2 : null;
  const points = samples.map(sample => ({ minute: sampleMinute(sample), value: Number(sample.cloudCover) }))
    .filter(point => Number.isFinite(point.minute) && Number.isFinite(point.value))
    .sort((left, right) => left.minute - right.minute);
  if (!points.length) return null;
  const spacings = points.slice(1).map((point, index) => point.minute - points[index].minute).filter(value => value > 0).sort((left, right) => left - right);
  const typicalSpacing = spacings.length ? spacings[Math.floor(spacings.length / 2)] : 60;
  const solarStart = Number.isFinite(sunrise) ? sunrise : points[0].minute - typicalSpacing / 2;
  const solarEnd = Number.isFinite(sunset) ? sunset : points.at(-1).minute + typicalSpacing / 2;
  const availableStart = Math.max(solarStart, points[0].minute - typicalSpacing / 2);
  const availableEnd = Math.min(solarEnd, points.at(-1).minute + typicalSpacing / 2);
  const integratedMean = (start, end) => {
    if (!(end > start)) return null;
    let weighted = 0;
    let duration = 0;
    points.forEach((point, index) => {
      const left = index ? (points[index - 1].minute + point.minute) / 2 : point.minute - typicalSpacing / 2;
      const right = index < points.length - 1 ? (point.minute + points[index + 1].minute) / 2 : point.minute + typicalSpacing / 2;
      const overlap = Math.max(0, Math.min(end, right) - Math.max(start, left));
      weighted += point.value * overlap;
      duration += overlap;
    });
    return duration ? weighted / duration : null;
  };
  const mean = integratedMean(availableStart, availableEnd);
  const morningMean = Number.isFinite(solarMidpoint) ? integratedMean(availableStart, Math.min(availableEnd, solarMidpoint)) : null;
  const afternoonMean = Number.isFinite(solarMidpoint) ? integratedMean(Math.max(availableStart, solarMidpoint), availableEnd) : null;
  if (!Number.isFinite(mean)) return null;
  const valid = points.filter(point => point.minute >= availableStart && point.minute <= availableEnd).map(point => point.value);
  const low = cloudPercentile(valid, .2);
  const high = cloudPercentile(valid, .8);
  const spread = high - low;
  // « Variable » est réservé à une forte évolution durable : au moins trente
  // points entre P20 et P80, avec traversée d'au moins deux niveaux de ciel.
  const variable = valid.length >= 4 && spread >= 30 && Math.abs(cloudCoverBand(high) - cloudCoverBand(low)) >= 2;
  const integratedHalves = [morningMean, afternoonMean].filter(Number.isFinite);
  return {
    mean, morningMean, afternoonMean,
    morningMin: morningMean, morningMax: morningMean,
    afternoonMin: afternoonMean, afternoonMax: afternoonMean,
    min: integratedHalves.length ? Math.min(...integratedHalves) : mean,
    max: integratedHalves.length ? Math.max(...integratedHalves) : mean,
    low,
    high,
    variable
  };
}

function cloudCoverDailyRange(days) {
  const entries = (Array.isArray(days) ? days : [days]).filter(day => day && typeof day === "object");
  const minimums = entries.map(day => day.cloudCoverMin).filter(value => value != null).map(Number).filter(Number.isFinite);
  const maximums = entries.map(day => day.cloudCoverMax).filter(value => value != null).map(Number).filter(Number.isFinite);
  // En synthèse, un modèle peut encore provenir d'un cache antérieur qui ne
  // contient pas le min–max horaire. Ne pas abandonner pour autant la plage
  // fournie par l'autre modèle, au risque de retomber sur deux moyennes.
  if (!minimums.length || !maximums.length) return null;
  return { min: Math.min(...minimums), max: Math.max(...maximums) };
}

function cloudCoverPresentation(days) {
  const entries = (Array.isArray(days) ? days : [days]).map(day => {
    if (day && typeof day === "object") {
      // La moyenne qualifie le ciel global; les demi-journées ne servent qu'à
      // décrire une évolution nette, dont la ligne affiche alors le min–max.
      const mean = Number(day.cloudCoverMean ?? day.cloudCover);
      if (!Number.isFinite(mean)) return null;
      const morningMean = day.cloudCoverMorningMean == null ? null : Number(day.cloudCoverMorningMean);
      const afternoonMean = day.cloudCoverAfternoonMean == null ? null : Number(day.cloudCoverAfternoonMean);
      const read = key => day[key] == null ? null : Number(day[key]);
      return {
        mean,
        morningMean: Number.isFinite(morningMean) ? morningMean : null,
        afternoonMean: Number.isFinite(afternoonMean) ? afternoonMean : null,
        morningMin: read("cloudCoverMorningMin"),
        morningMax: read("cloudCoverMorningMax"),
        afternoonMin: read("cloudCoverAfternoonMin"),
        afternoonMax: read("cloudCoverAfternoonMax"),
        min: read("cloudCoverMin"),
        max: read("cloudCoverMax"),
        variable: Boolean(day.cloudVariable)
      };
    }
    const mean = Number(day);
    return Number.isFinite(mean) ? { mean, variable: false } : null;
  }).filter(Boolean);
  if (!entries.length) return { text: "", mean: null, morning: null, afternoon: null };
  const mean = entries.reduce((sum, entry) => sum + entry.mean, 0) / entries.length;
  const morningValues = entries.map(entry => entry.morningMean).filter(Number.isFinite);
  const afternoonValues = entries.map(entry => entry.afternoonMean).filter(Number.isFinite);
  if (morningValues.length && afternoonValues.length) {
    const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;
    const morning = average(morningValues);
    const afternoon = average(afternoonValues);
    const morningBand = cloudCoverBand(morning);
    const afternoonBand = cloudCoverBand(afternoon);
    if (Math.abs(morning - afternoon) >= 30 && Math.abs(morningBand - afternoonBand) >= 2) {
      return {
        text: "Ciel " + cloudCoverLabels[morningBand] + " le matin, " + cloudCoverLabels[afternoonBand] + " l’après-midi.",
        mean,
        morning,
        afternoon
      };
    }
  }
  // Sans différence notable et qualifiable entre matin et après-midi, une
  // seule ligne est affichée : son texte doit reprendre la moyenne intégrée.
  // « Variable » ne doit jamais accompagner un pictogramme à niveau unique.
  return { text: "Ciel " + cloudCoverLabels[cloudCoverBand(mean)] + ".", mean, morning: null, afternoon: null };
}

function conciseSkySummary(days) {
  return cloudCoverPresentation(days).text;
}

function conciseWindSummary(speedValues, gustValues, gustPeriods, windPeriods = [], directionValues = []) {
  const winds = (Array.isArray(speedValues) ? speedValues : [speedValues]).map(Number).filter(Number.isFinite);
  const gusts = (Array.isArray(gustValues) ? gustValues : [gustValues]).map(Number).filter(Number.isFinite);
  const directions = (Array.isArray(directionValues) ? directionValues : [directionValues]).map(Number).filter(Number.isFinite);
  if (!winds.length && !gusts.length) return "";
  const windLabels = ["très léger", "très léger", "léger", "modéré", "soutenu", "fort"];
  const gustLabels = ["faibles", "faibles", "modérées", "fortes", "très fortes", "violentes"];
  const windQualifier = value => windLabels[meanWindIntensityLevel(value)];
  const gustQualifier = value => gustLabels[gustIntensityLevel(value)];
  const dominantQualifier = (values, qualifier, labels) => {
    const qualified = values.map(qualifier);
    const counts = Object.fromEntries(labels.map(label => [label, qualified.filter(value => value === label).length]));
    const dominant = labels.reduce((choice, label) => counts[label] >= counts[choice] ? label : choice, labels[0]);
    const indexes = qualified.map(value => labels.indexOf(value));
    const low = Math.min(...indexes);
    const high = Math.max(...indexes);
    if (low === high) return labels[low];
    // Avec deux modèles, un désaccord de classe ne doit pas être tranché en
    // faveur du plus fort : c'est une synthèse, pas le maximum d'une source.
    if (values.length <= 2) return labels[low] + " à " + labels[high];
    return high - low >= 3 ? labels[low] + " à " + labels[high] : dominant;
  };
  const windMaximum = winds.length ? Math.max(...winds) : 0;
  const gustMaximum = gusts.length ? Math.max(...gusts) : 0;
  if (windMaximum <= 0 && gustMaximum <= 0) return "Pas de vent.";
  const windLow = winds.length ? windQualifier(Math.min(...winds)) : "";
  const windHigh = winds.length ? windQualifier(windMaximum) : "";
  const direction = directions.length ? (Math.atan2(
    directions.reduce((sum, value) => sum + Math.sin(value * Math.PI / 180), 0),
    directions.reduce((sum, value) => sum + Math.cos(value * Math.PI / 180), 0)
  ) * 180 / Math.PI + 360) % 360 : null;
  const directionLabels = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
  const directionLabel = direction == null ? "" : directionLabels[Math.round(direction / 45) % 8];
  const directionText = directionLabel ? (/^[EO]/.test(directionLabel) ? " d’" : " de ") + directionLabel : "";
  const parts = [];
  const windTiming = forecastPeriodText(windPeriods);
  const gustTiming = forecastPeriodText(gustPeriods);
  const sharedTiming = windTiming && windTiming === gustTiming ? windTiming : "";
  const finish = () => {
    const joined = parts.length > 1 ? parts.slice(0, -1).join(", ") + " et " + parts.at(-1) : parts[0] || "";
    const summary = joined + (sharedTiming ? " surtout " + sharedTiming : "");
    return summary ? summary.charAt(0).toUpperCase() + summary.slice(1) + "." : "";
  };
  if (winds.length && windMaximum > 0) {
    const windSummary = dominantQualifier(winds, windQualifier, ["très léger", "léger", "modéré", "soutenu", "fort"]);
    const windDescription = "Vent " + windSummary;
    parts.push(windDescription + directionText + (windTiming && !sharedTiming ? " surtout " + windTiming : ""));
  }
  if (!gusts.length || gustMaximum <= 0) return parts.length ? parts.join(", ") + "." : "Pas de vent.";
  const gustLow = gustQualifier(Math.min(...gusts));
  const gustHigh = gustQualifier(Math.max(...gusts));
  if (sharedTiming && windHigh === "fort" && gustHigh === "fortes" && windLow === windHigh && gustLow === gustHigh) {
    return "Vent et rafales fortes" + directionText + " surtout " + sharedTiming + ".";
  }
  const gustSummary = dominantQualifier(gusts, gustQualifier, ["faibles", "modérées", "fortes", "très fortes", "violentes"]);
  if (gustMaximum < 35) {
    parts.push("rafales " + gustSummary + (gustTiming && !sharedTiming ? " surtout " + gustTiming : ""));
    return finish();
  }
  parts.push("rafales " + gustSummary + (gustTiming && !sharedTiming ? " surtout " + gustTiming : ""));
  return finish();
}

function backgroundTrendArrow(values, threshold = 0) {
  const series = (values || []).map(Number).filter(Number.isFinite);
  if (series.length < 2) return "→";
  const edgeCount = Math.max(1, Math.floor(series.length / 2));
  const median = items => {
    const sorted = [...items].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const change = median(series.slice(-edgeCount)) - median(series.slice(0, edgeCount));
  const neutralRange = Math.max(0, Number(threshold) || 0);
  return change > neutralRange ? "↗" : change < -neutralRange ? "↘" : "→";
}

function normalizeOpenMeteoDays(daily, hourly) {
  const forecastStart = weekForecastStartKey();
  const today = todayDateKey();
  const hourlyByDate = new Map();
  (hourly?.time || []).forEach((time, index) => {
    const date = time.slice(0, 10);
    if (!hourlyByDate.has(date)) hourlyByDate.set(date, []);
    hourlyByDate.get(date).push({
      time,
      period: forecastPeriodKey(Number(time.slice(11, 13))),
      precipitation: Math.max(0, Number(hourly.precipitation?.[index]) || 0),
      probability: Math.max(0, Number(hourly.precipitation_probability?.[index]) || 0),
      rain: Math.max(0, Number(hourly.rain?.[index]) || 0),
      showers: Math.max(0, Number(hourly.showers?.[index]) || 0),
      temperature: Number(hourly.temperature_2m?.[index]),
      apparentTemperature: Number(hourly.apparent_temperature?.[index]),
      weatherCode: Number(hourly.weather_code?.[index]),
      cloudCover: Number(hourly.cloud_cover?.[index]),
      windSpeed: Math.max(0, Number(hourly.wind_speed_10m?.[index]) || 0),
      windDirection: Number(hourly.wind_direction_10m?.[index]),
      windGust: Math.max(0, Number(hourly.wind_gusts_10m?.[index]) || 0)
    });
  });
  const finite = (samples, key) => samples.map(sample => sample[key]).filter(Number.isFinite);
  const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const representativeCode = samples => {
    const rank = code => code >= 95 ? 7 : code >= 80 ? 6 : code >= 71 ? 5 : code >= 51 ? 4 : code >= 45 ? 3 : code >= 3 ? 2 : code >= 1 ? 1 : 0;
    return samples.reduce((selected, sample) => rank(sample.weatherCode) > rank(selected) ? sample.weatherCode : selected, 0);
  };
  const solarPeriod = (sample, sunriseValue, sunsetValue) => {
    const minute = Number(sample.time.slice(11, 13)) * 60 + Number(sample.time.slice(14, 16));
    const readMinute = value => value && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)
      ? Number(value.slice(11, 13)) * 60 + Number(value.slice(14, 16)) : null;
    const sunrise = readMinute(sunriseValue);
    const sunset = readMinute(sunsetValue);
    if (!Number.isFinite(sunrise) || !Number.isFinite(sunset)) return sample.period;
    const midpoint = (sunrise + sunset) / 2;
    const lateStart = midpoint + (sunset - midpoint) * .6;
    return minute < sunrise ? "night" : minute < midpoint ? "morning" : minute < lateStart ? "afternoon" : minute < sunset ? "late_afternoon" : "evening";
  };
  const characteristicPeriod = (samples, key, minimumGap, sunrise, sunset) => {
    const maxima = forecastPeriodOrder.map(period => ({
      period,
      value: Math.max(...samples.filter(sample => solarPeriod(sample, sunrise, sunset) === period).map(sample => Number(sample[key])).filter(Number.isFinite), -Infinity)
    })).filter(item => Number.isFinite(item.value)).sort((left, right) => right.value - left.value);
    if (!maxima.length) return null;
    if (maxima.length === 1) return maxima[0].period;
    const gap = maxima[0].value - maxima[1].value;
    return gap >= Math.max(minimumGap, maxima[0].value * .2) ? maxima[0].period : null;
  };
  return (daily?.time || []).map((date, index) => {
    const isToday = date === today;
    const allSamples = hourlyByDate.get(date) || [];
    const samples = isToday ? allSamples.filter(sample => sample.time >= forecastStart) : allSamples;
    if (isToday && !samples.length) return null;
    const remainingProbability = samples.length ? Math.max(...samples.map(sample => sample.probability)) : null;
    const dailyProbability = isToday ? remainingProbability : daily.precipitation_probability_max?.[index] ?? null;
    const rainSamples = samples.filter(sample => sample.precipitation >= .02);
    const sunrise = daily.sunrise?.[index];
    const sunset = daily.sunset?.[index];
    const windPeriod = characteristicPeriod(samples, "windSpeed", 5, sunrise, sunset);
    const gustPeriod = characteristicPeriod(samples, "windGust", 8, sunrise, sunset);
    const temperatures = finite(samples, "temperature");
    const apparentTemperatures = finite(samples, "apparentTemperature");
    const clouds = finite(samples, "cloudCover");
    const cloudProfile = dailyCloudProfile(samples, sunrise, sunset);
    const winds = finite(samples, "windSpeed");
    const gusts = finite(samples, "windGust");
    const directions = finite(samples, "windDirection");
    const remainingPrecipitation = samples.reduce((sum, sample) => sum + sample.precipitation, 0);
    const remainingRain = samples.reduce((sum, sample) => sum + sample.rain, 0);
    const remainingShowers = samples.reduce((sum, sample) => sum + sample.showers, 0);
    const remainingDirection = directions.length ? (Math.atan2(directions.reduce((sum, value) => sum + Math.sin(value * Math.PI / 180), 0), directions.reduce((sum, value) => sum + Math.cos(value * Math.PI / 180), 0)) * 180 / Math.PI + 360) % 360 : null;
    const periodSummary = (slot) => {
      const slotDate = shiftForecastDateKey(date, slot.dayOffset);
      const slotSamples = hourlyByDate.get(slotDate) || [];
      const periodSamples = slotSamples.filter(sample => {
        const hour = Number(sample.time.slice(11, 13));
        return hour >= slot.startHour && hour < slot.endHour;
      });
      if (!periodSamples.length) return null;
      const values = key => finite(periodSamples, key);
      const temperatures = values("temperature");
      const clouds = values("cloudCover");
      const winds = values("windSpeed");
      const gusts = values("windGust");
      const periodDirections = values("windDirection");
      const temperatureReferences = periodSamples.map(sample => ({
        temperature: sample.temperature,
        normal: temperatureNormalAt(sample.time)
      })).filter(item => Number.isFinite(item.temperature) && item.normal);
      const temperatureAnomalies = temperatureReferences.map(item => item.temperature - item.normal.median);
      const direction = periodDirections.length ? (Math.atan2(periodDirections.reduce((sum, value) => sum + Math.sin(value * Math.PI / 180), 0), periodDirections.reduce((sum, value) => sum + Math.cos(value * Math.PI / 180), 0)) * 180 / Math.PI + 360) % 360 : null;
      const timedRain = periodSamples.map(sample => ({
        hour: Number(sample.time.slice(11, 13)) + .5,
        amount: Math.max(0, Number(sample.precipitation) || 0)
      })).filter(sample => sample.amount >= possibleDrizzleThreshold);
      const timedRainTotal = timedRain.reduce((sum, sample) => sum + sample.amount, 0);
      const periodRainTotal = periodSamples.reduce((sum, sample) => sum + Math.max(0, Number(sample.precipitation) || 0), 0);
      const rainWindows3h = periodSamples.map((_, startIndex) => periodSamples.slice(startIndex, startIndex + 3));
      const peakRain3h = rainWindows3h.reduce((peak, window) => Math.max(
        peak,
        window.reduce((sum, sample) => sum + Math.max(0, Number(sample.precipitation) || 0), 0)
      ), 0);
      const stormRainOverlap = rainWindows3h.some(window => {
        const windowRain = window.reduce((sum, sample) => sum + Math.max(0, Number(sample.precipitation) || 0), 0);
        return windowRain >= 10 && window.some(sample => Number(sample.weatherCode) >= 95 && Math.max(0, Number(sample.precipitation) || 0) >= possibleDrizzleThreshold);
      }) || (periodRainTotal >= 15 && periodSamples.some(sample => Number(sample.weatherCode) >= 95 && Math.max(0, Number(sample.precipitation) || 0) >= possibleDrizzleThreshold));
      const stormRainWindOverlap = periodSamples.some(sample =>
        Number(sample.weatherCode) >= 95
        && Math.max(0, Number(sample.precipitation) || 0) >= .5
        && (Math.max(0, Number(sample.windSpeed) || 0) >= 30 || Math.max(0, Number(sample.windGust) || 0) >= 50)
      );
      const weightedRainHour = timedRainTotal > 0
        ? timedRain.reduce((sum, sample) => sum + sample.hour * sample.amount, 0) / timedRainTotal
        : null;
      const rainTiming = weightedRainHour == null ? null
        : weightedRainHour < slot.startHour + (slot.endHour - slot.startHour) / 3 ? "start"
        : weightedRainHour >= slot.startHour + (slot.endHour - slot.startHour) * 2 / 3 ? "end"
        : "middle";
      return {
        time: periodSamples[Math.floor(periodSamples.length / 2)]?.time || date + "T12:00",
        weatherCode: representativeCode(periodSamples),
        temperatureMin: temperatures.length ? Math.min(...temperatures) : null,
        temperatureMax: temperatures.length ? Math.max(...temperatures) : null,
        cloudCover: average(clouds),
        precipitationSum: periodRainTotal,
        peakRain3h,
        stormRainOverlap,
        stormRainWindOverlap,
        precipitationProbabilityMax: Math.max(...periodSamples.map(sample => sample.probability), 0),
        windSpeedMax: winds.length ? Math.max(...winds) : null,
        windGustMax: gusts.length ? Math.max(...gusts) : null,
        windDirection: direction,
        rainTiming,
        storm: periodSamples.some(sample => sample.weatherCode >= 95),
        temperatureNormal: average(temperatureReferences.map(item => item.normal.median)),
        temperatureAnomaly: average(temperatureAnomalies),
        temperatureWarmShare: temperatureReferences.length ? temperatureReferences.filter(item => item.temperature >= item.normal.high).length / temperatureReferences.length : null,
        temperatureColdShare: temperatureReferences.length ? temperatureReferences.filter(item => item.temperature <= item.normal.low).length / temperatureReferences.length : null,
        backgroundTrends: {
          cloud: backgroundTrendArrow(periodSamples.map(sample => sample.cloudCover), 15),
          rain: backgroundTrendArrow(periodSamples.map(sample => sample.precipitation), .2),
          wind: backgroundTrendArrow(periodSamples.map(sample => sample.windSpeed), 5),
          gust: backgroundTrendArrow(periodSamples.map(sample => sample.windGust), 8),
          storm: backgroundTrendArrow(periodSamples.map(sample => Number(sample.weatherCode) >= 95 ? 1 : 0), .34)
        }
      };
    };
    return {
      date,
      time: date + "T12:00",
      forecastStart: isToday ? forecastStart : null,
      weatherCode: isToday ? representativeCode(samples) : daily.weather_code?.[index] ?? null,
      temperatureMax: isToday ? Math.max(...temperatures) : daily.temperature_2m_max?.[index],
      temperatureMin: isToday ? Math.min(...temperatures) : daily.temperature_2m_min?.[index],
      apparentTemperatureMax: isToday && apparentTemperatures.length ? Math.max(...apparentTemperatures) : daily.apparent_temperature_max?.[index],
      apparentTemperatureMin: isToday && apparentTemperatures.length ? Math.min(...apparentTemperatures) : daily.apparent_temperature_min?.[index],
      precipitationSum: isToday ? remainingPrecipitation : daily.precipitation_sum?.[index] || 0,
      rainSum: isToday ? remainingRain : daily.rain_sum?.[index] || 0,
      showersSum: isToday ? remainingShowers : daily.showers_sum?.[index] || 0,
      precipitationProbabilityMax: dailyProbability,
      cloudCover: isToday ? average(clouds) ?? 0 : daily.cloud_cover_mean?.[index] ?? 0,
      cloudCoverMean: cloudProfile?.mean ?? (isToday ? average(clouds) ?? 0 : daily.cloud_cover_mean?.[index] ?? 0),
      cloudCoverMorningMean: cloudProfile?.morningMean ?? null,
      cloudCoverAfternoonMean: cloudProfile?.afternoonMean ?? null,
      cloudCoverMorningMin: cloudProfile?.morningMin ?? null,
      cloudCoverMorningMax: cloudProfile?.morningMax ?? null,
      cloudCoverAfternoonMin: cloudProfile?.afternoonMin ?? null,
      cloudCoverAfternoonMax: cloudProfile?.afternoonMax ?? null,
      cloudCoverMin: cloudProfile?.min ?? null,
      cloudCoverMax: cloudProfile?.max ?? null,
      cloudCoverLow: cloudProfile?.low ?? null,
      cloudCoverHigh: cloudProfile?.high ?? null,
      cloudVariable: cloudProfile?.variable || false,
      windSpeedMax: isToday && winds.length ? Math.max(...winds) : daily.wind_speed_10m_max?.[index],
      windGustMax: isToday && gusts.length ? Math.max(...gusts) : daily.wind_gusts_10m_max?.[index],
      windDirection: isToday ? remainingDirection : daily.wind_direction_10m_dominant?.[index],
      sunrise,
      sunset,
      rainPeriods: [...new Set(rainSamples.map(sample => sample.period))],
      windPeriod,
      gustPeriod,
      // La nuit affichée après le soir de J utilise explicitement les heures
      // 00–06 de J+1 : « nuit J → J+1 », comme dans les bulletins publics.
      periods: Object.fromEntries(forecastDailySlots.map(slot => [slot.key, periodSummary(slot)]))
    };
  }).filter(Boolean);
}

function normalizeDashboardOpenMeteoDays(openMeteo) {
  if (!openMeteo?.days?.length || !openMeteo?.hours?.length) return [];
  const daily = {};
  ["time", "weather_code", "temperature_2m_max", "temperature_2m_min", "apparent_temperature_max", "apparent_temperature_min", "precipitation_sum", "rain_sum", "showers_sum", "precipitation_probability_max", "cloud_cover_mean", "wind_speed_10m_max", "wind_gusts_10m_max", "wind_direction_10m_dominant", "sunrise", "sunset"].forEach(key => { daily[key] = []; });
  openMeteo.days.forEach(day => {
    daily.time.push(day.date);
    daily.weather_code.push(day.weatherCode);
    daily.temperature_2m_max.push(day.temperatureMax);
    daily.temperature_2m_min.push(day.temperatureMin);
    daily.apparent_temperature_max.push(day.apparentTemperatureMax);
    daily.apparent_temperature_min.push(day.apparentTemperatureMin);
    daily.precipitation_sum.push(day.precipitationSum);
    daily.rain_sum.push(day.rainSum);
    daily.showers_sum.push(day.showersSum);
    daily.precipitation_probability_max.push(day.precipitationProbabilityMax);
    daily.cloud_cover_mean.push(day.cloudCover);
    daily.wind_speed_10m_max.push(day.windSpeedMax);
    daily.wind_gusts_10m_max.push(day.windGustMax);
    daily.wind_direction_10m_dominant.push(day.windDirection);
    daily.sunrise.push(day.sunrise);
    daily.sunset.push(day.sunset);
  });
  const hourly = {};
  ["time", "temperature_2m", "apparent_temperature", "precipitation", "rain", "showers", "precipitation_probability", "weather_code", "cloud_cover", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m"].forEach(key => { hourly[key] = []; });
  openMeteo.hours.forEach(hour => {
    hourly.time.push(hour.time);
    hourly.temperature_2m.push(hour.temperature);
    hourly.apparent_temperature.push(null);
    hourly.precipitation.push(hour.rain);
    hourly.rain.push(hour.rain);
    hourly.showers.push(0);
    hourly.precipitation_probability.push(hour.probability);
    hourly.weather_code.push(hour.weatherCode);
    hourly.cloud_cover.push(hour.cloudiness);
    hourly.wind_speed_10m.push(hour.windSpeed);
    hourly.wind_direction_10m.push(hour.windDirection);
    hourly.wind_gusts_10m.push(hour.windGust);
  });
  // Le tableau de bord fournit déjà 48 h détaillées : les afficher tout de
  // suite, puis laisser la requête hebdomadaire compléter les jours suivants.
  return normalizeOpenMeteoDays(daily, hourly).filter(day => Object.values(day.periods || {}).some(Boolean));
}

function dashboardOpenMeteoWeekDay(day) {
  return {
    ...day,
    cloudCoverMean: day.cloudCover,
    cloudCoverMorningMean: null,
    cloudCoverAfternoonMean: null,
    cloudCoverLow: day.cloudCover,
    cloudCoverHigh: day.cloudCover,
    cloudVariable: false,
    rainPeriods: [],
    windPeriod: null,
    gustPeriod: null,
    confidence: null
  };
}

function includeCurrentDashboardDay(days) {
  const today = todayDateKey();
  if (days.some(day => day.date === today)) return days;
  const current = latestForecastData?.openMeteo?.days?.find(day => day.date === today);
  return current ? [dashboardOpenMeteoWeekDay(current), ...days].sort((left, right) => left.date.localeCompare(right.date)) : days;
}

function normalizeWeekConfidence(hourly) {
  const forecastStart = weekForecastStartKey();
  const groups = new Map();
  (hourly?.time || []).forEach((time, index) => {
    if (time.slice(0, 10) === todayDateKey() && time < forecastStart) return;
    const date = time.slice(0, 10);
    if (!groups.has(date)) groups.set(date, { temperature: [], precipitation: [], wind: [] });
    const group = groups.get(date);
    const add = (values, value) => { if (Number.isFinite(Number(value))) values.push(Number(value)); };
    add(group.temperature, hourly.temperature_2m_spread?.[index]);
    add(group.precipitation, hourly.precipitation_spread?.[index]);
    add(group.wind, hourly.wind_speed_10m_spread?.[index]);
  });
  return new Map([...groups].map(([date, values]) => {
    const average = list => list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null;
    const maximum = list => list.length ? Math.max(...list) : null;
    const temperatureSpread = average(values.temperature);
    const precipitationSpread = maximum(values.precipitation);
    const windSpread = average(values.wind);
    if (![temperatureSpread, precipitationSpread, windSpread].every(Number.isFinite)) return [date, null];
    const uncertainty = (temperatureSpread / 2 + precipitationSpread / 1 + windSpread / 5) / 3;
    const level = uncertainty <= .45 ? "strong" : uncertainty <= .8 ? "medium" : "low";
    const label = level === "strong" ? "forte" : level === "medium" ? "moyenne" : "faible";
    return [date, { level, label, temperatureSpread, precipitationSpread, windSpread }];
  }));
}

function refreshActiveOpenMeteoWeek() {
  if (!latestOpenMeteoWeekRaw) return;
  const confidenceByDate = new Map((latestWeekForecast?.days || []).map(day => [day.date, day.confidence || null]));
  latestWeekForecast = {
    fetchedAt: latestWeekForecast?.fetchedAt || Date.now(),
    model: "Open-Meteo",
    days: includeCurrentDashboardDay(normalizeOpenMeteoDays(latestOpenMeteoWeekRaw.daily, latestOpenMeteoWeekRaw.hourly))
      .map(day => ({ ...day, confidence: confidenceByDate.get(day.date) || null }))
  };
}

function scheduleActiveWeekDayUpdate() {
  clearTimeout(weekActiveDayTimer);
  const delay = 60000 - Date.now() % 60000 + 100;
  weekActiveDayTimer = setTimeout(() => {
    refreshActiveOpenMeteoWeek();
    renderWeekForecast();
    scheduleActiveWeekDayUpdate();
  }, delay);
}

function weekModelAgreement(ecmwf, arpege) {
  const value = item => item == null || item === "" ? null : Number.isFinite(Number(item)) ? Number(item) : null;
  const difference = (left, right) => left != null && right != null ? Math.abs(left - right) : null;
  const temperatureMax = difference(value(ecmwf.temperatureMax), value(arpege.temperatureMax));
  const temperatureMin = difference(value(ecmwf.temperatureMin), value(arpege.temperatureMin));
  const rain = difference(value(ecmwf.precipitationSum), value(arpege.precipitationSum));
  const wind = difference(value(ecmwf.windSpeedMax), value(arpege.windSpeedMax));
  const gust = difference(value(ecmwf.windGustMax), value(arpege.windGustMax));
  const cloud = difference(value(ecmwf.cloudCover), value(arpege.cloudCover));
  const wet = item => (value(item.precipitationSum) || 0) >= .2 || (value(item.precipitationProbabilityMax) || 0) >= 45;
  const storm = item => Boolean(item?.stormSignal) || Number(item?.weatherCode) >= 95;
  const rainProfiles = [
    { name: "Open-Meteo", item: ecmwf, amount: Math.max(0, value(ecmwf.precipitationSum) || 0), probability: value(ecmwf.precipitationProbabilityMax) },
    { name: "Météo-France", item: arpege, amount: Math.max(0, value(arpege.precipitationSum) || 0), probability: value(arpege.precipitationProbabilityMax) }
  ].map(profile => ({ ...profile, wet: wet(profile.item), storm: storm(profile.item) }));
  const wetProfiles = rainProfiles.filter(profile => profile.wet);
  const strongestRain = rainProfiles.reduce((strongest, profile) => profile.amount > strongest.amount ? profile : strongest, rainProfiles[0]);
  const rainSeverity = profile => profile.storm || profile.amount >= 10 ? 4
    : (profile.name === "Open-Meteo" && Number(profile.item.weatherCode) >= 80) || profile.amount >= 5 ? 3
    : profile.amount >= 1 || profile.probability >= 60 ? 2
    : profile.amount >= .1 || profile.probability >= 40 ? 1 : 0;
  const rainSeverityGap = Math.abs(rainSeverity(rainProfiles[0]) - rainSeverity(rainProfiles[1]));
  const rainDisagreement = rainSeverityGap >= 3 ? "major" : rainSeverityGap >= 2 ? "meaningful" : rainSeverityGap ? "minor" : "aligned";
  const amountLevel = profile => profile.amount <= 0 ? 0 : profile.amount < .1 ? 1 : profile.amount < 1 ? 2 : profile.amount < 5 ? 3 : profile.amount < 15 ? 4 : profile.amount < 30 ? 5 : 6;
  const amountLabels = ["nulle", "quelques gouttes", "très faible", "faible", "modérée", "forte", "très forte"];
  const amountLevels = rainProfiles.map(amountLevel);
  const lowestAmountLevel = Math.min(...amountLevels);
  const highestAmountLevel = Math.max(...amountLevels);
  const wettestProfile = rainProfiles[amountLevels.indexOf(highestAmountLevel)];
  const stormProfiles = rainProfiles.filter(profile => profile.storm);
  let rainCondition;
  let rainScenario;
  if (stormProfiles.length === 2) {
    rainCondition = "pluie/orage probable";
    rainScenario = "Les deux modèles retiennent un scénario pluvio-orageux.";
  } else if (stormProfiles.length === 1) {
    rainCondition = "pluie/orage selon " + stormProfiles[0].name;
    rainScenario = stormProfiles[0].name + " privilégie un scénario pluvio-orageux que l’autre modèle ne confirme pas.";
  } else if (highestAmountLevel === 0) {
    rainCondition = "temps sec probable";
    rainScenario = Math.max(...rainProfiles.map(profile => profile.probability)) >= 50
      ? "Les deux modèles n’annoncent pas de cumul défini, même si une possibilité de pluie subsiste."
      : "Les deux modèles privilégient une journée sans pluie notable.";
  } else if (lowestAmountLevel === 0 && highestAmountLevel <= 2) {
    rainCondition = "quelques gouttes possibles";
    rainScenario = "Les deux modèles privilégient un scénario globalement sec, avec au plus de très faibles précipitations.";
  } else if (lowestAmountLevel === 0 && highestAmountLevel === 3) {
    rainCondition = "faible pluie possible";
    rainScenario = "Le scénario reste globalement peu pluvieux, même si " + wettestProfile.name + " envisage de faibles précipitations.";
  } else if (lowestAmountLevel === 1 && highestAmountLevel <= 2) {
    rainCondition = "quelques gouttes possibles";
    rainScenario = "Les deux modèles envisagent seulement quelques gouttes à de très faibles précipitations.";
  } else if (lowestAmountLevel === 1 && highestAmountLevel === 3) {
    rainCondition = "faible pluie possible";
    rainScenario = "Les deux modèles retiennent un scénario peu pluvieux, de quelques gouttes à de faibles précipitations selon le modèle.";
  } else {
    const amountRange = lowestAmountLevel === highestAmountLevel ? amountLabels[highestAmountLevel] : amountLabels[lowestAmountLevel] + " à " + amountLabels[highestAmountLevel];
    rainCondition = highestAmountLevel >= 4 ? "pluie probable" : "pluie possible";
    rainScenario = "Les deux modèles prévoient de la pluie, en quantité " + amountRange + (lowestAmountLevel === highestAmountLevel ? "." : " selon le modèle.");
  }
  const rainIconAmount = Math.max(strongestRain.amount, wetProfiles.length ? .1 : 0);
  const openMeteoShowersState = (value(ecmwf.showersSum) || 0) >= .1 ? "yes" : Number(ecmwf.weatherCode) >= 80 ? "probable" : "no";
  // La convergence dépend de l'amplitude des écarts, et pas seulement du
  // franchissement d'un seuil. La puissance > 1 accentue les écarts importants.
  const divergencePenalty = (gap, significantGap) => gap == null
    ? null
    : Math.min(1.5, Math.pow(Math.max(0, gap) / significantGap, 1.35));
  const rainReference = Math.max(1.5, Math.max(...rainProfiles.map(profile => profile.amount)) * .45);
  const factors = [
    { name: "température maximale", penalty: divergencePenalty(temperatureMax, 3.5), weight: 1.3 },
    { name: "température minimale", penalty: divergencePenalty(temperatureMin, 3.5), weight: 1.3 },
    { name: "cumul de pluie", penalty: divergencePenalty(rain, rainReference), weight: 2.4 },
    { name: "scénario de pluie", penalty: rainSeverityGap / 4, weight: 2.2 },
    { name: "scénario orageux", penalty: storm(ecmwf) === storm(arpege) ? 0 : 1.5, weight: 3 },
    { name: "vent", penalty: divergencePenalty(wind, 16), weight: 1 },
    { name: "rafales", penalty: divergencePenalty(gust, 24), weight: 1 },
    { name: "nébulosité", penalty: divergencePenalty(cloud, 40), weight: .7 }
  ].filter(factor => Number.isFinite(factor.penalty));
  const totalWeight = factors.reduce((sum, factor) => sum + factor.weight, 0);
  const divergence = totalWeight
    ? factors.reduce((sum, factor) => sum + factor.penalty * factor.weight, 0) / totalWeight
    : 1;
  const score = Math.max(0, Math.min(1, 1 - divergence));
  const majorMagnitudeDifference = factors.some(factor => factor.weight >= 1 && factor.penalty >= 1.2);
  let level = score >= .78 ? "agreement" : score >= .48 ? "mixed" : "disagreement";
  // Un écart extrême sur une seule grandeur ne peut plus être dilué par les
  // autres paramètres, même si ceux-ci sont proches.
  if (storm(ecmwf) !== storm(arpege) || rainSeverityGap >= 3) level = "disagreement";
  else if ((rainSeverityGap >= 2 || majorMagnitudeDifference) && level === "agreement") level = "mixed";
  const label = level === "agreement" ? "Concordance nette" : level === "mixed" ? "Concordance partielle" : "Désaccord marqué";
  const cloudValues = [value(ecmwf.cloudCover), value(arpege.cloudCover)].filter(Number.isFinite);
  const windValues = [value(ecmwf.windSpeedMax), value(arpege.windSpeedMax)].filter(Number.isFinite);
  const gustValues = [value(ecmwf.windGustMax), value(arpege.windGustMax)].filter(Number.isFinite);
  const rainAmountMean = rainProfiles.reduce((sum, profile) => sum + profile.amount, 0) / rainProfiles.length;
  const rainPeriods = forecastRainPeriods(ecmwf.rainPeriods, arpege.rainPeriods);
  const gustPeriods = forecastSharedPeriods(ecmwf.gustPeriod ? [ecmwf.gustPeriod] : [], arpege.gustPeriod ? [arpege.gustPeriod] : []);
  const windPeriods = forecastSharedPeriods(ecmwf.windPeriod ? [ecmwf.windPeriod] : [], arpege.windPeriod ? [arpege.windPeriod] : []);
  const skySummary = conciseSkySummary([ecmwf, arpege]);
  const rainProbability = rainProbabilitySummary(rainProfiles.map(profile => ({ value: profile.probability, name: profile.name })));
  const rainSummary = weekRainBelowDisplayThreshold(rainProfiles.map(profile => profile.probability), Boolean(stormProfiles.length)) ? "" : conciseRainSummary(rainAmountMean, [], rainPeriods, openMeteoShowersState !== "no" && !stormProfiles.length, Boolean(stormProfiles.length), rainProbability) || "Pas de pluie.";
  const windSummary = conciseWindSummary(windValues, gustValues, gustPeriods, windPeriods, [ecmwf.windDirection, arpege.windDirection]);
  const confidenceLevels = [ecmwf.confidence?.level, arpege.confidence?.level].filter(Boolean);
  const stability = confidenceLevels.includes("low") ? "variable" : confidenceLevels.includes("medium") ? "evolving" : confidenceLevels.length ? "stable" : "unknown";
  const description = [skySummary, rainSummary, windSummary].filter(Boolean).join(" ");
  const criticalDisagreement = rainDisagreement === "major" || storm(ecmwf) !== storm(arpege);
  return {
    level, label, score, description, skySummary, rainSummary, windSummary, stability, criticalDisagreement, rainCondition, rainIconAmount, rainDisagreement, rainProbability,
    details: [
      temperatureMax != null ? "max. " + temperatureMax.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " °C" : null,
      temperatureMin != null ? "min. " + temperatureMin.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " °C" : null,
      rain != null ? "pluie " + rain.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " mm" : null,
      wind != null ? "vent " + Math.round(wind) + " km/h" : null,
      cloud != null ? "ciel " + Math.round(cloud) + " points" : null
    ].filter(Boolean)
  };
}

function weekForecastEvolution() {
  const fields = day => ({
    temperatureMax: Number(day.temperatureMax), temperatureMin: Number(day.temperatureMin),
    precipitationSum: Number(day.precipitationSum), precipitationProbabilityMax: Number(day.precipitationProbabilityMax), showersSum: Number(day.showersSum),
    cloudCover: Number(day.cloudCover), cloudCoverMean: Number(day.cloudCoverMean),
    cloudCoverMorningMean: Number(day.cloudCoverMorningMean), cloudCoverAfternoonMean: Number(day.cloudCoverAfternoonMean),
    cloudCoverMorningMin: Number(day.cloudCoverMorningMin), cloudCoverMorningMax: Number(day.cloudCoverMorningMax),
    cloudCoverAfternoonMin: Number(day.cloudCoverAfternoonMin), cloudCoverAfternoonMax: Number(day.cloudCoverAfternoonMax),
    cloudCoverMin: Number(day.cloudCoverMin), cloudCoverMax: Number(day.cloudCoverMax), cloudCoverLow: Number(day.cloudCoverLow),
    cloudCoverHigh: Number(day.cloudCoverHigh), cloudVariable: Boolean(day.cloudVariable), windSpeedMax: Number(day.windSpeedMax), windGustMax: Number(day.windGustMax),
    weatherCode: Number(day.weatherCode), stormSignal: Boolean(day.stormSignal), rainPeriods: Array.isArray(day.rainPeriods) ? day.rainPeriods.slice().sort() : null,
    windPeriod: day.windPeriod || null, gustPeriod: day.gustPeriod || null
  });
  const current = {
    ecmwf: Object.fromEntries((latestWeekForecast?.days || []).map(day => [day.date, fields(day)])),
    arpege: Object.fromEntries((latestMeteoFranceWeek?.days || []).map(day => [day.date, fields({ ...day, stormSignal: meteoFranceStormForDate(day.date) })]))
  };
  const currentSignature = JSON.stringify(current);
  let history = Array.isArray(latestWeekEvolutionHistory) ? latestWeekEvolutionHistory.filter(item => item?.models) : [];
  // L'historique fourni par le serveur est la référence commune aux deux
  // domaines. Le stockage local ne sert qu'en secours, sinon GitHub Pages et
  // le site principal finissent par comparer des séries différentes.
  if (!history.length) {
    try {
      const stored = JSON.parse(localStorage.getItem("week-forecast-history-v2") || "null");
      if (Array.isArray(stored?.history)) history = stored.history.filter(item => item?.models);
      if (!history.length) {
        const previous = JSON.parse(localStorage.getItem("week-forecast-history-v1") || "null");
        if (previous?.models) history.push(previous);
      }
    } catch {
      history = [];
    }
  }
  history.sort((left, right) => Number(left.savedAt || 0) - Number(right.savedAt || 0));
  if (JSON.stringify(history.at(-1)?.models) !== currentSignature) history.push({ savedAt: Date.now(), models: current });
  history = history.slice(-6);
  const signature = JSON.stringify(history.map(item => item.models));
  if (signature === weekEvolutionState.signature) return weekEvolutionState.byDate;
  const byDate = new Map();
  const dates = [...new Set([...Object.keys(current.ecmwf), ...Object.keys(current.arpege)])];
  const wet = day => day && ((day.precipitationSum || 0) >= .2 || (day.precipitationProbabilityMax || 0) >= 45);
  const changesBetween = (beforeModels, afterModels, date) => {
    const changes = new Set();
    let comparable = false;
    let stormComparable = false;
    let stormChanged = false;
    const stormByModel = {};
    ["ecmwf", "arpege"].forEach(model => {
      const before = beforeModels?.[model]?.[date];
      const after = afterModels?.[model]?.[date];
      if (!before || !after) return;
      comparable = true;
      if (Math.abs(after.temperatureMax - before.temperatureMax) >= 2.5 || Math.abs(after.temperatureMin - before.temperatureMin) >= 2.5) changes.add("températures");
      if (Math.abs(after.precipitationSum - before.precipitationSum) >= 2 || wet(after) !== wet(before)) changes.add("pluie");
      if (before.rainPeriods && after.rainPeriods && JSON.stringify(before.rainPeriods) !== JSON.stringify(after.rainPeriods)) changes.add("horaire de la pluie");
      if (model === "ecmwf" && (Math.abs(after.showersSum - before.showersSum) >= 1 || (after.weatherCode >= 80) !== (before.weatherCode >= 80))) changes.add("averses");
      if (Math.abs(after.cloudCover - before.cloudCover) >= 25) changes.add("ciel");
      if (Math.abs(after.windSpeedMax - before.windSpeedMax) >= 10 || Math.abs(after.windGustMax - before.windGustMax) >= 15) changes.add("vent");
      if (before.gustPeriod && after.gustPeriod && before.gustPeriod !== after.gustPeriod) changes.add("horaire des rafales");
      stormComparable = true;
      const beforeStorm = Boolean(before.stormSignal) || before.weatherCode >= 95;
      const afterStorm = Boolean(after.stormSignal) || after.weatherCode >= 95;
      stormByModel[model] = { comparable: true, changed: afterStorm !== beforeStorm };
      if (afterStorm !== beforeStorm) {
        stormChanged = true;
        changes.add("orage");
      }
    });
    return { comparable, changes, stormComparable, stormChanged, stormByModel };
  };
  dates.forEach(date => {
    const transitions = history.slice(1).map((item, index) => changesBetween(history[index].models, item.models, date)).filter(item => item.comparable);
    const changedTransitions = transitions.filter(item => item.changes.size);
    const changes = new Set(changedTransitions.flatMap(item => [...item.changes]));
    const changeRate = transitions.length ? changedTransitions.length / transitions.length : null;
    const stabilityPoints = Number.isFinite(changeRate) ? Math.max(1, Math.round((1 - changeRate) * 5)) : 0;
    const frequent = stabilityPoints <= 2;
    const level = !transitions.length ? "unknown" : !changedTransitions.length ? "stable" : frequent ? "frequent" : "few";
    const description = level === "frequent" ? "Changements fréquents sur : " + [...changes].join(", ") + "."
      : level === "few" ? "Quelques changements récents sur : " + [...changes].join(", ") + "."
      : "";
    const stormTransitions = transitions.filter(item => item.stormComparable);
    const stormChangedCount = stormTransitions.filter(item => item.stormChanged).length;
    const stormByModel = Object.fromEntries(["ecmwf", "arpege"].map(model => {
      const modelTransitions = transitions.filter(item => item.stormByModel?.[model]?.comparable);
      return [model, {
        changedCount: modelTransitions.filter(item => item.stormByModel[model].changed).length,
        transitionCount: modelTransitions.length
      }];
    }));
    byDate.set(date, { level, description, changeRate, changedCount: changedTransitions.length, transitionCount: transitions.length, stormChangedCount, stormTransitionCount: stormTransitions.length, stormByModel });
  });
  try { localStorage.setItem("week-forecast-history-v2", JSON.stringify({ history })); } catch {}
  weekEvolutionState = { signature, byDate };
  return byDate;
}

function meteoFranceStormForDate(dateKey) {
  const weekDay = (latestMeteoFranceWeek?.days || []).find(day => day.date === dateKey);
  if (weekDay?.stormSignal) return true;
  return (latestForecastData?.arome?.hours || []).some(hour => hour.stormSignal && forecastDateKey(new Date(hour.time)) === dateKey);
}

function weekStormRisk(dateKey, { includeOpenMeteo = true, includeMeteoFrance = true, individual = false } = {}) {
  const openMeteoDay = (latestWeekForecast?.days || []).find(day => day.date === dateKey) || null;
  const sources = [
    includeOpenMeteo && Number(openMeteoDay?.weatherCode) >= 95 ? "Open-Meteo" : "",
    includeMeteoFrance && meteoFranceStormForDate(dateKey) ? "Météo-France" : ""
  ].filter(Boolean);
  if (!sources.length) return { level: 0, baseLevel: 0, instabilityPenalty: 0, horizonDays: null, sources };
  const targetDay = Date.parse(dateKey + "T12:00:00Z");
  const currentDay = Date.parse(todayDateKey() + "T12:00:00Z");
  const horizonDays = Math.max(0, Math.round((targetDay - currentDay) / 86400000));
  const evolution = weekForecastEvolution().get(dateKey) || null;
  if (individual) {
    const model = includeOpenMeteo && !includeMeteoFrance ? "ecmwf" : includeMeteoFrance && !includeOpenMeteo ? "arpege" : null;
    const sourceEvolution = model ? evolution?.stormByModel?.[model] : null;
    const comparisons = Number(sourceEvolution?.transitionCount) || 0;
    const changes = Number(sourceEvolution?.changedCount) || 0;
    const stabilityLevel = !comparisons ? 3 : Math.max(3, 5 - changes);
    const temporalCeiling = horizonDays >= 4 ? 3 : horizonDays >= 2 ? 4 : 5;
    const level = Math.min(stabilityLevel, temporalCeiling);
    const stabilityLabel = !comparisons
      ? "historique encore insuffisant : minimum 3 sur 5"
      : temporalCeiling < stabilityLevel
        ? (changes
          ? changes + " changement" + (changes > 1 ? "s" : "") + " récent" + (changes > 1 ? "s" : "")
          : "signal stable dans les prévisions récentes") + ", plafonné à " + level + " sur 5 par l’échéance"
      : changes
        ? changes + " changement" + (changes > 1 ? "s" : "") + " récent" + (changes > 1 ? "s" : "") + " : " + level + " sur 5"
        : "signal stable dans les prévisions récentes : 5 sur 5";
    return { level, baseLevel: 5, instabilityPenalty: Math.min(2, changes), horizonDays, sources, individual: true, stabilityLabel, stormChangedCount: changes, stormTransitionCount: comparisons, temporalCeiling };
  }
  if (sources.length >= 2) {
    const openMeteoLevel = weekStormRisk(dateKey, { includeOpenMeteo: true, includeMeteoFrance: false, individual: true }).level;
    const meteoFranceLevel = weekStormRisk(dateKey, { includeOpenMeteo: false, includeMeteoFrance: true, individual: true }).level;
    return {
      level: Math.floor((openMeteoLevel + meteoFranceLevel) / 2),
      baseLevel: 5,
      instabilityPenalty: 0,
      horizonDays,
      sources,
      individualLevels: { openMeteo: openMeteoLevel, meteoFrance: meteoFranceLevel }
    };
  }
  // À l'échelle quotidienne, la veille fait déjà partie de l'échéance proche :
  // un signal explicite ne doit pas être présenté comme un simple 1/5.
  const nearLevel = horizonDays <= 1 ? 3 : horizonDays === 2 ? 2 : 1;
  const baseLevel = sources.length >= 2 ? nearLevel + 2 : nearLevel;
  const instabilityPenalty = Number(evolution?.stormChangedCount) >= 2 ? 2 : Number(evolution?.stormChangedCount) === 1 ? 1 : 0;
  return {
    // La stabilité nuance la convergence de plusieurs sources, sans faire
    // descendre une source individuelle sous son plancher temporel.
    level: Math.max(nearLevel, Math.min(5, baseLevel - instabilityPenalty)),
    baseLevel,
    instabilityPenalty,
    horizonDays,
    sources
  };
}

function weekWeightedValue(openMeteo, meteoFrance) {
  const numeric = value => value != null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
  const om = numeric(openMeteo), mf = numeric(meteoFrance);
  return mf == null ? om : om == null ? mf : .3 * om + .7 * mf;
}

function renderTestingDailyForecast() {
  const target = $("week-forecast");
  if (!target) return;
  const openPeriodKeys = new Set([...target.querySelectorAll(".daily-period-card[open][data-period-key]")]
    .map(detail => detail.dataset.periodKey));
  const format = (value, digits = 1) => value != null && Number.isFinite(Number(value))
    ? Number(value).toLocaleString("fr-FR", { maximumFractionDigits: digits }) : "—";
  const dateFromKey = dateKey => new Date(dateKey + "T12:00:00");
  const relativeDayLabel = day => {
    if (day.date === todayDateKey()) return "Aujourd’hui";
    const todayNoon = dateFromKey(todayDateKey()).getTime();
    const gap = Math.round((dateFromKey(day.date).getTime() - todayNoon) / 86400000);
    if (gap === 1) return "Demain";
    const weekday = weekDayFormat.format(dateFromKey(day.date));
    return weekday.charAt(0).toUpperCase() + weekday.slice(1);
  };
  const weatherDescription = period => {
    if (!period) return "";
    const rain = Math.max(0, Number(period.precipitationSum) || 0);
    const probability = Math.max(0, Number(period.precipitationProbabilityMax) || 0);
    const gust = Math.max(0, Number(period.windGustMax) || 0);
    const parts = [];
    if (period.storm) parts.push(Number(period.weatherCode) >= 96 ? "Orage violent possible" : "Orage possible");
    else if (rain >= 5) parts.push(format(rain) + " mm de pluie");
    else if (probability >= 70) parts.push("Pluie probable");
    const gustLevel = gustIntensityLevel(gust);
    if (gustLevel >= 3) parts.push(shortTermGustLabel(gustLevel));
    return parts.join(" · ");
  };
  const hazardPictogram = (kind, detail) => kind === "storm"
    ? stormSignalPictogram(detail, "daily-hazard-symbol storm")
    : '<span class="daily-hazard-symbol wind chart-point" tabindex="0" role="img" aria-label="Vent fort" data-tooltip="' + escapeText(detail) + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h11c3 0 3-4 0-4-1.2 0-2 .6-2.4 1.4M3 12h16c3.2 0 3.2 4.5 0 4.5-1.3 0-2.2-.7-2.5-1.6M3 16h8"/></svg></span>';
  const periodMetricIcons = {
    cloud: '<path d="M5.5 18a4.5 4.5 0 0 1-.6-9A6.2 6.2 0 0 1 16.7 8a5 5 0 1 1 .8 10H5.5Z"/>',
    rain: '<path d="M12 2.8C9.5 6.4 6.8 9.7 6.8 13.2a5.2 5.2 0 0 0 10.4 0C17.2 9.7 14.5 6.4 12 2.8Z"/>',
    showers: '<path d="M5 10.5a5 5 0 0 1 9.4-2.3A3.8 3.8 0 1 1 17 15H6a3.2 3.2 0 0 1-1-6.2"/><path d="m8 17-1.2 3M12 17l-1.2 3M16 17l-1.2 3"/>',
    wind: '<path d="M3 7.5h10.5c3.7 0 3.7-4.5.7-4.5-1.3 0-2.2.7-2.6 1.7M3 12h15c3.8 0 3.8 5 .5 5-1.5 0-2.4-.8-2.8-1.8M3 16.5h7"/>',
    gust: '<path d="M3 7h12c4 0 4-5 .7-5-1.5 0-2.5.8-2.9 2M3 12h17M3 17h10c4 0 4 5 .7 5-1.5 0-2.5-.8-2.9-2"/>',
    storm: '<path d="M13.5 2 6.8 13h5l-1.2 9L18 10.5h-5L13.5 2Z"/>'
  };
  const periodMetricPictogram = (kind, step, label, sources) => {
    const level = Math.max(0, Math.min(5, Math.round(Number(step) || 0)));
    const scale = Array.from({ length: 5 }, (_, index) => '<i class="' + (index < level ? "solid" : "") + '"></i>').join("");
    const sourceTooltip = sources.filter(Boolean).join("\n");
    const accessibleLabel = label + " · " + level + " sur 5 · " + sourceTooltip.replace(/\n/g, ", ");
    return '<span class="week-metric-pictogram ' + kind + ' chart-point" tabindex="0" role="img" aria-label="' + escapeText(accessibleLabel) + '" data-tooltip="' + escapeText(sourceTooltip) + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + periodMetricIcons[kind] + '</svg><span class="week-metric-scale" aria-hidden="true">' + scale + '</span></span>';
  };
  const periodCloudStep = value => cloudCoverBand(value);
  const periodWindStep = meanWindIntensityLevel;
  const periodGustStep = gustIntensityLevel;
  const periodMetricRow = (pictogram, valueMarkup, description, extraClass = "") => '<div class="week-metric-row' + (extraClass ? " " + extraClass : "") + '"><dt>' + pictogram + '</dt><dd>' + (valueMarkup ? '<span class="week-metric-number">(' + valueMarkup + ')</span>' : '') + '</dd>' + (description ? '<p class="week-metric-description">' + escapeText(description) + '</p>' : '') + '</div>';
  const slotDateKey = (dateKey, slot) => shiftForecastDateKey(dateKey, slot.dayOffset);
  const meteoFranceRainForPeriod = (dateKey, slot) => {
    const targetDateKey = slotDateKey(dateKey, slot);
    const periods = (latestForecastData?.pearome?.hours || []).filter(item => {
      const start = new Date(item.time).getTime();
      const duration = Math.max(1, Number(item.durationHours) || 1) * 3600000;
      if (!Number.isFinite(start) || !Number.isFinite(Number(item.ensembleMean))) return false;
      const midpoint = new Date(start + duration / 2);
      const hour = forecastHourValue(midpoint);
      return forecastDateKey(midpoint) === targetDateKey && hour >= slot.startHour && hour < slot.endHour;
    }).sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime());
    if (!periods.length) return null;
    const hourlyMeans = periods.flatMap(item => {
      const durationHours = Math.max(1, Math.round(Number(item.durationHours) || 1));
      const hourlyMean = Math.max(0, Number(item.ensembleMean) || 0) / durationHours;
      return Array.from({ length: durationHours }, () => hourlyMean);
    });
    const peak3h = hourlyMeans.reduce((peak, _, startIndex) => Math.max(
      peak,
      hourlyMeans.slice(startIndex, startIndex + 3).reduce((sum, amount) => sum + amount, 0)
    ), 0);
    return {
      amount: periods.reduce((sum, item) => sum + Math.max(0, Number(item.ensembleMean) || 0), 0),
      peak3h,
      probability: Math.max(...periods.map(item => Math.max(0, Number(item.probability) || 0))),
      intervals: periods.map(item => ({
        start: new Date(item.time).getTime(),
        end: new Date(item.time).getTime() + Math.max(1, Number(item.durationHours) || 1) * 3600000,
        amount: Math.max(0, Number(item.ensembleMean) || 0)
      })),
      backgroundTrend: backgroundTrendArrow(hourlyMeans, .2),
      source: "Météo-France (PEAROME)"
    };
  };
  const meteoFranceStormForPeriod = (dateKey, slot) => {
    const targetDateKey = slotDateKey(dateKey, slot);
    const detailedHours = (latestForecastData?.arome?.hours || []).filter(item => {
      const date = new Date(item.time);
      const hour = forecastHourValue(date);
      return forecastDateKey(date) === targetDateKey && hour >= slot.startHour && hour < slot.endHour;
    });
    // Dans les premières 48 h, le signal horaire AROME qui alimente la frise
    // est la référence. Ne jamais étendre son booléen quotidien aux créneaux
    // secs situés avant ou après le passage orageux.
    if (detailedHours.length) {
      const stormHours = detailedHours.filter(item => item.stormSignal).map(item => new Date(item.time).getTime()).filter(Number.isFinite);
      return {
        active: stormHours.length > 0,
        times: stormHours,
        backgroundTrend: backgroundTrendArrow(detailedHours.map(item => item.stormSignal ? 1 : 0), .34)
      };
    }
    const weekDay = (latestMeteoFranceWeek?.days || []).find(day => day.date === targetDateKey);
    return {
      active: Array.isArray(weekDay?.stormSignalPeriods) && weekDay.stormSignalPeriods.includes(slot.key),
      times: [],
      backgroundTrend: "→"
    };
  };
  const meteoFranceWindForPeriod = (dateKey, slot) => {
    const targetDateKey = slotDateKey(dateKey, slot);
    const hours = (latestForecastData?.arome?.hours || []).filter(item => {
      const date = new Date(item.time);
      const hour = forecastHourValue(date);
      return forecastDateKey(date) === targetDateKey && hour >= slot.startHour && hour < slot.endHour;
    }).sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime());
    const speeds = hours.filter(item => item.windSpeed != null).map(item => Number(item.windSpeed)).filter(Number.isFinite);
    const gusts = hours.filter(item => item.windGust != null).map(item => Number(item.windGust)).filter(Number.isFinite);
    const temperatures = hours.filter(item => item.temperature != null).map(item => Number(item.temperature)).filter(Number.isFinite);
    const clouds = hours.filter(item => item.cloudCover != null).map(item => Number(item.cloudCover)).filter(Number.isFinite);
    if (!speeds.length && !gusts.length && !temperatures.length && !clouds.length) return null;
    return {
      temperatureMin: temperatures.length ? Math.min(...temperatures) : null,
      temperatureMax: temperatures.length ? Math.max(...temperatures) : null,
      cloudCover: clouds.length ? clouds.reduce((sum, value) => sum + value, 0) / clouds.length : null,
      speed: speeds.length ? Math.max(...speeds) : null,
      gust: gusts.length ? Math.max(...gusts) : null,
      windBackgroundTrend: backgroundTrendArrow(speeds, 5),
      gustBackgroundTrend: backgroundTrendArrow(gusts, 8),
      stormWindTimes: hours.filter(item => item.stormSignal && (Number(item.windSpeed) >= 30 || Number(item.windGust) >= 50))
        .map(item => new Date(item.time).getTime()).filter(Number.isFinite),
      source: "Météo-France (AROME)"
    };
  };
  const confidenceIndicator = (openMeteo, meteoFrance) => {
    let score = null;
    let convergenceScore = null;
    let evolutionDisplayScore = null;
    let detail = "Indice indisponible : données comparables insuffisantes.";
    const activeDay = openMeteo.date === todayDateKey();
    const weightedScore = components => {
      const available = components.filter(component => Number.isFinite(component.score));
      const weight = available.reduce((sum, component) => sum + component.weight, 0);
      return weight ? available.reduce((sum, component) => sum + component.score * component.weight, 0) / weight : null;
    };
    if (meteoFrance) {
      const agreement = weekModelAgreement(openMeteo, meteoFrance);
      // Pour aujourd'hui, les agrégats portent sur la période restante et leur
      // fenêtre se raccourcit à chaque heure. Les comparer à l'historique ferait
      // passer cette contraction normale pour une révision de la prévision.
      const evolution = activeDay ? { level: "unknown", changeRate: null } : weekForecastEvolution().get(openMeteo.date) || { level: "unknown", changeRate: null };
      const modelAgreementScore = Number.isFinite(Number(agreement.score)) ? Number(agreement.score) : .5;
      const stabilityScore = agreement.stability === "stable" ? 1 : agreement.stability === "evolving" ? .68 : agreement.stability === "variable" ? .35 : null;
      const evolutionScore = evolution.level === "stable" ? 1 : evolution.level === "few" ? .75 : evolution.level === "frequent" ? .35 : null;
      convergenceScore = modelAgreementScore;
      evolutionDisplayScore = Number.isFinite(Number(evolution.changeRate)) ? Math.max(.2, 1 - Number(evolution.changeRate)) : evolutionScore;
      score = weightedScore([
        { score: modelAgreementScore, weight: .65 },
        { score: stabilityScore, weight: .2 },
        { score: evolutionScore, weight: .15 }
      ]);
      if (agreement.criticalDisagreement || agreement.rainDisagreement === "major" || modelAgreementScore < .38) score = Math.min(score, .35);
      else if (agreement.rainDisagreement === "meaningful" || agreement.level === "mixed" || evolution.level === "frequent") score = Math.min(score, .59);
      const ensembleLabel = agreement.stability === "stable" ? "plutôt stable" : agreement.stability === "evolving" ? "évolutif" : agreement.stability === "variable" ? "très variable" : "à confirmer";
      const evolutionLabel = activeDay ? "non évaluée sur une fenêtre glissante" : evolution.level === "frequent" ? "forte" : evolution.level === "few" ? "faible" : evolution.level === "stable" ? "nulle" : "sans recul";
      const rainDisagreementLabel = agreement.rainDisagreement === "major" ? "majeur" : agreement.rainDisagreement === "meaningful" ? "significatif" : agreement.rainDisagreement === "minor" ? "mineur" : "faible";
      detail = (activeDay ? "Période restante · " : "") + "concordance pondérée : " + Math.round(modelAgreementScore * 100) + "/100 · écart pluie : " + rainDisagreementLabel + " · stabilité : " + ensembleLabel + " · évolution : " + evolutionLabel;
    } else if (openMeteo.confidence) {
      const confidence = openMeteo.confidence;
      score = confidence.level === "strong" ? .9 : confidence.level === "medium" ? .65 : .35;
      const evolution = activeDay ? { level: "unknown", changeRate: null } : weekForecastEvolution().get(openMeteo.date) || { level: "unknown", changeRate: null };
      evolutionDisplayScore = Number.isFinite(Number(evolution.changeRate)) ? Math.max(.2, 1 - Number(evolution.changeRate)) : null;
      const spreads = [
        Number.isFinite(Number(confidence.temperatureSpread)) ? "température " + format(confidence.temperatureSpread) + " °C" : "",
        Number.isFinite(Number(confidence.windSpread)) ? "vent " + format(confidence.windSpread) + " km/h" : "",
        Number.isFinite(Number(confidence.precipitationSpread)) ? "précipitations " + format(confidence.precipitationSpread) + " mm" : ""
      ].filter(Boolean);
      detail = (activeDay ? "Période restante · " : "") + "variabilité de l’ensemble Open-Meteo : " + (spreads.join(", ") || "à confirmer");
    }
    const toneForScore = value => !Number.isFinite(value) ? "unknown" : value >= .8 ? "green" : value >= .6 ? "yellow" : value >= .4 ? "orange" : "red";
    const graphicRow = (rowLabel, rowScore) => {
      if (!Number.isFinite(rowScore)) return '<span class="daily-confidence-row unknown"><span>' + rowLabel + '</span><em>indisponible</em></span>';
      const points = Math.max(1, Math.min(5, Math.round(rowScore * 5)));
      const dots = Array.from({ length: 5 }, (_, index) => '<i class="' + (index < points ? "filled" : "") + '"></i>').join("");
      return '<span class="daily-confidence-row ' + toneForScore(rowScore) + '"><span>' + rowLabel + '</span><b aria-hidden="true">' + dots + '</b></span>';
    };
    const tone = toneForScore(score);
    const label = tone === "green" ? "forte" : tone === "yellow" ? "bonne" : tone === "orange" ? "limitée" : tone === "red" ? "faible" : "indisponible";
    return '<span class="daily-confidence-indicator ' + tone + '" tabindex="0" role="img" aria-label="Confiance générale ' + label + '. ' + escapeText(detail) + '"><i class="daily-confidence-dot" aria-hidden="true"></i><span class="daily-confidence-popover" role="tooltip">' + graphicRow("Convergence des modèles", convergenceScore) + graphicRow("Évolution des prévisions", evolutionDisplayScore) + graphicRow("Confiance", score) + '</span></span>';
  };
  const periodCard = (period, label, labelTitle, slot, dateKey, periodKey, meteoFranceStorm = false, vigilanceAlerts = [], meteoFranceRain = null, meteoFranceWind = null, hasMeteoFranceDay = false) => {
    if (!period) return "";
    const slotEndTime = new Date(slotDateKey(dateKey, slot) + "T00:00:00").getTime() + slot.endHour * 3600000;
    const pastClass = Number.isFinite(slotEndTime) && slotEndTime <= appNow() ? " daily-period-past" : "";
    const openMeteoRain = Math.max(0, Number(period.precipitationSum) || 0);
    const meteoFranceRainAmount = meteoFranceRain?.amount != null && Number.isFinite(Number(meteoFranceRain.amount)) ? Math.max(0, Number(meteoFranceRain.amount)) : null;
    const rain = weekWeightedValue(openMeteoRain, meteoFranceRainAmount);
    const rainDisagreement = meteoFranceRainAmount != null && Math.abs(openMeteoRain - meteoFranceRainAmount) >= .05;
    const rainAmountText = value => value > 0 && value < .1 ? "< 0,1" : format(value);
    const rainRangeText = rainAmountText(rain);
    const rainProbability = weekWeightedValue(period.precipitationProbabilityMax, meteoFranceRain?.probability);
    const probabilitySummary = rainProbabilitySummary([rainProbability]);
    const cloud = Math.max(0, Math.min(100, weekWeightedValue(period.cloudCover, meteoFranceWind?.cloudCover) ?? 0));
    const temperatureMax = weekWeightedValue(period.temperatureMax, meteoFranceWind?.temperatureMax);
    const temperatureMin = weekWeightedValue(period.temperatureMin, meteoFranceWind?.temperatureMin);
    const hasOpenMeteoStorm = Boolean(period.storm) || Number(period.weatherCode) >= 95;
    const hasMeteoFranceStorm = meteoFranceStorm && typeof meteoFranceStorm === "object"
      ? Boolean(meteoFranceStorm.active)
      : Boolean(meteoFranceStorm);
    const meteoFranceStormTimes = Array.isArray(meteoFranceStorm?.times) ? meteoFranceStorm.times : [];
    const hasStorm = hasOpenMeteoStorm || hasMeteoFranceStorm;
    const hideRain = weekRainBelowDisplayThreshold([rainProbability], hasStorm);
    const icon = displayIcon({
      time: period.time,
      cloudCover: cloud,
      rain: hasStorm ? Math.max(.5, rain) : hideRain ? 0 : rain,
      rainLevel: hideRain ? 0 : rainPictogramStep(rain),
      forceDay: label === "Soir"
    });
    const temperature = '<span class="daily-period-temperatures"><span><small>Max.</small><strong>' + format(temperatureMax, 0) + '°</strong></span><span><small>Min.</small><b>' + format(temperatureMin, 0) + '°</b></span></span>';
    const direction = Number.isFinite(Number(period.windDirection))
      ? '<span class="daily-period-wind-arrow" style="transform:rotate(' + Number(period.windDirection) + 'deg)" aria-hidden="true">↑</span>' : "";
    const openMeteoWind = Math.max(0, Number(period.windSpeedMax) || 0);
    const meteoFranceWindValue = meteoFranceWind?.speed != null && Number.isFinite(Number(meteoFranceWind.speed)) ? Math.max(0, Number(meteoFranceWind.speed)) : null;
    const wind = weekWeightedValue(openMeteoWind, meteoFranceWindValue);
    const windRangeText = format(wind, 0);
    const openMeteoGust = Math.max(0, Number(period.windGustMax) || 0);
    const meteoFranceGustValue = meteoFranceWind?.gust != null && Number.isFinite(Number(meteoFranceWind.gust)) ? Math.max(0, Number(meteoFranceWind.gust)) : null;
    const gust = weekWeightedValue(openMeteoGust, meteoFranceGustValue);
    const gustRangeText = format(gust, 0);
    const openMeteoTrends = period.backgroundTrends || {};
    const rainSources = [
      "Open-Meteo : " + rainAmountText(openMeteoRain) + " mm · " + format(period.precipitationProbabilityMax, 0) + " % " + (openMeteoTrends.rain || "→"),
      meteoFranceRainAmount != null ? "Météo-France : " + rainAmountText(meteoFranceRainAmount) + " mm · " + format(meteoFranceRain.probability, 0) + " % " + (meteoFranceRain.backgroundTrend || "→") : ""
    ];
    const windSources = [
      "Open-Meteo : " + format(openMeteoWind, 0) + " km/h " + (openMeteoTrends.wind || "→"),
      meteoFranceWindValue != null ? "Météo-France : " + format(meteoFranceWindValue, 0) + " km/h " + (meteoFranceWind.windBackgroundTrend || "→") : ""
    ];
    const gustSources = [
      "Open-Meteo : " + format(openMeteoGust, 0) + " km/h " + (openMeteoTrends.gust || "→"),
      meteoFranceGustValue != null ? "Météo-France : " + format(meteoFranceGustValue, 0) + " km/h " + (meteoFranceWind.gustBackgroundTrend || "→") : ""
    ];
    const stormSources = [
      "Open-Meteo : " + (hasOpenMeteoStorm ? "orage possible" : "pas d’orage") + " " + (openMeteoTrends.storm || "→"),
      hasMeteoFranceDay ? "Météo-France : " + (hasMeteoFranceStorm ? "orage possible" : "pas d’orage") + " " + (meteoFranceStorm?.backgroundTrend || "→") : ""
    ];
    const hazard = [
      hasStorm
        ? hazardPictogram("storm", stormSources.filter(Boolean).join("\n")) : "",
      gustIntensityLevel(gust) >= 3
        ? hazardPictogram("wind", gustSources.filter(Boolean).join("\n")) : ""
    ].join("");
    const rainStep = rainPictogramStep(rain);
    const windStep = periodWindStep(wind);
    const gustStep = periodGustStep(gust);
    const stormRisk = weekStormRisk(period.time.slice(0, 10));
    const stormStep = hasStorm ? Math.max(3, stormRisk.level) : 0;
    const activeStormSources = [
      hasOpenMeteoStorm ? "Open-Meteo" : "",
      hasMeteoFranceStorm ? "Météo-France" : ""
    ].filter(Boolean);
    const stormSourceLabel = activeStormSources.length > 1 ? activeStormSources.slice(0, -1).join(", ") + " et " + activeStormSources.at(-1) : activeStormSources[0] + " seulement";
    const rainVolume = !hideRain && rain >= .1
      ? '<span class="daily-period-rain-volume" role="img" aria-label="Cumul de pluie ' + escapeText(rainAmountText(rain) + " millimètres") + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8C9.5 6.4 6.8 9.7 6.8 13.2a5.2 5.2 0 0 0 10.4 0C17.2 9.7 14.5 6.4 12 2.8Z"/></svg><strong>' + escapeText(rainRangeText) + ' mm</strong></span>'
      : "";
    // Le rappel chiffré du créneau garde son seuil historique de 50 km/h :
    // il informe sur la valeur sans dépendre du niveau qualitatif recalibré.
    const gustVolume = gust >= 50
      ? '<span class="daily-period-gust-volume" role="img" aria-label="Rafales ' + escapeText(format(gust, 0) + " kilomètres par heure") + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + periodMetricIcons.gust + '</svg><strong>' + escapeText(gustRangeText) + ' km/h</strong></span>'
      : "";
    const notable = weatherDescription({ ...period, precipitationSum: hideRain ? 0 : rain, precipitationProbabilityMax: hideRain ? 0 : rainProbability, storm: hasStorm });
    const notableMarkup = notable ? '<span class="daily-period-copy">' + escapeText(notable) + '</span>' : "";
    const showers = (Number(period.weatherCode) >= 80 && Number(period.weatherCode) <= 82) || hasStorm;
    const skyDescription = conciseSkySummary(cloud);
    const quantityBand = value => value < 1 ? "très faible" : value < 5 ? "faible" : value < 15 ? "modérée" : value < 30 ? "forte" : "très forte";
    const quantitySummary = "en quantité " + quantityBand(rain);
    const periodNoun = slot.key === "morning" ? "matinée" : slot.key === "afternoon" ? "après-midi" : slot.key === "evening" ? "soirée" : "nuit";
    const timingSummary = period.rainTiming === "start" ? "en début de " + periodNoun
      : period.rainTiming === "middle" ? "au milieu de " + periodNoun
      : period.rainTiming === "end" ? "en fin de " + periodNoun : "";
    const pluralRain = showers && !hasStorm;
    const likelihood = (pluralRain ? {
      "Prévue": "",
      "Très probable": " très probables",
      "Probable": " probables",
      "Possible": " possibles",
      "Envisagée": " envisagées",
      "Peu probable": " peu probables",
      "Très peu probable": " très peu probables",
      "Incertain": " incertaines",
      "À confirmer": " à confirmer"
    } : {
      "Prévue": "",
      "Très probable": " très probable",
      "Probable": " probable",
      "Possible": " possible",
      "Envisagée": " envisagée",
      "Peu probable": " peu probable",
      "Très peu probable": " très peu probable",
      "Incertain": " incertaine",
      "À confirmer": " à confirmer"
    })[probabilitySummary.text] ?? "";
    const rainSubject = hasStorm ? "Pluie orageuse" : pluralRain ? "Averses" : "Pluie";
    const disagreementSummary = rainSubject + likelihood + (timingSummary ? " " + timingSummary + "," : "") + " " + quantitySummary + ".";
    // La synthèse reste qualitative. Les valeurs exactes restent dans le
    // pictogramme et son détail accessible.
    const rainDescription = hideRain ? "" : rainDisagreement
      ? disagreementSummary
      : conciseRainSummary(rain, [], [], showers, hasStorm, probabilitySummary) || "Pas de pluie.";
    const windDescription = conciseWindSummary([wind], [gust], [], [], [period.windDirection]);
    const cloudDetail = periodMetricRow(periodMetricPictogram("cloud", periodCloudStep(cloud), "Nébulosité " + format(cloud, 0) + " %", ["Open-Meteo : " + format(period.cloudCover, 0) + " % " + (openMeteoTrends.cloud || "→"), meteoFranceWind?.cloudCover != null ? "Météo-France : " + format(meteoFranceWind.cloudCover, 0) + " %" : ""]), format(cloud, 0) + " %", skyDescription);
    const rainKind = showers ? "showers" : "rain";
    const showerPlus = showers ? '<span class="week-shower-plus" aria-hidden="true">+</span>' : "";
    const rainPictogram = '<span class="week-rain-pictogram">' + periodMetricPictogram(rainKind, rainStep, "Pluie " + rainRangeText + " mm · probabilité " + format(rainProbability, 0) + " %", rainSources) + showerPlus + '</span>';
    const rainDetail = periodMetricRow(rainPictogram, escapeText(rainRangeText) + " mm", rainDescription, "week-rain-row");
    const windDetail = '<div class="week-wind-group"><div class="week-grouped-metric-line"><dt>' + periodMetricPictogram("wind", windStep, "Vent " + windRangeText + " km/h", windSources) + '</dt><dd><span class="week-metric-number">(' + direction + escapeText(windRangeText) + ' km/h)</span></dd></div><div class="week-grouped-metric-line"><dt>' + periodMetricPictogram("gust", gustStep, "Rafales " + gustRangeText + " km/h", gustSources) + '</dt><dd><span class="week-metric-number">(' + escapeText(gustRangeText) + ' km/h)</span></dd></div><p class="week-metric-description">' + escapeText(windDescription) + '</p></div>';
    const stormDescription = hasStorm
      ? Number(period.weatherCode) >= 96 ? "Phénomène orageux violent possible selon " + stormSourceLabel + "." : "Orage possible selon " + stormSourceLabel + "."
      : "Pas d’orage.";
    const stormDetail = periodMetricRow(periodMetricPictogram("storm", stormStep, hasStorm ? Number(period.weatherCode) >= 96 ? "Phénomène violent possible" : "Orage possible" : "Pas d’orage", stormSources), "", stormDescription, "daily-period-storm-detail");
    const hazardMarkup = hazard ? '<span class="daily-period-hazards">' + hazard + '</span>' : "";
    // Chaque modèle conserve son propre scénario pluie/probabilité. Cela
    // évite de fabriquer un niveau avec la probabilité de l'un et le cumul de
    // l'autre. L'orage ne relève le niveau que s'il chevauche soit une pluie
    // forte, soit un épisode à la fois pluvieux et venteux.
    const meteoFranceStormRainOverlap = meteoFranceStormTimes.some(stormTime =>
      (meteoFranceRain?.intervals || []).some(interval => interval.amount >= 5 && stormTime >= interval.start && stormTime < interval.end)
    );
    const meteoFranceStormRainWindOverlap = (meteoFranceWind?.stormWindTimes || []).some(stormTime =>
      (meteoFranceRain?.intervals || []).some(interval => interval.amount >= 1 && stormTime >= interval.start && stormTime < interval.end)
    );
    const alertTone = forecastSlotAlertTone([
      {
        wind,
        gust,
        probability: rainProbability,
        rain,
        rain3h: weekWeightedValue(period.peakRain3h, meteoFranceRain?.peak3h),
        stormRainOverlap: (hasOpenMeteoStorm && Boolean(period.stormRainOverlap))
          || (hasMeteoFranceStorm && meteoFranceStormRainOverlap),
        stormRainWindOverlap: (hasOpenMeteoStorm && Boolean(period.stormRainWindOverlap))
          || (hasMeteoFranceStorm && meteoFranceStormRainWindOverlap)
      }
    ]);
    const alertClass = alertTone ? " daily-period-alert-" + alertTone : "";
    const titleAttribute = labelTitle ? ' title="' + escapeText(labelTitle) + '"' : "";
    return '<details class="daily-period-card' + alertClass + pastClass + '" data-period-key="' + escapeText(periodKey) + '"><summary><span class="daily-period-title"' + titleAttribute + '><strong>' + label + '</strong>' + vigilanceSlotIcons(vigilanceAlerts) + '</span><span class="daily-period-icon weather-icon chart-point" tabindex="0" data-tooltip="' + escapeText("Précipitations\n" + rainSources.filter(Boolean).join("\n")) + '">' + icon + hazardMarkup + '</span><span class="daily-period-values">' + temperature + rainVolume + gustVolume + '</span>' + notableMarkup + '<span class="daily-period-chevron" aria-hidden="true">⌄</span></summary><div class="daily-period-details"><dl>' + cloudDetail + rainDetail + windDetail + stormDetail + '</dl></div></details>';
  };
  const openMeteoDays = (latestWeekForecast?.days || []).filter(day => day.date >= todayDateKey()).slice(0, 7).map(day => futureActiveWeekDay(day));
  const meteoFranceByDate = new Map((latestMeteoFranceWeek?.days || []).map(day => futureActiveWeekDay(day)).map(day => [day.date, day]));
  const cards = openMeteoDays.map(openMeteo => {
    const meteoFranceDay = meteoFranceByDate.get(openMeteo.date) || null;
    const vigilance = latestForecastData?.vigilance || null;
    const slotPresentation = slot => {
      if (slot.key !== "night") return { label: slot.label, title: "" };
      const startDate = dateFromKey(openMeteo.date);
      const endDate = dateFromKey(slotDateKey(openMeteo.date, slot));
      return {
        label: "Nuit",
        title: "Nuit du " + nightPeriodDateFormat.format(startDate) + " au " + nightPeriodDateFormat.format(endDate) + " matin"
      };
    };
    const periods = forecastDailySlots.map(slot => {
      const presentation = slotPresentation(slot);
      return periodCard(
        openMeteo.periods?.[slot.key] || null,
        presentation.label,
        presentation.title,
        slot,
        openMeteo.date,
        openMeteo.date + ":" + slot.key,
        meteoFranceStormForPeriod(openMeteo.date, slot),
        vigilanceAlertsForSlot(vigilance, slotDateKey(openMeteo.date, slot), slot.startHour, slot.endHour),
        meteoFranceRainForPeriod(openMeteo.date, slot),
        meteoFranceWindForPeriod(openMeteo.date, slot),
        meteoFranceByDate.has(slotDateKey(openMeteo.date, slot))
      );
    }).filter(Boolean);
    const dayLabel = relativeDayLabel(openMeteo);
    const shortDate = shortDateFormat.format(dateFromKey(openMeteo.date));
    const dayGap = Math.round((dateFromKey(openMeteo.date).getTime() - dateFromKey(todayDateKey()).getTime()) / dayMilliseconds);
    const canOpen48h = dayGap >= 0 && dayGap <= 1;
    const dayHeading = canOpen48h
      ? '<button class="daily-day-open" type="button" data-open-48h-date="' + escapeText(openMeteo.date) + '" data-open-48h-label="' + escapeText(dayLabel) + '" aria-controls="panel-48h" aria-expanded="' + String(!$("panel-48h").hidden && $("panel-48h").dataset.focusDate === openMeteo.date) + '" title="Ouvrir la frise 48 h sur ' + escapeText(dayLabel.toLowerCase()) + '"><span class="daily-day-heading"><strong>' + escapeText(dayLabel) + '</strong><time datetime="' + escapeText(openMeteo.date) + '">' + escapeText(shortDate) + '</time></span>' + graphIconMarkup("daily-day-open-icon") + '</button>'
      : '<div class="daily-day-heading"><strong>' + escapeText(dayLabel) + '</strong><time datetime="' + escapeText(openMeteo.date) + '">' + escapeText(shortDate) + '</time></div>';
    return '<article class="daily-forecast-card"><header>' + dayHeading + confidenceIndicator(openMeteo, meteoFranceDay) + '</header><div class="daily-period-grid">' + periods.join("") + '</div></article>';
  }).join("");
  target.innerHTML = cards ? '<section class="daily-cards-view" aria-label="Prévisions quotidiennes sur 7 jours"><div class="daily-cards-grid">' + cards + '</div></section>' : '<div class="week-source-message">' + escapeText(weekForecastErrors.openmeteo || "Chargement des prévisions quotidiennes…") + '</div>';
  const periodDetails = [...target.querySelectorAll(".daily-period-card")];
  periodDetails.forEach(detail => { detail.open = openPeriodKeys.has(detail.dataset.periodKey); });
  periodDetails.forEach(detail => detail.addEventListener("toggle", () => {
    if (!detail.open) return;
    periodDetails.forEach(other => {
      if (other !== detail && other.open) other.open = false;
    });
  }));
  target.querySelectorAll("[data-open-48h-date]").forEach(button => button.addEventListener("click", () => toggleDaily48HourForecast(button)));
  bindChartTooltips();
  renderWeekApiLinks();
}

function renderWeekForecast() {
  renderTestingDailyForecast();
  return;
  const number = value => value != null && Number.isFinite(Number(value)) ? Number(value).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) : "—";
  const metricIcons = {
    rain: '<path d="M12 2.8C9.5 6.4 6.8 9.7 6.8 13.2a5.2 5.2 0 0 0 10.4 0C17.2 9.7 14.5 6.4 12 2.8Z"/>',
    showers: '<path d="M5 10.5a5 5 0 0 1 9.4-2.3A3.8 3.8 0 1 1 17 15H6a3.2 3.2 0 0 1-1-6.2"/><path d="m8 17-1.2 3M12 17l-1.2 3M16 17l-1.2 3"/>',
    cloud: '<path d="M5.5 18a4.5 4.5 0 0 1-.6-9A6.2 6.2 0 0 1 16.7 8a5 5 0 1 1 .8 10H5.5Z"/>',
    wind: '<path d="M3 7.5h10.5c3.7 0 3.7-4.5.7-4.5-1.3 0-2.2.7-2.6 1.7M3 12h15c3.8 0 3.8 5 .5 5-1.5 0-2.4-.8-2.8-1.8M3 16.5h7"/>',
    gust: '<path d="M3 7h12c4 0 4-5 .7-5-1.5 0-2.5.8-2.9 2M3 12h17M3 17h10c4 0 4 5 .7 5-1.5 0-2.5-.8-2.9-2"/>',
    storm: '<path d="M13.5 2 6.8 13h5l-1.2 9L18 10.5h-5L13.5 2Z"/>',
    hail: '<path d="M5 13.5a4 4 0 0 1 .2-8A6 6 0 0 1 17 6.5a3.5 3.5 0 1 1 .5 7H5Z"/><text class="hail-letter" x="12" y="11.4" text-anchor="middle">G</text><circle class="hailstone" cx="7.5" cy="18" r="1.6"/><circle class="hailstone" cx="12.5" cy="20" r="1.6"/><circle class="hailstone" cx="17.5" cy="18" r="1.6"/>',
  };
  const metricPictogram = (kind, lowStep, highStep, label) => {
    const low = Math.max(0, Math.min(5, Math.round(Number(lowStep) || 0)));
    const high = Math.max(low, Math.min(5, Math.round(Number(highStep) || 0)));
    const scale = Array.from({ length: 5 }, (_, index) => '<i class="' + (index < low ? "solid" : index < high ? "range" : "") + '"></i>').join("");
    return '<span class="week-metric-pictogram ' + kind + '" role="img" aria-label="' + escapeText(label) + '" title="' + escapeText(label) + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + metricIcons[kind] + '</svg><span class="week-metric-scale" aria-hidden="true">' + scale + '</span></span>';
  };
  const metricSteps = (values, classifier) => {
    const valid = values.filter(value => value != null && value !== "").map(Number).filter(Number.isFinite).map(classifier).sort((left, right) => left - right);
    return valid.length ? [valid[0], valid.at(-1)] : [0, 0];
  };
  const dailyRainIconAmount = value => value >= 50 ? 10 : value >= 25 ? 4 : value >= 10 ? 1 : value >= 1 ? .5 : value > 0 ? .1 : 0;
  const cloudStep = value => cloudCoverBand(value);
  const windStep = meanWindIntensityLevel;
  const gustStep = gustIntensityLevel;
  const metricRow = (kind, label, values, classifier, valueMarkup = "", description = "") => {
    const [low, high] = metricSteps(values, classifier);
    const descriptionMarkup = description ? '<p class="week-metric-description">' + escapeText(description) + '</p>' : '';
    return '<div class="week-metric-row"><dt>' + metricPictogram(kind, low, high, label) + '</dt><dd>' + (valueMarkup ? '<span class="week-metric-number">(' + valueMarkup + ')</span>' : '') + '</dd>' + descriptionMarkup + '</div>';
  };
  const cloudMetricRow = (presentation, hoverLabel, description = "") => {
    const evolving = Number.isFinite(presentation.morning) && Number.isFinite(presentation.afternoon);
    const mean = Number.isFinite(presentation.mean) ? presentation.mean : 0;
    const levels = evolving
      ? [cloudStep(presentation.morning), cloudStep(presentation.afternoon)].sort((left, right) => left - right)
      : [cloudStep(mean), cloudStep(mean)];
    const pictogram = metricPictogram("cloud", levels[0], levels[1], hoverLabel);
    const value = evolving
      ? escapeText(number(presentation.morning) + ' % · ' + number(presentation.afternoon) + ' %')
      : escapeText(number(mean) + ' %');
    const descriptionMarkup = description ? '<p class="week-metric-description">' + escapeText(description) + '</p>' : '';
    return '<div class="week-metric-row"><dt>' + pictogram + '</dt><dd><span class="week-metric-number">(' + value + ')</span></dd>' + descriptionMarkup + '</div>';
  };
  const rainMetricRow = (amountValues, amountMarkup, probabilityValues, showersLevel = 0, probabilitySummary = null, description = "") => {
    const [low, high] = metricSteps(amountValues, rainPictogramStep);
    const probability = probabilitySummary || rainProbabilitySummary(probabilityValues);
    const showers = showersLevel > 0;
    const label = "Pluie" + (probability.text === "Prévue" ? "" : " " + probability.text.toLowerCase()) + " (" + probability.detail + ")" + (showers ? ", averses " + (showersLevel >= 5 ? "prévues" : "probables") : "");
    const showerPlus = showers ? '<span class="week-shower-plus" aria-hidden="true">+</span>' : '';
    const descriptionMarkup = description ? '<p class="week-metric-description">' + escapeText(description) + '</p>' : '';
    return '<div class="week-metric-row week-rain-row"><dt><span class="week-rain-pictogram">' + metricPictogram("showers", low, high, label) + showerPlus + '</span></dt><dd><span class="week-metric-number">(' + amountMarkup + ')</span></dd>' + descriptionMarkup + '</div>';
  };
  const windMetricGroup = (windValues, windMarkup, gustValues, gustMarkup, description = "", windLabel = "Vent maximal", gustLabel = "Rafales") => {
    const [windLow, windHigh] = metricSteps(windValues, windStep);
    const [gustLow, gustHigh] = metricSteps(gustValues, gustStep);
    const descriptionMarkup = description ? '<p class="week-metric-description">' + escapeText(description) + '</p>' : '';
    return '<div class="week-wind-group"><div class="week-grouped-metric-line"><dt>' + metricPictogram("wind", windLow, windHigh, windLabel) + '</dt><dd><span class="week-metric-number">(' + windMarkup + ')</span></dd></div><div class="week-grouped-metric-line"><dt>' + metricPictogram("gust", gustLow, gustHigh, gustLabel) + '</dt><dd><span class="week-metric-number">(' + gustMarkup + ')</span></dd></div>' + descriptionMarkup + '</div>';
  };
  const modelDaySummaries = (day, probabilitySummary = null) => {
    const rain = Math.max(0, Number(day.precipitationSum) || 0);
    const probability = Math.max(0, Number(day.precipitationProbabilityMax) || 0);
    const showers = Math.max(0, Number(day.showersSum) || 0);
    const code = Number(day.weatherCode);
    const cloud = Math.max(0, Number(day.cloudCover) || 0);
    const wind = Math.max(0, Number(day.windSpeedMax) || 0);
    const gust = Math.max(0, Number(day.windGustMax) || 0);
    const skySummary = conciseSkySummary(day);
    const rainSummary = weekRainBelowDisplayThreshold([day.precipitationProbabilityMax], code >= 95) ? "" : conciseRainSummary(rain, [], day.rainPeriods, showers >= .1 || code >= 80 && code <= 82, code >= 95, probabilitySummary || rainProbabilitySummary([probability])) || "Pas de pluie.";
    const windSummary = conciseWindSummary([wind], [gust], day.gustPeriod ? [day.gustPeriod] : [], day.windPeriod ? [day.windPeriod] : [], [day.windDirection]);
    return { sky: skySummary, rain: rainSummary, wind: windSummary };
  };
  const controls = (date, hasMeteoFrance, selected) => '<div class="week-day-source-selector" aria-label="Prévision affichée pour ' + escapeText(date) + '"><button type="button" data-week-date="' + escapeText(date) + '" data-week-source="meteofrance" aria-pressed="' + (selected === "meteofrance") + '"' + (hasMeteoFrance ? '' : ' disabled title="Prévision Météo-France limitée à 4 jours"') + '>Météo-France</button><button type="button" data-week-date="' + escapeText(date) + '" data-week-source="openmeteo" aria-pressed="' + (selected === "openmeteo") + '">Open-Meteo</button><button type="button" data-week-date="' + escapeText(date) + '" data-week-source="synthesis" aria-pressed="' + (selected === "synthesis") + '"' + (hasMeteoFrance ? '' : ' disabled title="Synthèse proposée sur les 4 premiers jours"') + '>Synthèse</button></div>';
  const weekDayHeading = (date, dateKey, days = [], dateBadgeMarkup = "") => {
    if (dateKey !== todayDateKey()) {
      return '<div class="week-day-head"><strong>' + escapeText(weekDayFormat.format(date)) + '</strong><span class="week-day-date-stack"><time datetime="' + escapeText(dateKey) + '">' + escapeText(shortDateFormat.format(date)) + '</time>' + dateBadgeMarkup + '</span></div>';
    }
    if (new Date(appNow()).getHours() < 12) {
      return '<div class="week-day-head week-day-head-active"><span class="week-day-date-stack"><strong>Aujourd’hui</strong>' + dateBadgeMarkup + '</span></div>';
    }
    const starts = days.map(day => day?.forecastStart).filter(Boolean).sort();
    const start = starts.at(-1) || weekForecastStartKey();
    const hour = start.slice(11, 16).replace(":", "h").replace(/h00$/, "h");
    return '<div class="week-day-head week-day-head-active"><strong>Aujourd’hui,</strong><span class="week-day-date-stack"><time class="week-active-start" datetime="' + escapeText(start) + '">à partir de ' + escapeText(hour) + '</time>' + dateBadgeMarkup + '</span></div>';
  };
  const dailyCloudRangeText = day => {
    const range = cloudCoverDailyRange(day);
    const activeDay = day?.date === todayDateKey();
    if (!range) return number(day?.cloudCoverMean ?? day?.cloudCover) + (activeDay ? " % intégrés sur la période restante" : " % intégrés sur la durée du jour");
    return number(range.min) + (Math.abs(range.max - range.min) >= .05 ? " à " + number(range.max) : "") + (activeDay ? " % intégrés sur la période restante" : " % intégrés du matin à l’après-midi");
  };
  const renderDay = (day, sourceKey, sourceControls) => {
    const date = new Date(day.time);
    const activeDay = day.date === todayDateKey();
    const code = Number(day.weatherCode);
    const stormActive = sourceKey === "openmeteo" ? code >= 95 : meteoFranceStormForDate(day.date);
    const rainCode = code >= 51 && code <= 67 || code >= 80 && code <= 82 || code >= 95;
    const dailyRain = Math.max(0, Number(day.precipitationSum) || 0);
    const rainProbability = Math.max(0, Number(day.precipitationProbabilityMax) || 0);
    const meteoFranceRainSignal = dailyRain > 0 || rainProbability >= 45;
    const displayRain = sourceKey === "meteofrance" ? meteoFranceRainSignal : rainCode;
    // A daily total is not an hourly intensity. Keep totals below 1 mm on the
    // light-precipitation pictogram instead of depicting sustained rain.
    const iconRain = stormActive ? Math.max(.5, dailyRainIconAmount(dailyRain)) : displayRain ? dailyRainIconAmount(dailyRain) : 0;
    const reportedCloud = Number(day.cloudCoverMean ?? day.cloudCover);
    const iconCloud = Number.isFinite(reportedCloud)
      ? Math.max(0, Math.min(100, reportedCloud))
      : code === 0 ? 0 : code === 1 ? 20 : code === 2 ? 55 : code === 3 || code === 45 || code === 48 || code >= 51 && code <= 77 ? 90 : code >= 80 ? 60 : 50;
    const hideRain = weekRainBelowDisplayThreshold([day.precipitationProbabilityMax], stormActive);
    const icon = displayIcon({ time: day.time, cloudCover: iconCloud, rain: hideRain ? 0 : iconRain, rainLevel: hideRain ? 0 : rainPictogramStep(dailyRain) });
    const openMeteoShowerSignal = sourceKey === "openmeteo" && ((Number(day.showersSum) || 0) >= .1 || code >= 80 && code <= 82);
    const precipitationTotal = dailyRain > 0 && dailyRain < .1 ? "< 0,1 mm" : dailyRain === 0 && openMeteoShowerSignal ? "type averse" : number(dailyRain) + " mm";
    const windDirection = Number.isFinite(Number(day.windDirection)) ? '<span class="week-wind-arrow" style="transform:rotate(' + Number(day.windDirection) + 'deg)">↑</span>' : '';
    const ensembleStatus = sourceKey === "meteofrance" ? latestMeteoFranceWeek?.ensembleStatus?.status : "ready";
    const showersTotal = Number(day.showersSum);
    const showersLabel = Number.isFinite(showersTotal) && showersTotal >= .1 ? "oui" : code >= 80 ? "probable" : "non";
    const showersLevel = showersLabel === "oui" ? 5 : showersLabel === "probable" ? 3 : 0;
    const confidence = day.confidence;
    const confidenceDetails = confidence ? [
      confidence.temperatureSpread != null && Number.isFinite(Number(confidence.temperatureSpread)) ? 'température ' + number(confidence.temperatureSpread) + ' °C' : '',
      confidence.windSpread != null && Number.isFinite(Number(confidence.windSpread)) ? 'vent ' + number(confidence.windSpread) + ' km/h' : '',
      confidence.precipitationSpread != null && Number.isFinite(Number(confidence.precipitationSpread)) ? 'précipitations ' + number(confidence.precipitationSpread) + ' mm' : ''
    ].filter(Boolean) : [];
    const confidenceTitle = confidence ? 'Variabilité de l’ensemble : ' + confidenceDetails.join(', ')
      : sourceKey === "meteofrance" ? ensembleStatus === "error" ? 'Acquisition PE-ARPEGE en erreur' : 'Données PE-ARPEGE en acquisition'
      : 'Variabilité de l’ensemble à confirmer';
    const confidenceMissingLabel = sourceKey === "meteofrance"
      ? ensembleStatus === "error" ? "acquisition en erreur" : "données en acquisition"
      : "à confirmer";
    const confidenceMarkup = confidence ? '<div class="week-confidence ' + confidence.level + '" title="' + escapeText(confidenceTitle) + '"><span>Confiance</span><strong>' + confidence.label + '</strong></div>' : '<div class="week-confidence unavailable"><span>Confiance</span><strong>' + confidenceMissingLabel + '</strong></div>';
    const probabilitySummary = rainProbabilitySummary([day.precipitationProbabilityMax]);
    const summaries = modelDaySummaries(day, probabilitySummary);
    const sourceLabel = sourceKey === "meteofrance" ? "Météo-France" : "Open-Meteo";
    const cloudPresentation = cloudCoverPresentation(day);
    const rainMarkup = rainMetricRow([dailyRain], escapeText(precipitationTotal), [], sourceKey === "openmeteo" ? showersLevel : 0, probabilitySummary, summaries.rain);
    const cloudPeriods = [
      day.cloudCoverMorningMean != null && Number.isFinite(Number(day.cloudCoverMorningMean)) ? "matin " + number(day.cloudCoverMorningMean) + " %" : "",
      day.cloudCoverAfternoonMean != null && Number.isFinite(Number(day.cloudCoverAfternoonMean)) ? "après-midi " + number(day.cloudCoverAfternoonMean) + " %" : ""
    ].filter(Boolean);
    const cloudHoverLabel = "Nébulosité · " + sourceLabel + " · " + dailyCloudRangeText(day) + (cloudPeriods.length ? " · " + cloudPeriods.join(" · ") : "");
    const windDirectionLabel = Number.isFinite(Number(day.windDirection)) ? " · direction " + Math.round(Number(day.windDirection)) + "°" : "";
    const gustTiming = day.gustPeriod ? " · maximum " + forecastPeriodText([day.gustPeriod]) : "";
    const windTiming = day.windPeriod ? " · maximum " + forecastPeriodText([day.windPeriod]) : "";
    const windHoverLabel = "Vent maximal · " + sourceLabel + " · " + number(day.windSpeedMax) + " km/h" + windDirectionLabel + windTiming;
    const gustHoverLabel = "Rafales · " + sourceLabel + " · " + number(day.windGustMax) + " km/h" + gustTiming;
    const cloudMarkup = cloudMetricRow(cloudPresentation, cloudHoverLabel, summaries.sky);
    const windMarkup = windMetricGroup([day.windSpeedMax], windDirection + escapeText(number(day.windSpeedMax) + " km/h"), [day.windGustMax], escapeText(number(day.windGustMax) + " km/h"), summaries.wind, windHoverLabel, gustHoverLabel);
    const stormRisk = weekStormRisk(day.date, { includeOpenMeteo: sourceKey === "openmeteo", includeMeteoFrance: sourceKey === "meteofrance", individual: true });
    const stormLevel = stormRisk.level;
    const stormPeriodLabel = activeDay ? "sur la période restante" : "sur la journée";
    const stormLikelihood = stormLevel >= 5 ? "très probable" : stormLevel >= 4 ? "probable" : "possible";
    const stormHoverLabel = "Orage · " + sourceLabel + " · " + (stormActive ? stormLikelihood + " " : "non prévu ") + stormPeriodLabel
      + (stormLevel ? " · risque " + stormLevel + " sur 5 · " + stormRisk.stabilityLabel : "");
    const stormMarkup = metricRow("storm", stormHoverLabel, [stormLevel], value => value, "", stormActive ? "Orage " + stormLikelihood + "." : "Pas d’orage.");
    const sourceStormMarkup = stormActive ? stormSignalPictogram(stormHoverLabel, "week-source-storm-source") : "";
    const rainHover = "Précipitations · " + sourceLabel + " : " + number(dailyRain) + " mm · " + number(day.precipitationProbabilityMax) + " %";
    const sourceWeatherMarkup = stormActive ? '<div class="week-weather-pictograms"><div class="week-icon weather-icon">' + icon + '</div>' + sourceStormMarkup + '</div>' : '<div class="week-icon weather-icon">' + icon + '</div>';
    return '<article class="week-day' + (stormActive ? ' week-source-storm-day' : '') + '">' + weekDayHeading(date, day.date, [day]) + sourceControls + '<div class="week-day-overview chart-point" tabindex="0" data-tooltip="' + escapeText(rainHover) + '">' + sourceWeatherMarkup + '<div class="week-temperatures"><span class="week-temperature"><small>Max.</small><strong>' + number(day.temperatureMax) + '°</strong></span><span class="week-temperature"><small>Min.</small><b>' + number(day.temperatureMin) + '°</b></span></div></div><dl>' + cloudMarkup + rainMarkup + windMarkup + stormMarkup + '</dl>' + confidenceMarkup + '</article>';
  };
  const renderSynthesisDay = (ecmwf, arpege, sourceControls) => {
    arpege = { ...arpege, stormSignal: meteoFranceStormForDate(arpege.date) };
    const agreement = weekModelAgreement(ecmwf, arpege);
    const evolution = weekForecastEvolution().get(arpege.date) || { level: "unknown", description: "" };
    const openMeteoStorm = Number(ecmwf.weatherCode) >= 95;
    const meteoFranceStorm = meteoFranceStormForDate(arpege.date);
    const date = new Date(arpege.time);
    const finite = values => values.map(Number).filter(Number.isFinite);
    const mean = values => { const valid = finite(values); return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null; };
    const range = (values, suffix, digits = 1) => { const valid = finite(values); if (!valid.length) return "—"; const format = value => value.toLocaleString("fr-FR", { maximumFractionDigits: digits }); return (valid.length > 1 && Math.abs(valid[0] - valid[1]) >= .05 ? format(Math.min(...valid)) + " – " + format(Math.max(...valid)) : format(valid[0])) + suffix; };
    const synthesisCloud = mean([ecmwf.cloudCoverMean ?? ecmwf.cloudCover, arpege.cloudCoverMean ?? arpege.cloudCover]) ?? 50;
    const synthesisStorm = openMeteoStorm || meteoFranceStorm;
    const hideRain = weekRainBelowDisplayThreshold([ecmwf.precipitationProbabilityMax, arpege.precipitationProbabilityMax], synthesisStorm);
    const icon = displayIcon({ time: arpege.time, cloudCover: synthesisCloud, rain: hideRain ? 0 : Math.max(synthesisStorm ? .5 : 0, dailyRainIconAmount(agreement.rainIconAmount)), rainLevel: hideRain ? 0 : rainPictogramStep(agreement.rainIconAmount) });
    const stormModels = [openMeteoStorm ? "Open-Meteo" : "", meteoFranceStorm ? "Météo-France" : ""].filter(Boolean);
    const stormLabel = stormModels.length >= 2 ? "Risque partagé" : stormModels.length ? stormModels[0] + " seulement" : "possible";
    const showerLabel = (Number(ecmwf.showersSum) || 0) >= .1 ? "oui" : Number(ecmwf.weatherCode) >= 80 ? "probable" : "non";
    const windDirections = [ecmwf.windDirection, arpege.windDirection].map(Number).filter(Number.isFinite);
    const windDirection = windDirections.length ? (Math.atan2(windDirections.reduce((sum, value) => sum + Math.sin(value * Math.PI / 180), 0), windDirections.reduce((sum, value) => sum + Math.cos(value * Math.PI / 180), 0)) * 180 / Math.PI + 360) % 360 : null;
    const windDirectionMarkup = windDirection == null ? "" : '<span class="week-wind-arrow" style="transform:rotate(' + windDirection + 'deg)">↑</span>';
    const ensembleLabel = agreement.stability === "stable" ? "Plutôt stable" : agreement.stability === "evolving" ? "Évolutif" : agreement.stability === "variable" ? "Très variable" : "À confirmer";
    const modelAgreementScore = Number.isFinite(Number(agreement.score)) ? Number(agreement.score) : .5;
    const modelAgreementPoints = Math.min(5, Math.max(1, Math.round(modelAgreementScore * 5)));
    const convergenceLabel = modelAgreementPoints >= 5 ? "Forte" : modelAgreementPoints >= 3 ? "Partielle" : "Faible";
    const evolutionLabel = evolution.level === "frequent" ? "Forte" : evolution.level === "few" ? "Faible" : evolution.level === "stable" ? "Nulle" : "Sans recul";
    const verdictLevel = evolution.level === "frequent" && agreement.level === "agreement" ? "mixed" : agreement.level;
    // La concordance chiffrée entre modèles porte l'essentiel du verdict.
    // Stabilité et évolution nuancent le score sans imposer seules "faible".
    const stabilityScore = agreement.stability === "stable" ? 1 : agreement.stability === "evolving" ? .68 : agreement.stability === "variable" ? .35 : .55;
    const evolutionScore = evolution.level === "stable" ? 1 : evolution.level === "few" ? .75 : evolution.level === "frequent" ? .35 : .55;
    const combinedConfidenceScore = modelAgreementScore * .65 + stabilityScore * .2 + evolutionScore * .15;
    let confidenceLevel = combinedConfidenceScore >= .9 ? "strong" : combinedConfidenceScore >= .5 ? "medium" : "low";
    if (agreement.criticalDisagreement || agreement.rainDisagreement === "major" || modelAgreementScore < .38) {
      confidenceLevel = "low";
    } else if ((agreement.rainDisagreement === "meaningful" || agreement.level === "mixed" || evolution.level === "frequent") && confidenceLevel === "strong") {
      confidenceLevel = "medium";
    }
    const confidenceLabel = confidenceLevel === "strong" ? "forte" : confidenceLevel === "medium" ? "moyenne" : "faible";
    const rainDisagreementLabel = agreement.rainDisagreement === "major" ? "majeur" : agreement.rainDisagreement === "meaningful" ? "significatif" : agreement.rainDisagreement === "minor" ? "mineur" : "faible";
    const confidenceTitle = "Concordance pondérée : " + Math.round(modelAgreementScore * 100) + "/100 · écart pluie : " + rainDisagreementLabel + " · stabilité : " + ensembleLabel + " · évolution : " + evolutionLabel;
    const statusPointCount = score => Number.isFinite(score) ? Math.min(5, Math.max(score > 0 ? 1 : 0, Math.round(score * 5))) : 0;
    const statusTone = score => {
      const points = statusPointCount(score);
      return points >= 5 ? "strong" : points >= 3 ? "medium" : points >= 1 ? "low" : "medium";
    };
    const statusDots = score => {
      const points = statusPointCount(score);
      return '<span class="week-status-dots" aria-hidden="true">' + Array.from({ length: 5 }, (_, index) => '<i class="' + (index < points ? 'filled' : '') + '"></i>').join('') + '</span>';
    };
    const confidenceDisplayScore = confidenceLevel === "low" ? Math.min(combinedConfidenceScore, .4) : confidenceLevel === "medium" ? Math.min(combinedConfidenceScore, .7) : combinedConfidenceScore;
    const confidenceMarkup = '<span class="week-footer-status ' + statusTone(confidenceDisplayScore) + '" title="' + escapeText(confidenceTitle) + '"><span>Confiance</span><span role="img" aria-label="Confiance ' + escapeText(confidenceLabel) + '">' + statusDots(confidenceDisplayScore) + '</span></span>';
    const rainRange = values => {
      const valid = finite(values);
      if (!valid.length) return "—";
      const format = value => value > 0 && value < .1 ? "< 0,1" : value.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
      return (valid.length > 1 && Math.abs(valid[0] - valid[1]) >= .05 ? format(Math.min(...valid)) + " – " + format(Math.max(...valid)) : format(valid[0])) + " mm";
    };
    const modelRangeDetail = (label, values, suffix = " km/h") => {
      const valid = finite(values);
      if (valid.length <= 1) return "";
      return " · " + label + " " + range(valid, suffix);
    };
    const sourceValueDetail = (label, ecmwfValue, arpegeValue, suffix = " km/h") => {
      const details = [
        Number.isFinite(Number(ecmwfValue)) ? "Open-Meteo " + number(ecmwfValue) + suffix : "",
        Number.isFinite(Number(arpegeValue)) ? "Météo-France " + number(arpegeValue) + suffix : ""
      ].filter(Boolean);
      return details.length ? " · " + label + " " + details.join(" · ") : "";
    };
    const combinedPeriodDetail = (label, periods) => {
      const text = forecastPeriodText(periods);
      return text ? " · " + label + " " + text : "";
    };
    const sourcePeriodDetail = (label, ecmwfPeriod, arpegePeriod) => {
      const details = [
        ecmwfPeriod ? "Open-Meteo " + forecastPeriodText([ecmwfPeriod]) : "",
        arpegePeriod ? "Météo-France " + forecastPeriodText([arpegePeriod]) : ""
      ].filter(Boolean);
      return details.length ? " · " + label + " " + details.join(" · ") : "";
    };
    const rainValues = finite([ecmwf.precipitationSum, arpege.precipitationSum]);
    const rawWindValues = finite([ecmwf.windSpeedMax, arpege.windSpeedMax]);
    const rawGustValues = finite([ecmwf.windGustMax, arpege.windGustMax]);
    const synthesisWindValue = mean(rawWindValues);
    const synthesisGustValue = mean(rawGustValues);
    const windValues = finite([synthesisWindValue]);
    const gustValues = finite([synthesisGustValue]);
    const cloudValues = [ecmwf.cloudCoverMean ?? ecmwf.cloudCover, arpege.cloudCoverMean ?? arpege.cloudCover];
    const riskValues = [
      { value: ecmwf.precipitationProbabilityMax, name: "Open-Meteo" },
      { value: arpege.precipitationProbabilityMax, name: "Météo-France" }
    ];
    const showerLevel = showerLabel === "oui" ? 5 : showerLabel === "probable" ? 3 : 0;
    const stormRisk = weekStormRisk(arpege.date);
    const stormLevel = stormRisk.level;
    const cloudPresentation = cloudCoverPresentation([ecmwf, arpege]);
    const synthesisCloudPeriods = [
      cloudPresentation.morning != null ? "matin " + number(cloudPresentation.morning) + " %" : "",
      cloudPresentation.afternoon != null ? "après-midi " + number(cloudPresentation.afternoon) + " %" : ""
    ].filter(Boolean);
    const cloudHoverLabel = "Nébulosité · Open-Meteo " + dailyCloudRangeText(ecmwf) + " · Météo-France " + dailyCloudRangeText(arpege)
      + (synthesisCloudPeriods.length ? " · synthèse " + synthesisCloudPeriods.join(" · ") : "");
    const windPeriodSummary = forecastPeriodText(forecastSharedPeriods(ecmwf.windPeriod ? [ecmwf.windPeriod] : [], arpege.windPeriod ? [arpege.windPeriod] : []));
    const gustPeriodSummary = forecastPeriodText(forecastSharedPeriods(ecmwf.gustPeriod ? [ecmwf.gustPeriod] : [], arpege.gustPeriod ? [arpege.gustPeriod] : []));
    const windHoverLabel = "Vent · synthèse " + range(windValues, " km/h")
      + modelRangeDetail("plage modèles", rawWindValues)
      + sourceValueDetail("sources", ecmwf.windSpeedMax, arpege.windSpeedMax)
      + (windDirection == null ? "" : " · direction " + Math.round(windDirection) + "°")
      + (windPeriodSummary ? " · surtout " + windPeriodSummary : "")
      + combinedPeriodDetail("maxima possibles", [ecmwf.windPeriod, arpege.windPeriod].filter(Boolean))
      + sourcePeriodDetail("maxima par source", ecmwf.windPeriod, arpege.windPeriod);
    const gustHoverLabel = "Rafales · synthèse " + range(gustValues, " km/h")
      + modelRangeDetail("plage modèles", rawGustValues)
      + sourceValueDetail("sources", ecmwf.windGustMax, arpege.windGustMax)
      + (gustPeriodSummary ? " · surtout " + gustPeriodSummary : "")
      + combinedPeriodDetail("maxima possibles", [ecmwf.gustPeriod, arpege.gustPeriod].filter(Boolean))
      + sourcePeriodDetail("maxima par source", ecmwf.gustPeriod, arpege.gustPeriod);
    const cloudMarkup = cloudMetricRow(cloudPresentation, cloudHoverLabel, agreement.skySummary);
    const rainMarkup = rainMetricRow(rainValues, escapeText(rainRange(rainValues)), [], showerLevel, agreement.rainProbability, agreement.rainSummary);
    const windMarkup = windMetricGroup(windValues, windDirectionMarkup + escapeText(range(windValues, " km/h")), gustValues, escapeText(range(gustValues, " km/h")), agreement.windSummary, windHoverLabel, gustHoverLabel);
    const stormDescription = stormModels.length >= 2 ? "Orage possible selon " + stormModels.join(" et ") + "."
      : stormModels.length ? "Orage possible selon " + stormModels[0] + " seulement." : "Pas d’orage.";
    const stormHoverLabel = "Orage · Open-Meteo " + (openMeteoStorm ? "possible" : "non prévu")
      + " · Météo-France " + (meteoFranceStorm ? "possible" : "non prévu")
      + " · risque " + stormLevel + " sur 5"
      + (stormRisk.individualLevels
        ? " · moyenne basse d’Open-Meteo " + stormRisk.individualLevels.openMeteo + "/5 et Météo-France " + stormRisk.individualLevels.meteoFrance + "/5"
        : stormRisk.instabilityPenalty ? " · pénalité d’instabilité " + stormRisk.instabilityPenalty : "");
    const synthesisStormMarkup = synthesisStorm ? stormSignalPictogram(stormHoverLabel, "week-synthesis-storm-source") : "";
    const rainHover = "Précipitations\nOpen-Meteo : " + number(ecmwf.precipitationSum) + " mm · " + number(ecmwf.precipitationProbabilityMax) + " %\nMétéo-France : " + number(arpege.precipitationSum) + " mm · " + number(arpege.precipitationProbabilityMax) + " %";
    const synthesisWeatherMarkup = synthesisStorm
      ? '<div class="week-weather-pictograms"><div class="week-icon weather-icon">' + icon + '</div>' + synthesisStormMarkup + '</div>'
      : '<div class="week-icon weather-icon">' + icon + '</div>';
    const stormMarkup = metricRow("storm", stormHoverLabel, [stormLevel], value => value, "", stormDescription);
    const convergenceTone = statusTone(modelAgreementScore);
    const convergenceTitle = "Convergence des modèles : " + convergenceLabel.toLowerCase() + " · " + Math.round(modelAgreementScore * 100) + "/100";
    const convergenceMarkup = '<span class="week-footer-status ' + convergenceTone + '" title="' + escapeText(convergenceTitle) + '"><span>Convergence des modèles</span><span role="img" aria-label="' + escapeText(convergenceTitle) + '">' + statusDots(modelAgreementScore) + '</span></span>';
    const evolutionCounts = evolution.transitionCount ? evolution.changedCount + " changement" + (evolution.changedCount > 1 ? "s" : "") + " sur " + evolution.transitionCount + " comparaison" + (evolution.transitionCount > 1 ? "s" : "") + ". " : "";
    const evolutionTitle = evolutionCounts + (evolution.description || (evolution.level === "stable" ? "Aucun changement notable dans les dernières prévisions." : evolution.level === "unknown" ? "Pas encore assez de recul pour évaluer les changements." : ""));
    const evolutionDisplayScore = Number.isFinite(evolution.changeRate) ? Math.max(.2, 1 - evolution.changeRate) : null;
    const evolutionTone = statusTone(evolutionDisplayScore);
    const evolutionMarkup = '<span class="week-footer-status ' + evolutionTone + '" title="' + escapeText(evolutionTitle) + '"><span>Évolution des prévisions</span><span role="img" aria-label="' + escapeText(evolutionLabel + " : " + evolutionTitle) + '">' + statusDots(evolutionDisplayScore) + '</span></span>';
    const footerMarkup = '<div class="week-synthesis-footer">' + convergenceMarkup + evolutionMarkup + confidenceMarkup + '</div>';
    return '<article class="week-day week-consensus-day ' + verdictLevel + '">' + weekDayHeading(date, arpege.date, [ecmwf, arpege]) + sourceControls + '<div class="week-day-overview chart-point" tabindex="0" data-tooltip="' + escapeText(rainHover) + '">' + synthesisWeatherMarkup + '<div class="week-temperatures"><span class="week-temperature"><small>Max.</small><strong>' + number(mean([ecmwf.temperatureMax, arpege.temperatureMax])) + '°</strong></span><span class="week-temperature"><small>Min.</small><b>' + number(mean([ecmwf.temperatureMin, arpege.temperatureMin])) + '°</b></span></div></div><dl>' + cloudMarkup + rainMarkup + windMarkup + stormMarkup + '</dl>' + footerMarkup + '</article>';
  };
  const openMeteoDays = (latestWeekForecast?.days || []).filter(day => day.date >= todayDateKey()).slice(0, 7).map(day => futureActiveWeekDay(day));
  const meteoFranceByDate = new Map((latestMeteoFranceWeek?.days || []).map(day => futureActiveWeekDay(day)).map(day => [day.date, day]));
  const cards = openMeteoDays.map(openMeteo => {
    const meteoFrance = meteoFranceByDate.get(openMeteo.date) || null;
    const hasMeteoFrance = Boolean(meteoFrance);
    let selected = weekDaySourceSelection.get(openMeteo.date) || (hasMeteoFrance ? "synthesis" : "openmeteo");
    if (!hasMeteoFrance && selected !== "openmeteo") selected = "openmeteo";
    const sourceControls = controls(openMeteo.date, hasMeteoFrance, selected);
    if (selected === "meteofrance") return renderDay(meteoFrance, "meteofrance", sourceControls);
    if (selected === "synthesis") return renderSynthesisDay(openMeteo, meteoFrance, sourceControls);
    return renderDay(openMeteo, "openmeteo", sourceControls);
  }).join("");
  const content = cards || '<div class="week-source-message">' + escapeText(weekForecastErrors.openmeteo || "Chargement des prévisions…") + '</div>';
  $("week-forecast").innerHTML = '<section class="week-daily-view" aria-label="Prévisions sur 7 jours"><div class="week-day-grid week-day-grid-seven">' + content + '</div></section>';
  bindWeekHorizontalScroll();
  renderWeekApiLinks();
  $("week-forecast").querySelectorAll("[data-week-source]:not(:disabled)").forEach(button => button.addEventListener("click", () => {
    weekDaySourceSelection.set(button.dataset.weekDate, button.dataset.weekSource);
    renderWeekForecast();
  }));
}

function bindWeekHorizontalScroll() {
  const master = $("week-horizontal-scroll");
  const track = $("week-horizontal-track");
  const content = document.querySelector(".week-scroll");
  if (!master || !track || !content) return;
  track.style.width = $("week-forecast").scrollWidth + "px";
  let synchronising = false;
  const sync = source => {
    if (synchronising) return;
    synchronising = true;
    const left = source.scrollLeft;
    master.scrollLeft = left;
    content.scrollLeft = left;
    synchronising = false;
  };
  master.onscroll = () => sync(master);
  content.onscroll = () => sync(content);
  content.scrollLeft = master.scrollLeft;
}

function scheduleMeteoFranceWeekPoll(status) {
  clearTimeout(meteoFranceWeekPollTimer);
  meteoFranceWeekPollTimer = 0;
  const activeDayValidUntil = new Date(latestMeteoFranceWeek?.activeDayValidUntil || 0).getTime();
  const awaitingData = status === "loading" || status === "pending" || status === "error";
  // Même une réponse complète doit être revérifiée : les runs ARPEGE sont
  // renouvelés en journée. Une erreur PE-ARPEGE est aussi réessayée au lieu
  // de figer l'indice de confiance jusqu'au lendemain.
  const delay = awaitingData ? status === "error" ? 60000 : 5000
    : Number.isFinite(activeDayValidUntil) && activeDayValidUntil > Date.now()
      ? Math.min(15 * 60000, activeDayValidUntil - Date.now() + 1000)
      : 5000;
  if (!delay) return;
  meteoFranceWeekPollTimer = setTimeout(async () => {
    try {
      const payload = await json("api/week?lat=" + point.lat + "&lon=" + point.lon);
      latestWeekEvolutionHistory = Array.isArray(payload.history) ? payload.history : [];
      if (payload.status === "ready" && payload.data?.version >= 20 && payload.data?.days?.length === 4) {
        const ensembleStatus = payload.data.version >= 7 ? payload.ensemble || null : { status: "pending", stage: payload.stage, progress: 0, error: null };
        latestMeteoFranceWeek = { ...payload.data, ensembleStatus };
        renderWeekForecast();
        scheduleMeteoFranceWeekPoll(ensembleStatus?.status);
      } else {
        scheduleMeteoFranceWeekPoll("loading");
      }
    } catch (error) {
      weekForecastErrors.meteofrance = error.message;
      renderWeekForecast();
    }
  }, delay);
}

async function loadMeteoFranceWeek() {
  for (let attempt = 0; attempt < 300; attempt++) {
    const payload = await json("api/week?lat=" + point.lat + "&lon=" + point.lon);
    latestWeekEvolutionHistory = Array.isArray(payload.history) ? payload.history : [];
    if (payload.status === "ready" && payload.data?.version >= 20 && payload.data?.days?.length === 4) {
      const ensembleStatus = payload.data.version >= 7 ? payload.ensemble || null : { status: "pending", stage: payload.stage, progress: 0, error: null };
      scheduleMeteoFranceWeekPoll(ensembleStatus?.status);
      return { ...payload.data, ensembleStatus };
    }
    if (payload.status === "error") throw new Error(payload.error || "Prévision ARPEGE impossible à charger.");
    weekForecastErrors.meteofrance = (payload.stage || "Acquisition ARPEGE") + " · " + (payload.progress || 0) + " %";
    renderWeekForecast();
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error("L’acquisition ARPEGE dépasse dix minutes.");
}

async function ensureWeekForecast() {
  if (!weekCacheHydrated) {
    weekCacheHydrated = true;
    const weekPath = "api/week?lat=" + point.lat + "&lon=" + point.lon;
    const cachedPayload = await readCachedJson(apiUrl(weekPath), 6 * 3600000);
    if (cachedPayload) {
      latestWeekEvolutionHistory = Array.isArray(cachedPayload.history) ? cachedPayload.history : [];
      if (cachedPayload.status === "ready" && cachedPayload.data?.version >= 20 && cachedPayload.data?.days?.length === 4) {
        latestMeteoFranceWeek = {
          ...cachedPayload.data,
          ensembleStatus: cachedPayload.data.version >= 7 ? cachedPayload.ensemble || null : { status: "pending", stage: cachedPayload.stage, progress: 0, error: null }
        };
        renderWeekForecast();
      }
    }
  }
  const confidenceReady = latestWeekForecast?.days?.length && latestWeekForecast.days.every(day => day.confidence);
  if (latestWeekForecast?.days?.length && latestMeteoFranceWeek?.days?.length && confidenceReady) {
    renderWeekForecast();
    return;
  }
  if (weekForecastPromise) return weekForecastPromise;
  weekForecastErrors = {};
  renderWeekForecast();
  weekForecastPromise = (async () => {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(point.lat));
    url.searchParams.set("longitude", String(point.lon));
    url.searchParams.set("timezone", "Europe/Paris");
    url.searchParams.set("forecast_days", "8");
    url.searchParams.set("wind_speed_unit", "kmh");
    // Keep one model over the whole forecast. Open-Meteo's automatic
    // best-match currently introduces artificial gust jumps at model seams.
    url.searchParams.set("models", "ecmwf_ifs");
    url.searchParams.set("hourly", "temperature_2m,apparent_temperature,precipitation,rain,showers,precipitation_probability,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m");
    url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,rain_sum,showers_sum,precipitation_probability_max,cloud_cover_mean,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,sunrise,sunset");
    const ensembleUrl = new URL("https://ensemble-api.open-meteo.com/v1/ensemble");
    ensembleUrl.searchParams.set("latitude", String(point.lat));
    ensembleUrl.searchParams.set("longitude", String(point.lon));
    ensembleUrl.searchParams.set("timezone", "Europe/Paris");
    ensembleUrl.searchParams.set("forecast_days", "8");
    ensembleUrl.searchParams.set("wind_speed_unit", "kmh");
    ensembleUrl.searchParams.set("models", "dwd_icon_eps_ensemble_mean_seamless");
    ensembleUrl.searchParams.set("hourly", "temperature_2m_spread,precipitation_spread,wind_speed_10m_spread");
    const forecastRequest = latestOpenMeteoWeekRaw ? Promise.resolve(null) : (async () => {
      const value = await readCachedJson(url.toString(), 30 * 60000) || await json(url.toString());
      latestOpenMeteoWeekRaw = { daily: value.daily, hourly: value.hourly };
      latestWeekForecast = { fetchedAt: Date.now(), model: "Open-Meteo", days: includeCurrentDashboardDay(normalizeOpenMeteoDays(value.daily, value.hourly)) };
      scheduleActiveWeekDayUpdate();
      renderWeekForecast();
      return value;
    })();
    const [forecastResult, meteoFranceResult, ensembleResult] = await Promise.allSettled([
      forecastRequest,
      latestMeteoFranceWeek?.days?.length ? Promise.resolve(null) : loadMeteoFranceWeek(),
      confidenceReady ? Promise.resolve(null) : json(ensembleUrl.toString())
    ]);
    if (!latestWeekForecast?.days?.length) {
      if (forecastResult.status === "fulfilled") {
        latestOpenMeteoWeekRaw = { daily: forecastResult.value.daily, hourly: forecastResult.value.hourly };
        latestWeekForecast = { fetchedAt: Date.now(), model: "Open-Meteo", days: includeCurrentDashboardDay(normalizeOpenMeteoDays(forecastResult.value.daily, forecastResult.value.hourly)) };
        scheduleActiveWeekDayUpdate();
      }
      else weekForecastErrors.openmeteo = "Impossible de charger Open-Meteo : " + forecastResult.reason.message;
    }
    if (!latestMeteoFranceWeek?.days?.length) {
      if (meteoFranceResult.status === "fulfilled") {
        latestMeteoFranceWeek = meteoFranceResult.value;
        scheduleMeteoFranceWeekPoll(latestMeteoFranceWeek?.ensembleStatus?.status);
        delete weekForecastErrors.meteofrance;
      }
      else weekForecastErrors.meteofrance = "Impossible de charger Météo-France : " + meteoFranceResult.reason.message;
    }
    if (ensembleResult.status === "fulfilled" && ensembleResult.value) {
      const confidenceByDate = normalizeWeekConfidence(ensembleResult.value.hourly);
      latestWeekForecast.days = (latestWeekForecast?.days || []).map(day => ({ ...day, confidence: confidenceByDate.get(day.date) || null }));
    }
    renderWeekForecast();
  })().catch(error => {
    weekForecastErrors.openmeteo ||= error.message;
    weekForecastErrors.meteofrance ||= error.message;
    renderWeekForecast();
  }).finally(() => {
    weekForecastPromise = null;
    clearTimeout(weekForecastRetryTimer);
    if (!latestOpenMeteoWeekRaw) weekForecastRetryTimer = setTimeout(ensureWeekForecast, 15000);
  });
  return weekForecastPromise;
}

async function ensureOpenMeteoEnsemble() {
  if (latestOpenMeteoEnsemble && Date.now() - latestOpenMeteoEnsemble.fetchedAt < 30 * 60000) return latestOpenMeteoEnsemble;
  if (openMeteoEnsemblePromise) return openMeteoEnsemblePromise;
  openMeteoEnsemblePromise = (async () => {
    const url = new URL("https://ensemble-api.open-meteo.com/v1/ensemble");
    url.searchParams.set("latitude", String(point.lat));
    url.searchParams.set("longitude", String(point.lon));
    url.searchParams.set("timezone", "Europe/Paris");
    url.searchParams.set("forecast_hours", "48");
    url.searchParams.set("wind_speed_unit", "kmh");
    url.searchParams.set("models", "dwd_icon_eps_ensemble_mean_seamless");
    url.searchParams.set("hourly", "temperature_2m_spread,wind_speed_10m_spread,wind_gusts_10m_spread");
    const source = await json(url.toString());
    const hourly = source.hourly || {};
    const hours = (hourly.time || []).map((time, index) => ({
      time,
      temperatureSpread: hourly.temperature_2m_spread?.[index],
      windSpread: hourly.wind_speed_10m_spread?.[index],
      gustSpread: hourly.wind_gusts_10m_spread?.[index]
    })).filter(item => Number.isFinite(item.temperatureSpread) && Number.isFinite(item.windSpread) && Number.isFinite(item.gustSpread));
    if (!hours.length) throw new Error("Open‑Meteo ne renvoie aucune variabilité d’ensemble exploitable.");
    latestOpenMeteoEnsemble = { source: "openmeteo", fetchedAt: Date.now(), model: "ICON EPS", hours };
    if (activeForecastSource === "openmeteo") renderActiveForecast();
    return latestOpenMeteoEnsemble;
  })().catch(() => null).finally(() => { openMeteoEnsemblePromise = null; });
  return openMeteoEnsemblePromise;
}

function completeHourlyRain(samples, stepMinutes, source, anchorAtStart = false) {
  const step = stepMinutes * 60000;
  const stepsPerHour = 60 / stepMinutes;
  const byEndTime = new Map(samples
    .filter(sample => Number.isFinite(sample.endTime) && Number.isFinite(sample.precipitation))
    .map(sample => [sample.endTime, Math.max(0, sample.precipitation)]));
  const result = new Map();
  for (const endTime of byEndTime.keys()) {
    const end = new Date(endTime);
    if (end.getMinutes() !== 0 || end.getSeconds() !== 0 || end.getMilliseconds() !== 0) continue;
    const amounts = Array.from({ length: stepsPerHour }, (_, index) => byEndTime.get(endTime - index * step));
    // Never turn a partial nowcast into an hourly total. All consecutive
    // sub-periods ending at H are required to cover exactly [H-1 h, H].
    if (amounts.some(amount => !Number.isFinite(amount))) continue;
    // The 48 h cells are labelled by the beginning of the represented hour.
    // PIAF values, however, are timestamped at the end of each accumulation.
    const anchorTime = anchorAtStart ? endTime - 3600000 : endTime;
    result.set(anchorTime, {
      rain: Math.round(amounts.reduce((total, amount) => total + amount, 0) * 100) / 100,
      rainSource: source,
      rainIntervalStart: endTime - 3600000,
      rainIntervalEnd: endTime
    });
  }
  return result;
}

function piafRunTime(piaf) {
  const runText = piaf?.coverageId?.match(/___(\d{4}-\d{2}-\d{2}T\d{2}\.\d{2}\.\d{2}Z)_PT5M$/)?.[1];
  return runText ? Date.parse(runText.replace(/\./g, ":")) : NaN;
}

// Calcul transféré au moteur : piafItemEndTime.

// Calcul transféré au moteur : piafRainSteps.

// Calcul transféré au moteur : rainPassageForStep.

// Calcul transféré au moteur : rainPassageFragmentsOutside.

// Calcul transféré au moteur : mergeThreeHourRainPassages.

// Calcul transféré au moteur : threeHourRainSignalIgnored.

// Calcul transféré au moteur : threeHourRainPassageAmount.

// Calcul transféré au moteur : threeHourRainMessageSequence.

function threeHourMessageSequenceInitialIndex(messages) {
  const sequence = messages || [];
  const priorities = [
    message => message?.state === "active" && message?.occurrenceReliable !== false,
    message => message?.state === "active" && message?.observedAtPoint === true,
    message => message?.state === "future" && message?.occurrenceReliable !== false,
    message => message?.state === "active",
    message => message?.state === "future"
  ];
  for (const priority of priorities) {
    const index = sequence.findIndex(priority);
    if (index >= 0) return index;
  }
  return Math.max(0, sequence.length - 1);
}

function threeHourMessagePosition(index, selectedIndex) {
  if (index === selectedIndex) return "current";
  if (index === selectedIndex - 1) return "previous";
  if (index === selectedIndex + 1) return "next";
  return index < selectedIndex ? "before" : "after";
}

function threeHourMessageSequenceMarkup(messages) {
  const sequence = (messages || []).filter(message => message?.label);
  if (!sequence.length) return "";
  const initialIndex = threeHourMessageSequenceInitialIndex(sequence);
  if (!threeHourMessageRotationEnabled) {
    const message = sequence[initialIndex];
    return '<span class="three-hour-action-value three-hour-message-static" aria-hidden="true">'
      + (message.detail ? '<small>' + escapeText(message.detail) + '</small>' : '')
      + '<b>' + escapeText(message.label) + '</b></span>';
  }
  const signature = sequence.map(message => message.key).join("|");
  return '<span class="three-hour-action-value three-hour-message-sequence" data-three-hour-message-sequence data-sequence-signature="' + escapeText(signature) + '" data-sequence-initial-index="' + initialIndex + '" aria-hidden="true">'
    + sequence.map((message, index) => '<span class="three-hour-message" data-three-hour-message data-position="' + threeHourMessagePosition(index, initialIndex) + '"><span class="three-hour-message-meta"><em>' + escapeText(message.detail) + '</em></span><b>' + escapeText(message.label) + '</b></span>').join("")
    + '</span>';
}

function clearThreeHourMessageSequence(reset = false) {
  clearInterval(threeHourMessageSequenceTimer);
  threeHourMessageSequenceTimer = 0;
  if (reset) {
    threeHourMessageSequenceState = { signature: "", index: 0 };
  }
}

function positionThreeHourMessageSequence(container, selectedIndex, animate = true) {
  const items = [...container.querySelectorAll("[data-three-hour-message]")];
  if (!items.length) return;
  const boundedIndex = Math.max(0, Math.min(items.length - 1, Number(selectedIndex) || 0));
  container.classList.toggle("is-resetting", !animate);
  items.forEach((item, index) => { item.dataset.position = threeHourMessagePosition(index, boundedIndex); });
  container.dataset.sequenceIndex = String(boundedIndex);
  threeHourMessageSequenceState.index = boundedIndex;
  if (!animate) requestAnimationFrame(() => container.classList.remove("is-resetting"));
}

function initializeThreeHourMessageSequence(root) {
  clearThreeHourMessageSequence();
  if (!threeHourMessageRotationEnabled) return;
  const container = root?.querySelector("[data-three-hour-message-sequence]");
  if (!container) return;
  const items = [...container.querySelectorAll("[data-three-hour-message]")];
  const initialIndex = Math.max(0, Math.min(items.length - 1, Number(container.dataset.sequenceInitialIndex) || 0));
  const signature = String(container.dataset.sequenceSignature || "");
  const selectedIndex = threeHourMessageSequenceState.signature === signature
    ? Math.max(initialIndex, Math.min(items.length - 1, threeHourMessageSequenceState.index))
    : initialIndex;
  threeHourMessageSequenceState = { signature, index: selectedIndex };
  positionThreeHourMessageSequence(container, selectedIndex, false);
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  if (window.METEO_REPLAY || reducedMotion || selectedIndex >= items.length - 1) return;
  threeHourMessageSequenceTimer = window.setInterval(() => {
    if (!container.isConnected || document.hidden || container.closest(".three-hour-action")?.matches(":hover, :focus-within")) return;
    const currentIndex = Number(container.dataset.sequenceIndex) || initialIndex;
    const nextIndex = currentIndex >= items.length - 1 ? initialIndex : currentIndex + 1;
    positionThreeHourMessageSequence(container, nextIndex, currentIndex < items.length - 1);
  }, 5000);
}

function piafQuarterHourRain(piaf, radar = null) {
  return (currentNowcast()?.quarterHourRain || []).map(item => ({ ...item, slotTime: new Date(item.slotTime) }));
}

function piafHourlyRain(piaf, radar = null) {
  return new Map(currentNowcast()?.hourlyRain || []);
}

function currentNowcast() {
  const forecast = latestForecastData?.nowcast;
  return forecast?.schemaVersion === 1 && appNow() <= forecast.validUntil ? forecast : null;
}

function openMeteoHourlyRain(openMeteo) {
  return completeHourlyRain((openMeteo?.minutely15 || []).map(item => ({
    endTime: new Date(item.time).getTime(),
    precipitation: Number(item.precipitation)
  })), 15, "Open-Meteo 15 min");
}

function withHourlyNowcast(forecast, hourlyRain, options = {}) {
  if (!forecast?.hours?.length || !hourlyRain?.size) return forecast;
  const fallbackByTime = new Map((options.fallbackHours || []).map(item => [new Date(item.time).getTime(), item]));
  const existingTimes = new Set(forecast.hours.map(item => new Date(item.time).getTime()));
  const currentHour = new Date(appNow());
  currentHour.setMinutes(0, 0, 0);
  const firstForecastTime = Math.min(...existingTimes);
  const prependedHours = options.includeCurrentHour
    ? [...hourlyRain.entries()].flatMap(([time, replacement]) => {
        if (time < currentHour.getTime() || time >= firstForecastTime || existingTimes.has(time)) return [];
        const fallback = fallbackByTime.get(time) || forecast.hours[0];
        return [{
          ...fallback,
          time: new Date(time).toISOString(),
          leadHour: Math.min(0, Number(fallback?.leadHour) || 0),
          ...replacement
        }];
      })
    : [];
  return {
    ...forecast,
    hours: [...prependedHours, ...forecast.hours.map(item => {
      const replacement = hourlyRain.get(new Date(item.time).getTime());
      return replacement ? { ...item, ...replacement } : item;
    })].sort((left, right) => new Date(left.time) - new Date(right.time))
  };
}

function precedingHourEndKey(time) {
  const match = String(time).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return String(time).slice(0, 13);
  const [, year, month, day, hour, minute] = match;
  if (minute === "00") return `${year}-${month}-${day}T${hour}`;
  // Open-Meteo timestamps precipitation probabilities at the end of the
  // preceding hour. A 22:45 slot therefore belongs to the hour ending 23:00.
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) + 1)).toISOString().slice(0, 13);
}

function renderActiveForecast() {
  const data = latestForecastData;
  if (!data) return;
  const openMeteo = withHourlyNowcast(data.openMeteo, openMeteoHourlyRain(data.openMeteo));
  const meteoFranceFallback = (openMeteo?.hours || []).map(item => ({
    ...item,
    cloudCover: item.cloudCover ?? item.cloudiness
  }));
  const meteoFrance = withHourlyNowcast(
    data.arome,
    data.piaf ? piafHourlyRain(data.piaf, data.radar) : null,
    { includeCurrentHour: true, fallbackHours: meteoFranceFallback }
  );
  if (activeForecastSource === "comparison") {
    renderComparisonForecast(meteoFrance, openMeteo);
    return;
  }
  if (activeForecastSource === "openmeteo") {
    if (!openMeteo?.hours?.length) return;
    const forecast = {
      ...openMeteo,
      hours: openMeteo.hours.map((item, index) => ({
        ...item,
        cloudCover: item.cloudiness,
        leadHour: index
      }))
    };
    renderForecast(forecast, null, latestOpenMeteoEnsemble, null);
    return;
  }
  if (meteoFrance) renderForecast(meteoFrance, data.pearome, data.ensemble, null);
}

function renderActiveRain() {
  const data = latestForecastData;
  if (!data) return;
  if (!window.METEO_REPLAY && !currentNowcast()) {
    $("rain-bars").innerHTML = '<p>Prévision en attente d’actualisation</p>';
    $("rain-axis").innerHTML = '';
    renderRadarNowcast(data.radar, data.piaf, data.arome, data.lightning, data.vigilance);
    return;
  }
  const useOpenMeteo = Boolean(window.METEO_REPLAY && !data.piaf);
  if (useOpenMeteo) {
    if ($("rain-api-links")) $("rain-api-links").innerHTML = shortRainLinks();
    const probabilityByHour = new Map((data.openMeteo?.hours || []).map(item => [item.time.slice(0, 13), item.probability]));
    const values = (data.openMeteo?.minutely15 || []).map(item => ({
      ...item,
      probability: probabilityByHour.get(precedingHourEndKey(item.time))
    }));
    if (values.length) renderPiaf({ values, source: "openmeteo" });
  } else {
    if ($("rain-api-links")) $("rain-api-links").innerHTML = shortRainLinks();
    if (data.piaf) renderPiaf(data.piaf, data.radar);
  }
  refreshSourceIndicators();
  renderRadarNowcast(data.radar, data.piaf, data.arome || (window.METEO_REPLAY ? data.openMeteo : null), data.lightning, data.vigilance);
}

function renderComparisonForecast(arome, openMeteo) {
  const panels = $("forecast-panels");
  const overview = $("forecast-overview");
  $("panel-48h")._updateMetricLabels = null;
  $("panel-48h")._updateMetricLabels = null;
  if (!arome?.hours?.length || !openMeteo?.hours?.length) {
    overview.innerHTML = '<p class="forecast-empty">La comparaison sera disponible dès que les deux modèles auront chargé leurs prévisions.</p>';
    panels.innerHTML = "";
    $("forecast-controls").innerHTML = "";
    return;
  }
  const openByTime = new Map(openMeteo.hours.map(item => [new Date(item.time).getTime(), item]));
  const currentHour = new Date(appNow());
  currentHour.setMinutes(0, 0, 0);
  const nextHour = new Date(currentHour);
  nextHour.setHours(nextHour.getHours() + 1);
  const hasCurrentShortTerm = arome.hours.some(item => item.rainShortTerm && new Date(item.time).getTime() === currentHour.getTime());
  const forecastStart = hasCurrentShortTerm ? currentHour : nextHour;
  const hours = arome.hours
    .filter(item => new Date(item.time) >= forecastStart)
    .map(meteoFrance => ({ meteoFrance, openMeteo: openByTime.get(new Date(meteoFrance.time).getTime()) }))
    .filter(pair => pair.openMeteo && ["temperature", "rain", "windSpeed", "windGust"].every(key => Number.isFinite(pair.meteoFrance[key]) && Number.isFinite(pair.openMeteo[key])))
    .slice(0, 48);
  if (!hours.length) {
    overview.innerHTML = '<p class="forecast-empty">Aucune heure commune n’est encore disponible pour comparer les deux modèles.</p>';
    panels.innerHTML = "";
    return;
  }
  const cell = 88;
  const width = hours.length * cell;
  const height = 316;
  const x = index => index * cell + cell / 2;
  const average = (pair, key) => (pair.meteoFrance[key] + pair.openMeteo[key]) / 2;
  const difference = (pair, key) => Math.abs(pair.meteoFrance[key] - pair.openMeteo[key]);
  const meteoFranceRainSource = item => item.rainShortTerm
    ? (Number(item.rainNowcastAmendment) > 0 ? "PIAF + Nowcasting" : "PIAF")
    : item.rainSource?.replace(/^Météo-France\s+/, "") || "AROME";
  const rainScenario = pair => {
    const meteoFranceRain = Math.max(0, Number(pair.meteoFrance.rain) || 0);
    const openMeteoRain = Math.max(0, Number(pair.openMeteo.rain) || 0);
    const probability = Number(pair.openMeteo.probability);
    const probabilityValue = Number.isFinite(probability) ? Math.max(0, Math.min(100, probability)) : null;
    const mfWet = meteoFranceRain >= measurableRainThreshold;
    const omWet = openMeteoRain >= measurableRainThreshold;
    const shower = !mfWet && !omWet && probabilityValue >= rainRiskDisplayThreshold;
    const minimum = Math.min(meteoFranceRain, openMeteoRain);
    const maximum = Math.max(meteoFranceRain, openMeteoRain);
    if (mfWet && omWet) {
      const amount = (meteoFranceRain + openMeteoRain) / 2;
      const spreadPenalty = Math.abs(meteoFranceRain - openMeteoRain) / Math.max(.5, maximum);
      return { kind: "shared", amount, minimum, maximum, probabilityValue, confidence: Math.round(Math.max(45, Math.min(95, 100 - spreadPenalty * 55))) };
    }
    if (mfWet || omWet) {
      const support = probabilityValue == null ? 0 : probabilityValue;
      const confidence = Math.round(Math.max(30, Math.min(72, 32 + support * .38 + (omWet ? 8 : 0))));
      return { kind: "single", amount: maximum, minimum, maximum, probabilityValue, confidence };
    }
    if (shower) return { kind: "shower", amount: 0, minimum, maximum, probabilityValue, confidence: Math.round(Math.max(20, Math.min(60, probabilityValue))) };
    return { kind: "dry", amount: 0, minimum, maximum, probabilityValue, confidence: 70 };
  };
  const agreement = pair => {
    // Use deliberately tight thresholds: a comparison view is useful only if
    // its background visibly reacts to modest model differences.
    const temperature = Math.max(0, 1 - difference(pair, "temperature") / 2.5);
    const wind = Math.max(0, 1 - difference(pair, "windSpeed") / 10);
    const gust = Math.max(0, 1 - difference(pair, "windGust") / 16);
    const rain = rainScenario(pair).confidence / 100;
    return Math.round((temperature * .32 + wind * .28 + gust * .25 + rain * .15) * 100);
  };
  const level = score => score >= 75 ? "fort" : score >= 50 ? "moyen" : "faible";
  const levelLabel = score => "Accord " + level(score);
  const opacity = (score, minimum = .2) => Math.max(minimum, minimum + (1 - minimum) * score / 100).toFixed(2);
  const agreementColor = (score, alpha) => {
    const ratio = Math.max(0, Math.min(1, score / 100));
    const red = Math.round(206 + (38 - 206) * ratio);
    const green = Math.round(76 + (255 - 76) * ratio);
    const blue = Math.round(66 + (104 - 66) * ratio);
    return 'rgba(' + red + ',' + green + ',' + blue + ',' + alpha + ')';
  };
  const stormSlots = hours.map((pair, index) => {
    const date = new Date(pair.meteoFrance.time);
    const sources = [
      Number(pair.openMeteo.weatherCode) >= 95 ? "Open-Meteo" : "",
      pair.meteoFrance.stormSignal ? "Météo-France" : ""
    ].filter(Boolean);
    const weeklyRisk = weekStormRisk(forecastDateKey(date));
    return {
      index,
      // À 48 h, un signal explicite à 3/5 doit rester visible : 3/5 est le
      // plancher normal d'une prévision proche ou encore sans historique.
      active: sources.length > 0 && weeklyRisk.level >= 3,
      detail: "Orage possible · " + sources.join(" · ") + " · " + forecastWeekdayLabel(date) + " " + forecastHourLabel(date) + " · risque semaine " + weeklyRisk.level + " sur 5"
    };
  });
  const hasStormMarkers = stormSlots.some(slot => slot.active);
  const temperatureValues = hours.map(pair => average(pair, "temperature"));
  const temperatureMin = Math.min(...hours.map(pair => Math.min(pair.meteoFrance.temperature, pair.openMeteo.temperature)));
  const temperatureMax = Math.max(...hours.map(pair => Math.max(pair.meteoFrance.temperature, pair.openMeteo.temperature)));
  const curveTop = hasStormMarkers ? 54 : 24;
  const curveBottom = 230;
  const temperaturePad = Math.max(1, (temperatureMax - temperatureMin) * .12);
  const temperatureY = value => curveBottom - (value - (temperatureMin - temperaturePad)) * (curveBottom - curveTop) / Math.max(1, temperatureMax - temperatureMin + temperaturePad * 2);
  const windDomain = hours.flatMap(pair => [pair.meteoFrance.windSpeed, pair.openMeteo.windSpeed, pair.meteoFrance.windGust, pair.openMeteo.windGust]);
  const windMin = Math.min(...windDomain);
  const windMax = Math.max(...windDomain);
  const windPad = Math.max(2, (windMax - windMin) * .12);
  const windY = value => curveBottom - (value - (windMin - windPad)) * (curveBottom - curveTop) / Math.max(1, windMax - windMin + windPad * 2);
  const points = (values, y) => values.map((value, index) => x(index) + "," + y(value)).join(" ");
  const uncertainty = (key, y, className) => hours.map((pair, index) => {
    const low = Math.min(pair.meteoFrance[key], pair.openMeteo[key]);
    const high = Math.max(pair.meteoFrance[key], pair.openMeteo[key]);
    return '<line class="comparison-range ' + className + '" x1="' + x(index) + '" x2="' + x(index) + '" y1="' + y(low) + '" y2="' + y(high) + '" style="opacity:' + opacity(agreement(pair), .16) + '"/>';
  }).join("");
  const temperatureSegments = hours.slice(0, -1).map((pair, index) => '<line class="comparison-temperature" x1="' + x(index) + '" y1="' + temperatureY(temperatureValues[index]) + '" x2="' + x(index + 1) + '" y2="' + temperatureY(temperatureValues[index + 1]) + '" style="opacity:' + opacity((agreement(pair) + agreement(hours[index + 1])) / 2) + '"/>').join("");
  const windValues = hours.map(pair => average(pair, "windSpeed"));
  const gustValues = hours.map(pair => average(pair, "windGust"));
  const windSegments = hours.slice(0, -1).map((pair, index) => '<line class="comparison-wind" x1="' + x(index) + '" y1="' + windY(windValues[index]) + '" x2="' + x(index + 1) + '" y2="' + windY(windValues[index + 1]) + '" style="opacity:' + opacity((agreement(pair) + agreement(hours[index + 1])) / 2) + '"/>').join("");
  const gustSegments = hours.slice(0, -1).map((pair, index) => '<line class="comparison-gust" x1="' + x(index) + '" y1="' + windY(gustValues[index]) + '" x2="' + x(index + 1) + '" y2="' + windY(gustValues[index + 1]) + '" style="opacity:' + opacity((agreement(pair) + agreement(hours[index + 1])) / 2) + '"/>').join("");
  const agreementWash = hours.map((pair, index) => '<rect class="comparison-agreement-wash" x="' + (index * cell) + '" y="0" width="' + cell + '" height="' + height + '" fill="' + agreementColor(agreement(pair), .17) + '"/>').join("");
  const rainBars = hours.map((pair, index) => {
    const scenario = rainScenario(pair);
    if (scenario.kind === "dry") return "";
    if (scenario.kind === "shower") {
      const probability = Math.round(Number(scenario.probabilityValue));
      const detail = 'Risque de pluie selon Open-Meteo\nProbabilité de précipitations : ' + probability + ' %\nCumul horaire : ' + pair.openMeteo.rain.toFixed(2) + ' mm';
      return '<g class="comparison-shower chart-point" tabindex="0" data-tooltip="' + escapeText(detail) + '"><rect x="' + (index * cell + 10) + '" y="278" width="' + (cell - 20) + '" height="16" rx="8"/><text x="' + x(index) + '" y="289" text-anchor="middle">Pluie · ' + probability + ' %</text></g>';
    }
    const amount = scenario.amount;
    const minimum = scenario.minimum;
    const maximum = scenario.maximum;
    const singleModelRain = scenario.kind === "single";
    const barHeight = Math.min(66, Math.max(6, Math.sqrt(Math.max(amount, .02)) * 35));
    const minHeight = Math.min(barHeight, Math.sqrt(Math.max(minimum, .01)) * 35);
    const maxHeight = Math.min(66, Math.max(barHeight, Math.sqrt(Math.max(maximum, .02)) * 35));
    const rainAgreement = scenario.confidence;
    const probability = scenario.probabilityValue;
    const probabilityLabel = Number.isFinite(probability) ? Math.round(probability) + ' %' : '—';
    const amountLabel = amount.toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' mm';
    const detail = 'Précipitations synthèse : ' + amount.toFixed(2) + ' mm'
      + (singleModelRain ? '\nUn seul modèle voit la pluie : cumul conservé, confiance réduite.' : '\nLes deux modèles voient de la pluie : cumul moyen.')
      + '\nMétéo-France (' + meteoFranceRainSource(pair.meteoFrance) + ') : ' + pair.meteoFrance.rain.toFixed(2) + ' mm'
      + '\nOpen-Meteo : ' + pair.openMeteo.rain.toFixed(2) + ' mm · probabilité ' + probabilityLabel
      + '\nConfiance pluie : ' + rainAgreement + ' %'
      + '\nPlage : ' + minimum.toFixed(2) + ' – ' + maximum.toFixed(2) + ' mm';
    const valueLabel = amount.toFixed(amount < 1 ? 1 : 0) + ' mm';
    const minimumLine = singleModelRain ? '' : '<line class="comparison-rain-min" x1="' + (index * cell + 18) + '" x2="' + (index * cell + cell - 18) + '" y1="' + (298 - minHeight) + '" y2="' + (298 - minHeight) + '" style="opacity:' + opacity(rainAgreement, .32) + '"/>';
    return '<g class="comparison-rain-group' + (singleModelRain ? ' comparison-rain-single' : '') + ' chart-point" tabindex="0" data-tooltip="' + escapeText(detail) + '"><rect class="comparison-rain-range" x="' + (index * cell + 17) + '" y="' + (298 - maxHeight) + '" width="' + (cell - 34) + '" height="' + maxHeight + '" style="opacity:' + opacity(rainAgreement, .24) + '"/><rect class="comparison-rain" x="' + (index * cell + 24) + '" y="' + (298 - barHeight) + '" width="' + (cell - 48) + '" height="' + barHeight + '" style="opacity:' + opacity(rainAgreement, .36) + '"/>' + minimumLine + '<text class="comparison-rain-value" x="' + x(index) + '" y="' + (294 - maxHeight) + '" text-anchor="middle">' + valueLabel + '</text></g>';
  }).join("");
  const comparisonTemperaturePoints = hours.map((pair, index) => {
    const mf = pair.meteoFrance;
    const om = pair.openMeteo;
    const detail = dateTimeFormat.format(new Date(mf.time)) + '\n\nMétéo-France\nTempérature : ' + mf.temperature.toFixed(1) + ' °C\nPrécipitations (' + meteoFranceRainSource(mf) + ') : ' + mf.rain.toFixed(2) + ' mm\nVent : ' + Math.round(mf.windSpeed) + ' km/h · rafales ' + Math.round(mf.windGust) + ' km/h\n\nOpen-Meteo\nTempérature : ' + om.temperature.toFixed(1) + ' °C\nPrécipitations : ' + om.rain.toFixed(2) + ' mm · probabilité ' + (Number.isFinite(Number(om.probability)) ? Math.round(om.probability) + ' %' : 'à confirmer') + '\nVent : ' + Math.round(om.windSpeed) + ' km/h · rafales ' + Math.round(om.windGust) + ' km/h\n\nAccord entre modèles : ' + agreement(pair) + ' %';
    return '<g class="comparison-data-point chart-point" tabindex="0" data-tooltip="' + escapeText(detail) + '"><circle class="temperature" cx="' + x(index) + '" cy="' + temperatureY(temperatureValues[index]) + '" r="4"/></g>';
  }).join("");
  const comparisonWindPoints = hours.map((pair, index) => {
    const detail = dateTimeFormat.format(new Date(pair.meteoFrance.time)) + '\nVent moyen : ' + Math.round(windValues[index]) + ' km/h\nRafales : ' + Math.round(gustValues[index]) + ' km/h';
    return '<g class="comparison-data-point chart-point" tabindex="0" data-tooltip="' + escapeText(detail) + '"><circle class="wind" cx="' + x(index) + '" cy="' + windY(windValues[index]) + '" r="3.5"/></g>';
  }).join("");
  const comparisonGustPoints = hours.map((pair, index) => {
    const detail = dateTimeFormat.format(new Date(pair.meteoFrance.time)) + '\nRafales : ' + Math.round(gustValues[index]) + ' km/h';
    return '<g class="comparison-data-point chart-point" tabindex="0" data-tooltip="' + escapeText(detail) + '"><circle class="gust" cx="' + x(index) + '" cy="' + windY(gustValues[index]) + '" r="3"/></g>';
  }).join("");
  const stormMarkers = stormSlots.filter(slot => slot.active).map(slot =>
    '<g class="comparison-storm-marker chart-point" transform="translate(' + (x(slot.index) - 12) + ' 7)" tabindex="0" role="img" aria-label="Orage possible" data-tooltip="' + escapeText(slot.detail) + '"><rect class="comparison-storm-hit" x="-4" y="-3" width="32" height="34" rx="7"/><path class="storm-signal-cloud" d="M4.8 15.5a3.7 3.7 0 0 1 .4-7.4A5.7 5.7 0 0 1 16.4 6.8a4 4 0 0 1 3.3 1.7 3.6 3.6 0 0 1 .7 7H4.8Z"/><path class="storm-signal-bolt" d="m13.2 10.4-3.8 6h3.2l-1.5 6.5 8-9.8h-3.5l1.7-2.7h-4.1Z"/></g>'
  ).join("");
  const headers = hours.map((pair, index) => {
    const item = pair.meteoFrance;
    const score = agreement(pair);
    const date = new Date(item.time);
    const detail = levelLabel(score) + ' (' + score + '%)\nTempérature : ' + item.temperature.toFixed(1) + ' / ' + pair.openMeteo.temperature.toFixed(1) + ' °C\nVent : ' + Math.round(item.windSpeed) + ' / ' + Math.round(pair.openMeteo.windSpeed) + ' km/h\n' + dateTimeFormat.format(date);
    return '<div class="comparison-hour chart-point" data-forecast-date="' + escapeText(forecastDateKey(date)) + '" data-forecast-hour="' + forecastHourValue(date) + '" tabindex="0" aria-label="' + escapeText(levelLabel(score) + ' : ' + score + ' %') + '" data-tooltip="' + escapeText(detail) + '" style="background:' + agreementColor(score, .17) + '"><div class="comparison-hour-content"><time><small>' + escapeText(forecastWeekdayLabel(date)) + '</small>' + escapeText(forecastHourLabel(date)) + '</time></div></div>';
  }).join("");
  $("forecast-controls").innerHTML = forecastSourceControlsMarkup();
  bindForecastControlButtons();
  overview.innerHTML = '<div class="overview-graph-layout">' + forecastMetricControlsMarkup() + '<section class="comparison-panel"><div class="overview-scroll"><div class="comparison-canvas" style="width:' + width + 'px"><div class="comparison-head">' + headers + '</div><svg class="comparison-chart" viewBox="0 0 ' + width + ' ' + height + '" aria-label="Synthèse de comparaison des prévisions sur 48 heures">' + agreementWash + '<g class="comparison-grid">' + hours.map((_, index) => '<line x1="' + (index * cell) + '" x2="' + (index * cell) + '" y1="0" y2="' + height + '"/>').join("") + '</g><g class="metric-layer metric-layer-temperature">' + uncertainty("temperature", temperatureY, "temperature") + temperatureSegments + comparisonTemperaturePoints + '</g><g class="metric-layer metric-layer-wind">' + uncertainty("windSpeed", windY, "wind") + windSegments + comparisonWindPoints + '</g><g class="metric-layer metric-layer-gust">' + uncertainty("windGust", windY, "gust") + gustSegments + comparisonGustPoints + '</g><g class="metric-layer metric-layer-rain"><line class="comparison-rain-baseline" x1="0" x2="' + width + '" y1="298" y2="298"/>' + rainBars + '</g><g class="comparison-storm-layer">' + stormMarkers + '</g></svg></div></div></section></div><div class="comparison-confidence-legend" aria-label="Légende de l’accord entre modèles"><span>Accord faible</span><i aria-hidden="true"></i><span>Accord fort</span></div>';
  bindForecastControlButtons();
  panels.innerHTML = "";
  document.querySelector(".forecast-section").style.setProperty("--overview-left-axis-width", "0px");
  document.querySelector(".forecast-section").style.setProperty("--overview-right-axis-width", "0px");
  bindChartTooltips();
  bindSharedHorizontalScroll(width);
}

function renderForecast(arome, pearome, ensemble, openMeteo) {
  const panels = $("forecast-panels");
  if (!arome || !arome.hours || !arome.hours.length) {
    panels.innerHTML = '<p class="forecast-empty">Actualisation des prévisions depuis le cache serveur…</p>';
    return;
  }
  // A forecast cycle can stay cached across midnight. Keep the current hour
  // only when PIAF/Nowcasting provides a short-term partial accumulation;
  // otherwise begin at the next full forecast hour.
  const currentHour = new Date(appNow());
  currentHour.setMinutes(0, 0, 0);
  const nextHour = new Date(currentHour);
  nextHour.setHours(nextHour.getHours() + 1);
  const hasCurrentShortTerm = arome.hours.some(item => item.rainShortTerm && new Date(item.time).getTime() === currentHour.getTime());
  const forecastStart = hasCurrentShortTerm ? currentHour : nextHour;
  const hours = arome.hours.filter(item => new Date(item.time) >= forecastStart);
  if (!hours.length) return;
  const probabilities = (pearome?.hours || hours).filter(item => Number.isFinite(item.probability)).map(item => ({ ...item, time: new Date(item.time).getTime(), durationHours: item.durationHours || (pearome ? 3 : 1) }));
  const probabilityPointForTime = time => {
    const match = probabilities.find(item => time >= item.time && time < item.time + item.durationHours * 3600000);
    return match || null;
  };
  const ensembleRangeFor = (metric, item) => {
    if (ensemble?.source === "openmeteo") {
      const itemTime = new Date(item.time).getTime();
      const anchor = ensemble.hours.find(candidate => new Date(candidate.time).getTime() === itemTime);
      // The displayed Open-Meteo rain comes from its best-match forecast,
      // while this ensemble is ICON EPS. Do not present one as the uncertainty
      // of the other.
      if (metric === "rain") return null;
      const spread = metric === "temperature" ? anchor?.temperatureSpread : metric === "wind" ? anchor?.windSpread : metric === "gust" ? anchor?.gustSpread : null;
      const value = metric === "temperature" ? item.temperature : metric === "wind" ? item.windSpeed : metric === "gust" ? item.windGust : null;
      if (!Number.isFinite(spread) || !Number.isFinite(value)) return null;
      const minimum = metric === "temperature" ? -Infinity : 0;
      return { low: Math.max(minimum, value - spread), high: value + spread };
    }
    const compatibleCycle = ensemble?.runTime && pearome?.runTime && ensemble.runTime === pearome.runTime;
    const anchors = compatibleCycle && ensemble.members === 25 ? ensemble.hours || [] : [];
    if (!anchors.length) return null;
    const itemTime = new Date(item.time).getTime();
    const before = [...anchors].reverse().find(anchor => new Date(anchor.time).getTime() <= itemTime) || anchors[0];
    const after = anchors.find(anchor => new Date(anchor.time).getTime() >= itemTime) || anchors.at(-1);
    const left = before[metric];
    const right = after[metric];
    if (!left || !right) return null;
    const beforeTime = new Date(before.time).getTime();
    const afterTime = new Date(after.time).getTime();
    const ratio = beforeTime === afterTime ? 0 : Math.max(0, Math.min(1, (itemTime - beforeTime) / (afterTime - beforeTime)));
    return { low: left.low + (right.low - left.low) * ratio, high: left.high + (right.high - left.high) * ratio };
  };
  const cell = 88;
  const width = hours.length * cell;
  const chartHeight = 210;
  const plotTop = 24;
  const plotBottom = 180;
  const x = index => index * cell + cell / 2;
  const timeHeadings = hours.map((item, index) => {
    const date = new Date(item.time);
    return '<div class="chart-hour"><span>' + escapeText(forecastWeekdayLabel(date)) + '</span><time>' + escapeText(forecastHourLabel(date)) + '</time></div>';
  }).join("");
  const overviewTemperature = hours.map(item => item.temperature);
  const overviewWind = hours.map(item => item.windSpeed);
  const overviewGust = hours.map(item => item.windGust);
  const overviewCloud = hours.map(cloudiness);
  const openMeteoByTime = new Map((openMeteo?.hours || []).map(item => [new Date(item.time).getTime(), item]));
  const openMeteoHours = hours.map(item => openMeteoByTime.get(new Date(item.time).getTime()) || null);
  const hasOpenMeteo = openMeteoHours.every(item => item && Number.isFinite(item.temperature) && Number.isFinite(item.windSpeed) && Number.isFinite(item.cloudiness));
  const openMeteoTemperature = hasOpenMeteo ? openMeteoHours.map(item => item.temperature) : [];
  const openMeteoWind = hasOpenMeteo ? openMeteoHours.map(item => item.windSpeed) : [];
  const openMeteoGust = hasOpenMeteo ? openMeteoHours.map(item => item.windGust) : [];
  const openMeteoCloud = hasOpenMeteo ? openMeteoHours.map(item => item.cloudiness) : [];
  const forecastModelLabel = activeForecastSource === "openmeteo" ? "Open-Meteo" : "Météo-France (AROME)";
  const uncertaintyLabel = activeForecastSource === "openmeteo" ? "Plage probable" : "Plage de probabilité 90 %";
  const metricTooltip = (label, value, format, item, interval = null) => [
    forecastModelLabel,
    label + " : " + format(value),
    interval?.pending ? uncertaintyLabel + " : calcul en cours (environ 1 minute)" : interval ? uncertaintyLabel + " : " + format(interval.low) + " – " + format(interval.high) : "",
    dateTimeFormat.format(new Date(item.time))
  ].filter(Boolean).join("\n");
  const showOpenMeteoData = false;
  const overviewHeight = 255;
  const overviewPlotTop = 24;
  const overviewPlotBottom = overviewHeight - 24;
  const overviewPlotRange = overviewPlotBottom - overviewPlotTop;
  const mapDomain = (minimum, maximum) => value => overviewPlotBottom - (value - minimum) * overviewPlotRange / Math.max(1, maximum - minimum);
  const boundsFor = (metric, values) => values.map((value, index) => ensembleRangeFor(metric, hours[index]) || { low: value, high: value });
  const temperatureBounds = boundsFor("temperature", overviewTemperature);
  const windBounds = boundsFor("wind", overviewWind);
  const gustBounds = boundsFor("gust", overviewGust);
  const cloudBounds = boundsFor("cloud", overviewCloud);
  const temperatureDataMin = Math.min(...temperatureBounds.map(bound => bound.low), ...(showOpenMeteoData ? openMeteoTemperature : []));
  const temperatureDataMax = Math.max(...temperatureBounds.map(bound => bound.high), ...(showOpenMeteoData ? openMeteoTemperature : []));
  const temperatureSpan = Math.max(1, temperatureDataMax - temperatureDataMin);
  const windDataMin = Math.min(...windBounds.map(bound => bound.low), ...gustBounds.map(bound => bound.low), ...(showOpenMeteoData ? openMeteoWind : []), ...(showOpenMeteoData ? openMeteoGust : []));
  const windDataMax = Math.max(...windBounds.map(bound => bound.high), ...gustBounds.map(bound => bound.high), ...(showOpenMeteoData ? openMeteoWind : []), ...(showOpenMeteoData ? openMeteoGust : []));
  const windMeanMin = Math.min(...windBounds.map(bound => bound.low), ...(showOpenMeteoData ? openMeteoWind : []));
  const windMeanMax = Math.max(...windBounds.map(bound => bound.high), ...(showOpenMeteoData ? openMeteoWind : []));
  const gustMin = Math.min(...gustBounds.map(bound => bound.low), ...(showOpenMeteoData ? openMeteoGust : []));
  const gustMax = Math.max(...gustBounds.map(bound => bound.high), ...(showOpenMeteoData ? openMeteoGust : []));
  const windDataSpan = Math.max(4, windDataMax - windDataMin);
  const windPadding = Math.max(2, windDataSpan * .12);
  const windFloorLimit = windDataMin > 0 ? Math.max(1, Math.floor(windDataMin * .4)) : 0;
  const windDomainMin = Math.max(windFloorLimit, Math.floor(windDataMin - windPadding));
  const windDomainMax = Math.max(windDomainMin + 4, Math.ceil(windDataMax + windPadding));
  const cloudDataMin = Math.min(...cloudBounds.map(bound => bound.low), ...(showOpenMeteoData ? openMeteoCloud : []));
  const cloudDataMax = Math.max(...cloudBounds.map(bound => bound.high), ...(showOpenMeteoData ? openMeteoCloud : []));
  const cloudDataSpan = Math.max(10, cloudDataMax - cloudDataMin);
  const cloudPadding = Math.max(5, cloudDataSpan * .15);
  const cloudFloorLimit = cloudDataMin > 0 ? Math.max(1, Math.floor(cloudDataMin * .4)) : 0;
  const cloudDomainMin = Math.max(cloudFloorLimit, Math.floor(cloudDataMin - cloudPadding));
  const cloudDomainMax = Math.min(100, Math.max(cloudDomainMin + 10, Math.ceil((cloudDataMax + cloudPadding) / 5) * 5));
  const cloudYForLayout = mapDomain(cloudDomainMin, cloudDomainMax);
  const mapToBand = (minimum, maximum, top, bottom) => value => bottom - (value - minimum) * (bottom - top) / Math.max(1, maximum - minimum);
  // Chaque métrique exploite toute la hauteur avec sa propre échelle. Leur
  // position verticale ne suggère donc plus une amplitude comparable.
  const curveBand = [overviewPlotTop, overviewPlotBottom];
  const temperaturePadding = Math.max(.6, temperatureSpan * .18);
  const overviewY = mapToBand(temperatureDataMin - temperaturePadding, temperatureDataMax + temperaturePadding, ...curveBand);
  const windY = mapToBand(windDomainMin, windDomainMax, ...curveBand);
  const gustY = windY;
  const cloudReferenceBottom = overviewPlotBottom;
  const cloudY = mapToBand(cloudDomainMin, cloudDomainMax, ...curveBand);
  const fullWidthPointArray = (values, y) => [
    "0," + y(values[0]),
    ...values.map((value, index) => x(index) + "," + y(value)),
    width + "," + y(values.at(-1))
  ];
  const fullWidthPoints = (values, y) => fullWidthPointArray(values, y).join(" ");
  const overviewPoints = fullWidthPoints(overviewTemperature, overviewY);
  const overviewUncertaintyBand = (metric, values, y, color) => {
    const intervals = values.map((_, index) => ensembleRangeFor(metric, hours[index]));
    if (intervals.some(interval => !interval)) return "";
    const lower = intervals.map(interval => interval.low);
    const upper = intervals.map(interval => interval.high);
    const area = fullWidthPointArray(upper, y).concat(fullWidthPointArray(lower, y).reverse()).join(" ");
    return '<polygon class="overview-uncertainty-fill" fill="' + color + '" points="' + area + '"/><polyline class="overview-uncertainty-edge" stroke="' + color + '" points="' + fullWidthPoints(upper, y) + '"/><polyline class="overview-uncertainty-edge" stroke="' + color + '" points="' + fullWidthPoints(lower, y) + '"/>';
  };
  const overviewLightDefs = hours.map((item, index) => {
    const date = new Date(item.time);
    const start = date.getTime();
    return '<linearGradient id="overview-light-' + index + '"><stop offset="0%" stop-color="' + daylightColor(start, date) + '"/><stop offset="100%" stop-color="' + daylightColor(start + 3600000, date) + '"/></linearGradient>';
  }).join("");
  const overviewLightRects = hours.map((_, index) => '<rect x="' + index * cell + '" y="0" width="' + cell + '" height="' + overviewHeight + '" fill="url(#overview-light-' + index + ')"/>').join("");
  const iconRainAmountFor = item => {
    if (item.rainSource) return Math.max(0, Number(item.rain) || 0);
    const probabilityPoint = probabilityPointForTime(new Date(item.time).getTime());
    if (pearome && Number.isFinite(Number(probabilityPoint?.ensembleMean))) {
      // Le volume bleu est un cumul moyen sur la fenêtre PEAROME (souvent
      // trois heures). Le pictogramme horaire représente donc ce cumul ramené
      // à une heure, et non la sortie déterministe AROME potentiellement très
      // éloignée de la quantité effectivement affichée.
      return Math.max(0, Number(probabilityPoint.ensembleMean)) / Math.max(1, Number(probabilityPoint.durationHours) || 3);
    }
    return Math.max(0, Number(item.rain) || 0);
  };
  const overviewHeaders = hours.map((item, index) => {
    const date = new Date(item.time);
    const cloud = cloudiness(item);
    const iconRain = iconRainAmountFor(item);
    const stormActive = activeForecastSource === "openmeteo" ? Number(item.weatherCode) >= 95 : Boolean(item.stormSignal);
    const stormSourceLabel = activeForecastSource === "openmeteo" ? "Open-Meteo" : "Météo-France";
    const stormMarkup = stormActive ? forecastStormPictogram(stormSourceLabel, item, forecastWeekdayLabel(date) + " " + forecastHourLabel(date), "overview-storm-source") : "";
    const iconClass = "weather-icon" + (isNight(date) ? " night-icon" : " day-icon") + (iconRain >= measurableRainThreshold ? " precipitation-icon" : "");
    const headerWind = '<div class="wind"><span class="wind-arrow" style="transform:rotate(' + item.windDirection + 'deg)">↑</span> ' + item.windSpeed + ' km/h</div><div class="gust">' + (item.windGust > item.windSpeed + 8 ? item.windGust + ' km/h' : '&nbsp;') + '</div>';
    const eclipsePeakSlot = isEclipsePeakSlot(date);
    const pictogram = eclipsePeakSlot ? '<svg class="timeline-eclipse-icon" viewBox="0 0 48 48" role="img" aria-label="Éclipse solaire partielle à 94,7 %"><circle class="eclipse-sun" cx="24" cy="24" r="14"/><circle class="eclipse-moon" cx="22.6" cy="25.4" r="14.25"/></svg>' : displayIcon({ ...item, rain: iconRain });
    return '<div class="overview-hour' + (stormActive ? ' storm-signal-hour' : '') + '" style="' + daylightStyle(date) + '"><div class="overview-weather-pictograms"><div class="' + iconClass + (eclipsePeakSlot ? ' eclipse-weather-icon' : '') + '" title="' + (eclipsePeakSlot ? 'Éclipse solaire · maximum vers 20 h 23' : cloud + '% de nébulosité · ' + iconRain.toFixed(2) + ' mm/h moyen') + '">' + pictogram + '</div>' + stormMarkup + '</div>' + headerWind + '</div>';
  }).join("");
  const overviewXAxis = hours.map((item, index) => {
    const date = new Date(item.time);
    return '<div class="overview-x-hour" data-forecast-date="' + escapeText(forecastDateKey(date)) + '" data-forecast-hour="' + forecastHourValue(date) + '" style="' + daylightStyle(date, true) + '"><span>' + escapeText(forecastWeekdayLabel(date)) + '</span><time>' + escapeText(forecastHourLabel(date)) + '</time></div>';
  }).join("");
  const probabilityDisplayIndexes = new Map(probabilities.map(point => {
    const indexes = hours.map((item, index) => ({ index, time: new Date(item.time).getTime() }))
      .filter(item => item.time >= point.time && item.time < point.time + point.durationHours * 3600000)
      .map(item => item.index);
    return [point.time, indexes.length ? indexes[Math.floor(indexes.length / 2)] : -1];
  }));
  const overviewRain = hours.map((item, index) => {
    const probabilityPoint = probabilityPointForTime(new Date(item.time).getTime());
    const isShortTermHour = Boolean(item.rainShortTerm);
    const hasProbability = !isShortTermHour && Number.isFinite(probabilityPoint?.probability);
    const probability = hasProbability ? Number(probabilityPoint.probability) : null;
    const usePearomePeriod = pearome && hasProbability && !item.rainSource;
    const periodIndexes = usePearomePeriod ? hours.map((hour, hourIndex) => ({ hourIndex, time: new Date(hour.time).getTime() }))
      .filter(hour => hour.time >= probabilityPoint.time && hour.time < probabilityPoint.time + probabilityPoint.durationHours * 3600000).map(hour => hour.hourIndex) : [index];
    const showPeriod = usePearomePeriod && probabilityDisplayIndexes.get(probabilityPoint.time) === index;
    const aromeAmount = showPeriod ? periodIndexes.reduce((total, hourIndex) => total + Number(hours[hourIndex].rain || 0), 0) : Number(item.rain || 0);
    // In a PEAROME period, use the ensemble mean for the bar: it is expressed
    // over the same window and in the same unit as P10–P90.
    const displayedAmount = usePearomePeriod ? Number(probabilityPoint.ensembleMean || 0) : aromeAmount;
    const measurable = displayedAmount >= measurableRainThreshold;
    const rainTrace = displayedAmount >= possibleDrizzleThreshold;
    const drops = displayedAmount > 0 && displayedAmount <= .2;
    const showProbability = hasProbability && probability > 0 && (usePearomePeriod ? showPeriod : probabilityDisplayIndexes.get(probabilityPoint.time) === index);
    const probabilisticAverse = showProbability && probability >= rainRiskDisplayThreshold && !measurable;
    const height = selectedMetrics.has("rain") && rainTrace ? (measurable ? Math.min(112, Math.max(7, Math.sqrt(displayedAmount) * 35)) : 4) : 0;
    const interval = isShortTermHour || ensemble?.source === "openmeteo" ? null : probabilityPoint?.interval;
    const intervalLabel = "Plage ensemble PEAROME (P10–P90)";
    const durationHours = usePearomePeriod ? probabilityPoint.durationHours : 1;
    const rainDurationMinutes = Number(item.rainDurationMinutes);
    const durationLabel = Number.isFinite(rainDurationMinutes) && rainDurationMinutes < 60
      ? rainDurationMinutes + " min"
      : durationHours + " h";
    const intervalPeriod = item.rainIntervalStart && item.rainIntervalEnd
      ? '\nPériode : ' + hourFormat.format(new Date(item.rainIntervalStart)) + '–' + hourFormat.format(new Date(item.rainIntervalEnd))
      : '';
    const shortTermPassage = Number(item.rainEtaPassage);
    const shortTermDetail = isShortTermHour
      ? '\nMétéo-France : ' + Number(item.rainBasePiaf || 0).toFixed(2) + ' mm'
        + (Number(item.rainDirectRadarAmendment) > 0 ? '\nRadar aux Tatins : +' + Number(item.rainDirectRadarAmendment).toFixed(2) + ' mm' : '')
        + (Number(item.rainEtaAmendment) > 0 ? '\nCellule(s) ETA si passage : +' + Number(item.rainEtaAmendment).toFixed(2) + ' mm' : '')
        + (Number.isFinite(shortTermPassage) && shortTermPassage < 100 ? '\nPassage Nowcasting : ' + Math.round(shortTermPassage) + ' %' : '')
        + ((item.rainEtaCellIds || []).length ? '\nCellule(s) avec ETA : ' + item.rainEtaCellIds.join(', ') : '')
      : '';
    const detail = (item.rainSource || forecastModelLabel) + '\nCumul : ' + displayedAmount.toFixed(2) + ' mm (' + durationLabel + ')' + shortTermDetail + intervalPeriod + (item.rainRadarCellOverPoint ? '\nPluie détectée aux Tatins par le radar' : '') + (usePearomePeriod ? '\nRéférence AROME : ' + aromeAmount.toFixed(2) + ' mm' : '') + (hasProbability ? '\nProbabilité : ' + probability + '%' : '') + (interval ? '\n' + intervalLabel + ' : ' + interval.low.toFixed(2) + ' – ' + interval.high.toFixed(2) + ' mm sur ' + durationHours + ' h' : '') + '\nÉchéance : ' + dateTimeFormat.format(new Date(item.time));
    const precipitationLabel = drops ? 'gouttes' : measurable ? displayedAmount.toFixed(isShortTermHour ? 2 : 1) + ' mm' : (!pearome && probability >= rainRiskDisplayThreshold ? 'pluie' : '');
    const intervalAmountLabel = interval && measurable && !drops ? '(' + interval.low.toFixed(1) + '–' + interval.high.toFixed(1) + ' mm)' : '';
    const centerX = usePearomePeriod ? (periodIndexes[0] * cell + (periodIndexes.length * cell) / 2) : x(index);
    const chanceLabel = 'Pluie ' + probability + ' %';
    const chanceWidth = Math.min(cell - 12, Math.max(58, chanceLabel.length * 5.3 + 12));
    const chanceX = x(index) - chanceWidth / 2;
    const rainHeight = value => Math.min(112, Math.sqrt(Math.max(0, value)) * 35);
    const quantifiedInterval = (usePearomePeriod ? showPeriod : true) && interval && interval.high > interval.low && !drops ? interval : null;
    const barStart = usePearomePeriod ? periodIndexes[0] * cell + 10 : index * cell + 10;
    const barWidth = usePearomePeriod ? periodIndexes.length * cell - 20 : cell - 20;
    const uncertaintyPositions = usePearomePeriod ? [barStart, barStart + barWidth] : [centerX];
    const uncertainty = quantifiedInterval ? uncertaintyPositions.map(position => '<path class="overview-rain-error" d="M' + position + ' ' + (overviewHeight - rainHeight(quantifiedInterval.high)) + 'V' + (overviewHeight - rainHeight(quantifiedInterval.low)) + 'M' + (position - 6) + ' ' + (overviewHeight - rainHeight(quantifiedInterval.high)) + 'H' + (position + 6) + 'M' + (position - 6) + ' ' + (overviewHeight - rainHeight(quantifiedInterval.low)) + 'H' + (position + 6) + '"/>').join('') : '';
    const drawBar = usePearomePeriod ? showPeriod : true;
    const nowcastAmendment = isShortTermHour ? Math.min(displayedAmount, Math.max(0, Number(item.rainNowcastAmendment) || 0)) : 0;
    const nowcastBaseHeight = rainHeight(Math.max(0, displayedAmount - nowcastAmendment));
    const nowcastBandHeight = nowcastAmendment > 0 ? Math.max(3, height - nowcastBaseHeight) : 0;
    const nowcastBand = drawBar && nowcastBandHeight > 0
      ? '<rect class="overview-rain-nowcast-band" x="' + barStart + '" y="' + (overviewHeight - height) + '" width="' + barWidth + '" height="' + nowcastBandHeight + '"/>'
      : '';
    const nowcastPassage = isShortTermHour && Number.isFinite(Number(item.rainEtaPassage)) ? Math.round(Number(item.rainEtaPassage)) : null;
    const nowcastPassageLabel = drawBar && nowcastBandHeight > 0 && nowcastPassage != null && nowcastPassage < 100
      ? '<text class="overview-rain-nowcast-probability" x="' + centerX + '" y="' + Math.max(12, overviewHeight - height - 5) + '" text-anchor="middle">' + nowcastPassage + ' %</text>'
      : '';
    // La probabilité décrit le volume affiché : elle reste dans la zone bleue,
    // juste au-dessus du cumul, sans suivre la borne haute d'incertitude.
    const probabilityLabelY = overviewHeight - (intervalAmountLabel ? 38 : 22);
    const probabilityLabel = showProbability && selectedMetrics.has("rain") ? '<text class="overview-rain-label overview-rain-probability-label" x="' + centerX + '" y="' + probabilityLabelY + '" text-anchor="middle">' + probability + ' %</text>' : '';
    const amountLabel = intervalAmountLabel
      ? '<text class="overview-rain-amount-label" x="' + centerX + '" y="' + (overviewHeight - 17) + '" text-anchor="middle"><tspan class="overview-rain-amount-value" x="' + centerX + '">' + escapeText(precipitationLabel) + '</tspan><tspan class="overview-rain-amount-range" x="' + centerX + '" dy="12">' + escapeText(intervalAmountLabel) + '</tspan></text>'
      : '<text class="overview-rain-amount-label" x="' + centerX + '" y="' + (overviewHeight - 5) + '" text-anchor="middle">' + escapeText(precipitationLabel) + '</text>';
    const marker = drawBar && rainTrace ? '<rect class="overview-rain-bar wet" x="' + barStart + '" y="' + (overviewHeight - height) + '" width="' + barWidth + '" height="' + height + '"/>' + nowcastBand + nowcastPassageLabel + uncertainty + probabilityLabel + amountLabel : (probabilisticAverse ? '<rect class="overview-rain-chance" x="' + chanceX + '" y="' + (overviewHeight - 24) + '" width="' + chanceWidth + '" height="18" rx="9"/><text class="overview-rain-chance-label" x="' + x(index) + '" y="' + (overviewHeight - 15) + '" text-anchor="middle" dominant-baseline="middle">' + escapeText(chanceLabel) + '</text>' : '');
    return marker ? '<g class="overview-rain-svg' + (probabilisticAverse ? ' overview-rain-chance-group' : '') + ' chart-point" tabindex="0" data-rain-index="' + index + '" data-tooltip="' + escapeText(detail) + '">' + marker + '</g>' : '';
  }).join("");
  const overviewDataPoints = hours.map((item, index) => {
    const points = [];
    if (selectedMetrics.has("temperature")) points.push('<g class="overview-data-point chart-point metric-layer metric-layer-temperature" tabindex="0" data-tooltip="' + escapeText(metricTooltip("Température", overviewTemperature[index], value => Math.round(value) + " °C", item, ensembleRangeFor("temperature", item) || { pending: true })) + '"><circle class="temperature" cx="' + x(index) + '" cy="' + overviewY(overviewTemperature[index]) + '" r="4"/></g>');
    if (selectedMetrics.has("wind")) {
      points.push('<g class="overview-data-point chart-point metric-layer metric-layer-wind" tabindex="0" data-tooltip="' + escapeText(metricTooltip("Vent", overviewWind[index], value => Math.round(value) + " km/h", item, ensembleRangeFor("wind", item) || { pending: true })) + '"><circle class="wind" cx="' + x(index) + '" cy="' + windY(overviewWind[index]) + '" r="3.5"/></g>');
    }
    if (selectedMetrics.has("gust")) points.push('<g class="overview-data-point chart-point metric-layer metric-layer-gust" tabindex="0" data-tooltip="' + escapeText(metricTooltip("Rafales", overviewGust[index], value => Math.round(value) + " km/h", item, ensembleRangeFor("gust", item) || { pending: true })) + '"><circle class="gust" cx="' + x(index) + '" cy="' + gustY(overviewGust[index]) + '" r="3"/></g>');
    return points.join("");
  }).join("");
  const temperatureMarkup = selectedMetrics.has("temperature") ? '<g class="metric-layer metric-layer-temperature">' + overviewUncertaintyBand("temperature", overviewTemperature, overviewY, "#ef5b2a") + '<polyline class="temperature-line" points="' + overviewPoints + '"/>' + (showOpenMeteoData ? '<polyline class="open-meteo-line temperature" points="' + fullWidthPoints(openMeteoTemperature, overviewY) + '"/>' : '') + overviewTemperature.map((value, index) => '<text x="' + x(index) + '" y="' + (overviewY(value) - 9) + '" text-anchor="middle" style="fill:' + forecastTextColor(new Date(hours[index].time)) + '">' + Math.round(value) + '°</text>').join("") + '</g>' : "";
  const windMarkup = selectedMetrics.has("wind") ? '<g class="metric-layer metric-layer-wind">' + overviewUncertaintyBand("wind", overviewWind, windY, "#16805f") + '<polyline class="wind-line" points="' + fullWidthPoints(overviewWind, windY) + '"/>' + (showOpenMeteoData ? '<polyline class="open-meteo-line wind" points="' + fullWidthPoints(openMeteoWind, windY) + '"/>' : '') + '</g>' : "";
  const gustMarkup = selectedMetrics.has("gust") ? '<g class="metric-layer metric-layer-gust">' + (ensemble?.source === "openmeteo" ? overviewUncertaintyBand("gust", overviewGust, gustY, "#8050b5") : "") + '<polyline class="gust-line" points="' + fullWidthPoints(overviewGust, gustY) + '"/>' + (showOpenMeteoData ? '<polyline class="open-meteo-line gust" points="' + fullWidthPoints(openMeteoGust, gustY) + '"/>' : '') + '</g>' : "";
  const cloudCoverArea = ['0,' + cloudReferenceBottom, ...fullWidthPointArray(overviewCloud, cloudY), width + ',' + cloudReferenceBottom].join(' ');
  const cloudMarkup = selectedMetrics.has("cloudiness") ? '<g class="metric-layer metric-layer-cloudiness"><polygon class="cloud-cover-overlay" points="' + cloudCoverArea + '"/></g>' : "";
  const forecastSection = document.querySelector(".forecast-section");
  forecastSection.style.setProperty("--overview-left-axis-width", "0px");
  forecastSection.style.setProperty("--overview-right-axis-width", "0px");
  const extremaLabels = curve => '<span class="sticky-curve-label ' + curve + '-label" data-curve="' + curve + '" data-extreme="min"></span><span class="sticky-curve-label ' + curve + '-label" data-curve="' + curve + '" data-extreme="max"></span>';
  const curveNames = (selectedMetrics.has("wind") ? '<span class="sticky-curve-name wind-average-label" data-curve="wind-average">Vent moyen</span>' : '') + (selectedMetrics.has("gust") ? '<span class="sticky-curve-name wind-gust-label" data-curve="wind-gust">Rafales</span>' : '');
  const curveLabels = curveNames + (selectedMetrics.has("wind") ? extremaLabels("wind-average") : '') + (selectedMetrics.has("gust") ? extremaLabels("wind-gust") : '');
  const comparisonLegend = showOpenMeteoData ? '<div class="overview-comparison-legend"><span><i class="meteo-france-swatch"></i>Météo-France</span><span><i class="open-meteo-swatch"></i>Open-Meteo</span></div>' : '';
  const timelineStart = new Date(hours[0].time).getTime();
  const timelineEnd = new Date(hours.at(-1).time).getTime() + 3600000;
  const eclipseOverlay = eclipseOverlayMarkup(timelineStart, timelineEnd, width);
  $("forecast-overview").innerHTML = comparisonLegend
    + '<div class="overview-graph-layout">' + forecastMetricControlsMarkup()
    + '<section class="overview-panel"><div class="overview-scroll"><div class="overview-curve-labels" aria-hidden="true">' + curveLabels + '</div><div class="overview-canvas" style="width:' + width + 'px"><div class="overview-x-axis" aria-label="Heures des prévisions">' + overviewXAxis + '</div><div class="overview-head">' + overviewHeaders + '</div><svg class="overview-temperature" viewBox="0 0 ' + width + ' ' + overviewHeight + '" aria-label="Prévisions sélectionnées"><defs>' + overviewLightDefs + '<pattern id="overview-nowcast-rain-stripes" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="7" fill="#e99512"/></pattern></defs>' + overviewLightRects + cloudMarkup + '<g class="metric-layer metric-layer-rain">' + overviewRain + '</g>' + temperatureMarkup + windMarkup + gustMarkup + overviewDataPoints + '</svg>' + eclipseOverlay + '</div></div></section></div>';
  const labelSeries = {
    "wind-average": { values: overviewWind, y: windY, format: value => Math.round(value) + " km/h" },
    "wind-gust": { values: overviewGust, y: gustY, format: value => Math.round(value) + " km/h" },
    cloud: { values: overviewCloud, y: cloudY, format: value => Math.round(value) + " %" }
  };
  const updateCurveLabels = scrollLeft => {
    const scroll = $("forecast-overview").querySelector(".overview-scroll");
    const names = [...document.querySelectorAll(".sticky-curve-name")];
    const labels = [...document.querySelectorAll(".sticky-curve-label")];
    const labelAreaWidth = Math.max(120, scroll.clientWidth);
    const nameEntries = names.map((label, index) => {
      const series = labelSeries[label.dataset.curve];
      const preferredLeft = 12 + index * 80;
      const graphX = Math.max(cell / 2, Math.min(width - cell / 2, scrollLeft + preferredLeft));
      const position = Math.max(0, Math.min(hours.length - 1, (graphX - cell / 2) / cell));
      const leftIndex = Math.floor(position);
      const rightIndex = Math.min(hours.length - 1, leftIndex + 1);
      const ratio = position - leftIndex;
      const currentY = series.y(series.values[leftIndex] + (series.values[rightIndex] - series.values[leftIndex]) * ratio);
      const curveOffset = label.dataset.curve === "wind-average" ? metricOffsets.wind : label.dataset.curve === "wind-gust" ? metricOffsets.gust : metricOffsets[label.dataset.curve] || 0;
      return {
        label,
        left: Math.max(4, Math.min(preferredLeft, labelAreaWidth - label.offsetWidth - 4)),
        top: 112 + currentY + curveOffset - 17,
        width: label.offsetWidth,
        height: label.offsetHeight
      };
    });
    nameEntries.forEach(entry => {
      entry.top = Math.min(112 + overviewHeight - entry.height - 4, Math.max(112 + 4, entry.top));
      entry.label.style.left = entry.left + "px";
      entry.label.style.top = entry.top + "px";
      entry.label.style.transform = "none";
    });
    const firstVisible = Math.max(0, Math.floor(scrollLeft / cell));
    const lastVisible = Math.min(hours.length - 1, Math.ceil((scrollLeft + scroll.clientWidth) / cell));
    const temperatureEntries = selectedMetrics.has("temperature") ? Array.from({ length: lastVisible - firstVisible + 1 }, (_, offset) => {
      const index = firstVisible + offset;
      return {
        left: x(index) - scrollLeft - 18,
        top: 112 + overviewY(overviewTemperature[index]) + metricOffsets.temperature - 23,
        width: 36,
        height: 18
      };
    }) : [];
    const extremaEntries = labels.map(label => {
      const series = labelSeries[label.dataset.curve];
      const visibleIndexes = Array.from({ length: lastVisible - firstVisible + 1 }, (_, offset) => firstVisible + offset);
      const extremeIndex = visibleIndexes.reduce((best, index) => label.dataset.extreme === "min" ? (series.values[index] < series.values[best] ? index : best) : (series.values[index] > series.values[best] ? index : best), firstVisible);
      const pairedExtreme = label.dataset.extreme === "min" ? "max" : "min";
      const paired = labels.find(candidate => candidate.dataset.curve === label.dataset.curve && candidate.dataset.extreme === pairedExtreme);
      if (paired && extremeIndex === firstVisible && series.values[firstVisible] === series.values[lastVisible] && label.dataset.extreme === "max") {
        label.hidden = true;
        return null;
      }
      label.hidden = false;
      label.textContent = series.format(series.values[extremeIndex]);
      const pointLeft = extremeIndex * cell + cell / 2 - scrollLeft;
      const left = Math.max(4, Math.min(pointLeft - label.offsetWidth / 2, labelAreaWidth - label.offsetWidth - 4));
      const curveOffset = label.dataset.curve === "wind-average" ? metricOffsets.wind : label.dataset.curve === "wind-gust" ? metricOffsets.gust : metricOffsets[label.dataset.curve] || 0;
      return { label, kind: "extreme", left, top: 112 + series.y(series.values[extremeIndex]) + curveOffset - 18, width: label.offsetWidth, height: label.offsetHeight };
    }).filter(Boolean);
    const rainEntries = [...$("forecast-overview").querySelectorAll(".overview-rain-label, .overview-rain-chance-label")].map(text => {
      const box = text.getBBox();
      const baseTop = 112 + box.y;
      return {
        text,
        left: box.x - scrollLeft,
        top: baseTop,
        baseTop,
        anchorTop: 112 + Number(text.getAttribute("y")),
        fixedInRainArea: text.classList.contains("overview-rain-probability-label"),
        width: box.width,
        height: box.height
      };
    }).filter(entry => entry.left + entry.width >= 0 && entry.left <= labelAreaWidth);
    const annotationGap = 10;
    const topLimit = 112 + 4;
    const bottomLimit = 112 + overviewHeight - 4;
    const overlaps = (entry, previous) => entry.left < previous.left + previous.width + annotationGap && previous.left < entry.left + entry.width + annotationGap && entry.top < previous.top + previous.height + annotationGap && previous.top < entry.top + entry.height + annotationGap;
    // Rain labels share the SVG with temperature labels. Move a label when a
    // small bar would otherwise place it directly over a temperature value.
    rainEntries.sort((a, b) => a.left - b.left);
    rainEntries.forEach((entry, index) => {
      if (entry.fixedInRainArea) {
        entry.top = entry.baseTop;
        return;
      }
      const candidates = [0, 16, -16, 32, -32, 48, -48].map(offset => Math.min(bottomLimit - entry.height, Math.max(topLimit, entry.baseTop + offset)));
      const occupied = nameEntries.concat(temperatureEntries, rainEntries.slice(0, index));
      entry.top = candidates.find(top => !occupied.some(previous => overlaps({ ...entry, top }, previous))) ?? candidates.at(-1);
    });
    extremaEntries.sort((a, b) => a.top - b.top);
    extremaEntries.forEach((entry, index) => {
      const pointTop = entry.top + 18;
      const candidates = [-18, 8, -38, 28, -58, 48, -78, 68].map(offset => Math.min(bottomLimit - entry.height, Math.max(topLimit, pointTop + offset)));
      const occupied = nameEntries.concat(temperatureEntries, rainEntries, extremaEntries.slice(0, index));
      entry.top = candidates.find(top => !occupied.some(previous => overlaps({ ...entry, top }, previous))) ?? candidates.at(-1);
    });
    const entries = extremaEntries.concat(rainEntries);
    entries.forEach(entry => {
      if (entry.label) {
        entry.label.style.left = entry.left + "px";
        entry.label.style.top = entry.top + "px";
        entry.label.style.transform = "none";
      } else {
        entry.text.setAttribute("transform", "translate(0 " + Math.round(entry.top - entry.baseTop) + ")");
      }
    });
  };
  forecastSection._updateMetricLabels = () => {
    const scroll = $("forecast-overview").querySelector(".overview-scroll");
    if (scroll) updateCurveLabels(scroll.scrollLeft);
  };
  const chart = ({ key, label, values, format, intervalFor, confidenceFor, secondary, kind = "line", hideAxisLabels = false }) => {
    const intervals = values.map((value, index) => intervalFor(value, hours[index]) || { low: value, high: value, pending: true });
    const uncertainty = intervals.map((interval, index) => Math.max(values[index] - interval.low, interval.high - values[index]));
    const series = (secondary ? values.concat(secondary.values) : values).concat(values.map((value, index) => value - uncertainty[index]), values.map((value, index) => value + uncertainty[index]));
    const min = Math.min(0, ...series);
    const max = Math.max(1, ...series);
    const pad = Math.max(1, (max - min) * .12);
    const floor = Math.max(0, min - pad);
    const ceiling = max + pad;
    const y = value => plotBottom - (value - floor) * (plotBottom - plotTop) / (ceiling - floor);
    const gridValues = Array.from({ length: 4 }, (_, index) => {
      const value = floor + (ceiling - floor) * index / 3;
      const yy = y(value);
      return { value, yy };
    });
    const grid = gridValues.map(({ yy }) => '<line x1="0" y1="' + yy + '" x2="' + width + '" y2="' + yy + '"/>').join("");
    const axis = hideAxisLabels ? "" : gridValues.map(({ value, yy }) => '<text x="48" y="' + (yy + 4) + '" text-anchor="end">' + format(value, true) + '</text>').join("");
    const curve = values.map((value, index) => x(index) + "," + y(value)).join(" ");
    const endCurve = "0," + y(values[0]) + " " + curve + " " + width + "," + y(values.at(-1));
    const dots = values.map((value, index) => {
      const item = hours[index];
      const interval = intervals[index];
      const detail = metricTooltip(label, value, format, item, interval);
      const top = y(interval.high);
      const bottom = y(Math.max(0, interval.low));
      return '<g class="chart-point" tabindex="0" data-tooltip="' + escapeText(detail) + '"><path class="uncertainty-bar" d="M' + x(index) + ' ' + top + 'V' + bottom + 'M' + (x(index) - 5) + ' ' + top + 'H' + (x(index) + 5) + 'M' + (x(index) - 5) + ' ' + bottom + 'H' + (x(index) + 5) + '"/><circle cx="' + x(index) + '" cy="' + y(value) + '" r="5"/></g>';
    }).join("");
    const secondaryCurve = secondary ? '<polyline class="series-secondary" points="' + secondary.values.map((value, index) => x(index) + "," + y(value)).join(" ") + '"/>' : "";
    const secondaryDots = secondary ? secondary.values.map((value, index) => {
      const item = hours[index];
      const detail = metricTooltip(secondary.label, value, secondary.format, item);
      return '<g class="chart-point secondary-point" tabindex="0" data-tooltip="' + escapeText(detail) + '"><circle cx="' + x(index) + '" cy="' + y(value) + '" r="4"/></g>';
    }).join("") : "";
    const bars = kind === "bars" ? values.map((value, index) => '<rect class="precipitation-bar" x="' + (index * cell + 12) + '" y="' + y(value) + '" width="' + (cell - 24) + '" height="' + (plotBottom - y(value)) + '"/>').join("") : "";
    return '<section class="metric-panel ' + key + '"><div class="metric-title"><strong>' + label + '</strong></div><div class="chart-body"><div class="chart-axis" aria-hidden="true"><div class="chart-axis-head"></div><svg viewBox="0 0 54 ' + chartHeight + '">' + axis + '</svg></div><div class="chart-scroll"><div class="chart-wrap" style="width:' + width + 'px"><div class="chart-hours">' + timeHeadings + '</div><svg class="metric-chart ' + key + '" viewBox="0 0 ' + width + ' ' + chartHeight + '" aria-label="' + label + '"><g class="chart-grid">' + grid + '</g>' + bars + (kind === "bars" ? "" : '<polyline class="series-main" points="' + endCurve + '"/>') + secondaryCurve + '<g class="chart-dots">' + dots + secondaryDots + '</g></svg></div></div></div></section>';
  };
  const temperature = hours.map(item => item.temperature);
  const wind = hours.map(item => item.windSpeed);
  const gust = hours.map(item => item.windGust);
  const clouds = hours.map(cloudiness);
  const rainRisk = hours.map(item => probabilityPointForTime(new Date(item.time).getTime())?.probability || 0);
  const score = scale => (value, interval) => Math.max(0, Math.min(100, Math.round(100 - (interval.high - interval.low) * scale)));
  const metrics = [
    { key: "temperature", label: "Température", values: temperature, format: value => Math.round(value) + " °C", intervalFor: (_, item) => ensembleRangeFor("temperature", item), confidenceFor: score(12) },
    { key: "wind", label: "Vent", values: wind, format: value => Math.round(value) + " km/h", intervalFor: (_, item) => ensembleRangeFor("wind", item), confidenceFor: score(4), secondary: { label: "Rafales", values: gust, format: value => Math.round(value) + " km/h" } },
    { key: "cloudiness", label: "Nébulosité", values: clouds, format: value => Math.round(value) + " %", intervalFor: (_, item) => ensembleRangeFor("cloud", item), confidenceFor: score(.8), hideAxisLabels: true },
    { key: "rain", label: "Précipitations", values: rainRisk, format: value => Math.round(value) + " %", intervalFor: (_, item) => {
      const point = probabilityPointForTime(new Date(item.time).getTime());
      return point?.interval || null;
    }, confidenceFor: score(1), kind: "bars", hideAxisLabels: true }
  ];
  $("forecast-controls").innerHTML = forecastSourceControlsMarkup();
  const selected = metrics.filter(metric => selectedMetrics.has(metric.key));
  const unifiedHeight = 250;
  const top = 20;
  const bottom = 226;
  const colors = { temperature: "#ef5b2a", wind: "#16805f", gust: "#8050b5", cloudiness: "#77848e", rain: "#258bc0" };
  const graph = selected.map(metric => {
    const intervals = metric.values.map((value, index) => metric.intervalFor(value, hours[index]) || { low: value, high: value, pending: true });
    const domain = metric.values.concat(intervals.flatMap(interval => [interval.low, interval.high]), metric.secondary?.values || []);
    const low = Math.min(...domain);
    const high = Math.max(...domain);
    const pad = Math.max(1, (high - low) * .12);
    const y = value => bottom - (value - (low - pad)) * (bottom - top) / Math.max(1, high - low + pad * 2);
    const tooltip = (label, value, index, interval) => {
      const item = hours[index];
      return metricTooltip(label, value, metric.format, item, interval);
    };
    const points = metric.values.map((value, index) => {
      const interval = intervals[index];
      const detail = tooltip(metric.label, value, index, interval);
      const error = metric.key === "rain" ? "" : '<path class="unified-error" stroke="' + colors[metric.key] + '" d="M' + x(index) + ' ' + y(interval.high) + 'V' + y(interval.low) + 'M' + (x(index) - 4) + ' ' + y(interval.high) + 'H' + (x(index) + 4) + 'M' + (x(index) - 4) + ' ' + y(interval.low) + 'H' + (x(index) + 4) + '"/>';
      return '<g class="chart-point" tabindex="0" data-tooltip="' + escapeText(detail) + '">' + error + '<circle cx="' + x(index) + '" cy="' + y(value) + '" r="4" fill="' + colors[metric.key] + '"/></g>';
    }).join("");
    if (metric.kind === "bars") {
      const bars = metric.values.map((value, index) => '<rect class="unified-rain-bar" x="' + (index * cell + 12) + '" y="' + y(value) + '" width="' + (cell - 24) + '" height="' + (bottom - y(value)) + '"/>').join("");
      return '<g class="metric-layer metric-layer-' + metric.key + '">' + bars + points + '</g>';
    }
    const line = metric.values.map((value, index) => x(index) + "," + y(value)).join(" ");
    const secondary = metric.secondary ? '<polyline class="unified-secondary" points="' + metric.secondary.values.map((value, index) => x(index) + "," + y(value)).join(" ") + '"/>' : "";
    return '<g class="metric-layer metric-layer-' + metric.key + '"><polyline class="unified-line" stroke="' + colors[metric.key] + '" points="' + line + '"/>' + secondary + points + '</g>';
  }).join("");
  const verticals = hours.map((_, index) => '<line x1="' + (index * cell) + '" y1="0" x2="' + (index * cell) + '" y2="' + unifiedHeight + '"/>').join("");
  panels.innerHTML = '<div class="unified-display"><div class="chart-scroll"><div class="chart-wrap" style="width:' + width + 'px"><div class="unified-weather">' + overviewHeaders + '</div><svg class="unified-chart" viewBox="0 0 ' + width + ' ' + unifiedHeight + '" aria-label="Prévisions sélectionnées"><g class="unified-grid">' + verticals + '</g>' + graph + '</svg></div></div></div>';
  bindForecastControlButtons();
  bindChartTooltips();
  bindSharedHorizontalScroll(width, updateCurveLabels);
}

function bindSharedHorizontalScroll(width, onScroll = () => {}) {
  const master = $("forecast-horizontal-scroll");
  const track = $("forecast-horizontal-track");
  track.style.width = width + "px";
  const scrollables = () => [$("forecast-overview").querySelector(".overview-scroll"), ...document.querySelectorAll(".chart-scroll")].filter(Boolean);
  let synchronising = false;
  const sync = source => {
    if (synchronising) return;
    synchronising = true;
    const left = source.scrollLeft;
    master.scrollLeft = left;
    scrollables().forEach(element => { if (element !== source) element.scrollLeft = left; });
    onScroll(left);
    synchronising = false;
  };
  master.onscroll = () => sync(master);
  scrollables().forEach(element => { element.onscroll = () => sync(element); });
  scrollables().forEach(element => { element.scrollLeft = master.scrollLeft; });
  onScroll(master.scrollLeft);
  document.querySelectorAll(".forecast-panel").forEach(panel => panel.addEventListener("toggle", () => {
    const chart = panel.querySelector(".chart-scroll");
    if (chart) chart.scrollLeft = master.scrollLeft;
  }));
}

function bindChartTooltips() {
  const tooltip = $("chart-tooltip");
  const show = (target, event) => {
    tooltip.textContent = target.dataset.tooltip;
    tooltip.hidden = false;
    tooltip.style.left = Math.min(window.innerWidth - 260, Math.max(12, event.clientX + 14)) + "px";
    tooltip.style.top = Math.max(12, event.clientY - 82) + "px";
  };
  document.querySelectorAll(".chart-point").forEach(point => {
    if (point.dataset.tooltipBound === "true") return;
    point.dataset.tooltipBound = "true";
    point.addEventListener("pointerenter", event => show(point, event));
    point.addEventListener("pointermove", event => show(point, event));
    point.addEventListener("pointerleave", () => { tooltip.hidden = true; });
    point.addEventListener("focus", () => show(point, { clientX: point.getBoundingClientRect().right, clientY: point.getBoundingClientRect().top }));
    point.addEventListener("blur", () => { tooltip.hidden = true; });
  });
}

function radarDataAgeLabel(timestamp) {
  const updatedAt = new Date(timestamp).getTime();
  if (!Number.isFinite(updatedAt)) return "Dernières datas · mise à jour inconnue";
  const minutes = Math.max(0, Math.floor((appNow() - updatedAt) / 60000));
  if (minutes < 1) return "Dernières datas · à l’instant";
  if (minutes < 60) return "Dernières datas · il y a " + minutes + " min";
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return "Dernières datas · il y a " + hours + " h" + (remainingMinutes ? " " + remainingMinutes + " min" : "");
  const days = Math.floor(hours / 24);
  return "Dernières datas · il y a " + days + (days === 1 ? " jour" : " jours");
}

function radarCellEdgeDistance(cell) {
  const exact = cell?.edgeDistanceKm == null || cell.edgeDistanceKm === "" ? NaN : Number(cell.edgeDistanceKm);
  if (Number.isFinite(exact)) return Math.max(0, exact);
  return radarCellPointDistance(cell, 0, 0);
}

function radarCellPointDistance(cell, eastKm, northKm) {
  const shapeRuns = radarCellShapeRuns(cell);
  if (shapeRuns.length) {
    return Math.min(...shapeRuns.map(run => {
      const horizontal = Math.max(Number(run.westKm) - eastKm, 0, eastKm - Number(run.eastKm));
      const vertical = Math.max(Number(run.southKm) - northKm, 0, northKm - Number(run.northKm));
      return Math.hypot(horizontal, vertical);
    }));
  }
  const footprint = Array.isArray(cell?.footprint) ? cell.footprint : [];
  if (footprint.length >= 3) {
    let inside = false;
    let distance = Infinity;
    for (let index = 0, previousIndex = footprint.length - 1; index < footprint.length; previousIndex = index++) {
      const current = footprint[index];
      const previous = footprint[previousIndex];
      const currentEast = Number(current.eastKm);
      const currentNorth = Number(current.northKm);
      const previousEast = Number(previous.eastKm);
      const previousNorth = Number(previous.northKm);
      if ((currentNorth > northKm) !== (previousNorth > northKm)
        && eastKm < (previousEast - currentEast) * (northKm - currentNorth) / (previousNorth - currentNorth) + currentEast) inside = !inside;
      const segmentEast = previousEast - currentEast;
      const segmentNorth = previousNorth - currentNorth;
      const lengthSquared = segmentEast ** 2 + segmentNorth ** 2;
      const ratio = lengthSquared > 0
        ? Math.max(0, Math.min(1, ((eastKm - currentEast) * segmentEast + (northKm - currentNorth) * segmentNorth) / lengthSquared))
        : 0;
      distance = Math.min(distance, Math.hypot(eastKm - (currentEast + segmentEast * ratio), northKm - (currentNorth + segmentNorth * ratio)));
    }
    return inside ? 0 : Math.max(0, distance);
  }
  // Compatibilité avec les anciennes archives, qui ne contiennent pas encore la forme.
  return Math.max(0, Math.hypot(eastKm - Number(cell?.eastKm || 0), northKm - Number(cell?.northKm || 0)) - Math.max(0, Number(cell?.radiusKm || 0)));
}

// Calcul transféré au moteur : polarimetricHailRisk.

// Calcul transféré au moteur : polarimetricHailLabel.

// Calcul transféré au moteur : nowcastCellRepresentativeRain.

// Calcul transféré au moteur : nowcastEvidenceIsFresh.

// Calcul transféré au moteur : nowcastFlashesNearCell.

// Calcul transféré au moteur : nowcastCellHasConvectiveSignal.

// Calcul transféré au moteur : nowcastCellHasHailSignal.

// Calcul transféré au moteur : nowcastCellHasIntenseRainSignal.

// Calcul transféré au moteur : nowcastCellHasStormEvidence.

// Calcul transféré au moteur : nowcastLocalHail.

// Calcul transféré au moteur : nowcastLocalStormHazards.

function radarCellShapeRuns(cell) {
  return (Array.isArray(cell?.shapeRuns) ? cell.shapeRuns : []).filter(run => {
    return Number.isFinite(Number(run?.westKm))
      && Number.isFinite(Number(run?.eastKm))
      && Number.isFinite(Number(run?.southKm))
      && Number.isFinite(Number(run?.northKm))
      && Number(run.eastKm) > Number(run.westKm)
      && Number(run.northKm) > Number(run.southKm);
  });
}

// Calcul transféré au moteur : nowcastMapCoverage.

// Calcul transféré au moteur : nowcastMapIsSaturated.

// Calcul transféré au moteur : nowcastEtaCellOutsideMap.

function nowcastCellHasEtaProjection(cell) {
  if (cell?.etaMinutes == null) return false;
  const etaMinutes = Number(cell.etaMinutes);
  return Number.isFinite(etaMinutes)
    && etaMinutes >= 0
    && etaMinutes <= 180
    && Array.isArray(cell.track?.points)
    && cell.track.points.length > 1;
}

function nowcastEtaProjectionCells(cells) {
  return (cells || []).filter(cell => nowcastCellHasEtaProjection(cell)
    || (cell?.passageEnsemble?.status === 'ready' && cell.passageEnsemble.scenarios?.length > 0
      && cell.track?.points?.length > 1));
}

// Calcul transféré au moteur : nowcastSweptShapePolygons.

const nowcastPassageGridCache = new Map();

// Calcul transféré au moteur : nowcastPassageFrequencyGrid.

function radarCellExtent(cell, directionEast, directionNorth, absolute = false) {
  const shapeRuns = radarCellShapeRuns(cell);
  if (shapeRuns.length) {
    const centerEast = Number(cell.eastKm || 0);
    const centerNorth = Number(cell.northKm || 0);
    return Math.max(0, ...shapeRuns.flatMap(run => [
      [Number(run.westKm), Number(run.southKm)],
      [Number(run.westKm), Number(run.northKm)],
      [Number(run.eastKm), Number(run.southKm)],
      [Number(run.eastKm), Number(run.northKm)]
    ]).map(([eastKm, northKm]) => {
      const projection = (eastKm - centerEast) * directionEast + (northKm - centerNorth) * directionNorth;
      return absolute ? Math.abs(projection) : projection;
    }));
  }
  const footprint = Array.isArray(cell?.footprint) ? cell.footprint : [];
  if (footprint.length < 3) return Math.max(0, Number(cell?.radiusKm || 0));
  const centerEast = Number(cell.eastKm || 0);
  const centerNorth = Number(cell.northKm || 0);
  return Math.max(0, ...footprint.map(point => {
    const projection = (Number(point.eastKm) - centerEast) * directionEast + (Number(point.northKm) - centerNorth) * directionNorth;
    return absolute ? Math.abs(projection) : projection;
  }));
}

function nowcastRectangleIntersectionArea(left, right) {
  if (!left || !right) return 0;
  return Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left))
    * Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
}

function nowcastRectangleDistance(left, right) {
  if (!left || !right) return 0;
  const horizontal = Math.max(0, left.left - right.right, right.left - left.right);
  const vertical = Math.max(0, left.top - right.bottom, right.top - left.bottom);
  return Math.hypot(horizontal, vertical);
}

// Choisit une position proche de la cellule, contenue dans la carte et, dès
// que possible, hors de la zone occupée par Les Tatins et son libellé.
function nowcastCellOverlayPlacement({ cellBounds, targetBounds = null, viewport, overlaySize }) {
  const margin = 8;
  const gap = 8;
  const width = Math.min(Math.max(1, Number(overlaySize?.width) || 1), Math.max(1, viewport.right - viewport.left - margin * 2));
  const height = Math.min(Math.max(1, Number(overlaySize?.height) || 1), Math.max(1, viewport.bottom - viewport.top - margin * 2));
  const visibleCell = {
    left: Math.max(viewport.left + margin, cellBounds.left),
    top: Math.max(viewport.top + margin, cellBounds.top),
    right: Math.min(viewport.right - margin, cellBounds.right),
    bottom: Math.min(viewport.bottom - margin, cellBounds.bottom)
  };
  const cellCenterX = (cellBounds.left + cellBounds.right) / 2;
  const cellCenterY = (cellBounds.top + cellBounds.bottom) / 2;
  const candidates = [];
  const add = (left, top, placement, insideCell = false) => candidates.push({ left, top, placement, insideCell });
  const largeVisibleCell = visibleCell.right - visibleCell.left >= width + gap * 2
    && visibleCell.bottom - visibleCell.top >= height + gap * 2;
  if (largeVisibleCell) {
    add(visibleCell.left + gap, visibleCell.top + gap, "cell-top-left", true);
    add(visibleCell.right - width - gap, visibleCell.top + gap, "cell-top-right", true);
    add(visibleCell.left + gap, visibleCell.bottom - height - gap, "cell-bottom-left", true);
    add(visibleCell.right - width - gap, visibleCell.bottom - height - gap, "cell-bottom-right", true);
  }
  add(cellBounds.right + gap, cellCenterY - height / 2, "right");
  add(cellBounds.left - width - gap, cellCenterY - height / 2, "left");
  add(cellCenterX - width / 2, cellBounds.top - height - gap, "above");
  add(cellCenterX - width / 2, cellBounds.bottom + gap, "below");
  add(cellBounds.right + gap, cellBounds.top, "top-right");
  add(cellBounds.left - width - gap, cellBounds.top, "top-left");
  add(cellBounds.right + gap, cellBounds.bottom - height, "bottom-right");
  add(cellBounds.left - width - gap, cellBounds.bottom - height, "bottom-left");
  if (largeVisibleCell) {
    add(viewport.left + margin, viewport.top + margin, "map-top-left", true);
    add(viewport.right - width - margin, viewport.top + margin, "map-top-right", true);
    add(viewport.left + margin, viewport.bottom - height - margin, "map-bottom-left", true);
    add(viewport.right - width - margin, viewport.bottom - height - margin, "map-bottom-right", true);
  }
  const minLeft = viewport.left + margin;
  const maxLeft = viewport.right - width - margin;
  const minTop = viewport.top + margin;
  const maxTop = viewport.bottom - height - margin;
  return candidates.map((candidate, index) => {
    const left = Math.max(minLeft, Math.min(maxLeft, candidate.left));
    const top = Math.max(minTop, Math.min(maxTop, candidate.top));
    const rectangle = { left, top, right: left + width, bottom: top + height };
    const targetOverlap = nowcastRectangleIntersectionArea(rectangle, targetBounds);
    const overflow = Math.abs(left - candidate.left) + Math.abs(top - candidate.top);
    const associationDistance = nowcastRectangleDistance(rectangle, cellBounds);
    const targetClearance = targetBounds ? nowcastRectangleDistance(rectangle, targetBounds) : 0;
    const score = (targetOverlap > 0 ? 1e9 : 0) + targetOverlap * 1e7 + overflow * 1e4
      + associationDistance * 2 - (candidate.insideCell ? 500 : 0) - Math.min(400, targetClearance) * .25 + index * .01;
    return { ...rectangle, width, height, placement: candidate.placement, avoidsTarget: targetOverlap === 0, score };
  }).sort((left, right) => left.score - right.score)[0];
}

function nowcastMapScale(width, height, mapRadiusKm) {
  const radiusKm = Math.max(1, Number(mapRadiusKm) || 20);
  return Math.min((width - 40) / (radiusKm * 2), (height - 40) / (radiusKm * 2));
}

function nowcastRangeDistances(mapRadiusKm) {
  const radiusKm = Math.max(0, Number(mapRadiusKm) || 0);
  const stepKm = radiusKm >= 60 ? 20 : 10;
  return Array.from({ length: Math.floor(radiusKm / stepKm) }, (_, index) => (index + 1) * stepKm);
}

function renderThreatMap(radar, lightning = null, mapRadiusKm = activeNowcastMapRadius, cellPresentations = new Map()) {
  const updateTimestamp = radar?.dataUpdatedAt || radar?.fetchedAt || radar?.observedAt;
  const updateAgeMarkup = '<span class="storm-map-age">' + escapeText(radarDataAgeLabel(updateTimestamp)) + '</span>';

  const { width, height } = sandboxNowcastDimensions();
  const radarCells = (radar?.cells || []).map((cell, index) => ({
    ...cell,
    id: cell.id || String.fromCharCode(65 + index)
  })).filter(cell => {
    return radarCellEdgeDistance(cell) <= mapRadiusKm;
  });
  const threat = radarCells.find(cell => cell.id === radar?.threat?.id) || radarCells[0] || null;
  if (!threat) {
    const targetX = width / 2;
    const targetY = height / 2;
    const scale = nowcastMapScale(width, height, mapRadiusKm);
    const rings = nowcastRangeDistances(mapRadiusKm).map(distance => {
      const radius = distance * scale;
      const labelX = targetX;
      const labelY = targetY - radius;
      return '<g class="range-distance"><circle class="range-ring" cx="' + targetX + '" cy="' + targetY + '" r="' + radius.toFixed(1) + '"></circle><text x="' + labelX.toFixed(1) + '" y="' + labelY.toFixed(1) + '" text-anchor="middle">' + distance + ' km</text></g>';
    }).join('');
    const lightningMarks = (lightning?.flashes || []).filter(flash => Math.hypot(Number(flash.eastKm), Number(flash.northKm)) <= mapRadiusKm).map(flash => '<g class="lightning-flash" transform="translate(' + (targetX + flash.eastKm * scale).toFixed(1) + ' ' + (targetY - flash.northKm * scale).toFixed(1) + ')"><path d="M2-8-4 1h4l-2 8 7-11H1z"></path></g>').join('');
    return '<div class="storm-map"><div class="storm-map-leaflet" aria-hidden="true"></div><div class="nowcast-map-attribution"><a href="https://www.esri.com/" target="_blank" rel="noopener">Fond © Esri</a></div>' + updateAgeMarkup + '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Zone de détection radar à ' + mapRadiusKm + ' km centrée sur Les Tatins"><g class="north-arrow"><path d="M28 40V17l-5 8m5-8 5 8"></path><text x="23" y="54">N</text></g>' + rings + lightningMarks + '<g class="target-point"><title>Les Tatins</title><circle cx="' + targetX + '" cy="' + targetY + '" r="5"></circle><text x="' + (targetX + 8) + '" y="' + (targetY - 8) + '" text-anchor="start">Les Tatins</text></g></svg></div>';
  }
  const points = threat.track?.points || [];
  const etaProjectionCells = nowcastEtaProjectionCells(radarCells);
  const approachProjections = etaProjectionCells.map(cell => ({ id: cell.id, points: cell.track.points }));
  const projectionsById = new Map(approachProjections.map(projection => [projection.id, projection]));
  const primaryProjection = projectionsById.get(threat.id);
  const primaryPoints = primaryProjection?.points || points;
  const secondaryTrackPoints = etaProjectionCells.flatMap(cell => cell.id === threat.id ? [] : cell.track.points);
  const extentPoints = [{ eastKm: 0, northKm: 0, uncertaintyKm: 3 }, ...radarCells, ...secondaryTrackPoints, ...(primaryPoints.length ? primaryPoints : [threat])];
  const paddingX = 20;
  const paddingY = 20;
  const scale = nowcastMapScale(width, height, mapRadiusKm);
  const x = eastKm => width / 2 + Number(eastKm || 0) * scale;
  const y = northKm => height / 2 - Number(northKm || 0) * scale;
  const minimumEast = -(width / 2 - paddingX) / scale;
  const maximumEast = (width / 2 - paddingX) / scale;
  const minimumNorth = -(height / 2 - paddingY) / scale;
  const maximumNorth = (height / 2 - paddingY) / scale;
  const visibleTrackFor = (track, cell = null) => {
    if (!Array.isArray(track) || track.length <= 1) return track || [];
    const start = track[0];
    const end = track.at(-1);
    const dx = Number(end.eastKm) - Number(start.eastKm);
    const dy = Number(end.northKm) - Number(start.northKm);
    const lengthKm = Math.hypot(dx, dy);
    if (!Number.isFinite(lengthKm) || lengthKm <= 0) return track;
    const radiusKm = radarCellExtent(cell, dx / lengthKm, dy / lengthKm);
    const clearanceKm = Math.max(.6, .8 / Math.max(.1, scale));
    return [{
      ...start,
      eastKm: Number(start.eastKm) + dx / lengthKm * (radiusKm + clearanceKm),
      northKm: Number(start.northKm) + dy / lengthKm * (radiusKm + clearanceKm)
    }, ...track.slice(1)];
  };
  const trackPoints = '';
  const coneFor = (track, className, gradientId, color, cell = null) => {
    if (track.length <= 1) return '';
    const announcedPassage = cell ? cellPresentations.get(String(cell.id))?.passageRisk : null;
    const passageKnown = Number.isFinite(announcedPassage);
    const passage = passageKnown ? Math.max(0, Math.min(100, announcedPassage)) : 0;
    const confidence = Math.max(0, Math.min(100, Number(cell?.track?.confidence) || 0));
    const speedKmh = Math.max(0, Number(cell?.track?.speedKmh) || 0);
    const movingTrajectory = confidence > 0 || speedKmh >= 1;
    if (passage <= 0 && !movingTrajectory) return '';
    const baseOpacity = passage > 0
      ? Math.max(.14, Math.min(.64, .12 + passage / 100 * .38 + confidence / 100 * .12))
      : Math.max(.055, Math.min(.12, .045 + confidence / 100 * .06 + Math.min(speedKmh, 40) / 40 * .035));
    const start = track[0];
    const end = track.at(-1);
    const startX = x(start.eastKm);
    const startY = y(start.northKm);
    const endX = x(end.eastKm);
    const endY = y(end.northKm);
    const screenDx = endX - startX;
    const screenDy = endY - startY;
    const length = Math.hypot(screenDx, screenDy) || 1;
    const directionX = screenDx / length;
    const directionY = screenDy / length;
    const perpendicularX = -screenDy / length;
    const perpendicularY = screenDx / length;
    const geographicLength = Math.hypot(Number(end.eastKm) - Number(start.eastKm), Number(end.northKm) - Number(start.northKm)) || 1;
    const directionEast = (Number(end.eastKm) - Number(start.eastKm)) / geographicLength;
    const directionNorth = (Number(end.northKm) - Number(start.northKm)) / geographicLength;
    if (radarCellShapeRuns(cell).length) {
      const bounds = { westKm: -width / (2 * scale), eastKm: width / (2 * scale),
        southKm: -height / (2 * scale), northKm: height / (2 * scale) };
      if (cell.passageEnsemble?.status !== 'ready') return '';
      const groups = latestForecastData?.nowcast?.passageMaps?.find(map => String(map.id) === String(cell.id))?.groups || [];
      const paths = new Map();
      for (const { probability, runs } of groups) {
        let path = '';
        for (const [west, south, length] of runs) {
          const east = west + length;
          if (east < bounds.westKm || west > bounds.eastKm || south + .25 < bounds.southKm || south > bounds.northKm) continue;
          path += 'M' + x(west).toFixed(1) + ' ' + y(south + .25).toFixed(1)
            + 'H' + x(east).toFixed(1) + 'V' + y(south).toFixed(1) + 'H' + x(west).toFixed(1) + 'Z';
        }
        if (path) paths.set(probability, path);
      }
      const observedPath = radarCellShapeRuns(cell).map(run => 'M' + x(run.westKm).toFixed(1) + ' ' + y(run.northKm).toFixed(1)
        + 'H' + x(run.eastKm).toFixed(1) + 'V' + y(run.southKm).toFixed(1) + 'H' + x(run.westKm).toFixed(1) + 'Z').join('');
      const maskId = gradientId + '-observed';
      const mask = '<mask id="' + maskId + '" maskUnits="userSpaceOnUse" x="0" y="0" width="' + width + '" height="' + height
        + '"><rect width="' + width + '" height="' + height + '" fill="white"></rect><path d="'
        + observedPath + '" fill="black"></path></mask>';
      const horizon = Math.round(Number(track.at(-1).minutes) || 0);
      const smoothingId = gradientId + '-probability-smoothing';
      const smoothing = '<filter id="' + smoothingId + '" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">'
        + '<feGaussianBlur stdDeviation="' + Math.max(.8, Math.min(2, scale * .18)).toFixed(2) + '"/></filter>';
      return '<defs>' + mask + smoothing + '</defs><g class="' + className + ' shape-projection" mask="url(#' + maskId + ')"><g filter="url(#' + smoothingId + ')">'
        + [...paths].map(([count, path]) => {
          const frequency = count;
          const title = 'Cellule ' + cell.id + ' · ici : ' + Math.round(frequency * 100) + ' % des trajectoires simulées sur '
            + horizon + ' min · estimation du déplacement et de son incertitude';
          return '<path class="chart-point" tabindex="0" data-tooltip="' + escapeText(title) + '" d="' + path
            + '" shape-rendering="crispEdges" style="fill:' + color + ';fill-opacity:' + (frequency * .6).toFixed(4) + ';stroke:none"></path>';
        }).join('') + '</g></g>';
    }
    const forwardExtent = radarCellExtent(cell, directionEast, directionNorth);
    const lateralExtent = radarCellExtent(cell, -directionNorth, directionEast, true);
    let previousExtentKm = lateralExtent;
    const radiusByPointKm = track.map((point, index) => {
      const legacyTotalUncertainty = Math.max(0, Number(point.uncertaintyKm) || 0);
      const growthKm = index === 0 ? 0 : Number.isFinite(Number(point.uncertaintyGrowthKm))
        ? Math.max(0, Number(point.uncertaintyGrowthKm))
        : Math.max(0, legacyTotalUncertainty - lateralExtent);
      previousExtentKm = Math.max(previousExtentKm, lateralExtent + growthKm);
      return previousExtentKm;
    });
    const radiusFor = index => radiusByPointKm[index] * scale;
    const edgeClearance = Math.max(3, scale * .8);
    const edgeStartX = startX + directionX * (forwardExtent * scale + edgeClearance);
    const edgeStartY = startY + directionY * (forwardExtent * scale + edgeClearance);
    const startHalfWidth = Math.max(scale, lateralExtent * scale);
    const edgeOpacity = 0;
    const sideOpacity = Math.max(.06, baseOpacity * .68);
    const centerOpacity = baseOpacity;
    const title = cell
      ? (passage > 0 ? 'Zone probable cellule ' : 'Trajectoire estimée cellule ') + cell.id + ' · passage ' + (passageKnown ? Math.round(passage) + ' %' : 'incertain') + ' · confiance trajectoire ' + Math.round(confidence) + ' % · horizon ' + Math.round(Number(cell.track?.horizonMinutes || end.minutes || 0)) + ' min'
      : 'Zone probable';
    const visibleTrack = visibleTrackFor(track, cell);
    const coneCenterline = visibleTrack;
    const screenPoints = coneCenterline.map((point, index) => ({
      x: x(point.eastKm),
      y: y(point.northKm),
      radius: index === 0 ? startHalfWidth : radiusFor(Math.min(index, track.length - 1))
    }));
    const left = [];
    const right = [];
    screenPoints.forEach((point, index) => {
      const next = screenPoints[Math.min(screenPoints.length - 1, index + 1)];
      const previous = screenPoints[Math.max(0, index - 1)];
      const dx = next.x - previous.x;
      const dy = next.y - previous.y;
      const segmentLength = Math.hypot(dx, dy) || 1;
      const normalX = -dy / segmentLength;
      const normalY = dx / segmentLength;
      left.push([point.x + normalX * point.radius, point.y + normalY * point.radius]);
      right.push([point.x - normalX * point.radius, point.y - normalY * point.radius]);
    });
    const conePath = left.concat(right.reverse()).map((point, index) => (index ? 'L' : 'M') + point[0].toFixed(1) + ' ' + point[1].toFixed(1)).join(' ') + 'Z';
    const gradient = '<linearGradient id="' + gradientId + '" gradientUnits="userSpaceOnUse" x1="' + edgeStartX.toFixed(1) + '" y1="' + edgeStartY.toFixed(1) + '" x2="' + endX.toFixed(1) + '" y2="' + endY.toFixed(1) + '"><stop offset="0" stop-color="' + color + '" stop-opacity="' + centerOpacity.toFixed(3) + '"></stop><stop offset=".55" stop-color="' + color + '" stop-opacity="' + sideOpacity.toFixed(3) + '"></stop><stop offset="1" stop-color="' + color + '" stop-opacity="' + edgeOpacity.toFixed(3) + '"></stop></linearGradient>';
    return '<defs>' + gradient + '</defs><path class="' + className + ' chart-point" tabindex="0" data-tooltip="' + escapeText(title) + '" d="' + conePath + '" style="fill:url(#' + gradientId + ');stroke:none"></path>';
  };
  const directionChevronsFor = (track, cell) => {
    const visibleTrack = visibleTrackFor(track, cell);
    if (visibleTrack.length <= 1 || track.length <= 1) return '';
    const origin = track[0];
    const next = track.slice(1).find(point => Math.hypot(Number(point.eastKm) - Number(origin.eastKm), Number(point.northKm) - Number(origin.northKm)) > .01);
    if (!next) return '';
    const start = visibleTrack[0];
    const startX = x(start.eastKm);
    const startY = y(start.northKm);
    const dx = x(next.eastKm) - x(origin.eastKm);
    const dy = y(next.northKm) - y(origin.northKm);
    const length = Math.hypot(dx, dy) || 1;
    const ux = dx / length;
    const uy = dy / length;
    const nx = -uy;
    const ny = ux;
    const chevron = offset => {
      const cx = startX + ux * offset;
      const cy = startY + uy * offset;
      const backX = cx - ux * 8;
      const backY = cy - uy * 8;
      return '<path class="storm-direction" d="M' + (backX + nx * 5).toFixed(1) + ' ' + (backY + ny * 5).toFixed(1) + 'L' + cx.toFixed(1) + ' ' + cy.toFixed(1) + 'L' + (backX - nx * 5).toFixed(1) + ' ' + (backY - ny * 5).toFixed(1) + '"></path>';
    };
    return chevron(18);
  };
  const cones = etaProjectionCells.map((cell, index) => coneFor(
    cell.track.points,
    'storm-cone projected' + (cell.id === threat.id ? ' primary' : ' secondary'),
    'storm-probability-eta-' + index,
    '#2b91c6',
    cell
  )).join('');
  const directionChevrons = radarCells.map(cell => directionChevronsFor(cell.track?.points || [], cell)).join('');
  const cellOverlays = [];
  const cells = radarCells.map((cell, index) => {
    const legacyRadius = Math.max(5, Number(cell.radiusKm || 1) * scale);
    const selected = Math.abs(cell.eastKm - threat.eastKm) < .1 && Math.abs(cell.northKm - threat.northKm) < .1;
    const cellId = cell.id || String.fromCharCode(65 + index);
    const name = 'Cellule ' + cellId;
    const presentation = cellPresentations.get(String(cellId));
    const overlayId = "nowcast-cell-overlay-" + (String(cellId).replace(/[^a-z0-9_-]/gi, "") || index);
    const interactionAttributes = presentation
      ? ' tabindex="0" role="button" data-nowcast-cell-trigger="' + escapeText(cellId) + '" aria-controls="' + escapeText(overlayId) + '" aria-expanded="false" aria-label="' + escapeText(presentation.label) + '"'
      : ' aria-label="' + escapeText(name) + '"';
    const shapeRuns = radarCellShapeRuns(cell);
    const footprint = Array.isArray(cell.footprint) && cell.footprint.length >= 3 ? cell.footprint : null;
    const rasterPath = shapeRuns.map(run => 'M' + x(run.westKm).toFixed(1) + ' ' + y(run.northKm).toFixed(1)
      + 'H' + x(run.eastKm).toFixed(1) + 'V' + y(run.southKm).toFixed(1)
      + 'H' + x(run.westKm).toFixed(1) + 'Z').join('');
    const shape = shapeRuns.length
      ? '<path class="radar-cell raster-shape' + (selected ? ' selected' : '') + '" d="' + rasterPath + '"' + interactionAttributes + '></path>'
      : footprint
        ? '<path class="radar-cell' + (selected ? ' selected' : '') + '" d="' + footprint.map((point, pointIndex) => (pointIndex ? 'L' : 'M') + x(point.eastKm).toFixed(1) + ' ' + y(point.northKm).toFixed(1)).join(' ') + 'Z"' + interactionAttributes + '></path>'
      : '<circle class="radar-cell' + (selected ? ' selected' : '') + '" cx="' + x(cell.eastKm).toFixed(1) + '" cy="' + y(cell.northKm).toFixed(1) + '" r="' + legacyRadius.toFixed(1) + '"' + interactionAttributes + '></circle>';
    const labelX = shapeRuns.length
      ? Math.min(...shapeRuns.map(run => x(run.westKm))) - 4
      : footprint ? Math.min(...footprint.map(point => x(point.eastKm))) - 4 : x(cell.eastKm) - legacyRadius - 4;
    const labelY = shapeRuns.length
      ? Math.min(...shapeRuns.map(run => y(run.northKm))) - 4
      : footprint ? Math.min(...footprint.map(point => y(point.northKm))) - 4 : y(cell.northKm) - legacyRadius - 4;
    if (presentation) {
      cellOverlays.push('<aside class="nowcast-cell-map-overlay passage-' + escapeText(presentation.tone) + '" id="' + escapeText(overlayId) + '" data-nowcast-cell-overlay="' + escapeText(cellId) + '" role="tooltip" hidden>' + presentation.markup + '</aside>');
    }
    return '<g class="radar-cell-marker" data-nowcast-cell-marker="' + escapeText(cellId) + '">' + shape + '<text class="cell-name' + (selected ? '' : ' secondary') + '" x="' + labelX.toFixed(1) + '" y="' + labelY.toFixed(1) + '" text-anchor="end">' + escapeText(cellId) + '</text></g>';
  }).join('');
  const lightningMarks = (lightning?.flashes || []).filter(flash => flash.eastKm >= minimumEast && flash.eastKm <= maximumEast && flash.northKm >= minimumNorth && flash.northKm <= maximumNorth).map(flash => '<g class="lightning-flash" transform="translate(' + x(flash.eastKm).toFixed(1) + ' ' + y(flash.northKm).toFixed(1) + ')"><path d="M2-8-4 1h4l-2 8 7-11H1z"></path><title>Éclair · ' + escapeText(Number(flash.distanceKm).toFixed(1)) + ' km des Tatins</title></g>').join('');
  const secondaryTracks = '';
  const milestones = '';
  const targetX = x(0).toFixed(1);
  const targetY = y(0).toFixed(1);
  const rangeRings = nowcastRangeDistances(mapRadiusKm).map(distance => {
    const radius = distance * scale;
    const labelX = x(0);
    const labelY = y(0) - radius;
    return '<g class="range-distance"><circle class="range-ring" cx="' + targetX + '" cy="' + targetY + '" r="' + radius.toFixed(1) + '"></circle><text x="' + labelX.toFixed(1) + '" y="' + labelY.toFixed(1) + '" text-anchor="middle">' + distance + ' km</text></g>';
  }).join('');
  const threatX = x(threat.eastKm);
  const threatY = y(threat.northKm);
  const cellDistanceKm = Math.hypot(Number(threat.eastKm || 0), Number(threat.northKm || 0));
  const distanceMiddleX = (x(0) + threatX) / 2;
  const distanceMiddleY = (y(0) + threatY) / 2;
  const distanceLink = '';
  return '<div class="storm-map"><div class="storm-map-leaflet" aria-hidden="true"></div><div class="nowcast-map-attribution"><a href="https://www.esri.com/" target="_blank" rel="noopener">Fond © Esri</a></div>' + updateAgeMarkup + '<svg viewBox="0 0 ' + width + ' ' + height + '" role="group" aria-label="Cellules radar et trajectoires avec ETA sur la carte à ' + mapRadiusKm + ' km"><defs><marker id="storm-arrowhead" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="3.2" markerHeight="3.2" orient="auto"><path d="M1 2L10 6L1 10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></marker></defs>' +
    '<path class="map-axis" d="M' + targetX + ' 14V' + (height - 14) + 'M18 ' + targetY + 'H' + (width - 18) + '"></path><g class="north-arrow"><path d="M28 40V17l-5 8m5-8 5 8"></path><text x="23" y="54">N</text></g>' + rangeRings +
    distanceLink + cones + secondaryTracks + cells + lightningMarks + directionChevrons + milestones +
    '<g class="target-point"><title>Les Tatins</title><circle cx="' + targetX + '" cy="' + targetY + '" r="5"></circle><text x="' + (targetX + 8) + '" y="' + (targetY - 8) + '" text-anchor="start">Les Tatins</text></g>' +
    '</svg>' + (etaProjectionCells.some(cell => radarCellShapeRuns(cell).length)
      ? (etaProjectionCells.some(cell => cell.passageEnsemble?.status === 'ready')
        ? '<div class="nowcast-probability-legend" title="Probabilité estimée de passage sur l’horizon annoncé.">Passage estimé · 0 % <span aria-hidden="true"></span> 100 %</div>'
        : '<div class="nowcast-probability-legend">Probabilité en cours d’estimation</div>') : '')
    + cellOverlays.join("") + '</div>';
}

function initializeNowcastCellOverlays(root) {
  if (nowcastCellOverlayResizeObserver) {
    nowcastCellOverlayResizeObserver.disconnect();
    nowcastCellOverlayResizeObserver = null;
  }
  const map = root.querySelector(".storm-map");
  if (!map) return;
  const markers = [...map.querySelectorAll("[data-nowcast-cell-marker]")];
  const panels = [...map.querySelectorAll("[data-nowcast-cell-overlay]")];
  if (!markers.length || !panels.length) return;
  let pinnedTrigger = null;
  let activeTrigger = null;
  const panelFor = trigger => {
    const panel = document.getElementById(trigger?.getAttribute("aria-controls") || "");
    return panel && map.contains(panel) ? panel : null;
  };
  const closeAll = () => {
    markers.forEach(marker => marker.classList.remove("is-active"));
    panels.forEach(panel => {
      panel.hidden = true;
      panel.classList.remove("is-visible", "is-measuring");
    });
    map.querySelectorAll("[data-nowcast-cell-trigger]").forEach(trigger => trigger.setAttribute("aria-expanded", "false"));
    activeTrigger = null;
  };
  const positionPanel = (trigger, panel) => {
    panel.style.left = "0px";
    panel.style.top = "0px";
    panel.hidden = false;
    panel.classList.add("is-measuring");
    const mapRectangle = map.getBoundingClientRect();
    const cellRectangle = trigger.getBoundingClientRect();
    const panelRectangle = panel.getBoundingClientRect();
    const targetRectangle = map.querySelector(".target-point")?.getBoundingClientRect();
    const relative = rectangle => rectangle ? {
      left: rectangle.left - mapRectangle.left,
      top: rectangle.top - mapRectangle.top,
      right: rectangle.right - mapRectangle.left,
      bottom: rectangle.bottom - mapRectangle.top
    } : null;
    const targetBounds = relative(targetRectangle);
    if (targetBounds) {
      targetBounds.left -= 8;
      targetBounds.top -= 8;
      targetBounds.right += 8;
      targetBounds.bottom += 8;
    }
    const placement = nowcastCellOverlayPlacement({
      cellBounds: relative(cellRectangle),
      targetBounds,
      viewport: { left: 0, top: 0, right: mapRectangle.width, bottom: mapRectangle.height },
      overlaySize: { width: panelRectangle.width, height: panelRectangle.height }
    });
    panel.style.left = placement.left.toFixed(1) + "px";
    panel.style.top = placement.top.toFixed(1) + "px";
    panel.dataset.placement = placement.placement;
    panel.classList.remove("is-measuring");
  };
  const show = trigger => {
    const panel = panelFor(trigger);
    if (!panel) return;
    closeAll();
    positionPanel(trigger, panel);
    panel.classList.add("is-visible");
    trigger.setAttribute("aria-expanded", "true");
    trigger.closest("[data-nowcast-cell-marker]")?.classList.add("is-active");
    activeTrigger = trigger;
  };
  const restorePinnedOrClose = marker => {
    if (marker?.matches(":hover") || marker?.contains(document.activeElement)) return;
    if (pinnedTrigger) show(pinnedTrigger);
    else closeAll();
  };
  markers.forEach(marker => {
    const trigger = marker.querySelector("[data-nowcast-cell-trigger]");
    if (!trigger) return;
    marker.addEventListener("pointerenter", () => show(trigger));
    marker.addEventListener("pointerleave", () => restorePinnedOrClose(marker));
    marker.addEventListener("focusin", () => show(trigger));
    marker.addEventListener("focusout", () => requestAnimationFrame(() => restorePinnedOrClose(marker)));
    trigger.addEventListener("click", event => {
      event.stopPropagation();
      if (pinnedTrigger === trigger) {
        pinnedTrigger = null;
        closeAll();
        return;
      }
      pinnedTrigger = trigger;
      show(trigger);
    });
    trigger.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        pinnedTrigger = null;
        closeAll();
        trigger.focus();
      }
    });
  });
  map.addEventListener("click", () => {
    pinnedTrigger = null;
    closeAll();
  });
  nowcastCellOverlayResizeObserver = new ResizeObserver(() => {
    if (activeTrigger) {
      const panel = panelFor(activeTrigger);
      if (panel && !panel.hidden) positionPanel(activeTrigger, panel);
    }
  });
  nowcastCellOverlayResizeObserver.observe(map);
}

function initializeNowcastMapBackground(mapRadiusKm) {
  const requestId = ++nowcastMapRequest;
  if (nowcastLeafletResizeObserver) {
    nowcastLeafletResizeObserver.disconnect();
    nowcastLeafletResizeObserver = null;
  }
  if (nowcastLeafletMap) {
    nowcastLeafletMap.remove();
    nowcastLeafletMap = null;
  }
  const container = document.querySelector("#radar-nowcast .storm-map-leaflet");
  if (!container || !window.L) return;
  const { width, height } = sandboxNowcastDimensions();
  const scale = nowcastMapScale(width, height, mapRadiusKm);
  const eastExtentKm = width / (2 * scale);
  const northExtentKm = height / (2 * scale);
  const latitudeKm = 111.32;
  const longitudeKm = latitudeKm * Math.cos(point.lat * Math.PI / 180);
  const bounds = [
    [point.lat - northExtentKm / latitudeKm, point.lon - eastExtentKm / longitudeKm],
    [point.lat + northExtentKm / latitudeKm, point.lon + eastExtentKm / longitudeKm]
  ];
  nowcastLeafletMap = window.L.map(container, {
    preferCanvas: true,
    zoomControl: false,
    attributionControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    tap: false,
    zoomSnap: 0,
    fadeAnimation: false,
    zoomAnimation: false,
    markerZoomAnimation: false
  }).setView([point.lat, point.lon], mapRadiusKm === 20 ? 9 : 7);
  window.L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, opacity: 0.62, attribution: "" }).addTo(nowcastLeafletMap);
  let placeContext = [];
  const regionalPlaceNames = new Set(["Montélimar", "Carpentras", "Sisteron", "Embrun", "Valence", "Grenoble", "Gap", "Briançon"]);
  const regionalPlaceFallback = [
    { name: "Montélimar", place: "town", latitude: 44.5579, longitude: 4.7503, distanceKm: 68 },
    { name: "Carpentras", place: "town", latitude: 44.0554, longitude: 5.0488, distanceKm: 79 },
    { name: "Sisteron", place: "town", latitude: 44.1963, longitude: 5.9444, distanceKm: 58 },
    { name: "Embrun", place: "town", latitude: 44.5642, longitude: 6.4958, distanceKm: 72 },
    { name: "Valence", place: "city", latitude: 44.9332, longitude: 4.8921, distanceKm: 64 },
    { name: "Grenoble", place: "city", latitude: 45.1876, longitude: 5.7358, distanceKm: 60 },
    { name: "Gap", place: "town", latitude: 44.5612, longitude: 6.0821, distanceKm: 40 },
    { name: "Briançon", place: "town", latitude: 44.899, longitude: 6.643, distanceKm: 87 }
  ];
  const localPlaceFallback = [
    { name: "Châtillon-en-Diois", place: "village", latitude: 44.6952, longitude: 5.4857, distanceKm: 11.5 },
    { name: "Die", place: "town", latitude: 44.7537, longitude: 5.3703, distanceKm: 21.2 },
    { name: "Saint-Roman", place: "village", latitude: 44.692, longitude: 5.432, distanceKm: 14 },
    { name: "Valdrôme", place: "village", latitude: 44.5043, longitude: 5.5724, distanceKm: 16.8 },
    { name: "La Faurie", place: "village", latitude: 44.568, longitude: 5.739, distanceKm: 14.7 },
    { name: "Aspremont", place: "village", latitude: 44.491, longitude: 5.729, distanceKm: 20.8 },
    { name: "Clelles", place: "village", latitude: 44.827, longitude: 5.623, distanceKm: 19.4 },
    { name: "Glandage", place: "village", latitude: 44.6885, longitude: 5.5977, distanceKm: 3.9 },
    { name: "Lus-la-Croix-Haute", place: "village", latitude: 44.665, longitude: 5.705, distanceKm: 8.5 }
  ];
  const placeLayer = window.L.layerGroup().addTo(nowcastLeafletMap);
  const renderPlaceLabels = () => {
    placeLayer.clearLayers();
    const occupied = [];
    const candidates = [...placeContext].sort((left, right) => {
      const rank = { city: 3, town: 2, village: 1 };
      const leftPriority = rank[left.place] * 100000 + Math.min(99999, Number(left.population) || 0) - Math.max(0, Number(left.distanceKm) || 0) * 120;
      const rightPriority = rank[right.place] * 100000 + Math.min(99999, Number(right.population) || 0) - Math.max(0, Number(right.distanceKm) || 0) * 120;
      return rightPriority - leftPriority;
    });
    candidates.forEach(place => {
      const screenPoint = nowcastLeafletMap.latLngToContainerPoint([place.latitude, place.longitude]);
      const widthEstimate = Math.max(30, place.name.length * 6 + 15);
      const nearTopEdge = screenPoint.y < 36;
      const box = nearTopEdge
        ? { left: screenPoint.x - widthEstimate / 2, right: screenPoint.x + widthEstimate / 2, top: screenPoint.y + 8, bottom: screenPoint.y + 28 }
        : { left: screenPoint.x - 2, right: screenPoint.x + widthEstimate + 6, top: screenPoint.y - 15, bottom: screenPoint.y + 2 };
      if (box.right < 4 || box.left > container.clientWidth - 4 || box.bottom < 4 || box.top > container.clientHeight - 4) return;
      if (occupied.some(other => box.left < other.right + 5 && box.right > other.left - 5 && box.top < other.bottom + 4 && box.bottom > other.top - 4)) return;
      occupied.push(box);
      const labelPosition = nearTopEdge ? ' style="left:50%;top:12px;bottom:auto;transform:translateX(-50%)"' : '';
      const icon = window.L.divIcon({ className: "osm-place-label " + place.place, html: '<i class="osm-place-dot" aria-hidden="true"></i><span' + labelPosition + '>' + escapeText(place.name) + '</span>', iconSize: [4, 4], iconAnchor: [2, 2] });
      window.L.marker([place.latitude, place.longitude], { icon, interactive: false, keyboard: false }).addTo(placeLayer);
    });
  };
  placeContext = mapRadiusKm === 60 ? regionalPlaceFallback : localPlaceFallback;
  renderPlaceLabels();
  const fitToContainer = () => {
    if (!nowcastLeafletMap || container.clientWidth < 1 || container.clientHeight < 1) return;
    nowcastLeafletMap.invalidateSize({ animate: false });
    nowcastLeafletMap.fitBounds(bounds, { padding: [0, 0], animate: false });
    renderPlaceLabels();
  };
  nowcastLeafletResizeObserver = new ResizeObserver(() => requestAnimationFrame(fitToContainer));
  nowcastLeafletResizeObserver.observe(container);
  requestAnimationFrame(fitToContainer);
}

function renderRadarNowcast(radar, piaf, arome, lightning, vigilance = null) {
  const element = $("radar-nowcast");
  const summaryElement = $("three-hour-summary");
  const forecast = latestForecastData?.nowcast;
  const now = appNow();
  if (!radar || !forecast || forecast.schemaVersion !== 1 || now > forecast.validUntil) {
    clearThreeHourMessageSequence(true);
    if (summaryElement) summaryElement.innerHTML = '<p class="horizon-empty">Prévision en attente d’actualisation</p>';
    if (element) element.innerHTML = '<strong>Radar</strong><span>Prévision serveur indisponible ou périmée.</span>';
    return;
  }
  const { rainMessageSequence, rainValue, rainColorLevel, rainDetail, rainTrend, stormCombinedLevel, stormDetail, stormTrend, stormTrendDetail, stormEtaLabel, stormDurationLabel, stormEtaDetail, windValue, windLevel, windDetail, windTrendWithDetail, windColorLevel } = forecast;
  if (!nowcastMapRadiusManuallySelected) activeNowcastMapRadius = forecast.recommendedMapRadius;
  nowcastMapAutoExpanded = activeNowcastMapRadius === 60;
  const metrics = new Map(forecast.cellMetrics.map(metric => [String(metric.id), metric]));
  const riskTone = value => value >= 60 ? "high" : value >= 30 ? "medium" : value > 0 ? "low" : "none";
  const nowcastMetricIcons = {
    rain: '<path d="M12 2.8C9.5 6.4 6.8 9.7 6.8 13.2a5.2 5.2 0 0 0 10.4 0C17.2 9.7 14.5 6.4 12 2.8Z"/>',
    wind: '<path d="M3 7.5h10.5c3.7 0 3.7-4.5.7-4.5-1.3 0-2.2.7-2.6 1.7M3 12h15c3.8 0 3.8 5 .5 5-1.5 0-2.4-.8-2.8-1.8M3 16.5h7"/>',
    gust: '<path d="M3 7h12c4 0 4-5 .7-5-1.5 0-2.5.8-2.9 2M3 12h17M3 17h10c4 0 4 5 .7 5-1.5 0-2.5-.8-2.9-2"/>',
    storm: '<path class="storm-cloud" d="M4.2 14.2a3.4 3.4 0 0 1 .4-6.8A5.3 5.3 0 0 1 15 6a3.8 3.8 0 0 1 3.1 1.6 3.3 3.3 0 0 1 .7 6.6H4.2Z"/><path class="storm-bolt" d="M11.2 10.8 7.8 16h3l-1.4 6 7-9h-3.2l1.5-2.2h-3.5Z"/>',
    lightning: '<path d="M13.5 2 6.8 13h5l-1.2 9L18 10.5h-5L13.5 2Z"/>',
    hail: '<path d="M5 13.5a4 4 0 0 1 .2-8A6 6 0 0 1 17 6.5a3.5 3.5 0 1 1 .5 7H5Z"/><text class="hail-letter" x="12" y="11.4" text-anchor="middle">G</text><circle class="hailstone" cx="7.5" cy="18" r="1.6"/><circle class="hailstone" cx="12.5" cy="20" r="1.6"/><circle class="hailstone" cx="17.5" cy="18" r="1.6"/>'
  };
  const nowcastMetricPictogram = (kind, step, label, showSymbol = true, showScale = true, nativeTitle = true) => {
    const level = Math.max(0, Math.min(5, Math.round(Number(step) || 0)));
    const scale = showScale ? '<span class="week-metric-scale" aria-hidden="true">' + Array.from({ length: 5 }, (_, index) => '<i class="' + (index < level ? "solid" : "") + '"></i>').join("") + '</span>' : '';
    const symbol = showSymbol ? '<svg viewBox="0 0 24 24" aria-hidden="true">' + nowcastMetricIcons[kind] + '</svg>' : "";
    return '<span class="week-metric-pictogram ' + kind + '" role="img" aria-label="' + escapeText(label) + '"' + (nativeTitle ? ' title="' + escapeText(label) + '"' : '') + '>' + symbol + scale + '</span>';
  };
  const trendMarkup = (kind, trend, source, nativeTitle = true) => {
    const arrow = trend.label === "croissant"
      ? '<path d="M10 14V6m0 0L7 9m3-3 3 3"/>'
      : trend.label === "decroissant"
        ? '<path d="M10 6v8m0 0-3-3m3 3 3-3"/>'
        : '<path d="M6 10h8m0 0-3-3m3 3-3 3"/>';
    const wording = trend.label === "croissant" ? "en hausse" : trend.label === "decroissant" ? "en baisse" : "stable";
    const detail = trend.detail || "Tendance " + wording + " sur les 3 prochaines heures" + (source ? " (" + source + ")" : "");
    const significance = threeHourTrendIsSignificant(kind, trend) ? " significant" : "";
    return '<span class="three-hour-trend ' + trend.label + significance + '"' + (nativeTitle ? ' title="' + escapeText(detail) + '"' : '') + ' aria-label="' + escapeText(detail) + '"><b aria-hidden="true"><svg viewBox="0 0 20 20">' + arrow + '</svg></b></span>';
  };
  const summaryAction = (kind, value, level, detail, trend, target = null, stormPassageLevel = null, stormDetails = null, colorLevelOverride = null, stableTooltip = false) => {
    const stormLayout = stormPassageLevel != null;
    const messageSequence = Array.isArray(value) ? value.filter(message => message?.label) : [];
    const messageSequenceMarkup = messageSequence.length ? threeHourMessageSequenceMarkup(messageSequence) : "";
    const accessibleMessages = threeHourMessageRotationEnabled
      ? messageSequence
      : messageSequence.length ? [messageSequence[threeHourMessageSequenceInitialIndex(messageSequence)]] : [];
    const messageSequenceDetail = accessibleMessages.map(message => [message.label, message.detail].filter(Boolean).join(" · ")).join(" ; ");
    const colorSource = colorLevelOverride == null ? (stormLayout ? stormPassageLevel : level) : colorLevelOverride;
    const colorLevel = Math.max(0, Math.min(5, Math.round(Number(colorSource) || 0)));
    const passageDetail = stormDetails?.passage || detail;
    const displayedTrend = stormDetails?.trend ? { ...trend, detail: stormDetails.trend } : trend;
    const stormIndicator = nowcastMetricPictogram(kind, stormPassageLevel, passageDetail);
    const stormEta = stormDetails?.eta
      ? '<span class="three-hour-action-value three-hour-storm-window" title="' + escapeText(stormDetails.etaDetail || stormDetails.eta) + '"><span class="three-hour-storm-eta">' + escapeText(stormDetails.eta) + '</span>'
        + (stormDetails.duration ? '<span class="three-hour-storm-duration">' + escapeText(stormDetails.duration) + '</span>' : '')
        + '</span>'
      : '';
    const actionGraph = target ? graphIconMarkup("three-hour-graph-icon") : "";
    const stormTiming = displayedTrend
      ? '<span class="three-hour-storm-timing">' + trendMarkup(kind, displayedTrend, passageDetail, !stableTooltip) + '</span>'
      : '';
    const metric = stormLayout
      ? stormIndicator + stormTiming + stormEta + actionGraph
      : nowcastMetricPictogram(kind, level, detail, true, true, !stableTooltip) + (trend ? trendMarkup(kind, trend, detail, !stableTooltip) : '') + (messageSequenceMarkup || (value ? '<b class="three-hour-action-value">' + escapeText(value) + '</b>' : '')) + actionGraph;
    const actionLabel = target === "rain" ? "Ouvrir les précipitations sur 3 h" : target === "nowcast" ? "Ouvrir le nowcasting" : target === "wind48" ? "Ouvrir les prévisions de vent sur 48 h" : "";
    const accessibleSummary = [messageSequenceDetail, detail].filter(Boolean).join(" — ");
    const accessibleDetail = actionLabel ? actionLabel + " — " + accessibleSummary : accessibleSummary;
    return '<button class="three-hour-action metric-' + kind + ' level-' + colorLevel + (target ? ' actionable' : '') + (stableTooltip ? ' chart-point' : '') + '" type="button"' + (target ? ' data-summary-target="' + target + '"' : ' aria-disabled="true"') + ' aria-label="' + escapeText(accessibleDetail) + '"' + (stableTooltip ? ' data-tooltip="' + escapeText(detail) + '"' : ' title="' + escapeText(accessibleDetail) + '"') + '><span class="three-hour-action-body">' + metric + '</span></button>';
  };

  const cellPresentation = cell => {
    const risks = cell.risks || {};
    const metric = metrics.get(String(cell.id));
    if (!metric) return { tone: "none", label: "", markup: "", passageRisk: null };
    // Le cartouche décrit la cellule courante, même si son ETA n'est pas encore
    // confirmée sur plusieurs scans. La synthèse 3 h reste, elle, plus prudente.
    const passageRisk = metric.passageRisk;
    const passageText = metric.uncertain
      ? 'incertain'
      : passageRisk == null ? "incertain" : passageRisk + " %";
    const hailRisk = metric.hailRisk;
    const rainRisk = Math.round(Number(risks.intenseRain) || 0);
    const rainIntensity = Number(cell.maximum);
    const rainIntensityLabel = Number.isFinite(rainIntensity)
      ? rainIntensity.toLocaleString("fr-FR", { minimumFractionDigits: rainIntensity < 1 ? 2 : 1, maximumFractionDigits: 2 }) + " mm/h"
      : null;
    const flashes = metric.flashes;
    const rainLevel = metric.rainLevel;
    const hailLevel = metric.hailLevel;
    const lightningLevel = metric.lightningLevel;
    const rainPictogram = nowcastMetricPictogram("rain", rainLevel, "Pluie : niveau " + rainLevel + " sur 5 · risque de pluie intense " + rainRisk + " %" + (rainIntensityLabel ? " · intensité radar maximale " + rainIntensityLabel : ""), true, true, false);
    const hailLabel = "Grêle : " + metric.hailLabel;
    const hailPictogram = nowcastMetricPictogram("hail", hailLevel, hailLabel, true, true, false);
    const lightningLabel = lightning == null
      ? (window.METEO_REPLAY ? "Foudre : donnée non archivée" : "Foudre : donnée indisponible")
      : "Foudre : niveau " + lightningLevel + " sur 5 · " + flashes + (flashes === 1 ? " éclair détecté" : " éclairs détectés") + " près de la cellule";
    const lightningPictogram = nowcastMetricPictogram("lightning", lightningLevel, lightningLabel, true, true, false);
    const distanceKm = metric.distanceKm;
    const distance = distanceKm.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " km";
    const etaMinutes = metric.arrivalAt == null ? null : Math.max(0, (metric.arrivalAt - now) / 60000);
    const hasEta = Number.isFinite(etaMinutes) && etaMinutes >= 0 && etaMinutes <= 240;
    const etaText = hasEta
      ? etaMinutes < 1 ? "0min" : compactMinutesLabel(Math.max(1, etaMinutes))
      : "—";
    const etaDetail = hasEta
      ? etaMinutes < 1 ? "ETA 0min" : "ETA dans " + compactMinutesLabel(Math.max(1, etaMinutes))
      : "ETA non calculée";
    const speed = Number(cell.track?.speedKmh);
    const speedText = Number.isFinite(speed) ? speed.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) : "—";
    const trackedSince = cell.trackedSince ? hourFormat.format(new Date(cell.trackedSince)) : "—";
    const confidence = cell.track?.confidence == null ? null : Math.round(Number(cell.track.confidence));
    const confidenceText = Number.isFinite(confidence) ? confidence + " %" : "—";
    const label = "Cellule " + cell.id + " · bord à " + distance + " des Tatins · passage " + passageText + " · " + etaDetail
      + " · grêle " + hailLevel + " sur 5 · pluie " + rainLevel + " sur 5 · foudre " + lightningLevel + " sur 5"
      + " · vitesse " + speedText + " km/h · suivie depuis " + trackedSince + " · confiance trajectoire " + confidenceText;
    const markup = '<div class="nowcast-cell-map-head"><strong>' + escapeText(cell.id) + '</strong><span>' + escapeText(distance) + '</span><b>Passage ' + escapeText(passageText) + '</b><b>ETA ' + escapeText(etaText) + '</b></div>'
      + '<div class="nowcast-cell-map-intensities" aria-label="Intensités grêle, pluie et foudre"><span class="hail">' + hailPictogram + '</span><span class="rain">' + rainPictogram + '</span><span class="lightning">' + lightningPictogram + '</span></div>'
      + '<div class="nowcast-cell-map-meta"><span><small>vitesse</small><b>' + escapeText(speedText) + ' km/h</b></span><span><small>suivi depuis</small><b>' + escapeText(trackedSince) + '</b></span><span><small>trajectoire</small><b>' + escapeText(confidenceText) + '</b></span></div>';
    return { tone: riskTone(passageRisk || 0), label, markup, passageRisk };
  };

  const cellsInRange = (radar.cells || []).filter(cell => metrics.has(String(cell.id)) && metrics.get(String(cell.id)).distanceKm <= activeNowcastMapRadius);
  const cellPresentations = new Map(cellsInRange.map(cell => [String(cell.id), cellPresentation(cell)]));
  const generalExpertise = '<section class="storm-summary storm-general"><div class="three-hour-actions">'
    + summaryAction('rain', rainMessageSequence.length ? rainMessageSequence : rainValue, rainColorLevel, rainDetail, rainMessageSequence.length ? rainTrend : null, 'rain')
    + summaryAction('storm', '', stormCombinedLevel, stormDetail, stormTrend, 'nowcast', stormCombinedLevel, { passage: stormDetail, trend: stormTrendDetail, eta: stormEtaLabel, duration: stormDurationLabel, etaDetail: stormEtaDetail })
    + summaryAction('wind', windValue, windLevel, windDetail, windTrendWithDetail, 'wind48', null, null, windColorLevel, true)
    + '</div></section>';
  if (summaryElement) {
    summaryElement.innerHTML = sandboxThreeHourTimeline(forecast.timelineSlots, now, forecast.ongoingStorm);
    initializeThreeHourMessageSequence(summaryElement);
    summaryElement.querySelector(".horizon-scroll")?.addEventListener("click", event => { if (!event.target.closest("button")) sandboxToggleRainDetails(); });
    sandboxBindRainScroll();
    summaryElement.querySelectorAll('[data-summary-target]').forEach(button => {
      if (button.dataset.summaryTarget === "wind48") {
        button.setAttribute("aria-controls", "panel-48h");
        button.setAttribute("aria-expanded", String(!$("panel-48h").hidden && $("panel-48h").dataset.focusMetric === "wind"));
        button.addEventListener("click", open48HourWindForecast);
        return;
      }
      const details = $(button.dataset.summaryTarget + "-details");
      button.setAttribute("aria-controls", details?.id || "");
      button.setAttribute("aria-expanded", String(details ? !details.hidden : false));
      button.addEventListener('click', () => {
        if (button.dataset.summaryTarget === "rain" && button.closest(".horizon-scroll")) { sandboxToggleRainDetails(); return; }
        if (!details) return;
        if (button.dataset.summaryTarget === "nowcast") {
          setNowcastOpen(details.hidden, details.hidden);
          return;
        }
        details.hidden = !details.hidden;
        button.setAttribute("aria-expanded", String(!details.hidden));
      });
    });
  }
  const mapControlsMarkup = '<div class="forecast-source-selector storm-map-controls" aria-label="Portée de la carte"><button class="forecast-source-button' + (activeNowcastMapRadius === 20 ? ' active' : '') + '" type="button" data-nowcast-radius="20" aria-pressed="' + (activeNowcastMapRadius === 20) + '">20 km</button><button class="forecast-source-button' + (activeNowcastMapRadius === 60 ? ' active' : '') + '" type="button" data-nowcast-radius="60" aria-pressed="' + (activeNowcastMapRadius === 60) + '">60 km</button></div>';
  element.innerHTML = '<div class="nowcast-workspace"><div class="nowcast-map-column">' + mapControlsMarkup + renderThreatMap(radar, lightning, activeNowcastMapRadius, cellPresentations) + '</div></div>';
  initializeNowcastCellOverlays(element);
  initializeNowcastMapBackground(activeNowcastMapRadius);
  element.querySelectorAll("[data-nowcast-radius]").forEach(button => button.addEventListener("click", event => {
    nowcastMapRadiusManuallySelected = true;
    activeNowcastMapRadius = Number(event.currentTarget.dataset.nowcastRadius) === 20 ? 20 : 60;
    try {
      sessionStorage.setItem(nowcastMapRadiusSessionKey, String(activeNowcastMapRadius));
    } catch {}
    renderRadarNowcast(radar, piaf, arome, lightning, vigilance);
  }));
  bindChartTooltips();
}

function renderPiaf(piaf, radar = null) {
  if (!piaf?.values?.length) return;
  const isOpenMeteo = piaf.source === "openmeteo";
  const precipitationSourceLabel = piaf.source === "radar-archive" ? "Radar archivé" : "PIAF";
  const isTimedForecast = isOpenMeteo || piaf.source === "arome";
  const runTime = piafRunTime(piaf);
  const piafBaseTime = new Date(Number.isFinite(runTime) ? runTime : piaf.fetchedAt || Date.now());
  piafBaseTime.setMilliseconds(0);
  // PIAF arrive toutes les 5 minutes. La frise publique regroupe trois pas
  // afin de présenter des cumuls exacts de 15 minutes issus du même run.
  const values = isTimedForecast ? piaf.values : piafQuarterHourRain(piaf, radar).filter(item => item.intervalEnd > appNow());
  const slotTimes = values.map(item => item.slotTime || (isTimedForecast ? new Date(item.time) : new Date(piafBaseTime.getTime() + item.seconds * 1000)));
  const precipitationFor = item => Number(item.nowcastPrecipitation ?? item.precipitation) || 0;
  const slotIntervalFor = (item, index) => {
    const explicitStart = Number(item.intervalStart ?? item.rainIntervalStart);
    const explicitEnd = Number(item.intervalEnd ?? item.rainIntervalEnd);
    if (Number.isFinite(explicitStart) && Number.isFinite(explicitEnd) && explicitEnd > explicitStart) {
      return { start: explicitStart, end: explicitEnd };
    }
    const current = slotTimes[index].getTime();
    const next = slotTimes[index + 1]?.getTime();
    const previous = slotTimes[index - 1]?.getTime();
    if (isTimedForecast && Number.isFinite(next)) return { start: current, end: next };
    if (isTimedForecast) return { start: current, end: current + 15 * 60000 };
    const duration = Number.isFinite(previous) ? current - previous : 15 * 60000;
    return { start: current - Math.max(5 * 60000, duration), end: current };
  };
  const slotIntervals = values.map(slotIntervalFor);
  const cellEtaSlots = new Map(values.map((item, index) => [index, item.cellPassages || []]));
  // La correction d'unité radar rend désormais les cumuls réels. Revenir à
  // 4 mm en 15 minutes évite de saturer les épisodes modérés à soutenus.
  const fullScaleRain = 4;
  $("rain-bars").style.gridTemplateColumns = "repeat(" + values.length + ", minmax(0, 1fr))";
  $("rain-axis").style.gridTemplateColumns = "repeat(" + values.length + ", minmax(0, 1fr))";
  $("rain-axis").innerHTML = slotTimes.map((time, index) => {
    // Les runs PIAF ne commencent pas forcément sur un quart d'heure rond.
    // Le responsive suit donc les pas de la frise, pas les minutes de l'horloge :
    // tous les pas, un sur deux sur smartphone, un sur quatre si très étroit.
    return '<span class="rain-axis-tick' + (index % 2 === 0 ? ' half-hour-tick' : '') + (index % 4 === 0 ? ' exact-hour' : '') + '" style="grid-column:' + (index + 1) + '">' + hourFormat.format(time) + '</span>';
  }).join("");
  const slices = values.map((item, index) => {
    // Blue is the unmodified PIAF accumulation. Radar and cell ETA amounts
    // are drawn separately in orange so the source of a high total remains
    // visible instead of making PIAF itself look excessive.
    const precipitation = Math.max(0, Number(item.precipitation) || 0);
    const nowcastTotal = Math.max(precipitation, Number(item.totalPrecipitation ?? item.nowcastPrecipitation) || 0);
    // Seuil d'annonce sur le cumul brut du créneau, toutes sources confondues.
    const announcedRain = nowcastTotal > .01 + 1e-9;
    const wet = precipitation > 0 && announcedRain;
    // PIAF est déterministe : aucun pourcentage artificiel n'est affiché.
    // Open-Meteo fournit en revanche une probabilité horaire distincte.
    const probability = isOpenMeteo && Number.isFinite(item.probability) ? Number(item.probability) : null;
    const risk = !wet && probability >= rainRiskDisplayThreshold;
    const trace = wet && precipitation < .1;
    // Le graphique représente une quantité de pluie, pas sa part relative au
    // maximum courant. Les traces conservent seulement un filet visible.
    const height = trace ? 2 : wet ? Math.min(100, Math.max(2, precipitation / fullScaleRain * 100)) : 0;
    // Si une quantité est dessinée, afficher cette quantité plutôt qu'un 0 %
    // provenant d'une source probabiliste distincte.
    const label = trace ? "pluie faible" : wet ? precipitation.toFixed(2) + " mm" : risk ? probability + "%" : "";
    const slotTime = hourFormat.format(new Date(slotIntervals[index].start)) + "–" + hourFormat.format(new Date(slotIntervals[index].end));
    const coveredMinutes = Number.isFinite(item.intervalStart) && Number.isFinite(item.intervalEnd) ? Math.round((item.intervalEnd - item.intervalStart) / 60000) : 15;
    const periodDetail = piaf.source === "arome" ? " (cumul sur 1 h)" : item.complete === false ? " (cumul partiel sur " + coveredMinutes + " min)" : " (cumul sur 15 min)";
    const nowcastDetail = nowcastTotal - precipitation > .01 + 1e-9
      ? "\nAvec nowcasting : " + nowcastTotal.toFixed(2) + " mm (estimation, passage à confirmer)" : "";
    const detail = (isOpenMeteo && !wet && probability != null ? slotTime + " · risque de pluie · probabilité de précipitations " + probability + "% · aucun cumul prévu" : slotTime + " · " + precipitationSourceLabel + " " + precipitation.toFixed(2) + " mm" + periodDetail) + nowcastDetail
      + (item.piafUnconfirmed && announcedRain ? "\nPluie possible : PIAF non confirmé par le nowcasting récent aux Tatins." : "");
    const visibleLabel = label;
    return '<div class="now-slice chart-point' + (risk ? " averse-risk" : "") + (trace ? " trace" : "") + '" style="grid-column:' + (index + 1) + ';grid-row:1;--rain-height:' + height + '%" tabindex="0" data-tooltip="' + escapeText(detail) + '"><span class="now-value"' + (trace ? ' data-mobile-label="≈"' : '') + '>' + visibleLabel + '</span><div class="now-bar' + (wet ? " active" : "") + '" style="height:' + height + '%"></div></div>';
  }).join("");
  const aversePeriods = values.map((item, index) => isOpenMeteo && precipitationFor(item) <= 0 && Number(item.probability) >= rainRiskDisplayThreshold
    ? '<span class="now-averse-period" data-mobile-label="Pluie" style="grid-column:' + (index + 1) + ';grid-row:1">Pluie possible</span>'
    : '').join('');
  const cellPeriods = values.map((item, index) => {
    const entries = cellEtaSlots.get(index) || [];
    entries.sort((left, right) => right.passage - left.passage || left.etaMinutes - right.etaMinutes);
    const basePiaf = Math.max(0, Number(item.precipitation) || 0);
    const radarAmendment = Math.max(0, Number(item.effectiveRadarAmendment) || 0);
    const etaRain = Math.max(0, ...entries.filter(entry => entry.amountReliable).map(entry => Number(entry.etaRain) || 0));
    const interval = slotIntervals[index];
    const radarObservedAt = Date.parse(radar?.observedAt || "");
    const observed = item.radarCellOverPoint === true
      && Number.isFinite(radarObservedAt)
      && radarObservedAt >= interval.start && radarObservedAt < interval.end;
    // Reprendre le cumul agrégé de la frise, y compris le radar extrapolé
    // sur les créneaux futurs. Radar et ETA représentent la même pluie.
    const totalRain = Math.max(basePiaf + radarAmendment,
      Number(item.totalPrecipitation ?? item.nowcastPrecipitation) || 0, etaRain, basePiaf);
    const difference = totalRain - basePiaf;
    const quantitative = difference > .01 + 1e-9 ? difference : 0;
    if (!entries.length && quantitative <= 0) return '';
    const passage = entries.length ? Math.max(...entries.map(entry => Number(entry.passage) || 0)) : null;
    const baseHeight = Math.min(100, basePiaf / fullScaleRain * 100);
    const amendmentBottom = Math.min(97, baseHeight);
    const presenceOnly = !observed && quantitative <= 0;
    const totalHeight = Math.min(100, Math.max(3, totalRain / fullScaleRain * 100));
    const amendmentHeight = presenceOnly
      ? Math.min(100 - amendmentBottom, 4)
      : Math.min(100 - amendmentBottom, Math.max(3, totalHeight - amendmentBottom));
    const alpha = passage == null ? .58 : Math.max(.32, Math.min(.86, .22 + passage / 100 * .72));
    const label = [quantitative > 0 ? totalRain.toFixed(2) + " mm" : "", passage > 0 ? Math.round(passage) + " %" : ""].filter(Boolean).join(" · ");
    const etaWindowStart = entries.length ? Math.min(...entries.map(entry => entry.eventStart)) : null;
    const etaWindowEnd = entries.length ? Math.max(...entries.map(entry => entry.eventEnd)) : null;
    const etaLabels = [...new Set(entries.map(entry => (entry.etaBasis === "envelope" ? "ETA possible " : "ETA ") + shortEtaLabel(entry.etaMinutes)))].slice(0, 2);
    const piafPeriod = piaf.source === "arome"
      ? " sur 1 h"
      : item.complete === false ? " sur " + Math.max(5, Math.round((Number(item.intervalEnd) - Number(item.intervalStart)) / 60000)) + " min" : " sur 15 min";
    const detail = "PIAF : " + basePiaf.toFixed(2) + " mm" + piafPeriod
      + (observed && radarAmendment > .01 ? "\nNowcasting observé : +" + radarAmendment.toFixed(2) + " mm" : "")
      + (!observed && quantitative > 0 ? "\nNowcasting prévu si passage : +" + quantitative.toFixed(2) + " mm" : "")
      + (presenceOnly ? "\nPrésence possible, cumul non assez stable" : "\nTotal affiché : " + totalRain.toFixed(2) + " mm")
      + (passage != null ? "\nProbabilité de passage : " + passage + " %" : "")
      + (etaLabels.length ? "\n" + etaLabels.join(" · ") : "")
      + (etaWindowStart != null && etaWindowEnd != null ? "\nPrésence : " + hourFormat.format(new Date(etaWindowStart)) + "–" + hourFormat.format(new Date(etaWindowEnd)) : "")
      + "\nClic : ouvrir la carte";
    const labelMarkup = label ? '<span class="now-cell-overlay-label">' + escapeText(label) + '</span>' : '';
    return '<button class="now-cell-overlay chart-point' + (presenceOnly ? ' presence-only' : '') + (observed ? ' observed' : '') + '" type="button" data-open-nowcast="true" data-tooltip="' + escapeText(detail) + '" style="grid-column:' + (index + 1) + ';grid-row:1;--amendment-bottom:' + amendmentBottom.toFixed(1) + '%;--amendment-height:' + amendmentHeight.toFixed(1) + '%;--eta-opacity:' + alpha.toFixed(2) + '" aria-label="' + escapeText(detail) + '"><span class="now-cell-overlay-fill" aria-hidden="true"></span>' + labelMarkup + '</button>';
  }).join('');
  const noRainPeriod = !isOpenMeteo && values.every(item => precipitationFor(item) <= 0)
    ? '<span class="now-no-rain-period">Pas de pluie</span>'
    : '';
  sandboxSyncRainDetails(slotIntervals);
  $("rain-bars").innerHTML = slices + aversePeriods + cellPeriods + noRainPeriod;
  $("rain-bars").querySelectorAll("[data-open-nowcast]").forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    setNowcastOpen(true, true);
  }));
  bindChartTooltips();
}

function applyDashboardPayload(payload) {
    const receivedData = payload.data;
    // PIAF is intentionally absent from the public payload while its
    // four-minute cache is being refreshed. Keep the previous complete run
    // during that short gap so both rain views switch atomically to the next
    // run instead of briefly falling back to AROME.
    const data = receivedData && !receivedData.nowcast && !receivedData.piaf && latestForecastData?.piaf
      ? { ...receivedData, piaf: latestForecastData.piaf }
      : receivedData;
    dashboardSync = { status: payload.status, error: payload.error || null };
    latestForecastData = data;
    clearTimeout(nowcastExpiryTimer);
    if (!window.METEO_REPLAY && data?.nowcast?.validUntil > appNow()) {
      nowcastExpiryTimer = setTimeout(() => { renderActiveRain(); renderActiveForecast(); }, data.nowcast.validUntil - appNow() + 1);
    }
    if (!latestWeekForecast?.days?.length && data?.openMeteo?.days?.length) {
      const detailedDays = normalizeDashboardOpenMeteoDays(data.openMeteo);
      latestWeekForecast = {
        fetchedAt: data.openMeteo.fetchedAt || Date.now(),
        model: "Open-Meteo via serveur",
        days: detailedDays.length ? detailedDays : data.openMeteo.days.map(dashboardOpenMeteoWeekDay)
      };
      renderWeekForecast();
    }
    refreshSourceIndicators();
    const vigilanceStamp = data?.vigilance?.fetchedAt || 0;
    if (vigilanceStamp !== lastVigilanceStamp) {
      lastVigilanceStamp = vigilanceStamp;
      renderWeekForecast();
    }
    // Désactivé temporairement : ne plus afficher systématiquement le bandeau
    // « Perturbation en approche ». La fonction est
    // conservée pour pouvoir réutiliser ces informations sous une autre forme.
    // renderApproachingCellsAlert(data?.radar);
    const aromeStamp = data?.arome?.fetchedAt || 0;
    const piafStamp = data?.piaf?.fetchedAt || 0;
    const radarStamp = data?.radar?.fetchedAt || 0;
    const pearomeStamp = data?.pearome?.fetchedAt || 0;
    const ensembleStamp = data?.ensemble?.fetchedAt || 0;
    const openMeteoStamp = data?.openMeteo?.fetchedAt || 0;
    if ((data?.arome || (window.METEO_REPLAY && data?.openMeteo)) && (aromeStamp !== lastAromeStamp || piafStamp !== lastPiafStamp || radarStamp !== lastRadarStamp || pearomeStamp !== lastPearomeStamp || ensembleStamp !== lastEnsembleStamp || openMeteoStamp !== lastOpenMeteoStamp)) {
      lastAromeStamp = aromeStamp;
      lastPiafStamp = piafStamp;
      lastRadarStamp = radarStamp;
      lastPearomeStamp = pearomeStamp;
      lastEnsembleStamp = ensembleStamp;
      lastOpenMeteoStamp = openMeteoStamp;
      renderActiveForecast();
      // Les cartes quotidiennes reprennent le détail pluie/orages de la
      // frise. Les recalculer sur le même changement de run empêche les
      // deux vues de conserver temporairement des horaires différents.
      renderWeekForecast();
    }
    if (data && (data.piaf || data.openMeteo || data.radar)) {
      lastPiafStamp = piafStamp;
      lastRadarStamp = radarStamp;
      renderActiveRain();
    }
}

async function refresh() {
  try {
    const dashboardPath = "api/dashboard?lat=" + point.lat + "&lon=" + point.lon;
    if (!dashboardCacheHydrated) {
      dashboardCacheHydrated = true;
      const cachedPayload = await readCachedJson(apiUrl(dashboardPath), 3 * 3600000);
      if (cachedPayload?.data) applyDashboardPayload(cachedPayload);
    }
    const payload = await json(dashboardPath);
    applyDashboardPayload(payload);
    scheduleRefresh(payload.status === "loading" ? 3000 : 60000);
  } catch (error) {
    console.error(error);
    dashboardSync = { status: "error", error: error.message };
    refreshSourceIndicators();
    scheduleRefresh(10000);
  }
}

function scheduleRefresh(delay) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, delay);
}

function renderNewsBanner(news) {
  const banner = $("news-alert");
  const message = $("news-alert-message");
  if (!banner || !message) return;
  const visible = news?.active === true && Boolean(String(news.banner || "").trim());
  message.textContent = visible ? news.banner.trim() : "";
  banner.hidden = !visible;
}

async function renderAppVersion() {
  let releaseNumber = "";
  try {
    const config = await json("api/config");
    releaseNumber = String(runtimeConfig.releaseNumber || config.releaseNumber || "");
    renderNewsBanner(config.news);
  } catch {}
  if (!/^\d+\.\d{3}$/.test(releaseNumber)) {
    try {
      const changelog = await fetch(runtimeConfig.changelogUrl || "changelog", { cache: "no-store" }).then(response => response.ok ? response.text() : "");
      const versions = [...changelog.matchAll(/\bv(\d+\.\d{3})\b/g)];
      releaseNumber = versions.at(-1)?.[1] || "";
    } catch {}
  }
  if (/^\d+\.\d{3}$/.test(releaseNumber)) {
    const version = $("app-version");
    if (runtimeConfig.changelogUrl) version.href = runtimeConfig.changelogUrl;
    version.textContent = "v" + releaseNumber;
    version.hidden = false;
  }
  clearTimeout(renderAppVersion.timer);
  renderAppVersion.timer = setTimeout(renderAppVersion, 60000);
}

function setNowcastOpen(open, scroll = false) {
  const link = $("header-nowcast-link");
  const details = $("nowcast-details");
  const titleToggle = $("nowcast-title-toggle");
  if (!details) return;
  details.hidden = !open;
  link?.setAttribute("aria-expanded", String(open));
  titleToggle?.setAttribute("aria-expanded", String(open));
  $("horizon-nowcast-toggle")?.setAttribute("aria-expanded", String(open));
  document.querySelector('[data-summary-target="nowcast"]')?.setAttribute("aria-expanded", String(open));
  if (open) ensureLeafletAssets()
    .then(() => initializeNowcastMapBackground(activeNowcastMapRadius))
    .catch(error => console.warn("Fond de carte Nowcasting indisponible", error));
  if (open && scroll) details.scrollIntoView({ behavior: "smooth", block: "start" });
}

function bindHeaderNowcastLink() {
  $("horizon-nowcast-toggle")?.addEventListener("click", () => setNowcastOpen($("nowcast-details").hidden));
  const link = $("header-nowcast-link");
  const details = $("nowcast-details");
  const titleToggle = $("nowcast-title-toggle");
  if (!link || !details || !titleToggle) return;
  link.addEventListener("click", event => {
    event.preventDefault();
    setNowcastOpen(details.hidden, details.hidden);
  });
  titleToggle.addEventListener("click", () => setNowcastOpen(details.hidden));
  document.addEventListener("click", event => {
    const trigger = event.target.closest("[data-open-nowcast-link]");
    if (!trigger) return;
    event.preventDefault();
    setNowcastOpen(true, true);
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || window.METEO_REPLAY) return;
  let reloadPending = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadPending) return;
    reloadPending = true;
    window.location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(new URL("service-worker.js", document.baseURI), { updateViaCache: "none" })
      .then(registration => registration.update())
      .catch(error => console.warn("Service worker indisponible", error));
  }, { once: true });
}

bindForecastLayout();
bindHeaderNowcastLink();
registerServiceWorker();
if (window.location.hash === "#radar-nowcast") {
  const nowcastDetails = $("nowcast-details");
  if (nowcastDetails) {
    nowcastDetails.hidden = false;
    $("header-nowcast-link")?.setAttribute("aria-expanded", "true");
    $("nowcast-title-toggle")?.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => $("radar-nowcast")?.scrollIntoView({ block: "start" }));
  }
}
renderAppVersion();
if (window.METEO_REPLAY?.start) import(replayEngineUrl.href).then(({ createNowcastEngine }) => {
  let snapshot = null;
  let lastTime = -Infinity;
  let lastData = null;
  let lastForecast = null;
  window.METEO_REPLAY.start({ applyDashboardPayload(payload) {
    if (!payload.data) return applyDashboardPayload(payload);
    const now = appNow();
    if (now < lastTime) snapshot = null;
    const signature = JSON.stringify(payload.data);
    if (now !== lastTime || signature !== lastData) {
      lastForecast = createNowcastEngine({ now, snapshot, replay: true }).compute(payload.data);
      snapshot = lastForecast?.projectionSnapshot || null;
      lastTime = now;
      lastData = signature;
    }
    applyDashboardPayload({ ...payload, data: { ...payload.data, nowcast: lastForecast } });
  } });
}).catch(error => { console.error("Moteur du replay indisponible", error); });
else refresh();

function sandboxNowcastDimensions() {
  return { width: window.matchMedia("(max-width: 600px)").matches ? 360 : 640, height: 360 };
}
function sandboxNowcastContext(label, detail) {
  return '<button type="button" class="horizon-nowcast-context" data-open-nowcast-link="true" aria-controls="nowcast-details" title="' + escapeText(detail) + '"><span>Nowcasting</span><strong>' + escapeText(label) + '</strong><small>Carte ↗</small></button>';
}
function sandboxCloudLevel(value, hasPhenomenon = false) {
  const cloud = value == null ? NaN : Number(value);
  const level = !Number.isFinite(cloud) ? (hasPhenomenon ? 5 : 3)
    : cloud <= 5 ? 0 : cloud <= 25 ? 1 : cloud <= 50 ? 2 : cloud <= 75 ? 3 : cloud <= 90 ? 4 : 5;
  return hasPhenomenon ? Math.max(1, level) : level;
}
function sandboxSkyPresentation(slot) {
  const hasPhenomenon = slot.level > 0 || Boolean(slot.storm) || Boolean(slot.hail);
  const level = sandboxCloudLevel(slot.cloudCover, hasPhenomenon);
  const labels = ["dégagé", "très peu nuageux", "peu nuageux", "nuageux", "très nuageux", "couvert"];
  const suffixes = ["1", "tres-peu-nuageux", "2", "3", "4", "5"];
  const period = slot.night ? "nuit" : "jour";
  return {
    level,
    label: (slot.night ? "Nuit, ciel " : "Ciel ") + labels[level],
    src: "pictogrammes/ciel-" + period + "-" + suffixes[level] + ".svg"
  };
}
function sandboxStormPresentation(slot, now) {
  if (!slot.storm) return null;
  const observed = slot.storm.locallyObserved && slot.start <= now && now < slot.end;
  const qualifier = observed ? "en cours" : shortTermRiskQualifier(slot.storm.passage).trim();
  const intensity = slot.storm.level >= 4 ? "violent" : slot.storm.level >= 2 ? "modéré" : "faible";
  return { label: ["Orage", qualifier].filter(Boolean).join(" "), intensity, observed };
}
function sandboxSlotPresentation(slot, now) {
  const sky = sandboxSkyPresentation(slot);
  const storm = sandboxStormPresentation(slot, now);
  const rain = slot.level > 0 && slot.label !== "Grêle";
  const unavailable = slot.label === "Indisponible";
  const qualifier = slot.label === "Gouttes" ? slot.qualifier.replace(/^(possible|probable)$/, "$1s") : slot.qualifier;
  let title = unavailable ? "Indisponible" : rain ? slot.label : storm ? "Orage" : slot.hail ? "Grêle" : sky.label.replace(/^Nuit, ciel |^Ciel /, "Ciel ");
  const details = [];
  if (rain && qualifier) details.push(qualifier);
  if (storm) details.push(storm.label + (storm.intensity ? " · " + storm.intensity : ""));
  if (slot.hail) {
    const hailQualifier = slot.hailLocalized == null ? shortTermRiskQualifier(slot.hailRisk).trim() : "possible";
    if (title !== "Grêle") details.push(["Grêle", hailQualifier].filter(Boolean).join(" "));
    else if (hailQualifier) details.push(hailQualifier);
    if (Number.isFinite(Number(slot.hailRisk))) details.push("passage cellule " + Math.round(slot.hailRisk) + " %");
  }
  if (slot.hail && storm && !rain) title = "Orage · grêle";
  const wind = slot.wind >= 2;
  return {
    sky, storm, rain, unavailable, title, details,
    signature: JSON.stringify([sky.level, slot.night, slot.level, title, details, Boolean(slot.hail), wind ? slot.wind : 0])
  };
}
function sandboxWeatherGroups(slots, now) {
  const groups = [];
  slots.forEach((slot, index) => {
    const presentation = sandboxSlotPresentation(slot, now);
    const previous = groups.at(-1);
    if (previous?.presentation.signature === presentation.signature && previous.slot.end === slot.start) {
      previous.endIndex = index + 1;
      previous.slot.end = slot.end;
      previous.slot.total += slot.total;
      previous.slot.windSpeed = Math.max(previous.slot.windSpeed || 0, slot.windSpeed || 0);
      previous.slot.windGust = Math.max(previous.slot.windGust || 0, slot.windGust || 0);
      if (Number.isFinite(previous.slot.hailRisk) || Number.isFinite(slot.hailRisk)) {
        previous.slot.hailRisk = Math.max(Number(previous.slot.hailRisk) || 0, Number(slot.hailRisk) || 0);
      }
      if (Number.isFinite(previous.slot.hailScore) || Number.isFinite(slot.hailScore)) {
        previous.slot.hailScore = Math.max(Number(previous.slot.hailScore) || 0, Number(slot.hailScore) || 0);
      }
    } else groups.push({ presentation, startIndex: index, endIndex: index + 1, slot: { ...slot } });
  });
  return groups;
}
function sandboxStartNearHour(start, end) {
  const nextHour = (Math.floor(start / 3600000) + 1) * 3600000;
  return nextHour - start < 30 * 60000 && nextHour <= end;
}
function sandboxQuietBoundary(boundary, start, end) {
  const hideStart = sandboxStartNearHour(start, end);
  if (boundary === start) return !hideStart;
  return boundary === end || (boundary % 3600000 === 0
    && (hideStart || boundary - start >= 30 * 60000) && end - boundary >= 30 * 60000);
}
function sandboxThreeHourAxis(slots, time) {
  const start = slots[0].start, end = slots.at(-1).end;
  const position = value => (value - start) / (end - start) * 100;
  const ticks = [start, ...slots.map(slot => slot.end)].filter(boundary => boundary % 900000 === 0).map(boundary =>
    '<span class="horizon-minute' + (sandboxQuietBoundary(boundary, start, end) ? '' : ' quiet-minor') + (boundary === start && sandboxStartNearHour(start, end) ? ' near-hour-start' : '') + '" style="left:' + position(boundary) + '%" aria-label="' + time(boundary) + '" title="' + time(boundary) + '">' + time(boundary) + '</span>');
  return '<div class="horizon-axis">' + ticks.join('') + '</div>';
}
function sandboxThreeHourTimeline(preparedSlots, now, ongoingStorm = null) {
  const probabilityStep = value => value <= 0 ? 0 : value < 20 ? 1 : value < 40 ? 2 : value < 60 ? 3 : value < 80 ? 4 : 5;
  const slots = (preparedSlots || []).filter(slot => slot.end > now).map(slot => ({ ...slot }));
  if (!slots.length) return '<p class="horizon-empty">Prévision indisponible</p>';
  const time = value => hourFormat.format(new Date(value));
  const windIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 7h12c6 0 6-6 1-6M2 12h17c5 0 5 7 0 7M2 17h7c5 0 5 6 1 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const clock = value => {
    const [hour, minute] = time(value).split(":");
    return Number(hour) + " h" + (minute === "00" ? "" : " " + minute);
  };
  const groups = sandboxWeatherGroups(slots, now);
  const quiet = groups.length === 1 && !groups[0].presentation.rain && !groups[0].presentation.storm && !groups[0].slot.hail && !(groups[0].slot.wind >= 2);
  const renderIcon = (slot, presentation) => {
    const layers = [presentation.sky.src];
    if (slot.level > 0) layers.push("pictogrammes/calque-pluie-" + Math.max(1, Math.min(5, slot.level)) + ".svg");
    if (slot.wind >= 2) layers.push("pictogrammes/calque-vent.svg");
    if (slot.storm) layers.push("pictogrammes/calque-orage.svg");
    if (slot.hail) layers.push("pictogrammes/calque-grele.svg");
    const alt = [presentation.sky.label, presentation.title, ...presentation.details, slot.wind >= 2 ? shortTermWindLabel(slot.wind) : ""].filter(Boolean).join(" · ");
    return '<span class="horizon-period-icon" role="img" aria-label="' + escapeText(alt) + '">' + layers.map(src => '<img src="' + src + '" alt="" loading="lazy" decoding="async">').join("") + '</span>';
  };
  const renderGroup = ({ slot, presentation, startIndex, endIndex }) => {
    const duration = slot.end - slot.start;
    const periodLabel = endIndex - startIndex > 1 || duration !== 15 * 60000 ? clock(slot.start) + " – " + clock(slot.end) : clock(slot.start);
    const stormTone = slot.storm ? stormRiskIntensityStep(presentation.storm?.observed ? 5 : probabilityStep(slot.storm.passage), slot.storm.level) : 0;
    const hailTone = slot.hail ? probabilityStep(slot.hailRisk) : 0;
    const tone = Math.max(slot.level || 0, slot.wind || 0, stormTone, hailTone);
    const possible = /possible/.test(slot.qualifier || "") || /possible/.test(presentation.storm?.label || "") || slot.hail && slot.hailLocalized !== true;
    const clear = !presentation.rain && !presentation.storm && !slot.hail && !(slot.wind >= 2) && presentation.sky.level === 0;
    const description = periodLabel + " : " + [presentation.title, ...presentation.details].filter(Boolean).join(" · ")
      + (slot.hailLocalized === false ? " · noyau de grêle non localisé dans les données" : "")
      + (slot.hail && slot.hailScore != null ? " · indice polarimétrique de la zone " + Math.round(slot.hailScore) + " % (indice non probabiliste)" : "");
    const mainTag = presentation.rain ? "button" : "div";
    const mainAction = presentation.rain ? ' type="button" data-summary-target="rain"' : '';
    const windMaximum = Math.round(Math.max(slot.windGust || 0, slot.windSpeed || 0));
    const windLabel = windMaximum > 0 ? "max " + windMaximum + " km/h" : shortTermWindLabel(slot.wind);
    const windMarkup = slot.wind >= 2 ? '<button type="button" class="horizon-period-wind" data-summary-target="wind48" aria-label="' + escapeText(shortTermWindLabel(slot.wind) + (windMaximum ? " · " + windLabel : "")) + '">' + windIcon + '<span>' + escapeText(windLabel) + '</span></button>' : '<span class="horizon-period-wind-spacer" aria-hidden="true"></span>';
    return '<article class="horizon-period tone-' + tone + (clear ? ' is-clear' : '') + (possible ? ' is-possible' : '') + (slot.hail ? ' is-hail' : '') + (slot.label === 'Gouttes' ? ' is-drizzle' : '') + (presentation.unavailable ? ' is-unavailable' : '') + '" style="grid-column:' + (startIndex + 1) + '/' + (endIndex + 1) + '" aria-label="' + escapeText(description) + '">' 
      + '<time datetime="' + new Date(slot.start).toISOString() + '">' + escapeText(periodLabel) + '</time>'
      + '<' + mainTag + mainAction + ' class="horizon-period-main" title="' + escapeText(description) + '">' + renderIcon(slot, presentation) + '<strong>' + escapeText(presentation.title) + '</strong><span class="horizon-period-details">' + presentation.details.map(detail => '<span>' + escapeText(detail) + '</span>').join('') + '</span></' + mainTag + '>'
      + windMarkup + '</article>';
  };
  return '<section class="horizon-scroll' + (quiet ? ' is-quiet' : '') + '" aria-label="Prévisions météo regroupées des trois prochaines heures"><div class="horizon-timeline" style="grid-template-columns:' + slots.map(slot => (slot.end - slot.start) + 'fr').join(' ') + '">'
    + groups.map(renderGroup).join('') + '</div></section>';
}

function sandboxToggleRainDetails() {
  const rain = $("rain-details");
  const open = rain.hidden;
  rain.hidden = !open;
  document.querySelectorAll('.horizon-scroll [data-summary-target="rain"]').forEach(button => {
    button.setAttribute("aria-controls", "rain-details");
    button.setAttribute("aria-expanded", String(open));
  });
}
function sandboxSyncRainDetails(intervals) {
  const slots = intervals.map((interval, index) => ({start: index === 0 ? Math.floor(interval.start / 900000) * 900000 : interval.start, end: interval.end}));
  if (!slots.length) return;
  $("rain-bars").style.gridTemplateColumns = slots.map(slot => (slot.end - slot.start) + 'fr').join(' ');
  $("rain-axis").style.gridTemplateColumns = '';
  $("rain-axis").innerHTML = sandboxThreeHourAxis(slots, value => hourFormat.format(new Date(value)));
  sandboxBindRainScroll();
}
function sandboxBindRainScroll() {
  const scrolls = [...document.querySelectorAll('.horizon-scroll, .horizon-detail-scroll')];
  scrolls.forEach(scroller => {
    if (scroller.dataset.syncBound) return;
    scroller.dataset.syncBound = 'true';
    scroller.addEventListener('scroll', () => document.querySelectorAll('.horizon-scroll, .horizon-detail-scroll').forEach(other => {
      if (other !== scroller && other.scrollLeft !== scroller.scrollLeft) other.scrollLeft = scroller.scrollLeft;
    }), {passive:true});
  });
}

