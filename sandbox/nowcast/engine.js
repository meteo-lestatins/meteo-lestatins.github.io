import { preparePassageMap } from './map.js';
// Moteur 0–180 min : mêmes méthodes que l'ancien client, horloge et historique explicites.
// Exécuté par le serveur. L'import navigateur est réservé aux replays historiques.
export const NOWCAST_ENGINE_VERSION = 1;

export function createNowcastEngine({ now = Date.now(), snapshot = null, replay = false } = {}) {
const appNow = () => now;
const window = { METEO_REPLAY: replay };
let latestForecastData = null;
let cellPassageSnapshot = snapshot;


const hourFormat = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });

let nowcastMapAutoExpanded = snapshot?.mapAutoExpanded === true;

const possibleDrizzleThreshold = .01;

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

const sourceFreshness = { arome: 3 * 3600000, pearome: 3 * 3600000, ensemble: 3 * 3600000, piaf: 20 * 60000, radar: 15 * 60000, lightning: 20 * 60000, vigilance: 30 * 60000, openMeteo: 60 * 60000 };

function compactMinutesLabel(minutes) {
  const rounded = Math.max(0, Math.round(Number(minutes) || 0));
  if (rounded < 60) return rounded + "min";
  const hours = Math.floor(rounded / 60);
  const remaining = rounded % 60;
  return hours + "h" + (remaining ? String(remaining).padStart(2, "0") : "");
}

function nowcastCellContainsPoint(cell, eastKm, northKm) {
  const shapeRuns = Array.isArray(cell?.shapeRuns) ? cell.shapeRuns : [];
  if (shapeRuns.length) {
    return shapeRuns.some(run => eastKm >= Number(run.westKm)
      && eastKm <= Number(run.eastKm)
      && northKm >= Number(run.southKm)
      && northKm <= Number(run.northKm));
  }
  const footprint = Array.isArray(cell?.footprint) ? cell.footprint : [];
  if (footprint.length >= 3) {
    let inside = false;
    for (let index = 0, previous = footprint.length - 1; index < footprint.length; previous = index++) {
      const currentEast = Number(footprint[index].eastKm);
      const currentNorth = Number(footprint[index].northKm);
      const previousEast = Number(footprint[previous].eastKm);
      const previousNorth = Number(footprint[previous].northKm);
      if ((currentNorth > northKm) !== (previousNorth > northKm)
        && eastKm < (previousEast - currentEast) * (northKm - currentNorth) / (previousNorth - currentNorth) + currentEast) inside = !inside;
    }
    return inside;
  }
  return Math.hypot(eastKm - Number(cell?.eastKm || 0), northKm - Number(cell?.northKm || 0)) <= Math.max(0, Number(cell?.radiusKm || 0));
}

function nowcastCellTraversal(cell) {
  if (!nowcastCellContainsPoint(cell, 0, 0)) return null;
  const points = (cell?.track?.points || []).filter(point => Number.isFinite(Number(point?.eastKm)) && Number.isFinite(Number(point?.northKm)));
  const start = points[0];
  const next = points.find(point => point !== start && Math.hypot(Number(point.eastKm) - Number(start?.eastKm), Number(point.northKm) - Number(start?.northKm)) >= .1);
  if (!start || !next) return null;
  const movementEast = Number(next.eastKm) - Number(start.eastKm);
  const movementNorth = Number(next.northKm) - Number(start.northKm);
  const movementDistance = Math.hypot(movementEast, movementNorth);
  if (movementDistance < .1) return null;
  const unitEast = movementEast / movementDistance;
  const unitNorth = movementNorth / movementDistance;
  const shapeCoordinates = (cell.shapeRuns || []).flatMap(run => [Number(run.westKm), Number(run.eastKm), Number(run.southKm), Number(run.northKm)]).filter(Number.isFinite);
  const legacyRadius = shapeCoordinates.length ? 0 : Number(cell.radiusKm || 0);
  const maximumDistance = Math.min(200, Math.max(10, Math.max(0, ...shapeCoordinates.map(Math.abs), legacyRadius) * 2 + 5));
  const distanceToExit = direction => {
    const stepKm = .25;
    for (let distance = stepKm; distance <= maximumDistance; distance += stepKm) {
      if (!nowcastCellContainsPoint(cell, unitEast * direction * distance, unitNorth * direction * distance)) return Math.max(0, distance - stepKm / 2);
    }
    return maximumDistance;
  };
  // La cellule se déplace dans le sens +1 ; le point fixe traverse donc la
  // forme en sens inverse. La sortie future se trouve du côté -1.
  const remainingDistanceKm = distanceToExit(-1);
  const traversedDistanceKm = distanceToExit(1);
  const totalDistanceKm = remainingDistanceKm + traversedDistanceKm;
  return totalDistanceKm > 0 ? {
    remainingDistanceKm,
    totalDistanceKm,
    remainingFraction: Math.max(0, Math.min(1, remainingDistanceKm / totalDistanceKm))
  } : null;
}

function nowcastCellProjectedPassages(cell, horizonMinutes = 180) {
  const points = (cell?.track?.points || []).filter(point => Number.isFinite(Number(point?.eastKm))
    && Number.isFinite(Number(point?.northKm))
    && Number.isFinite(Number(point?.minutes)));
  const start = points[0];
  const next = points.find(point => point !== start
    && Number(point.minutes) > Number(start?.minutes)
    && Math.hypot(Number(point.eastKm) - Number(start?.eastKm), Number(point.northKm) - Number(start?.northKm)) >= .1);
  if (!start || !next) return [];
  const elapsedMinutes = Number(next.minutes) - Number(start.minutes);
  const velocityEast = (Number(next.eastKm) - Number(start.eastKm)) / elapsedMinutes;
  const velocityNorth = (Number(next.northKm) - Number(start.northKm)) / elapsedMinutes;
  if (!Number.isFinite(velocityEast) || !Number.isFinite(velocityNorth) || Math.hypot(velocityEast, velocityNorth) < .001) return [];

  const shapeRuns = Array.isArray(cell?.shapeRuns) ? cell.shapeRuns : [];
  let intervals = [];
  if (shapeRuns.length) {
    const axisInterval = (minimum, maximum, velocity) => {
      const targetVelocity = -velocity;
      if (Math.abs(targetVelocity) < 1e-9) return minimum <= 0 && maximum >= 0 ? [-Infinity, Infinity] : null;
      const first = minimum / targetVelocity;
      const second = maximum / targetVelocity;
      return [Math.min(first, second), Math.max(first, second)];
    };
    intervals = shapeRuns.flatMap(run => {
      const east = axisInterval(Number(run.westKm), Number(run.eastKm), velocityEast);
      const north = axisInterval(Number(run.southKm), Number(run.northKm), velocityNorth);
      if (!east || !north) return [];
      const intervalStart = Math.max(0, east[0], north[0]);
      const projectedEnd = Math.min(east[1], north[1]);
      const intervalEnd = Math.min(horizonMinutes, projectedEnd);
      return Number.isFinite(intervalStart) && Number.isFinite(intervalEnd) && intervalEnd > intervalStart
        ? [{ startMinutes: intervalStart, endMinutes: intervalEnd, continuesBeyondHorizon: !Number.isFinite(projectedEnd) || projectedEnd > horizonMinutes }]
        : [];
    });
  } else {
    const stepMinutes = .25;
    let intervalStart = null;
    for (let minutes = 0; minutes <= horizonMinutes + stepMinutes; minutes += stepMinutes) {
      const inside = minutes <= horizonMinutes
        && nowcastCellContainsPoint(cell, -velocityEast * minutes, -velocityNorth * minutes);
      if (inside && intervalStart == null) intervalStart = minutes;
      if (!inside && intervalStart != null) {
        intervals.push({ startMinutes: intervalStart, endMinutes: Math.min(horizonMinutes, minutes), continuesBeyondHorizon: minutes > horizonMinutes });
        intervalStart = null;
      }
    }
  }

  return intervals
    .sort((left, right) => left.startMinutes - right.startMinutes)
    .reduce((merged, interval) => {
      const previous = merged.at(-1);
      if (previous && interval.startMinutes <= previous.endMinutes + .05) {
        previous.endMinutes = Math.max(previous.endMinutes, interval.endMinutes);
        previous.continuesBeyondHorizon ||= Boolean(interval.continuesBeyondHorizon);
      } else {
        merged.push({ ...interval });
      }
      return merged;
    }, [])
    .map(interval => ({
      ...interval,
      durationMinutes: interval.endMinutes - interval.startMinutes,
      durationBeyondHorizon: interval.startMinutes <= .05
        && interval.endMinutes >= horizonMinutes - .05
        && Boolean(interval.continuesBeyondHorizon)
    }));
}

function nowcastCellRainProfilePassages(cell, horizonMinutes = 180) {
  const profile = Array.isArray(cell?.rainProfile) ? cell.rainProfile : [];
  const intervals = profile.flatMap(segment => {
    if (segment?.startMinutes == null || segment?.endMinutes == null || segment?.intensity == null) return [];
    const startMinutes = Math.max(0, Number(segment?.startMinutes));
    const projectedEnd = Number(segment?.endMinutes);
    const endMinutes = Math.min(horizonMinutes, projectedEnd);
    const intensity = Math.max(0, Number(segment?.intensity) || 0);
    return Number.isFinite(startMinutes) && Number.isFinite(endMinutes) && endMinutes > startMinutes && intensity > 0
      ? [{ startMinutes, endMinutes, intensity, continuesBeyondHorizon: projectedEnd >= horizonMinutes }]
      : [];
  });
  if (!intervals.length) return [];

  const boundaries = [...new Set(intervals.flatMap(interval => [interval.startMinutes, interval.endMinutes]))]
    .sort((left, right) => left - right);
  const normalized = [];
  for (let index = 0; index < boundaries.length - 1; index++) {
    const startMinutes = boundaries[index];
    const endMinutes = boundaries[index + 1];
    const midpoint = (startMinutes + endMinutes) / 2;
    const active = intervals.filter(interval => interval.startMinutes < midpoint && interval.endMinutes > midpoint);
    if (!active.length) continue;
    const intensity = active.reduce((sum, interval) => sum + interval.intensity, 0) / active.length;
    const continuesBeyondHorizon = active.some(interval => interval.continuesBeyondHorizon);
    const previous = normalized.at(-1);
    if (previous && startMinutes - previous.endMinutes <= .01 && Math.abs(previous.intensity - intensity) <= .05) {
      previous.endMinutes = endMinutes;
      previous.continuesBeyondHorizon ||= continuesBeyondHorizon;
    } else {
      normalized.push({ startMinutes, endMinutes, intensity, continuesBeyondHorizon });
    }
  }

  return normalized.reduce((passages, segment) => {
    const previous = passages.at(-1);
    if (previous && segment.startMinutes <= previous.endMinutes + .05) {
      previous.endMinutes = Math.max(previous.endMinutes, segment.endMinutes);
      previous.intensityProfile.push(segment);
      previous.continuesBeyondHorizon ||= Boolean(segment.continuesBeyondHorizon);
    } else {
      passages.push({
        startMinutes: segment.startMinutes,
        endMinutes: segment.endMinutes,
        intensityProfile: [segment],
        continuesBeyondHorizon: Boolean(segment.continuesBeyondHorizon)
      });
    }
    return passages;
  }, []).map(passage => ({
    ...passage,
    durationMinutes: passage.endMinutes - passage.startMinutes,
    durationBeyondHorizon: passage.startMinutes <= .05
      && passage.endMinutes >= horizonMinutes - .05
      && Boolean(passage.continuesBeyondHorizon)
  }));
}

function nowcastCellPostContactDeparture(cell, radarObservedAt = null) {
  if (typeof cell?.postContactDepartureConfirmed === "boolean") return cell.postContactDepartureConfirmed;
  const contactAt = Date.parse(cell?.lastDirectContactAt || "");
  const observedAt = Date.parse(radarObservedAt || "");
  const contactAge = observedAt - contactAt;
  const edgeDistanceKm = Number(cell?.edgeDistanceKm);
  const confidence = Number(cell?.track?.confidence);
  const speedKmh = Number(cell?.track?.speedKmh);
  const horizonMinutes = Number(cell?.track?.horizonMinutes);
  const hasEta = [cell?.etaMinutes, cell?.etaCoreMinutes, cell?.etaEnvelopeMinutes]
    .some(value => value != null && value !== "" && Number.isFinite(Number(value)));
  const radialChangeKm = Number(cell?.passageTrend?.radialChangeKm);
  return Number.isFinite(contactAt) && Number.isFinite(observedAt)
    && contactAge >= 0 && contactAge <= 45 * 60000
    && Number.isFinite(edgeDistanceKm) && edgeDistanceKm > .25
    && !hasEta && confidence >= 35 && speedKmh >= 5 && horizonMinutes >= 60
    && Number.isFinite(radialChangeKm) && radialChangeKm >= 1;
}

function nowcastCellProjectionQuality(cell, radarObservedAt) {
  if (nowcastCellPostContactDeparture(cell, radarObservedAt)) return { reliable: false, reason: "post-contact-departure" };
  const speedKmh = Number(cell?.track?.speedKmh);
  const confidence = Number(cell?.track?.confidence);
  const horizonMinutes = Number(cell?.track?.horizonMinutes);
  if (!Number.isFinite(speedKmh) || speedKmh <= 2) return { reliable: false, reason: "motion-unavailable" };
  if (!Number.isFinite(confidence) || confidence < 35) return { reliable: false, reason: "motion-confidence" };
  if (!Number.isFinite(horizonMinutes) || horizonMinutes < 45) return { reliable: false, reason: "motion-horizon" };
  if (cell?.track?.inherited === true) return { reliable: false, reason: "inherited-motion" };

  const observationTime = Date.parse(radarObservedAt || "");
  const historyByTime = new Map((Array.isArray(cell?.history) ? cell.history : []).map(point => [Date.parse(point?.observedAt || ""), point]));
  if (Number.isFinite(observationTime)) historyByTime.set(observationTime, {
    observedAt: radarObservedAt,
    eastKm: cell?.eastKm,
    northKm: cell?.northKm,
    areaKm2: cell?.areaKm2
  });
  const recent = [...historyByTime.entries()]
    .map(([time, point]) => ({
      time,
      eastKm: Number(point?.eastKm),
      northKm: Number(point?.northKm),
      areaKm2: Number(point?.areaKm2)
    }))
    .filter(point => Number.isFinite(point.time) && Number.isFinite(point.eastKm) && Number.isFinite(point.northKm)
      && (!Number.isFinite(observationTime) || point.time >= observationTime - 20 * 60000) && point.time <= observationTime)
    .sort((left, right) => left.time - right.time);
  const areas = recent.map(point => point.areaKm2).filter(value => Number.isFinite(value) && value > 0);
  if (areas.length >= 3 && Math.max(...areas) / Math.min(...areas) > 2.5) {
    return { reliable: false, reason: "footprint-changing" };
  }

  const trackPoints = (cell?.track?.points || [])
    .filter(point => Number.isFinite(Number(point?.minutes))
      && Number.isFinite(Number(point?.eastKm))
      && Number.isFinite(Number(point?.northKm)))
    .sort((left, right) => Number(left.minutes) - Number(right.minutes));
  const trackStart = trackPoints[0];
  const trackNext = trackPoints.find(point => Number(point.minutes) > Number(trackStart?.minutes));
  if (!trackStart || !trackNext) return { reliable: false, reason: "motion-points-missing" };
  if (recent.length >= 2 && trackStart && trackNext) {
    const previous = recent.at(-2);
    const current = recent.at(-1);
    const elapsedMinutes = (current.time - previous.time) / 60000;
    const observedEast = current.eastKm - previous.eastKm;
    const observedNorth = current.northKm - previous.northKm;
    const projectedEast = Number(trackNext.eastKm) - Number(trackStart.eastKm);
    const projectedNorth = Number(trackNext.northKm) - Number(trackStart.northKm);
    const observedDistance = Math.hypot(observedEast, observedNorth);
    const projectedDistance = Math.hypot(projectedEast, projectedNorth);
    const projectedMinutes = Number(trackNext.minutes) - Number(trackStart.minutes);
    if (elapsedMinutes > 0 && elapsedMinutes <= 15 && observedDistance >= .5 && projectedDistance >= .5 && projectedMinutes > 0) {
      const alignment = (observedEast * projectedEast + observedNorth * projectedNorth) / (observedDistance * projectedDistance);
      const speedRatio = (observedDistance / elapsedMinutes) / (projectedDistance / projectedMinutes);
      if (alignment < .45 || speedRatio < .35 || speedRatio > 2.85) {
        return { reliable: false, reason: "track-discontinuity" };
      }
    }
  }
  if (recent.length >= 3) {
    const first = recent.at(-3);
    const middle = recent.at(-2);
    const last = recent.at(-1);
    const previousEast = middle.eastKm - first.eastKm;
    const previousNorth = middle.northKm - first.northKm;
    const latestEast = last.eastKm - middle.eastKm;
    const latestNorth = last.northKm - middle.northKm;
    const previousDistance = Math.hypot(previousEast, previousNorth);
    const latestDistance = Math.hypot(latestEast, latestNorth);
    if (previousDistance >= .5 && latestDistance >= .5
      && (previousEast * latestEast + previousNorth * latestNorth) / (previousDistance * latestDistance) < 0) {
      return { reliable: false, reason: "track-reversal" };
    }
  }
  return { reliable: true, reason: "consistent-motion" };
}

function nowcastPreviousProjection(event, projectionSnapshot) {
  const passageIndex = Number(event?.passageIndex);
  if (!Number.isInteger(passageIndex) || passageIndex < 0) return null;
  const candidates = (Array.isArray(projectionSnapshot?.projections) ? projectionSnapshot.projections : [])
    .filter(projection => String(projection?.cellId) === String(event?.cell?.id)
      && Number.isInteger(Number(projection?.passageIndex))
      && Number(projection.passageIndex) === passageIndex
      && String(projection?.projectionKind || "") === String(event?.projectionKind || "")
      && Number.isFinite(Number(projection?.eventStart)) && Number.isFinite(Number(projection?.eventEnd)));
  return candidates.reduce((best, projection) => {
    const score = Math.abs(Number(projection.eventStart) - Number(event.eventStart))
      + Math.abs(Number(projection.eventEnd) - Number(event.eventEnd));
    return !best || score < best.score ? { projection, score } : best;
  }, null)?.projection || null;
}

function nowcastProjectionFingerprint(event) {
  return JSON.stringify([
    event?.projectionKind || null,
    Number(event?.passage),
    Number(event?.eventStart),
    Number(event?.eventEnd),
    Number(event?.durationMinutes),
    Number(event?.projectedAmountMm),
    Number(event?.conditionalIntensity),
    (Array.isArray(event?.intensityProfile) ? event.intensityProfile : []).map(segment => [
      Number(segment?.start),
      Number(segment?.end),
      Number(segment?.intensity)
    ])
  ]);
}

