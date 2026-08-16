const $ = id => document.getElementById(id);
const runtimeConfig = window.METEO_RUNTIME_CONFIG && typeof window.METEO_RUNTIME_CONFIG === "object"
  ? window.METEO_RUNTIME_CONFIG
  : {};
const apiBaseUrl = new URL(runtimeConfig.apiBase || "./", document.baseURI);
const apiUrl = path => new URL(String(path).replace(/^\/+/, ""), apiBaseUrl);
const appNow = () => Number(window.METEO_REPLAY?.currentTime?.()) || Date.now();
const point = { lat: 44.6538, lon: 5.5995 };
const hourFormat = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
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
let lastAromeStamp = 0;
let lastPiafStamp = 0;
let lastRadarStamp = 0;
let lastPearomeStamp = 0;
let lastEnsembleStamp = 0;
let lastVigilanceStamp = 0;
let lastOpenMeteoStamp = 0;
let refreshTimer = 0;
let dashboardSync = { status: "loading", error: null };
let activeForecastSource = window.METEO_REPLAY ? "openmeteo" : "meteofrance";
let activeRainSource = window.METEO_REPLAY ? "openmeteo" : "meteofrance";
let latestForecastData = null;
let latestWeekForecast = null;
let latestOpenMeteoWeekRaw = null;
let latestMeteoFranceWeek = null;
let weekForecastPromise = null;
let weekForecastRetryTimer = 0;
let weekForecastErrors = {};
let meteoFranceWeekPollTimer = 0;
let weekActiveDayTimer = 0;
let latestWeekEvolutionHistory = [];
let dashboardCacheHydrated = false;
let weekCacheHydrated = false;
let activeNowcastMapRadius = 60;
let nowcastMapRadiusManuallySelected = false;
let nowcastLeafletMap = null;
let nowcastLeafletResizeObserver = null;
let nowcastMapRequest = 0;
let weekEvolutionState = { signature: "", byDate: new Map() };
let cellPassageSnapshot = null;
try {
  const savedCellPassageSnapshot = JSON.parse(localStorage.getItem("meteo-cell-passage-snapshot") || "null");
  if (savedCellPassageSnapshot?.observedAt && savedCellPassageSnapshot?.values) cellPassageSnapshot = savedCellPassageSnapshot;
} catch {
  cellPassageSnapshot = null;
}
const weekDaySourceSelection = new Map();
let latestOpenMeteoEnsemble = null;
let openMeteoEnsemblePromise = null;
const selectedMetrics = new Set(["temperature", "rain", "wind", "gust", "cloudiness"]);
const metricOpacities = { temperature: 100, rain: 100, wind: 0, gust: 0, cloudiness: 0 };
const metricOffsets = { temperature: 0, rain: 0, wind: 0, gust: 0, cloudiness: 0 };
const possibleDrizzleThreshold = .01;
const measurableRainThreshold = .05;
// Échelle commune des pictogrammes de pluie. Elle exprime une quantité
// réellement affichée, sans transformer quelques millimètres en pluie forte.
const rainPictogramStep = value => value <= 0 ? 0 : value < 3 ? 1 : value < 8 ? 2 : value < 15 ? 3 : value < 30 ? 4 : 5;

const sourceFreshness = { arome: 3 * 3600000, pearome: 3 * 3600000, ensemble: 3 * 3600000, piaf: 20 * 60000, radar: 15 * 60000, lightning: 20 * 60000, openMeteo: 60 * 60000 };
const sourceLabels = { arome: "AROME", pearome: "AROME-PI", ensemble: "PEAROME", piaf: "PIAF", radar: "Radar", lightning: "EUMETSAT LI", openMeteo: "Open-Meteo" };

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
  const href = (window.METEO_REPLAY ? "../" : "") + "about.html#" + section;
  return '<a class="source-link" data-source-status="' + key + '" data-sync="' + state + '" href="' + href + '" title="Voir ' + escapeText(label) + ' dans About · ' + escapeText(sourceSyncTitle(key)) + '">' + label + '</a>';
}

const meteoFranceLinks = () => sourceLink("arome", "api-arome", "AROME")
  + sourceLink("piaf", "api-piaf", "PIAF")
  + sourceLink("pearome", "api-pe-arome", "AROME-PI");
const openMeteoLink = () => sourceLink("openMeteo", "api-open-meteo", "Open-Meteo");
const radarLink = () => sourceLink("radar", "api-radar", window.METEO_REPLAY ? "Radar archivé" : "Radar v1");
const lightningLink = () => sourceLink("lightning", "api-eumetsat-li", "EUMETSAT LI");
const threeHourLinks = () => window.METEO_REPLAY ? radarLink() + openMeteoLink() : radarLink()
  + sourceLink("piaf", "api-piaf", "PIAF")
  + sourceLink("arome", "api-arome", "AROME")
  + lightningLink();

function renderRainApiLinks() {
  if ($("three-hour-api-links")) $("three-hour-api-links").innerHTML = threeHourLinks();
  if ($("rain-api-links")) $("rain-api-links").innerHTML = activeRainSource === "openmeteo" ? openMeteoLink() : sourceLink("piaf", "api-piaf", "PIAF") + radarLink();
  if ($("nowcast-api-links")) $("nowcast-api-links").innerHTML = radarLink() + (window.METEO_REPLAY ? "" : lightningLink());
  refreshSourceIndicators();
}

function renderForecastApiLinks() {
  const container = $("forecast-api-links");
  if (!container) return;
  container.innerHTML = (activeForecastSource === "openmeteo" ? openMeteoLink()
    : activeForecastSource === "comparison" ? meteoFranceLinks() + openMeteoLink()
    : meteoFranceLinks());
  refreshSourceIndicators();
}

function renderWeekApiLinks() {
  const container = $("week-api-links");
  if (!container) return;
  container.innerHTML = sourceLink("arome", "api-arpege", "ARPEGE")
    + sourceLink("ensemble", "api-pe-arpege", "PE-ARPEGE")
    + sourceLink("openMeteo", "api-open-meteo", "Open-Meteo");
  refreshSourceIndicators();
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
  const renderRainSourceSelector = () => {
    const unavailable = window.METEO_REPLAY ? ' disabled title="PIAF non archivé pour cette date"' : '';
    $("rain-source-selector").innerHTML = '<div class="forecast-source-selector" aria-label="Source des prévisions de précipitations"><button class="forecast-source-button' + (activeRainSource === "meteofrance" ? " active" : "") + '" type="button" data-rain-source="meteofrance" aria-pressed="' + (activeRainSource === "meteofrance") + '"' + unavailable + '>Météo-France</button><button class="forecast-source-button' + (activeRainSource === "openmeteo" ? " active" : "") + '" type="button" data-rain-source="openmeteo" aria-pressed="' + (activeRainSource === "openmeteo") + '">Open-Meteo</button></div>';
    renderRainApiLinks();
    $("rain-source-selector").querySelectorAll("[data-rain-source]").forEach(button => button.addEventListener("click", () => {
      activeRainSource = button.dataset.rainSource;
      renderRainSourceSelector();
      renderActiveRain();
    }));
  };
  renderRainSourceSelector();
  renderForecastApiLinks();
  renderWeekApiLinks();
  ensureWeekForecast();
}

