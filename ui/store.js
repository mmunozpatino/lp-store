// Lógica de la tienda, sin pantalla ni parte nativa (la prueban los tests).

export const OWNER = 'mmunozpatino';
export const STORE_REPO = 'lp-store';
export const RELEASES_PAGE = `https://github.com/${OWNER}/${STORE_REPO}/releases`;
export const releasesPageOf = (repo) => `https://github.com/${OWNER}/${repo}/releases`;

/** "v0.1.12" -> [0, 1, 12]. null si no es una versión. */
export function versionParts(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? '').trim());
  return match ? match.slice(1).map(Number) : null;
}

/** Si `candidate` es más nueva que `current`. */
export function isNewer(candidate, current) {
  const [a, b] = [versionParts(candidate), versionParts(current)];
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

const text = (value, max = 2000) => (typeof value === 'string' ? value.slice(0, max) : '');

/**
 * El catálogo, solo con lo que se muestra y con tipos seguros (viene de afuera). Se descartan las apps sin repo,
 * paquete o versión. Los íconos solo se aceptan como imágenes en data URI.
 */
export function normalizeCatalog(raw) {
  if (!raw || raw.owner !== OWNER || !Array.isArray(raw.apps)) return null;
  const apps = raw.apps
    .filter((app) => app && typeof app.repo === 'string' && typeof app.packageId === 'string' && Number.isFinite(app.versionCode))
    .map((app) => ({
      repo: text(app.repo, 100),
      name: text(app.name, 100) || app.repo,
      description: text(app.description, 400),
      packageId: text(app.packageId, 200),
      versionName: text(app.versionName, 40),
      versionCode: app.versionCode,
      publishedAt: text(app.publishedAt, 40),
      notes: text(app.notes, 20000),
      size: Number.isFinite(app.apk?.size) ? app.apk.size : 0,
      icon: typeof app.icon === 'string' && /^data:image\/(png|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(app.icon) ? app.icon : null,
    }));
  return { generatedAt: text(raw.generatedAt, 40), apps };
}

/**
 * Qué se puede hacer con una app: "install" (no está), "update" (hay una más nueva), "current" (al día),
 * "dev" (versión de desarrollo, que no se puede actualizar encima) o "newer" (tiene una más nueva que la publicada).
 */
export function appState(app, installed) {
  if (!installed) return 'install';
  if (String(installed.versionName ?? '').includes('dev')) return 'dev';
  if (installed.versionCode < app.versionCode) return 'update';
  if (installed.versionCode > app.versionCode) return 'newer';
  return 'current';
}

/** "4,1 MB" */
export function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / 1024 / 1024;
  return `${mb.toLocaleString('es-AR', { maximumFractionDigits: mb < 10 ? 1 : 0 })} MB`;
}

/** "19 nov 2026" */
export function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const month = date.toLocaleDateString('es-AR', { month: 'short' }).replace('.', '');
  return `${date.getDate()} ${month} ${date.getFullYear()}`;
}

/**
 * Novedades de una release de GitHub ("- Título" con la explicación con sangría debajo) como [{ title, body }].
 * Si el texto no tiene ese formato, queda todo como un solo cambio sin título.
 */
export function parseNotes(notes) {
  const source = String(notes ?? '').replace(/\r\n/g, '\n').trim();
  if (!source) return [];
  if (!/^- /m.test(source)) return [{ title: '', body: source }];
  const changes = [];
  for (const line of source.split('\n')) {
    if (line.startsWith('- ')) changes.push({ title: line.slice(2).trim(), body: '' });
    else if (changes.length && line.trim()) changes.at(-1).body += (changes.at(-1).body ? ' ' : '') + line.trim();
    else if (changes.length && !line.trim() && changes.at(-1).body) changes.at(-1).body += '\n';
  }
  return changes.map(({ title, body }) => ({ title, body: body.replace(/ ?\n ?/g, '\n').trim() }));
}

/** Orden de la lista: primero las que tienen actualización, después las instaladas y al final las demás. */
export function sortApps(apps, installedMap) {
  const rank = { update: 0, current: 1, newer: 1, dev: 1, install: 2 };
  return [...apps].sort((a, b) => {
    const diff = rank[appState(a, installedMap[a.packageId])] - rank[appState(b, installedMap[b.packageId])];
    return diff || a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
  });
}
