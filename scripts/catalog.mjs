// Arma catalog.json: las apps que muestra LP Store. Corre en el workflow "Catálogo" (cada media hora y después de
// cada versión de LP Store), con el token del workflow, que tiene un límite de consultas mucho más alto que el de
// cada celular. Solo baja el APK de las apps que cambiaron de versión desde el catálogo anterior.
//
// node scripts/catalog.mjs --owner <usuario> --aapt2 <ruta> --out catalog.json [--previous anterior.json]
//
// Si el catálogo cambió (sin contar la fecha), escribe changed=true en $GITHUB_OUTPUT.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_ICON_CHARS,
  apkAsset,
  buildCatalog,
  buildEntry,
  candidateRepos,
  catalogChanged,
  parseBadging,
  resolveIcon,
  sameRelease,
} from './catalog-lib.mjs';

function arg(name) {
  const index = process.argv.indexOf('--' + name);
  return index === -1 ? null : process.argv[index + 1];
}

const owner = arg('owner');
const aapt2 = arg('aapt2');
const out = arg('out');
const previousFile = arg('previous');
if (!owner || !aapt2 || !out) {
  console.error('Uso: node scripts/catalog.mjs --owner <usuario> --aapt2 <ruta> --out catalog.json [--previous anterior.json]');
  process.exit(1);
}

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const headers = { 'User-Agent': 'LP-Store-Catalog', Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };

async function api(url, { allow404 = false, raw = false } = {}) {
  const response = await fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, {
    headers: raw ? { ...headers, Accept: 'application/vnd.github.raw' } : headers,
  });
  if (allow404 && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub respondió ${response.status} a ${url}`);
  return raw ? Buffer.from(await response.arrayBuffer()) : response.json();
}

async function allRepos() {
  const repos = [];
  for (let page = 1; page < 20; page += 1) {
    const batch = await api(`/users/${owner}/repos?type=owner&per_page=100&page=${page}`);
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos;
}

/** Baja el APK, calcula su huella y lee paquete, versión y nombre con aapt2. */
async function inspectApk(asset) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lp-store-'));
  try {
    const response = await fetch(asset.browser_download_url, { headers: { 'User-Agent': headers['User-Agent'] } });
    if (!response.ok) throw new Error(`No se pudo bajar ${asset.name}: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== asset.size) throw new Error(`${asset.name} se bajó incompleto.`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    // Si GitHub informa la huella, tiene que coincidir con lo bajado.
    const digest = /^sha256:([a-f0-9]{64})$/.exec(asset.digest ?? '')?.[1];
    if (digest && digest !== sha256) throw new Error(`La huella de ${asset.name} no coincide con la de GitHub.`);
    const file = path.join(dir, 'app.apk');
    writeFileSync(file, bytes);
    const badging = execFileSync(aapt2, ['dump', 'badging', file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return { ...parseBadging(badging), sha256 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** El ícono, del código del repo en la versión publicada. */
async function iconOf(repo, tag) {
  const tree = await api(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(tag)}?recursive=1`, { allow404: true });
  const paths = (tree?.tree ?? []).filter((item) => item.type === 'blob').map((item) => item.path).filter((p) => !p.includes('node_modules/'));
  const read = (file) => api(`/repos/${owner}/${repo}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(tag)}`, { allow404: true, raw: true });
  const icon = await resolveIcon({ paths, read });
  return icon && icon.length <= MAX_ICON_CHARS ? icon : null;
}

const previous = previousFile && existsSync(previousFile) ? JSON.parse(readFileSync(previousFile, 'utf8')) : null;
const previousApps = new Map((previous?.apps ?? []).map((app) => [app.repo, app]));

const apps = [];
for (const repo of candidateRepos(await allRepos())) {
  const release = await api(`/repos/${owner}/${repo.name}/releases/latest`, { allow404: true });
  const asset = apkAsset(release);
  if (!asset) continue;
  const old = previousApps.get(repo.name);
  try {
    if (sameRelease(old, repo, release, asset)) {
      // Misma versión: se reusa todo lo calculado, pero la descripción y las novedades pueden haber cambiado.
      apps.push({ ...old, description: repo.description ?? '', notes: String(release.body ?? '').trim() });
      console.log(`${repo.name}: ${release.tag_name} (sin cambios)`);
      continue;
    }
    const apk = await inspectApk(asset);
    let icon = null;
    try {
      icon = await iconOf(repo.name, release.tag_name);
    } catch (error) {
      console.warn(`${repo.name}: sin ícono (${error.message})`);
    }
    apps.push(buildEntry({ repo, release, asset, apk, icon }));
    console.log(`${repo.name}: ${release.tag_name} -> ${apk.packageId} ${apk.versionName} (${apk.versionCode})${icon ? '' : ', sin ícono'}`);
  } catch (error) {
    // Una app con problemas no frena a las demás; si estaba en el catálogo anterior, queda como estaba.
    console.warn(`${repo.name}: ${error.message}`);
    if (old) apps.push(old);
  }
}

const catalog = buildCatalog(owner, apps);
const changed = catalogChanged(previous, catalog);
writeFileSync(out, JSON.stringify(catalog) + '\n');
console.log(`${apps.length} apps. ${changed ? 'Catálogo nuevo.' : 'Sin cambios.'}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
