# Bulletin local Météo-France

API de données ouvertes de Météo-France utilisées :

- AROME : prévisions à courte échéance.
- ARPEGE : prévisions à moyenne échéance.
- PIAF : précipitations des prochaines heures.
- Vigilance : alertes météorologiques.

Open-Meteo complète les prévisions jusqu'à 16 jours ; les échéances à partir de J+8 sont présentées comme des tendances.

GitHub Actions récupère les données météo et prépare les fichiers du site.
