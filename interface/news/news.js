const article = document.getElementById("news-article");
const runtimeConfig = window.METEO_RUNTIME_CONFIG && typeof window.METEO_RUNTIME_CONFIG === "object" ? window.METEO_RUNTIME_CONFIG : {};
const apiBase = new URL(runtimeConfig.apiBase || "../", document.baseURI);
async function loadNews() {
  try {
    const response = await fetch(new URL("api/config", apiBase), { cache: "no-store", headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const config = await response.json();
    const version = document.getElementById("news-version");
    if (/^\d+\.\d{3}$/.test(String(config.releaseNumber || ""))) {
      version.textContent = `v${config.releaseNumber}`;
      version.hidden = false;
    }
    const content = String(config.news?.content || "").trim();
    article.innerHTML = content ? globalThis.newsMarkdownToHtml(content) : '<p class="news-empty">Aucune news publiée pour le moment.</p>';
  } catch (error) {
    article.innerHTML = '<p class="news-empty">Les news sont momentanément indisponibles.</p>';
    console.error(error);
  }
}

loadNews();
