package ar.lp.store;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Lo que la interfaz no puede hacer sola: bajar el catálogo, saber qué apps y qué versiones hay instaladas, bajar e
 * instalar un APK comprobado (StoreCatalog), abrir una app y abrir una página de GitHub en el navegador.
 */
@CapacitorPlugin(name = "LpStore")
public class LpStorePlugin extends Plugin {

    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final ExecutorService downloads = Executors.newSingleThreadExecutor();
    private volatile boolean installing = false;

    private static String message(Exception e, String fallback) {
        return e instanceof IOException && e.getMessage() != null ? e.getMessage() : fallback;
    }

    /** { json }: el catálogo publicado, como texto. */
    @PluginMethod
    public void catalog(PluginCall call) {
        network.execute(() -> {
            try {
                JSObject result = new JSObject();
                result.put("json", StoreCatalog.fetch());
                call.resolve(result);
            } catch (Exception e) {
                call.reject(message(e, "No se pudo bajar el catálogo. Revisá la conexión."));
            }
        });
    }

    /**
     * { self, apps }: el paquete de esta app y, para cada paquete pedido que esté instalado,
     * { versionName, versionCode, icon (PNG en base64), launchable }.
     */
    @PluginMethod
    public void installed(PluginCall call) {
        JSArray packages = call.getArray("packages", new JSArray());
        Context context = getContext();
        PackageManager pm = context.getPackageManager();
        JSObject apps = new JSObject();
        for (int i = 0; i < packages.length(); i++) {
            String packageId = packages.optString(i, "");
            if (packageId.isEmpty()) continue;
            try {
                PackageInfo info = pm.getPackageInfo(packageId, 0);
                JSObject app = new JSObject();
                app.put("versionName", info.versionName);
                app.put("versionCode", Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode);
                app.put("launchable", pm.getLaunchIntentForPackage(packageId) != null);
                String icon = iconOf(info.applicationInfo.loadIcon(pm));
                if (icon != null) app.put("icon", icon);
                apps.put(packageId, app);
            } catch (PackageManager.NameNotFoundException e) {
                // No está instalada.
            }
        }
        JSObject result = new JSObject();
        result.put("self", context.getPackageName());
        result.put("apps", apps);
        call.resolve(result);
    }

    /** El ícono que muestra Android (incluido el adaptable, con su forma) como PNG de 144x144 en base64. */
    private static String iconOf(Drawable drawable) {
        try {
            int size = 144;
            Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);
            drawable.setBounds(0, 0, size, size);
            drawable.draw(canvas);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
            return "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * "Instalar" / "Actualizar" la app de `repo`: vuelve a bajar el catálogo, baja el APK, lo comprueba y abre el
     * cartel de instalación de Android, que siempre pide confirmar. Responde varias veces:
     * { state: "progress", received, total } mientras baja y { state: "installing", version } al abrir el cartel.
     * Si Android todavía no deja que esta app instale, abre ese ajuste y responde { state: "permission" }.
     */
    @PluginMethod(returnType = PluginMethod.RETURN_CALLBACK)
    public void install(PluginCall call) {
        String repo = call.getString("repo", "");
        Context context = getContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.getPackageManager().canRequestPackageInstalls()) {
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.getPackageName()));
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(settings);
            JSObject result = new JSObject();
            result.put("state", "permission");
            call.resolve(result);
            return;
        }
        if (installing) {
            call.reject("Ya se está instalando otra app. Esperá a que termine.");
            return;
        }
        installing = true;
        call.setKeepAlive(true);
        downloads.execute(() -> {
            try {
                StoreCatalog.App app = StoreCatalog.find(StoreCatalog.fetch(), repo);
                File dir = new File(context.getCacheDir(), "descargas");
                File[] old = dir.listFiles();
                if (old != null) for (File file : old) file.delete();
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("No se pudo guardar el APK.");
                File apk = new File(dir, app.repo + "-" + app.versionCode + ".apk");
                final int[] lastPercent = { -1 };
                StoreCatalog.download(app, apk, (received, total) -> {
                    int percent = (int) (received * 100 / total);
                    if (percent == lastPercent[0]) return;
                    lastPercent[0] = percent;
                    JSObject progress = new JSObject();
                    progress.put("state", "progress");
                    progress.put("received", received);
                    progress.put("total", total);
                    call.resolve(progress);
                });
                checkArchive(context, apk, app);
                Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", apk);
                Intent install = new Intent(Intent.ACTION_VIEW);
                install.setDataAndType(uri, "application/vnd.android.package-archive");
                install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(install);
                JSObject result = new JSObject();
                result.put("state", "installing");
                result.put("version", app.versionName);
                call.setKeepAlive(false);
                call.resolve(result);
            } catch (Exception e) {
                android.util.Log.w("LpStore", "Instalación", e);
                call.setKeepAlive(false);
                call.reject(message(e, "No se pudo instalar. Revisá la conexión a internet."));
            } finally {
                installing = false;
            }
        });
    }

    /** El APK bajado tiene que ser el paquete y la versión que anuncia el catálogo. */
    private static void checkArchive(Context context, File apk, StoreCatalog.App app) throws IOException {
        PackageInfo info = context.getPackageManager().getPackageArchiveInfo(apk.getPath(), 0);
        long versionCode = info == null ? -1 : (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode);
        if (info == null || !app.packageId.equals(info.packageName) || versionCode != app.versionCode) {
            apk.delete();
            throw new IOException("El APK bajado no es la app anunciada: no se instala.");
        }
    }

    /** Abre una app instalada. */
    @PluginMethod
    public void launch(PluginCall call) {
        String packageId = call.getString("packageId", "");
        Intent intent = getContext().getPackageManager().getLaunchIntentForPackage(packageId);
        if (intent == null) {
            call.reject("No se puede abrir esa app.");
            return;
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    /** Abre una página de GitHub de la dueña de las apps. Cualquier otra dirección se rechaza. */
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("https://github.com/" + StoreCatalog.OWNER + "/")) {
            call.reject("Dirección no permitida");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }
}
