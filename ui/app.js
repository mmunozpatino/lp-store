import {
  RELEASES_PAGE,
  STORE_REPO,
  appState,
  formatDate,
  formatSize,
  isNewer,
  normalizeCatalog,
  parseNotes,
  releasesPageOf,
  sortApps,
  versionParts,
} from './store.js';

const KEYS = {
  catalog: 'lp-store:catalogo',
  newsSeen: 'lp-store:novedades-vistas',
  dismissed: 'lp-store:aviso-descartado',
};
/** Cada cuánto se vuelve a bajar el catálogo al volver a la app. */
const CATALOG_MAX_AGE = 15 * 60 * 1000;
/** Cada cuánto se busca, con la app abierta, una versión nueva. */
const UPDATE_EVERY = 6 * 60 * 60 * 1000;

const $ = (selector) => document.querySelector(selector);
const native = () => Boolean(window.Capacitor?.isNativePlatform?.());

function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Sin almacenamiento la app funciona igual; solo no recuerda.
  }
}

/** Crea un elemento con texto (nunca HTML: los textos vienen de afuera). */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (name === 'class') node.className = value;
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child);
  return node;
}

// ---------- Parte nativa ----------

const Native = {
  async catalog() {
    if (native()) {
      const { json } = await window.Capacitor.nativePromise('LpStore', 'catalog', {});
      return JSON.parse(json);
    }
    // En el navegador (npm run dev), el servidor de desarrollo trae el catálogo publicado.
    const response = await fetch('dev/catalog.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('No se pudo bajar el catálogo.');
    return response.json();
  },
  async installed(packages) {
    if (!native()) {
      // En el navegador no hay nada instalado. Para probar: ?instaladas=ar.lp.exchange:3,ar.lp.mediacenter:21
      const apps = {};
      for (const pair of (new URLSearchParams(location.search).get('instaladas') ?? '').split(',').filter(Boolean)) {
        const [id, code] = pair.split(':');
        apps[id] = { versionName: `0.1.${code}`, versionCode: Number(code), launchable: true };
      }
      return { self: 'ar.lp.store', apps };
    }
    return window.Capacitor.nativePromise('LpStore', 'installed', { packages });
  },
  install(repo, onProgress) {
    return new Promise((resolve, reject) => {
      if (!native()) {
        reject(new Error('Solo en la app instalada.'));
        return;
      }
      window.Capacitor.nativeCallback('LpStore', 'install', { repo }, (result, error) => {
        if (error) {
          reject(new Error(error.message || 'No se pudo instalar.'));
          return;
        }
        onProgress?.(result);
        if (result?.state !== 'progress') resolve(result);
      });
    });
  },
  async launch(packageId) {
    if (native()) await window.Capacitor.nativePromise('LpStore', 'launch', { packageId });
  },
  async openUrl(url) {
    if (native()) await window.Capacitor.nativePromise('LpStore', 'openUrl', { url });
    else window.open(url, '_blank', 'noopener');
  },
};

// ---------- Estado ----------

const saved = load(KEYS.catalog);
let catalog = normalizeCatalog(saved?.catalog);
let catalogFetchedAt = catalog ? saved.fetchedAt : 0;
let installed = {};
let selfPackage = 'ar.lp.store';
let loading = false;
let catalogError = null;
/** Instalaciones en curso: repo -> { text, percent }. */
const progress = new Map();
let buildInfo = null;
let openDetail = null;

const installedOf = (app) => installed[app.packageId];
const isSelf = (app) => app.packageId === selfPackage || app.repo === STORE_REPO;
const selfApp = () => catalog?.apps.find(isSelf) ?? null;

async function refreshInstalled() {
  if (!catalog) return;
  try {
    const result = await Native.installed(catalog.apps.map((app) => app.packageId));
    installed = result.apps ?? {};
    selfPackage = result.self || selfPackage;
  } catch {
    // Sin la parte nativa, se muestran todas como no instaladas.
  }
  render();
}

async function refreshCatalog({ manual = false } = {}) {
  if (loading) return;
  loading = true;
  catalogError = null;
  if (manual) setUpdateStatus('Buscando…');
  render();
  try {
    const raw = await Native.catalog();
    const fresh = normalizeCatalog(raw);
    if (!fresh) throw new Error('El catálogo publicado no es el esperado.');
    catalog = fresh;
    catalogFetchedAt = Date.now();
    save(KEYS.catalog, { catalog: raw, fetchedAt: catalogFetchedAt });
  } catch (error) {
    catalogError = error.message || 'No se pudo bajar el catálogo. Revisá la conexión.';
  } finally {
    loading = false;
  }
  await refreshInstalled();
  checkSelfUpdate({ manual });
}

// ---------- Lista ----------

const STATE_LABEL = { install: 'Sin instalar', update: 'Actualización', current: 'Al día', newer: 'Al día', dev: 'Desarrollo' };

function iconOf(app, size = 'normal') {
  const src = installedOf(app)?.icon || app.icon;
  if (src) return el('img', { class: `app-icon ${size}`, src, alt: '' });
  return el('div', { class: `app-icon ${size} letter`, 'aria-hidden': 'true' }, app.name.replace(/^LP\s+/i, '').charAt(0).toUpperCase());
}

function versionLine(app) {
  const mine = installedOf(app);
  const state = appState(app, mine);
  if (state === 'install') return `${app.versionName}${app.size ? ' · ' + formatSize(app.size) : ''}`;
  if (state === 'update') return `${mine.versionName} → ${app.versionName}`;
  if (state === 'dev') return `Publicada: ${app.versionName}`;
  if (state === 'newer') return `${mine.versionName} (más nueva que la publicada)`;
  return app.versionName;
}

function actionButton(app, { large = false } = {}) {
  const state = appState(app, installedOf(app));
  const step = progress.get(app.repo);
  const cls = `button${large ? ' large' : ' small'}`;
  const run = (e) => {
    e.stopPropagation();
    install(app);
  };
  if (step) return el('button', { class: cls + ' primary', type: 'button', disabled: true }, step.percent != null ? `${step.percent}%` : '…');
  if (state === 'install') return el('button', { class: cls + ' primary', type: 'button', onclick: run }, 'Instalar');
  if (state === 'update') return el('button', { class: cls + ' primary', type: 'button', onclick: run }, 'Actualizar');
  if (isSelf(app)) return el('span', { class: 'tag' }, 'Esta app');
  return openButton(app, cls);
}

/** "Abrir" si la app está instalada y se puede abrir (no para LP Store misma). null si no. */
function openButton(app, cls) {
  if (isSelf(app) || !installedOf(app)?.launchable) return null;
  const open = (e) => {
    e.stopPropagation();
    Native.launch(app.packageId).catch((error) => showToast(error.message || 'No se pudo abrir la app.', true));
  };
  return el('button', { class: cls + ' soft', type: 'button', onclick: open }, 'Abrir');
}

/** Botones del detalle: el principal y, si la app ya está instalada y el principal no es "Abrir", también "Abrir". */
function detailButtons(app) {
  const main = actionButton(app, { large: true });
  const state = appState(app, installedOf(app));
  const extra = state === 'update' || state === 'dev' ? openButton(app, 'button large') : null;
  return [main, extra].filter(Boolean);
}

function progressBar(app) {
  const step = progress.get(app.repo);
  if (!step) return null;
  const fill = el('span');
  if (step.percent != null) fill.style.width = step.percent + '%';
  return el('div', { class: 'progress' + (step.percent == null ? ' indeterminate' : '') }, fill);
}

function card(app) {
  const state = appState(app, installedOf(app));
  const step = progress.get(app.repo);
  return el(
    'div',
    { class: `app-card state-${state}`, role: 'listitem', tabindex: '0', onclick: () => showDetail(app), onkeydown: (e) => e.key === 'Enter' && showDetail(app) },
    el(
      'div',
      { class: 'app-row' },
      iconOf(app),
      el(
        'div',
        { class: 'app-text' },
        el('div', { class: 'app-name' }, app.name),
        el('div', { class: 'app-meta' }, el('span', { class: `pill ${state}` }, STATE_LABEL[state]), el('span', { class: 'app-version' }, step?.text ?? versionLine(app))),
      ),
      actionButton(app),
    ),
    app.description ? el('div', { class: 'app-description' }, app.description) : null,
    progressBar(app),
  );
}

function stat(value, label, cls = '') {
  return el('div', { class: `stat ${cls}` }, el('strong', {}, String(value)), el('span', {}, label));
}

function renderSummary() {
  const apps = catalog?.apps ?? [];
  const states = apps.map((app) => appState(app, installedOf(app)));
  const updates = states.filter((s) => s === 'update').length;
  const mine = states.filter((s) => s !== 'install').length;
  $('#summary').replaceChildren(
    ...(catalog
      ? [
          stat(apps.length, apps.length === 1 ? 'app' : 'apps'),
          stat(mine, mine === 1 ? 'instalada' : 'instaladas', 'green'),
          stat(updates, updates === 1 ? 'actualización' : 'actualizaciones', updates ? 'purple' : ''),
        ]
      : []),
  );
  const node = $('#status');
  node.classList.toggle('error', Boolean(catalogError));
  if (catalogError) node.textContent = catalog ? `${catalogError} Se muestra lo último que se bajó.` : catalogError;
  else if (loading && !catalog) node.textContent = 'Buscando apps…';
  else if (catalog && !apps.length) node.textContent = 'Todavía no hay apps publicadas.';
  else if (catalog) node.textContent = updates ? 'Tenés apps para actualizar.' : mine ? 'Todo al día.' : 'Elegí qué instalar.';
  else node.textContent = '';
}

const SECTIONS = [
  { title: 'Para actualizar', states: ['update'] },
  { title: 'Instaladas', states: ['current', 'newer', 'dev'] },
  { title: 'Para instalar', states: ['install'] },
];

function render() {
  renderSummary();
  $('#refresh').classList.toggle('spinning', loading);
  const apps = catalog ? sortApps(catalog.apps, installed) : [];
  const groups = SECTIONS.map(({ title, states }) => {
    const list = apps.filter((app) => states.includes(appState(app, installedOf(app))));
    if (!list.length) return null;
    return el(
      'section',
      { class: 'group' },
      el('h2', { class: 'group-title' }, title, el('span', { class: 'count' }, String(list.length))),
      el('div', { class: 'cards', role: 'list' }, list.map(card)),
    );
  });
  $('#apps').replaceChildren(...groups.filter(Boolean));
  renderCatalogStatus();
  if (openDetail && $('#app-dialog').open) {
    const fresh = catalog?.apps.find((app) => app.repo === openDetail);
    if (fresh) fillDetail(fresh);
  }
}

// ---------- Detalle ----------

function changeList(changes) {
  if (!changes.length) return [el('p', { class: 'hint' }, 'Sin novedades que contar en esta versión.')];
  return changes.map(({ title, body }) => el('div', { class: 'change' }, title ? el('strong', {}, title) : null, body ? el('p', {}, body) : null));
}

function fillDetail(app) {
  const state = appState(app, installedOf(app));
  const icon = installedOf(app)?.icon || app.icon;
  const tiles = [
    ['Versión', app.versionName],
    installedOf(app) ? ['Instalada', installedOf(app).versionName] : app.size ? ['Tamaño', formatSize(app.size)] : null,
    app.publishedAt ? ['Publicada', formatDate(app.publishedAt)] : null,
  ].filter(Boolean);
  const step = progress.get(app.repo);
  $('#app-dialog-body').replaceChildren(
    ...[
      el(
        'section',
        { class: 'detail-hero' },
        icon ? el('img', { class: 'hero-glow', src: icon, alt: '', 'aria-hidden': 'true' }) : null,
        iconOf(app, 'large'),
        el('h2', { class: 'detail-name' }, app.name),
        el('span', { class: `pill ${state}` }, STATE_LABEL[state]),
        app.description ? el('p', { class: 'detail-description' }, app.description) : null,
        el('div', { class: 'detail-action' }, detailButtons(app)),
        progressBar(app),
        step ? el('p', { class: 'progress-text', 'aria-live': 'polite' }, step.text) : null,
      ),
      el('div', { class: 'tiles' }, tiles.map(([k, v]) => el('div', { class: 'tile' }, el('span', {}, k), el('strong', {}, v)))),
      el(
        'section',
        { class: 'card' },
        el('h3', {}, `Novedades de la ${app.versionName}`),
        ...changeList(parseNotes(app.notes)),
        el('div', { class: 'button-row' }, el('button', { class: 'button', type: 'button', onclick: () => Native.openUrl(releasesPageOf(app.repo)) }, 'Ver versiones anteriores en GitHub')),
      ),
      state === 'update' || state === 'dev'
        ? el('p', { class: 'hint footnote' }, 'Si Android dice "App no instalada", la que tenés está firmada con otra clave (por ejemplo, una versión de desarrollo): desinstalala y volvé a instalarla desde acá.')
        : null,
    ].filter(Boolean),
  );
}

function showDetail(app) {
  openDetail = app.repo;
  fillDetail(app);
  openDialog($('#app-dialog'));
}
$('#app-dialog').addEventListener('close', () => {
  openDetail = null;
});

// ---------- Instalar ----------

async function install(app, statusNode = null) {
  if (progress.has(app.repo)) return;
  const set = (text, isError = false, percent = null) => {
    if (text == null) progress.delete(app.repo);
    else progress.set(app.repo, { text, percent });
    if (statusNode) {
      statusNode.textContent = text ?? '';
      statusNode.classList.toggle('error', isError);
    }
    render();
  };
  set('Preparando…');
  try {
    const result = await Native.install(app.repo, (step) => {
      if (step?.state === 'progress' && step.total > 0) {
        const percent = Math.round((step.received / step.total) * 100);
        set(`Bajando… ${percent}%`, false, percent);
      }
    });
    if (result?.state === 'permission') {
      set(null);
      showToast('Permití que LP Store instale apps y después tocá de nuevo el botón.');
      if (statusNode) statusNode.textContent = 'Permití que LP Store instale apps y después tocá "Actualizar ahora" de nuevo.';
      return;
    }
    set(null);
    if (statusNode) statusNode.textContent = 'Abriendo el instalador de Android…';
  } catch (error) {
    set(null);
    const message = error.message || 'No se pudo instalar.';
    showToast(message, true);
    if (statusNode) {
      statusNode.textContent = `${message} Podés bajarla a mano desde GitHub.`;
      statusNode.classList.add('error');
    }
  }
}

let toastTimer = null;
function showToast(text, isError = false) {
  let node = $('#toast');
  if (!node) {
    node = el('div', { id: 'toast', class: 'toast', role: 'status' });
    document.body.append(node);
  }
  node.textContent = text;
  node.classList.toggle('error', isError);
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 5000);
}

