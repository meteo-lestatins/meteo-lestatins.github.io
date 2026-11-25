const HOUR = 3600000;
const snowPhases = ['snow', 'snow-unknown', 'mixed'];
const outdoorStartHour = 7;
const outdoorEndHour = 22;
const dryWindowHours = 4;
const maxPeriods = 3;

const liquidRate = interval => (interval.phase === 'rain' ? interval.rain : interval.liquidRain ?? 0)
  * HOUR / (interval.end - interval.start);

function weatherSpans(day, total) {
  const storms = total.samples.filter(sample => sample.storm === 1);
  const boundaries = [...new Set([day.start, day.end,
    ...total.intervals.flatMap(interval => [interval.start, interval.end]),
    ...storms.flatMap(sample => [sample.stamp, sample.intervalEnd])])]
    .filter(time => time >= day.start && time <= day.end).sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    const interval = total.intervals.find(item => item.start <= start && item.end >= end);
    const storm = storms.some(sample => sample.stamp < end && sample.intervalEnd > start);
    const rate = interval ? liquidRate(interval) : 0;
    return { start, end, phase: interval?.phase ?? 'unknown', storm, rate };
  });
}

function consecutive(spans, valueOf) {
  const runs = [];
  for (const span of spans) {
    const value = valueOf(span);
    const last = runs.at(-1);
    if (last?.value === value) last.end = span.end;
    else runs.push({ start: span.start, end: span.end, value });
  }
  return runs;
}

