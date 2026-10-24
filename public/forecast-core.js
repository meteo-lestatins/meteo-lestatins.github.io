import { createNowcastEngine, isNightAtLocation } from './nowcast/engine.js';

// PIAF aggregation and forecast messages without computing
// radar trajectories or synthesising radar observations.
export function prepareBasicForecast(data, now = Date.now()) {
  const engine = createNowcastEngine({ now, includePassageMaps: false });
  const piaf = data?.piaf ? { ...data.piaf, values: (data.piaf.values || []).map(({ seconds, precipitation, validTime }) => ({ seconds, precipitation, ...(validTime ? { validTime } : {}) })) } : null;
  const allSteps = engine.piafRainSteps(piaf, null, null, []);
  const steps = allSteps.filter(step => step.intervalEnd > now && step.intervalStart < now + 3 * 3600000);
  const quarters = engine.piafQuarterHourRain(piaf).filter(step => step.intervalEnd > now);
  const hours = [...engine.piafHourlyRain(piaf)].filter(([, step]) => step.rainIntervalEnd > now);
  const wind = (data?.arome?.hours || []).filter(h => {
    const time = new Date(h.time).getTime();
    return time >= now && time <= now + 3 * 3600000;
  });
  const max = field => wind.length ? Math.max(...wind.map(h => Number(h[field]) || 0)) : null;
  const speed = max('windSpeed'), gust = max('windGust');
  const level = (value, thresholds) => value == null ? 0 : thresholds.filter(t => value >= t).length;
  const windLevel = Math.max(level(speed, [0.01, 12, 20, 30, 40]), level(gust, [0.01, 35, 55, 75, 100]));
  const amount = steps.reduce((sum, step) => sum + step.precipitation, 0);
  const storm = wind.some(h => h.stormSignal === true);
  const timelineSlots = engine.sandboxThreeHourSlots(allSteps, [], [], data?.arome?.hours || [], now, quarters).map(slot => ({
    ...slot,
    night: isNightAtLocation(new Date((slot.start + slot.end) / 2), data?.latitude, data?.longitude),
    modelStorm: (data?.arome?.hours || []).some(hour => hour.stormSignal === true
      && new Date(hour.time).getTime() < slot.end && new Date(hour.time).getTime() + 3600000 > slot.start)
  }));
  return {
    schemaVersion: 1, mode: 'forecast', generatedAt: now, validUntil: now + 60000,
    sourceCycleAt: engine.piafRunTime(piaf), sourceFetchedAt: piaf?.fetchedAt || null,
    rainSteps: steps, quarterHourRain: quarters, hourlyRain: hours, etaRainEvents: [], cellMetrics: [],
    timelineSlots, ongoingStorm: null,
    rainMessageSequence: engine.threeHourRainMessageSequence(steps, now, []),
    rainValue: steps.length ? amount > 0 ? `${amount.toFixed(2)} mm` : 'Pas de pluie' : 'Prévision indisponible',
    rainColorLevel: steps.length ? engine.rainIntensityStep(Math.max(0, ...steps.map(s => s.precipitation * 12))) : 0,
    rainDetail: steps.length ? 'PIAF · échéances encore à venir · ' + amount.toFixed(2) + ' mm' : 'PIAF : aucune échéance encore valide.',
    rainTrend: steps.length ? engine.shortTermRainTrend(steps.map(step => ({ ...step, seconds: (step.intervalEnd - now) / 1000 })), 'PIAF') : null,
    stormCombinedLevel: storm ? 1 : 0, stormDetail: storm ? 'Orage possible au point de prévision du site.' : '',
    stormTrend: null, stormTrendDetail: '', stormEtaLabel: '', stormDurationLabel: '', stormEtaDetail: '',
    windValue: speed == null ? 'Indisponible' : `${Math.round(speed)} km/h`, windLevel, windColorLevel: windLevel >= 3 ? windLevel : 0,
    windDetail: speed == null ? 'AROME : aucune échéance disponible sur les trois prochaines heures.' : `AROME · vent maximal ${Math.round(speed)} km/h · rafales ${Math.round(gust)} km/h`,
    windTrendWithDetail: null
  };
}
