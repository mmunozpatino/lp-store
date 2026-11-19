import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apkAsset,
  candidateRepos,
  catalogChanged,
  cssColor,
  parseBadging,
  resolveIcon,
  resourceFiles,
  sameRelease,
  vectorToSvg,
} from '../scripts/catalog-lib.mjs';

test('solo repos propios, públicos, sin forks ni archivados', () => {
  const repos = [{ name: 'a' }, { name: 'b', fork: true }, { name: 'c', archived: true }, { name: 'd', private: true }];
  assert.deepEqual(candidateRepos(repos).map((r) => r.name), ['a']);
});

test('el APK de la versión publicada', () => {
  const release = { assets: [{ name: 'Setup.exe' }, { name: 'LP-Cine-Vault.apk', id: 1 }] };
  assert.equal(apkAsset(release).id, 1);
  assert.equal(apkAsset({ assets: [{ name: 'x.exe' }] }), null);
  assert.equal(apkAsset({ prerelease: true, assets: [{ name: 'x.apk' }] }), null);
  assert.equal(apkAsset(null), null);
});

test('aapt2 dump badging', () => {
  const out = "package: name='ar.lp.exchange' versionCode='5' versionName='0.1.5' platformBuildVersionName='16'\napplication-label:'LP Exchange'\n";
  assert.deepEqual(parseBadging(out), { packageId: 'ar.lp.exchange', versionCode: 5, versionName: '0.1.5', label: 'LP Exchange' });
  assert.throws(() => parseBadging('nada'));
});

test('reusa lo calculado si es la misma versión y el mismo APK', () => {
  const previous = { repo: 'a', tag: 'v1', apk: { name: 'a.apk', size: 3, assetId: 9 } };
  assert.ok(sameRelease(previous, { name: 'a' }, { tag_name: 'v1' }, { name: 'a.apk', size: 3, id: 9 }));
  assert.ok(!sameRelease(previous, { name: 'a' }, { tag_name: 'v2' }, { name: 'a.apk', size: 3, id: 9 }));
});

test('el catálogo cambió solo si cambió algo más que la fecha', () => {
  const a = { owner: 'x', generatedAt: '1', apps: [{ repo: 'a' }] };
  assert.ok(!catalogChanged(a, { ...a, generatedAt: '2' }));
  assert.ok(catalogChanged(a, { ...a, apps: [] }));
  assert.ok(catalogChanged(null, a));
});

test('colores de Android', () => {
  assert.equal(cssColor('#6D3FD6'), '#6d3fd6');
  assert.equal(cssColor('#FF6D3FD6'), '#6d3fd6');
  assert.equal(cssColor('#00000000'), null);
  assert.equal(cssColor('#80000000'), 'rgba(0,0,0,0.502)');
  assert.equal(cssColor('@color/fondo', { fondo: '#fff' }), '#ffffff');
});

test('dibujo vectorial a SVG', () => {
  const svg = vectorToSvg(
    '<vector xmlns:android="x" android:viewportWidth="54" android:viewportHeight="54">' +
      '<group android:translateX="2"><path android:pathData="M0,0 L10,10" android:strokeColor="#FFFFFF" android:strokeWidth="3" android:strokeLineCap="round"/></group>' +
      '<path android:pathData="M1,1Z" android:fillColor="#000"/></vector>',
  );
  assert.equal(
    svg,
    '<g transform="scale(2 2)"><g transform="translate(2 0)"><path d="M0,0 L10,10" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/></g><path d="M1,1Z" fill="#000000"/></g>',
  );
  assert.equal(vectorToSvg('<shape/>'), null);
});

test('recursos: primero el ícono adaptable, después los PNG de mayor densidad', () => {
  const res = 'app/src/main/res';
  const paths = [`${res}/mipmap-mdpi/ic_launcher.png`, `${res}/mipmap-xxxhdpi/ic_launcher.png`, `${res}/mipmap-anydpi-v26/ic_launcher.xml`, `${res}/mipmap-xxxhdpi/ic_launcher_round.png`];
  assert.deepEqual(resourceFiles(paths, res, '@mipmap/ic_launcher'), [paths[2], paths[1], paths[0]]);
});

test('ícono adaptable con fondo de color y frente vectorial', async () => {
  const res = 'android/app/src/main/res';
  const files = {
    'android/app/src/main/AndroidManifest.xml': '<manifest><application android:icon="@mipmap/ic_launcher"/></manifest>',
    [`${res}/mipmap-anydpi-v26/ic_launcher.xml`]:
      '<adaptive-icon><background android:drawable="@color/ic_launcher_background"/><foreground android:drawable="@drawable/frente"/></adaptive-icon>',
    [`${res}/drawable/frente.xml`]: '<vector android:viewportWidth="108" android:viewportHeight="108"><path android:pathData="M0,0Z" android:fillColor="#FFF"/></vector>',
    [`${res}/values/ic_launcher_background.xml`]: '<resources><color name="ic_launcher_background">#5B34C9</color></resources>',
  };
  const icon = await resolveIcon({ paths: Object.keys(files), read: async (p) => (files[p] ? Buffer.from(files[p]) : null) });
  const svg = Buffer.from(icon.split(',')[1], 'base64').toString();
  assert.ok(svg.includes('<rect width="108" height="108" fill="#5b34c9"/>'));
  assert.ok(svg.includes('<path d="M0,0Z" fill="#ffffff"/>'));
});

test('sin ícono adaptable, el PNG clásico', async () => {
  const res = 'android/app/src/main/res';
  const files = {
    'android/app/src/main/AndroidManifest.xml': '<manifest><application android:icon="@mipmap/ic_launcher"/></manifest>',
    [`${res}/mipmap-xxxhdpi/ic_launcher.png`]: 'png',
  };
  const icon = await resolveIcon({ paths: Object.keys(files), read: async (p) => (files[p] ? Buffer.from(files[p]) : null) });
  assert.equal(icon, 'data:image/png;base64,' + Buffer.from('png').toString('base64'));
});