function nowcastProjectionProfileSignature(event, bucketCount = 4) {
  const eventStart = Number(event?.eventStart);
  const eventEnd = Number(event?.eventEnd);
  const profile = Array.isArray(event?.intensityProfile) ? event.intensityProfile : [];
  if (!Number.isFinite(eventStart) || !Number.isFinite(eventEnd) || eventEnd <= eventStart || !profile.length) return null;
  const bucketDuration = (eventEnd - eventStart) / bucketCount;
  return Array.from({ length: bucketCount }, (_, index) => {
    const start = eventStart + index * bucketDuration;
    const end = index === bucketCount - 1 ? eventEnd : start + bucketDuration;
    const weightedIntensity = profile.reduce((sum, segment) => {
      const overlap = Math.max(0, Math.min(end, Number(segment?.end)) - Math.max(start, Number(segment?.start)));
      return sum + overlap * Math.max(0, Number(segment?.intensity) || 0);
    }, 0);
    return Math.round(weightedIntensity / Math.max(1, end - start) * 1000) / 1000;
  });
}

function nowcastProjectionFresh(event, referenceTime = null) {
  const observedAt = Number(event?.radarObservedAt);
  if (!Number.isFinite(observedAt)) return true;
  const evaluatedAt = referenceTime == null
    ? typeof appNow === "function" ? Number(appNow()) : Date.now()
    : Number(referenceTime);
  return Number.isFinite(evaluatedAt)
    && evaluatedAt >= observedAt - 5 * 60000
    && evaluatedAt - observedAt <= 15 * 60000;
}

function nowcastProjectionHistory(projectionSnapshot) {
  const history = Array.isArray(projectionSnapshot?.projectionHistory)
    ? projectionSnapshot.projectionHistory
    : [];
  if (history.length) return history;
  return projectionSnapshot?.observedAt && Array.isArray(projectionSnapshot?.projections)
    ? [{ observedAt: projectionSnapshot.observedAt, projections: projectionSnapshot.projections }]
    : [];
}

function nowcastArrivalProjectionQuality(cell, radarObservedAt) {
  if (cell?.track?.inherited !== true) return nowcastCellProjectionQuality(cell, radarObservedAt);
  // Une vitesse héritée ne suffit jamais à valider une durée ou une lame d'eau,
  // mais elle ne doit pas invalider une heure d'arrivée répétée par la géométrie.
  return nowcastCellProjectionQuality({
    ...cell,
    track: { ...cell.track, inherited: false }
  }, radarObservedAt);
}

function nowcastMedian(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function nowcastPresenceAssessment(event, projectionSnapshot, radarObservedAt, trackingEnabled) {
  const currentObservation = Date.parse(radarObservedAt || "");
  const currentStart = Number(event?.eventStart);
  const currentPassage = Number(event?.passage);
  const exactProjection = ["profile", "shape"].includes(event?.projectionKind)
    && event?.cell?.etaBasis !== "envelope";
  const quality = nowcastArrivalProjectionQuality(event?.cell, radarObservedAt);
  const candidate = Number.isFinite(currentStart)
    && Number.isFinite(currentPassage)
    && currentPassage >= 55
    && event?.cell?.etaBasis !== "envelope"
    && quality.reliable;
  const empty = reason => ({
    presenceReliable: false,
    arrivalReliable: false,
    presenceProbability: null,
    presenceStableScans: 0,
    arrivalStableScans: 0,
    presenceReason: reason,
    arrivalReason: reason,
    presenceCandidate: candidate,
    arrivalCandidate: candidate && exactProjection
  });
  if (!candidate) return empty(quality.reliable ? "presence-not-eligible" : quality.reason);
  if (!trackingEnabled) return {
    ...empty("legacy"),
    presenceReliable: true,
    arrivalReliable: exactProjection,
    presenceProbability: Math.round(currentPassage / 5) * 5,
    presenceStableScans: null,
    arrivalStableScans: exactProjection ? null : 0
  };

  const sameObservation = Date.parse(projectionSnapshot?.observedAt || "") === currentObservation
    ? (projectionSnapshot?.projections || []).filter(projection =>
      String(projection?.cellId) === String(event?.cell?.id)
      && Math.abs(Number(projection?.eventStart) - currentStart) <= 10 * 60000
    ).sort((left, right) => Math.abs(Number(left.eventStart) - currentStart) - Math.abs(Number(right.eventStart) - currentStart))[0]
    : null;
  if (sameObservation) return {
    presenceReliable: sameObservation.presenceReliable === true,
    arrivalReliable: sameObservation.arrivalReliable === true,
    presenceProbability: Number.isFinite(Number(sameObservation.presenceProbability))
      ? Number(sameObservation.presenceProbability) : null,
    presenceStableScans: Math.max(0, Number(sameObservation.presenceStableScans) || 0),
    arrivalStableScans: Math.max(0, Number(sameObservation.arrivalStableScans) || 0),
    presenceReason: sameObservation.presenceReason || "not-confirmed",
    arrivalReason: sameObservation.arrivalReason || "not-confirmed",
    presenceCandidate: sameObservation.presenceCandidate === true,
    arrivalCandidate: sameObservation.arrivalCandidate === true
  };

  const recentHistory = nowcastProjectionHistory(projectionSnapshot)
    .map(snapshot => ({ ...snapshot, time: Date.parse(snapshot?.observedAt || "") }))
    .filter(snapshot => Number.isFinite(snapshot.time)
      && snapshot.time < currentObservation
      && currentObservation - snapshot.time <= 15 * 60000)
    .sort((left, right) => right.time - left.time)
    .slice(0, 2);
  const matches = recentHistory.flatMap(snapshot => (snapshot.projections || [])
    .filter(projection => String(projection?.cellId) === String(event?.cell?.id)
      && projection?.presenceCandidate === true
      && Number.isFinite(Number(projection?.eventStart))
      && Math.abs(Number(projection.eventStart) - currentStart) <= 10 * 60000)
    .map(projection => ({ ...projection, observedAt: snapshot.observedAt }))
  ).sort((left, right) => Math.abs(Number(left.eventStart) - currentStart) - Math.abs(Number(right.eventStart) - currentStart));
  const compatibleMatches = [...new Map(matches.map(projection => [projection.observedAt, projection])).values()].slice(0, 2);
  const previous = compatibleMatches[0] || null;
  if (!previous) return empty("not-confirmed");

  const rawProbability = nowcastMedian([currentPassage, ...compatibleMatches.map(projection => Number(projection.passage))]);
  let presenceProbability = rawProbability == null ? null : Math.max(0, Math.min(100, Math.round(rawProbability / 5) * 5));
  const previousProbability = Number(compatibleMatches.find(projection =>
    Number.isFinite(Number(projection.presenceProbability)))?.presenceProbability);
  if (Number.isFinite(previousProbability) && Math.abs(presenceProbability - previousProbability) < 10) {
    presenceProbability = previousProbability;
  }
  const previousExact = compatibleMatches.some(projection => projection.arrivalCandidate === true
    && ["profile", "shape"].includes(projection.projectionKind));
  return {
    presenceReliable: true,
    arrivalReliable: exactProjection && previousExact,
    presenceProbability,
    presenceStableScans: Math.max(1, Number(previous.presenceStableScans) || 0) + 1,
    arrivalStableScans: exactProjection && previousExact
      ? Math.max(1, Number(previous.arrivalStableScans) || 0) + 1 : 0,
    presenceReason: "confirmed-arrival-window",
    arrivalReason: exactProjection && previousExact ? "confirmed-arrival" : "exact-arrival-not-confirmed",
    presenceCandidate: true,
    arrivalCandidate: exactProjection
  };
}

function nowcastProjectionAssessment(event, projectionSnapshot, radarObservedAt, trackingEnabled) {
  const currentProfileSignature = nowcastProjectionProfileSignature(event);
  const currentAnchor = {
    anchorPassage: event?.passage,
    anchorEventStart: event?.eventStart,
    anchorEventEnd: event?.eventEnd,
    anchorDurationMinutes: event?.durationMinutes,
    anchorProjectedAmountMm: event?.projectedAmountMm,
    anchorConditionalIntensity: event?.conditionalIntensity,
    anchorProfileSignature: currentProfileSignature
  };
  const reset = (reason, candidate = false) => ({ reliable: false, stableScans: 0, reason, candidate, ...currentAnchor });
  if (event?.projectionKind === "fallback") return reset("eta-fallback");
  if (event?.cell?.etaBasis === "envelope") return reset("eta-envelope");
  if (event?.durationBeyondHorizon === true || Number(event?.projectionEndMinutes) > 60) {
    return reset("confidence-horizon");
  }
  if (!trackingEnabled) return { reliable: true, stableScans: null, reason: "legacy", candidate: true, ...currentAnchor };
  const quality = nowcastCellProjectionQuality(event.cell, radarObservedAt);
  if (!quality.reliable) return reset(quality.reason);
  const trackHorizonMinutes = Number(event?.cell?.track?.horizonMinutes);
  if (Number.isFinite(trackHorizonMinutes) && Number(event?.projectionEndMinutes) >= trackHorizonMinutes - .05) {
    return reset("confidence-horizon");
  }
  const currentObservation = Date.parse(radarObservedAt || "");
  const previousObservation = Date.parse(projectionSnapshot?.observedAt || "");
  const previous = nowcastPreviousProjection(event, projectionSnapshot);
  if (currentObservation === previousObservation && previous) {
    const sameProjection = nowcastProjectionFingerprint(event) === previous.projectionFingerprint;
    if (!sameProjection) return reset("observation-revised", true);
    return {
      reliable: previous.projectionReliable === true,
      stableScans: Math.max(0, Number(previous.stableScans) || 0),
      reason: previous.projectionReason || (previous.projectionReliable ? "confirmed" : "not-confirmed"),
      candidate: previous.projectionCandidate === true,
      anchorPassage: previous.anchorPassage ?? previous.passage,
      anchorEventStart: previous.anchorEventStart ?? previous.eventStart,
      anchorEventEnd: previous.anchorEventEnd ?? previous.eventEnd,
      anchorDurationMinutes: previous.anchorDurationMinutes ?? previous.durationMinutes,
      anchorProjectedAmountMm: previous.anchorProjectedAmountMm ?? previous.projectedAmountMm,
      anchorConditionalIntensity: previous.anchorConditionalIntensity ?? previous.conditionalIntensity,
      anchorProfileSignature: previous.anchorProfileSignature ?? previous.profileSignature ?? null
    };
  }
  const elapsed = currentObservation - previousObservation;
  if (!previous || !Number.isFinite(elapsed) || elapsed <= 0 || elapsed > 15 * 60000
    || previous.projectionCandidate !== true) {
    return reset("not-confirmed", true);
  }
  const tolerance = 8 * 60000;
  const durationTolerance = 10;
  const anchorEventStart = Number(previous.anchorEventStart ?? previous.eventStart);
  const anchorEventEnd = Number(previous.anchorEventEnd ?? previous.eventEnd);
  const anchorPassage = Number(previous.anchorPassage ?? previous.passage);
  const anchorDuration = Number(previous.anchorDurationMinutes ?? previous.durationMinutes);
  const anchorAmount = Number(previous.anchorProjectedAmountMm ?? previous.projectedAmountMm);
  const anchorIntensity = Number(previous.anchorConditionalIntensity ?? previous.conditionalIntensity);
  const previousEventStart = Number(previous.eventStart);
  const previousEventEnd = Number(previous.eventEnd);
  const previousPassage = Number(previous.passage);
  const previousDuration = Number(previous.durationMinutes);
  const previousAmount = Number(previous.projectedAmountMm);
  const previousIntensity = Number(previous.conditionalIntensity);
  const anchorProfileSignature = previous.anchorProfileSignature ?? previous.profileSignature ?? null;
  const previousProfileSignature = previous.profileSignature ?? null;
  const currentDuration = Number(event.durationMinutes);
  const currentPassage = Number(event.passage);
  const currentAmount = Number(event.projectedAmountMm);
  const currentIntensity = Number(event.conditionalIntensity);
  const near = (left, right, maximumDifference) => Number.isFinite(left) && Number.isFinite(right)
    && Math.abs(left - right) <= maximumDifference + 1e-9;
  const amountTolerance = Math.max(.1, Math.abs(anchorAmount) * .35);
  const previousAmountTolerance = Math.max(.1, Math.abs(previousAmount) * .35);
  const amountConsistent = near(currentAmount, anchorAmount, amountTolerance)
    && near(currentAmount, previousAmount, previousAmountTolerance);
  const active = Number(event.etaMinutes) <= .5;
  const activeAmountNear = (referenceAmount, referenceDuration) => {
    if (!Number.isFinite(currentAmount) || !Number.isFinite(currentDuration) || currentDuration <= 0
      || !Number.isFinite(referenceAmount) || !Number.isFinite(referenceDuration) || referenceDuration <= 0) return false;
    const expectedAmount = referenceAmount * currentDuration / referenceDuration;
    return near(currentAmount, expectedAmount, Math.max(.1, Math.abs(expectedAmount) * .35));
  };
  const activeAmountConsistent = activeAmountNear(anchorAmount, anchorDuration)
    && activeAmountNear(previousAmount, previousDuration);
  const intensityTolerance = Math.max(.1, Math.abs(anchorIntensity) * .35);
  const previousIntensityTolerance = Math.max(.1, Math.abs(previousIntensity) * .35);
  const intensityConsistent = near(currentIntensity, anchorIntensity, intensityTolerance)
    && near(currentIntensity, previousIntensity, previousIntensityTolerance);
  const profileNear = (left, right) => {
    if (left == null && right == null) return true;
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => near(Number(value), Number(right[index]), Math.max(.2, Math.abs(Number(right[index])) * .5)));
  };
  const profileConsistent = profileNear(currentProfileSignature, anchorProfileSignature)
    && profileNear(currentProfileSignature, previousProfileSignature);
  const passageOverlap = (start, end, referenceStart, referenceEnd) => {
    if (![start, end, referenceStart, referenceEnd].every(Number.isFinite)
      || end <= start || referenceEnd <= referenceStart) return false;
    const shorterDuration = Math.min(end - start, referenceEnd - referenceStart);
    const overlap = Math.max(0, Math.min(end, referenceEnd) - Math.max(start, referenceStart));
    return overlap >= Math.min(shorterDuration, Math.max(30000, shorterDuration * .5));
  };
  const samePassage = passageOverlap(Number(event.eventStart), Number(event.eventEnd), anchorEventStart, anchorEventEnd)
    && passageOverlap(Number(event.eventStart), Number(event.eventEnd), previousEventStart, previousEventEnd);
  const passageValuesAvailable = [currentPassage, anchorPassage, previousPassage].every(Number.isFinite);
  const passageConsistent = passageValuesAvailable
    && near(currentPassage, anchorPassage, 12) && near(currentPassage, previousPassage, 12);
  const consistent = near(Number(event.eventEnd), anchorEventEnd, tolerance)
    && near(Number(event.eventEnd), previousEventEnd, tolerance)
    && (active || (near(Number(event.eventStart), anchorEventStart, tolerance)
      && near(Number(event.eventStart), previousEventStart, tolerance)))
    && (active || (near(currentDuration, anchorDuration, durationTolerance)
      && near(currentDuration, previousDuration, durationTolerance)))
    && intensityConsistent
    && profileConsistent
    && samePassage
    && passageConsistent
    && (active ? activeAmountConsistent : amountConsistent);
  const stableScans = consistent ? Math.max(0, Number(previous.stableScans) || 0) + 1 : 0;
  return {
    reliable: stableScans >= 2,
    stableScans,
    reason: consistent ? "confirmed" : "projection-shift",
    candidate: true,
    ...(consistent ? {
      anchorPassage: previous.anchorPassage ?? previous.passage,
      anchorEventStart,
      anchorEventEnd,
      anchorDurationMinutes: previous.anchorDurationMinutes ?? previous.durationMinutes,
      anchorProjectedAmountMm: previous.anchorProjectedAmountMm ?? previous.projectedAmountMm,
      anchorConditionalIntensity: previous.anchorConditionalIntensity ?? previous.conditionalIntensity,
      anchorProfileSignature: previous.anchorProfileSignature ?? previous.profileSignature ?? null
    } : currentAnchor)
  };
}

function nowcastProjectionSnapshot(events) {
  return (events || []).map(event => ({
    cellId: event?.cell?.id,
    etaBasis: event?.cell?.etaBasis || null,
    passageIndex: event?.passageIndex,
    passage: Number(event?.passage),
    eventStart: event?.eventStart,
    eventEnd: event?.eventEnd,
    radarObservedAt: event?.radarObservedAt,
    etaMinutes: event?.etaMinutes,
    projectionEndMinutes: event?.projectionEndMinutes,
    durationBeyondHorizon: event?.durationBeyondHorizon === true,
    durationMinutes: event?.durationMinutes,
    projectedAmountMm: event?.projectedAmountMm,
    conditionalIntensity: event?.conditionalIntensity,
    profileSignature: nowcastProjectionProfileSignature(event),
    projectionFingerprint: nowcastProjectionFingerprint(event),
    projectionKind: event?.projectionKind || null,
    projectionReliable: event?.projectionReliable === true,
    projectionReason: event?.projectionReason || null,
    projectionCandidate: event?.projectionCandidate === true,
    stableScans: Math.max(0, Number(event?.projectionStableScans) || 0),
    presenceReliable: event?.presenceReliable === true,
    arrivalReliable: event?.arrivalReliable === true,
    presenceProbability: Number.isFinite(Number(event?.presenceProbability)) ? Number(event.presenceProbability) : null,
    presenceStableScans: Math.max(0, Number(event?.presenceStableScans) || 0),
    arrivalStableScans: Math.max(0, Number(event?.arrivalStableScans) || 0),
    presenceReason: event?.presenceReason || null,
    arrivalReason: event?.arrivalReason || null,
    presenceCandidate: event?.presenceCandidate === true,
    arrivalCandidate: event?.arrivalCandidate === true,
    presenceHeld: event?.presenceHeld === true,
    presenceMisses: Math.max(0, Number(event?.presenceMisses) || 0),
    anchorPassage: event?.projectionAnchorPassage,
    anchorEventStart: event?.projectionAnchorEventStart,
    anchorEventEnd: event?.projectionAnchorEventEnd,
    anchorDurationMinutes: event?.projectionAnchorDurationMinutes,
    anchorProjectedAmountMm: event?.projectionAnchorProjectedAmountMm,
    anchorConditionalIntensity: event?.projectionAnchorConditionalIntensity,
    anchorProfileSignature: event?.projectionAnchorProfileSignature
  }));
}

function nowcastNextProjectionHistory(projectionSnapshot, observedAt, projections) {
  const currentTime = Date.parse(observedAt || "");
  const history = nowcastProjectionHistory(projectionSnapshot)
    .filter(snapshot => snapshot?.observedAt !== observedAt)
    .filter(snapshot => {
      const time = Date.parse(snapshot?.observedAt || "");
      return Number.isFinite(time) && Number.isFinite(currentTime)
        && time < currentTime && currentTime - time <= 20 * 60000;
    });
  history.push({ observedAt, projections });
  return history.sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt)).slice(-3);
}

