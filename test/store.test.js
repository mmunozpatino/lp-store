import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appState, formatSize, isNewer, normalizeCatalog, parseNotes, sortApps } from '../ui/store.js';

const app = (over = {}) => ({ repo: 'lp-x', name: 'LP X', packageId: 'ar.lp.x', versionName: '0.1.5', versionCode: 5, ...over });

test('estado de cada app según lo instalado', () => {
  assert.equal(appState(app(), undefined), 'install');
  assert.equal(appState(app(), { versionName: '0.1.3', versionCode: 3 }), 'update');
  assert.equal(appState(app(), { versionName: '0.1.5', versionCode: 5 }), 'current');
  assert.equal(appState(app(), { versionName: '0.1.6', versionCode: 6 }), 'newer');
  assert.equal(appState(app(), { versionName: '0.0.0-dev', versionCode: 1 }), 'dev');
});

test('catálogo: descarta lo inválido y los íconos que no son imágenes', () => {
  assert.equal(normalizeCatalog({ owner: 'otra', apps: [] }), null);
  const catalog = normalizeCatalog({
    owner: 'mmunozpatino',
    apps: [
      { ...app(), apk: { size: 10 }, icon: 'data:image/png;base64,AAAA' },
      { ...app({ repo: 'lp-y' }), icon: 'javascript:alert(1)' },
      { repo: 'roto' },
    ],
  });
  assert.equal(catalog.apps.length, 2);
  assert.equal(catalog.apps[0].icon, 'data:image/png;base64,AAAA');
  assert.equal(catalog.apps[0].size, 10);
  assert.equal(catalog.apps[1].icon, null);
});

test('orden: primero las actualizaciones, después las instaladas', () => {
  const apps = [app({ repo: 'a', name: 'A', packageId: 'a.a' }), app({ repo: 'b', name: 'B', packageId: 'b.b' }), app({ repo: 'c', name: 'C', packageId: 'c.c' })];
  const installed = { 'c.c': { versionName: '0.1.1', versionCode: 1 }, 'b.b': { versionName: '0.1.5', versionCode: 5 } };
  assert.deepEqual(sortApps(apps, installed).map((a) => a.repo), ['c', 'b', 'a']);
});

test('novedades de la release', () => {
  assert.deepEqual(parseNotes('- Uno\n\n  Explicación\n  larga\n\n- Dos\n'), [
    { title: 'Uno', body: 'Explicación larga' },
    { title: 'Dos', body: '' },
  ]);
  assert.deepEqual(parseNotes('Texto suelto'), [{ title: '', body: 'Texto suelto' }]);
  assert.deepEqual(parseNotes(''), []);
});

test('versiones y tamaños', () => {
  assert.ok(isNewer('v0.1.10', '0.1.9'));
  assert.ok(!isNewer('0.1.9', '0.1.9'));
  assert.equal(formatSize(3102661), '3 MB');
  assert.equal(formatSize(40863191), '39 MB');
  assert.equal(formatSize(2048), '2 KB');
});