function renderVigilance(vigilance) {
  const banner = $("vigilance-alert");
  const alerts = vigilance?.alerts || [];
  const now = Date.now();
  const visibleAlerts = alerts.filter(alert => Number(alert.colorId) >= 2);
  const activeAlerts = visibleAlerts.filter(alert => !alert.start || new Date(alert.start).getTime() <= now && (!alert.end || now < new Date(alert.end).getTime()));
  const upcomingAlerts = visibleAlerts.filter(alert => alert.start && new Date(alert.start).getTime() > now);
  const hasParticularVigilance = activeAlerts.length > 0 || upcomingAlerts.length > 0;
  banner.hidden = !hasParticularVigilance;
  if (!hasParticularVigilance) {
    banner.innerHTML = "";
    banner.removeAttribute("data-level");
    return;
  }
  const highest = Math.max(1, ...activeAlerts.map(alert => Number(alert.colorId) || 2));
  banner.dataset.level = highest >= 4 ? "red" : highest >= 3 ? "orange" : highest >= 2 ? "yellow" : "green";
  const level = highest >= 4 ? "rouge" : highest >= 3 ? "orange" : highest >= 2 ? "jaune" : "green";
  const detail = alert => {
    const start = alert.start ? dateTimeFormat.format(new Date(alert.start)) : "en cours";
    const end = alert.end ? dateTimeFormat.format(new Date(alert.end)) : "non précisée";
    const timeline = (alert.timeline || []).filter(item => item.start && item.end);
    const totalDuration = Math.max(1, ...timeline.map(item => Math.max(1, new Date(item.end) - new Date(item.start))));
    const bar = timeline.length ? '<div class="vigilance-timeline" aria-label="Chronologie de ' + escapeText(alert.label) + '">' + timeline.map(item => '<span class="timeline-segment ' + escapeText(item.color) + '" style="flex-grow:' + (Math.max(1, new Date(item.end) - new Date(item.start)) / totalDuration).toFixed(3) + '" title="' + escapeText(item.color) + '"></span>').join("") + '</div>' : '';
    return '<li data-alert-level="' + escapeText(alert.color) + '"><strong>' + escapeText(alert.label) + '</strong><span>Du ' + escapeText(start) + ' au ' + escapeText(end) + '</span>' + bar + '</li>';
  };
  const commentary = activeAlerts.map(alert => alert.commentary).find(Boolean);
  const activeMarkup = activeAlerts.length ? '<ul class="vigilance-details">' + activeAlerts.map(detail).join("") + '</ul>' : '';
  const upcomingMarkup = upcomingAlerts.length ? '<section class="vigilance-upcoming"><strong>Vigilance à venir</strong><ul class="vigilance-details">' + upcomingAlerts.map(detail).join("") + '</ul></section>' : '';
  const title = activeAlerts.length ? 'Vigilance ' + level + ' en cours' : 'Pas de vigilance particulière';
  banner.innerHTML = '<details class="vigilance-disclosure"><summary><span class="vigilance-summary-title">' + title + '</span><span class="vigilance-summary-place">Drôme (26)</span><span class="vigilance-chevron" aria-hidden="true">⌄</span></summary><div class="vigilance-content"><div class="vigilance-title"><strong>' + title + '</strong><span>Drôme (26)</span></div>' + activeMarkup + upcomingMarkup + (commentary ? '<p>' + escapeText(commentary) + '</p>' : '') + '<a href="https://vigilance.meteofrance.fr/" target="_blank" rel="noreferrer">Voir le bulletin Météo-France ↗</a></div></details>';
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


function shortEtaLabel(minutes) {
  if (!Number.isFinite(minutes)) return "à confirmer";
  if (minutes <= 0) return "en cours";
  if (minutes < 1) return "moins d’une minute";
  return Math.round(minutes) + " min";
}

function renderApproachingCellsAlert(radar) {
  const banner = $("cell-approach-alert");
  const approaching = (radar?.cells || [])
    .filter(cell => Math.hypot(Number(cell.eastKm || 0), Number(cell.northKm || 0)) < 60)
    .map((cell, index) => {
    const distance = Math.hypot(Number(cell.eastKm || 0), Number(cell.northKm || 0));
    const point15 = cell.track?.points?.find(point => point.minutes === 15);
    if (!point15) return null;
    const distance15 = Math.hypot(Number(point15.eastKm || 0), Number(point15.northKm || 0));
    const radialSpeed = Math.round((distance15 - distance) * 4);
    if (radialSpeed >= -1) return null;
    const passageRisk = Math.round(Number(cell.risks?.passage) || 0);
    if (passageRisk <= 0) return null;
    const etaMinutes = cell.etaMinutes == null ? null : Number(cell.etaMinutes);
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
    : nearest.etaMinutes < 1 ? "dans moins d’une minute" : "dans environ " + Math.round(nearest.etaMinutes) + " min";
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
    return url.origin === apiBaseUrl.origin && /\/api\/(dashboard|week)$/.test(url.pathname);
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
  const response = await fetch(target, { cache: "no-store" });
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
  const night = isNight(date);
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
  const rainMarkup = rainLevel ? '<img class="weather-rain-layer" src="vendor/weather-variants/rain-' + rainLevel + '.svg" alt="">' : '';
  return '<span class="weather-variant-icon" role="img" aria-label="' + escapeText(label) + '"><img class="weather-cloud-layer" src="' + base + '" alt="">' + rainMarkup + '</span>';
}

function stormSignalPictogram(detail, extraClass = "", withCloud = false) {
  const symbol = withCloud
    ? '<path class="storm-signal-cloud" d="M4.8 15.5a3.7 3.7 0 0 1 .4-7.4A5.7 5.7 0 0 1 16.4 6.8a4 4 0 0 1 3.3 1.7 3.6 3.6 0 0 1 .7 7H4.8Z"/><path class="storm-signal-bolt" d="m13.2 10.4-3.8 6h3.2l-1.5 6.5 8-9.8h-3.5l1.7-2.7h-4.1Z"/>'
    : '<path class="storm-signal-bolt" d="M13.5 2 6.8 13h5l-1.2 9L18 10.5h-5L13.5 2Z"/>';
  return '<span class="storm-signal-pictogram chart-point' + (extraClass ? " " + extraClass : "") + '" tabindex="0" role="img" aria-label="Orage possible" data-tooltip="' + escapeText(detail) + '" title="' + escapeText(detail) + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + symbol + '</svg></span>';
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

function weekForecastStartKey(now = new Date(appNow())) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    hourCycle: "h23", timeZone: "Europe/Paris"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return values.year + "-" + values.month + "-" + values.day + "T" + values.hour + ":" + values.minute;
}

const forecastPeriodOrder = ["night", "morning", "afternoon", "late_afternoon", "evening"];

function forecastPeriodKey(hour) {
  return hour < 6 ? "night" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
}

function forecastPeriodText(periods) {
  const selected = [...new Set((periods || []).filter(period => forecastPeriodOrder.includes(period)))].sort((left, right) => forecastPeriodOrder.indexOf(left) - forecastPeriodOrder.indexOf(right));
  if (!selected.length) return "";
  if (selected.length === forecastPeriodOrder.length) return "tout au long de la journée";
  if (selected.join(",") === "morning,afternoon,evening") return "du matin au soir";
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

function conciseRainSummary(amount, probabilities, periods, showers = false, storm = false, probabilitySummary = null) {
  const rain = Math.max(0, Number(amount) || 0);
  const probability = probabilitySummary || rainProbabilitySummary(probabilities);
  const risk = Math.max(0, Number(probability.average) || 0);
  if (rain <= 0 && risk < 40 && !storm) return "";
  const timing = forecastPeriodText(periods);
  const quantity = rain <= 0 ? "sans cumul notable"
    : rain < .1 ? "sous forme de quelques gouttes"
    : rain < 1 ? "en très faible quantité"
    : rain < 5 ? "en faible quantité"
    : rain < 15 ? "en quantité modérée"
    : rain < 30 ? "en forte quantité" : "en très forte quantité";
  const plural = showers;
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
  const windQualifier = value => value < 6 ? "très léger" : value < 12 ? "léger" : value < 20 ? "modéré" : value < 30 ? "assez fort" : "fort";
  const gustQualifier = value => value < 20 ? "faibles" : value < 35 ? "modérées" : value < 50 ? "significatives" : value < 70 ? "fortes" : "très fortes";
  const dominantQualifier = (values, qualifier, labels) => {
    const qualified = values.map(qualifier);
    const counts = Object.fromEntries(labels.map(label => [label, qualified.filter(value => value === label).length]));
    const dominant = labels.reduce((choice, label) => counts[label] >= counts[choice] ? label : choice, labels[0]);
    const indexes = qualified.map(value => labels.indexOf(value));
    const low = Math.min(...indexes);
    const high = Math.max(...indexes);
    // Une plage n'apporte quelque chose que lors d'un changement réellement
    // radical. Sinon, la catégorie la plus fréquente tranche le résumé.
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
    const windSummary = dominantQualifier(winds, windQualifier, ["très léger", "léger", "modéré", "assez fort", "fort"]);
    const windDescription = (windSummary === "très léger" || windSummary === "léger")
      ? windSummary.charAt(0).toUpperCase() + windSummary.slice(1) + " vent"
      : "Vent " + windSummary;
    parts.push(windDescription + directionText + (windTiming && !sharedTiming ? " surtout " + windTiming : ""));
  }
  if (!gusts.length || gustMaximum <= 0) return parts.length ? parts.join(", ") + "." : "Pas de vent.";
  const gustLow = gustQualifier(Math.min(...gusts));
  const gustHigh = gustQualifier(Math.max(...gusts));
  if (sharedTiming && windHigh === "fort" && gustHigh === "fortes" && windLow === windHigh && gustLow === gustHigh) {
    return "Vent et rafales fortes" + directionText + " surtout " + sharedTiming + ".";
  }
  const gustSummary = dominantQualifier(gusts, gustQualifier, ["faibles", "modérées", "significatives", "fortes", "très fortes"]);
  if (gustMaximum < 35) {
    parts.push("rafales " + gustSummary + (gustTiming && !sharedTiming ? " surtout " + gustTiming : ""));
    return finish();
  }
  parts.push("rafales " + gustSummary + (gustTiming && !sharedTiming ? " surtout " + gustTiming : ""));
  return finish();
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
    let rainSamples = samples.filter(sample => sample.precipitation >= .02);
    if (!rainSamples.length && Number(dailyProbability) >= 50) {
      const maximumProbability = Math.max(...samples.map(sample => sample.probability), 0);
      rainSamples = samples.filter(sample => sample.probability >= Math.max(50, maximumProbability - 10));
    }
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
      gustPeriod
    };
  }).filter(Boolean);
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
      ? "Les deux modèles n’annoncent pas de cumul notable, même si une possibilité de pluie subsiste."
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
  const rainSummary = conciseRainSummary(rainAmountMean, [], rainPeriods, openMeteoShowersState !== "no" && !stormProfiles.length, Boolean(stormProfiles.length), rainProbability) || "Pas de pluie.";
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

function renderWeekForecast() {
  const number = value => value != null && Number.isFinite(Number(value)) ? Number(value).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) : "—";
  const metricIcons = {
    rain: '<path d="M12 2.8C9.5 6.4 6.8 9.7 6.8 13.2a5.2 5.2 0 0 0 10.4 0C17.2 9.7 14.5 6.4 12 2.8Z"/>',
    showers: '<path d="M5 10.5a5 5 0 0 1 9.4-2.3A3.8 3.8 0 1 1 17 15H6a3.2 3.2 0 0 1-1-6.2"/><path d="m8 17-1.2 3M12 17l-1.2 3M16 17l-1.2 3"/>',
    cloud: '<path d="M5.5 18a4.5 4.5 0 0 1-.6-9A6.2 6.2 0 0 1 16.7 8a5 5 0 1 1 .8 10H5.5Z"/>',
    wind: '<path d="M3 7.5h10.5c3.7 0 3.7-4.5.7-4.5-1.3 0-2.2.7-2.6 1.7M3 12h15c3.8 0 3.8 5 .5 5-1.5 0-2.4-.8-2.8-1.8M3 16.5h7"/>',
    gust: '<path d="M3 7h12c4 0 4-5 .7-5-1.5 0-2.5.8-2.9 2M3 12h17M3 17h10c4 0 4 5 .7 5-1.5 0-2.5-.8-2.9-2"/>',
    storm: '<path d="M13.5 2 6.8 13h5l-1.2 9L18 10.5h-5L13.5 2Z"/>',
    hail: '<path d="M5 13.5a4 4 0 0 1 .2-8A6 6 0 0 1 17 6.5a3.5 3.5 0 1 1 .5 7H5Z"/><circle class="hailstone" cx="7.5" cy="18" r="1.6"/><circle class="hailstone" cx="12.5" cy="20" r="1.6"/><circle class="hailstone" cx="17.5" cy="18" r="1.6"/>',
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
  const windStep = value => value < 6 ? 1 : value < 12 ? 2 : value < 20 ? 3 : value < 30 ? 4 : 5;
  const gustStep = value => value < 20 ? 1 : value < 35 ? 2 : value < 50 ? 3 : value < 70 ? 4 : 5;
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
    const rainSummary = conciseRainSummary(rain, [], day.rainPeriods, showers >= .1 || code >= 80 && code <= 82, code >= 95, probabilitySummary || rainProbabilitySummary([probability])) || "Pas de pluie.";
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
    const icon = displayIcon({ time: day.time, cloudCover: iconCloud, rain: iconRain, rainLevel: rainPictogramStep(dailyRain) });
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
    const sourceWeatherMarkup = stormActive ? '<div class="week-weather-pictograms"><div class="week-icon weather-icon">' + icon + '</div>' + sourceStormMarkup + '</div>' : '<div class="week-icon weather-icon">' + icon + '</div>';
    return '<article class="week-day' + (stormActive ? ' week-source-storm-day' : '') + '">' + weekDayHeading(date, day.date, [day]) + sourceControls + '<div class="week-day-overview">' + sourceWeatherMarkup + '<div class="week-temperatures"><span class="week-temperature"><small>Max.</small><strong>' + number(day.temperatureMax) + '°</strong></span><span class="week-temperature"><small>Min.</small><b>' + number(day.temperatureMin) + '°</b></span></div></div><dl>' + cloudMarkup + rainMarkup + windMarkup + stormMarkup + '</dl>' + confidenceMarkup + '</article>';
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
    const icon = displayIcon({ time: arpege.time, cloudCover: synthesisCloud, rain: Math.max(synthesisStorm ? .5 : 0, dailyRainIconAmount(agreement.rainIconAmount)), rainLevel: rainPictogramStep(agreement.rainIconAmount) });
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
    const rainValues = finite([ecmwf.precipitationSum, arpege.precipitationSum]);
    const windValues = [ecmwf.windSpeedMax, arpege.windSpeedMax];
    const gustValues = [ecmwf.windGustMax, arpege.windGustMax];
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
    const windPeriods = [
      ecmwf.windPeriod ? "Open-Meteo " + forecastPeriodText([ecmwf.windPeriod]) : "",
      arpege.windPeriod ? "Météo-France " + forecastPeriodText([arpege.windPeriod]) : ""
    ].filter(Boolean);
    const windHoverLabel = "Vent maximal · Open-Meteo " + number(ecmwf.windSpeedMax) + " km/h · Météo-France " + number(arpege.windSpeedMax) + " km/h"
      + (windPeriods.length ? " · période caractéristique : " + windPeriods.join(" · ") : "");
    const gustPeriods = [
      ecmwf.gustPeriod ? "Open-Meteo " + forecastPeriodText([ecmwf.gustPeriod]) : "",
      arpege.gustPeriod ? "Météo-France " + forecastPeriodText([arpege.gustPeriod]) : ""
    ].filter(Boolean);
    const gustHoverLabel = "Rafales · Open-Meteo " + number(ecmwf.windGustMax) + " km/h · Météo-France " + number(arpege.windGustMax) + " km/h"
      + (gustPeriods.length ? " · maximum : " + gustPeriods.join(" · ") : "");
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
    return '<article class="week-day week-consensus-day ' + verdictLevel + '">' + weekDayHeading(date, arpege.date, [ecmwf, arpege]) + sourceControls + '<div class="week-day-overview">' + synthesisWeatherMarkup + '<div class="week-temperatures"><span class="week-temperature"><small>Max.</small><strong>' + number(mean([ecmwf.temperatureMax, arpege.temperatureMax])) + '°</strong></span><span class="week-temperature"><small>Min.</small><b>' + number(mean([ecmwf.temperatureMin, arpege.temperatureMin])) + '°</b></span></div></div><dl>' + cloudMarkup + rainMarkup + windMarkup + stormMarkup + '</dl>' + footerMarkup + '</article>';
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
    const forecastRequest = latestOpenMeteoWeekRaw ? Promise.resolve(null) : json(url.toString()).then(value => {
      latestOpenMeteoWeekRaw = { daily: value.daily, hourly: value.hourly };
      latestWeekForecast = { fetchedAt: Date.now(), model: "Open-Meteo", days: includeCurrentDashboardDay(normalizeOpenMeteoDays(value.daily, value.hourly)) };
      scheduleActiveWeekDayUpdate();
      renderWeekForecast();
      return value;
    });
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

function piafQuarterHourRain(piaf) {
  const runTime = piafRunTime(piaf);
  if (!Number.isFinite(runTime)) return [];
  const fiveMinutes = 5 * 60000;
  const quarterHour = 15 * 60000;
  const buckets = new Map();
  for (const item of piaf.values || []) {
    const endTime = runTime + Number(item.seconds) * 1000;
    if (!Number.isFinite(endTime) || !Number.isFinite(Number(item.precipitation))) continue;
    const bucketEnd = (Math.floor((endTime - 1) / quarterHour) + 1) * quarterHour;
    if (!buckets.has(bucketEnd)) buckets.set(bucketEnd, []);
    buckets.get(bucketEnd).push({ ...item, endTime });
  }
  return [...buckets.entries()].sort(([left], [right]) => left - right).map(([bucketEnd, items]) => {
    items.sort((left, right) => left.endTime - right.endTime);
    const expectedEnds = [bucketEnd - 2 * fiveMinutes, bucketEnd - fiveMinutes, bucketEnd];
    const complete = expectedEnds.every(expected => items.some(item => item.endTime === expected));
    const sum = field => items.reduce((total, item) => total + (Number(item[field]) || 0), 0);
    const has = field => items.some(item => Number.isFinite(Number(item[field])));
    const intervalStart = items[0].endTime - fiveMinutes;
    const intervalEnd = items.at(-1).endTime;
    return {
      slotTime: new Date(complete ? bucketEnd : intervalEnd),
      endTime: bucketEnd,
      seconds: (intervalEnd - runTime) / 1000,
      precipitation: sum("precipitation"),
      nowcastPrecipitation: has("nowcastPrecipitation") ? sum("nowcastPrecipitation") : undefined,
      radarPrecipitation: has("radarPrecipitation") ? sum("radarPrecipitation") : undefined,
      radarCellOverPoint: items.some(item => item.radarCellOverPoint),
      probability: has("probability") ? Math.max(...items.filter(item => Number.isFinite(Number(item.probability))).map(item => Number(item.probability))) : null,
      intervalStart,
      intervalEnd,
      complete
    };
  });
}

function piafHourlyRain(piaf) {
  const runTime = piafRunTime(piaf);
  if (!Number.isFinite(runTime)) return new Map();
  const fiveMinutes = 5 * 60000;
  const hour = 60 * 60000;
  const buckets = new Map();
  for (const item of piaf.values || []) {
    const endTime = runTime + Number(item.seconds) * 1000;
    const precipitation = Number(item.nowcastPrecipitation ?? item.precipitation);
    if (!Number.isFinite(endTime) || !Number.isFinite(precipitation)) continue;
    // Un pas terminé exactement à H:00 appartient à l'heure précédente.
    const hourStart = Math.floor((endTime - 1) / hour) * hour;
    if (!buckets.has(hourStart)) buckets.set(hourStart, []);
    buckets.get(hourStart).push({ ...item, endTime, precipitation });
  }
  return new Map([...buckets.entries()].sort(([left], [right]) => left - right).map(([hourStart, items]) => {
    items.sort((left, right) => left.endTime - right.endTime);
    const intervalStart = items[0].endTime - fiveMinutes;
    const intervalEnd = items.at(-1).endTime;
    const radarAdjusted = items.some(item => Number.isFinite(item.nowcastPrecipitation));
    const radarCellOverPoint = items.some(item => item.radarCellOverPoint);
    return [hourStart, {
      rain: Math.round(items.reduce((total, item) => total + Math.max(0, item.precipitation), 0) * 100) / 100,
      rainSource: radarAdjusted ? "Météo-France PIAF + radar" : "Météo-France PIAF",
      rainIntervalStart: intervalStart,
      rainIntervalEnd: intervalEnd,
      rainDurationMinutes: Math.round((intervalEnd - intervalStart) / 60000),
      rainRadarCellOverPoint: radarCellOverPoint
    }];
  }));
}

function openMeteoHourlyRain(openMeteo) {
  return completeHourlyRain((openMeteo?.minutely15 || []).map(item => ({
    endTime: new Date(item.time).getTime(),
    precipitation: Number(item.precipitation)
  })), 15, "Open-Meteo 15 min");
}

function withHourlyNowcast(forecast, hourlyRain) {
  if (!forecast?.hours?.length || !hourlyRain?.size) return forecast;
  return {
    ...forecast,
    hours: forecast.hours.map(item => {
      const replacement = hourlyRain.get(new Date(item.time).getTime());
      return replacement ? { ...item, ...replacement } : item;
    })
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
  const meteoFrance = withHourlyNowcast(data.arome, data.piaf ? piafHourlyRain(data.piaf) : null);
  const openMeteo = withHourlyNowcast(data.openMeteo, openMeteoHourlyRain(data.openMeteo));
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
  const useOpenMeteo = activeRainSource === "openmeteo" || !data.piaf;
  if (useOpenMeteo) {
    if ($("rain-api-links")) $("rain-api-links").innerHTML = openMeteoLink();
    const probabilityByHour = new Map((data.openMeteo?.hours || []).map(item => [item.time.slice(0, 13), item.probability]));
    const values = (data.openMeteo?.minutely15 || []).map(item => ({
      ...item,
      probability: probabilityByHour.get(precedingHourEndKey(item.time))
    }));
    if (values.length) renderPiaf({ values, source: "openmeteo" });
  } else {
    if ($("rain-api-links")) $("rain-api-links").innerHTML = sourceLink("piaf", "api-piaf", "PIAF") + radarLink();
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
  const nextHour = new Date(appNow());
  nextHour.setMinutes(0, 0, 0);
  nextHour.setHours(nextHour.getHours() + 1);
  const hours = arome.hours
    .filter(item => new Date(item.time) >= nextHour)
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
  const meteoFranceRainSource = item => item.rainSource?.replace(/^Météo-France\s+/, "") || "AROME";
  const agreement = pair => {
    // Use deliberately tight thresholds: a comparison view is useful only if
    // its background visibly reacts to modest model differences.
    const temperature = Math.max(0, 1 - difference(pair, "temperature") / 2.5);
    const wind = Math.max(0, 1 - difference(pair, "windSpeed") / 10);
    const gust = Math.max(0, 1 - difference(pair, "windGust") / 16);
    const bothWet = pair.meteoFrance.rain >= measurableRainThreshold && pair.openMeteo.rain >= measurableRainThreshold;
    const bothDry = pair.meteoFrance.rain < measurableRainThreshold && pair.openMeteo.rain < measurableRainThreshold;
    const rain = bothWet ? Math.max(.2, 1 - difference(pair, "rain") / .7) : bothDry ? .7 : .1;
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
    const mfWet = pair.meteoFrance.rain >= measurableRainThreshold;
    const omWet = pair.openMeteo.rain >= measurableRainThreshold;
    const amount = average(pair, "rain");
    const omShower = Number(pair.openMeteo.probability) > 0 && (Number(pair.openMeteo.weatherCode) >= 80 || pair.openMeteo.rain < measurableRainThreshold);
    if (!mfWet && !omWet && !omShower) return "";
    if (!mfWet && !omWet && omShower) {
      const probability = Math.round(Number(pair.openMeteo.probability));
      const detail = 'Averse selon Open-Meteo\nProbabilité : ' + probability + ' %\nCumul horaire : ' + pair.openMeteo.rain.toFixed(2) + ' mm';
      return '<g class="comparison-shower chart-point" tabindex="0" data-tooltip="' + escapeText(detail) + '"><rect x="' + (index * cell + 10) + '" y="278" width="' + (cell - 20) + '" height="16" rx="8"/><text x="' + x(index) + '" y="289" text-anchor="middle">Averse · ' + probability + ' %</text></g>';
    }
    const minimum = Math.min(pair.meteoFrance.rain, pair.openMeteo.rain);
    const maximum = Math.max(pair.meteoFrance.rain, pair.openMeteo.rain);
    const barHeight = Math.min(66, Math.max(6, Math.sqrt(Math.max(amount, .02)) * 35));
    const minHeight = Math.min(barHeight, Math.sqrt(Math.max(minimum, .01)) * 35);
    const maxHeight = Math.min(66, Math.max(barHeight, Math.sqrt(Math.max(maximum, .02)) * 35));
    const rainAgreement = mfWet && omWet ? agreement(pair) : 18;
    const singleModelRain = mfWet !== omWet;
    const probability = Number(pair.openMeteo.probability);
    const probabilityLabel = Number.isFinite(probability) ? Math.round(probability) + ' %' : '—';
    const amountLabel = (singleModelRain ? maximum : amount).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' mm';
    const detail = 'Précipitations : ' + amount.toFixed(2) + ' mm\nMétéo-France (' + meteoFranceRainSource(pair.meteoFrance) + ') : ' + pair.meteoFrance.rain.toFixed(2) + ' mm\nOpen-Meteo : ' + pair.openMeteo.rain.toFixed(2) + ' mm · probabilité ' + probabilityLabel + '\nPlage : ' + minimum.toFixed(2) + ' – ' + maximum.toFixed(2) + ' mm';
    const valueLabel = singleModelRain ? amountLabel + ' · ' + probabilityLabel : amount.toFixed(amount < 1 ? 1 : 0) + ' mm';
    return '<g class="comparison-rain-group' + (singleModelRain ? ' comparison-rain-single' : '') + ' chart-point" tabindex="0" data-tooltip="' + escapeText(detail) + '"><rect class="comparison-rain-range" x="' + (index * cell + 17) + '" y="' + (298 - maxHeight) + '" width="' + (cell - 34) + '" height="' + maxHeight + '" style="opacity:' + opacity(rainAgreement, .18) + '"/><rect class="comparison-rain" x="' + (index * cell + 24) + '" y="' + (298 - barHeight) + '" width="' + (cell - 48) + '" height="' + barHeight + '" style="opacity:' + opacity(rainAgreement, .24) + '"/><line class="comparison-rain-min" x1="' + (index * cell + 18) + '" x2="' + (index * cell + cell - 18) + '" y1="' + (298 - minHeight) + '" y2="' + (298 - minHeight) + '" style="opacity:' + opacity(rainAgreement, .24) + '"/><text class="comparison-rain-value" x="' + x(index) + '" y="' + (294 - maxHeight) + '" text-anchor="middle">' + valueLabel + '</text></g>';
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
    return '<div class="comparison-hour chart-point" tabindex="0" aria-label="' + escapeText(levelLabel(score) + ' : ' + score + ' %') + '" data-tooltip="' + escapeText(detail) + '" style="background:' + agreementColor(score, .17) + '"><div class="comparison-hour-content"><time><small>' + escapeText(forecastWeekdayLabel(date)) + '</small>' + escapeText(forecastHourLabel(date)) + '</time></div></div>';
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
  // A forecast cycle can stay cached across midnight.  Never let its past
  // slots push the current forecast off screen: begin at the next full hour.
  const nextHour = new Date(appNow());
  nextHour.setMinutes(0, 0, 0);
  nextHour.setHours(nextHour.getHours() + 1);
  const hours = arome.hours.filter(item => new Date(item.time) >= nextHour);
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
    return '<div class="overview-x-hour" style="' + daylightStyle(date, true) + '"><span>' + escapeText(forecastWeekdayLabel(date)) + '</span><time>' + escapeText(forecastHourLabel(date)) + '</time></div>';
  }).join("");
  const probabilityDisplayIndexes = new Map(probabilities.map(point => {
    const indexes = hours.map((item, index) => ({ index, time: new Date(item.time).getTime() }))
      .filter(item => item.time >= point.time && item.time < point.time + point.durationHours * 3600000)
      .map(item => item.index);
    return [point.time, indexes.length ? indexes[Math.floor(indexes.length / 2)] : -1];
  }));
  const overviewRain = hours.map((item, index) => {
    const probabilityPoint = probabilityPointForTime(new Date(item.time).getTime());
    const isPiafHour = item.rainSource?.startsWith("Météo-France PIAF");
    const hasProbability = !isPiafHour && Number.isFinite(probabilityPoint?.probability);
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
    const drops = displayedAmount >= possibleDrizzleThreshold && displayedAmount < .2;
    const showProbability = hasProbability && probability > 0 && (usePearomePeriod ? showPeriod : probabilityDisplayIndexes.get(probabilityPoint.time) === index);
    const probabilisticAverse = showProbability && probability > 0 && !measurable;
    const height = selectedMetrics.has("rain") && rainTrace ? (measurable ? Math.min(112, Math.max(7, Math.sqrt(displayedAmount) * 35)) : 4) : 0;
    const interval = isPiafHour || ensemble?.source === "openmeteo" ? null : probabilityPoint?.interval;
    const intervalLabel = "Plage ensemble PEAROME (P10–P90)";
    const durationHours = usePearomePeriod ? probabilityPoint.durationHours : 1;
    const rainDurationMinutes = Number(item.rainDurationMinutes);
    const durationLabel = Number.isFinite(rainDurationMinutes) && rainDurationMinutes < 60
      ? rainDurationMinutes + " min"
      : durationHours + " h";
    const intervalPeriod = item.rainIntervalStart && item.rainIntervalEnd
      ? '\nPériode : ' + hourFormat.format(new Date(item.rainIntervalStart)) + '–' + hourFormat.format(new Date(item.rainIntervalEnd))
      : '';
    const detail = (item.rainSource || forecastModelLabel) + '\nCumul : ' + displayedAmount.toFixed(2) + ' mm (' + durationLabel + ')' + intervalPeriod + (item.rainRadarCellOverPoint ? '\nCellule au-dessus des Tatins : radar prioritaire à courte échéance' : '') + (usePearomePeriod ? '\nRéférence AROME : ' + aromeAmount.toFixed(2) + ' mm' : '') + (hasProbability ? '\nProbabilité : ' + probability + '%' : '') + (interval ? '\n' + intervalLabel + ' : ' + interval.low.toFixed(2) + ' – ' + interval.high.toFixed(2) + ' mm sur ' + durationHours + ' h' : '') + '\nÉchéance : ' + dateTimeFormat.format(new Date(item.time));
    const precipitationLabel = drops ? 'gouttes' : measurable ? displayedAmount.toFixed(isPiafHour ? 2 : 1) + ' mm' : (!pearome && probability > 0 ? 'averse' : '');
    const intervalAmountLabel = interval && measurable && !drops ? '(' + interval.low.toFixed(1) + '–' + interval.high.toFixed(1) + ' mm)' : '';
    const centerX = usePearomePeriod ? (periodIndexes[0] * cell + (periodIndexes.length * cell) / 2) : x(index);
    const chanceLabel = 'Averse ' + probability + ' %';
    const chanceWidth = Math.min(cell - 12, Math.max(58, chanceLabel.length * 5.3 + 12));
    const chanceX = x(index) - chanceWidth / 2;
    const rainHeight = value => Math.min(112, Math.sqrt(Math.max(0, value)) * 35);
    const quantifiedInterval = (usePearomePeriod ? showPeriod : true) && interval && interval.high > interval.low && !drops ? interval : null;
    const barStart = usePearomePeriod ? periodIndexes[0] * cell + 10 : index * cell + 10;
    const barWidth = usePearomePeriod ? periodIndexes.length * cell - 20 : cell - 20;
    const uncertaintyPositions = usePearomePeriod ? [barStart, barStart + barWidth] : [centerX];
    const uncertainty = quantifiedInterval ? uncertaintyPositions.map(position => '<path class="overview-rain-error" d="M' + position + ' ' + (overviewHeight - rainHeight(quantifiedInterval.high)) + 'V' + (overviewHeight - rainHeight(quantifiedInterval.low)) + 'M' + (position - 6) + ' ' + (overviewHeight - rainHeight(quantifiedInterval.high)) + 'H' + (position + 6) + 'M' + (position - 6) + ' ' + (overviewHeight - rainHeight(quantifiedInterval.low)) + 'H' + (position + 6) + '"/>').join('') : '';
    const drawBar = usePearomePeriod ? showPeriod : true;
    // La probabilité décrit le volume affiché : elle reste dans la zone bleue,
    // juste au-dessus du cumul, sans suivre la borne haute d'incertitude.
    const probabilityLabelY = overviewHeight - (intervalAmountLabel ? 38 : 22);
    const probabilityLabel = showProbability && selectedMetrics.has("rain") ? '<text class="overview-rain-label overview-rain-probability-label" x="' + centerX + '" y="' + probabilityLabelY + '" text-anchor="middle">' + probability + ' %</text>' : '';
    const amountLabel = intervalAmountLabel
      ? '<text class="overview-rain-amount-label" x="' + centerX + '" y="' + (overviewHeight - 17) + '" text-anchor="middle"><tspan class="overview-rain-amount-value" x="' + centerX + '">' + escapeText(precipitationLabel) + '</tspan><tspan class="overview-rain-amount-range" x="' + centerX + '" dy="12">' + escapeText(intervalAmountLabel) + '</tspan></text>'
      : '<text class="overview-rain-amount-label" x="' + centerX + '" y="' + (overviewHeight - 5) + '" text-anchor="middle">' + escapeText(precipitationLabel) + '</text>';
    const marker = drawBar && rainTrace ? '<rect class="overview-rain-bar wet" x="' + barStart + '" y="' + (overviewHeight - height) + '" width="' + barWidth + '" height="' + height + '"/>' + uncertainty + probabilityLabel + amountLabel : (probabilisticAverse ? '<rect class="overview-rain-chance" x="' + chanceX + '" y="' + (overviewHeight - 24) + '" width="' + chanceWidth + '" height="18" rx="9"/><text class="overview-rain-chance-label" x="' + x(index) + '" y="' + (overviewHeight - 15) + '" text-anchor="middle" dominant-baseline="middle">' + escapeText(chanceLabel) + '</text>' : '');
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
    + '<section class="overview-panel"><div class="overview-scroll"><div class="overview-curve-labels" aria-hidden="true">' + curveLabels + '</div><div class="overview-canvas" style="width:' + width + 'px"><div class="overview-x-axis" aria-label="Heures des prévisions">' + overviewXAxis + '</div><div class="overview-head">' + overviewHeaders + '</div><svg class="overview-temperature" viewBox="0 0 ' + width + ' ' + overviewHeight + '" aria-label="Prévisions sélectionnées"><defs>' + overviewLightDefs + '</defs>' + overviewLightRects + cloudMarkup + '<g class="metric-layer metric-layer-rain">' + overviewRain + '</g>' + temperatureMarkup + windMarkup + gustMarkup + overviewDataPoints + '</svg>' + eclipseOverlay + '</div></div></section></div>';
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
      return '<g class="chart-point" tabindex="0" data-tooltip="' + escapeText(detail) + '"><path class="uncertainty-bar" d="M' + x(index) + ' ' + top + 'V' + bottom + 'M' + (x(index) - 5) + ' ' + top + 'H' + (x(index) + 5) + 'M' + (x(index) - 5) + ' ' + bottom + 'H' + (x(index) + 5) + '"/><circle cx="' + x(index) + '" cy="' + y(value) + '" r="5"/><title>' + escapeText(detail) + '</title></g>';
    }).join("");
    const secondaryCurve = secondary ? '<polyline class="series-secondary" points="' + secondary.values.map((value, index) => x(index) + "," + y(value)).join(" ") + '"/>' : "";
    const secondaryDots = secondary ? secondary.values.map((value, index) => {
      const item = hours[index];
      const detail = metricTooltip(secondary.label, value, secondary.format, item);
      return '<g class="chart-point secondary-point" tabindex="0" data-tooltip="' + escapeText(detail) + '"><circle cx="' + x(index) + '" cy="' + y(value) + '" r="4"/><title>' + escapeText(detail) + '</title></g>';
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
      return '<g class="chart-point" tabindex="0" data-tooltip="' + escapeText(detail) + '">' + error + '<circle cx="' + x(index) + '" cy="' + y(value) + '" r="4" fill="' + colors[metric.key] + '"/><title>' + escapeText(detail) + '</title></g>';
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

function renderThreatMap(radar, lightning = null, mapRadiusKm = activeNowcastMapRadius) {
  const updateTimestamp = radar?.dataUpdatedAt || radar?.fetchedAt || radar?.observedAt;
  const updateAgeMarkup = '<span class="storm-map-age">' + escapeText(radarDataAgeLabel(updateTimestamp)) + '</span>';

  const compactDesktopMap = !window.matchMedia("(max-width: 1100px)").matches;
  const width = compactDesktopMap ? 640 : 360;
  const height = compactDesktopMap ? 640 : 360;
  const radarCells = (radar?.cells || []).filter(cell => {
    const centerDistance = Math.hypot(Number(cell.eastKm || 0), Number(cell.northKm || 0));
    return Math.max(0, centerDistance - Math.max(0, Number(cell.radiusKm || 0))) <= mapRadiusKm;
  });
  const threat = radarCells.find(cell => cell.id === radar?.threat?.id) || radarCells[0] || null;
  if (!threat) {
    const targetX = width / 2;
    const targetY = height / 2;
    const scale = width === 360
      ? (width - 32) / (mapRadiusKm * 2)
      : (height - 32) / (mapRadiusKm * 2.02);
    const rings = [20, 40, 60].filter(distance => distance <= mapRadiusKm).map(distance => {
      const radius = distance * scale;
      const labelX = targetX;
      const labelY = targetY - radius;
      return '<g class="range-distance"><circle class="range-ring" cx="' + targetX + '" cy="' + targetY + '" r="' + radius.toFixed(1) + '"></circle><text x="' + labelX.toFixed(1) + '" y="' + labelY.toFixed(1) + '" text-anchor="middle">' + distance + ' km</text></g>';
    }).join('');
    const lightningMarks = (lightning?.flashes || []).filter(flash => Math.hypot(Number(flash.eastKm), Number(flash.northKm)) <= mapRadiusKm).map(flash => '<g class="lightning-flash" transform="translate(' + (targetX + flash.eastKm * scale).toFixed(1) + ' ' + (targetY - flash.northKm * scale).toFixed(1) + ')"><path d="M2-8-4 1h4l-2 8 7-11H1z"></path></g>').join('');
    return '<div class="storm-map"><div class="storm-map-leaflet" aria-hidden="true"></div><div class="nowcast-map-attribution"><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a> · <a href="https://carto.com/attributions" target="_blank" rel="noopener">© CARTO</a></div>' + updateAgeMarkup + '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Zone de détection radar à ' + mapRadiusKm + ' km centrée sur Les Tatins"><g class="north-arrow"><path d="M28 40V17l-5 8m5-8 5 8"></path><text x="23" y="54">N</text></g>' + rings + lightningMarks + '<g class="target-point"><circle cx="' + targetX + '" cy="' + targetY + '" r="5"></circle><text x="' + targetX + '" y="' + (Number(targetY) + (compactDesktopMap ? 36 : 28)) + '" text-anchor="middle">Les Tatins</text></g></svg></div>';
  }
  const points = threat.track?.points || [];
  const buildApproachProjection = cell => {
    const source = cell.track?.points || [];
    const first = source.find(point => Number(point.minutes) === 0) || source[0];
    const last = source.at(-1);
    if (!first || !last || Number(last.minutes) <= Number(first.minutes)) return null;
    const startDistance = Math.hypot(Number(first.eastKm), Number(first.northKm));
    const endDistance = Math.hypot(Number(last.eastKm), Number(last.northKm));
    if (endDistance >= startDistance - .25) return null;
    const duration = Number(last.minutes) - Number(first.minutes);
    const velocityEast = (Number(last.eastKm) - Number(first.eastKm)) / duration;
    const velocityNorth = (Number(last.northKm) - Number(first.northKm)) / duration;
    const speedSquared = velocityEast * velocityEast + velocityNorth * velocityNorth;
    if (speedSquared <= .0001) return null;
    const closestMinutes = Math.max(Number(last.minutes), -(Number(first.eastKm) * velocityEast + Number(first.northKm) * velocityNorth) / speedSquared);
    const horizon = Math.min(240, Math.ceil(closestMinutes / 15) * 15);
    if (horizon <= Number(last.minutes)) return { id: cell.id, points: source };
    const firstUncertainty = Number(first.uncertaintyKm || cell.radiusKm || 3);
    const lastUncertainty = Number(last.uncertaintyKm || firstUncertainty);
    const uncertaintyRate = Math.max(.04, (lastUncertainty - firstUncertainty) / duration) * 1.35;
    const extension = [];
    for (let minutes = Number(last.minutes) + 15; minutes <= horizon; minutes += 15) {
      extension.push({
        minutes,
        eastKm: Number(last.eastKm) + velocityEast * (minutes - Number(last.minutes)),
        northKm: Number(last.northKm) + velocityNorth * (minutes - Number(last.minutes)),
        uncertaintyKm: lastUncertainty + uncertaintyRate * (minutes - Number(last.minutes))
      });
    }
    return { id: cell.id, points: source.concat(extension) };
  };
  const approachProjections = radarCells.map(buildApproachProjection).filter(Boolean);
  const projectionsById = new Map(approachProjections.map(projection => [projection.id, projection]));
  const primaryProjection = projectionsById.get(threat.id);
  const primaryPoints = primaryProjection?.points || points;
  const secondaryTrackPoints = radarCells.flatMap(cell => {
    if (cell.id === threat.id) return [];
    return projectionsById.get(cell.id)?.points || cell.track?.points || [];
  });
  const extentPoints = [{ eastKm: 0, northKm: 0, uncertaintyKm: 3 }, ...radarCells, ...secondaryTrackPoints, ...(primaryPoints.length ? primaryPoints : [threat])];
  const paddingX = width === 360 ? 20 : 16;
  const paddingY = width === 360 ? 20 : 16;
  const eastRadiusKm = mapRadiusKm * (width === 360 ? 1.05 : 1.01);
  const northRadiusKm = mapRadiusKm * (width === 360 ? 1.05 : 1.01);
  const scale = Math.min((width - paddingX * 2) / (eastRadiusKm * 2), (height - paddingY * 2) / (northRadiusKm * 2));
  const x = eastKm => width / 2 + Number(eastKm || 0) * scale;
  const y = northKm => height / 2 - Number(northKm || 0) * scale;
  const minimumEast = -(width / 2 - paddingX) / scale;
  const maximumEast = (width / 2 - paddingX) / scale;
  const minimumNorth = -(height / 2 - paddingY) / scale;
  const maximumNorth = (height / 2 - paddingY) / scale;
  const trackPoints = primaryPoints.map(point => x(point.eastKm).toFixed(1) + ',' + y(point.northKm).toFixed(1)).join(' ');
  const coneFor = (track, className, gradientId, color, startRadiusKm = null) => {
    if (track.length <= 1) return '';
    const start = track[0];
    const end = track.at(-1);
    const startX = x(start.eastKm);
    const startY = y(start.northKm);
    const endX = x(end.eastKm);
    const endY = y(end.northKm);
    const screenDx = endX - startX;
    const screenDy = endY - startY;
    const length = Math.hypot(screenDx, screenDy) || 1;
    const perpendicularX = -screenDy / length;
    const perpendicularY = screenDx / length;
    let previousRadiusKm = Math.max(0, Number(startRadiusKm) || 0);
    const radiusByPointKm = track.map((point, index) => {
      const estimatedRadiusKm = index === 0 ? previousRadiusKm : Math.max(0, Number(point.uncertaintyKm) || 0);
      previousRadiusKm = Math.max(previousRadiusKm, estimatedRadiusKm);
      return previousRadiusKm;
    });
    const radiusFor = index => radiusByPointKm[index] * scale;
    const maximumRadius = Math.max(1, ...track.map((point, index) => radiusFor(index)));
    const startRadius = radiusFor(0);
    const left = [
      (startX + perpendicularX * startRadius).toFixed(1) + ',' + (startY + perpendicularY * startRadius).toFixed(1),
      (endX + perpendicularX * maximumRadius).toFixed(1) + ',' + (endY + perpendicularY * maximumRadius).toFixed(1)
    ];
    const right = [
      (endX - perpendicularX * maximumRadius).toFixed(1) + ',' + (endY - perpendicularY * maximumRadius).toFixed(1),
      (startX - perpendicularX * startRadius).toFixed(1) + ',' + (startY - perpendicularY * startRadius).toFixed(1)
    ];
    const middleX = (startX + endX) / 2;
    const middleY = (startY + endY) / 2;
    const gradientX1 = middleX + perpendicularX * maximumRadius;
    const gradientY1 = middleY + perpendicularY * maximumRadius;
    const gradientX2 = middleX - perpendicularX * maximumRadius;
    const gradientY2 = middleY - perpendicularY * maximumRadius;
    const gradient = '<linearGradient id="' + gradientId + '" gradientUnits="userSpaceOnUse" x1="' + gradientX1.toFixed(1) + '" y1="' + gradientY1.toFixed(1) + '" x2="' + gradientX2.toFixed(1) + '" y2="' + gradientY2.toFixed(1) + '"><stop offset="0" stop-color="' + color + '" stop-opacity=".02"></stop><stop offset=".28" stop-color="' + color + '" stop-opacity=".11"></stop><stop offset=".5" stop-color="' + color + '" stop-opacity=".3"></stop><stop offset=".72" stop-color="' + color + '" stop-opacity=".11"></stop><stop offset="1" stop-color="' + color + '" stop-opacity=".02"></stop></linearGradient>';
    return '<defs>' + gradient + '</defs><polygon class="' + className + '" style="fill:url(#' + gradientId + ');stroke:none" points="' + left.concat(right).join(' ') + '"></polygon>';
  };
  const cone = coneFor(primaryPoints, 'storm-cone' + (primaryProjection ? ' projected' : ''), 'storm-probability-primary', '#2b91c6', threat.radiusKm);
  const secondaryCones = approachProjections.filter(projection => projection.id !== threat.id).map((projection, index) => {
    const cell = radarCells.find(candidate => candidate.id === projection.id);
    return coneFor(projection.points, 'storm-cone projected secondary', 'storm-probability-secondary-' + index, '#5e93ad', cell?.radiusKm);
  }).join('');
  const mapProbabilityStep = value => value <= 0 ? 0 : value < 20 ? 1 : value < 40 ? 2 : value < 60 ? 3 : value < 80 ? 4 : 5;
  const mapRainIntensityStep = value => value <= 0 ? 0 : value < 2 ? 1 : value < 10 ? 2 : value < 30 ? 3 : value < 60 ? 4 : 5;
  const mapRainSynthesisStep = (probability, intensity) => {
    const intensityLevel = mapRainIntensityStep(intensity);
    const probabilityValue = Math.max(0, Math.min(100, Number(probability) || 0));
    return intensityLevel && probabilityValue ? Math.max(1, Math.min(5, Math.ceil(intensityLevel * (.5 + probabilityValue / 200)))) : 0;
  };
  const mapFlashCountStep = value => value <= 0 ? 0 : value === 1 ? 1 : value < 4 ? 2 : value < 7 ? 3 : value < 10 ? 4 : 5;
  const mapFlashesNearCell = cell => (lightning?.flashes || []).filter(flash => Math.hypot(Number(flash.eastKm || 0) - Number(cell.eastKm || 0), Number(flash.northKm || 0) - Number(cell.northKm || 0)) <= Math.max(8, Number(cell.radiusKm || 0) + 5)).length;
  const cells = radarCells.map((cell, index) => {
    const radius = Math.max(5, Number(cell.radiusKm || 1) * scale);
    const selected = Math.abs(cell.eastKm - threat.eastKm) < .1 && Math.abs(cell.northKm - threat.northKm) < .1;
    const cellId = cell.id || String.fromCharCode(65 + index);
    const name = 'Cellule ' + cellId;
    const distance = Math.hypot(Number(cell.eastKm || 0), Number(cell.northKm || 0));
    const point15 = cell.track?.points?.find(point => point.minutes === 15);
    const distance15 = point15 ? Math.hypot(Number(point15.eastKm || 0), Number(point15.northKm || 0)) : null;
    const radialSpeed = distance15 == null ? null : Math.round((distance15 - distance) * 4);
    const relativeMotion = radialSpeed == null ? 'Évolution de la distance : à confirmer' : radialSpeed > 1 ? 'Vitesse d’éloignement : ' + radialSpeed + ' km/h' : radialSpeed < -1 ? 'Vitesse de rapprochement : ' + Math.abs(radialSpeed) + ' km/h' : 'Distance quasiment stable';
    const eta = cell.etaMinutes == null ? '—' : cell.etaMinutes <= 0 ? 'en cours' : Math.round(cell.etaMinutes) + ' min';
    const risks = cell.risks || {};
    const detail = name + '\nDistance : ' + distance.toFixed(1) + ' km\n' + relativeMotion + '\nETA : ' + eta + '\nPassage : ' + Math.round(Number(risks.passage) || 0) + ' %\nOrage : ' + Math.round(Number(risks.storm) || 0) + ' %\nGrêle : ' + Math.round(Number(risks.hail) || 0) + ' %\nPluie intense : ' + Math.round(Number(risks.intenseRain) || 0) + ' %\nSurface : ' + Number(cell.areaKm2 || 0).toFixed(0) + ' km²\nRayon : ' + Number(cell.radiusKm || 0).toFixed(1) + ' km\nPluie maximale : ' + Number(cell.maximum || 0).toFixed(1) + ' mm/h\nPluie moyenne : ' + Number(cell.mean || 0).toFixed(1) + ' mm/h';
    const cellX = x(cell.eastKm);
    const cellY = y(cell.northKm);
    const tatinsX = x(0);
    const tatinsY = y(0);
    const edgeDistance = Math.max(0, distance - Math.max(0, Number(cell.radiusKm || 0)));
    const distanceLabel = edgeDistance.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " km";
    const rainLevel = mapRainSynthesisStep(Math.round(Number(risks.intenseRain) || 0), Number(cell.maximum));
    const hailLevel = mapProbabilityStep(Math.round(Number(risks.hail) || 0));
    const lightningLevel = mapFlashCountStep(mapFlashesNearCell(cell));
    const weightedIntensityLevel = rainLevel * .4 + hailLevel * .3 + lightningLevel * .3;
    const cellIntensityLevel = rainLevel || hailLevel || lightningLevel ? Math.max(1, Math.min(5, Math.round(weightedIntensityLevel))) : 0;
    const linkLength = Math.max(1, Math.hypot(tatinsX - cellX, tatinsY - cellY));
    const linkX = (tatinsX - cellX) / linkLength;
    const linkY = (tatinsY - cellY) / linkLength;
    const cellEdgeX = cellX + linkX * radius;
    const cellEdgeY = cellY + linkY * radius;
    const labelX = cellEdgeX + (tatinsX - cellEdgeX) * .32 - linkY * 13;
    const labelY = cellEdgeY + (tatinsY - cellEdgeY) * .32 + linkX * 13;
    const labelWidth = Math.max(72, distanceLabel.length * 6.3 + 12);
    const intensityDots = Array.from({ length: 5 }, (_, dotIndex) => '<circle class="cell-intensity-dot' + (dotIndex < cellIntensityLevel ? ' active' : '') + '" style="fill:' + (dotIndex < cellIntensityLevel ? '#d29319' : '#dfe7eb') + '" cx="' + (-16 + dotIndex * 8) + '" cy="10" r="2.3"></circle>').join('');
    return '<g class="radar-cell-marker" data-nowcast-cell="' + escapeText(cellId) + '"><line class="cell-distance-link" x1="' + cellEdgeX.toFixed(1) + '" y1="' + cellEdgeY.toFixed(1) + '" x2="' + tatinsX.toFixed(1) + '" y2="' + tatinsY.toFixed(1) + '"></line><g class="cell-distance-badge" transform="translate(' + labelX.toFixed(1) + ' ' + labelY.toFixed(1) + ')"><rect x="' + (-labelWidth / 2).toFixed(1) + '" y="-16" width="' + labelWidth.toFixed(1) + '" height="34" rx="8"></rect><text x="0" y="-3" text-anchor="middle">' + distanceLabel + '</text><g aria-hidden="true">' + intensityDots + '</g></g><circle class="radar-cell' + (selected ? ' selected' : '') + '" cx="' + cellX.toFixed(1) + '" cy="' + cellY.toFixed(1) + '" r="' + radius.toFixed(1) + '" tabindex="0" aria-label="' + escapeText(name + " · bord à " + distanceLabel + " des Tatins · intensité " + cellIntensityLevel + " sur 5") + '"></circle><text class="cell-name' + (selected ? '' : ' secondary') + '" x="' + (cellX - radius - 4).toFixed(1) + '" y="' + (cellY - radius - 4).toFixed(1) + '" text-anchor="end">' + escapeText(cellId) + '</text></g>';
  }).join('');
  const lightningMarks = (lightning?.flashes || []).filter(flash => flash.eastKm >= minimumEast && flash.eastKm <= maximumEast && flash.northKm >= minimumNorth && flash.northKm <= maximumNorth).map(flash => '<g class="lightning-flash" transform="translate(' + x(flash.eastKm).toFixed(1) + ' ' + y(flash.northKm).toFixed(1) + ')"><path d="M2-8-4 1h4l-2 8 7-11H1z"></path><title>Éclair · ' + escapeText(Number(flash.distanceKm).toFixed(1)) + ' km des Tatins</title></g>').join('');
  const secondaryTracks = radarCells.filter(cell => cell.id !== threat.id && cell.track?.points?.length).map(cell => {
    const projection = projectionsById.get(cell.id);
    const track = projection?.points || cell.track.points;
    return '<polyline class="storm-track secondary' + (projection ? ' projected' : '') + '" points="' + track.map(point => x(point.eastKm).toFixed(1) + ',' + y(point.northKm).toFixed(1)).join(' ') + '"><title>Trajectoire prévue de la cellule ' + escapeText(cell.id) + '</title></polyline>';
  }).join('');
  const milestones = '';
  const targetX = x(0).toFixed(1);
  const targetY = y(0).toFixed(1);
  const rangeRings = [20, 40, 60].filter(distance => distance * scale <= Math.min(width / 2 - paddingX, height / 2 - paddingY)).map(distance => {
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
  const scaleBarKm = scale * 20 > 150 ? 10 : 20;
  const scaleBarWidth = scaleBarKm * scale;
  return '<div class="storm-map"><div class="storm-map-leaflet" aria-hidden="true"></div><div class="nowcast-map-attribution"><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a> · <a href="https://carto.com/attributions" target="_blank" rel="noopener">© CARTO</a></div>' + updateAgeMarkup + '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Trajectoire prévue de la cellule ' + escapeText(threat.id) + ' sur la carte à ' + mapRadiusKm + ' km"><defs><marker id="storm-arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z"></path></marker></defs>' +
    '<path class="map-axis" d="M' + targetX + ' 14V' + (height - 14) + 'M18 ' + targetY + 'H' + (width - 18) + '"></path><g class="north-arrow"><path d="M28 40V17l-5 8m5-8 5 8"></path><text x="23" y="54">N</text></g>' + rangeRings +
    distanceLink + cone + secondaryCones + secondaryTracks + cells + lightningMarks + (trackPoints ? '<polyline class="storm-track' + (primaryProjection ? ' projected' : '') + '" points="' + trackPoints + '"></polyline>' : '') + milestones +
    '<g class="target-point"><circle cx="' + targetX + '" cy="' + targetY + '" r="5"></circle><text x="' + targetX + '" y="' + (Number(targetY) + (compactDesktopMap ? 36 : 28)) + '" text-anchor="middle">Les Tatins</text></g>' +
    '<g class="scale-bar"><path d="M24 ' + (height - 26) + 'v5h' + scaleBarWidth.toFixed(1) + 'v-5"></path><text x="24" y="' + (height - 32) + '">' + scaleBarKm + ' km</text></g>' +
    '</svg><div class="map-legend"><span><i class="legend-cell"></i> cellule</span><span><i class="legend-cone"></i> zone probable</span>' + (window.METEO_REPLAY ? '' : '<span><i class="legend-lightning">ϟ</i> foudre</span>') + '</div></div>';
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
  const compactDesktopMap = !window.matchMedia("(max-width: 1100px)").matches;
  const width = compactDesktopMap ? 640 : 360;
  const height = compactDesktopMap ? 640 : 360;
  const scale = width === 360
    ? (width - 32) / (mapRadiusKm * 2)
    : Math.min((width - 32) / (mapRadiusKm * 2.02), (height - 32) / (mapRadiusKm * 2.02));
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
    zoomSnap: 1,
    fadeAnimation: false,
    zoomAnimation: false,
    markerZoomAnimation: false
  }).setView([point.lat, point.lon], mapRadiusKm === 20 ? 9 : 7);
  window.L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", { maxZoom: 19, attribution: "" }).addTo(nowcastLeafletMap);
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
      const box = { left: screenPoint.x - 2, right: screenPoint.x + widthEstimate + 6, top: screenPoint.y - 15, bottom: screenPoint.y + 2 };
      if (box.right < 4 || box.left > container.clientWidth - 4 || box.bottom < 4 || box.top > container.clientHeight - 4) return;
      if (occupied.some(other => box.left < other.right + 5 && box.right > other.left - 5 && box.top < other.bottom + 4 && box.bottom > other.top - 4)) return;
      occupied.push(box);
      const icon = window.L.divIcon({ className: "osm-place-label " + place.place, html: '<i class="osm-place-dot" aria-hidden="true"></i><span>' + escapeText(place.name) + '</span>', iconSize: [4, 4], iconAnchor: [2, 2] });
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
  if (!radar) {
    if (summaryElement) summaryElement.innerHTML = "";
    element.innerHTML = '<strong>Radar</strong><span>Acquisition de la première trame en cours…</span>';
    return;
  }
  const cardinal = bearing => {
    const labels = ["nord", "nord-est", "est", "sud-est", "sud", "sud-ouest", "ouest", "nord-ouest"];
    return labels[Math.round(Number(bearing || 0) / 45) % 8];
  };
  const directionLabel = bearing => {
    const direction = cardinal(bearing).toUpperCase();
    return (direction === "EST" || direction === "OUEST" ? "L’" : "LE ") + direction;
  };
  const firstPiafRain = (piaf?.values || []).find(item => Number(item.nowcastPrecipitation ?? item.precipitation) >= measurableRainThreshold);
  const etaSeconds = radar.etaSeconds ?? firstPiafRain?.seconds ?? null;
  const threeHours = (piaf?.values || []).filter(item => item.seconds <= 3 * 3600);
  const rainAmount = Math.round(threeHours.reduce((sum, item) => sum + (Number(item.nowcastPrecipitation ?? item.precipitation) || 0), 0) * 10) / 10;
  const now = appNow();
  const upcomingWind = (arome?.hours || []).filter(item => {
    const time = new Date(item.time).getTime();
    return Number.isFinite(time) && time >= now - 30 * 60000 && time <= now + 3 * 3600000;
  });
  const windWindow = upcomingWind.length ? upcomingWind : (arome?.hours || []).slice(0, 3);
  const maximumGust = Math.round(Math.max(0, ...windWindow.map(item => Number(item.windGust) || 0)));
  const nowcastMetricIcons = {
    rain: '<path d="M12 2.8C9.5 6.4 6.8 9.7 6.8 13.2a5.2 5.2 0 0 0 10.4 0C17.2 9.7 14.5 6.4 12 2.8Z"/>',
    gust: '<path d="M3 7h12c4 0 4-5 .7-5-1.5 0-2.5.8-2.9 2M3 12h17M3 17h10c4 0 4 5 .7 5-1.5 0-2.5-.8-2.9-2"/>',
    storm: '<path class="storm-cloud" d="M4.2 14.2a3.4 3.4 0 0 1 .4-6.8A5.3 5.3 0 0 1 15 6a3.8 3.8 0 0 1 3.1 1.6 3.3 3.3 0 0 1 .7 6.6H4.2Z"/><path class="storm-bolt" d="M11.2 10.8 7.8 16h3l-1.4 6 7-9h-3.2l1.5-2.2h-3.5Z"/>',
    lightning: '<path d="M13.5 2 6.8 13h5l-1.2 9L18 10.5h-5L13.5 2Z"/>',
    hail: '<path d="M5 13.5a4 4 0 0 1 .2-8A6 6 0 0 1 17 6.5a3.5 3.5 0 1 1 .5 7H5Z"/><circle class="hailstone" cx="7.5" cy="18" r="1.6"/><circle class="hailstone" cx="12.5" cy="20" r="1.6"/><circle class="hailstone" cx="17.5" cy="18" r="1.6"/>'
  };
  const nowcastMetricPictogram = (kind, step, label, showSymbol = true, showScale = true) => {
    const level = Math.max(0, Math.min(5, Math.round(Number(step) || 0)));
    const scale = showScale ? '<span class="week-metric-scale" aria-hidden="true">' + Array.from({ length: 5 }, (_, index) => '<i class="' + (index < level ? "solid" : "") + '"></i>').join("") + '</span>' : '';
    const symbol = showSymbol ? '<svg viewBox="0 0 24 24" aria-hidden="true">' + nowcastMetricIcons[kind] + '</svg>' : "";
    return '<span class="week-metric-pictogram ' + kind + '" role="img" aria-label="' + escapeText(label) + '" title="' + escapeText(label) + '">' + symbol + scale + '</span>';
  };
  // Intensité radar en mm/h : faible, modérée, forte, très forte, extrême.
  const rainIntensityStep = value => value <= 0 ? 0 : value < 2 ? 1 : value < 10 ? 2 : value < 30 ? 3 : value < 60 ? 4 : 5;
  const probabilityStep = value => value <= 0 ? 0 : value < 20 ? 1 : value < 40 ? 2 : value < 60 ? 3 : value < 80 ? 4 : 5;
  const flashCountStep = value => value <= 0 ? 0 : value === 1 ? 1 : value < 4 ? 2 : value < 7 ? 3 : value < 10 ? 4 : 5;
  const forecastTrend = (start, end, threshold) => {
    const change = end - start;
    return {
      label: change > threshold ? "croissant" : change < -threshold ? "decroissant" : "stable",
      change
    };
  };
  const splitForecastWindow = (values, value) => {
    const count = Math.max(1, Math.floor(values.length / 3));
    const average = group => group.reduce((sum, item) => sum + (Number(value(item)) || 0), 0) / Math.max(1, group.length);
    return { start: average(values.slice(0, count)), end: average(values.slice(-count)) };
  };
  const piafRainTrend = values => {
    const radarAdjusted = values.some(item => item.radarCellOverPoint);
    const series = values.map(item => Math.max(0, Number(item.nowcastPrecipitation ?? item.precipitation) || 0));
    const total = series.reduce((sum, value) => sum + value, 0);
    const wetIndexes = series.map((value, index) => value > 0 ? index : -1).filter(index => index >= 0);
    const stepDetail = series.length + " pas PIAF de 5 min analysés";
    const sourceDetail = radarAdjusted ? "PIAF amendé par le radar" : "PIAF";
    if (!wetIndexes.length || total <= 0) return { label: "stable", change: 0, detail: "Aucune pluie prévue par " + sourceDetail + " · " + stepDetail };

    // Linear regression over every five-minute accumulation: isolated noise
    // has little influence, while a rain band moving into or out of the period
    // gives the arrow a clear direction.
    const middleIndex = (series.length - 1) / 2;
    const mean = total / series.length;
    const numerator = series.reduce((sum, value, index) => sum + (index - middleIndex) * (value - mean), 0);
    const denominator = series.reduce((sum, _, index) => sum + (index - middleIndex) ** 2, 0) || 1;
    const projectedChange = numerator / denominator * Math.max(0, series.length - 1);
    const threshold = Math.max(.005, Math.max(...series) * .15);
    const firstWet = wetIndexes[0];
    const lastWet = wetIndexes.at(-1);
    const lead = index => "+" + Math.round(Number(values[index]?.seconds) / 60) + " min";
    const timing = "premier signal " + lead(firstWet) + " · dernier signal " + lead(lastWet) + " · " + stepDetail;

    const peak = Math.max(...series);
    const peakIndex = series.indexOf(peak);
    // La flèche suit l'évolution du premier épisode pluvieux : si les
    // quantités montent vers un pic, elle monte, même si l'averse cesse plus tard.
    if (peakIndex > firstWet && peak - series[firstWet] > threshold) {
      return { label: "croissant", change: peak - series[firstWet], detail: "Pluie augmentant au fil des prochains créneaux selon PIAF · " + timing };
    }
    if (peakIndex === firstWet && (lastWet < series.length - 1 || peak - series[lastWet] > threshold)) {
      return { label: "decroissant", change: series[lastWet] - peak, detail: "Pluie diminuant au fil des prochains créneaux selon PIAF · " + timing };
    }
    if (projectedChange > threshold) {
      const wording = firstWet > 0 ? "Pluie arrivant" : "Pluie s’intensifiant";
      return { label: "croissant", change: projectedChange, detail: wording + " selon " + sourceDetail + " · " + timing };
    }
    if (projectedChange < -threshold) {
      const wording = lastWet < series.length - 1 ? "Pluie cessant" : "Pluie s’atténuant";
      return { label: "decroissant", change: projectedChange, detail: wording + " selon " + sourceDetail + " · " + timing };
    }
    const wording = firstWet > 0 && lastWet < series.length - 1 ? "Passage pluvieux temporaire" : "Pluie globalement stable";
    return { label: "stable", change: projectedChange, detail: wording + " selon " + sourceDetail + " · " + timing };
  };
  const trendMarkup = (trend, source) => {
    const arrow = trend.label === "croissant"
      ? '<path d="M10 14V6m0 0L7 9m3-3 3 3"/>'
      : trend.label === "decroissant"
        ? '<path d="M10 6v8m0 0-3-3m3 3 3-3"/>'
        : '<path d="M6 10h8m0 0-3-3m3 3-3 3"/>';
    const wording = trend.label === "croissant" ? "en hausse" : trend.label === "decroissant" ? "en baisse" : "stable";
    const detail = trend.detail || "Tendance " + wording + " sur les 3 prochaines heures" + (source ? " (" + source + ")" : "");
    return '<span class="three-hour-trend ' + trend.label + '" title="' + escapeText(detail) + '" aria-label="' + escapeText(detail) + '"><b aria-hidden="true"><svg viewBox="0 0 20 20">' + arrow + '</svg></b></span>';
  };
  // Synthèse pluie : l'intensité fixe le plafond, puis la probabilité module
  // ce niveau sans jamais transformer une pluie très faible en signal fort.
  const rainSynthesisStep = (probability, intensity) => {
    const intensityLevel = rainIntensityStep(intensity);
    const probabilityValue = Math.max(0, Math.min(100, Number(probability) || 0));
    if (!intensityLevel || !probabilityValue) return 0;
    return Math.max(1, Math.min(5, Math.ceil(intensityLevel * (0.5 + probabilityValue / 200))));
  };
  const summaryAction = (kind, value, level, detail, trend, target = null, stormPassageLevel = null, stormDetails = null) => {
    const stormLayout = stormPassageLevel != null;
    const passageDetail = stormDetails?.passage || detail;
    const intensityDetail = stormDetails?.intensity || detail;
    const displayedTrend = stormDetails?.trend ? { ...trend, detail: stormDetails.trend } : trend;
    const showStormIntensity = stormDetails?.showIntensity ?? stormPassageLevel > 0;
    const metric = stormLayout
      ? nowcastMetricPictogram(kind, stormPassageLevel, passageDetail)
        + (displayedTrend ? trendMarkup(displayedTrend, passageDetail) : '')
        + (showStormIntensity ? '<span class="three-hour-storm-intensity"><strong>intensité</strong>' + nowcastMetricPictogram(kind, level, intensityDetail, false) + '</span>' : '')
      : nowcastMetricPictogram(kind, level, detail) + (trend ? trendMarkup(trend, detail) : '') + (value ? '<b>' + escapeText(value) + '</b>' : '');
    return '<button class="three-hour-action metric-' + kind + (target ? ' actionable' : '') + '" type="button"' + (target ? ' data-summary-target="' + target + '"' : ' aria-disabled="true"') + ' aria-label="' + escapeText(detail) + '" title="' + escapeText(detail) + '"><span class="three-hour-action-body">' + metric + '</span></button>';
  };
  const latestDataTime = radar.observedAt ? hourFormat.format(new Date(radar.observedAt)) : "—";
  const threat = radar.threat;
  const cells = (radar.cells || []).map((cell, index) => ({ ...cell, id: cell.id || String.fromCharCode(65 + index) }));
  const maximumPassageRisk = Math.max(0, ...cells.map(cell => Math.round(Number(cell.risks?.passage) || 0)));
  const cellCenterDistance = cell => Math.hypot(Number(cell.eastKm || 0), Number(cell.northKm || 0));
  // La distance utile est celle du bord le plus proche, pas celle du centre.
  const cellDistance = cell => Math.max(0, cellCenterDistance(cell) - Math.max(0, Number(cell.radiusKm || 0)));
  const vigilanceNow = Date.now();
  const vigilancePeriodActive = period =>
    (!period.start || new Date(period.start).getTime() <= vigilanceNow)
    && (!period.end || vigilanceNow < new Date(period.end).getTime());
  const orangeVigilanceActive = (vigilance?.alerts || []).some(alert => {
    if (alert.label !== "Orages") return false;
    const timeline = Array.isArray(alert.timeline) ? alert.timeline : [];
    return timeline.length
      ? timeline.some(period => Number(period.colorId) >= 3 && vigilancePeriodActive(period))
      : Number(alert.colorId) >= 3 && vigilancePeriodActive(alert);
  });
  const stormForecastStart = new Date(vigilanceNow);
  stormForecastStart.setMinutes(0, 0, 0);
  const stormForecastEnd = stormForecastStart.getTime() + 3 * 60 * 60 * 1000;
  const meteoFranceStormForecastActive = (arome?.hours || []).some(hour => {
    const time = new Date(hour.time).getTime();
    return Boolean(hour.stormSignal) && time >= stormForecastStart.getTime() && time <= stormForecastEnd;
  });
  const openMeteoStormForecastActive = (latestForecastData?.openMeteo?.hours || []).some(hour => {
    const time = new Date(hour.time).getTime();
    return Number(hour.weatherCode) >= 95 && time >= stormForecastStart.getTime() && time <= stormForecastEnd;
  });
  const stormForecastSourceCount = Number(meteoFranceStormForecastActive) + Number(openMeteoStormForecastActive);
  // Les sources prévisionnelles imposent un plancher de 1 ou 2. Toute
  // probabilité de passage nowcasting supérieure à zéro utilise également
  // l'échelle complète de 1 à 5, indépendamment de l'intensité affichée.
  const rawStormPassageLevel = probabilityStep(maximumPassageRisk);
  if (!nowcastMapRadiusManuallySelected) {
    activeNowcastMapRadius = cells.some(cell => cellDistance(cell) < 20) ? 20 : 60;
  }
  const currentObservation = new Date(radar.observedAt || 0).getTime();
  const previousObservation = new Date(cellPassageSnapshot?.observedAt || 0).getTime();
  const previousPassageSnapshot = cellPassageSnapshot
    && radar.observedAt !== cellPassageSnapshot.observedAt
    && Number.isFinite(currentObservation)
    && Number.isFinite(previousObservation)
    && currentObservation > previousObservation
    && currentObservation - previousObservation <= 45 * 60000
      ? cellPassageSnapshot
      : null;
  const previousDisplayedLevelSnapshot = cellPassageSnapshot
    && Number.isFinite(currentObservation)
    && Number.isFinite(previousObservation)
    && currentObservation >= previousObservation
    && currentObservation - previousObservation <= 45 * 60000
      ? cellPassageSnapshot
      : null;
  const passageTrendFor = cell => {
    let trend = cell?.passageTrend;
    if (!trend && previousPassageSnapshot && Object.prototype.hasOwnProperty.call(previousPassageSnapshot.values, cell?.id)) {
      const previous = Number(previousPassageSnapshot.values[cell.id]);
      const current = Number(cell.risks?.passage);
      if (Number.isFinite(previous) && Number.isFinite(current)) {
        const change = Math.round(current - previous);
        trend = { label: change > 0 ? "croissant" : change < 0 ? "decroissant" : "stable", change };
      }
    }
    return trend && ["croissant", "decroissant", "stable"].includes(trend.label) ? trend : null;
  };
  const formatMinutes = minutes => {
    const rounded = Math.max(0, Math.round(minutes));
    if (rounded < 60) return rounded + " min";
    const hours = Math.floor(rounded / 60);
    const remaining = rounded % 60;
    return hours + " h" + (remaining ? " " + remaining : "");
  };
  const nearbyCells = cells.filter(cell => cellDistance(cell) < 60);
  const riskTone = value => value >= 60 ? "high" : value >= 30 ? "medium" : value > 0 ? "low" : "none";
  const hazardIcons = {
    hail: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 14a4 4 0 0 1 .2-8A6 6 0 0 1 17 7a3.5 3.5 0 1 1 .5 7H5Z"></path><circle cx="8" cy="18" r="1.5"></circle><circle cx="13" cy="19" r="1.5"></circle><circle cx="18" cy="17.5" r="1.5"></circle></svg>',
    wind: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h11c3.5 0 3.5-4.5.5-4.5-1.3 0-2.2.7-2.6 1.7M3 12h16M3 16h10c3.7 0 3.7 4.5.5 4.5-1.4 0-2.3-.7-2.7-1.8"></path></svg>',
    rain: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3C9 7.2 6.5 10.4 6.5 14a5.5 5.5 0 0 0 11 0C17.5 10.4 15 7.2 12 3Z"></path></svg>',
    lightning: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 2-8 12h6l-2 8 8-12h-6l2-8Z"></path></svg>'
  };
  const hazardMetric = (kind, tone, title, pictogram) => '<span class="cell-hazard pictogram-only ' + tone + '" title="' + escapeText(title) + '">' + pictogram + '</span>';
  const flashesNearCell = cell => (lightning?.flashes || []).filter(flash => {
    const distance = Math.hypot(Number(flash.eastKm || 0) - Number(cell.eastKm || 0), Number(flash.northKm || 0) - Number(cell.northKm || 0));
    return distance <= Math.max(8, Number(cell.radiusKm || 0) + 5);
  }).length;
  const lightningIntensityStep = flashes => flashes <= 0 ? 0 : flashes === 1 ? 2 : flashes < 5 ? 3 : flashes < 10 ? 4 : 5;
  const stormIntensityFor = cell => {
    const passage = Math.round(Number(cell.risks?.passage) || 0);
    const rain = Math.max(0, Number(cell.maximum) || 0);
    const intenseRainRisk = Math.round(Number(cell.risks?.intenseRain) || 0);
    const hailRisk = Math.round(Number(cell.risks?.hail) || 0);
    const flashes = flashesNearCell(cell);
    const rainLevel = rainSynthesisStep(intenseRainRisk, rain);
    const hailLevel = probabilityStep(hailRisk);
    const lightningLevel = lightningIntensityStep(flashes);
    const weightedLevel = rainLevel * .4 + hailLevel * .3 + lightningLevel * .3;
    const level = rainLevel || hailLevel || lightningLevel ? Math.max(1, Math.min(5, Math.round(weightedLevel))) : 0;
    return { cell, passage, rain, intenseRainRisk, hailRisk, flashes, rainLevel, hailLevel, lightningLevel, level };
  };
  // Le premier indicateur décrit uniquement la probabilité de passage. Le
  // second décrit l'intensité de la cellule qui porte le maximum. A égalité
  // de probabilité, la cellule la plus intense est retenue.
  const passageCandidates = cells
    .filter(cell => Number(cell.risks?.passage) > 0)
    .map(cell => stormIntensityFor(cell))
    .sort((left, right) => right.passage - left.passage || right.level - left.level || cellDistance(left.cell) - cellDistance(right.cell));
  const relevantStormIntensity = passageCandidates[0] || null;
  const relevantStormCell = relevantStormIntensity?.cell || null;
  const otherPassageCells = passageCandidates.slice(1);
  const nowcastStormPassageLevel = rawStormPassageLevel;
  const stormPassageLevel = Math.max(nowcastStormPassageLevel, stormForecastSourceCount, orangeVigilanceActive ? 1 : 0);
  const rainTrend = piafRainTrend(threeHours);
  const windTrendWindow = splitForecastWindow(windWindow, item => item.windGust);
  const windTrend = forecastTrend(windTrendWindow.start, windTrendWindow.end, 4);
  const snapshotPassages = previousPassageSnapshot
    ? Object.values(previousPassageSnapshot.values || {}).map(Number).filter(Number.isFinite)
    : [
        ...cells.map(cell => Number(cell.passageTrend?.previous)).filter(Number.isFinite),
        ...(radar.disappearedCells || []).map(cell => Number(cell.risks?.passage)).filter(Number.isFinite)
      ];
  const previousMaximumPassageRisk = snapshotPassages.length ? Math.max(0, ...snapshotPassages) : maximumPassageRisk;
  const maximumPassageChange = Math.round(maximumPassageRisk - previousMaximumPassageRisk);
  const previousRawStormPassageLevel = probabilityStep(previousMaximumPassageRisk);
  const previousNowcastStormPassageLevel = previousRawStormPassageLevel;
  const savedStormPassageLevel = Number(previousDisplayedLevelSnapshot?.displayedLevel);
  const previousStormPassageLevel = Number.isFinite(savedStormPassageLevel)
    ? savedStormPassageLevel
    : Math.max(previousNowcastStormPassageLevel, stormForecastSourceCount, orangeVigilanceActive ? 1 : 0);
  const stormPassageLevelChange = stormPassageLevel - previousStormPassageLevel;
  const stormTrendUsesDisplayedLevel = stormPassageLevelChange !== 0;
  const stormTrendChange = stormTrendUsesDisplayedLevel ? stormPassageLevelChange : maximumPassageChange;
  const stormTrend = {
    label: stormTrendChange > 0 ? "croissant" : stormTrendChange < 0 ? "decroissant" : "stable",
    change: stormTrendChange,
    previous: stormTrendUsesDisplayedLevel ? previousStormPassageLevel : previousMaximumPassageRisk,
    basis: stormTrendUsesDisplayedLevel ? "displayed-level" : "passage-probability"
  };
  const passageTrendMarkup = cell => {
    const trend = passageTrendFor(cell);
    if (!trend) return "";
    const arrow = trend.label === "croissant" ? "↗" : trend.label === "decroissant" ? "↘" : "→";
    const wording = trend.label === "croissant" ? "Risque en hausse" : trend.label === "decroissant" ? "Risque en baisse" : "Risque stable";
    const change = Number(trend.change);
    const radialChange = Number(trend.radialChangeKm);
    const motionDetail = Number.isFinite(radialChange) && Math.abs(radialChange) >= .1
      ? " · cellule " + (radialChange > 0 ? "plus éloignée de " : "plus proche de ") + Math.abs(radialChange).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " km à +15 min"
      : "";
    const detail = (Number.isFinite(change) && change !== 0 ? wording + " de " + Math.abs(change) + " point" + (Math.abs(change) > 1 ? "s" : "") : wording) + motionDetail;
    return '<span class="cell-passage-trend ' + trend.label + '" title="' + escapeText(detail) + '" aria-label="' + escapeText(detail) + '">' + arrow + '</span>';
  };
  const detailMetric = (label, value) => value == null || value === "" ? "" : '<div><dt>' + escapeText(label) + '</dt><dd>' + escapeText(value) + '</dd></div>';
  const cellCard = cell => {
    const risks = cell.risks || {};
    const passageRisk = Math.round(Number(risks.passage) || 0);
    const hailRisk = Math.round(Number(risks.hail) || 0);
    const rainRisk = Math.round(Number(risks.intenseRain) || 0);
    const rainIntensity = Number(cell.maximum);
    const rainIntensityLabel = Number.isFinite(rainIntensity)
      ? rainIntensity.toLocaleString("fr-FR", { minimumFractionDigits: rainIntensity < 1 ? 2 : 1, maximumFractionDigits: 2 }) + " mm/h"
      : null;
    const rainMean = Number(cell.mean);
    const rainMeanLabel = Number.isFinite(rainMean) ? rainMean.toLocaleString("fr-FR", { minimumFractionDigits: rainMean < 1 ? 2 : 1, maximumFractionDigits: 2 }) + " mm/h" : null;
    const flashes = flashesNearCell(cell);
    const lightningTone = flashes >= 5 ? "high" : flashes >= 2 ? "medium" : flashes > 0 ? "low" : "none";
    const rainLevel = rainIntensityLabel ? rainSynthesisStep(rainRisk, rainIntensity) : 0;
    const rainPictogram = nowcastMetricPictogram("rain", rainLevel, "Pluie : niveau " + rainLevel + " sur 5 · risque de pluie intense " + rainRisk + " %" + (rainIntensityLabel ? " · maximale " + rainIntensityLabel : "") + (rainMeanLabel ? " · moyenne " + rainMeanLabel : ""));
    const hailPictogram = nowcastMetricPictogram("hail", probabilityStep(hailRisk), "Grêle : risque " + hailRisk + " %");
    const lightningPictogram = nowcastMetricPictogram("lightning", flashCountStep(flashes), "Éclairs : " + flashes + (flashes === 1 ? " éclair détecté près de la cellule" : " éclairs détectés près de la cellule"));
    const hailLevel = probabilityStep(hailRisk);
    const lightningLevel = flashCountStep(flashes);
    const weightedIntensityLevel = rainLevel * .4 + hailLevel * .3 + lightningLevel * .3;
    const cellIntensityLevel = rainLevel || hailLevel || lightningLevel ? Math.max(1, Math.min(5, Math.round(weightedIntensityLevel))) : 0;
    const hazards = hazardMetric("hail", riskTone(hailRisk), "Grêle : risque " + hailRisk + " %", hailPictogram)
      + hazardMetric("rain", riskTone(rainRisk), "Pluie : niveau " + rainLevel + " sur 5 · risque " + rainRisk + " %" + (rainIntensityLabel ? " · maximale " + rainIntensityLabel : "") + (rainMeanLabel ? " · moyenne " + rainMeanLabel : ""), rainPictogram)
      + (window.METEO_REPLAY ? "" : hazardMetric("lightning", lightningTone, "Éclairs : " + flashes + " détecté" + (flashes === 1 ? "" : "s") + " près de la cellule", lightningPictogram));
    const detailsId = "cell-details-" + String(cell.id).replace(/[^a-z0-9_-]/gi, "");
    const details = [
      detailMetric("Distance du centre", cellCenterDistance(cell).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " km"),
      detailMetric("Rayon estimé", Number.isFinite(Number(cell.radiusKm)) ? Number(cell.radiusKm).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " km" : null),
      risks.storm == null ? "" : '<div class="nowcast-convective"><dt>Indice convectif</dt><dd>' + nowcastMetricPictogram("storm", probabilityStep(Number(risks.storm)), "Indice convectif : niveau " + probabilityStep(Number(risks.storm)) + " sur 5", false) + "</dd></div>",
      detailMetric("Vitesse estimée", Number.isFinite(Number(cell.track?.speedKmh)) ? Number(cell.track.speedKmh).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " km/h" : null),
      detailMetric("Confiance trajectoire", cell.track?.confidence == null ? null : Math.round(Number(cell.track.confidence)) + " %"),
      detailMetric("Suivie depuis", cell.trackedSince ? hourFormat.format(new Date(cell.trackedSince)) : null)
    ];
    const distance = cellDistance(cell).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " km";
    const etaMinutes = Number(cell.etaMinutes);
    const eta = Number.isFinite(etaMinutes) && etaMinutes > 0 && etaMinutes <= 240
      ? '<span class="nowcast-cell-eta">ETA ' + formatMinutes(etaMinutes) + '</span>'
      : '';
    const detailTitle = "Cellule " + cell.id + " · probabilité " + passageRisk + " % · distance " + distance + (eta ? " · ETA disponible" : "");
    return '<article class="nowcast-cell-card passage-' + riskTone(passageRisk) + '"><button class="nowcast-cell-card-button" type="button" data-nowcast-cell="' + escapeText(cell.id) + '" aria-expanded="false" aria-controls="' + escapeText(detailsId) + '" title="' + escapeText(detailTitle) + '"><span class="nowcast-cell-name"><strong>' + escapeText(cell.id) + '</strong><small>' + escapeText(distance) + '</small></span><span class="nowcast-cell-primary"><b>Passage : ' + passageRisk + ' %</b>' + passageTrendMarkup(cell) + eta + '</span><span class="nowcast-cell-intensity"><strong>intensité</strong>' + nowcastMetricPictogram('storm', cellIntensityLevel, 'Intensité : niveau ' + cellIntensityLevel + ' sur 5', false) + '</span></button><dl class="nowcast-cell-details" id="' + escapeText(detailsId) + '" hidden><div class="nowcast-cell-detail-hazards"><dt>Intensité détaillée</dt><dd><span class="cell-hazards">' + hazards + '</span></dd></div>' + details.filter(Boolean).join("") + '</dl></article>';
  };
  const cellsInRange = nearbyCells
    .filter(cell => cellDistance(cell) < activeNowcastMapRadius)
    .sort((left, right) => Number(right.risks?.passage || 0) - Number(left.risks?.passage || 0) || cellDistance(left) - cellDistance(right));
  const disappearedCellsInRange = (radar.disappearedCells || [])
    .filter(cell => {
      const centerDistance = Number.isFinite(Number(cell.lastDistanceKm)) ? Number(cell.lastDistanceKm) : cellCenterDistance(cell);
      return Math.max(0, centerDistance - Math.max(0, Number(cell.radiusKm || 0))) < activeNowcastMapRadius;
    })
    .sort((left, right) => new Date(right.disappearedAt || 0).getTime() - new Date(left.disappearedAt || 0).getTime());
  const disappearedCellCard = cell => {
    const centerDistance = Number.isFinite(Number(cell.lastDistanceKm)) ? Number(cell.lastDistanceKm) : cellCenterDistance(cell);
    const distance = Math.max(0, centerDistance - Math.max(0, Number(cell.radiusKm || 0))).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " km";
    const disappearedAt = new Date(cell.disappearedAt || 0).getTime();
    const referenceTime = Number.isFinite(currentObservation) ? currentObservation : Date.now();
    const elapsedMinutes = Number.isFinite(disappearedAt) ? Math.max(0, Math.round((referenceTime - disappearedAt) / 60000)) : null;
    const elapsed = elapsedMinutes == null ? "récemment" : "depuis " + formatMinutes(elapsedMinutes);
    const title = "Cellule " + cell.id + " · fin de détection " + elapsed + " · dernière distance " + distance;
    return '<article class="nowcast-cell-card disappeared"><button class="nowcast-cell-card-button" type="button" aria-disabled="true" title="' + escapeText(title) + '"><span class="nowcast-cell-name"><strong>' + escapeText(cell.id) + '</strong><small>' + escapeText(distance) + '</small></span><span class="nowcast-cell-missing-copy"><b>Fin de détection</b><small>' + escapeText(elapsed) + '</small></span></button></article>';
  };
  const cellCards = cellsInRange.map(cellCard).join("") + disappearedCellsInRange.map(disappearedCellCard).join("");
  const cellsPanel = '<section class="nowcast-cells-panel" aria-label="Cellules visibles sur la carte">'
    + (cellCards ? '<div class="nowcast-cell-grid">' + cellCards + '</div>' : '<p class="nowcast-cells-empty">Aucune cellule détectée dans ce périmètre.</p>')
    + '</section>';
  if (radar.observedAt && cellPassageSnapshot?.observedAt !== radar.observedAt) {
    cellPassageSnapshot = {
      observedAt: radar.observedAt,
      values: Object.fromEntries(cells.map(cell => [cell.id, Math.round(Number(cell.risks?.passage) || 0)])),
      displayedLevel: stormPassageLevel
    };
    try {
      localStorage.setItem("meteo-cell-passage-snapshot", JSON.stringify(cellPassageSnapshot));
    } catch {
      // L'affichage reste fonctionnel si le stockage local est indisponible.
    }
  }
  const stormLevel = relevantStormIntensity?.level || 0;
  const stormPassageFloorDetail = [
    orangeVigilanceActive ? "vigilance Orages orange ou rouge active : minimum 1" : "",
    openMeteoStormForecastActive ? "Open-Meteo prévoit un orage dans les 3 h" : "",
    meteoFranceStormForecastActive ? "Météo-France prévoit un orage dans les 3 h" : "",
    stormForecastSourceCount ? stormForecastSourceCount + " source" + (stormForecastSourceCount > 1 ? "s" : "") + " prévisionnelle" + (stormForecastSourceCount > 1 ? "s" : "") + " : minimum " + stormForecastSourceCount : ""
  ].filter(Boolean).join(" · ");
  const otherPassageDetail = otherPassageCells.length
    ? " · autres cellules : " + otherPassageCells.map(item => item.cell.id + " " + item.passage + " %").join(", ")
    : "";
  const stormDetail = relevantStormCell
    ? "Orage · cellule retenue " + relevantStormCell.id + " · probabilité de passage " + maximumPassageRisk + " % · intensité " + stormLevel + " sur 5" + otherPassageDetail
    : "Aucune cellule pluvio-convective susceptible de passer";
  const stormPassageDetail = relevantStormCell
    ? "Probabilité de passage maximale : " + maximumPassageRisk + " % · cellule " + relevantStormCell.id + " · niveau nowcasting " + nowcastStormPassageLevel + " sur 5 · niveau affiché " + stormPassageLevel + " sur 5" + (stormPassageFloorDetail ? " · " + stormPassageFloorDetail : "") + otherPassageDetail
    : "Probabilité de passage maximale : " + maximumPassageRisk + " % · niveau nowcasting " + nowcastStormPassageLevel + " sur 5 · niveau affiché " + stormPassageLevel + " sur 5" + (stormPassageFloorDetail ? " · " + stormPassageFloorDetail : "");
  const stormIntensityDetail = relevantStormCell
    ? "Intensité estimée de la cellule " + relevantStormCell.id + " : " + stormLevel + " sur 5"
    : "Aucune intensité de cellule à afficher";
  const stormTrendWording = stormTrend.label === "croissant" ? "en hausse" : stormTrend.label === "decroissant" ? "en baisse" : "stable";
  const stormTrendDetail = stormTrendUsesDisplayedLevel
    ? "Risque orageux " + stormTrendWording
      + " · indicateur " + previousStormPassageLevel + " sur 5 → " + stormPassageLevel + " sur 5"
      + (stormForecastSourceCount > previousStormPassageLevel && stormPassageLevel <= 2 ? " · nouveau signal orageux entré dans les 3 prochaines heures" : "")
    : "Probabilité de passage " + stormTrendWording
      + (Number.isFinite(stormTrendChange) && stormTrendChange !== 0 ? " de " + Math.abs(Math.round(stormTrendChange)) + " point" + (Math.abs(Math.round(stormTrendChange)) > 1 ? "s" : "") : "")
      + " · maximum global " + previousMaximumPassageRisk + " % → " + maximumPassageRisk + " %"
      + (relevantStormCell ? " · cellule actuellement retenue " + relevantStormCell.id : "");
  const radarOverPoint = threeHours.some(item => item.radarCellOverPoint);
  const rainDetail = "Pluie · cumul PIAF prévu sur 3 h amendé par le radar : " + rainAmount.toFixed(1) + " mm"
    + (radarOverPoint ? " · cellule au-dessus des Tatins : priorité au radar à courte échéance" : "")
    + " · " + rainTrend.detail;
  const windTrendLabel = windTrend.label === "croissant" ? "en hausse" : windTrend.label === "decroissant" ? "en baisse" : "stable";
  const gustDetail = "Rafales · maximum AROME sur 3 h : " + maximumGust + " km/h · tendance " + windTrendLabel;
  const generalExpertise = '<section class="storm-summary storm-general"><div class="three-hour-actions">'
    + summaryAction('rain', rainAmount.toFixed(1) + ' mm', rainAmount <= 0 ? 0 : rainAmount <= 1 ? 1 : rainAmount < 10 ? 2 : rainAmount < 25 ? 3 : rainAmount < 50 ? 4 : 5, rainDetail, rainTrend, 'rain')
    + summaryAction('storm', '', stormLevel, stormDetail, stormTrend, 'nowcast', stormPassageLevel, { passage: stormPassageDetail, intensity: stormIntensityDetail, trend: stormTrendDetail, showIntensity: Boolean(relevantStormCell) })
    + summaryAction('gust', 'max ' + maximumGust + ' km/h', maximumGust <= 0 ? 0 : maximumGust < 20 ? 1 : maximumGust < 35 ? 2 : maximumGust < 50 ? 3 : maximumGust < 70 ? 4 : 5, gustDetail, windTrend)
    + '</div></section>';
  if (summaryElement) {
    summaryElement.innerHTML = generalExpertise;
    summaryElement.querySelectorAll('[data-summary-target]').forEach(button => {
      const details = $(button.dataset.summaryTarget + "-details");
      button.setAttribute("aria-controls", details?.id || "");
      button.setAttribute("aria-expanded", String(details ? !details.hidden : false));
      button.addEventListener('click', () => {
        if (!details) return;
        details.hidden = !details.hidden;
        button.setAttribute("aria-expanded", String(!details.hidden));
        if (button.dataset.summaryTarget === "nowcast") {
          $("header-nowcast-link")?.setAttribute("aria-expanded", String(!details.hidden));
          $("nowcast-title-toggle")?.setAttribute("aria-expanded", String(!details.hidden));
        }
      });
    });
  }
  const mapControlsMarkup = '<div class="forecast-source-selector storm-map-controls" aria-label="Portée de la carte"><button class="forecast-source-button' + (activeNowcastMapRadius === 20 ? ' active' : '') + '" type="button" data-nowcast-radius="20" aria-pressed="' + (activeNowcastMapRadius === 20) + '">20 km</button><button class="forecast-source-button' + (activeNowcastMapRadius === 60 ? ' active' : '') + '" type="button" data-nowcast-radius="60" aria-pressed="' + (activeNowcastMapRadius === 60) + '">60 km</button></div>';
  element.innerHTML = '<div class="nowcast-workspace"><div class="nowcast-map-column">' + mapControlsMarkup + renderThreatMap(radar, lightning, activeNowcastMapRadius) + '</div>' + cellsPanel + '</div>';
  initializeNowcastMapBackground(activeNowcastMapRadius);
  element.querySelectorAll("[data-nowcast-radius]").forEach(button => button.addEventListener("click", event => {
    nowcastMapRadiusManuallySelected = true;
    activeNowcastMapRadius = Number(event.currentTarget.dataset.nowcastRadius) === 20 ? 20 : 60;
    renderRadarNowcast(radar, piaf, arome, lightning, vigilance);
  }));
  const showCellDetails = button => {
    const card = button.closest(".nowcast-cell-card");
    const grid = card?.parentElement;
    const details = document.getElementById(button.getAttribute("aria-controls"));
    if (!card || !grid || !details) return;
    const cellId = button.getAttribute("data-nowcast-cell");
    element.querySelectorAll(".radar-cell-marker.panel-selected").forEach(marker => {
      marker.classList.remove("panel-selected");
      marker.querySelector(".radar-cell")?.removeAttribute("aria-current");
    });
    const mappedMarker = [...element.querySelectorAll(".radar-cell-marker[data-nowcast-cell]")].find(marker => marker.getAttribute("data-nowcast-cell") === cellId);
    mappedMarker?.classList.add("panel-selected");
    mappedMarker?.querySelector(".radar-cell")?.setAttribute("aria-current", "true");
    grid.querySelectorAll(".nowcast-cell-card").forEach(candidate => {
      candidate.classList.remove("row-expanded", "detail-expanded");
      const candidateButton = candidate.querySelector(".nowcast-cell-card-button");
      const candidateDetails = document.getElementById(candidateButton?.getAttribute("aria-controls"));
      if (candidateButton) candidateButton.setAttribute("aria-expanded", "false");
      if (candidateDetails) candidateDetails.hidden = true;
    });
    card.classList.add("row-expanded");
    card.classList.add("detail-expanded");
    button.setAttribute("aria-expanded", "true");
    details.hidden = false;
  };
  const hideCellDetails = button => {
    const card = button.closest(".nowcast-cell-card");
    const details = document.getElementById(button.getAttribute("aria-controls"));
    const cellId = button.getAttribute("data-nowcast-cell");
    card?.classList.remove("row-expanded", "detail-expanded");
    button.setAttribute("aria-expanded", "false");
    if (details) details.hidden = true;
    const mappedMarker = [...element.querySelectorAll(".radar-cell-marker[data-nowcast-cell]")].find(marker => marker.getAttribute("data-nowcast-cell") === cellId);
    mappedMarker?.classList.remove("panel-selected");
    mappedMarker?.querySelector(".radar-cell")?.removeAttribute("aria-current");
  };
  element.querySelectorAll(".nowcast-cell-card-button[data-nowcast-cell]").forEach(button => {
    const card = button.closest(".nowcast-cell-card");
    card?.addEventListener("pointerenter", () => showCellDetails(button));
    card?.addEventListener("pointerleave", () => hideCellDetails(button));
    button.addEventListener("focus", () => showCellDetails(button));
    button.addEventListener("blur", () => hideCellDetails(button));
  });
  const showMappedCell = marker => {
    const cellId = marker.getAttribute("data-nowcast-cell");
    const button = [...element.querySelectorAll(".nowcast-cell-card-button[data-nowcast-cell]")].find(candidate => candidate.getAttribute("data-nowcast-cell") === cellId);
    if (!button) return;
    element.querySelectorAll(".nowcast-cell-card.map-selected").forEach(card => card.classList.remove("map-selected"));
    element.querySelectorAll('.nowcast-cell-card-button[aria-current="true"]').forEach(candidate => candidate.removeAttribute("aria-current"));
    button.closest(".nowcast-cell-card")?.classList.add("map-selected");
    button.setAttribute("aria-current", "true");
    showCellDetails(button);
  };
  const hideMappedCell = marker => {
    const cellId = marker.getAttribute("data-nowcast-cell");
    const button = [...element.querySelectorAll(".nowcast-cell-card-button[data-nowcast-cell]")].find(candidate => candidate.getAttribute("data-nowcast-cell") === cellId);
    const card = button?.closest(".nowcast-cell-card");
    const details = document.getElementById(button?.getAttribute("aria-controls"));
    card?.classList.remove("map-selected");
    button?.removeAttribute("aria-current");
    if (button) hideCellDetails(button);
    marker.classList.remove("panel-selected");
    marker.querySelector(".radar-cell")?.removeAttribute("aria-current");
  };
  element.querySelectorAll(".radar-cell-marker[data-nowcast-cell]").forEach(marker => {
    marker.addEventListener("pointerenter", () => showMappedCell(marker));
    marker.addEventListener("pointerleave", () => hideMappedCell(marker));
    marker.addEventListener("focusin", () => showMappedCell(marker));
    marker.addEventListener("focusout", () => hideMappedCell(marker));
  });
  if (threat) bindChartTooltips();
}

function renderPiaf(piaf, radar = null) {
  if (!piaf?.values?.length) return;
  const isOpenMeteo = piaf.source === "openmeteo";
  const isTimedForecast = isOpenMeteo || piaf.source === "arome";
  const runTime = piafRunTime(piaf);
  const piafBaseTime = new Date(Number.isFinite(runTime) ? runTime : piaf.fetchedAt || Date.now());
  piafBaseTime.setMilliseconds(0);
  // PIAF arrive toutes les 5 minutes. La frise publique regroupe trois pas
  // afin de présenter des cumuls exacts de 15 minutes issus du même run.
  const values = isTimedForecast ? piaf.values : piafQuarterHourRain(piaf);
  const slotTimes = values.map(item => item.slotTime || (isTimedForecast ? new Date(item.time) : new Date(piafBaseTime.getTime() + item.seconds * 1000)));
  const precipitationFor = item => Number(item.nowcastPrecipitation ?? item.precipitation) || 0;
  // Echelle absolue : 4 mm en 15 minutes remplit le graphique. Une faible
  // valeur reste donc visuellement faible, même si c'est le maximum de la série.
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
    const precipitation = precipitationFor(item);
    const wet = precipitation > 0;
    // PIAF est déterministe : aucun pourcentage artificiel n'est affiché.
    // Open-Meteo fournit en revanche une probabilité horaire distincte.
    const probability = isOpenMeteo && Number.isFinite(item.probability) ? Number(item.probability) : null;
    const risk = !wet && probability > 0;
    const trace = wet && precipitation < .1;
    // Le graphique représente une quantité de pluie, pas sa part relative au
    // maximum courant. Les traces conservent seulement un filet visible.
    const height = trace ? 2 : wet ? Math.min(100, Math.max(2, precipitation / fullScaleRain * 100)) : 0;
    // Si une quantité est dessinée, afficher cette quantité plutôt qu'un 0 %
    // provenant d'une source probabiliste distincte.
    const label = trace ? "gouttes" : wet ? precipitation.toFixed(2) + " mm" : probability == null ? "" : probability + "%";
    const slotTime = hourFormat.format(slotTimes[index]);
    const fusionDetail = Number.isFinite(item.radarPrecipitation) ? " · PIAF " + item.precipitation.toFixed(2) + " mm · radar extrapolé " + item.radarPrecipitation.toFixed(2) + " mm" : "";
    const coveredMinutes = Number.isFinite(item.intervalStart) && Number.isFinite(item.intervalEnd) ? Math.round((item.intervalEnd - item.intervalStart) / 60000) : 15;
    const periodDetail = piaf.source === "arome" ? " (cumul sur 1 h)" : item.complete === false ? " (cumul partiel sur " + coveredMinutes + " min)" : " (cumul sur 15 min)";
    const detail = isOpenMeteo && risk ? slotTime + " · averse ? · probabilité " + probability + "%" : slotTime + " · pluie " + precipitation.toFixed(2) + " mm" + fusionDetail + (isTimedForecast ? periodDetail : "");
    const visibleLabel = label;
    return '<div class="now-slice chart-point' + (risk ? " averse-risk" : "") + (trace ? " trace" : "") + (Number.isFinite(item.radarPrecipitation) ? " radar-adjusted" : "") + '" style="grid-column:' + (index + 1) + ';grid-row:1" tabindex="0" data-tooltip="' + escapeText(detail) + '"><span class="now-value"' + (trace ? ' data-mobile-label="≈"' : '') + '>' + visibleLabel + '</span><div class="now-bar' + (wet ? " active" : "") + '" style="height:' + height + '%"></div></div>';
  }).join("");
  const aversePeriods = values.map((item, index) => isOpenMeteo && precipitationFor(item) <= 0 && Number(item.probability) > 0
    ? '<span class="now-averse-period" data-mobile-label="Averse" style="grid-column:' + (index + 1) + ';grid-row:1">Averse possible</span>'
    : '').join('');
  const noRainPeriod = !isOpenMeteo && values.every(item => precipitationFor(item) <= 0)
    ? '<span class="now-no-rain-period">Pas de pluie</span>'
    : '';
  $("rain-bars").innerHTML = slices + aversePeriods + noRainPeriod;
  bindChartTooltips();
}

function applyDashboardPayload(payload) {
    const receivedData = payload.data;
    // PIAF is intentionally absent from the public payload while its
    // four-minute cache is being refreshed. Keep the previous complete run
    // during that short gap so both rain views switch atomically to the next
    // run instead of briefly falling back to AROME.
    const data = receivedData && !receivedData.piaf && latestForecastData?.piaf
      ? { ...receivedData, piaf: latestForecastData.piaf }
      : receivedData;
    dashboardSync = { status: payload.status, error: payload.error || null };
    latestForecastData = data;
    if (!latestWeekForecast?.days?.length && data?.openMeteo?.days?.length) {
      latestWeekForecast = {
        fetchedAt: data.openMeteo.fetchedAt || Date.now(),
        model: "Open-Meteo via serveur",
        days: data.openMeteo.days.map(dashboardOpenMeteoWeekDay)
      };
      renderWeekForecast();
    }
    refreshSourceIndicators();
    const vigilanceStamp = data?.vigilance?.fetchedAt || 0;
    if (vigilanceStamp !== lastVigilanceStamp) {
      lastVigilanceStamp = vigilanceStamp;
      renderVigilance(data?.vigilance);
    }
    // Désactivé temporairement : ne plus afficher systématiquement sous la
    // vigilance le bandeau « Perturbation en approche ». La fonction est
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
    }
    if (data && (data.piaf || data.openMeteo)) {
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

function bindHeaderNowcastLink() {
  const link = $("header-nowcast-link");
  const details = $("nowcast-details");
  const titleToggle = $("nowcast-title-toggle");
  if (!link || !details || !titleToggle) return;
  const setOpen = (open, scroll = false) => {
    details.hidden = !open;
    link.setAttribute("aria-expanded", String(open));
    titleToggle.setAttribute("aria-expanded", String(open));
    document.querySelector('[data-summary-target="nowcast"]')?.setAttribute("aria-expanded", String(open));
    if (open && scroll) details.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  link.addEventListener("click", event => {
    event.preventDefault();
    setOpen(details.hidden, details.hidden);
  });
  titleToggle.addEventListener("click", () => setOpen(details.hidden));
}

bindForecastLayout();
bindHeaderNowcastLink();
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
if (window.METEO_REPLAY?.start) window.METEO_REPLAY.start({ applyDashboardPayload });
else refresh();
