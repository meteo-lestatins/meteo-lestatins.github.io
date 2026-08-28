(() => {
  const channel = location.pathname.split("/").includes("sandbox") ? "sandbox" : "main";
  const target = new URL(`https://nicolas.sindelar.fr/meteo-les_tatins/admin/replay/${channel}/`);
  target.search = location.search;
  target.hash = location.hash;
  location.replace(target.href);
})();
