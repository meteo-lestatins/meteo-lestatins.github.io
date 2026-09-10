(() => {
  const runtimeConfig = window.METEO_RUNTIME_CONFIG && typeof window.METEO_RUNTIME_CONFIG === "object" ? window.METEO_RUNTIME_CONFIG : {};
  const apiBase = new URL(runtimeConfig.apiBase || "./", document.baseURI);
  const endpoint = new URL("api/analytics", apiBase);
  const storageKey = "meteo_anonymous_visitor";
  const interactionSelectors = [
    ["nowcasting", "#header-nowcast-link, [data-open-nowcast-link], #nowcast-title-toggle, .approach-nowcast-button"],
    ["forecast48", "#forecast-48h-title-toggle, [data-open-48h-date], [data-summary-target=\"wind48\"]"],
    ["weatherDetails", "[data-summary-target=\"rain\"], .daily-period-card > summary, .forecast-panel > summary"]
  ];

  function visitorId() {
    try {
      const existing = localStorage.getItem(storageKey);
      if (/^[0-9a-f-]{36}$/i.test(existing || "")) return existing;
      const created = crypto.randomUUID();
      localStorage.setItem(storageKey, created);
      return created;
    } catch {
      return crypto.randomUUID();
    }
  }

  const anonymousVisitor = visitorId();
  function deviceType() {
    const agent = navigator.userAgent || "";
    if (/iPad|Tablet|PlayBook|Silk/i.test(agent) || (/Android/i.test(agent) && !/Mobile/i.test(agent)) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "tablet";
    if (navigator.userAgentData?.mobile || /Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(agent)) return "smartphone";
    return "desktop";
  }

  const send = (type, target = "") => fetch(endpoint, {
    method: "POST",
    mode: "cors",
    keepalive: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ visitorId: anonymousVisitor, type, target, device: deviceType() })
  }).catch(() => {});

  function pageTarget() {
    const url = new URL(document.location.href);
    const pathname = url.pathname.replace(/\/+$/, "");
    const publicPath = pathname.replace(/^\/(?:sandbox|testing|meteo-les_tatins)(?=\/|$)/i, "");
    if (!publicPath || /^\/index\.html$/i.test(publicPath)) return "main";
    if (/\/about\.html$/i.test(publicPath)) return "about";
    if (/\/news(?:\/index\.html)?$/i.test(publicPath)) return "news";
    if (/\/changelog(?:\.html)?$/i.test(publicPath)) return "changelog";
    if (/\/contact(?:\/index\.html)?$/i.test(publicPath)) return "contact";
    if (/\/rapports(?:\/|$)/i.test(publicPath)) return "reports";
    return "other";
  }

  send("visit", pageTarget());
  document.addEventListener("click", event => {
    for (const [target, selector] of interactionSelectors) {
      if (event.target.closest(selector)) {
        send("interaction", target);
        break;
      }
    }
  }, { capture: true });
})();