export function cardPeriods(day, { total, daytime, summarize, at, leadDays, clock, notableGust, describe }) {
  const sunrise = day.sunrise ?? at(6);
  const sunset = day.sunset ?? at(18);
  const earlyMorning = at(outdoorStartHour);
  // A late sunrise keeps the preceding morning hours in the night summary.
  const nightEnd = earlyMorning + Math.max(0, Math.round((sunrise - earlyMorning) / HOUR)) * HOUR;
  const activityEnd = at(outdoorEndHour);
  const evening = at(18);
  const spans = weatherSpans(day, total);
  const dryRuns = consecutive(spans, span => span.phase === 'dry' && !span.storm).filter(run => run.value);
  const firstWeather = spans.find(span => span.phase !== 'dry');
  let start = day.start;
  // Ignore a dry start before people are likely to plan outdoor activities.
  // Very small nocturnal amounts can be skipped when the wet day starts later.
  const morningStart = dryRuns.find(run => run.start <= day.start + HOUR && run.end <= nightEnd);
  if (morningStart && morningStart.end < day.end && spans.some(span => span.start >= morningStart.end && span.phase !== 'dry' && span.phase !== 'unknown')) {
    const prefix = summarize(day.start, morningStart.end);
    const distinctGusts = prefix.windGust >= notableGust && !(daytime.windGust >= notableGust);
    if (prefix.completeRain && prefix.rain < .01 && prefix.storm !== true && !distinctGusts
        && !prefix.intervals.some(interval => snowPhases.includes(interval.phase) || interval.phase === 'freezing')) start = morningStart.end;
  }
  const dryRest = dryRuns.find(run => run.end === day.end);
  if (dryRest?.start > day.start && dryRest.start <= day.start + HOUR && firstWeather?.phase === 'rain') {
    const prefix = summarize(day.start, dryRest.start);
    const distinctGusts = prefix.windGust >= notableGust && !(daytime.windGust >= notableGust);
    if (prefix.completeRain && prefix.rain < .5 && prefix.storm !== true && !distinctGusts) start = dryRest.start;
  }

  // Reserve both sides of a usable dry window. Rank changes by how much they
  // affect the choice of when to go outside, then use at most two boundaries.
  const features = dryRuns.filter(run => {
    const outdoorHours = Math.min(run.end, activityEnd) - Math.max(run.start, nightEnd);
    const preceding = spans.find(span => span.end === run.start);
    const following = spans.find(span => span.start === run.end);
    const lateClearing = run.end === day.end && run.start > evening;
    const usefulHours = lateClearing ? (day.trend ? dryWindowHours : 3) : 2;
    return run.start >= start && run.end - run.start >= dryWindowHours * HOUR && outdoorHours >= usefulHours * HOUR
      && (run.start > start || run.end < day.end) && preceding?.phase !== 'unknown' && following?.phase !== 'unknown';
  }).map(run => ({ times: [run.start, run.end], score: 70 + Math.min(10, (run.end - run.start) / HOUR) }));

  const episodes = consecutive(spans.filter(span => span.end > start), span => {
    if (snowPhases.includes(span.phase)) return 'snow';
    return span.phase === 'rain' && span.rate >= 2 ? 'strong-rain' : span.phase;
  });
  for (let index = 1; index < episodes.length; index++) {
    const previous = episodes[index - 1];
    const current = episodes[index];
    const next = episodes[index + 1];
    if (current.value === 'freezing' || previous.value === 'freezing') {
      features.push({ times: [current.start], score: 100 });
    } else if (current.value === 'strong-rain' && previous.value === 'rain') {
      const preceding = summarize(previous.start, current.start);
      const hours = (current.start - previous.start) / HOUR;
      if (hours >= 1 && (preceding.liquidRain ?? preceding.rain) / hours < .5) {
        features.push({ times: [current.start], score: 68 });
      }
    } else if (current.value === 'snow' || previous.value === 'snow') {
      // A single light rain phase between two snow phases is part of the same
      // mixed episode. Sustained changes of phase deserve a separate slot.
      const alternates = current.value === episodes[index - 2]?.value || previous.value === next?.value;
      if (!['rain', 'strong-rain'].includes(current.value === 'snow' ? previous.value : current.value)) continue;
      const snow = current.value === 'snow' ? current : previous;
      const snowfall = summarize(snow.start, snow.end).snowfall;
      if (snowfall >= (alternates ? 2 : .5) && current.end - current.start >= HOUR && previous.end - previous.start >= HOUR) {
        features.push({ times: [current.start], score: 85 });
      }
    }
  }
  const storms = consecutive(spans, span => span.storm).filter(run => run.value);
  for (const storm of storms) {
    const rainAlreadyStrong = episodes.some(episode => episode.value === 'strong-rain'
      && episode.start < storm.start && episode.end > storm.start);
    if (storm.start > start && !rainAlreadyStrong) features.push({ times: [storm.start], score: 69 });
    const nextStorm = storms.find(run => run.start > storm.end);
    const quietEnd = nextStorm?.start ?? day.end;
    if (storm.end - storm.start >= 2 * HOUR && quietEnd - storm.end >= dryWindowHours * HOUR
      && summarize(storm.end, quietEnd).storm === false) features.push({ times: [storm.end], score: 61 });
  }
  // Show a sustained change in outdoor comfort on a dry day, without
  // subdividing an already meaningful precipitation episode.
  if (total.completeRain && total.phase === 'dry' && total.storm === false) {
    const morning = summarize(nightEnd, at(12));
    const afternoon = summarize(at(12), evening);
    const daylightGusts = (morning.windGust >= notableGust) !== (afternoon.windGust >= notableGust);
    const cloudChange = Number.isFinite(morning.cloudCover) && Number.isFinite(afternoon.cloudCover)
      && Math.abs(morning.cloudCover - afternoon.cloudCover) >= 50;
    if (daylightGusts || cloudChange) features.push({ times: [at(12)], score: 40 });
    const gustsInEvening = summarize(evening, day.end).windGust;
    if (gustsInEvening >= notableGust && gustsInEvening - (daytime.windGust ?? gustsInEvening) >= 20) {
      features.push({ times: [evening], score: 55 });
    }
  }

  // Round changes within the night to one boundary at the start of the day.
  const eligible = features.map(feature => ({ ...feature, times: feature.times
    .filter(time => time > start && time < day.end).map(time => Math.max(time, nightEnd)) }))
    .filter(feature => feature.times.length);
  const cuts = new Set();
  for (const { times } of eligible.sort((a, b) => b.score - a.score || a.times[0] - b.times[0])) {
    const candidate = new Set([...cuts, ...times]);
    if (candidate.size < maxPeriods) for (const time of times) cuts.add(time);
  }
  const boundaries = [start, ...[...cuts].sort((a, b) => a - b), day.end];
  const periods = boundaries.slice(0, -1).map((time, index) => summarize(time, boundaries[index + 1]));
  if (periods.length === 1 && periods[0].phase === 'dry') {
    periods[0] = { ...periods[0], cloudCover: daytime.cloudCover ?? periods[0].cloudCover };
  }

  const stepsAt = time => total.intervals.filter(interval => interval.start <= time && interval.end >= time);
  const precise = time => {
    const steps = stepsAt(time);
    return leadDays < 4 && steps.length > 0 && steps.every(interval =>
      interval.nativeEnd - interval.nativeStart <= HOUR && (leadDays < 2 || !interval.interpolated));
  };
  const hourLabel = time => clock.format(time).replace(':00', ' h').replace(':', ' h ');
  const afternoonPart = time => time < at(15) ? 'début' : time < at(17) ? 'milieu' : 'fin';
  // Keep only changes that are visible on the card, before labeling the remaining boundaries.
  const conditions = [];
  for (const period of periods) {
    const { start, end, rain, phase } = period;
    const night = periods.length > 1 && (end <= nightEnd
      || Math.min(end, sunset) - Math.max(start, sunrise) < Math.min(HOUR, (end - start) / 2));
    const presentation = describe(period, night);
    const key = JSON.stringify(presentation);
    const previous = conditions.at(-1);
    if (previous?.end === start && start < day.end && previous.night === night && previous.key === key) {
      previous.end = end;
      previous.rain += rain;
    } else {
      conditions.push({ start, end, rain, phase, night, presentation, key });
    }
  }
  const labeledConditions = conditions.map(({ start: from, end: to, rain, phase, night, presentation }, index) => {
    let label = '';
    if (conditions.length === 1) return { start: from, label, night, presentation };
    if (to <= nightEnd) label = 'Nuit';
    else if (from >= evening && to === day.end && (!precise(from) || from === evening)) label = 'Soir';
    else if (to === at(12)) label = 'Matin';
    else if (from === at(12) && to === day.end) label = 'Reste de la journée';
    else if (index === 0 && from < at(12) && to > at(13) && to < evening && rain > 0
      && conditions[1].phase === 'dry' && conditions[1].end === day.end && leadDays <= 5
      && clock.format(to).endsWith(':00') && stepsAt(to).every(interval => interval.nativeEnd - interval.nativeStart <= HOUR)) {
      label = `Jusqu’à ${hourLabel(to)}`;
    }
    else if (index === 0 && precise(to) && to < day.end) label = `Avant ${hourLabel(to)}`;
    else if (index > 0 && from <= sunrise + HOUR && to === day.end && !precise(from)) label = 'En journée';
    else if (index > 0 && to === day.end && phase === 'dry') label = 'Reste de la journée';
    else if (index > 0 && precise(from) && to === day.end) label = `Dès ${hourLabel(from)}`;
    else if (index > 0 && from <= sunrise + HOUR && to >= evening && to < day.end) label = 'En journée';
    else if (index > 0 && to < day.end && precise(from) && precise(to)) label = `${hourLabel(from)} – ${hourLabel(to)}`;
    else if (to <= at(13)) label = 'Matin';
    else if (from < at(12) && to < evening) label = `Jusqu’en ${afternoonPart(to)} d’après-midi`;
    else if (to === day.end && from >= at(15)) label = 'Fin de journée';
    else if (to === day.end && from >= at(12)) label = 'Reste de la journée';
    else if (from >= evening) label = 'Soir';
    else if (from >= at(12)) label = to <= evening ? 'Après-midi' : 'Fin de journée';
    else label = 'En journée';
    return { start: from, label, night, presentation };
  });

  // A weather transition may split a broad part of the day when hours are too uncertain to display.
  for (const [label, early, late] of [
    ['Matin', 'Début de matinée', 'Fin de matinée'],
    ['Soir', 'Début de soirée', 'Fin de soirée'],
  ]) {
    const matching = labeledConditions.filter(condition => condition.label === label);
    if (matching.length !== 2) continue;
    matching[0].label = early;
    matching[1].label = late;
  }
  return labeledConditions;
}
