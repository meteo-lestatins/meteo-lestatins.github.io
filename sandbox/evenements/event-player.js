const slider = document.querySelector("#day-position");
const timeOutput = document.querySelector("#selected-time");
const player = document.querySelector(".event-player");
const eventState = document.querySelector("#event-state");
const summary = document.querySelector("#event-summary");
const lightningDetail = document.querySelector("#lightning-detail");
const lightningMap = document.querySelector("#lightning-map");
const hourlyStrip = document.querySelector("#hourly-strip");

const dayStart = Date.parse("2026-08-04T00:00:00+02:00");
const hailStart = Date.parse("2026-08-04T16:40:00+02:00");
const hailEnd = Date.parse("2026-08-04T17:10:00+02:00");
const minute = 60_000;
let data;

const formatTime = timestamp => new Intl.DateTimeFormat("fr-FR", {
  timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit"
}).format(new Date(timestamp)).replace(":", " h ");
const formatNumber = (value, digits = 1) => Number(value).toLocaleString("fr-FR", { maximumFractionDigits: digits });
const currentTimestamp = () => dayStart + Number(slider.value) * minute;
const sourceWindow = timestamp => timestamp >= Date.parse("2026-08-04T14:00:00+02:00") && timestamp < Date.parse("2026-08-05T00:00:00+02:00");

const weatherSymbol = code => code === 95 ? "ϟ" : code >= 80 ? "☂" : code >= 3 ? "☁" : code >= 1 ? "⛅" : "○";
const weatherLabel = code => code === 95 ? "orage" : code >= 80 ? "averses" : code >= 3 ? "couvert" : code >= 1 ? "peu nuageux" : "dégagé";

function renderSummary(timestamp) {
  const hailActive = timestamp >= hailStart && timestamp <= hailEnd;
  const beforeHail = timestamp < hailStart;
  const flashes10 = data.lightning.flashes.filter(flash => {
    const time = Date.parse(flash.t);
    return flash.d <= 20 && time <= timestamp && time > timestamp - 10 * minute;
  });
  const hour = data.hourly.samples[Math.min(23, Math.max(0, new Date(timestamp + 2 * 60 * minute).getUTCHours()))];
  const hailValue = hailActive ? "3–4 cm" : beforeHail ? "pas encore" : "épisode terminé";
  const hailContext = hailActive ? "observation aux Tatins" : beforeHail ? "début observé vers 16 h 40" : "fin observée vers 17 h 10";
  const lightningValue = sourceWindow(timestamp) ? String(flashes10.length) : "hors archive";
  const lightningContext = sourceWindow(timestamp) ? "éclairs à moins de 20 km · 10 min" : "archive disponible de 14 h à 24 h";
  summary.innerHTML = `
    <article class="${hailActive ? "hail-active" : ""}"><small>Grêle aux Tatins</small><strong>${hailValue}</strong><span>${hailContext}</span></article>
    <article><small>Pluie aux Tatins</small><strong>non mesurée</strong><span>aucun pluviomètre local archivé</span></article>
    <article><small>Foudre proche</small><strong>${lightningValue}</strong><span>${lightningContext}</span></article>
    <article><small>Archive horaire</small><strong>${formatNumber(hour.temperatureC)} °C</strong><span>${weatherLabel(hour.weatherCode)} · CAPE ${formatNumber(hour.capeJkg, 0)} J/kg</span></article>`;
}

function canvasColors() {
  return { background: "#eef4f6", grid: "#b8ccd5", text: "#173f57", flash: "#d78b16", target: "#1688bf", quiet: "#60757f" };
}

