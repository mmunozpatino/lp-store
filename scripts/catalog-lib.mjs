// Lógica del catálogo, sin red ni archivos: la usan scripts/catalog.mjs (en el workflow) y los tests.
//
// El catálogo es la lista de apps que muestra LP Store: todos los repos públicos de la dueña cuya última versión
// publicada en GitHub trae un APK. Para cada una guarda lo que la app necesita sin consultar la API de GitHub
// (que tiene un límite de 60 consultas por hora por IP): nombre, paquete de Android, versión, novedades, tamaño y
// huella SHA-256 del APK, e ícono.

/** Repos públicos propios que pueden tener apps: sin forks ni archivados. */
export function candidateRepos(repos) {
  return (repos ?? []).filter((repo) => repo && !repo.fork && !repo.archived && !repo.private && !repo.disabled);
}

/** El APK de una versión publicada: el primer asset .apk. null si no trae ninguno. */
export function apkAsset(release) {
  if (!release || release.draft || release.prerelease) return null;
  return (release.assets ?? []).find((asset) => /\.apk$/i.test(asset?.name ?? '') && asset.state !== 'starter') ?? null;
}

/** Lo que importa de `aapt2 dump badging`: { packageId, versionCode, versionName, label }. */
export function parseBadging(text) {
  const output = String(text ?? '');
  const pkg = /^package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'/m.exec(output);
  if (!pkg) throw new Error('aapt2 no informó el paquete del APK.');
  const label = /^application-label:'([^']*)'/m.exec(output)?.[1] ?? null;
  return { packageId: pkg[1], versionCode: Number(pkg[2]), versionName: pkg[3], label };
}

/** Si se puede reusar lo ya calculado de esta app: misma versión y mismo APK. */
export function sameRelease(previous, repo, release, asset) {
  return Boolean(
    previous &&
      previous.repo === repo.name &&
      previous.tag === release.tag_name &&
      previous.apk?.name === asset.name &&
      previous.apk?.size === asset.size &&
      previous.apk?.assetId === asset.id,
  );
}

/** Una app del catálogo. `apk` trae { packageId, versionCode, versionName, label, sha256 } del APK bajado. */
export function buildEntry({ repo, release, asset, apk, icon }) {
  return {
    repo: repo.name,
    name: apk.label || repo.name,
    description: repo.description ?? '',
    packageId: apk.packageId,
    versionName: apk.versionName,
    versionCode: apk.versionCode,
    tag: release.tag_name,
    publishedAt: release.published_at,
    notes: String(release.body ?? '').trim(),
    apk: { name: asset.name, size: asset.size, sha256: apk.sha256, assetId: asset.id },
    icon: icon ?? null,
  };
}

export function buildCatalog(owner, apps) {
  const sorted = [...apps].sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
  return { owner, generatedAt: new Date().toISOString(), apps: sorted };
}

/** Si cambió algo más que la fecha: si no, no hace falta volver a publicar el catálogo. */
export function catalogChanged(previous, next) {
  const strip = (catalog) => JSON.stringify({ ...catalog, generatedAt: undefined });
  return !previous || strip(previous) !== strip(next);
}

// ---------- Íconos ----------
// El ícono sale del código del repo, en la versión publicada. Android lo guarda en el APK con nombres acortados
// (res/BW.xml), así que no se puede sacar de ahí. Se arma un SVG con el ícono adaptable (fondo + frente, cada uno
// color, dibujo vectorial o PNG) o, si la app no tiene, se usa el PNG clásico.

