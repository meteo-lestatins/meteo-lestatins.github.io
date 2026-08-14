const tatins = { latitude: 44.6538, longitude: 5.5995 };
const sources = [
  {
    id: "radar", label: "Radar v1", detail: "Suit les cellules pluvio‑orageuses", sizeLabel: "0,5 × 0,5 km", color: "#5d3fd3",
    widthKm: 0.5, heightKm: 0.5,
    corners: [[44.6499891678, 5.5963095545], [44.6495512545, 5.6025667284], [44.6540179283, 5.6031805931], [44.6544559033, 5.5969227424]]
  },
  { id: "piaf", label: "PIAF", detail: "Prévoit la pluie sur 3 h", sizeLabel: "0,8 × 1,1 km", color: "#087cac", originLongitude: -6, originLatitude: 51.5, longitudeStep: 0.01, latitudeStep: 0.01 },
  { id: "arome", label: "AROME", detail: "Prévoit les prochaines 48 h", sizeLabel: "0,8 × 1,1 km", color: "#008b74", originLongitude: -12, originLatitude: 55.4, longitudeStep: 0.01, latitudeStep: 0.01 },
  { id: "pearome", label: "PE‑AROME", detail: "Calcule les probabilités à 48 h", sizeLabel: "2,0 × 2,8 km", color: "#d18b00", originLongitude: -12, originLatitude: 55.4, longitudeStep: 0.025, latitudeStep: 0.025 },
  { id: "arpege", label: "ARPEGE", detail: "Prolonge la prévision à 4 jours", sizeLabel: "4,0 × 5,6 km", color: "#d45555", originLongitude: -100, originLatitude: 80, longitudeStep: 0.05, latitudeStep: 0.05 },
  { id: "pearpege", label: "PE‑ARPEGE", detail: "Mesure l’incertitude à 4 jours", sizeLabel: "7,9 × 11,1 km", color: "#8b4ca3", originLongitude: -32, originLatitude: 72, longitudeStep: 0.1, latitudeStep: 0.1 }
];

const map = L.map("scale-map", {
  preferCanvas: true,
  zoomControl: true,
  dragging: false,
  keyboard: false,
  boxZoom: false,
  scrollWheelZoom: "center",
  doubleClickZoom: "center",
  touchZoom: "center"
}).setView([tatins.latitude, tatins.longitude], 11);
L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
}).addTo(map);

const layers = new Map();

function radarPolygon(source, eastIndex, northIndex) {
  const [southWest, southEast, northEast, northWest] = source.corners;
  const eastVector = [
    ((southEast[0] - southWest[0]) + (northEast[0] - northWest[0])) / 2,
    ((southEast[1] - southWest[1]) + (northEast[1] - northWest[1])) / 2
  ];
  const northVector = [
    ((northWest[0] - southWest[0]) + (northEast[0] - southEast[0])) / 2,
    ((northWest[1] - southWest[1]) + (northEast[1] - southEast[1])) / 2
  ];
  return source.corners.map(([latitude, longitude]) => [
    latitude + eastIndex * eastVector[0] + northIndex * northVector[0],
    longitude + eastIndex * eastVector[1] + northIndex * northVector[1]
  ]);
}

function wcsPolygon(source, eastIndex, northIndex) {
  const nativeColumn = Math.round((tatins.longitude - source.originLongitude) / source.longitudeStep);
  const nativeRow = Math.round((source.originLatitude - tatins.latitude) / source.latitudeStep);
  const centerLongitude = source.originLongitude + (nativeColumn + eastIndex) * source.longitudeStep;
  const centerLatitude = source.originLatitude - (nativeRow - northIndex) * source.latitudeStep;
  const halfLongitude = source.longitudeStep / 2;
  const halfLatitude = source.latitudeStep / 2;
  return [
    [centerLatitude - halfLatitude, centerLongitude - halfLongitude],
    [centerLatitude - halfLatitude, centerLongitude + halfLongitude],
    [centerLatitude + halfLatitude, centerLongitude + halfLongitude],
    [centerLatitude + halfLatitude, centerLongitude - halfLongitude]
  ];
}

function cellPolygon(source, eastIndex, northIndex) {
  return source.corners ? radarPolygon(source, eastIndex, northIndex) : wcsPolygon(source, eastIndex, northIndex);
}

function sourceLayer(source) {
  const group = L.layerGroup();
  const gridRadius = 5;
  for (let north = -gridRadius; north <= gridRadius; north++) {
    for (let east = -gridRadius; east <= gridRadius; east++) {
      const central = north === 0 && east === 0;
      const distance = Math.hypot(east, north);
      const fade = Math.max(0, 1 - distance / (gridRadius + 0.35));
      if (!central && fade <= 0) continue;
      L.polygon(cellPolygon(source, east, north), {
        color: source.color,
        weight: central ? 3 : 1,
        opacity: central ? 1 : 0.58 * fade * fade,
        fill: central,
        fillColor: source.color,
        fillOpacity: central ? 0.09 : 0,
        interactive: central
      }).bindTooltip(central ? `${source.label} · ${source.sizeLabel}` : "", {
        permanent: false,
        direction: "center",
        className: "grid-label"
      }).addTo(group);
    }
  }
  return group;
}

[...sources].reverse().forEach(source => {
  const layer = sourceLayer(source).addTo(map);
  layers.set(source.id, layer);
});

L.circleMarker([tatins.latitude, tatins.longitude], {
  radius: 6,
  color: "#fff",
  weight: 3,
  fillColor: "#113f58",
  fillOpacity: 1
}).addTo(map).bindTooltip("Les Tatins", {
  permanent: true,
  direction: "top",
  offset: [0, -8],
  className: "tatins-label"
});

const controls = document.querySelector("#layer-controls");
sources.forEach(source => {
  const label = document.createElement("label");
  label.className = "layer-toggle";
  label.style.setProperty("--layer-color", source.color);
  label.innerHTML = `<input type="checkbox" checked data-layer="${source.id}"><span class="layer-copy"><strong>${source.label}</strong><small>${source.detail}</small></span><span class="layer-size">${source.sizeLabel}</span>`;
  controls.append(label);
});

controls.addEventListener("change", event => {
  const input = event.target.closest("input[data-layer]");
  if (!input) return;
  const layer = layers.get(input.dataset.layer);
  if (input.checked) layer.addTo(map);
  else layer.removeFrom(map);
});

function fitAll() {
  map.setView([tatins.latitude, tatins.longitude], 13, { animate: false });
}

fitAll();