function renderLightning(timestamp) {
  const recent = data.lightning.flashes.filter(flash => {
    const time = Date.parse(flash.t);
    return time <= timestamp && time > timestamp - 30 * minute;
  });
  const counts = [20, 40, 80, 120].map(radius => [radius, recent.filter(flash => flash.d <= radius).length]);
  const near = recent.filter(flash => flash.d <= 60);
  const nearest = recent.length ? Math.min(...recent.map(flash => flash.d)) : null;
  lightningDetail.innerHTML = `<span class="period">30 minutes précédentes</span><strong>${recent.length}</strong><span>éclairs détectés à moins de 120 km${nearest == null ? "" : ` · plus proche à ${formatNumber(nearest)} km`}</span><div class="radius-counts">${counts.map(([radius, count]) => `<span><b>${count}</b>à moins de ${radius} km</span>`).join("")}</div>`;

  const rect = lightningMap.getBoundingClientRect();
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(320, Math.round(rect.width || 720));
  const height = Math.max(300, Math.round(rect.height || 520));
  lightningMap.width = width * ratio;
  lightningMap.height = height * ratio;
  const ctx = lightningMap.getContext("2d");
  ctx.scale(ratio, ratio);
  const colors = canvasColors();
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, width, height);
  const cx = width / 2;
  const cy = height / 2;
  const scale = Math.min(width, height) * .43 / 60;
  ctx.strokeStyle = colors.grid;
  ctx.fillStyle = colors.quiet;
  ctx.lineWidth = 1;
  ctx.font = "11px system-ui";
  [20, 40, 60].forEach(radius => {
    ctx.beginPath();
    ctx.arc(cx, cy, radius * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText(`${radius} km`, cx + 5, cy - radius * scale + 13);
  });
  ctx.beginPath();
  ctx.moveTo(cx, cy - 60 * scale); ctx.lineTo(cx, cy + 60 * scale);
  ctx.moveTo(cx - 60 * scale, cy); ctx.lineTo(cx + 60 * scale, cy);
  ctx.stroke();
  ctx.fillStyle = colors.flash;
  near.forEach(flash => {
    const x = cx + flash.x * scale;
    const y = cy - flash.y * scale;
    ctx.beginPath();
    ctx.arc(x, y, 2.4, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = colors.target;
  ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = colors.text;
  ctx.font = "800 12px system-ui";
  ctx.fillText("Les Tatins", cx + 10, cy - 10);
  if (!near.length) {
    ctx.fillStyle = colors.quiet;
    ctx.font = "12px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(sourceWindow(timestamp) ? "Aucun éclair détecté à moins de 60 km durant les 30 minutes précédentes" : "Pas de données LI dans cette partie de la journée", cx, height - 24);
    ctx.textAlign = "start";
  }
  lightningMap.setAttribute("aria-label", `${near.length} éclairs détectés à moins de 60 kilomètres durant les trente minutes précédant ${formatTime(timestamp)}.`);
}

function renderHourly(timestamp) {
  const selectedHour = Math.min(23, Math.max(0, new Date(timestamp + 2 * 60 * minute).getUTCHours()));
  const first = Math.min(16, Math.max(0, selectedHour - 3));
  hourlyStrip.innerHTML = data.hourly.samples.slice(first, first + 8).map((hour, offset) => {
    const index = first + offset;
    return `<article class="history-hour ${index === selectedHour ? "selected" : ""} ${index === 16 || index === 17 ? "hail-hour" : ""}"><time>${String(index).padStart(2, "0")} h</time><span class="weather-symbol" aria-hidden="true">${weatherSymbol(hour.weatherCode)}</span><strong>${formatNumber(hour.temperatureC)} °C</strong><span>${weatherLabel(hour.weatherCode)} · ${hour.cloudCoverPct} % nuages</span><span class="gust">rafales ${formatNumber(hour.gustKmh, 0)} km/h</span></article>`;
  }).join("");
}

function render() {
  if (!data) return;
  const timestamp = currentTimestamp();
  const progress = Number(slider.value) / Number(slider.max) * 100;
  player.style.setProperty("--progress", `${progress}%`);
  player.style.setProperty("--cursor", `${progress}%`);
  timeOutput.value = formatTime(timestamp);
  timeOutput.textContent = formatTime(timestamp);
  if (timestamp < hailStart) eventState.textContent = `Avant la grêle · ${Math.ceil((hailStart - timestamp) / minute)} min avant 16 h 40`;
  else if (timestamp <= hailEnd) eventState.textContent = "Pendant l’épisode de grêle observé";
  else eventState.textContent = `Après la grêle · fin observée vers 17 h 10`;
  renderSummary(timestamp);
  renderLightning(timestamp);
  renderHourly(timestamp);
}

fetch("data/2026-08-04-grele-les-tatins.json")
  .then(response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  })
  .then(value => { data = value; render(); })
  .catch(() => {
    summary.innerHTML = '<p class="measurement-note">Les données historiques ne peuvent pas être chargées.</p>';
  });

slider.addEventListener("input", render);
new ResizeObserver(() => data && renderLightning(currentTimestamp())).observe(lightningMap.parentElement);
