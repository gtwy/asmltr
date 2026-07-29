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
    String q = query.toLowerCase();
    // try exact package first, then fuzzy match on launchable app labels
    Intent direct = pm.getLaunchIntentForPackage(query);
    if (direct != null) { direct.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); ctx.startActivity(direct); return ok(); }
    Intent probe = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
    for (ResolveInfo ri : pm.queryIntentActivities(probe, 0)) {
      String label = String.valueOf(ri.loadLabel(pm)).toLowerCase();
      String pkg = ri.activityInfo.packageName;
      if (label.contains(q) || pkg.toLowerCase().contains(q)) {
        Intent li = pm.getLaunchIntentForPackage(pkg);
        if (li != null) { li.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); ctx.startActivity(li);
          try { JSONObject o = new JSONObject(); o.put("launched", pkg); return ok(o); } catch (Exception e) { return ok(); } }
      }
    }
    return err("no app matching \"" + query + "\"");
  }

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
}
