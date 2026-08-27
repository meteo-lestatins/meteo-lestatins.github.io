const article = document.getElementById("report-article");
const version = document.getElementById("report-version");
const runtimeConfig = window.METEO_RUNTIME_CONFIG && typeof window.METEO_RUNTIME_CONFIG === "object" ? window.METEO_RUNTIME_CONFIG : {};

if (/^\d+\.\d{3}$/.test(String(runtimeConfig.releaseNumber || ""))) {
  version.textContent = `v${runtimeConfig.releaseNumber}`;
  version.hidden = false;
}

fetch(new URL("../fin-pluie-bord-cellule.md", document.baseURI), { cache: "no-store" })
  .then(response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  })
  .then(markdown => {
    article.innerHTML = globalThis.newsMarkdownToHtml(markdown);
  })
  .catch(error => {
    article.innerHTML = '<p class="news-empty">Le rapport est momentanément indisponible.</p>';
    console.error(error);
  });
