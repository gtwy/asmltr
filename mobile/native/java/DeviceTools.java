package com.asmltr.assistant;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.hardware.camera2.CameraManager;
import android.media.AudioManager;
import android.net.Uri;
import android.os.BatteryManager;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.List;

/**
 * #77 device-control framework — the actual phone actuators the assistant can drive, exposed to the
 * web brain as the `AsmltrDevice` bridge. Each method returns a JSON string {ok, ...} so the web layer
 * can post the result straight back over the connector as a tool result. Kept intentionally small and
 * permission-light; capabilities that need special grants (DND) degrade gracefully with a clear error.
 */
public class DeviceTools {
  private final Context ctx;
  public DeviceTools(Context c) { ctx = c; }

  private String ok() { return "{\"ok\":true}"; }
  private String ok(JSONObject o) { try { o.put("ok", true); } catch (Exception e) {} return o.toString(); }
  private String err(String m) { return "{\"ok\":false,\"error\":" + JSONObject.quote(m) + "}"; }
  private AudioManager audio() { return (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE); }

  /** dispatch(tool, jsonArgs) — single entry point the web calls for a device_rpc. */
  @JavascriptInterface
  public String dispatch(String tool, String argsJson) {
    try {
      JSONObject a = (argsJson != null && !argsJson.isEmpty()) ? new JSONObject(argsJson) : new JSONObject();
      switch (tool) {
        case "set_volume":    return setVolume(a.optString("stream", "media"), a.optInt("percent", -1));
        case "volume_up":     return nudgeVolume(a.optString("stream", "media"), +1);
        case "volume_down":   return nudgeVolume(a.optString("stream", "media"), -1);
        case "get_volume":    return getVolume(a.optString("stream", "media"));
        case "set_ringer":    return setRinger(a.optString("mode", "normal"));
        case "torch":         return torch(a.optBoolean("on", true));
        case "launch_app":    return launchApp(a.optString("query", ""));
        case "open_url":      return openUrl(a.optString("url", ""));
        case "open_setting":  return openSetting(a.optString("screen", ""));
        case "battery":       return battery();
        case "list_apps":     return listApps();
        // ── phase 2: on-screen control (needs the accessibility service enabled) ──
        case "tap":           return gesture(g -> g.tap((float) a.optDouble("x", -1), (float) a.optDouble("y", -1)));
        case "long_press":    return gesture(g -> g.longPress((float) a.optDouble("x", -1), (float) a.optDouble("y", -1)));
        case "swipe":         return gesture(g -> g.swipe((float) a.optDouble("x1", -1), (float) a.optDouble("y1", -1), (float) a.optDouble("x2", -1), (float) a.optDouble("y2", -1), a.optInt("ms", 300)));
        case "tap_text":      return gesture(g -> g.tapText(a.optString("query", "")));
        case "type_text":     return gesture(g -> g.typeText(a.optString("text", "")));
        case "global":        return gesture(g -> g.global(a.optString("action", "")));
        case "read_screen":   return readScreen(a.optInt("max", 120));
        case "screenshot":    return screenshot(a.optInt("max_dim", 1024), a.optInt("quality", 55));
        default:              return err("unknown device tool: " + tool);
      }
    } catch (Exception e) { return err(e.getMessage() == null ? e.toString() : e.getMessage()); }
  }

  private int streamId(String s) {
    switch (s) {
      case "ring": return AudioManager.STREAM_RING;
      case "alarm": return AudioManager.STREAM_ALARM;
      case "call": return AudioManager.STREAM_VOICE_CALL;
      case "notification": return AudioManager.STREAM_NOTIFICATION;
      default: return AudioManager.STREAM_MUSIC; // "media"
    }
  }