function nowcastEtaRainEvents(radar, projectionSnapshot = typeof cellPassageSnapshot === "undefined" ? undefined : cellPassageSnapshot) {
  const radarObservedAt = new Date(radar?.observedAt || 0).getTime();
  if (!Number.isFinite(radarObservedAt)) return [];
  const projectionTrackingEnabled = projectionSnapshot !== undefined;
  const clampDuration = minutes => Math.max(15, Math.min(90, minutes));
  const legacyFootprintAtEta = cell => {
    const etaMinutes = Number(cell.etaMinutes);
    const points = cell.track?.points || [];
    const closestPoint = points.reduce((best, point) => {
      const distance = Math.abs(Number(point.minutes) - etaMinutes);
      return !best || distance < best.distance ? { point, distance } : best;
    }, null)?.point;
    if (cell.etaBasis === "envelope") return Math.max(Number(cell.radiusKm) || 0, Number(closestPoint?.uncertaintyKm) || 0);
    return Math.max(0, Number(cell.radiusKm) || 0) + 2;
  };
  const events = (radar?.cells || []).flatMap(cell => {
    if (cell?.etaMinutes == null) return null;
    const etaMinutes = Number(cell.etaMinutes);
    const passage = Math.max(0, Number(cell.risks?.passage) || 0);
    if (!Number.isFinite(etaMinutes) || etaMinutes < 0 || etaMinutes > 180 || passage <= 0) return null;
    const measuredSpeedKmh = Math.max(0, Number(cell.track?.speedKmh) || 0);
    const speedKmh = Math.max(1, measuredSpeedKmh);
    const rainProfilePassages = nowcastCellRainProfilePassages(cell);
    const shapePassages = nowcastCellProjectedPassages(cell);
    const projectedPassages = rainProfilePassages.length ? rainProfilePassages : shapePassages;
    const projectionKind = rainProfilePassages.length ? "profile" : shapePassages.length ? "shape" : "fallback";
    const traversal = etaMinutes <= .5 ? nowcastCellTraversal(cell) : null;
    const fullTraversalDurationMinutes = traversal && speedKmh > 2
      ? 60 * traversal.totalDistanceKm / speedKmh
      : null;
    // Une ETA probabiliste peut exister alors que le noyau pixelise ne coupe
    // pas exactement le point. La lame d'eau conditionnelle doit tout de meme
    // apparaitre dans la bande Nowcasting orange, avec la probabilite de
    // passage separee, plutot que de disparaitre completement de la frise.
    const needsEtaFallback = !projectedPassages.length;
    const fallbackDurationMinutes = needsEtaFallback
      ? traversal
        ? clampDuration(fullTraversalDurationMinutes ?? 45)
        : clampDuration(speedKmh > 2 ? 60 * (legacyFootprintAtEta(cell) * 2) / speedKmh : 45)
      : 0;
    const fallbackRemainingMinutes = traversal ? Math.max(1, fallbackDurationMinutes * traversal.remainingFraction) : fallbackDurationMinutes;
    const passages = projectedPassages.length
      ? projectedPassages
      : needsEtaFallback ? [{ startMinutes: etaMinutes, endMinutes: etaMinutes + fallbackRemainingMinutes, durationMinutes: fallbackRemainingMinutes }] : [];
    const maximum = Math.max(0, Number(cell.maximum) || 0);
    const representativeIntensity = Math.min(maximum, Math.max(0, Number(cell.mean) || maximum * .5));
    return passages.map((projectedPassage, passageIndex) => {
      const durationMinutes = Math.max(0, Number(projectedPassage.durationMinutes) || 0);
      const eventStart = radarObservedAt + projectedPassage.startMinutes * 60000;
      const eventEnd = radarObservedAt + projectedPassage.endMinutes * 60000;
      const intensityProfile = (projectedPassage.intensityProfile || []).map(segment => ({
        start: radarObservedAt + segment.startMinutes * 60000,
        end: radarObservedAt + segment.endMinutes * 60000,
        intensity: segment.intensity
      }));
      const profiledRain = intensityProfile.reduce((sum, segment) => sum + segment.intensity * (segment.end - segment.start), 0);
      const profiledDuration = intensityProfile.reduce((sum, segment) => sum + segment.end - segment.start, 0);
      const profiledIntensity = profiledDuration > 0 ? profiledRain / profiledDuration : representativeIntensity;
      const projectedAmountMm = profiledDuration > 0
        ? profiledRain / 3600000
        : representativeIntensity * durationMinutes / 60;
      const fadeDurationMinutes = intensityProfile.length
        ? 0
        : passageIndex === 0 && projectedPassage.startMinutes <= .5 && Number.isFinite(fullTraversalDurationMinutes)
          ? fullTraversalDurationMinutes * .1
          : durationMinutes * .1;
      const fadeStart = intensityProfile.length ? null : eventEnd - fadeDurationMinutes * 60000;
      return {
        cell,
        etaMinutes: projectedPassage.startMinutes,
        forecastEtaMinutes: etaMinutes,
        passage,
        passageIndex,
        projectionKind,
        eventStart,
        eventEnd,
        radarObservedAt,
        fadeStart,
        intensityProfile,
        durationMinutes: measuredSpeedKmh > 2 ? Math.max(1, Math.round(durationMinutes)) : null,
        projectionEndMinutes: Number(projectedPassage.endMinutes),
        projectedAmountMm: Math.round(projectedAmountMm * 1000) / 1000,
        durationBeyondHorizon: Boolean(projectedPassage.durationBeyondHorizon),
        remainingFraction: traversal?.remainingFraction ?? 1,
        maximum,
        conditionalIntensity: profiledIntensity,
        etaLabel: cell.etaBasis === "envelope" ? "ETA possible " : "ETA "
      };
    });
  }).filter(Boolean);
  const assessedEvents = events.map(event => {
    const assessment = nowcastProjectionAssessment(event, projectionSnapshot, radar?.observedAt, projectionTrackingEnabled);
    const presence = nowcastPresenceAssessment(event, projectionSnapshot, radar?.observedAt, projectionTrackingEnabled);
    return {
      ...event,
      projectionReliable: assessment.reliable,
      projectionStableScans: assessment.stableScans,
      projectionReason: assessment.reason,
      projectionCandidate: assessment.candidate === true,
      projectionAnchorPassage: assessment.anchorPassage,
      projectionAnchorEventStart: assessment.anchorEventStart,
      projectionAnchorEventEnd: assessment.anchorEventEnd,
      projectionAnchorDurationMinutes: assessment.anchorDurationMinutes,
      projectionAnchorProjectedAmountMm: assessment.anchorProjectedAmountMm,
      projectionAnchorConditionalIntensity: assessment.anchorConditionalIntensity,
      projectionAnchorProfileSignature: assessment.anchorProfileSignature,
      ...presence
    };
  });
  if (!projectionTrackingEnabled) return assessedEvents;
  const currentCellIds = new Set(assessedEvents.map(event => String(event?.cell?.id)));
  const sameObservation = projectionSnapshot?.observedAt === radar?.observedAt;
  const heldEvents = (projectionSnapshot?.projections || []).flatMap(projection => {
    if (projection?.presenceReliable !== true
      || currentCellIds.has(String(projection?.cellId))
      || !Number.isFinite(Number(projection?.eventStart))
      || !Number.isFinite(Number(projection?.eventEnd))
      || Number(projection.eventEnd) <= radarObservedAt) return [];
    const previousObservation = Date.parse(projectionSnapshot?.observedAt || "");
    const canHold = sameObservation
      ? projection?.presenceHeld === true
      : Number.isFinite(previousObservation)
        && radarObservedAt > previousObservation
        && radarObservedAt - previousObservation <= 10 * 60000
        && Math.max(0, Number(projection?.presenceMisses) || 0) < 1;
    if (!canHold) return [];
    return [{
      cell: { id: projection.cellId, etaBasis: projection.etaBasis || "core" },
      passageIndex: projection.passageIndex,
      passage: Number(projection.passage),
      presenceProbability: Number(projection.presenceProbability),
      projectionKind: projection.projectionKind || "fallback",
      eventStart: Number(projection.eventStart),
      eventEnd: Number(projection.eventEnd),
      radarObservedAt,
      etaMinutes: Math.max(0, (Number(projection.eventStart) - radarObservedAt) / 60000),
      projectionEndMinutes: (Number(projection.eventEnd) - radarObservedAt) / 60000,
      durationMinutes: null,
      projectedAmountMm: 0,
      conditionalIntensity: 0,
      intensityProfile: [],
      durationBeyondHorizon: projection.durationBeyondHorizon === true,
      projectionReliable: false,
      projectionReason: "presence-held",
      projectionCandidate: false,
      projectionStableScans: 0,
      presenceReliable: true,
      arrivalReliable: projection.arrivalReliable === true,
      presenceStableScans: Math.max(1, Number(projection.presenceStableScans) || 1),
      arrivalStableScans: Math.max(0, Number(projection.arrivalStableScans) || 0),
      presenceReason: "one-scan-hold",
      arrivalReason: projection.arrivalReason || "one-scan-hold",
      presenceCandidate: false,
      arrivalCandidate: false,
      presenceHeld: true,
      presenceMisses: sameObservation ? 1 : Math.max(0, Number(projection.presenceMisses) || 0) + 1
    }];
  });
  return [...assessedEvents, ...heldEvents];
}

function nowcastEtaRainEligible(event, referenceTime = null) {
  return event?.projectionReliable === true
    && nowcastProjectionFresh(event, referenceTime)
    && Number(event?.passage) >= 55
    && event?.cell?.etaBasis !== "envelope"
    && ["profile", "shape"].includes(event?.projectionKind)
    && event?.durationBeyondHorizon !== true
    && event?.projectionEndMinutes != null
    && Number.isFinite(Number(event?.projectionEndMinutes))
    && Number(event.projectionEndMinutes) <= 60;
}

function nowcastReliablePassageEventForCell(events, cellOrId, referenceTime = null) {
  const cellId = typeof cellOrId === "object" ? cellOrId?.id : cellOrId;
  if (cellId == null) return null;
  const evaluatedAt = referenceTime == null
    ? typeof appNow === "function" ? Number(appNow()) : Date.now()
    : Number(referenceTime);
  if (!Number.isFinite(evaluatedAt)) return null;
  return (events || [])
    .filter(event => String(event?.cell?.id) === String(cellId)
      && (event?.arrivalReliable === true
        || (event?.arrivalReliable == null && event?.projectionReliable === true))
      && nowcastProjectionFresh(event, evaluatedAt)
      && event?.cell?.etaBasis !== "envelope"
      && ["profile", "shape"].includes(event?.projectionKind)
      && Number.isFinite(Number(event?.eventStart))
      && Number.isFinite(Number(event?.eventEnd))
      && Number(event.eventEnd) > evaluatedAt)
    .sort((left, right) => Number(left.eventStart) - Number(right.eventStart))[0] || null;
}

function nowcastCellLocallyObservedInterior(cell, radar) {
  return Boolean(cell)
    && radar?.pointOnRainBorder !== true
    && Number(radar?.currentPrecipitation) >= .05
    && radarCellEdgeDistance(cell) <= 2.5;
}

function nowcastAnnouncedCellPassageRisk(cell, reliableEvent, radar = null) {
  if (!reliableEvent || (reliableEvent.arrivalReliable !== true
    && !(reliableEvent.arrivalReliable == null && reliableEvent.projectionReliable === true))) return null;
  const passage = Number(reliableEvent.presenceProbability ?? reliableEvent.passage);
  return Number.isFinite(passage) ? Math.max(0, Math.min(100, Math.round(passage))) : null;
}

function nowcastCellPassageObserved(cell, radar) {
  return (Array.isArray(cell?.shapeRuns) && cell.shapeRuns.length > 0 && nowcastCellContainsPoint(cell, 0, 0))
    || nowcastCellLocallyObservedInterior(cell, radar);
}

function nowcastDisplayedCellPassageRisk(cell, reliableEvent, radar = null) {
  if (nowcastCellPassageObserved(cell, radar)) return 100;
  if (cell?.passageEnsemble?.status === 'ready' && Number.isFinite(cell.passageEnsemble.pointProbability)) {
    return Math.round(cell.passageEnsemble.pointProbability * 100);
  }
  const announcedPassage = nowcastAnnouncedCellPassageRisk(cell, reliableEvent, radar);
  const passage = announcedPassage ?? Number(cell?.risks?.passage);
  return Number.isFinite(passage) ? Math.max(0, Math.min(100, Math.round(passage))) : null;
}

function nowcastEtaRainRateAt(event, time, referenceTime = null) {
  if (!nowcastEtaRainEligible(event, referenceTime) || time < Number(event.eventStart) || time >= Number(event.eventEnd)) return 0;
  const intensityProfile = Array.isArray(event.intensityProfile) ? event.intensityProfile : [];
  if (intensityProfile.length) {
    return Math.max(0, ...intensityProfile
      .filter(segment => time >= Number(segment.start) && time < Number(segment.end))
      .map(segment => Number(segment.intensity) || 0));
  }
  const intensity = Math.max(0, Number(event.conditionalIntensity ?? event.maximum) || 0);
  const fadeStart = Number(event.fadeStart);
  const fadeDuration = Number(event.eventEnd) - fadeStart;
  if (!Number.isFinite(fadeStart) || fadeDuration <= 0 || time <= fadeStart) return intensity;
  return intensity * Math.max(0, Math.min(1, (Number(event.eventEnd) - time) / fadeDuration));
}

function nowcastEtaRainAmount(events, windowStart, windowEnd, referenceTime = null) {
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) return 0;
  const eligibleEvents = (events || []).filter(event => nowcastEtaRainEligible(event, referenceTime));
  if (!eligibleEvents.length) return 0;
  const boundaries = new Set([windowStart, windowEnd]);
  eligibleEvents.forEach(event => {
    [event.eventStart, event.eventEnd, event.fadeStart]
      .map(Number)
      .filter(time => Number.isFinite(time) && time > windowStart && time < windowEnd)
      .forEach(time => boundaries.add(time));
    (Array.isArray(event.intensityProfile) ? event.intensityProfile : []).forEach(segment => {
      [segment.start, segment.end]
        .map(Number)
        .filter(time => Number.isFinite(time) && time > windowStart && time < windowEnd)
        .forEach(time => boundaries.add(time));
    });
  });
  const times = [...boundaries].sort((left, right) => left - right);
  return times.slice(0, -1).reduce((amount, start, index) => {
    const end = times[index + 1];
    const midpoint = start + (end - start) / 2;
    const maximumRate = Math.max(0, ...eligibleEvents.map(event => nowcastEtaRainRateAt(event, midpoint, referenceTime)));
    return amount + maximumRate * (end - start) / 3600000;
  }, 0);
}

function shortTermRainTrend(values, sourceDetail = "PIAF") {
  const analysedValues = (values || []).slice(0, 12);
  const series = analysedValues.map(item => Math.max(0, Number(item.precipitation) || 0));
  const total = series.reduce((sum, value) => sum + value, 0);
  const wetIndexes = series.map((value, index) => value >= .01 ? index : -1).filter(index => index >= 0);
  const stepDetail = series.length + " pas de 5 min sur l’heure à venir";
  if (!wetIndexes.length || total <= 0) return { label: "stable", change: 0, detail: "Aucune pluie prévue par " + sourceDetail + " · " + stepDetail };

  const middleIndex = (series.length - 1) / 2;
  const mean = total / series.length;
  const numerator = series.reduce((sum, value, index) => sum + (index - middleIndex) * (value - mean), 0);
  const denominator = series.reduce((sum, _, index) => sum + (index - middleIndex) ** 2, 0) || 1;
  const projectedChange = numerator / denominator * Math.max(0, series.length - 1);
  const threshold = Math.max(.005, Math.max(...series) * .15);
  const firstWet = wetIndexes[0];
  const lastWet = wetIndexes.at(-1);
  const lead = index => "+" + Math.round(Number(analysedValues[index]?.seconds) / 60) + " min";
  const timing = "premier signal " + lead(firstWet) + " · dernier signal " + lead(lastWet) + " · " + stepDetail;

  // An imminent peak must describe the transition from the first five-minute
  // step, not the average slope of the whole hour. Otherwise a strong shower
  // arriving in ten minutes followed by dry weather is incorrectly marked as
  // decreasing because the dry tail dominates the regression.
  const peak = Math.max(...series);
  const peakIndex = series.indexOf(peak);
  const immediate = series[0] || 0;
  const imminentRise = peakIndex > 0 && peak - immediate > threshold;
  if (firstWet > 0 || imminentRise) {
    const wording = firstWet > 0 ? "Pluie arrivant" : "Pluie s’intensifiant";
    return { label: "croissant", change: peak - immediate, detail: wording + " selon " + sourceDetail + " · pic prévu " + lead(peakIndex) + " · " + timing };
  }

  if (projectedChange > threshold) {
    return { label: "croissant", change: projectedChange, detail: "Pluie s’intensifiant selon " + sourceDetail + " · " + timing };
  }
  if (projectedChange < -threshold) {
    const wording = lastWet < series.length - 1 ? "Pluie cessant" : "Pluie s’atténuant";
    return { label: "decroissant", change: projectedChange, detail: wording + " selon " + sourceDetail + " · " + timing };
  }
  const wording = firstWet > 0 && lastWet < series.length - 1 ? "Passage pluvieux temporaire" : "Pluie globalement stable";
  return { label: "stable", change: projectedChange, detail: wording + " selon " + sourceDetail + " · " + timing };
}

function stormRiskIntensityStep(riskLevel, intensityLevel) {
  const risk = Math.max(0, Math.min(5, Math.round(Number(riskLevel) || 0)));
  const intensity = Math.max(0, Math.min(5, Math.round(Number(intensityLevel) || 0)));
  if (risk >= 5 && intensity >= 5) return 5;
  if (risk >= 4 && intensity >= 4) return 4;
  if (risk >= 3 || (risk > 0 && intensity >= 3)) return 3;
  return risk;
}

function stormHazardIntensityStep(rainLevel, hailLevel, lightningLevel) {
  const rain = Math.max(0, Math.min(5, Math.round(Number(rainLevel) || 0)));
  const hail = Math.max(0, Math.min(5, Math.round(Number(hailLevel) || 0)));
  const lightning = Math.max(0, Math.min(5, Math.round(Number(lightningLevel) || 0)));
  if (hail >= 5) return 5;
  if (rain >= 5 && (hail > 0 || lightning > 0)) return 5;
  if (hail >= 3) return 4;
  return Math.max(Math.min(4, rain), hail, Math.min(3, lightning));
}

function rainRateFromAccumulation(amount, durationMilliseconds) {
  const rain = Math.max(0, Number(amount) || 0);
  const duration = Number(durationMilliseconds);
  return Number.isFinite(duration) && duration > 0 ? rain * 3600000 / duration : 0;
}

