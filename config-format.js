// JSON configuration with # comments outside quoted strings.
export function parseConfigText(text) {
  if (typeof text !== 'string') throw new Error('Fichier de configuration invalide.');
  let result = '', quoted = false, escaped = false, comment = false;
  for (const char of text) {
    if (comment) {
      if (char === '\n' || char === '\r') { comment = false; result += char; }
    } else if (quoted) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '#') comment = true;
    else { result += char; if (char === '"') quoted = true; }
  }
  try { return JSON.parse(result); } catch { throw new Error('Fichier de configuration invalide.'); }
}
