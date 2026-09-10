// Shared geographic probability raster, calculated once per radar revision.
const nowcastPassageGridCache = new Map();
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

function nowcastSweptShapePolygons(cell, track, uncertainty = false, bounds = null) {
  const runs = radarCellShapeRuns(cell);
  if (!runs.length || !Array.isArray(track) || track.length < 2) return [];
  const origin = track[0];
  const hull = points => {
    points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const half = values => {
      const result = [];
      for (const point of values) {
        while (result.length > 1 && cross(result.at(-2), result.at(-1), point) <= 0) result.pop();
        result.push(point);
      }
      return result.slice(0, -1);
    };
    return half(points).concat(half([...points].reverse()));
  };
  const polygons = [];
  for (let index = 1; index < track.length; index++) {
    const endpoints = [track[index - 1], track[index]];
    for (const run of runs) {
      const corners = endpoints.flatMap(point => {
        const dx = Number(point.eastKm) - Number(origin.eastKm);
        const dy = Number(point.northKm) - Number(origin.northKm);
        const radius = uncertainty ? Math.max(0, Number(point.uncertaintyGrowthKm) || 0) : 0;
        // Octogone circonscrit : conserver toute l'enveloppe d'incertitude.
        const offsets = radius > 0 ? Array.from({ length: 8 }, (_, i) => [
          Math.cos((i + .5) * Math.PI / 4) * radius / Math.cos(Math.PI / 8),
          Math.sin((i + .5) * Math.PI / 4) * radius / Math.cos(Math.PI / 8)
        ]) : [[0, 0]];
        return [[run.westKm, run.southKm], [run.eastKm, run.southKm],
          [run.eastKm, run.northKm], [run.westKm, run.northKm]]
          .flatMap(([east, north]) => offsets.map(([ox, oy]) => [Number(east) + dx + ox, Number(north) + dy + oy]));
      });
      if (bounds && (corners.every(p => p[0] < bounds.westKm) || corners.every(p => p[0] > bounds.eastKm)
        || corners.every(p => p[1] < bounds.southKm) || corners.every(p => p[1] > bounds.northKm))) continue;
      polygons.push(hull(corners));
    }
  }
  return polygons;
}

function nowcastPassageFrequencyGrid(cell, bounds, stepKm = .5) {
  const cacheKey = JSON.stringify([cell.eastKm, cell.northKm, cell.shapeRuns, cell.passageEnsemble, bounds, stepKm]);
  if (nowcastPassageGridCache.has(cacheKey)) return nowcastPassageGridCache.get(cacheKey);
  const ensemble = cell?.passageEnsemble;
  const scenarios = ensemble?.status === 'ready' ? ensemble.scenarios || [] : [];
  const columns = Math.ceil((bounds.eastKm - bounds.westKm) / stepKm);
  const rows = Math.ceil((bounds.northKm - bounds.southKm) / stepKm);
  const counts = new Float64Array(columns * rows);
  const samples = scenarios.length;
  const origin = { eastKm: Number(cell.eastKm) || 0, northKm: Number(cell.northKm) || 0, minutes: 0 };
  for (const scenario of scenarios) {
    const perturbed = [origin, { minutes: ensemble.horizonMinutes,
      eastKm: origin.eastKm + scenario.velocityEast * ensemble.horizonMinutes,
      northKm: origin.northKm + scenario.velocityNorth * ensemble.horizonMinutes }];
    const covered = new Uint8Array(counts.length);
    for (const polygon of nowcastSweptShapePolygons(cell, perturbed, false, bounds)) {
      const firstRow = Math.max(0, Math.ceil((Math.min(...polygon.map(p => p[1])) - bounds.southKm) / stepKm - .5));
      const lastRow = Math.min(rows - 1, Math.floor((Math.max(...polygon.map(p => p[1])) - bounds.southKm) / stepKm - .5));
      for (let row = firstRow; row <= lastRow; row++) {
        const north = bounds.southKm + (row + .5) * stepKm;
        const crossings = [];
        for (let i = 0; i < polygon.length; i++) {
          const a = polygon[i], b = polygon[(i + 1) % polygon.length];
          if ((a[1] <= north && b[1] > north) || (b[1] <= north && a[1] > north)) {
            crossings.push(a[0] + (north - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
          }
        }
        if (crossings.length < 2) continue;
        const first = Math.max(0, Math.ceil((Math.min(...crossings) - bounds.westKm) / stepKm - .5));
        const last = Math.min(columns - 1, Math.floor((Math.max(...crossings) - bounds.westKm) / stepKm - .5));
        for (let column = first; column <= last; column++) covered[row * columns + column] = 1;
      }
    }
    for (let index = 0; index < counts.length; index++) counts[index] += covered[index] * scenario.weight;
  }
  const grid = { counts, columns, rows, stepKm, samples, bounds };
  if (nowcastPassageGridCache.size >= 8) nowcastPassageGridCache.delete(nowcastPassageGridCache.keys().next().value);
  nowcastPassageGridCache.set(cacheKey, grid);
  return grid;
}

const preparedMaps = new Map();
export function preparePassageMap(cell) {
  if (cell?.passageEnsemble?.status !== 'ready') return [];
  const key = JSON.stringify([cell.shapeRuns, cell.eastKm, cell.northKm, cell.passageEnsemble]);
  if (preparedMaps.has(key)) return preparedMaps.get(key);
  // Covers the desktop 60 km view and both mobile views on the same 250 m lattice.
  const bounds = { westKm: -120, eastKm: 120, southKm: -67.5, northKm: 67.5 };
  const grid = nowcastPassageFrequencyGrid(cell, bounds, .25);
  const groups = new Map();
  for (let row = 0; row < grid.rows; row++) {
    for (let column = 0; column < grid.columns;) {
      const count = Math.round(grid.counts[row * grid.columns + column] * 1e6) / 1e6;
      let end = column + 1;
      while (end < grid.columns && Math.round(grid.counts[row * grid.columns + end] * 1e6) / 1e6 === count) end++;
      if (count > 0) {
        if (!groups.has(count)) groups.set(count, []);
        groups.get(count).push([bounds.westKm + column * .25, bounds.southKm + row * .25, (end - column) * .25]);
      }
      column = end;
    }
  }
  const result = [...groups].map(([probability, runs]) => ({ probability, runs }));
  if (preparedMaps.size >= 8) preparedMaps.delete(preparedMaps.keys().next().value);
  preparedMaps.set(key, result);
  return result;
}
export { nowcastPassageFrequencyGrid, nowcastSweptShapePolygons };
