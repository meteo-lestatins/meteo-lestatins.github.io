(() => {
  const runtimeConfig = window.METEO_RUNTIME_CONFIG && typeof window.METEO_RUNTIME_CONFIG === "object" ? window.METEO_RUNTIME_CONFIG : {};
  const apiBase = new URL(runtimeConfig.apiBase || "./", document.baseURI);
  const endpoint = new URL("api/analytics", apiBase);
  const storageKey = "meteo_anonymous_visitor";

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
  const send = (type, target = "") => fetch(endpoint, {
    method: "POST",
    mode: "cors",
    keepalive: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ visitorId: anonymousVisitor, type, target })
  }).catch(() => {});

  function pageTarget() {
    const url = new URL(document.location.href);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (!pathname || /^\/(?:sandbox|testing)?(?:\/index\.html)?$/i.test(pathname)) return "main";
    if (/\/about\.html$/i.test(pathname)) return "about";
    if (/\/news(?:\/index\.html)?$/i.test(pathname)) return "news";
    if (/\/changelog(?:\.html)?$/i.test(pathname)) return "changelog";
    return "";
  }

  send("visit", pageTarget());
})();
