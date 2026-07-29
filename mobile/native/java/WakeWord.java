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
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.json.JSONObject;
import org.vosk.Model;
import org.vosk.Recognizer;
import org.vosk.android.RecognitionListener;
import org.vosk.android.SpeechService;

/**
 * Always-on wake word via Vosk — OFFLINE keyword spotting. The phrase is a runtime grammar string, so it's
 * fully configurable in Settings with NO per-phrase model generation and nothing leaving the device (one
 * ~40MB model, downloaded once, covers every phrase). Runs inside the persistent DeviceControlService
 * (always-on, screen-off). On a match it fires the overlay in listen mode; mic handoff via
 * OverlayService.setAwake → pause()/resume() so the wake listener and the turn recorder never fight the mic.
 * Heavily guarded: any failure (wake off, no model, Vosk error) leaves it inert — it never crashes the service.
 */
public class WakeWord {
  private static SpeechService speech;
  private static Model model;
  private static boolean enabled = false, paused = false, usePartial = false;
  private static String activePhrase = "";
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
    String phrase = cfg.optString("phrase", "").toLowerCase().trim().replaceAll("[^a-z0-9 ]", "").trim();
    String modelUrl = cfg.optString("model_url", "");
    String modelId = cfg.optString("model_id", "vosk-model");
    usePartial = cfg.optDouble("sensitivity", 50) >= 60; // higher = trigger on partials (faster, more false-accepts)
    if (!en || phrase.isEmpty() || modelUrl.isEmpty()) { stop(); return; }
    if (speech != null && enabled && phrase.equals(activePhrase)) return; // already listening for this phrase
    File dir = ensureModel(modelUrl, modelId);
    stopSpeech();
    if (model == null) model = new Model(dir.getAbsolutePath());
    // Grammar restricts recognition to the phrase (+ [unk]) → efficient keyword spotting.
    Recognizer rec = new Recognizer(model, 16000.0f, "[\"" + phrase + "\", \"[unk]\"]");
    speech = new SpeechService(rec, 16000.0f);
    enabled = true; activePhrase = phrase;
    if (!paused) startListening(phrase);
  }

  private static void startListening(final String phrase) {
    speech.startListening(new RecognitionListener() {
      @Override public void onResult(String h) { if (matches(h, phrase)) onWake(); }
      @Override public void onFinalResult(String h) { if (matches(h, phrase)) onWake(); }
      @Override public void onPartialResult(String h) { if (usePartial && matches(h, phrase)) onWake(); }
      @Override public void onError(Exception e) {}
      @Override public void onTimeout() {}
    });
  }
  private static boolean matches(String json, String phrase) { return json != null && json.toLowerCase().contains(phrase); }

  private static void onWake() {
    try {
      Intent i = new Intent(appCtx, OverlayService.class).setAction(OverlayService.ACTION_LISTEN);
      if (Build.VERSION.SDK_INT >= 26) appCtx.startForegroundService(i); else appCtx.startService(i);
    } catch (Exception e) {}
    // the overlay's setAwake(true) pauses us so its recorder gets the mic; setAwake(false) resumes us.
  }

  /** Overlay is about to use the mic → free it. */
  static synchronized void pause() { paused = true; stopSpeech(); }
  /** Overlay is done → resume listening. */
  static synchronized void resume() { paused = false; if (enabled && speech == null && appCtx != null) refresh(appCtx); }
  static synchronized void stop() { stopSpeech(); try { if (model != null) model.close(); } catch (Exception e) {} model = null; enabled = false; activePhrase = ""; }
  private static void stopSpeech() { try { if (speech != null) { speech.stop(); speech.shutdown(); } } catch (Exception e) {} speech = null; }

  // ── model provisioning (download once, unzip to files dir) ──
  private static File ensureModel(String url, String modelId) throws Exception {
    File dir = new File(appCtx.getFilesDir(), modelId);
    if (dir.isDirectory() && new File(dir, "conf").exists()) return dir; // already unpacked
    File zip = new File(appCtx.getCacheDir(), modelId + ".zip");
    download(url, zip);
    unzip(zip, appCtx.getFilesDir());
    try { zip.delete(); } catch (Exception e) {}
    if (!dir.isDirectory()) { // some zips nest differently — find the dir that has a conf/
      File[] kids = appCtx.getFilesDir().listFiles();
      if (kids != null) for (File k : kids) if (k.isDirectory() && new File(k, "conf").exists()) return k;
    }
    return dir;
  }
  private static void unzip(File zip, File dest) throws Exception {
    try (ZipInputStream zis = new ZipInputStream(new java.io.BufferedInputStream(new java.io.FileInputStream(zip)))) {
      ZipEntry e; byte[] buf = new byte[8192];
      while ((e = zis.getNextEntry()) != null) {
        File out = new File(dest, e.getName());
        if (!out.getCanonicalPath().startsWith(dest.getCanonicalPath())) continue; // zip-slip guard
        if (e.isDirectory()) { out.mkdirs(); continue; }
        out.getParentFile().mkdirs();
        try (FileOutputStream fo = new FileOutputStream(out)) { int n; while ((n = zis.read(buf)) > 0) fo.write(buf, 0, n); }
      }
    }
  }

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
    c.setConnectTimeout(15000); c.setReadTimeout(120000); c.setInstanceFollowRedirects(true);
    if (c.getResponseCode() != 200) { c.disconnect(); throw new Exception("model http " + c.getResponseCode()); }
    InputStream in = c.getInputStream(); FileOutputStream fo = new FileOutputStream(out);
    byte[] b = new byte[16384]; int n; while ((n = in.read(b)) > 0) fo.write(b, 0, n);
    fo.close(); in.close(); c.disconnect();
  }
}