function rainIntensityStep(value) {
  return value <= 0 ? 0 : value < 2 ? 1 : value < 10 ? 2 : value < 30 ? 3 : value < 60 ? 4 : 5;
}

function onlyDrizzleInThreeHours(steps) {
  const wetSteps = (steps || [])
    .map(step => Math.max(0, Number(step?.totalPrecipitation) || 0))
    .filter(amount => amount >= possibleDrizzleThreshold);
  return wetSteps.length > 0 && wetSteps.every(amount => amount < .2);
}

function rainIntensityLabel(intensityLevel = 0) {
  const level = Math.max(0, Math.min(5, Math.round(Number(intensityLevel) || 0)));
  return level >= 5 ? "Pluie violente" : level >= 4 ? "Pluie forte" : level >= 3 ? "Pluie soutenue" : level >= 2 ? "Pluie" : "Pluie faible";
}

function rainPhaseForStep(step) {
  const amount = Math.max(0, Number(step?.totalPrecipitation) || 0);
  if (amount < possibleDrizzleThreshold) return null;
  const basePrecipitation = Number(step?.basePrecipitation);
  const nowcastOnly = Number.isFinite(basePrecipitation) && Math.max(0, basePrecipitation) < possibleDrizzleThreshold;
  if (amount < .2) return { drizzle: true, level: 0, nowcastOnly };
  const duration = Number(step?.intervalEnd) - Number(step?.intervalStart);
  return { drizzle: false, level: rainIntensityStep(rainRateFromAccumulation(amount, duration)), nowcastOnly };
}

function rainPhaseLabel(phase) {
  return phase?.dry ? "Fin de l’épisode de pluie" : phase?.drizzle ? "Pluie faible" : rainIntensityLabel(phase?.level);
}

function rainPhaseRank(phase) {
  if (!phase || phase.dry) return -1;
  if (phase.drizzle) return 0;
  const level = Math.max(0, Math.min(5, Math.round(Number(phase.level) || 0)));
  return level >= 5 ? 4 : level >= 4 ? 3 : level >= 3 ? 2 : 1;
}

function nextRainPhaseTransition(steps, now, currentPhase) {
  if (!currentPhase) return null;
  const currentRank = rainPhaseRank(currentPhase);
  let dropsUntilDry = Boolean(currentPhase.drizzle);
  let dropsPossibleUntilDry = Boolean(currentPhase.drizzle && currentPhase.nowcastOnly);
  const timeline = [...(steps || [])]
    .filter(step => Number.isFinite(Number(step?.intervalStart)) && Number(step?.intervalStart) > now)
    .sort((left, right) => Number(left.intervalStart) - Number(right.intervalStart));
  for (const step of timeline) {
    const phase = rainPhaseForStep(step);
    const etaMinutes = Math.max(1, Math.ceil((Number(step.intervalStart) - now) / 60000));
    if (!phase) return { currentPhase, nextPhase: { dry: true, drizzle: false, level: 0 }, step, etaMinutes, dropsUntilDry, dropsPossibleUntilDry };
    if (!currentPhase.drizzle && phase.drizzle) {
      dropsPossibleUntilDry = dropsUntilDry ? dropsPossibleUntilDry && phase.nowcastOnly : phase.nowcastOnly;
      dropsUntilDry = true;
      continue;
    }
    if (currentPhase.drizzle && phase.drizzle) dropsPossibleUntilDry &&= phase.nowcastOnly;
    if (!phase.drizzle) {
      dropsUntilDry = false;
      dropsPossibleUntilDry = false;
    }
    // Les baisses d’intensité n’ont pas d’intérêt dans le résumé : tant que
    // l’épisode continue, on attend soit une intensification, soit sa fin.
    if (!currentPhase.drizzle && rainPhaseRank(phase) <= currentRank) continue;
    // Pour une pluie faible, la première pluie plus marquée reste l’unique cas où
    // l’on raconte explicitement les deux étapes avec « puis ».
    if (currentPhase.drizzle && phase.drizzle) continue;
    return { currentPhase, nextPhase: phase, step, etaMinutes };
  }
  return null;
}

function shortTermRainTransitionLabel(transition, passageRisk = 100) {
  if (!transition) return "";
  const eta = " dans " + compactMinutesLabel(transition.etaMinutes);
  if (transition.nextPhase?.dry && transition.dropsUntilDry) return "Pluie faible pendant encore " + compactMinutesLabel(transition.etaMinutes);
  if (transition.nextPhase?.dry) return "Fin de l’épisode de pluie" + eta;
  const next = rainPhaseLabel(transition.nextPhase);
  const qualifier = shortTermRiskQualifier(passageRisk);
  return transition.currentPhase?.drizzle
    ? "Pluie faible puis " + next.toLowerCase() + qualifier + eta
    : next + qualifier + eta;
}

function shortTermRiskQualifier(risk) {
  if (risk == null || !Number.isFinite(Number(risk))) return "";
  const probability = Math.max(0, Number(risk) || 0);
  return probability >= 80 ? "" : probability >= 55 ? " probable" : " possible";
}

function shortTermHailQualifier(risk) {
  const probability = Math.max(0, Number(risk) || 0);
  return probability >= 80 ? " avec grêle"
    : probability >= 55 ? " avec grêle probable"
    : probability >= 20 ? " avec grêle possible"
    : "";
}

function shortTermRainLabel(etaMinutes, drizzleOnly = false, intensityLevel = 0, passageRisk = 100) {
  if (!drizzleOnly) {
    const label = rainIntensityLabel(intensityLevel);
    const eta = etaMinutes == null ? null : Number(etaMinutes);
    if (!Number.isFinite(eta) || eta < 0) return "pas de pluie";
    if (eta < 1) return label;
    return label + shortTermRiskQualifier(passageRisk) + " dans " + compactMinutesLabel(Math.max(1, eta));
  }
  const eta = etaMinutes == null ? null : Number(etaMinutes);
  if (!Number.isFinite(eta) || eta < 0) return "pas de pluie";
  return eta < 1
    ? "Pluie faible"
    : "Pluie faible" + (passageRisk == null ? "" : shortTermRiskQualifier(passageRisk)) + " dans " + compactMinutesLabel(Math.max(1, eta));
}

function shortTermRainSequenceLabel(etaMinutes, intensityLevel = 0, passageRisk = 100) {
  const eta = etaMinutes == null ? null : Number(etaMinutes);
  if (!Number.isFinite(eta) || eta < 0) return "Pluie faible";
  const rain = rainIntensityLabel(intensityLevel).toLowerCase() + (eta < 1 ? "" : shortTermRiskQualifier(passageRisk));
  return "Pluie faible puis " + rain + (eta < 1
    ? ""
    : " dans " + compactMinutesLabel(Math.max(1, eta)));
}

function shortTermRainCellLabel(etaMinutes, passageRisk = 100, distanceKm = null, activeCount = 0) {
  const eta = etaMinutes == null ? null : Number(etaMinutes);
  const distance = distanceKm == null ? null : Number(distanceKm);
  if (Number.isFinite(eta) && eta >= 0) {
    if (eta < 1 || Number(activeCount) > 0) return "Cellule pluvieuse";
    return "Cellule pluvieuse" + shortTermRiskQualifier(passageRisk) + " dans " + compactMinutesLabel(Math.max(1, eta));
  }
  if (Number.isFinite(distance)) {
    return "Cellule pluvieuse à " + distance.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " km";
  }
  return "pas de cellule pluvieuse";
}

function shortTermStormLabel(etaMinutes, activeCount = 0, intensityLevel = 0, passageRisk = 100, hailRisk = 0, distanceKm = null) {
  const eta = etaMinutes == null ? null : Number(etaMinutes);
  const distance = distanceKm == null ? null : Number(distanceKm);
  if ((!Number.isFinite(eta) || eta < 0) && Number.isFinite(distance)) {
    return "Orage à " + distance.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " km";
  }
  if (!Number.isFinite(eta) || eta < 0) return "pas d’orage";
  const level = Math.max(0, Math.min(5, Math.round(Number(intensityLevel) || 0)));
  const violent = level >= 4;
  const subject = violent ? "Orage violent" : "Orage";
  const hail = shortTermHailQualifier(hailRisk);
  if (eta < 1 || Number(activeCount) > 0) {
    const count = Math.max(1, Math.round(Number(activeCount) || 1));
    if (count > 1) return count + (violent ? " orages violents" : " orages") + hail;
    return subject + hail;
  }
  return subject + shortTermRiskQualifier(passageRisk) + hail + " dans " + compactMinutesLabel(Math.max(1, eta));
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

function nowcastStormEtaSelection(events, candidateCellIds, now, preferredCellId = null) {
  const allowedIds = new Set(candidateCellIds || []);
  const observedCandidates = (events || []).filter(event => {
    const cellId = event?.cell?.id;
    return allowedIds.has(cellId)
      && nowcastProjectionFresh(event, now)
      && Number.isFinite(Number(event.eventStart))
      && Number.isFinite(Number(event.eventEnd))
      && Number(event.eventEnd) > now;
  });
  const candidates = observedCandidates.filter(event => (event?.arrivalReliable === true
      || (event?.arrivalReliable == null && event?.projectionReliable === true))
    && event?.cell?.etaBasis !== "envelope"
    && (event?.projectionKind == null || ["profile", "shape"].includes(event.projectionKind)));
  const activeByCell = new Map();
  candidates.filter(event => Number(event.eventStart) <= now).forEach(event => {
    const cellId = event.cell.id;
    const previous = activeByCell.get(cellId);
    if (!previous || Number(event.eventEnd) > Number(previous.eventEnd)) activeByCell.set(cellId, event);
  });
  const active = [...activeByCell.values()];
  const activeIds = new Set(active.map(event => event.cell.id));
  const upcomingByCell = new Map();
  candidates.filter(event => Number(event.eventStart) > now && !activeIds.has(event.cell.id)).forEach(event => {
    const cellId = event.cell.id;
    const previous = upcomingByCell.get(cellId);
    if (!previous || Number(event.eventStart) < Number(previous.eventStart)) upcomingByCell.set(cellId, event);
  });
  const upcoming = [...upcomingByCell.values()];
  if (active.length) {
    const event = active.find(item => item.cell.id === preferredCellId)
      || [...active].sort((left, right) => Number(right.passage) - Number(left.passage))[0];
    const durationCalculable = Number.isFinite(Number(event?.durationMinutes)) && Number(event.durationMinutes) > 0;
    const durationReliable = event?.projectionReliable === true;
    const durationBeyondHorizon = event?.durationBeyondHorizon === true;
    return {
      event,
      etaMinutes: 0,
      durationMinutes: durationCalculable && durationReliable ? Math.max(1, Math.ceil((Number(event.eventEnd) - now) / 60000)) : null,
      durationUncertain: !durationCalculable || !durationReliable || durationBeyondHorizon,
      durationBeyondHorizon,
      activeCount: active.length,
      upcomingCount: upcoming.length,
      activeIds: [...activeIds],
      upcomingIds: [...upcomingByCell.keys()]
    };
  }
  const event = upcoming.find(item => item.cell.id === preferredCellId)
    || [...upcoming].sort((left, right) => Number(left.eventStart) - Number(right.eventStart))[0]
    || null;
  const durationCalculable = Number.isFinite(Number(event?.durationMinutes)) && Number(event.durationMinutes) > 0;
  const durationReliable = event?.projectionReliable === true;
  const durationBeyondHorizon = Boolean(event?.durationBeyondHorizon);
  return {
    event,
    etaMinutes: event ? Math.max(0, (Number(event.eventStart) - now) / 60000) : null,
    durationMinutes: durationCalculable && durationReliable ? Number(event.durationMinutes) : null,
    durationUncertain: event
      ? !durationCalculable || !durationReliable || durationBeyondHorizon
      : observedCandidates.length > 0,
    durationBeyondHorizon: event
      ? durationBeyondHorizon
      : observedCandidates.some(item => item?.durationBeyondHorizon === true),
    activeCount: 0,
    upcomingCount: upcoming.length,
    activeIds: [],
    upcomingIds: [...upcomingByCell.keys()]
  };
}

function nowcastUncertainRainBorder(radar, cell, selection, etaMinutes = null) {
  if (!cell || radar?.pointOnRainBorder !== true || radarCellEdgeDistance(cell) > 2.5) return false;
  const presenceOrDurationUncertain = !selection?.event
    || selection.durationUncertain === true
    || selection.durationBeyondHorizon === true
    || selection.event.projectionReliable !== true;
  return presenceOrDurationUncertain;
}

function formatRainAmount(value, decimals = 1) {
  const rounded = Math.round((Number(value) || 0) * 10 ** decimals) / 10 ** decimals;
  return rounded.toLocaleString("fr-FR", {
    minimumFractionDigits: rounded % 1 === 0 ? 0 : decimals,
    maximumFractionDigits: decimals
  });
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

function piafRunTime(piaf) {
  const runText = piaf?.coverageId?.match(/___(\d{4}-\d{2}-\d{2}T\d{2}\.\d{2}\.\d{2}Z)_PT5M$/)?.[1];
  return runText ? Date.parse(runText.replace(/\./g, ":")) : NaN;
}

function piafItemEndTime(piaf, item) {
  const validTime = Date.parse(item?.validTime || "");
  if (Number.isFinite(validTime)) return validTime;
  const runTime = piafRunTime(piaf);
  const seconds = Number(item?.seconds);
  return Number.isFinite(runTime) && Number.isFinite(seconds) ? runTime + seconds * 1000 : NaN;
}

function piafRainSteps(piaf, radar = null, sourceValues = null, etaEvents = null) {
  const values = sourceValues || piaf?.values || [];
  const events = etaEvents || nowcastEtaRainEvents(radar);
  return values.map(item => {
    const intervalEnd = piafItemEndTime(piaf, item);
    const explicitStart = Number(item.intervalStart ?? item.rainIntervalStart);
    const intervalStart = Number.isFinite(explicitStart) && explicitStart < intervalEnd
      ? explicitStart
      : intervalEnd - 5 * 60000;
    const basePrecipitation = Math.max(0, Number(item.precipitation) || 0);
    const radarAdjustedPrecipitation = Math.max(basePrecipitation, Number(item.nowcastPrecipitation ?? item.precipitation) || 0);
    const etaPrecipitation = Number.isFinite(intervalStart) && Number.isFinite(intervalEnd)
      ? nowcastEtaRainAmount(events, intervalStart, intervalEnd)
      : 0;
    // L'extrapolation radar au point et le profil de la cellule décrivent la
    // même pluie. On conserve la plus forte estimation au lieu de les sommer.
    const totalPrecipitation = Math.max(basePrecipitation, radarAdjustedPrecipitation, etaPrecipitation);
    const baseRain = basePrecipitation >= possibleDrizzleThreshold;
    const baseForecastAvailable = piaf?.source !== "radar-archive";
    // Une ancienne réponse API sans qualification ne constitue pas une
    // confirmation de l'extrapolation radar.
    const nowcastReliable = item.nowcastReliable === true;
    // Qualify PIAF only when a recent, usable radar projection explicitly
    // predicts a dry interval. Missing coverage is not contradictory evidence.
    const referenceTime = appNow();
    const observedAt = Date.parse(radar?.observedAt || "");
    const freshRadar = observedAt <= referenceTime + 60000 && referenceTime - observedAt <= 10 * 60000;
    const confidence = Number(radar?.motion?.confidence) || 0;
    const radarHorizon = confidence >= 35 ? 60 : confidence >= 18 ? 30 : confidence >= 8 ? 15 : 5;
    const radarSteps = (radar?.values || []).map(value => ({
      start: observedAt + Number(value.seconds) * 1000 - 300000,
      end: observedAt + Number(value.seconds) * 1000,
      precipitation: value.precipitation
    })).filter(value => value.end > intervalStart && value.start < intervalEnd)
      .sort((left, right) => left.start - right.start);
    const coversInterval = radarSteps.length > 0
      && radarSteps[0].start <= intervalStart && radarSteps.at(-1).end >= intervalEnd
      && radarSteps.every((value, index) => index === 0 || value.start <= radarSteps[index - 1].end);
    const radarPredictsDry = freshRadar && confidence >= 8 && coversInterval
      && intervalEnd <= observedAt + radarHorizon * 60000
      && radarSteps.every(value => Number.isFinite(value.precipitation) && value.precipitation === 0);
    const observedRain = freshRadar && observedAt >= intervalStart && observedAt < intervalEnd
      && (Number(radar?.currentPrecipitation) > 0 || item.radarCellOverPoint === true);
    // No display/alert threshold here: even a sub-percent passage prevents
    // calling the radar contradictory to PIAF. Its rain amount may be unknown.
    const cellConfirms = freshRadar && events.some(event => event.eventStart < intervalEnd && event.eventEnd > intervalStart
      && Math.max(Number(event.passage) || 0, Number(event.presenceProbability) || 0,
        Number(event.cell?.risks?.passage) || 0) > 0);
    const piafUnconfirmed = basePrecipitation > 0 && (!piaf?.source || piaf.source === "piaf")
      && intervalEnd > referenceTime && radarPredictsDry && !observedRain && !cellConfirms;
    return {
      ...item,
      intervalStart,
      intervalEnd,
      basePrecipitation,
      baseRainSource: piaf?.source || "piaf",
      radarAdjustedPrecipitation,
      etaPrecipitation,
      totalPrecipitation,
      piafUnconfirmed,
      rainOccurrenceReliable: !piafUnconfirmed && (baseRain || nowcastReliable),
      dryStateReliable: baseForecastAvailable || nowcastReliable,
      effectiveRadarAmendment: Math.max(0, radarAdjustedPrecipitation - basePrecipitation),
      effectiveEtaAmendment: Math.max(0, totalPrecipitation - radarAdjustedPrecipitation)
    };
  });
}

function rainPassageForStep(step, events, threshold = possibleDrizzleThreshold) {
  if (!step) return null;
  const minimum = Math.max(0, Number(threshold) || 0);
  // PIAF et le déplacement de la mosaïque sont des estimations de cumul,
  // pas des probabilités. Le champ probability joint à PIAF est PEAROME.
  if (Number(step.radarAdjustedPrecipitation) >= minimum) return null;
  const intervalStart = Number(step.intervalStart);
  const intervalEnd = Number(step.intervalEnd);
  if (!Number.isFinite(intervalStart) || !Number.isFinite(intervalEnd) || intervalEnd <= intervalStart) return null;
  const contributors = (events || []).filter(event =>
    Number(event?.eventEnd) > intervalStart
    && Number(event?.eventStart) < intervalEnd
    && nowcastEtaRainAmount([event], intervalStart, intervalEnd) > 0
  );
  return contributors.length
    ? Math.max(0, ...contributors.map(event => Number(event.passage) || 0))
    : null;
}

function rainPassageFragmentsOutside(passage, protectedPassages) {
  return (protectedPassages || []).reduce((fragments, protectedPassage) => fragments.flatMap(fragment => {
    const overlapStart = Math.max(Number(fragment.start), Number(protectedPassage.start));
    const overlapEnd = Math.min(Number(fragment.end), Number(protectedPassage.end));
    if (!Number.isFinite(overlapStart) || !Number.isFinite(overlapEnd) || overlapEnd <= overlapStart) return [fragment];
    const result = [];
    if (Number(fragment.start) < overlapStart) {
      result.push({ ...fragment, end: overlapStart, endKnown: false });
    }
    if (overlapEnd < Number(fragment.end)) {
      result.push({ ...fragment, start: overlapEnd, firstStep: null });
    }
    return result;
  }), [{ ...passage }]);
}

function mergeThreeHourRainPassages(passages) {
  const merged = [];
  for (const item of [...(passages || [])]
    .filter(passage => Number.isFinite(Number(passage?.start))
      && Number.isFinite(Number(passage?.end))
      && Number(passage.end) > Number(passage.start))
    .sort((left, right) => Number(left.start) - Number(right.start))) {
    const previous = merged.at(-1);
    const sameReliability = previous
      && (previous.occurrenceReliable !== false) === (item.occurrenceReliable !== false);
    if (previous && sameReliability && Number(item.start) <= Number(previous.end) + 60000) {
      const previousEnd = Number(previous.end);
      const itemEnd = Number(item.end);
      if (itemEnd > previousEnd) {
        previous.end = itemEnd;
        previous.endKnown = item.endKnown === true;
      } else if (itemEnd === previousEnd) {
        previous.endKnown = previous.endKnown === true && item.endKnown === true;
      }
      previous.drizzleOnly &&= Boolean(item.drizzleOnly);
      previous.occurrenceReliable = previous.occurrenceReliable !== false && item.occurrenceReliable !== false;
      previous.peakIntensity = Math.max(Number(previous.peakIntensity) || 0, Number(item.peakIntensity) || 0);
      previous.passageRisk = Math.max(Number(previous.passageRisk) || 0, Number(item.passageRisk) || 0);
      previous.firstStep ||= item.firstStep;
    } else merged.push({ ...item });
  }
  return merged;
}

function threeHourRainSignalIgnored(amount) {
  return amount > 0 && amount <= .01 + 1e-9;
}

function threeHourRainPassageAmount(passage, steps, events, referenceTime) {
  const start = Number(passage.start);
  const end = Math.min(Number(passage.end), referenceTime + 3 * 3600000);
  const boundaries = new Set([start, end]);
  for (const step of steps) {
    for (const time of [Number(step.intervalStart), Number(step.intervalEnd)]) {
      if (time > start && time < end) boundaries.add(time);
    }
  }
  const times = [...boundaries].sort((a, b) => a - b);
  return times.slice(0, -1).reduce((total, left, index) => {
    const right = times[index + 1];
    const base = Math.max(0, ...steps.filter(step => step.intervalStart <= left && step.intervalEnd >= right)
      .map(step => Math.max(0, Number(step.radarAdjustedPrecipitation ?? step.totalPrecipitation) || 0)
        * (right - left) / (step.intervalEnd - step.intervalStart)));
    // Les projections et PIAF décrivent la même pluie : ne pas les additionner.
    return total + Math.max(base, nowcastEtaRainAmount(events, left, right, referenceTime));
  }, 0);
}

function threeHourRainMessageSequence(steps, now, events = []) {
  const referenceTime = Number(now);
  if (!Number.isFinite(referenceTime)) return [];
  const horizonEnd = referenceTime + 3 * 3600000;
  const timeline = [...(steps || [])]
    .filter(step => Number.isFinite(Number(step?.intervalStart))
      && Number.isFinite(Number(step?.intervalEnd))
      && Number(step.intervalEnd) > Number(step.intervalStart))
    .sort((left, right) => Number(left.intervalStart) - Number(right.intervalStart))
    .map(step => threeHourRainSignalIgnored(Number(step.totalPrecipitation))
      ? { ...step, radarAdjustedPrecipitation: 0, totalPrecipitation: 0, etaPrecipitation: 0, dryStateReliable: false }
      : step);
  const passages = [];
  let passage = null;
  for (const step of timeline) {
    const nonEtaAmount = Number(step.radarAdjustedPrecipitation);
    const amount = Number.isFinite(nonEtaAmount)
      ? Math.max(0, nonEtaAmount)
      : Math.max(0, Number(step.totalPrecipitation) || 0);
    if (amount < possibleDrizzleThreshold) {
      const dryStart = Number(step.intervalStart);
      if (passage && passage.occurrenceReliable !== false && step.dryStateReliable !== false
        && Number.isFinite(dryStart) && dryStart <= passage.end + 60000) passage.endKnown = true;
      passage = null;
      continue;
    }
    const start = Number(step.intervalStart);
    const end = Number(step.intervalEnd);
    const occurrenceReliable = step.rainOccurrenceReliable !== false;
    if (!passage || start > passage.end + 60000
      || passage.occurrenceReliable !== occurrenceReliable) {
      passage = {
        start,
        end,
        firstStep: step,
        drizzleOnly: amount < .2,
        peakIntensity: rainRateFromAccumulation(amount, end - start),
        occurrenceReliable,
        endKnown: false
      };
      passages.push(passage);
      continue;
    }
    passage.end = Math.max(passage.end, end);
    passage.drizzleOnly &&= amount < .2;
    passage.peakIntensity = Math.max(passage.peakIntensity, rainRateFromAccumulation(amount, end - start));
  }
  const recentEtaPassages = (events || []).filter(event =>
    nowcastEtaRainEligible(event, referenceTime)
    && Number(event.eventEnd) > referenceTime
    && Number(event.eventStart) < horizonEnd
    && !threeHourRainSignalIgnored(
      nowcastEtaRainAmount([event], Math.max(referenceTime, Number(event.eventStart)), Math.min(horizonEnd, Number(event.eventEnd)), referenceTime))
  ).map(event => {
    const profilePeak = Math.max(0, ...(event.intensityProfile || []).map(segment => Number(segment.intensity) || 0));
    const peakIntensity = Math.max(profilePeak, Number(event.conditionalIntensity) || 0);
    return {
      start: Number(event.eventStart),
      end: Number(event.eventEnd),
      firstStep: null,
      drizzleOnly: peakIntensity < 2.4,
      peakIntensity,
      passageRisk: Number(event.passage) || 0,
      occurrenceReliable: true,
      endKnown: true
    };
  });
  const timelinePassages = passages.flatMap(item => item.occurrenceReliable === false
    ? rainPassageFragmentsOutside(item, recentEtaPassages)
    : [item]);
  const currentPassages = mergeThreeHourRainPassages([...timelinePassages, ...recentEtaPassages])
    .filter(item => item.end > referenceTime && item.start < horizonEnd)
    .map(item => ({ ...item, amount: threeHourRainPassageAmount(item, timeline, events, referenceTime) }))
    .filter(item => item.amount > 0);
  return currentPassages.map(item => {
    const observedAtPoint = item.firstStep?.radarCellOverPoint === true;
    const state = item.start <= referenceTime && (item.occurrenceReliable !== false || observedAtPoint) ? "active" : "future";
    const rawDurationMinutes = Math.max(1, (item.end - item.start) / 60000);
    const durationMinutes = Math.max(5, Math.round(rawDurationMinutes / 5) * 5);
    const subject = item.drizzleOnly ? "Pluie faible" : rainIntensityLabel(rainIntensityStep(item.peakIntensity));
    const passageRisk = Number.isFinite(Number(item.passageRisk)) && Number(item.passageRisk) > 0
      ? Number(item.passageRisk)
      : rainPassageForStep(item.firstStep, events, possibleDrizzleThreshold);
    let label;
    let detail = "";
    if (state === "active") {
      const remainingMinutes = Math.max(5, Math.round((item.end - referenceTime) / 300000) * 5);
      label = subject;
      if (item.endKnown === true) detail = "Encore " + compactMinutesLabel(remainingMinutes);
    } else {
      const etaMinutes = Math.max(1, Math.ceil((item.start - referenceTime) / 60000));
      label = item.occurrenceReliable === false
        ? subject + (item.firstStep?.piafUnconfirmed ? " possible" : shortTermRiskQualifier(passageRisk))
        : subject
          + (passageRisk == null ? "" : shortTermRiskQualifier(passageRisk))
          + " dans " + compactMinutesLabel(etaMinutes);
      if (item.occurrenceReliable !== false && item.endKnown === true) detail = "Durée " + compactMinutesLabel(durationMinutes);
    }
    return {
      key: [item.start, item.end, Math.round(item.peakIntensity * 10), state].join(":"),
      state,
      occurrenceReliable: item.occurrenceReliable !== false,
      observedAtPoint,
      amount: item.amount,
      passageRisk,
      label,
      detail
    };
  });
}

function piafQuarterHourRain(piaf, radar = null) {
  const runTime = piafRunTime(piaf);
  const fiveMinutes = 5 * 60000;
  const quarterHour = 15 * 60000;
  const buckets = new Map();
  for (const item of piafRainSteps(piaf, radar)) {
    const endTime = piafItemEndTime(piaf, item);
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
      seconds: Number.isFinite(runTime) ? (intervalEnd - runTime) / 1000 : Number(items.at(-1).seconds),
      baseRainSource: piaf?.source || "piaf",
      precipitation: sum("precipitation"),
      piafUnconfirmed: items.some(item => item.basePrecipitation > 0)
        && items.filter(item => item.basePrecipitation > 0).every(item => item.piafUnconfirmed),
      nowcastPrecipitation: sum("totalPrecipitation"),
      radarPrecipitation: has("radarPrecipitation") ? sum("radarPrecipitation") : undefined,
      radarAdjustedPrecipitation: sum("radarAdjustedPrecipitation"),
      etaPrecipitation: sum("etaPrecipitation"),
      effectiveRadarAmendment: sum("effectiveRadarAmendment"),
      effectiveEtaAmendment: sum("effectiveEtaAmendment"),
      totalPrecipitation: sum("totalPrecipitation"),
      radarCellOverPoint: items.some(item => item.radarCellOverPoint),
      probability: has("probability") ? Math.max(...items.filter(item => Number.isFinite(Number(item.probability))).map(item => Number(item.probability))) : null,
      intervalStart,
      intervalEnd,
      complete
    };
  });
}

