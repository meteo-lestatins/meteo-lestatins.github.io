import { requestSiteUpdate, findUpdateRun, adminTokenFromConfig } from './admin-api.js';
const config = window.METEO_RUNTIME_CONFIG || {};
const management = config.management || {};
const form = document.querySelector('#update-form');
const button = document.querySelector('#update-button');
const status = document.querySelector('#update-status');
const link = document.querySelector('#run-link');
document.querySelector('#site-name').textContent = config.site?.name || 'Bulletin météo local';
document.querySelector('#versions').textContent = 'Version installée : ' + (config.releaseNumber || 'inconnue');
if (!management.repository) {
  button.disabled = true;
  status.textContent = 'Administration disponible après installation dans le dépôt du site.';
}
const pause = () => new Promise(resolve => setTimeout(resolve, 5000));
async function waitForRun(api, workflow, requestId, message) {
  status.textContent = message;
  const deadline = Date.now() + 45 * 60_000;
  while (Date.now() < deadline) {
    const run = await findUpdateRun(api, management.repository, workflow, management.branch, requestId);
    if (run) {
      link.href = 'https://github.com/' + management.repository + '/actions/runs/' + run.id;
      link.hidden = false;
      if (run.status === 'completed') {
        if (run.conclusion !== 'success') throw new Error('Opération interrompue. Consulter le détail sur GitHub (' + run.conclusion + ').');
        return;
      }
    }
    await pause();
  }
  throw new Error('La demande a été envoyée. Consulter sa progression sur GitHub.');
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  button.disabled = true;
  link.hidden = true;
  const input = document.querySelector('#private-config');
  let token = '';
  const requestId = crypto.randomUUID();
  try {
    const file = input.files?.[0];
    if (!file || file.size > 65536) throw new Error('Choisir le fichier .conf privé de ce site.');
    token = adminTokenFromConfig(await file.text(), management.repository);
    input.value = '';
    status.textContent = 'Envoi de la demande…';
    const api = await requestSiteUpdate({ ...management, token, requestId });
    await waitForRun(api, 'update-site.yml', requestId, 'Récupération du code commun…');
    await waitForRun(api, 'weather.yml', requestId, 'Code récupéré. Publication du site en cours…');
    status.textContent = 'Site mis à jour. Votre configuration a été conservée.';
  } catch (error) {
    status.textContent = error.message;
  } finally {
    token = '';
    button.disabled = false;
  }
});
