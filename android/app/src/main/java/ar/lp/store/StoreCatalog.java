package ar.lp.store;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.regex.Pattern;

/**
 * El catálogo de apps y la descarga de sus APK. El catálogo lo arma el workflow "Catálogo" de este repo y lo publica
 * como archivo de la versión "catalogo": bajarlo no cuenta para el límite de la API de GitHub (60 consultas por hora
 * por IP, compartidas por toda la casa).
 *
 * Qué bajar lo decide esta clase, nunca la interfaz: la interfaz solo dice qué repo, y la dirección del APK se arma
 * acá con la dueña fija, el repo, el tag y el nombre del archivo del catálogo, validados. Después se comprueban
 * tamaño y huella SHA-256 (los calculó el workflow bajando ese mismo APK) y que el paquete y la versión sean los
 * anunciados. Además, Android solo lo instala encima de una app si está firmado con la misma clave.
 */
final class StoreCatalog {

    static final String OWNER = "mmunozpatino";
    static final String CATALOG_URL = "https://github.com/" + OWNER + "/lp-store/releases/download/catalogo/catalog.json";
    /** El APK más grande hoy pesa unos 40 MB; más que esto no es nuestro. */
    static final long MAX_BYTES = 300L * 1024 * 1024;
    private static final int MAX_CATALOG_BYTES = 4 * 1024 * 1024;
    private static final Pattern NAME = Pattern.compile("^[A-Za-z0-9._-]{1,100}$");
    private static final Pattern APK_NAME = Pattern.compile("^[A-Za-z0-9._ -]{1,120}\\.apk$", Pattern.CASE_INSENSITIVE);
    private static final Pattern PACKAGE = Pattern.compile("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$");
    private static final Pattern SHA256 = Pattern.compile("^[a-f0-9]{64}$");

    static final class App {
        final String repo;
        final String name;
        final String packageId;
        final String versionName;
        final long versionCode;
        final String url;
        final String sha256;
        final long size;

        App(String repo, String name, String packageId, String versionName, long versionCode, String url, String sha256, long size) {
            this.repo = repo;
            this.name = name;
            this.packageId = packageId;
            this.versionName = versionName;
            this.versionCode = versionCode;
            this.url = url;
            this.sha256 = sha256;
            this.size = size;
        }
    }

    interface Progress {
        void update(long received, long total);
    }

    private StoreCatalog() {}

    /** El catálogo tal como está publicado (texto JSON), comprobando que sea uno. */
    static String fetch() throws Exception {
        HttpURLConnection connection = open(CATALOG_URL);
        connection.setUseCaches(false);
        int code = connection.getResponseCode();
        if (code == 404) throw new IOException("Todavía no hay catálogo publicado. Probá en unos minutos.");
        if (code != 200) throw new IOException("GitHub respondió " + code + " al buscar el catálogo.");
        String text = readAll(connection.getInputStream(), MAX_CATALOG_BYTES);
        JSONObject catalog = new JSONObject(text);
        if (!OWNER.equals(catalog.optString("owner")) || catalog.optJSONArray("apps") == null) {
            throw new IOException("El catálogo publicado no es el esperado.");
        }
        return text;
    }

    /** La app de `repo` en el catálogo, validada. */
    static App find(String catalogText, String repo) throws Exception {
        JSONArray apps = new JSONObject(catalogText).getJSONArray("apps");
        for (int i = 0; i < apps.length(); i++) {
            JSONObject app = apps.getJSONObject(i);
            if (repo.equals(app.optString("repo"))) return validate(app);
        }
        throw new IOException("Esa app ya no está en el catálogo.");
    }

    private static App validate(JSONObject app) throws Exception {
        String repo = app.optString("repo");
        String tag = app.optString("tag");
        String packageId = app.optString("packageId");
        JSONObject apk = app.optJSONObject("apk");
        if (!NAME.matcher(repo).matches() || !NAME.matcher(tag).matches() || apk == null) {
            throw new IOException("El catálogo trae datos inválidos.");
        }
        if (!PACKAGE.matcher(packageId).matches()) throw new IOException("El catálogo trae un paquete inválido.");
        String apkName = apk.optString("name");
        if (!APK_NAME.matcher(apkName).matches()) throw new IOException("El catálogo trae un APK inválido.");
        String sha256 = apk.optString("sha256");
        if (!SHA256.matcher(sha256).matches()) throw new IOException("No se informa la huella del APK: no se puede comprobar.");
        long size = apk.optLong("size", 0);
        if (size <= 0 || size > MAX_BYTES) throw new IOException("El tamaño del APK no es el esperado.");
        long versionCode = app.optLong("versionCode", 0);
        if (versionCode <= 0) throw new IOException("El catálogo no informa la versión.");
        String url = "https://github.com/" + OWNER + "/" + repo + "/releases/download/" + tag + "/"
                + URLEncoder.encode(apkName, "UTF-8").replace("+", "%20");
        return new App(repo, app.optString("name", repo), packageId, app.optString("versionName"), versionCode, url, sha256, size);
    }

    /** Baja el APK a `file` y comprueba tamaño y huella. Si algo falla, borra el archivo. */
    static void download(App app, File file, Progress progress) throws Exception {
        HttpURLConnection connection = open(app.url);
        int code = connection.getResponseCode();
        if (code != 200) throw new IOException("GitHub respondió " + code + " al bajar el APK.");
        MessageDigest sha = MessageDigest.getInstance("SHA-256");
        long received = 0;
        try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) {
                received += read;
                if (received > app.size) throw new IOException("El APK bajado es más grande de lo esperado.");
                sha.update(buffer, 0, read);
                out.write(buffer, 0, read);
                progress.update(received, app.size);
            }
        } catch (Exception e) {
            file.delete();
            throw e;
        }
        if (received != app.size) {
            file.delete();
            throw new IOException("El APK se bajó incompleto.");
        }
        if (!hex(sha.digest()).equals(app.sha256)) {
            file.delete();
            throw new IOException("La huella del APK no coincide: no se instala.");
        }
    }

    /** Solo HTTPS. Sigue las redirecciones de GitHub a su servidor de archivos, que también son HTTPS. */
    private static HttpURLConnection open(String address) throws IOException {
        if (!address.startsWith("https://github.com/")) throw new IOException("Dirección no permitida.");
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        connection.setInstanceFollowRedirects(true);
        connection.setRequestProperty("User-Agent", "LP-Store");
        return connection;
    }

    private static String readAll(InputStream in, int max) throws IOException {
        try (InputStream input = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                if (out.size() + read > max) throw new IOException("El catálogo es más grande de lo esperado.");
                out.write(buffer, 0, read);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder text = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) text.append(String.format("%02x", b));
        return text.toString();
    }
}