function piafHourlyRain(piaf, radar = null) {
  const fiveMinutes = 5 * 60000;
  const hour = 60 * 60000;
  const etaEvents = nowcastEtaRainEvents(radar);
  const buckets = new Map();
  for (const item of piafRainSteps(piaf, radar, piaf?.values || [], etaEvents)) {
    const endTime = item.intervalEnd;
    if (!Number.isFinite(endTime)) continue;
    // Un pas terminé exactement à H:00 appartient à l'heure précédente.
    const hourStart = Math.floor((endTime - 1) / hour) * hour;
    if (!buckets.has(hourStart)) buckets.set(hourStart, []);
    buckets.get(hourStart).push({ ...item, endTime });
  }
  return new Map([...buckets.entries()].sort(([left], [right]) => left - right).map(([hourStart, items]) => {
    items.sort((left, right) => left.endTime - right.endTime);
    const intervalStart = items[0].endTime - fiveMinutes;
    const intervalEnd = items.at(-1).endTime;
    const basePiaf = Math.round(items.reduce((total, item) => total + item.basePrecipitation, 0) * 100) / 100;
    const directRadarAmendment = Math.round(items.reduce((total, item) => total + item.effectiveRadarAmendment, 0) * 100) / 100;
    const etaAmendment = Math.round(items.reduce((total, item) => total + item.effectiveEtaAmendment, 0) * 100) / 100;
    const totalRain = Math.round(items.reduce((total, item) => total + item.totalPrecipitation, 0) * 100) / 100;
    const hourEvents = etaEvents.filter(event => nowcastEtaRainEligible(event, appNow())
      && event.eventEnd > hourStart && event.eventStart < hourStart + hour);
    const nowcastAmendment = Math.round((directRadarAmendment + etaAmendment) * 100) / 100;
    const etaPassage = hourEvents.length ? Math.max(...hourEvents.map(event => Number(event.passage) || 0)) : null;
    const radarCellOverPoint = items.some(item => item.radarCellOverPoint);
    return [hourStart, {
      rain: totalRain,
      rainBasePiaf: basePiaf,
      rainNowcastAmendment: nowcastAmendment,
      rainDirectRadarAmendment: directRadarAmendment,
      rainEtaAmendment: etaAmendment,
      rainEtaCellIds: hourEvents.map(event => event.cell.id),
      rainEtaPassage: etaPassage,
      rainShortTerm: true,
      rainSource: nowcastAmendment > 0 ? "Météo-France + Nowcasting" : "Météo-France",
      rainIntervalStart: intervalStart,
      rainIntervalEnd: intervalEnd,
      rainDurationMinutes: Math.round((intervalEnd - intervalStart) / 60000),
      rainRadarCellOverPoint: radarCellOverPoint
    }];
  }));
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

function polarimetricHailRisk(cell) {
  const value = cell?.risks?.hail;
  if (cell?.polarimetry?.classification === "insufficient"
    || cell?.polarimetry?.scoreBasis !== "fraction-of-compatible-strong-pixels"
    || value == null || value === "" || !Number.isFinite(Number(value))) return null;
  return Math.max(0, Math.min(100, Math.round(Number(value))));
}

function polarimetricHailLabel(cell, reliableEvent = null) {
  const score = polarimetricHailRisk(cell);
  if (score != null) {
    const passage = reliableEvent?.projectionReliable === true ? Math.round(Number(reliableEvent.passage) || 0) : 0;
    const etaMinutes = reliableEvent?.etaMinutes == null ? null : Number(reliableEvent.etaMinutes);
    const arrival = cell?.polarimetry?.classification === "hail"
      && passage > 0
      && Number.isFinite(etaMinutes)
      && etaMinutes >= 0
      && etaMinutes <= 180
      ? etaMinutes < 1
        ? " · passage grêle possible en cours · passage " + passage + " %"
        : " · grêle possible dans " + compactMinutesLabel(Math.max(1, etaMinutes)) + " · passage " + passage + " %"
      : "";
    return "indice polarimétrique " + score + " %" + arrival;
  }
  return "non évaluée";
}

function nowcastCellRepresentativeRain(cell, currentPrecipitation = null) {
  const maximum = Math.max(0, Number(cell?.maximum) || 0);
  const mean = Math.max(0, Number(cell?.mean) || 0);
  const representative = mean > 0 ? Math.min(maximum || mean, mean) : maximum;
  const local = Number(currentPrecipitation);
  if (radarCellEdgeDistance(cell) <= .5 && Number.isFinite(local)) {
    const localRepresentative = Math.max(representative, local);
    return maximum > 0 ? Math.min(maximum, localRepresentative) : localRepresentative;
  }
  return representative;
}

function nowcastEvidenceIsFresh(evidenceObservedAt, radarObservedAt, referenceTime = Date.now()) {
  const evidenceTime = Date.parse(evidenceObservedAt || "");
  const radarTime = Date.parse(radarObservedAt || "");
  const currentTime = Number(referenceTime);
  return Number.isFinite(evidenceTime)
    && Number.isFinite(radarTime)
    && Number.isFinite(currentTime)
    && Math.abs(evidenceTime - radarTime) <= 12 * 60000
    && Math.abs(currentTime - radarTime) <= 15 * 60000
    && Math.abs(currentTime - evidenceTime) <= 20 * 60000;
}

function nowcastFlashesNearCell(cell, lightning, radarObservedAt = null, referenceTime = Date.now()) {
  const radarTime = Date.parse(radarObservedAt || "");
  if (!Number.isFinite(radarTime)
    || !nowcastEvidenceIsFresh(lightning?.observedAt, radarObservedAt, referenceTime)) return 0;
  return (lightning?.flashes || []).filter(flash => {
    const temporallyRelevant = nowcastEvidenceIsFresh(flash?.time, radarObservedAt, referenceTime);
    return temporallyRelevant
      && radarCellPointDistance(cell, Number(flash.eastKm || 0), Number(flash.northKm || 0)) <= 8;
  }).length;
}

function nowcastCellHasConvectiveSignal(cell, radarObservedAt, referenceTime = Date.now()) {
  const signal = cell?.signals?.convective;
  return signal?.detected === true
    && String(signal.source || "").trim().length > 0
    && nowcastEvidenceIsFresh(signal.observedAt, radarObservedAt, referenceTime);
}

function nowcastCellHasHailSignal(cell, radarObservedAt, referenceTime = Date.now()) {
  const polar = cell?.polarimetry;
  return nowcastEvidenceIsFresh(polar?.observedAt, radarObservedAt, referenceTime)
    && ((["hail", "mixed"].includes(cell?.polarimetry?.classification) && polarimetricHailRisk(cell) > 0)
      || (polar?.zones || []).some(zone => ["hail", "mixed"].includes(zone.classification)
        && zone.scoreBasis === "fraction-of-compatible-strong-pixels" && Number(zone.score) > 0));
}

function nowcastCellHasIntenseRainSignal(cell, radarObservedAt, referenceTime = Date.now()) {
  return rainIntensityStep(Math.max(0, Number(cell?.maximum) || 0)) >= 4
    && Number(cell?.intenseRainClusterAreaKm2) >= 1
    && nowcastEvidenceIsFresh(radarObservedAt, radarObservedAt, referenceTime);
}

function nowcastCellHasStormEvidence(cell, lightning, radarObservedAt, referenceTime = Date.now()) {
  return nowcastCellHasConvectiveSignal(cell, radarObservedAt, referenceTime)
    || nowcastFlashesNearCell(cell, lightning, radarObservedAt, referenceTime) > 0
    || nowcastCellHasHailSignal(cell, radarObservedAt, referenceTime)
    || nowcastCellHasIntenseRainSignal(cell, radarObservedAt, referenceTime);
}

function nowcastLocalHail(cell, radar, passages, now, local) {
  const polar = cell?.polarimetry;
  const windows = [];
  const unavailable = { hailRisk: null, hailLevel: 0, hailWindows: windows, hailLocalized: false };
  if (!nowcastEvidenceIsFresh(polar?.observedAt, radar?.observedAt, now)) return unavailable;
  const points = (cell.track?.points || []).filter(point => [point.minutes, point.eastKm, point.northKm].every(value => value != null && Number.isFinite(Number(value))));
  const first = points[0], next = points.find(point => Number(point.minutes) > Number(first?.minutes));
  const dt = next ? Number(next.minutes) - Number(first.minutes) : 0;
  const vx = dt ? (Number(next.eastKm) - Number(first.eastKm)) / dt : 0;
  const vy = dt ? (Number(next.northKm) - Number(first.northKm)) / dt : 0;
  const speed2 = vx * vx + vy * vy;
  const origin = Date.parse(polar.observedAt);
  const uncertaintyAt = minutes => {
    const before = [...points].reverse().find(point => Number(point.minutes) <= minutes) || points[0];
    const after = points.find(point => Number(point.minutes) >= minutes) || points.at(-1);
    const width = Number(after?.minutes) - Number(before?.minutes);
    const left = Math.max(0, Number(before?.uncertaintyGrowthKm ?? before?.uncertaintyKm) || 0), right = Math.max(0, Number(after?.uncertaintyGrowthKm ?? after?.uncertaintyKm) || 0);
    return width > 0 ? left + (right - left) * Math.max(0, Math.min(1, (minutes - Number(before.minutes)) / width)) : left;
  };
  const zones = Array.isArray(polar.zones) ? polar.zones : null;
  const positive = zone => ["hail", "mixed"].includes(zone?.classification)
    && zone?.scoreBasis === "fraction-of-compatible-strong-pixels" && Number(zone.score) > 0;
  const add = (start, end, score, passage = 100) => {
    if (end <= now || start >= now + 180 * 60000 || end <= start) return;
    // Un indice radar n'est pas une observation de grêle au sol.
    const risk = Math.max(0, Math.min(100, Number(passage)));
    if (risk > 0) windows.push({ start: Math.max(now, start), end: Math.min(now + 180 * 60000, end), risk, score: Number(score) });
  };
  if (zones) {
    for (const zone of zones.filter(positive)) {
      const x = Number(zone.eastKm), y = Number(zone.northKm), radius = Number(zone.radiusKm);
      if (![x, y, radius].every(Number.isFinite) || radius <= 0) continue;
      const age = (now - origin) / 60000;
      if (local && Math.hypot(x + vx * age, y + vy * age) <= radius) add(now, now + 1, zone.score);
      if (speed2 <= 0) continue;
      const middle = -(x * vx + y * vy) / speed2;
      const closest2 = (x + vx * middle) ** 2 + (y + vy * middle) ** 2;
      for (const event of passages) {
        const left = (Math.max(now, event.eventStart) - origin) / 60000;
        const right = (event.eventEnd - origin) / 60000;
        const uncertainty = Math.max(uncertaintyAt(left), uncertaintyAt(right), ...points
          .filter(point => Number(point.minutes) >= left && Number(point.minutes) <= right)
          .map(point => Math.max(0, Number(point.uncertaintyGrowthKm ?? point.uncertaintyKm) || 0)));
        const projectedRadius = radius + uncertainty;
        if (closest2 > projectedRadius * projectedRadius) continue;
        const half = Math.sqrt((projectedRadius * projectedRadius - closest2) / speed2);
        const start = origin + (middle - half) * 60000, end = origin + (middle + half) * 60000;
        add(Math.max(start, event.eventStart), Math.min(end, event.eventEnd), zone.score,
          event.presenceProbability ?? event.passage ?? cell.risks?.passage ?? 0);
      }
    }
  } else if (positive(polar)) {
    // Anciennes archives : conserver une alerte possible, sans prétendre
    // localiser le noyau de grêle à partir du seul score global.
    if (local) add(now, now + 1, polar.score);
    for (const event of passages) add(event.eventStart, event.eventEnd, polar.score,
      event.presenceProbability ?? event.passage ?? cell.risks?.passage ?? 0);
  }
  const score = Math.max(0, ...windows.map(window => window.score));
  return { hailRisk: windows.length ? Math.max(...windows.map(window => window.risk)) : null,
    hailLevel: score <= 0 ? 0 : score < 20 ? 1 : score < 40 ? 2 : score < 60 ? 3 : score < 80 ? 4 : 5,
    hailWindows: windows, hailLocalized: zones !== null };
}

function nowcastLocalStormHazards(cell, radar, lightning, events, now) {
  const observedAt = Date.parse(radar?.observedAt || "");
  const fresh = nowcastEvidenceIsFresh(radar?.observedAt, radar?.observedAt, now);
  const local = fresh && nowcastCellLocallyObservedInterior(cell, radar);
  const passages = (events || []).filter(event => String(event.cell?.id) === String(cell?.id)
    && nowcastStormEtaSelection([event], [cell.id], now, cell.id).event);
  const profiles = passages.filter(event => nowcastEtaRainEligible(event, now) && event.projectionKind === "profile")
    .flatMap(event => (event.intensityProfile || []).filter(segment => segment.end > now && segment.start < now + 180 * 60000));
  const rain = Math.max(0, local ? Number(radar.currentPrecipitation) || 0 : 0,
    ...profiles.map(segment => Number(segment.intensity) || 0));
  const points = (cell?.track?.points || []).filter(point => Number.isFinite(Number(point.minutes))
    && Number.isFinite(Number(point.eastKm)) && Number.isFinite(Number(point.northKm)));
  const first = points[0];
  const next = points.find(point => Number(point.minutes) > Number(first?.minutes));
  const elapsed = next ? Number(next.minutes) - Number(first.minutes) : 0;
  const east = elapsed ? (Number(next.eastKm) - Number(first.eastKm)) / elapsed : 0;
  const north = elapsed ? (Number(next.northKm) - Number(first.northKm)) / elapsed : 0;
  // Conserver seulement les éclairs proches du point, ou dont la zone advectée
  // traverse le voisinage de 8 km des Tatins pendant un passage confirmé.
  const flashes = fresh && nowcastEvidenceIsFresh(lightning?.observedAt, radar.observedAt, now)
    ? (lightning.flashes || []).filter(flash => {
      if (!nowcastEvidenceIsFresh(flash.time, radar.observedAt, now)
        || !Number.isFinite(Number(flash.eastKm)) || !Number.isFinite(Number(flash.northKm))
        || radarCellPointDistance(cell, Number(flash.eastKm), Number(flash.northKm)) > 8) return false;
      const x = Number(flash.eastKm), y = Number(flash.northKm);
      if (local && Math.hypot(x, y) <= 8) return true;
      const speed2 = east * east + north * north;
      if (!speed2) return false;
      return passages.some(event => {
        const start = Math.max(0, (Math.max(now, event.eventStart) - observedAt) / 60000);
        const end = Math.min(180, (event.eventEnd - observedAt) / 60000);
        if (end <= start) return false;
        const minutes = Math.max(start, Math.min(end, -(x * east + y * north) / speed2));
        return Math.hypot(x + east * minutes, y + north * minutes) <= 8;
      });
    }).length : 0;
  // Un faible risque ne justifie pas un cumul, mais doit rester signalé.
  const hailPassages = fresh ? (events || []).filter(event => String(event.cell?.id) === String(cell?.id)
    && Number.isFinite(Number(event.eventStart)) && Number.isFinite(Number(event.eventEnd))
    && Number(event.eventEnd) > now && Number(event.eventStart) < now + 180 * 60000
    && Number(event.presenceProbability ?? event.passage ?? cell.risks?.passage) > 0) : [];
  const hail = nowcastLocalHail(cell, radar, hailPassages, now, local);
  const { hailRisk, hailLevel } = hail;
  const rainLevel = rainIntensityStep(rain);
  const lightningLevel = flashes <= 0 ? 0 : flashes === 1 ? 2 : flashes < 5 ? 3 : flashes < 10 ? 4 : 5;
  const level = flashes > 0 || rain >= 30 || hailRisk > 0 ? stormHazardIntensityStep(rainLevel, hailLevel, lightningLevel) : null;
  return { rain, rainLevel, flashes, lightningLevel, ...hail, level };
}

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

function nowcastMapCoverage(cells, radiusKm = 20) {
  const minimum = -radiusKm;
  const maximum = radiusKm;
  const visibleAreaKm2 = radiusKm * radiusKm * 4;
  const areaKm2 = (cells || []).reduce((total, cell) => {
    if (radarCellEdgeDistance(cell) >= radiusKm) return total;
    const shapeRuns = radarCellShapeRuns(cell);
    if (!shapeRuns.length) return total + Math.min(visibleAreaKm2, Math.max(0, Number(cell.areaKm2) || 0));
    return total + shapeRuns.reduce((cellTotal, run) => {
      const west = Math.max(minimum, Number(run.westKm));
      const east = Math.min(maximum, Number(run.eastKm));
      const south = Math.max(minimum, Number(run.southKm));
      const north = Math.min(maximum, Number(run.northKm));
      return cellTotal + Math.max(0, east - west) * Math.max(0, north - south);
    }, 0);
  }, 0);
  return Math.max(0, Math.min(1, areaKm2 / visibleAreaKm2));
}

function nowcastMapIsSaturated(cells) {
  const visibleCells = (cells || []).filter(cell => radarCellEdgeDistance(cell) < 20);
  const coverage = nowcastMapCoverage(visibleCells, 20);
  const coverageThreshold = nowcastMapAutoExpanded ? .2 : .32;
  const crowdedCoverageThreshold = nowcastMapAutoExpanded ? .12 : .18;
  return coverage >= coverageThreshold
    || visibleCells.length >= 4 && coverage >= crowdedCoverageThreshold
    || visibleCells.length >= 6;
}

function nowcastEtaCellOutsideMap(cell, radiusKm = 20) {
  if (cell?.etaMinutes == null) return false;
  const etaMinutes = Number(cell?.etaMinutes);
  const passage = Number(cell?.risks?.passage);
  return Number.isFinite(etaMinutes)
    && etaMinutes >= 0
    && etaMinutes <= 180
    && passage > 0
    && radarCellEdgeDistance(cell) >= radiusKm;
}

function nowcastCellHasEtaProjection(cell) {
  if (cell?.etaMinutes == null) return false;
  const etaMinutes = Number(cell.etaMinutes);
  return Number.isFinite(etaMinutes)
    && etaMinutes >= 0
    && etaMinutes <= 180
    && Array.isArray(cell.track?.points)
    && cell.track.points.length > 1;
}

function nowcastPresenceRainEligible(event, referenceTime = null) {
  return event?.presenceReliable === true
    && nowcastProjectionFresh(event, referenceTime)
    && Number(event?.presenceProbability) >= 55
    && event?.cell?.etaBasis !== "envelope"
    && Number.isFinite(Number(event?.eventStart))
    && Number.isFinite(Number(event?.eventEnd));
}

function sandboxThreeHourSlots(steps, events, candidates, hours, now, intervals) {
  return intervals.filter(interval => Number(interval.intervalEnd) > now).map((interval, index) => {
    // Le quart d’heure courant reste entier jusqu’à sa fin ; seuls les repères visuels sont élargis.
    const start = index === 0 ? Math.floor(Number(interval.intervalStart) / 900000) * 900000 : Number(interval.intervalStart);
    const end = Number(interval.intervalEnd);
    const samples = steps.filter(item => item.intervalStart < end && item.intervalEnd > start);
    // Qualifier le même cumul de quart d'heure que le diagramme en barres.
    // Ne pas supprimer les petits pas de 5 min avant de les additionner.
    const portion = item => Math.max(0, Math.min(end, item.intervalEnd) - Math.max(start, item.intervalStart)) / (item.intervalEnd - item.intervalStart);
    const sum = field => samples.reduce((total, item) => total + Math.max(0, Number(item[field]) || 0) * portion(item), 0);
    const archived = interval.baseRainSource === "radar-archive" || samples.some(item => item.baseRainSource === "radar-archive");
    const base = archived ? 0 : Math.max(0, Number(interval.precipitation ?? sum("basePrecipitation")) || 0);
    const active = events.filter(event => nowcastEtaRainEligible(event, now)
      && event.eventStart < end && event.eventEnd > start
      && nowcastEtaRainAmount([event], Math.max(start, event.eventStart), Math.min(end, event.eventEnd), now) > 0);
    const etaAmount = nowcastEtaRainAmount(active, start, end, now);
    const total = Math.max(Number(interval.totalPrecipitation) || 0, sum("totalPrecipitation"), active.length ? etaAmount : 0, base);
    const nowcast = archived || Number(interval.effectiveRadarAmendment) > 0 || Number(interval.effectiveEtaAmendment) > 0
      || sum("effectiveRadarAmendment") > 0 || sum("effectiveEtaAmendment") > 0
      || Number(interval.radarPrecipitation) > 0 || interval.radarCellOverPoint === true
      || samples.some(item => Number(item.radarPrecipitation) > 0 || item.radarCellOverPoint === true)
      || active.length > 0;
    const corroborated = base > 0 && nowcast;
    const wet = total > .01 + 1e-9;
    const peak = wet ? Math.max(rainRateFromAccumulation(total, end - start),
      ...samples.map(item => rainRateFromAccumulation(Number(item.totalPrecipitation) || 0, item.intervalEnd - item.intervalStart)),
      ...active.map(event => Number(event.conditionalIntensity) || 0)) : 0;
    const level = peak > 0 ? Math.max(1, rainIntensityStep(peak)) : 0;
    const piafUnconfirmed = interval.piafUnconfirmed === true
      || (samples.some(item => item.basePrecipitation > 0)
        && samples.filter(item => item.basePrecipitation > 0).every(item => item.piafUnconfirmed === true));
    const qualifier = wet && ((nowcast && !corroborated) || piafUnconfirmed) ? "possible" : "";
    // Comme sur main, une présence observée au point vaut ETA 0 min.
    // Sans projection de durée, elle ne couvre que le créneau courant.
    const storms = candidates.filter(candidate => {
      const event = nowcastStormEtaSelection(events, [candidate.cell.id], now, candidate.cell.id).event;
      return (candidate.locallyObserved && start <= now && now < end)
        || (event && Number(event.eventStart) < end && Number(event.eventEnd) > start);
    });
    const storm = storms.sort((a, b) => b.level - a.level || b.passage - a.passage)[0];
    const hailCandidates = candidates.flatMap(candidate => {
      if (!Array.isArray(candidate.hailWindows)) return candidate === storm && Number(candidate.hailRisk) > 0
        ? [{ candidate, risk: candidate.hailRisk }] : [];
      return candidate.hailWindows.filter(window => window.start < end && window.end > start)
        .map(window => ({ candidate, risk: window.risk, score: window.score }));
    }).sort((a, b) => b.risk - a.risk || (b.score || 0) - (a.score || 0));
    const hailSource = hailCandidates[0];
    const hail = Boolean(hailSource);
    const windHours = hours.filter(hour => Date.parse(hour.time) < end && Date.parse(hour.time) + 3600000 > start);
    const wind = windHours.length ? shortTermWindIntensityLevel(
      Math.max(...windHours.map(hour => Number(hour.windSpeed) || 0)),
      Math.max(...windHours.map(hour => Number(hour.windGust) || 0))) : null;
    const cloudValues = windHours.flatMap(hour => {
      const value = hour.cloudCover ?? hour.cloudiness;
      return value == null ? [] : [Number(value)];
    }).filter(Number.isFinite);
    const cloudCover = cloudValues.length ? cloudValues.reduce((sum, value) => sum + value, 0) / cloudValues.length : null;
    const windSpeed = windHours.length ? Math.max(...windHours.map(hour => Number(hour.windSpeed) || 0)) : null;
    const windGust = windHours.length ? Math.max(...windHours.map(hour => Number(hour.windGust) || 0)) : null;
    const night = typeof isNight === "function" ? isNight(new Date((start + end) / 2)) : false;
    return { start, end, slotTime: interval.slotTime, total, level, qualifier, hail, storm, wind, windSpeed, windGust, cloudCover, night, hailRisk: hailSource?.risk, hailLocalized: hailSource?.candidate.hailLocalized, hailScore: hailSource?.score,
      label: hail ? "Grêle" : level ? (peak < .5 ? "Gouttes" : rainIntensityLabel(level)) : samples.length ? "" : "Indisponible" };
  });
}

function selectOngoingStorm(candidates, events, now) {
  return candidates.filter(candidate => candidate.locallyObserved
    && !nowcastStormEtaSelection(events, [candidate.cell.id], now, candidate.cell.id).event)
    .sort((a, b) => b.level - a.level || b.passage - a.passage)[0] || null;
}

function computeRadarNowcast(data) {
  const { radar, piaf, lightning, vigilance } = data;
  const arome = data.arome || (window.METEO_REPLAY ? data.openMeteo : null);
  if (!radar) return null;
  const threeHours = (piaf?.values || []).filter(item => item.seconds <= 3 * 3600);
  const etaRainEvents = nowcastEtaRainEvents(radar);
  const threeHourRainSteps = piafRainSteps(piaf, radar, threeHours, etaRainEvents);
  const piafRainAmount = Math.round(threeHourRainSteps.reduce((sum, item) => sum + item.basePrecipitation, 0) * 10) / 10;
  const directRadarRainAmendment = Math.round(threeHourRainSteps.reduce((sum, item) => sum + item.effectiveRadarAmendment, 0) * 10) / 10;
  const etaRainAmendment = Math.round(threeHourRainSteps.reduce((sum, item) => sum + item.effectiveEtaAmendment, 0) * 10) / 10;
  const nowcastRainAmendment = Math.round((directRadarRainAmendment + etaRainAmendment) * 10) / 10;
  const rainAmount = Math.round(threeHourRainSteps.reduce((sum, item) => sum + item.totalPrecipitation, 0) * 10) / 10;
  const upcomingWind = (arome?.hours || []).filter(item => {
    const time = new Date(item.time).getTime();
    return Number.isFinite(time) && time >= now - 30 * 60000 && time <= now + 3 * 3600000;
  });
  const windWindow = upcomingWind.length ? upcomingWind : (arome?.hours || []).slice(0, 3);
  const maximumWind = Math.round(Math.max(0, ...windWindow.map(item => Number(item.windSpeed) || 0)));
  const maximumGust = Math.round(Math.max(0, ...windWindow.map(item => Number(item.windGust) || 0)));
  const openMeteoWindHours = latestForecastData?.openMeteo?.hours || [];
  const upcomingOpenMeteoWind = openMeteoWindHours.filter(item => {
    const time = new Date(item.time).getTime();
    return Number.isFinite(time) && time >= now - 30 * 60000 && time <= now + 3 * 3600000;
  });
  const openMeteoWindWindow = upcomingOpenMeteoWind.length ? upcomingOpenMeteoWind : openMeteoWindHours.slice(0, 3);
  const maximumOpenMeteoWind = openMeteoWindWindow.length
    ? Math.round(Math.max(0, ...openMeteoWindWindow.map(item => Number(item.windSpeed) || 0)))
    : null;
  const maximumOpenMeteoGust = openMeteoWindWindow.length
    ? Math.round(Math.max(0, ...openMeteoWindWindow.map(item => Number(item.windGust) || 0)))
    : null;
  const openMeteoWindBackgroundTrend = backgroundTrendArrow(openMeteoWindWindow.map(item => item.windSpeed), 5);
  const openMeteoGustBackgroundTrend = backgroundTrendArrow(openMeteoWindWindow.map(item => item.windGust), 8);
  const meteoFranceWindBackgroundTrend = backgroundTrendArrow(windWindow.map(item => item.windSpeed), 5);
  const meteoFranceGustBackgroundTrend = backgroundTrendArrow(windWindow.map(item => item.windGust), 8);
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
  // Synthèse pluie : l'intensité fixe le plafond, puis la probabilité module
  // ce niveau sans jamais transformer une pluie très faible en signal fort.
  const rainSynthesisStep = (probability, intensity) => {
    const intensityLevel = rainIntensityStep(intensity);
    const probabilityValue = Math.max(0, Math.min(100, Number(probability) || 0));
    if (!intensityLevel || !probabilityValue) return 0;
    return Math.max(1, Math.min(5, Math.ceil(intensityLevel * (0.5 + probabilityValue / 200))));
  };
  const latestDataTime = radar.observedAt ? hourFormat.format(new Date(radar.observedAt)) : "—";
  const threat = radar.threat;
  const cells = (radar.cells || []).map((cell, index) => ({ ...cell, id: cell.id || String.fromCharCode(65 + index) }));
  // La distance utile est celle du bord le plus proche, pas celle du centre.
  const cellDistance = radarCellEdgeDistance;
  const nearbyCells = cells.filter(cell => cellDistance(cell) < 60 || nowcastCellHasEtaProjection(cell));
  const nearbyCellIds = new Set(nearbyCells.map(cell => cell.id));
  const stormCandidateCells = nearbyCells.filter(cell =>
    nowcastCellHasStormEvidence(cell, lightning, radar.observedAt, now)
  );
  const reliablePassageEventForCell = cell => nowcastReliablePassageEventForCell(etaRainEvents, cell, now);
  const announcedPassageRiskForCell = cell => nowcastAnnouncedCellPassageRisk(
    cell,
    reliablePassageEventForCell(cell),
    radar
  );
  const announcedStormPassageRisks = stormCandidateCells
    .map(announcedPassageRiskForCell)
    .filter(Number.isFinite);
  const hasAnnouncedStormPassageRisk = announcedStormPassageRisks.length > 0;
  const maximumPassageRisk = hasAnnouncedStormPassageRisk ? Math.max(...announcedStormPassageRisks) : 0;
  const vigilanceNow = appNow();
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
  // Une valeur de passage n'est affichée et ne pilote les points qu'après
  // confirmation de la trajectoire sur plusieurs scans.
  const rawStormPassageLevel = probabilityStep(maximumPassageRisk);
  const currentObservation = new Date(radar.observedAt || 0).getTime();
  const previousObservation = new Date(cellPassageSnapshot?.observedAt || 0).getTime();
  const previousPassageSnapshot = cellPassageSnapshot?.announced === true
    && radar.observedAt !== cellPassageSnapshot.observedAt
    && Number.isFinite(currentObservation)
    && Number.isFinite(previousObservation)
    && currentObservation > previousObservation
    && currentObservation - previousObservation <= 45 * 60000
      ? cellPassageSnapshot
      : null;
  const sameObservationSnapshot = cellPassageSnapshot?.announced === true
    && radar.observedAt === cellPassageSnapshot.observedAt
      ? cellPassageSnapshot
      : null;
  const passageTrendFor = cell => {
    let trend = null;
    if (!trend && previousPassageSnapshot && Object.prototype.hasOwnProperty.call(previousPassageSnapshot.values, cell?.id)) {
      const previous = Number(previousPassageSnapshot.values[cell.id]);
      const current = announcedPassageRiskForCell(cell);
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
  const riskTone = value => value >= 60 ? "high" : value >= 30 ? "medium" : value > 0 ? "low" : "none";
  const flashesNearCell = cell => nowcastFlashesNearCell(cell, lightning, radar.observedAt, now);
  const lightningIntensityStep = flashes => flashes <= 0 ? 0 : flashes === 1 ? 2 : flashes < 5 ? 3 : flashes < 10 ? 4 : 5;
  const localStormHazards = new Map();
  const localHazardsFor = cell => {
    if (!localStormHazards.has(cell.id)) localStormHazards.set(cell.id, nowcastLocalStormHazards(cell, radar, lightning, etaRainEvents, now));
    return localStormHazards.get(cell.id);
  };
  const localProjectedRainFor = cell => localHazardsFor(cell).rain;
  const stormIntensityFor = cell => ({ cell, passage: Math.round(Number(cell.risks?.passage) || 0),
    intenseRainRisk: null, ...localHazardsFor(cell) });
  // La cellule retenue porte l'indicateur unique risque + intensité. À
  // probabilité égale, la cellule la plus intense est prioritaire.
  const passageCandidates = stormCandidateCells
    .filter(cell => Number(cell.risks?.passage) > 0)
    .map(cell => stormIntensityFor(cell))
    .filter(candidate => candidate.level != null)
    .sort((left, right) => right.passage - left.passage || right.level - left.level || cellDistance(left.cell) - cellDistance(right.cell));
  const relevantStormIntensity = passageCandidates[0] || null;
  const relevantStormCell = relevantStormIntensity?.cell || null;
  const temporalPassageCandidates = passageCandidates.filter(candidate => !nowcastCellPostContactDeparture(candidate.cell, radar.observedAt));
  const relevantTemporalStormIntensity = temporalPassageCandidates[0] || null;
  const relevantTemporalStormCell = relevantTemporalStormIntensity?.cell || null;
  const departingStormIntensity = passageCandidates.find(candidate => nowcastCellPostContactDeparture(candidate.cell, radar.observedAt)) || null;
  const twentyKmSaturated = nowcastMapIsSaturated(cells);
  const etaTargetOutsideTwentyKm = temporalPassageCandidates
    .some(candidate => nowcastEtaCellOutsideMap(candidate.cell, 20));
  const recommendedMapRadius = twentyKmSaturated || etaTargetOutsideTwentyKm ? 60 : cells.some(cell => cellDistance(cell) < 20) ? 20 : 60;
  const nowcastStormPassageLevel = rawStormPassageLevel;
  const stormPassageLevel = Math.max(nowcastStormPassageLevel, stormForecastSourceCount, orangeVigilanceActive ? 1 : 0);
  const stormIntensityLevel = relevantStormIntensity?.level || 0;
  const temporalStormIntensityLevel = relevantTemporalStormIntensity?.level || 0;
  const stormCombinedLevel = stormRiskIntensityStep(stormPassageLevel, stormIntensityLevel);
  const previousDisplayedLevelSnapshot = cellPassageSnapshot?.announced === true
    && Number.isFinite(currentObservation)
    && Number.isFinite(previousObservation)
    && (currentObservation > previousObservation
      || (currentObservation === previousObservation
        && Number(cellPassageSnapshot.displayedLevel) !== stormCombinedLevel))
    && currentObservation - previousObservation <= 45 * 60000
      ? cellPassageSnapshot
      : null;
  const rainTrendSteps = threeHourRainSteps.map(item => ({
    seconds: item.seconds,
    precipitation: item.totalPrecipitation,
    etaRain: item.effectiveEtaAmendment
  }));
  const rainTrendUsesEta = rainTrendSteps.slice(0, 12).some(item => item.etaRain > 0);
  const rainTrendUsesRadar = threeHours.slice(0, 12).some(item => item.radarCellOverPoint);
  const rainTrendSource = rainTrendUsesEta
    ? "PIAF + Nowcasting"
    : rainTrendUsesRadar ? "PIAF amendé par le radar" : "PIAF";
  const rainTrend = shortTermRainTrend(rainTrendSteps, rainTrendSource);
  const windTrendWindow = splitForecastWindow(windWindow, item => shortTermWindIntensityLevel(item.windSpeed, item.windGust));
  const windTrend = forecastTrend(windTrendWindow.start, windTrendWindow.end, .4);
  const snapshotPassages = previousPassageSnapshot
    ? Object.entries(previousPassageSnapshot.values || {})
        .filter(([id]) => nearbyCellIds.has(id))
        .map(([, value]) => Number(value))
        .filter(Number.isFinite)
    : [];
  const previousMaximumPassageRisk = snapshotPassages.length ? Math.max(0, ...snapshotPassages) : maximumPassageRisk;
  const maximumPassageChange = Math.round(maximumPassageRisk - previousMaximumPassageRisk);
  const previousRawStormPassageLevel = probabilityStep(previousMaximumPassageRisk);
  const previousNowcastStormPassageLevel = previousRawStormPassageLevel;
  const savedStormPassageLevel = Number(previousDisplayedLevelSnapshot?.displayedLevel);
  const previousStormPassageLevel = Number.isFinite(savedStormPassageLevel)
    ? savedStormPassageLevel
    : Math.max(previousNowcastStormPassageLevel, stormForecastSourceCount, orangeVigilanceActive ? 1 : 0);
  const stormPassageLevelChange = stormCombinedLevel - previousStormPassageLevel;
  const stormTrendUsesDisplayedLevel = stormPassageLevelChange !== 0;
  const stormTrendChange = stormTrendUsesDisplayedLevel ? stormPassageLevelChange : maximumPassageChange;
  const passageMotionTrend = relevantStormCell ? passageTrendFor(relevantStormCell) : null;
  const probabilityStormTrend = {
    label: stormTrendChange > 0 ? "croissant" : stormTrendChange < 0 ? "decroissant" : "stable",
    change: stormTrendChange,
    previous: stormTrendUsesDisplayedLevel ? previousStormPassageLevel : previousMaximumPassageRisk,
    basis: stormTrendUsesDisplayedLevel ? "displayed-level" : "passage-probability"
  };
  const calculatedStormTrend = passageMotionTrend?.label === "decroissant" && probabilityStormTrend.label === "stable"
      ? { ...passageMotionTrend, basis: "cell-trajectory" }
      : probabilityStormTrend;
  const previousPendingDecline = previousPassageSnapshot?.pendingDecline;
  const declineFromCertainPassage = calculatedStormTrend.label === "decroissant"
    && calculatedStormTrend.basis === "passage-probability"
    && previousMaximumPassageRisk >= 100
    && maximumPassageRisk > 0;
  const confirmedPendingDecline = previousPendingDecline
    && maximumPassageRisk > 0
    && maximumPassageRisk <= Number(previousPendingDecline.currentRisk);
  let pendingDecline = null;
  let guardedStormTrend = calculatedStormTrend;
  if (confirmedPendingDecline) {
    const fromRisk = Number(previousPendingDecline.fromRisk);
    guardedStormTrend = {
      label: "decroissant",
      change: maximumPassageRisk - fromRisk,
      previous: fromRisk,
      basis: "passage-probability",
      confirmed: true
    };
  } else if (declineFromCertainPassage) {
    pendingDecline = { fromRisk: previousMaximumPassageRisk, currentRisk: maximumPassageRisk };
    guardedStormTrend = {
      label: "stable",
      change: 0,
      previous: previousMaximumPassageRisk,
      basis: "passage-probability",
      pendingConfirmation: true
    };
  }
  // Plusieurs rendus peuvent avoir lieu entre deux images radar. Conserver la
  // tendance calculée au premier rendu évite qu'une hausse vers 5/5 soit
  // aussitôt comparée à elle-même et remplacée par une flèche horizontale.
  const savedStormTrend = sameObservationSnapshot?.displayedLevel === stormCombinedLevel
    && ["croissant", "decroissant", "stable"].includes(sameObservationSnapshot?.trend?.label)
    && !(sameObservationSnapshot.trend.label === "croissant" && guardedStormTrend.label !== "croissant")
      ? sameObservationSnapshot.trend
      : null;
  const stormTrend = savedStormTrend || guardedStormTrend;
  if (savedStormTrend) pendingDecline = sameObservationSnapshot.pendingDecline || null;
  const nextProjectionSnapshot = nowcastProjectionSnapshot(etaRainEvents);
  const nextProjectionHistory = radar.observedAt
    ? nowcastNextProjectionHistory(cellPassageSnapshot, radar.observedAt, nextProjectionSnapshot)
    : nowcastProjectionHistory(cellPassageSnapshot);
  const projectionSnapshotChanged = JSON.stringify(nextProjectionSnapshot)
    !== JSON.stringify(Array.isArray(cellPassageSnapshot?.projections) ? cellPassageSnapshot.projections : []);
  if (radar.observedAt && (cellPassageSnapshot?.observedAt !== radar.observedAt || projectionSnapshotChanged)) {
    cellPassageSnapshot = {
      observedAt: radar.observedAt,
      announced: true,
      values: Object.fromEntries(cells
        .map(cell => [cell.id, announcedPassageRiskForCell(cell)])
        .filter(([, passage]) => Number.isFinite(passage))),
      projections: nextProjectionSnapshot,
      projectionHistory: nextProjectionHistory,
      displayedLevel: stormCombinedLevel,
      trend: stormTrend,
      pendingDecline
    };
  }
  const rainyCellCandidate = nearbyCells
    .filter(cell => !passageCandidates.some(candidate => String(candidate.cell.id) === String(cell.id))
      && Number(cell.risks?.passage) > 0
      && localProjectedRainFor(cell) >= .1
      && (cellDistance(cell) <= 10
        || (cellDistance(cell) < 60 && Boolean(reliablePassageEventForCell(cell)))))
    .sort((left, right) => Number(right.risks?.passage || 0) - Number(left.risks?.passage || 0) || cellDistance(left) - cellDistance(right))[0] || null;
  const stormDetail = relevantStormIntensity
    ? "Orage sur 3 h · passage " + (hasAnnouncedStormPassageRisk ? maximumPassageRisk + " %" : "incertain") + " · intensité " + stormIntensityLevel + "/5"
      + " · pluie " + relevantStormIntensity.rainLevel + "/5"
      + (relevantStormIntensity.hailRisk == null ? " · grêle non évaluée" : " · grêle " + relevantStormIntensity.hailLevel + "/5")
      + " · foudre " + relevantStormIntensity.lightningLevel + "/5"
    : rainyCellCandidate
      ? "Cellule " + rainyCellCandidate.id + " pluvieuse · aucun signal orageux détecté"
      : stormForecastSourceCount > 0 || orangeVigilanceActive
        ? "Signal orageux prévu dans les 3 prochaines heures"
        : "pas d’orage";
  const stormEtaSelection = nowcastStormEtaSelection(
    etaRainEvents,
    temporalPassageCandidates.map(candidate => candidate.cell.id),
    now,
    relevantTemporalStormCell?.id
  );
  const rainyCellEtaSelection = rainyCellCandidate
    ? nowcastStormEtaSelection(etaRainEvents, [rainyCellCandidate.id], now, rainyCellCandidate.id)
    : null;
  const relevantStormEtaEvent = stormEtaSelection.event;
  const selectedStormCell = relevantStormEtaEvent?.cell || relevantTemporalStormCell;
  const selectedStormIntensity = temporalPassageCandidates.find(candidate =>
    String(candidate.cell?.id) === String(selectedStormCell?.id)
  ) || relevantTemporalStormIntensity;
  const stormLocallyObservedInterior = nowcastCellLocallyObservedInterior(selectedStormCell, radar);
  const relevantStormEtaMinutes = stormEtaSelection.etaMinutes == null
    ? stormLocallyObservedInterior ? 0 : null
    : Number(stormEtaSelection.etaMinutes);
  const relevantStormDurationMinutes = stormEtaSelection.durationMinutes;
  const relevantStormDurationUncertain = stormEtaSelection.durationUncertain === true;
  const relevantStormDurationBeyondHorizon = stormEtaSelection.durationBeyondHorizon === true;
  const hasStormEta = Number.isFinite(relevantStormEtaMinutes) && relevantStormEtaMinutes >= 0 && relevantStormEtaMinutes <= 180;
  const rainyCellEtaEvent = rainyCellEtaSelection?.event || null;
  const selectedRainyCell = rainyCellEtaEvent?.cell || rainyCellCandidate;
  const rainyCellLocallyObservedInterior = nowcastCellLocallyObservedInterior(selectedRainyCell, radar);
  const rainyCellEtaMinutes = rainyCellEtaSelection?.etaMinutes == null
    ? rainyCellLocallyObservedInterior ? 0 : null
    : Number(rainyCellEtaSelection.etaMinutes);
  const hasRainyCellEta = Number.isFinite(rainyCellEtaMinutes) && rainyCellEtaMinutes >= 0 && rainyCellEtaMinutes <= 180;
  const stormOnUncertainBorder = Boolean(selectedStormCell)
    && nowcastUncertainRainBorder(radar, selectedStormCell, stormEtaSelection, relevantStormEtaMinutes);
  const rainyCellOnUncertainBorder = Boolean(selectedRainyCell)
    && nowcastUncertainRainBorder(radar, selectedRainyCell, rainyCellEtaSelection, rainyCellEtaMinutes);
  const localHailAlerts = stormCandidateCells.flatMap(cell => (localHazardsFor(cell).hailWindows || [])
    .map(window => ({ ...window, cell, localized: localHazardsFor(cell).hailLocalized })))
    .sort((a, b) => a.start - b.start || b.risk - a.risk);
  const firstHailAlert = localHailAlerts[0];
  const hailAlertLabel = firstHailAlert ? "Grêle possible" + (firstHailAlert.start > now + 60000
    ? " dans " + compactMinutesLabel((firstHailAlert.start - now) / 60000) : " actuellement")
    + " · passage cellule " + firstHailAlert.risk + " %"
    + (firstHailAlert.localized ? "" : " · noyau non localisé") : "";
  const stormEtaLabel = hailAlertLabel || (relevantTemporalStormIntensity
    ? stormOnUncertainBorder
      ? "Bordure d’orage"
      : shortTermStormLabel(
        hasStormEta ? relevantStormEtaMinutes : null,
        stormEtaSelection.activeCount || Number(stormLocallyObservedInterior),
        selectedStormIntensity.level,
        announcedPassageRiskForCell(selectedStormCell),
        selectedStormIntensity.hailRisk,
        cellDistance(selectedStormCell)
      )
    : departingStormIntensity
      ? shortTermStormLabel(null, 0, departingStormIntensity.level, departingStormIntensity.passage, departingStormIntensity.hailRisk, cellDistance(departingStormIntensity.cell))
    : rainyCellCandidate
      ? rainyCellOnUncertainBorder
        ? "Bordure de cellule pluvieuse"
        : shortTermRainCellLabel(
            hasRainyCellEta ? rainyCellEtaMinutes : null,
            announcedPassageRiskForCell(rainyCellCandidate),
            cellDistance(rainyCellCandidate),
            rainyCellEtaSelection?.activeCount || Number(rainyCellLocallyObservedInterior)
          )
      : stormForecastSourceCount > 0 || orangeVigilanceActive
        ? "Risque d’orage dans les 3 h"
        : "pas d’orage");
  const displayedEtaSelection = relevantTemporalStormIntensity ? stormEtaSelection : rainyCellCandidate ? rainyCellEtaSelection : null;
  const displayedEtaMinutes = relevantTemporalStormIntensity ? relevantStormEtaMinutes : rainyCellEtaMinutes;
  const displayedDurationMinutes = relevantTemporalStormIntensity ? relevantStormDurationMinutes : rainyCellEtaSelection?.durationMinutes;
  const displayedDurationUncertain = relevantTemporalStormIntensity ? relevantStormDurationUncertain : rainyCellEtaSelection?.durationUncertain === true;
  const displayedDurationBeyondHorizon = relevantTemporalStormIntensity ? relevantStormDurationBeyondHorizon : rainyCellEtaSelection?.durationBeyondHorizon === true;
  const displayedOnUncertainBorder = relevantTemporalStormIntensity ? stormOnUncertainBorder : rainyCellOnUncertainBorder;
  const displayedHasEta = relevantTemporalStormIntensity ? hasStormEta : hasRainyCellEta;
  const displayedCell = relevantTemporalStormIntensity ? selectedStormCell : selectedRainyCell;
  const displayedPassageRisk = relevantTemporalStormIntensity
    ? announcedPassageRiskForCell(selectedStormCell)
    : announcedPassageRiskForCell(rainyCellCandidate);
  const displayedActive = Number(displayedEtaSelection?.activeCount) > 0
    || (Number.isFinite(Number(displayedEtaMinutes)) && displayedEtaMinutes != null && displayedEtaMinutes < 1)
    || nowcastCellLocallyObservedInterior(displayedCell, radar);
  const stormDurationLabel = displayedHasEta
    && !displayedDurationUncertain
    && !displayedDurationBeyondHorizon
    && !displayedOnUncertainBorder
    && Number.isFinite(displayedDurationMinutes)
    && displayedDurationMinutes > 0
    ? (displayedActive ? "Encore " : "Durée ")
      + compactMinutesLabel(Math.max(5, Math.round(displayedDurationMinutes / 5) * 5))
    : "";
  const stormEtaDetail = displayedHasEta && displayedCell
      ? "Cellule " + displayedCell.id
      + " · bord à " + cellDistance(displayedCell).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " km"
      + " · passage " + (displayedPassageRisk == null ? "incertain" : Math.round(displayedPassageRisk) + " %")
      + " · " + (displayedActive ? "au point" : "ETA dans " + compactMinutesLabel(Math.max(1, displayedEtaMinutes)))
      + (displayedOnUncertainBorder ? " · bordure radar, durée incertaine" : "")
      + (stormDurationLabel ? " · " + stormDurationLabel.toLowerCase() : "")
    : !relevantTemporalStormIntensity && departingStormIntensity
      ? "Cellule " + departingStormIntensity.cell.id + " · bord à " + cellDistance(departingStormIntensity.cell).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " km"
      : "";
  const stormTrendWording = stormTrend.pendingConfirmation
    ? "stable, éloignement à confirmer"
    : stormTrend.label === "croissant" ? "en hausse" : stormTrend.label === "decroissant" ? "en baisse" : "stable";
  const effectiveStormTrendUsesDisplayedLevel = stormTrend.basis === "displayed-level";
  const effectiveStormTrendUsesTrajectory = stormTrend.basis === "cell-trajectory";
  const effectivePreviousStormValue = Number(stormTrend.previous);
  const effectiveStormTrendChange = Number(stormTrend.change);
  const stormTrendDetail = !hasAnnouncedStormPassageRisk
    ? "Passage incertain · trajectoire à confirmer sur plusieurs scans"
    : effectiveStormTrendUsesDisplayedLevel
    ? "Risque orageux " + stormTrendWording
      + " · indicateur " + effectivePreviousStormValue + " sur 5 → " + stormCombinedLevel + " sur 5"
      + (stormForecastSourceCount > effectivePreviousStormValue && stormCombinedLevel <= 2 ? " · nouveau signal orageux entré dans les 3 prochaines heures" : "")
    : effectiveStormTrendUsesTrajectory
      ? "Trajectoire cellule " + (relevantStormCell?.id || "") + " " + stormTrendWording
        + (Number.isFinite(Number(stormTrend.etaChange)) ? " · ETA " + (Number(stormTrend.etaChange) < 0 ? "rapprochée de " : "repoussée de ") + Math.abs(Math.round(Number(stormTrend.etaChange))) + " min" : "")
        + (Number.isFinite(Number(stormTrend.radialChangeKm)) ? " · distance à +15 min " + (Number(stormTrend.radialChangeKm) < 0 ? "en baisse" : "en hausse") + " de " + Math.abs(Number(stormTrend.radialChangeKm)).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " km" : "")
        + " · passage " + maximumPassageRisk + " %"
    : "Probabilité de passage " + stormTrendWording
      + (Number.isFinite(effectiveStormTrendChange) && effectiveStormTrendChange !== 0 ? " de " + Math.abs(Math.round(effectiveStormTrendChange)) + " point" + (Math.abs(Math.round(effectiveStormTrendChange)) > 1 ? "s" : "") : "")
      + " · maximum global " + effectivePreviousStormValue + " % → " + maximumPassageRisk + " %"
      + (relevantStormCell ? " · cellule actuellement retenue " + relevantStormCell.id : "");
  const upcomingRainSteps = threeHourRainSteps.filter(item =>
    !Number.isFinite(item.intervalEnd) || item.intervalEnd >= now - 60000
  );
  const rainArrival = upcomingRainSteps.find(item => item.totalPrecipitation >= possibleDrizzleThreshold);
  const measurableRainArrival = upcomingRainSteps.find(item => item.totalPrecipitation >= .2);
  const rainPassageRisk = rainPassageForStep(rainArrival, etaRainEvents, possibleDrizzleThreshold);
  const measurableRainPassageRisk = rainPassageForStep(measurableRainArrival, etaRainEvents, .2);
  const radarObservedAt = Date.parse(radar?.observedAt || "");
  const currentRadarRainRate = Number(radar?.currentPrecipitation);
  const freshRadarRainAtTarget = Number.isFinite(radarObservedAt)
    && now >= radarObservedAt - 5 * 60000
    && now - radarObservedAt <= sourceFreshness.radar
    && Number.isFinite(currentRadarRainRate)
    && currentRadarRainRate >= .1;
  const activeEtaRainAtTarget = etaRainEvents.some(event => {
    if (!nowcastEtaRainEligible(event, now)) return false;
    const profile = Array.isArray(event.intensityProfile) ? event.intensityProfile : [];
    if (profile.length) return profile.some(segment => segment.start <= now && segment.end > now && Number(segment.intensity) >= .1);
    return event.eventStart <= now && event.eventEnd > now && Number(event.conditionalIntensity) >= .1;
  });
  const rainEtaMinutes = freshRadarRainAtTarget || activeEtaRainAtTarget
    ? 0
    : rainArrival
    ? Math.max(0, Math.ceil((rainArrival.intervalStart - now) / 60000))
    : null;
  const measurableRainEtaMinutes = measurableRainArrival
    ? Math.max(0, Math.ceil((measurableRainArrival.intervalStart - now) / 60000))
    : null;
  // L'indicateur et la frise doivent raconter la même chose. Un pixel très
  // intense qui ne coupe le point que quelques secondes ne doit plus produire
  // 3/5 tandis que son pas de cinq minutes reste presque nul.
  const projectedPeakRainIntensity = Math.max(0, ...threeHourRainSteps.map(item =>
    rainRateFromAccumulation(item.totalPrecipitation, item.intervalEnd - item.intervalStart)
  ));
  const peakRainIntensity = Math.max(
    projectedPeakRainIntensity,
    freshRadarRainAtTarget ? Math.max(0, currentRadarRainRate) : 0
  );
  const drizzleOnly = onlyDrizzleInThreeHours(threeHourRainSteps);
  const rainArrivalIndex = upcomingRainSteps.indexOf(rainArrival);
  const measurableRainArrivalIndex = upcomingRainSteps.indexOf(measurableRainArrival);
  const dropsThenRain = Boolean(rainArrival
    && rainArrival.totalPrecipitation < .2
    && measurableRainArrival
    && measurableRainArrival.intervalStart > rainArrival.intervalStart
    && rainArrivalIndex >= 0
    && measurableRainArrivalIndex > rainArrivalIndex
    && upcomingRainSteps.slice(rainArrivalIndex, measurableRainArrivalIndex)
      .every(step => Number(step.totalPrecipitation) >= possibleDrizzleThreshold));
  const rainMessageSequence = threeHourRainMessageSequence(threeHourRainSteps, now, etaRainEvents);
  const rainColorLevel = !rainMessageSequence.length || drizzleOnly ? 0 : rainIntensityStep(peakRainIntensity);
  // La couleur signale le pic des 3 h, mais le texte décrit le premier pas
  // qui arrive réellement. Une pluie soutenue prévue plus tard ne doit pas
  // être annoncée comme déjà présente pendant que la frise montre une pluie faible.
  const rainLabelStep = dropsThenRain ? measurableRainArrival : rainArrival;
  const rainLabelStepIntensity = rainLabelStep
    ? rainRateFromAccumulation(rainLabelStep.totalPrecipitation, rainLabelStep.intervalEnd - rainLabelStep.intervalStart)
    : 0;
  const rainLabelIntensity = freshRadarRainAtTarget && rainEtaMinutes < 1 && !dropsThenRain
    ? currentRadarRainRate
    : rainLabelStepIntensity;
  const rainLabelLevel = drizzleOnly ? 0 : rainIntensityStep(rainLabelIntensity);
  const currentRainPhase = rainEtaMinutes < 1
    ? freshRadarRainAtTarget
      ? { drizzle: false, level: rainIntensityStep(currentRadarRainRate) }
      : rainPhaseForStep(rainArrival)
    : null;
  const rainTransition = nextRainPhaseTransition(upcomingRainSteps, now, currentRainPhase);
  const rainTransitionPassageRisk = rainPassageForStep(rainTransition?.step, etaRainEvents, possibleDrizzleThreshold);
  const rainValue = !rainMessageSequence.length
    ? (threeHourRainSteps.length ? "Pas de pluie" : "Prévision indisponible") : rainTransition
    ? shortTermRainTransitionLabel(rainTransition, rainTransitionPassageRisk)
    : dropsThenRain
    ? shortTermRainSequenceLabel(measurableRainEtaMinutes, rainLabelLevel, measurableRainPassageRisk)
    : shortTermRainLabel(
        rainEtaMinutes,
        drizzleOnly || (rainEtaMinutes >= 1 && Number(rainArrival?.totalPrecipitation) < .2),
        rainLabelLevel,
        rainPassageRisk
      );
  const preciseAmount = field => formatRainAmount(threeHourRainSteps.reduce((sum, item) => sum + (Number(item[field]) || 0), 0), 2);
  const rainDetail = "Cumul prévu sur 3 h : " + preciseAmount("totalPrecipitation")
    + " mm · pic d’intensité : " + peakRainIntensity.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " mm/h"
    + "\nTraces de 0,01 mm ou moins ignorées dans la synthèse, quelle que soit leur source."
    + "\nPIAF : " + preciseAmount("basePrecipitation") + " mm (prévision déterministe, sans probabilité propre)"
    + "\nAjout extrapolation radar : " + preciseAmount("effectiveRadarAmendment") + " mm (probabilité non disponible)"
    + "\nAjout cellules suivies : " + preciseAmount("effectiveEtaAmendment") + " mm"
    + (rainMessageSequence.some(message => Number.isFinite(message.passageRisk)) ? "\nProbabilité de passage des cellules : "
      + rainMessageSequence.filter(message => Number.isFinite(message.passageRisk)).map(message => message.passageRisk + " %").join(", ") : "");
  const windDetail = [
    Number.isFinite(maximumOpenMeteoWind) && Number.isFinite(maximumOpenMeteoGust)
      ? "Open-Meteo\nVent moyen : " + maximumOpenMeteoWind + " km/h " + openMeteoWindBackgroundTrend
        + "\nRafales : " + maximumOpenMeteoGust + " km/h " + openMeteoGustBackgroundTrend : "",
    windWindow.length
      ? "Météo-France\nVent moyen : " + maximumWind + " km/h " + meteoFranceWindBackgroundTrend
        + "\nRafales : " + maximumGust + " km/h " + meteoFranceGustBackgroundTrend : ""
  ].filter(Boolean).join("\n");
  const windTrendWithDetail = { ...windTrend, detail: windDetail };
  const windLevel = shortTermWindIntensityLevel(maximumWind, maximumGust);
  const windColorLevel = windLevel >= 3 ? windLevel : 0;
  const windValue = shortTermWindLabel(windLevel);

  return { rainMessageSequence, rainValue, rainColorLevel, rainDetail, rainTrend, stormCombinedLevel, stormDetail, stormTrend, stormTrendDetail, stormEtaLabel, stormDurationLabel, stormEtaDetail, windValue, windLevel, windDetail, windTrendWithDetail, windColorLevel, recommendedMapRadius,
    cellMetrics: cells.map(cell => {
      const reliablePassageEvent = reliablePassageEventForCell(cell);
      const passageRisk = nowcastDisplayedCellPassageRisk(cell, reliablePassageEvent, radar);
      const hailRisk = polarimetricHailRisk(cell);
      const flashes = flashesNearCell(cell);
      const rainRisk = Math.round(Number(cell.risks?.intenseRain) || 0);
      return { id: cell.id, passageRisk, observed: nowcastCellPassageObserved(cell, radar),
        uncertain: cell.passageEnsemble?.status === 'insufficient-observations' && !nowcastCellPassageObserved(cell, radar),
        hailRisk, hailLabel: polarimetricHailLabel(cell, reliablePassageEvent), flashes,
        rainLevel: Number.isFinite(Number(cell.maximum)) ? rainSynthesisStep(rainRisk, nowcastCellRepresentativeRain(cell, radar.currentPrecipitation)) : 0,
        hailLevel: hailRisk == null ? 0 : probabilityStep(hailRisk), lightningLevel: flashCountStep(flashes),
        distanceKm: cellDistance(cell), arrivalAt: nowcastCellPassageObserved(cell, radar) ? now : reliablePassageEvent?.eventStart ?? null,
        localHazards: localHazardsFor(cell) };
    }),
    timelineCandidates: stormCandidateCells.map(cell => ({ ...stormIntensityFor(cell), locallyObserved: nowcastCellLocallyObservedInterior(cell, radar) })).filter(candidate => candidate.level != null && (candidate.hailWindows?.length || candidate.locallyObserved || temporalPassageCandidates.some(item => item.cell.id === candidate.cell.id))),
    upcomingWind,
    etaRainEvents, rainSteps: piafRainSteps(piaf, radar), quarterHourRain: piafQuarterHourRain(piaf, radar), hourlyRain: [...piafHourlyRain(piaf, radar)],
    projectionSnapshot: cellPassageSnapshot ? { ...cellPassageSnapshot, mapAutoExpanded: twentyKmSaturated || etaTargetOutsideTwentyKm } : null
  };
}

return { compute(data) {
  latestForecastData = data;
  const result = computeRadarNowcast(data);
  if (!result) return null;
  result.passageMaps = (data.radar?.cells || []).filter(cell => radarCellEdgeDistance(cell) <= 60).map(cell => ({ id: cell.id, groups: preparePassageMap(cell) }));
  result.schemaVersion = 1;
  result.engineVersion = NOWCAST_ENGINE_VERSION;
  result.generatedAt = now;
  result.validUntil = now + 2 * 60000;
  result.timelineSlots = sandboxThreeHourSlots(result.rainSteps, result.etaRainEvents, result.timelineCandidates, result.upcomingWind, now, result.quarterHourRain);
  const ongoingStorm = selectOngoingStorm(result.timelineCandidates, result.etaRainEvents, now);
  result.ongoingStorm = ongoingStorm ? { ...ongoingStorm, cell: { id: ongoingStorm.cell.id } } : null;
  result.quarterHourRain = result.quarterHourRain.map(item => ({ ...item, cellPassages: result.etaRainEvents
    .filter(event => nowcastPresenceRainEligible(event, now) && event.eventStart < item.intervalEnd && event.eventEnd > item.intervalStart)
    .map(event => ({ id: event.cell.id, passage: Number(event.presenceProbability), etaMinutes: event.etaMinutes,
      etaBasis: event.cell.etaBasis, etaRain: nowcastEtaRainAmount([event], item.intervalStart, item.intervalEnd, now),
      amountReliable: event.projectionReliable === true, eventStart: event.eventStart, eventEnd: event.eventEnd })) }));
  result.etaRainEvents = result.etaRainEvents.map(event => ({ ...event,
    cell: { id: event.cell.id, etaBasis: event.cell.etaBasis },
    rainEligible: nowcastEtaRainEligible(event, now), validUntil: result.validUntil }));
  result.timelineSlots = result.timelineSlots.map(slot => slot.storm
    ? { ...slot, storm: { ...slot.storm, cell: { id: slot.storm.cell.id } } } : slot);
  // These intermediates contain full cells and are not needed by the display.
  delete result.timelineCandidates;
  delete result.upcomingWind;
  return result;
}, nowcastPresenceRainEligible, sandboxThreeHourSlots, nowcastEtaRainEvents, nowcastCellRainProfilePassages, nowcastCellProjectedPassages, nowcastCellContainsPoint, nowcastCellTraversal, nowcastProjectionAssessment, nowcastProjectionProfileSignature, nowcastCellProjectionQuality, nowcastCellPostContactDeparture, nowcastPreviousProjection, nowcastProjectionFingerprint, nowcastPresenceAssessment, nowcastArrivalProjectionQuality, nowcastProjectionHistory, nowcastMedian, piafRainSteps, piafItemEndTime, piafRunTime, nowcastEtaRainAmount, nowcastEtaRainEligible, nowcastProjectionFresh, nowcastEtaRainRateAt, backgroundTrendArrow, rainIntensityStep, radarCellEdgeDistance, radarCellPointDistance, radarCellShapeRuns, nowcastCellHasEtaProjection, nowcastCellHasStormEvidence, nowcastCellHasConvectiveSignal, nowcastEvidenceIsFresh, nowcastFlashesNearCell, nowcastCellHasHailSignal, polarimetricHailRisk, nowcastCellHasIntenseRainSignal, nowcastReliablePassageEventForCell, nowcastAnnouncedCellPassageRisk, nowcastLocalStormHazards, nowcastCellLocallyObservedInterior, nowcastStormEtaSelection, nowcastLocalHail, stormHazardIntensityStep, nowcastMapIsSaturated, nowcastMapCoverage, nowcastEtaCellOutsideMap, stormRiskIntensityStep, shortTermRainTrend, nowcastProjectionSnapshot, nowcastNextProjectionHistory, nowcastUncertainRainBorder, compactMinutesLabel, shortTermStormLabel, shortTermHailQualifier, shortTermRiskQualifier, shortTermRainCellLabel, rainPassageForStep, rainRateFromAccumulation, onlyDrizzleInThreeHours, threeHourRainMessageSequence, threeHourRainSignalIgnored, rainPassageFragmentsOutside, mergeThreeHourRainPassages, threeHourRainPassageAmount, rainIntensityLabel, rainPhaseForStep, nextRainPhaseTransition, rainPhaseRank, shortTermRainTransitionLabel, rainPhaseLabel, shortTermRainSequenceLabel, shortTermRainLabel, formatRainAmount, shortTermWindLabel, nowcastDisplayedCellPassageRisk, nowcastCellPassageObserved, polarimetricHailLabel, nowcastCellRepresentativeRain, piafQuarterHourRain, piafHourlyRain };
}
