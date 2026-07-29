package com.asmltr.assistant;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import org.json.JSONObject;
import ai.picovoice.porcupine.PorcupineManager;

/**
 * Always-on wake word via Porcupine. Runs inside the persistent DeviceControlService so "hey <name>"
 * works with the screen off. Config + the runtime access key + the keyword model come from the connector
 * (/gw/wake + /gw/wake-model), so the phrase is set in the web GUI. Heavily guarded: any failure (wake
 * off, no access key, no .ppn model for the phrase, Porcupine init error) just leaves it inert — it never
 * takes down the service. Mic handoff: the overlay pauses us while it's actively listening (setAwake),
 * then resumes us, so the wake listener and the turn recorder never fight over the microphone.
 */
public class WakeWord {
  private static PorcupineManager mgr;
  private static boolean enabled = false, paused = false;
  private static String activeSlug = "";
  private static Context appCtx;

  static void refresh(Context ctx) {
    appCtx = ctx.getApplicationContext();
    new Thread(() -> { try { configure(); } catch (Throwable t) { /* stay inert on any error */ } }, "asmltr-wake").start();
  }

  private static synchronized void configure() throws Exception {
    SharedPreferences p = appCtx.getSharedPreferences("asmltr", Context.MODE_PRIVATE);
    String base = p.getString("baseUrl", ""), token = p.getString("token", "");
    if (base.isEmpty() || token.isEmpty()) { stop(); return; }
    JSONObject cfg = getJson(base + "/gw/wake?token=" + enc(token));
    boolean en = cfg.optBoolean("enabled", false);
    String accessKey = cfg.optString("access_key", "");
    boolean hasModel = cfg.optBoolean("has_model", false);
    String phrase = cfg.optString("phrase", "");
    String slug = cfg.optString("slug", "");
    float sens = (float) Math.max(0, Math.min(1, cfg.optDouble("sensitivity", 50) / 100.0));
    if (!en || accessKey.isEmpty() || !hasModel) { stop(); enabled = false; return; }
    if (mgr != null && enabled && slug.equals(activeSlug)) return; // already running this phrase
    // download the keyword model for the current phrase
    File ppn = new File(appCtx.getFilesDir(), "wake-" + slug + ".ppn");
    if (!ppn.exists()) download(base + "/gw/wake-model?token=" + enc(token) + "&phrase=" + enc(phrase), ppn);
    stop();
    mgr = new PorcupineManager.Builder()
      .setAccessKey(accessKey)
      .setKeywordPath(ppn.getAbsolutePath())
      .setSensitivity(sens)
      .build(appCtx, (keywordIndex) -> onWake());
    enabled = true; activeSlug = slug;
    if (!paused) mgr.start();
  }

  private static void onWake() {
    // Fire the overlay in listen mode (same as the assist gesture). The overlay's setAwake(true) will
    // pause us so its recorder gets the mic; setAwake(false) resumes us afterward.
    try {
      Intent i = new Intent(appCtx, OverlayService.class).setAction(OverlayService.ACTION_LISTEN);
      if (Build.VERSION.SDK_INT >= 26) appCtx.startForegroundService(i); else appCtx.startService(i);
    } catch (Exception e) {}
  }

  /** Overlay is about to use the mic → free it. */
  static synchronized void pause() { paused = true; try { if (mgr != null) mgr.stop(); } catch (Exception e) {} }
  /** Overlay is done → resume listening for the wake word. */
  static synchronized void resume() { paused = false; try { if (mgr != null && enabled) mgr.start(); } catch (Exception e) {} }
  static synchronized void stop() { try { if (mgr != null) { mgr.stop(); mgr.delete(); } } catch (Exception e) {} mgr = null; enabled = false; activeSlug = ""; }

  // ── tiny HTTP helpers ──
  private static String enc(String s) { try { return URLEncoder.encode(s, "UTF-8"); } catch (Exception e) { return ""; } }
  private static JSONObject getJson(String url) throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
    c.setConnectTimeout(10000); c.setReadTimeout(10000);
    InputStream in = c.getInputStream();
    java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
    byte[] b = new byte[4096]; int n; while ((n = in.read(b)) > 0) bo.write(b, 0, n);
    in.close(); c.disconnect();
    return new JSONObject(bo.toString("UTF-8"));
  }
  private static void download(String url, File out) throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
    c.setConnectTimeout(10000); c.setReadTimeout(20000); c.setInstanceFollowRedirects(true);
    if (c.getResponseCode() != 200) { c.disconnect(); throw new Exception("model http " + c.getResponseCode()); }
    InputStream in = c.getInputStream(); FileOutputStream fo = new FileOutputStream(out);
    byte[] b = new byte[8192]; int n; while ((n = in.read(b)) > 0) fo.write(b, 0, n);
    fo.close(); in.close(); c.disconnect();
  }
}
