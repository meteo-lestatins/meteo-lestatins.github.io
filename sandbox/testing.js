(() => {
  const apiBase = new URL(window.METEO_RUNTIME_CONFIG?.apiBase || "./", document.baseURI);
  const apiUrl = path => new URL(String(path).replace(/^\/+/, ""), apiBase);
  const state = {
    archives: [],
    frames: [],
    frameIndex: 0,
    applyDashboardPayload: null,
    playing: false,
    timer: 0
  };
  const localDateTime = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
  const displayDateTime = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
  const $ = id => document.getElementById(id);
  const currentFrame = () => state.frames[state.frameIndex] || null;
  const currentTime = () => new Date(currentFrame()?.observedAt || Date.now()).getTime();

  async function apiJson(path) {
    const response = await fetch(apiUrl(path), { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Erreur ${response.status}`);
    return data;
  }

  function inputDateTime(timestamp) {
    return localDateTime.format(new Date(timestamp)).replace(" ", "T");
  }

  function piafFromRadar(radar, sequence) {
    const rates = new Map((radar?.values || []).map(item => [Number(item.seconds), Math.max(0, Number(item.precipitation) || 0)]));
    const observedAt = new Date(radar.observedAt);
    const coverageTime = observedAt.toISOString().replaceAll(":", ".");
    return {
      source: "radar-archive",
      fetchedAt: Number(radar.fetchedAt) + sequence + 1,
      coverageId: `ARCHIVE___${coverageTime}_PT5M`,
      values: Array.from({ length: 36 }, (_, index) => {
        const seconds = (index + 1) * 300;
        const precipitation = (rates.get(seconds) || 0) / 12;
        return {
          seconds,
          validTime: new Date(observedAt.getTime() + seconds * 1000).toISOString(),
          precipitation,
          nowcastPrecipitation: precipitation,
          radarPrecipitation: precipitation,
          radarCellOverPoint: Number(radar.currentPrecipitation || 0) >= .05
        };
      })
    };
  }

  function dashboard(frame, sequence = 0) {
    return {
      status: "ready",
      data: {
        radar: frame,
        piaf: piafFromRadar(frame, sequence),
        arome: null,
        pearome: null,
        ensemble: null,
        openMeteo: null,
        lightning: null,
        vigilance: null
      }
    };
  }

  function updateFrameStatus() {
    const frame = currentFrame();
    const slider = $("testing-frame");
    if (slider) {
      slider.max = String(Math.max(0, state.frames.length - 1));
      slider.value = String(state.frameIndex);
      slider.disabled = state.frames.length < 2;
    }
    const time = $("testing-current-time");
    if (time) time.textContent = frame ? displayDateTime.format(new Date(frame.observedAt)) : "Aucune trame";
    const detail = $("testing-frame-state");
    if (detail) {
      const passages = (frame?.cells || []).map(cell => Number(cell.risks?.passage) || 0);
      const maximum = passages.length ? Math.round(Math.max(...passages)) : 0;
      detail.textContent = frame ? `${state.frameIndex + 1}/${state.frames.length} · ${frame.cells?.length || 0} cellule(s) · passage max ${maximum} %` : "";
    }
    const play = $("testing-play");
    if (play) {
      play.textContent = state.playing ? "Ⅱ" : "▶";
      play.setAttribute("aria-label", state.playing ? "Mettre en pause" : "Lire la relecture");
      play.title = state.playing ? "Pause" : "Lecture";
    }
  }

  function renderFrame(index) {
    if (!state.frames.length) return;
    state.frameIndex = Math.max(0, Math.min(state.frames.length - 1, Number(index) || 0));
    updateFrameStatus();
    state.applyDashboardPayload?.(dashboard(currentFrame(), state.frameIndex));
    const nowcast = $("nowcast-details");
    if (nowcast) nowcast.hidden = false;
    $("header-nowcast-link")?.setAttribute("aria-expanded", "true");
    $("nowcast-title-toggle")?.setAttribute("aria-expanded", "true");
  }

  function stopPlayback() {
    state.playing = false;
    clearInterval(state.timer);
    state.timer = 0;
    updateFrameStatus();
  }

  function togglePlayback() {
    if (state.playing) return stopPlayback();
    if (state.frames.length < 2) return;
    if (state.frameIndex >= state.frames.length - 1) renderFrame(0);
    state.playing = true;
    updateFrameStatus();
    state.timer = setInterval(() => {
      if (state.frameIndex >= state.frames.length - 1) return stopPlayback();
      renderFrame(state.frameIndex + 1);
    }, 900);
  }

  function selectedArchive() {
    return state.archives.find(archive => archive.id === $("testing-archive")?.value) || state.archives[0] || null;
  }

  function selectLatestWindow() {
    const archive = selectedArchive();
    if (!archive) return;
    const durationMs = Number($("testing-duration")?.value || 180) * 60000;
    const first = new Date(archive.firstObservedAt).getTime();
    const last = new Date(archive.lastObservedAt).getTime();
    $("testing-from").value = inputDateTime(Math.max(first, last - durationMs));
  }

  async function loadReplay() {
    const archive = selectedArchive();
    const fromValue = $("testing-from")?.value;
    if (!archive || !fromValue) return;
    stopPlayback();
    const button = $("testing-load");
    const status = $("testing-load-state");
    button.disabled = true;
    status.textContent = "Calcul du modèle…";
    try {
      const from = new Date(fromValue).getTime();
      const durationMs = Number($("testing-duration")?.value || 180) * 60000;
      const archiveEnd = new Date(archive.lastObservedAt).getTime();
      const to = Math.min(from + durationMs, archiveEnd);
      const query = new URLSearchParams({
        archive: archive.id,
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString()
      });
      const replay = await apiJson(`api/testing/replay?${query}`);
      state.frames = replay.frames || [];
      state.frameIndex = 0;
      status.textContent = state.frames.length ? `${state.frames.length} trames recalculées · mémoire ${replay.warmupMinutes} min` : "Aucune trame sur ce créneau";
      if (state.frames.length) renderFrame(0);
      else updateFrameStatus();
    } catch (error) {
      state.frames = [];
      updateFrameStatus();
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  async function initializeArchives() {
    const response = await apiJson("api/testing/archives");
    state.archives = response.archives || [];
    const select = $("testing-archive");
    select.innerHTML = state.archives.map(archive => {
      const first = displayDateTime.format(new Date(archive.firstObservedAt));
      const last = displayDateTime.format(new Date(archive.lastObservedAt));
      return `<option value="${archive.id}">${archive.week} · ${first} → ${last}</option>`;
    }).join("");
    if (!state.archives.length) throw new Error("Aucune archive radar disponible.");
    selectLatestWindow();
    await loadReplay();
  }

  function bindController() {
    $("testing-archive")?.addEventListener("change", selectLatestWindow);
    $("testing-duration")?.addEventListener("change", selectLatestWindow);
    $("testing-load")?.addEventListener("click", loadReplay);
    $("testing-frame")?.addEventListener("input", event => {
      stopPlayback();
      renderFrame(event.currentTarget.value);
    });
    $("testing-previous")?.addEventListener("click", () => {
      stopPlayback();
      renderFrame(state.frameIndex - 1);
    });
    $("testing-play")?.addEventListener("click", togglePlayback);
    $("testing-next")?.addEventListener("click", () => {
      stopPlayback();
      renderFrame(state.frameIndex + 1);
    });
  }

  window.METEO_REPLAY = {
    archiveTesting: true,
    aboutBase: "",
    currentTime,
    async request(url) {
      if (/api\/config/.test(url)) return {
        releaseNumber: window.METEO_RUNTIME_CONFIG?.releaseNumber || "",
        latitude: "44.6538",
        longitude: "5.5995",
        news: null
      };
      if (/api\/dashboard/.test(url)) return currentFrame() ? dashboard(currentFrame(), state.frameIndex) : { status: "loading", data: null };
      if (/api\/week/.test(url)) return { status: "error", error: "Source non archivée" };
      throw new Error(`Source non archivée pour testing.html : ${url}`);
    },
    async start({ applyDashboardPayload }) {
      state.applyDashboardPayload = applyDashboardPayload;
      bindController();
      try {
        await initializeArchives();
      } catch (error) {
        $("testing-load-state").textContent = error.message;
      }
    }
  };
})();