/** XML mínimo: { name, attrs, children } del elemento raíz. Alcanza para los recursos de Android. */
export function parseXml(text) {
  const source = String(text ?? '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  const tag = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let match;
  while ((match = tag.exec(source))) {
    const [, closing, name, rawAttrs, selfClosing] = match;
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs = {};
    for (const [, key, , value1, value2] of rawAttrs.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      attrs[key] = decodeEntities(value1 ?? value2);
    }
    const node = { name, attrs, children: [] };
    stack.at(-1).children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root.children[0] ?? null;
}

function decodeEntities(text) {
  return text.replace(/&(lt|gt|amp|quot|apos);/g, (_, name) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[name]);
}

/** Colores de res/values*: { nombre: "#rrggbb" }. */
export function parseColors(xmlTexts) {
  const colors = {};
  for (const text of xmlTexts) {
    const root = parseXml(text);
    for (const node of root?.children ?? []) {
      if (node.name === 'color' && node.attrs.name) colors[node.attrs.name] = textOf(text, node.attrs.name);
    }
  }
  return colors;
}

/** El texto de <color name="x">#...</color> (parseXml no guarda texto). */
function textOf(xml, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<color[^>]*name=["']${escaped}["'][^>]*>\\s*([^<]*?)\\s*</color>`).exec(xml)?.[1] ?? '';
}

/** "#AARRGGBB", "#RRGGBB", "#RGB" o "@color/x" -> color CSS. null si no se entiende o es transparente. */
export function cssColor(value, colors = {}, depth = 0) {
  const text = String(value ?? '').trim();
  if (text.startsWith('@color/') || text.startsWith('@android:color/')) {
    if (text === '@android:color/white') return '#ffffff';
    if (text === '@android:color/black') return '#000000';
    return depth < 5 ? cssColor(colors[text.split('/')[1]], colors, depth + 1) : null;
  }
  const hex = /^#([0-9a-f]{3,8})$/i.exec(text)?.[1];
  if (!hex) return null;
  if (hex.length === 3) return '#' + [...hex].map((c) => c + c).join('').toLowerCase();
  if (hex.length === 6) return '#' + hex.toLowerCase();
  if (hex.length === 8) {
    const alpha = parseInt(hex.slice(0, 2), 16);
    if (alpha === 0) return null;
    if (alpha === 255) return '#' + hex.slice(2).toLowerCase();
    return `rgba(${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)},${parseInt(hex.slice(6, 8), 16)},${(alpha / 255).toFixed(3)})`;
  }
  return null;
}

const escapeAttr = (text) => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const number = (value, fallback = 0) => (Number.isFinite(Number.parseFloat(value)) ? Number.parseFloat(value) : fallback);

/** Un dibujo vectorial de Android (<vector>) como contenido SVG en un lienzo de 108x108. null si no es uno. */
export function vectorToSvg(xml, colors = {}) {
  const root = typeof xml === 'string' ? parseXml(xml) : xml;
  if (root?.name !== 'vector') return null;
  const width = number(root.attrs['android:viewportWidth'], 108);
  const height = number(root.attrs['android:viewportHeight'], 108);
  const body = root.children.map((child) => vectorNode(child, colors)).join('');
  return `<g transform="scale(${108 / width} ${108 / height})">${body}</g>`;
}

function vectorNode(node, colors) {
  const a = node.attrs;
  if (node.name === 'group') {
    const transforms = [];
    const tx = number(a['android:translateX']);
    const ty = number(a['android:translateY']);
    const px = number(a['android:pivotX']);
    const py = number(a['android:pivotY']);
    const sx = number(a['android:scaleX'], 1);
    const sy = number(a['android:scaleY'], 1);
    const rotation = number(a['android:rotation']);
    // Android aplica: escala y rotación alrededor del pivote, y después la traslación.
    if (tx || ty) transforms.push(`translate(${tx} ${ty})`);
    if (px || py) transforms.push(`translate(${px} ${py})`);
    if (rotation) transforms.push(`rotate(${rotation})`);
    if (sx !== 1 || sy !== 1) transforms.push(`scale(${sx} ${sy})`);
    if (px || py) transforms.push(`translate(${-px} ${-py})`);
    const inner = node.children.map((child) => vectorNode(child, colors)).join('');
    return transforms.length ? `<g transform="${transforms.join(' ')}">${inner}</g>` : `<g>${inner}</g>`;
  }
  if (node.name !== 'path' || !a['android:pathData']) return '';
  // Rellenos con degradado (<aapt:attr>): son sombras decorativas; se omiten.
  const fill = cssColor(a['android:fillColor'], colors);
  const stroke = cssColor(a['android:strokeColor'], colors);
  if (!fill && !stroke) return '';
  const attrs = [`d="${escapeAttr(a['android:pathData'])}"`, `fill="${fill ?? 'none'}"`];
  if (a['android:fillAlpha']) attrs.push(`fill-opacity="${number(a['android:fillAlpha'], 1)}"`);
  if (a['android:fillType'] === 'evenOdd') attrs.push('fill-rule="evenodd"');
  if (stroke) {
    attrs.push(`stroke="${stroke}"`, `stroke-width="${number(a['android:strokeWidth'], 1)}"`);
    if (a['android:strokeAlpha']) attrs.push(`stroke-opacity="${number(a['android:strokeAlpha'], 1)}"`);
    if (a['android:strokeLineCap']) attrs.push(`stroke-linecap="${escapeAttr(a['android:strokeLineCap'])}"`);
    if (a['android:strokeLineJoin']) attrs.push(`stroke-linejoin="${escapeAttr(a['android:strokeLineJoin'])}"`);
  }
  return `<path ${attrs.join(' ')}/>`;
}

const DENSITIES = ['xxxhdpi', 'xxhdpi', 'xhdpi', 'hdpi', 'mdpi', ''];

/**
 * Archivos de un recurso ("@mipmap/ic_launcher") en el árbol del repo, del mejor al peor: XML sin calificar primero
 * (los dibujos vectoriales valen para cualquier densidad), después los PNG de mayor densidad.
 */
export function resourceFiles(paths, resDir, reference) {
  const match = /^@(drawable|mipmap)\/([\w.]+)$/.exec(String(reference ?? '').trim());
  if (!match) return [];
  const [, type, name] = match;
  const found = paths.filter((p) => {
    if (!p.startsWith(resDir + '/')) return false;
    const [folder, file] = p.slice(resDir.length + 1).split('/');
    return file && (folder === type || folder.startsWith(type + '-')) && (file === name + '.xml' || file === name + '.png' || file === name + '.webp');
  });
  const rank = (p) => {
    const folder = p.slice(resDir.length + 1).split('/')[0];
    const isXml = p.endsWith('.xml');
    // mipmap-anydpi-v26 es el ícono adaptable en sí; los demás XML son dibujos.
    const density = DENSITIES.findIndex((d) => (d ? folder.includes('-' + d) : true));
    return (isXml ? 0 : 100) + (folder.includes('anydpi') ? -1 : 0) + density;
  };
  return found.sort((a, b) => rank(a) - rank(b));
}

/** Busca el ícono que declara el manifiesto (android:icon). "@mipmap/ic_launcher" si no se encuentra. */
export function manifestIcon(manifestXml) {
  const root = parseXml(manifestXml);
  const app = root?.children.find((child) => child.name === 'application');
  return app?.attrs['android:icon'] || '@mipmap/ic_launcher';
}

/**
 * Arma el ícono de una app como data URI. `read(path)` devuelve el contenido del archivo del repo (Buffer) o null.
 * `paths` es el árbol del repo. Devuelve null si no encuentra uno que sepa dibujar.
 */
export async function resolveIcon({ paths, read }) {
  const manifestPath = paths.find((p) => /(^|\/)app\/src\/main\/AndroidManifest\.xml$/.test(p));
  if (!manifestPath) return null;
  const resDir = manifestPath.replace(/AndroidManifest\.xml$/, 'res');
  const manifest = await read(manifestPath);
  const reference = manifestIcon(manifest?.toString('utf8') ?? '');
  const valueFiles = paths.filter((p) => p.startsWith(resDir + '/values/') && p.endsWith('.xml'));
  const colors = parseColors(await Promise.all(valueFiles.map(async (p) => (await read(p))?.toString('utf8') ?? '')));

  for (const file of resourceFiles(paths, resDir, reference)) {
    const content = await read(file);
    if (!content) continue;
    if (file.endsWith('.png') || file.endsWith('.webp')) return dataUri(file, content);
    const root = parseXml(content.toString('utf8'));
    if (root?.name === 'adaptive-icon') {
      const layer = async (name) => {
        const node = root.children.find((child) => child.name === name);
        return node ? drawLayer(node.attrs['android:drawable'], { paths, resDir, read, colors }) : '';
      };
      const background = await layer('background');
      const foreground = await layer('foreground');
      if (!foreground) continue;
      return svgUri(`${background || '<rect width="108" height="108" fill="#ffffff"/>'}${foreground}`);
    }
    const vector = vectorToSvg(root, colors);
    if (vector) return svgUri(vector);
  }
  return null;
}

/** Una capa del ícono adaptable como SVG en el lienzo de 108x108: color, dibujo vectorial o PNG. */
async function drawLayer(reference, { paths, resDir, read, colors }) {
  const color = cssColor(reference, colors);
  if (color) return `<rect width="108" height="108" fill="${color}"/>`;
  for (const file of resourceFiles(paths, resDir, reference)) {
    const content = await read(file);
    if (!content) continue;
    if (file.endsWith('.png') || file.endsWith('.webp')) {
      return `<image width="108" height="108" href="${dataUri(file, content)}"/>`;
    }
    const vector = vectorToSvg(content.toString('utf8'), colors);
    if (vector) return vector;
  }
  return '';
}

function dataUri(file, content) {
  return `data:image/${file.endsWith('.webp') ? 'webp' : 'png'};base64,${content.toString('base64')}`;
}

/** Se muestra la zona visible del ícono adaptable (los 72x72 del centro); las esquinas las redondea la app. */
function svgUri(body) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="18 18 72 72">${body}</svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

/** Más de esto no se guarda: el catálogo lo baja cada celular. */
export const MAX_ICON_CHARS = 300 * 1024;
