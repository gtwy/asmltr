package com.asmltr.assistant;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Bridge for the app + overlay WebViews: connector config (SharedPreferences, merge semantics),
 *  the installed version, and a robust in-app updater via the PackageInstaller session API (no
 *  app-chooser, no FileProvider — streams the APK straight to the system installer + confirm dialog). */
public class NativeConfig {
  private final Context ctx;
  public NativeConfig(Context c) { ctx = c; }

  @JavascriptInterface
  public void saveConfig(String baseUrl, String token, String name) {
    SharedPreferences.Editor e = ctx.getSharedPreferences("asmltr", Context.MODE_PRIVATE).edit();
    if (baseUrl != null && !baseUrl.isEmpty()) e.putString("baseUrl", baseUrl);
    if (token != null && !token.isEmpty()) e.putString("token", token);
    if (name != null && !name.isEmpty()) e.putString("name", name);
    e.apply();
  }

  @JavascriptInterface
  public int getAppVersion() {
    try { return ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionCode; }
    catch (Exception e) { return 0; }
  }

  /** True once the user has granted "draw over other apps" — required for the persistent overlay. */
  @JavascriptInterface
  public boolean canDrawOverlay() {
    return Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(ctx);
  }

  /** Route the user to grant the overlay permission (so the assistant can float over other apps). */
  @JavascriptInterface
  public void requestOverlayPermission() {
    if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(ctx)) {
      Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + ctx.getPackageName()));
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      ctx.startActivity(i);
    }
  }

  /** Manually surface the floating overlay (e.g. a "test overlay" button in the app). */
  @JavascriptInterface
  public void openOverlay() {
    if (!canDrawOverlay()) { requestOverlayPermission(); return; }
    Intent i = new Intent(ctx, OverlayService.class).setAction("com.asmltr.assistant.SHOW");
    if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i); else ctx.startService(i);
  }

  /** Download `url` and install it via a PackageInstaller session. If the app can't yet install
   *  unknown apps, route the user to grant that first (they re-tap Update after). */
  @JavascriptInterface
  public void installUpdate(final String url) {
    if (Build.VERSION.SDK_INT >= 26 && !ctx.getPackageManager().canRequestPackageInstalls()) {
      Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.getPackageName()));
      s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      ctx.startActivity(s);
      return;
    }
    new Thread(new Runnable() { public void run() {
      try {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(true); c.connect();
        InputStream in = c.getInputStream();
        PackageInstaller pi = ctx.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        int sid = pi.createSession(params);
        PackageInstaller.Session session = pi.openSession(sid);
        OutputStream out = session.openWrite("asmltr", 0, -1);
        byte[] b = new byte[65536]; int n; while ((n = in.read(b)) > 0) out.write(b, 0, n);
        session.fsync(out); out.close(); in.close(); c.disconnect();
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
        Intent cb = new Intent(ctx, InstallReceiver.class);
        PendingIntent pending = PendingIntent.getBroadcast(ctx, sid, cb, flags);
        session.commit(pending.getIntentSender());
      } catch (Exception e) { /* toast handled by the receiver on failure paths */ }
    } }).start();
  }
}
