# Étude préliminaire — Fin de pluie au bord d’une cellule

**Date de l’étude :** 27 août 2026  
**Site étudié :** Les Tatins (44,6538° N, 5,5995° E)  
**Objet :** déterminer si les archives permettent d’améliorer l’estimation de la fin de pluie lorsque le site se trouve au bord d’une cellule radar.

## Résumé

Les archives permettent dès maintenant de diagnostiquer et de prototyper une amélioration du nowcasting de fin de pluie. Elles ne contiennent toutefois encore que dix fins de pluie indépendantes clairement associées au bord d’une cellule : cet échantillon suffit pour révéler des faiblesses et comparer des variantes, mais pas pour figer des coefficients de production.

Le radar futur doit être utilisé comme vérité de validation. PIAF ne doit être ni une cible à reproduire ni un arbitre ; il doit être évalué séparément, avec exactement le même critère de fin de pluie.

Le premier replay du nowcasting actuel montre :

- 32 prévisions émises entre 5 et 30 minutes avant dix fins de pluie de bord ;
- une fin durable annoncée dans l’heure dans 19 cas ;
- aucune fin durable trouvée dans l’heure dans 13 cas ;
- parmi les 19 fins annoncées, une erreur absolue moyenne de 7,6 minutes ;
- un biais moyen de +3,9 minutes, donc une tendance à annoncer la fin trop tard ;
- à seulement 5 minutes de la fin réelle, 8 événements sur 10 sont correctement terminés dans la prévision, avec une erreur moyenne de 1,9 minute.

PIAF n’est comparable que sur un seul des dix événements. Sa fin est exacte sur ce cas unique, mais ce résultat ne permet aucune conclusion sur sa supériorité ou son infériorité.

## 1. Question évaluée

L’étude ne cherche pas à savoir si le nowcasting doit « se conformer à PIAF ». Elle pose deux questions indépendantes :

1. notre nowcasting radar prévoit-il correctement la sortie de pluie au passage du bord arrière d’une cellule ?
2. sur les mêmes événements et aux mêmes instants d’émission, PIAF est-il plus fiable, équivalent ou moins fiable ?

La réponse de référence est toujours donnée par les observations radar postérieures à la prévision.

## 2. Données disponibles

### 2.1 Radar

Le balayage de l’archive active a trouvé 3 108 trames radar entre le 16 et le 27 août 2026. La plupart des journées complètes contiennent 288 trames, soit une observation toutes les cinq minutes.

Chaque enregistrement conserve un champ de 401 × 401 pixels à 500 m, centré sur Les Tatins et couvrant environ 200 × 200 km. Il ne s’agit donc pas d’une simple série au point : la forme spatiale et le déplacement des cellules peuvent être rejoués.

Inventaire utile à cette étude :

| Élément | Nombre |
|---|---:|
| Trames radar | 3 108 |
| Trames humides au point des Tatins | 264 |
| Trames où le voisinage immédiat chevauche pluie et sec | 36 |
| Fins de pluie durables détectées | 18 |
| Fins de pluie durables classées « bord de cellule » | 10 |

L’archive étant alimentée en continu, ces nombres constituent une photographie au moment de l’étude.

### 2.2 PIAF

Les fichiers actifs contiennent environ 1 680 instantanés PIAF. Pour la position des Tatins, l’archivage continu commence précisément le **21 août 2026 à 16:31 UTC**. Le premier instantané sauvegardé correspond au run PIAF de **16:15 UTC**.

L’archivage continu des API a été ajouté au site avec la version v3.021 du 21 août. Avant cette mise en place, PIAF était interrogé et affiché en temps réel, mais seul l’état courant du cache était conservé. Les prévisions anciennes ne peuvent pas être reconstituées après coup à partir du radar ni à partir d’un cache plus récent.

Parmi les dix fins de pluie de bord retenues :

- neuf sont antérieures au début de l’archive PIAF des Tatins ;
- une seule, le 23 août, possède un PIAF historiquement disponible au moment de la prévision.

L’absence de comparaison PIAF ne signifie donc pas que PIAF était indisponible ou mauvais. Elle signifie que ses runs n’étaient pas encore archivés.

Une autre précaution est nécessaire : un run PIAF arrive souvent plusieurs minutes après son heure nominale. Une comparaison honnête ne doit utiliser que les instantanés dont `fetchedAt` est antérieur à l’instant d’émission évalué. Un run reçu après son échéance ne doit jamais être crédité rétrospectivement.

## 3. Définition opérationnelle d’une fin de pluie

Pour cette étude préliminaire :

- le point est humide à partir de 0,05 mm/h dans le champ radar normalisé ;
- une fin est dite durable lorsque les trois trames suivantes restent sous ce seuil, soit au moins 15 minutes sèches ;
- la transition est classée « bord de cellule » lorsque le voisinage 3 × 3 pixels autour des Tatins contient simultanément des pixels humides et secs sur la dernière trame humide ou la première trame sèche ;
- les prévisions sont évaluées 5, 10, 15, 20, 25 et 30 minutes avant la fin observée, uniquement si le point est encore humide à l’instant d’émission.

Cette définition élimine une grande partie des alternances pluie/sec d’une seule trame. Elle devra néanmoins être testée avec d’autres durées de confirmation, notamment 10, 20 et 30 minutes.

## 4. Résultats du nowcasting actuel

### 4.1 Résultat global

| Mesure | Résultat |
|---|---:|
| Événements indépendants | 10 |
| Instants d’émission évalués | 32 |
| Fin durable trouvée dans l’horizon de 60 min | 19 |
| Aucune fin durable trouvée dans l’horizon | 13 |
| Erreur absolue moyenne parmi les fins trouvées | 7,6 min |
| Biais moyen parmi les fins trouvées | +3,9 min |
| Fins à ±5 min | 10 sur 19 |
| Fins à ±10 min | 12 sur 19 |