// ---------- Diálogos y botón "atrás" de Android ----------
// Cada diálogo abierto agrega un paso al historial: "atrás" lo cierra en vez de salir de la app.

const dialogStack = [];
let pendingBacks = 0;
const waitingToOpen = [];

function openDialog(dialog) {
  if (dialog.open) return;
  if (pendingBacks > 0) {
    if (!waitingToOpen.includes(dialog)) waitingToOpen.push(dialog);
    return;
  }
  dialog.showModal();
  dialogStack.push(dialog);
  history.pushState({ lpDialog: dialogStack.length }, '');
}

document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.addEventListener('close', () => {
    const index = dialogStack.indexOf(dialog);
    if (index === -1) return;
    dialogStack.splice(index, 1);
    pendingBacks += 1;
    history.back();
  });
  dialog.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => dialog.close()));
});

window.addEventListener('popstate', () => {
  if (pendingBacks > 0) {
    pendingBacks -= 1;
    if (pendingBacks === 0) waitingToOpen.splice(0).forEach(openDialog);
    return;
  }
  const top = dialogStack.pop();
  if (top?.open) top.close();
});

// ---------- LP Store: su propia versión ----------

async function bundledJson(name) {
  try {
    const response = await fetch(name, { cache: 'no-store' });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function changesOf(version) {
  const data = await bundledJson('changelog.json');
  const entry = (data?.versions ?? []).find((v) => v.version === version);
  return Array.isArray(entry?.changes) ? entry.changes.filter((c) => typeof c?.title === 'string') : [];
}

function setUpdateStatus(text, isError = false) {
  const node = $('#update-status');
  node.textContent = text ?? '';
  node.classList.toggle('error', isError);
}

function renderCatalogStatus() {
  const node = $('#catalog-status');
  if (!catalog) {
    node.textContent = catalogError ?? '';
    return;
  }
  const when = catalogFetchedAt ? new Date(catalogFetchedAt).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '';
  node.textContent = `${catalog.apps.length} apps.${when ? ` Revisado: ${when}.` : ''}`;
}

/** Si hay una versión nueva de LP Store en el catálogo: botón en Ajustes y, una vez por versión, el aviso. */
function checkSelfUpdate({ manual = false } = {}) {
  const app = selfApp();
  if (!buildInfo) {
    if (manual) setUpdateStatus('Esta es una versión de desarrollo: no se actualiza sola.');
    $('#install-update').hidden = true;
    return;
  }
  if (catalogError && manual) {
    setUpdateStatus(catalogError, true);
    return;
  }
  if (app && isNewer(app.versionName, buildInfo.version)) {
    $('#install-update').hidden = false;
    setUpdateStatus(`Hay una versión nueva: ${app.versionName}.`);
    if (manual || load(KEYS.dismissed) !== app.versionName) showUpdateDialog(app);
  } else {
    $('#install-update').hidden = true;
    setUpdateStatus(manual ? 'Tenés la última versión.' : '');
  }
}

function showUpdateDialog(app) {
  if ($('#news-dialog').open) {
    $('#news-dialog').addEventListener('close', () => showUpdateDialog(app), { once: true });
    return;
  }
  if ($('#update-dialog').open) return;
  $('#update-dialog-text').textContent = `Versión ${app.versionName} (tenés la ${buildInfo.version}).`;
  $('#update-dialog-notes').replaceChildren(...changeList(parseNotes(app.notes)));
  $('#update-dialog-progress').textContent = '';
  $('#update-dialog').dataset.version = app.versionName;
  openDialog($('#update-dialog'));
}

$('#update-dialog').addEventListener('close', () => {
  if ($('#update-dialog').dataset.version) save(KEYS.dismissed, $('#update-dialog').dataset.version);
});

async function installSelf(statusNode, button) {
  const app = selfApp();
  if (!app) return;
  button.disabled = true;
  await install(app, statusNode);
  button.disabled = false;
}

$('#update-dialog-install').addEventListener('click', () => installSelf($('#update-dialog-progress'), $('#update-dialog-install')));
$('#install-update').addEventListener('click', () => installSelf($('#update-status'), $('#install-update')));
$('#check-updates').addEventListener('click', () => refreshCatalog({ manual: true }));
$('#refresh').addEventListener('click', () => refreshCatalog({ manual: true }));
$('#open-settings').addEventListener('click', () => openDialog($('#settings')));

/** Novedades: solo las de la versión instalada, con el enlace a las anteriores en GitHub. */
async function setupNews() {
  const olderButton = el('button', { class: 'button', type: 'button', onclick: () => Native.openUrl(RELEASES_PAGE) }, 'Ver versiones anteriores en GitHub');
  if (!buildInfo) {
    $('#version-text').textContent = 'Versión de desarrollo.';
    $('#settings-news').replaceChildren(el('div', { class: 'button-row' }, olderButton));
    return;
  }
  $('#version-text').textContent = `Versión ${buildInfo.version}.`;
  const changes = await changesOf(buildInfo.version);
  $('#settings-news').replaceChildren(
    el('h3', { class: 'news-title' }, `Novedades de la ${buildInfo.version}`),
    ...changeList(changes),
    el('div', { class: 'button-row' }, olderButton),
  );
  const seen = load(KEYS.newsSeen);
  // Recién actualizada: se muestran sus novedades una vez. En la primera instalación, no.
  if (seen && isNewer(buildInfo.version, seen) && changes.length) {
    $('#news-dialog-body').replaceChildren(el('p', { class: 'hint' }, `Versión ${buildInfo.version}`), ...changeList(changes));
    $('#news-dialog').addEventListener('close', () => save(KEYS.newsSeen, buildInfo.version), { once: true });
    openDialog($('#news-dialog'));
  } else {
    save(KEYS.newsSeen, buildInfo.version);
  }
}

// ---------- Arranque ----------

render();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // Al volver del instalador de Android: puede haber cambiado lo instalado.
  refreshInstalled();
  if (Date.now() - catalogFetchedAt > CATALOG_MAX_AGE) refreshCatalog();
});
window.addEventListener('online', () => {
  if (catalogError) refreshCatalog();
});

(async () => {
  const info = await bundledJson('build-info.json');
  buildInfo = info && versionParts(info.version) ? info : null;
  await setupNews();
  await refreshInstalled();
  refreshCatalog();
  setInterval(() => refreshCatalog(), UPDATE_EVERY);
})();
