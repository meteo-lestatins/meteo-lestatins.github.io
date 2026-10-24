# Installation

Le dépôt du site reprend le code commun. Seul site.json contient les paramètres du lieu ; aucun code ni workflow propre à un site.

Profil : identifiant, nom, lieu, latitude, longitude, département et fuseau horaire (exemple : test/fixtures/site.json). Facultatifs : headerAltitude, headingPrefix, publicUrl, githubRepository, githubBranch, meteoTokenSecret.

Secrets GitHub du dépôt du site :
- METEO_FRANCE_API_KEY : API Météo-France (ou le nom existant indiqué par meteoTokenSecret).
- BULLETIN_UPDATE_TOKEN : jeton limité à ce dépôt, Contents et Workflows en écriture, pour récupérer aussi les évolutions des workflows communs.

Dans admin.html, saisir un jeton autorisant Actions en écriture sur ce dépôt, puis **Mettre à jour le site**. Il reste en mémoire uniquement pendant la demande. Le workflow fusionne la branche main de nicklausFR/bulletin-local-meteo-france, conserve site.json, puis lance la construction et la publication. La page suit leur progression. Aucun serveur privé.

La mise à jour est volontaire. La collecte météo utilise la version déjà installée : PIAF toutes les cinq minutes, autres prévisions chaque heure, sous réserve des délais de GitHub Actions.

Pour un nouveau site : fork du dépôt commun, ajout de site.json, secrets ci-dessus et GitHub Pages avec GitHub Actions. Pour un dépôt existant, intégrer la branche de préparation en conservant son historique de fusion (pas de squash), afin de garder un ancêtre commun avec la source.

En local : npm run build -- --profile=/chemin/site.json --state=/chemin/etat.json.

Les branches de préparation ne publient rien. L’activation sur la branche principale et le déploiement restent à la charge de l’utilisateur.