Un biais positif signifie une fin annoncée après la fin réellement observée.

Les 32 émissions ne sont pas 32 événements indépendants : plusieurs proviennent de la même cellule à des échéances différentes. Elles servent à étudier la stabilité de la prévision à l’approche de la sortie, tandis que la robustesse statistique doit être jugée sur les dix événements.

### 4.2 Résultat selon l’avance avant la fin réelle

| Avance | Cas encore humides | Fins prévues | Erreur absolue moyenne | Biais moyen |
|---:|---:|---:|---:|---:|
| 30 min | 3 | 1 | 15,0 min | −15,0 min |
| 25 min | 4 | 1 | 10,0 min | −10,0 min |
| 20 min | 5 | 3 | 13,3 min | +10,0 min |
| 15 min | 5 | 3 | 11,7 min | +8,3 min |
| 10 min | 5 | 3 | 10,0 min | +10,0 min |
| 5 min | 10 | 8 | 1,9 min | +1,9 min |

Le nowcasting reconnaît généralement la fin lorsqu’elle est imminente. Entre 10 et 20 minutes d’avance, il produit moins souvent une fin durable et, lorsqu’il en produit une, elle est le plus souvent trop tardive. À 25 ou 30 minutes, l’échantillon est trop petit pour interpréter le biais.

## 5. Pourquoi le bord pose problème au calcul actuel

Le calcul de précipitation projetée suit le déplacement estimé puis lit un unique pixel radar, arrondi à la ligne et à la colonne les plus proches. Une trajectoire située juste de part ou d’autre d’une frontière de pixel peut donc passer brutalement de toute l’intensité à zéro.

En parallèle, le déplacement global est estimé sur une image réduite par blocs de 4 × 4 pixels. Avec des pixels radar de 500 m, le champ utilisé pour la corrélation se déplace par blocs correspondant à 2 km. Cette réduction est utile à la robustesse et au coût du calcul, mais elle limite la finesse de localisation du bord arrière.

Le problème n’appelle pas nécessairement un lissage circulaire ou la prise du maximum autour du point : une telle méthode ferait pleuvoir aux Tatins lorsqu’une cellule proche manque réellement le site. La grandeur géométrique pertinente est le passage du **bord arrière local** au-dessus du point.

## 6. Piste d’amélioration à tester

La variante prioritaire devrait conserver le déplacement radar comme base, mais remplacer la décision binaire sur un pixel par une estimation explicite de la sortie de cellule :

1. identifier le bord arrière local de la zone humide qui couvre les Tatins ;
2. calculer sa distance signée au point ;
3. estimer la normale locale du bord et sa vitesse sur les deux ou trois dernières trames ;
4. extrapoler l’instant où ce bord franchit le point ;
5. convertir la proximité du bord en fraction de couverture, plutôt qu’en intensité intégrale ou nulle ;
6. élargir l’incertitude lorsque la confiance du mouvement est faible ou lorsque le bord se déforme rapidement.

La quantité de pluie à la frontière pourrait alors être estimée comme une intensité robuste à l’intérieur de la cellule multipliée par une fraction de couverture. L’heure de fin resterait un résultat distinct, fondé sur la sortie géométrique puis confirmé par une courte persistance sèche.

## 7. Protocole de comparaison recommandé

Quatre sorties doivent être calculées hors ligne sur les mêmes événements :

- **référence A :** nowcasting actuel, avec lecture d’un pixel projeté ;
- **variante B :** extrapolation du bord arrière par distance signée ;
- **variante C :** bord arrière et couverture fractionnelle ;
- **comparateur D :** PIAF brut réellement disponible à l’instant d’émission.

Les indicateurs principaux sont :

- erreur absolue de l’heure de fin ;
- biais précoce ou tardif ;
- proportion de fins à ±5 et ±10 minutes ;
- proportion de prévisions ne trouvant aucune fin dans l’heure ;
- fausses fins, lorsque la pluie reprend dans les 15 ou 30 minutes ;
- stabilité de l’heure de fin annoncée entre deux émissions successives.

Les réglages doivent être ajustés sur certains événements puis évalués sur d’autres journées complètes. Les émissions successives d’une même cellule ne doivent pas être réparties entre apprentissage et validation.

## 8. Niveau de confiance et données supplémentaires nécessaires

Les dix événements actuels permettent :

- de construire l’évaluateur ;
- de reproduire les erreurs ;
- d’écarter les variantes manifestement mauvaises ;
- de détecter un biais important.

Ils ne permettent pas encore :

- de choisir définitivement un rayon, un seuil ou une durée de confirmation ;
- de couvrir correctement les pluies stratiformes, convectives et très faibles ;
- de conclure sur PIAF ;
- de garantir une amélioration hors des situations d’août observées.

Un minimum de 30 à 50 fins de pluie de bord indépendantes paraît raisonnable pour une première validation. Une archive couvrant plusieurs saisons resterait préférable.

## Conclusion

Les archives radar sont suffisamment riches pour commencer immédiatement le développement et le replay d’une amélioration de la fin de pluie au bord des cellules. Le premier diagnostic montre que le nowcasting actuel devient précis à très courte échéance, mais tend à conserver la pluie trop longtemps ou à ne pas identifier de fin durable entre 10 et 20 minutes d’avance.

PIAF ne peut pas encore être classé comme meilleur ou moins bon : neuf événements sur dix précèdent son archivage continu et le seul événement comparable est insuffisant. À mesure que les nouvelles fins de pluie seront archivées, PIAF pourra être ajouté comme comparateur indépendant, sans modifier la vérité de référence ni orienter artificiellement le nouvel algorithme vers ses résultats.
