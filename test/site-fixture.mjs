import { siteProfile as neutralProfile } from '../sites/profiles.mjs';
// Coordonnées d'exemple réservées aux tests.
export function siteProfile() {
  return { ...neutralProfile(), place: 'Exemple', latitude: 48.8566, longitude: 2.3522, department: '75', headerAltitude: 35 };
}