  private String setVolume(String stream, int percent) {
    if (percent < 0 || percent > 100) return err("percent must be 0-100");
    AudioManager am = audio(); int sid = streamId(stream);
    int max = am.getStreamMaxVolume(sid);
    int v = Math.round(percent / 100f * max);
    am.setStreamVolume(sid, v, 0);
    try { JSONObject o = new JSONObject(); o.put("stream", stream); o.put("percent", Math.round(v * 100f / max)); return ok(o); } catch (Exception e) { return ok(); }
  }
  private String nudgeVolume(String stream, int dir) {
    AudioManager am = audio(); int sid = streamId(stream);
    am.adjustStreamVolume(sid, dir > 0 ? AudioManager.ADJUST_RAISE : AudioManager.ADJUST_LOWER, AudioManager.FLAG_SHOW_UI);
    return getVolume(stream);
  }
  private String getVolume(String stream) {
    AudioManager am = audio(); int sid = streamId(stream);
    int max = am.getStreamMaxVolume(sid), cur = am.getStreamVolume(sid);
    try { JSONObject o = new JSONObject(); o.put("stream", stream); o.put("percent", max == 0 ? 0 : Math.round(cur * 100f / max)); return ok(o); } catch (Exception e) { return ok(); }
  }
  private String setRinger(String mode) {
    AudioManager am = audio();
    switch (mode) {
      case "silent": am.setRingerMode(AudioManager.RINGER_MODE_SILENT); break;
      case "vibrate": am.setRingerMode(AudioManager.RINGER_MODE_VIBRATE); break;
      default: am.setRingerMode(AudioManager.RINGER_MODE_NORMAL);
    }
    return ok();
  }

  private String torch(boolean on) {
    try {
      CameraManager cm = (CameraManager) ctx.getSystemService(Context.CAMERA_SERVICE);
      String id = null;
      for (String c : cm.getCameraIdList()) {
        Boolean has = cm.getCameraCharacteristics(c).get(android.hardware.camera2.CameraCharacteristics.FLASH_INFO_AVAILABLE);
        if (Boolean.TRUE.equals(has)) { id = c; break; }
      }
      if (id == null) return err("no flash on this device");
      cm.setTorchMode(id, on);
      return ok();
    } catch (Exception e) { return err("torch: " + e.getMessage()); }
  }

