package com.asmltr.assistant;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.IBinder;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import org.json.JSONObject;

/**
 * The persistent control link. A foreground service that holds a long-lived SSE to the android
 * connector's /gw/control and executes device_rpc frames NATIVELY (via DeviceTools) — so any agent
 * session can actuate the phone even when the overlay/app is closed. Independent of the WebView, so
 * closing the assistant UI no longer drops the connection. Dependency-free (HttpURLConnection SSE
 * reader); reconnects with backoff; started on app-open and on boot.
 */
public class DeviceControlService extends Service {
  static final String ACTION_START = "com.asmltr.assistant.CONTROL_START";
  static final String ACTION_STOP = "com.asmltr.assistant.CONTROL_STOP";
  private static final String CH = "asmltr_control";
  private volatile boolean running = false;
  private Thread worker;
  private DeviceTools tools;

  @Override public IBinder onBind(Intent i) { return null; }

  @Override public void onCreate() {
    super.onCreate();
    tools = new DeviceTools(this);
    startForeground(43, buildNotification("Connecting…"));
  }

  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null && ACTION_STOP.equals(intent.getAction())) { running = false; stopSelf(); return START_NOT_STICKY; }
    if (!running) { running = true; worker = new Thread(this::loop, "asmltr-control"); worker.start(); }
    return START_STICKY; // Android restarts us if killed → the link is meant to be always-on
  }

  private SharedPreferences prefs() { return getSharedPreferences("asmltr", Context.MODE_PRIVATE); }

  private void loop() {
    int backoff = 2000;
    while (running) {
      SharedPreferences p = prefs();
      String base = p.getString("baseUrl", ""), token = p.getString("token", ""), name = p.getString("name", "android");
      String device = NativeConfig.deviceId(this);
      if (base.isEmpty() || token.isEmpty()) { sleep(5000); continue; } // not configured yet
      HttpURLConnection c = null;
      try {
        String url = base + "/gw/control?token=" + enc(token) + "&device=" + enc(device) + "&name=" + enc(name);
        c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestProperty("Accept", "text/event-stream");
        c.setConnectTimeout(15000); c.setReadTimeout(0); // no read timeout — it's a long-lived stream
        c.connect();
        if (c.getResponseCode() != 200) { updateNote("Auth/failed (" + c.getResponseCode() + ")"); sleep(backoff); backoff = Math.min(backoff * 2, 60000); continue; }
        updateNote("Connected"); backoff = 2000;
        BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
        String line;
        while (running && (line = r.readLine()) != null) {
          if (!line.startsWith("data:")) continue;
          String payload = line.substring(5).trim();
          if (payload.isEmpty()) continue;
          try {
            JSONObject o = new JSONObject(payload);
            if ("device_rpc".equals(o.optString("type"))) handleRpc(base, token, device, o);
          } catch (Exception ignore) {}
        }
      } catch (Exception e) {
        updateNote("Reconnecting…");
      } finally { if (c != null) try { c.disconnect(); } catch (Exception e) {} }
      if (running) { sleep(backoff); backoff = Math.min(backoff * 2, 60000); }
    }
  }

  private void handleRpc(String base, String token, String device, JSONObject o) {
    final String id = o.optString("id");
    final String tool = o.optString("tool");
    final JSONObject args = o.optJSONObject("args");
    // DeviceTools returns a JSON string {ok,...}. Run on the main thread — many actuators (launch app,
    // torch, volume UI) expect to be called from the UI thread.
    final String[] out = new String[1];
    final Object lock = new Object();
    android.os.Handler h = new android.os.Handler(getMainLooper());
    h.post(() -> { String r; try { r = tools.dispatch(tool, args != null ? args.toString() : "{}"); } catch (Exception e) { r = "{\"ok\":false,\"error\":\"" + e.getMessage() + "\"}"; } synchronized (lock) { out[0] = r; lock.notifyAll(); } });
    synchronized (lock) { long end = System.currentTimeMillis() + 15000; while (out[0] == null && System.currentTimeMillis() < end) { try { lock.wait(200); } catch (InterruptedException e) { break; } } }
    postResult(base, token, device, id, out[0] != null ? out[0] : "{\"ok\":false,\"error\":\"timeout\"}");
  }

  private void postResult(String base, String token, String device, String id, String resultJson) {
    HttpURLConnection c = null;
    try {
      c = (HttpURLConnection) new URL(base + "/gw/rpc-result").openConnection();
      c.setRequestMethod("POST"); c.setDoOutput(true);
      c.setRequestProperty("Content-Type", "application/json");
      c.setConnectTimeout(10000); c.setReadTimeout(10000);
      JSONObject body = new JSONObject();
      body.put("token", token); body.put("device", device); body.put("id", id);
      try { body.put("result", new JSONObject(resultJson)); } catch (Exception e) { body.put("result", resultJson); }
      OutputStream os = c.getOutputStream(); os.write(body.toString().getBytes("UTF-8")); os.close();
      c.getResponseCode(); // fire
    } catch (Exception e) { /* the connector times the RPC out if we can't answer */ }
    finally { if (c != null) try { c.disconnect(); } catch (Exception e) {} }
  }

  private static String enc(String s) { try { return URLEncoder.encode(s, "UTF-8"); } catch (Exception e) { return ""; } }
  private void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException e) {} }

  private Notification buildNotification(String text) {
    if (Build.VERSION.SDK_INT >= 26) {
      NotificationChannel ch = new NotificationChannel(CH, "Assistant device link", NotificationManager.IMPORTANCE_MIN);
      ch.setShowBadge(false);
      ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(ch);
    }
    Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH) : new Notification.Builder(this);
    return b.setContentTitle("Assistant device link").setContentText(text)
      .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth).setOngoing(true).build();
  }
  private void updateNote(String text) {
    try { ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(43, buildNotification(text)); } catch (Exception e) {}
  }

  @Override public void onDestroy() { running = false; if (worker != null) worker.interrupt(); super.onDestroy(); }
}
