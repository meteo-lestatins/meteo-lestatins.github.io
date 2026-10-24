export const sourceRepository = 'nicklausFR/bulletin-local-meteo-france';

export function githubClient(token, fetchImpl = fetch) {
  return async (route, body) => {
    const response = await fetchImpl('https://api.github.com/' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store', credentials: 'omit', redirect: 'error'
    });
    if (!response.ok) {
      const messages = {
        401: 'Jeton GitHub invalide ou expiré.',
        403: 'Le jeton doit autoriser Actions en écriture sur ce dépôt.',
        404: 'Administration non activée sur ce dépôt, ou dépôt inaccessible avec ce jeton.',
        422: 'Le workflow de mise à jour doit être installé sur la branche principale.'
      };
      throw new Error(messages[response.status] || 'GitHub indisponible (HTTP ' + response.status + ').');
    }
    return response.status === 204 ? null : response.json();
  };
}

export async function requestSiteUpdate({ repository, branch, token, requestId, fetchImpl }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.toLowerCase() === sourceRepository.toLowerCase()) {
    throw new Error('Dépôt du site non configuré.');
  }
  if (!branch || !/^[a-zA-Z0-9-]+$/.test(requestId)) throw new Error('Demande de mise à jour invalide.');
  const api = githubClient(token, fetchImpl);
  await api('repos/' + repository + '/actions/workflows/update-site.yml/dispatches', {
    ref: branch, inputs: { request_id: requestId }
  });
  return api;
}

export async function findUpdateRun(api, repository, workflow, branch, requestId) {
  const result = await api('repos/' + repository + '/actions/workflows/' + workflow
    + '/runs?event=workflow_dispatch&branch=' + encodeURIComponent(branch) + '&per_page=30');
  return result.workflow_runs.find(run => run.display_title === 'Mise à jour ' + requestId);
}