  private String launchApp(String query) {
    if (query == null || query.isEmpty()) return err("app query required");
    PackageManager pm = ctx.getPackageManager();
    String q = query.toLowerCase().trim();
    String qtight = q.replaceAll("[^a-z0-9]", ""); // "google maps" ~ "googlemaps"
    // try exact package first
    Intent direct = pm.getLaunchIntentForPackage(query);
    if (direct != null) { direct.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); ctx.startActivity(direct); return launched(query); }
    // fuzzy match on launchable app labels (best UX — matches "spotify" → Spotify)
    int seen = 0;
    for (ResolveInfo ri : pm.queryIntentActivities(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)) {
      seen++;
      String label = String.valueOf(ri.loadLabel(pm)).toLowerCase();
      String pkg = ri.activityInfo.packageName;
      if (label.contains(q) || pkg.toLowerCase().contains(q) || label.replaceAll("[^a-z0-9]", "").contains(qtight)) {
        Intent li = pm.getLaunchIntentForPackage(pkg);
        if (li != null) { li.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); ctx.startActivity(li); return launched(pkg); }
      }
    }
    // fallback: scan ALL installed packages (needs QUERY_ALL_PACKAGES) for a package-name match, then
    // its launch intent — catches apps whose launcher label didn't match the query.
    try {
      for (android.content.pm.ApplicationInfo ai : pm.getInstalledApplications(0)) {
        String pkg = ai.packageName;
        String lbl = String.valueOf(pm.getApplicationLabel(ai)).toLowerCase();
        if (pkg.toLowerCase().contains(q) || lbl.contains(q) || lbl.replaceAll("[^a-z0-9]", "").contains(qtight)) {
          Intent li = pm.getLaunchIntentForPackage(pkg);
          if (li != null) { li.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); ctx.startActivity(li); return launched(pkg); }
        }
      }
    } catch (Exception e) {}
    try { JSONObject o = new JSONObject(); o.put("ok", false); o.put("error", "no app matching \"" + query + "\""); o.put("visible_launcher_apps", seen); return o.toString(); } catch (Exception e) { return err("no match"); }
  }
  private String launched(String pkg) { try { JSONObject o = new JSONObject(); o.put("launched", pkg); return ok(o); } catch (Exception e) { return ok(); } }

  private String openUrl(String url) {
    if (url == null || url.isEmpty()) return err("url required");
    Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    ctx.startActivity(i); return ok();
  }

  private String openSetting(String screen) {
    String action;
    switch (screen == null ? "" : screen) {
      case "wifi": action = Settings.ACTION_WIFI_SETTINGS; break;
      case "bluetooth": action = Settings.ACTION_BLUETOOTH_SETTINGS; break;
      case "display": action = Settings.ACTION_DISPLAY_SETTINGS; break;
      case "sound": action = Settings.ACTION_SOUND_SETTINGS; break;
      case "battery": action = Settings.ACTION_BATTERY_SAVER_SETTINGS; break;
      case "location": action = Settings.ACTION_LOCATION_SOURCE_SETTINGS; break;
      case "apps": action = Settings.ACTION_APPLICATION_SETTINGS; break;
      default: action = Settings.ACTION_SETTINGS;
    }
    ctx.startActivity(new Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); return ok();
  }

  private String battery() {
    try {
      BatteryManager bm = (BatteryManager) ctx.getSystemService(Context.BATTERY_SERVICE);
      int pct = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
      boolean charging = bm.isCharging();
      JSONObject o = new JSONObject(); o.put("percent", pct); o.put("charging", charging); return ok(o);
    } catch (Exception e) { return err("battery: " + e.getMessage()); }
  }

  private String listApps() {
    PackageManager pm = ctx.getPackageManager();
    Intent probe = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
    JSONArray arr = new JSONArray();
    for (ResolveInfo ri : pm.queryIntentActivities(probe, 0)) {
      try { JSONObject o = new JSONObject(); o.put("label", String.valueOf(ri.loadLabel(pm))); o.put("package", ri.activityInfo.packageName); arr.put(o); } catch (Exception e) {}
    }
    try { JSONObject o = new JSONObject(); o.put("apps", arr); return ok(o); } catch (Exception e) { return err(e.getMessage()); }
  }

  // ── phase 2 helpers: route to the accessibility service (the actuator + eyes) ──
  private interface GestureOp { boolean run(AsmltrAccessibilityService g); }
  private static final String A11Y_OFF = "screen control is off — enable the asmltr accessibility service in Settings → Accessibility";
  private String gesture(GestureOp op) {
    AsmltrAccessibilityService svc = AsmltrAccessibilityService.getInstance();
    if (svc == null) return err(A11Y_OFF);
    try { return op.run(svc) ? ok() : err("gesture failed (target not found or off-screen)"); }
    catch (Exception e) { return err(e.getMessage()); }
  }
  private String readScreen(int max) {
    AsmltrAccessibilityService svc = AsmltrAccessibilityService.getInstance();
    if (svc == null) return err(A11Y_OFF);
    try { JSONObject o = new JSONObject(); o.put("nodes", svc.readScreen(Math.min(Math.max(max, 1), 300))); return ok(o); }
    catch (Exception e) { return err(e.getMessage()); }
  }
  private String screenshot(int maxDim, int quality) {
    AsmltrAccessibilityService svc = AsmltrAccessibilityService.getInstance();
    if (svc == null) return err(A11Y_OFF);
    try { return svc.screenshot(Math.min(Math.max(maxDim, 240), 2048), Math.min(Math.max(quality, 20), 90)).toString(); }
    catch (Exception e) { return err(e.getMessage()); }
  }
}
