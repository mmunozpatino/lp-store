# LP Store

Un solo lugar para instalar, abrir y actualizar las apps Android de la usuaria publicadas en GitHub. App Android
(celular y tablet) hecha con Capacitor 8: la pantalla es HTML/JS sin compilar en `ui/` y la parte nativa, `android/`.
Base copiada de LP Exchange (`C:\Develop\lp-cambio`). Diseño en línea con LP Cine Vault: oscuro por defecto,
violeta `#9b5cff` de acento y verde para "al día" (mismos tokens en `ui/styles.css`, con su versión clara).

## Catálogo
- **Automático:** aparece todo repo **público** de `mmunozpatino` (no fork ni archivado) cuya última versión
  publicada trae un `.apk`. No hay que tocar nada en la tienda ni en las apps.
- Lo arma `.github/workflows/catalog.yml` (cada 30 minutos, a mano y después de cada versión de LP Store) con
  `scripts/catalog.mjs` y lo publica como `catalog.json` en la versión `catalogo` del repo (pre-release, no cuenta
  como "latest"). Solo lo vuelve a subir si cambió algo.
- Por app guarda: nombre (el del APK), descripción (la del repo), paquete, `versionName`, `versionCode`, tag,
  novedades (texto de la release), tamaño y SHA-256 del APK (calculados bajando ese APK; si GitHub informa `digest`,
  tiene que coincidir) e ícono. Paquete, versión y nombre salen de `aapt2 dump badging`. Solo baja el APK de las apps
  que cambiaron de versión; las demás se reusan del catálogo anterior.
- **Íconos:** Android acorta los nombres de recursos dentro del APK (`res/BW.xml`), así que salen del código del repo
  en ese tag (`scripts/catalog-lib.mjs`, `resolveIcon`): el ícono adaptable del manifiesto (fondo + frente, cada
  uno color, dibujo vectorial o PNG) armado como SVG, o el PNG clásico. Si la app está instalada, la tienda muestra el
  ícono real que le da Android.
- Las tareas programadas de GitHub se pausan si el repo pasa 60 días sin actividad: si el catálogo deja de
  actualizarse, correr "Catálogo" a mano desde Actions (o hacer un push).

## Instalar y actualizar
- La pantalla no habla con GitHub. `LpStorePlugin.java` + `StoreCatalog.java` bajan el catálogo, informan qué hay
  instalado (`<queries>` de apps del lanzador en el manifiesto; versión, ícono y si se puede abrir) e instalan.
- Para instalar, la pantalla solo dice el repo. La parte nativa vuelve a bajar el catálogo, arma la dirección
  (`github.com/mmunozpatino/<repo>/releases/download/<tag>/<apk>`, todo validado), baja el APK, comprueba tamaño y
  SHA-256, y que paquete y `versionCode` sean los anunciados. Después abre el instalador de Android (siempre pide
  confirmar). Si la app instalada está firmada con otra clave (por ejemplo, una versión de desarrollo), Android no la
  instala encima: hay que desinstalarla.
- Estados (`ui/store.js`, `appState`): sin instalar, actualización (`versionCode` menor), al día, desarrollo
  (`versionName` con "dev") y más nueva que la publicada.

## Desarrollo
- `npm test`: lógica de la tienda (`ui/store.js`) y del catálogo (`scripts/catalog-lib.mjs`).
- `npm run dev`: la pantalla en http://localhost:5174 (`/dev/catalog.json` trae el catálogo publicado; con
  `--catalog <archivo>`, uno local). `?instaladas=ar.lp.exchange:3,ar.lp.mediacenter:21` simula apps instaladas.
- Catálogo local: `GH_TOKEN=$(gh auth token) node scripts/catalog.mjs --owner mmunozpatino --aapt2 <aapt2.exe> --out dist/catalog.json`
  (aapt2 en `%LOCALAPPDATA%\Android\Sdk\build-tools\<versión>\`).
- `npm run apk`: APK en `dist\LP Store.apk`. **Gradle solo corre desde una pestaña del panel Terminal** (en la
  consola aislada falla con "Unable to establish loopback connection").
- "Atrás" de Android: cada diálogo agrega un paso al historial y `MainActivity` hace `goBack()` si se puede.

## Versiones y actualizaciones de LP Store
Igual que las demás apps (ver CLAUDE.md global): cada push a `main` corre `.github/workflows/version.yml` (tests,
APK firmado, release `v0.1.<corrida>` con `LP-Store.apk`). `scripts/build-info.mjs` escribe `ui/build-info.json` y
`ui/changelog.json` (no se commitean; sin ellos la app es de desarrollo y no se ofrece actualizarse).
- LP Store se actualiza con el mismo catálogo: aparece en su propia lista ("Esta app"), avisa con un diálogo una vez
  por versión, y Ajustes tiene "Buscar actualizaciones", "Actualizar ahora", las novedades de la versión instalada y
  "Ver versiones anteriores en GitHub". Después de actualizarse muestra sus novedades una vez.
- **Novedades = mensajes de commit**, públicos y leídos en la app: en español, entendibles, sin datos personales.
- **Firma:** `~/.lp-store-firma` (`lp-release.jks`, `clave.txt`), fuera del repo; en GitHub, secretos
  `ANDROID_KEYSTORE_BASE64` y `ANDROID_KEYSTORE_PASSWORD`. Si se pierde, hay que desinstalar en cada dispositivo.
