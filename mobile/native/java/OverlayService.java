package com.asmltr.assistant;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.IBinder;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import org.json.JSONObject;

/**
 * The TRUE persistent overlay: a foreground service that draws the assistant WebView in a
 * TYPE_APPLICATION_OVERLAY window. Unlike a VoiceInteractionSession (whose window dies on
 * swipe-home), this survives leaving the app — so a minimized bubble stays put and a reply keeps
 * being read aloud even when collapsed. Expanded → a full-screen focusable window (keyboard works,
 * hardware-back minimizes). Minimized → a tiny bottom-right window so the app behind stays usable.
 */
public class OverlayService extends Service {
  static final String ACTION_SHOW = "com.asmltr.assistant.SHOW";
  static final String ACTION_LISTEN = "com.asmltr.assistant.LISTEN";
  static final String ACTION_CLOSE = "com.asmltr.assistant.CLOSE";
  private static final String CH = "asmltr_overlay";
  private WindowManager wm;
  private FrameLayout root;
  private WebView web;
  private boolean added = false, minimized = false;

  private int dp(int v) { return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()); }

  @Override public IBinder onBind(Intent i) { return null; }

  @Override public void onCreate() {
    super.onCreate();
    startForeground(42, buildNotification());
    wm = (WindowManager) getSystemService(WINDOW_SERVICE);
    createWeb();
  }

  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    final String action = intent != null ? intent.getAction() : ACTION_SHOW;
    if (ACTION_CLOSE.equals(action)) { stopSelf(); return START_NOT_STICKY; }
    ensureAdded();
    setMinimizedInternal(false);
    if (web != null) web.post(new Runnable() { public void run() {
      // (re)start a listening turn on the assist gesture; a plain SHOW just surfaces the card
      String js = ACTION_LISTEN.equals(action)
        ? "window.__ASMLTR_ASSIST=true; if(window.asmltrExpand)window.asmltrExpand(); if(window.asmltrStartListening)window.asmltrStartListening();"
        : "if(window.asmltrExpand)window.asmltrExpand();";
      web.evaluateJavascript(js, null);
    } });
    return START_STICKY;
  }

  @SuppressLint("SetJavaScriptEnabled")
  private void createWeb() {
    root = new FrameLayout(this) {
      @Override public boolean dispatchKeyEvent(KeyEvent e) {
        // hardware back collapses the card instead of killing the overlay
        if (e.getKeyCode() == KeyEvent.KEYCODE_BACK && e.getAction() == KeyEvent.ACTION_UP && !minimized) {
          if (web != null) web.evaluateJavascript("if(window.asmltrMinimize)window.asmltrMinimize();", null);
          return true;
        }
        return super.dispatchKeyEvent(e);
      }
    };
    root.setBackgroundColor(Color.TRANSPARENT);
    web = new WebView(this);
    web.setBackgroundColor(Color.TRANSPARENT);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false); // TTS/cues autoplay
    web.addJavascriptInterface(new NativeConfig(this), "AsmltrNative");
    web.addJavascriptInterface(new DeviceTools(this), "AsmltrDevice"); // #77 phone control
    web.addJavascriptInterface(new OverlayBridge(), "AsmltrOverlay");
    web.setWebChromeClient(new WebChromeClient() {
      @Override public void onPermissionRequest(PermissionRequest r) { r.grant(r.getResources()); }
    });
    final String cfg = configJs();
    web.setWebViewClient(new WebViewClient() {
      @Override public void onPageStarted(WebView v, String url, Bitmap fav) { v.evaluateJavascript(cfg, null); }
    });
    web.loadUrl("file:///android_asset/public/assistant.html?overlay=1&native=1");
    root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
  }

  private WindowManager.LayoutParams params(boolean min) {
    int type = Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY : WindowManager.LayoutParams.TYPE_PHONE;
    WindowManager.LayoutParams lp = new WindowManager.LayoutParams();
    lp.type = type; lp.format = PixelFormat.TRANSLUCENT;
    if (min) {
      // tiny corner window → the rest of the screen passes through to the app behind
      lp.width = dp(120); lp.height = dp(120);
      lp.gravity = Gravity.BOTTOM | Gravity.END;
      lp.flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN;
    } else {
      // expanded: focusable full-screen so the keyboard works; resizes for the soft keyboard
      lp.width = WindowManager.LayoutParams.MATCH_PARENT; lp.height = WindowManager.LayoutParams.MATCH_PARENT;
      lp.gravity = Gravity.TOP | Gravity.START;
      lp.flags = WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN;
      lp.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;
    }
    return lp;
  }

  private void ensureAdded() {
    if (added) return;
    try { wm.addView(root, params(minimized)); added = true; }
    catch (Exception e) { /* SYSTEM_ALERT_WINDOW not granted → nothing to draw */ stopSelf(); }
  }

  private void setMinimizedInternal(boolean min) {
    minimized = min;
    if (added) try { wm.updateViewLayout(root, params(min)); } catch (Exception e) {}
  }

  /** JS → native overlay controls (called by the web brain in native mode). */
  private class OverlayBridge {
    @android.webkit.JavascriptInterface public void setMinimized(final boolean min) {
      if (root != null) root.post(new Runnable() { public void run() { setMinimizedInternal(min); } });
    }
    @android.webkit.JavascriptInterface public void close() {
      if (root != null) root.post(new Runnable() { public void run() { stopSelf(); } });
    }
  }

  private String configJs() {
    SharedPreferences p = getSharedPreferences("asmltr", Context.MODE_PRIVATE);
    JSONObject o = new JSONObject();
    try {
      o.put("baseUrl", p.getString("baseUrl", ""));
      o.put("token", p.getString("token", ""));
      o.put("name", p.getString("name", "assistant"));
    } catch (Exception e) {}
    return "window.__ASMLTR_NATIVE_CFG=" + o.toString() + ";";
  }

  private Notification buildNotification() {
    if (Build.VERSION.SDK_INT >= 26) {
      NotificationChannel c = new NotificationChannel(CH, "Assistant overlay", NotificationManager.IMPORTANCE_LOW);
      c.setShowBadge(false);
      ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(c);
    }
    Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH) : new Notification.Builder(this);
    return b.setContentTitle("Assistant")
      .setContentText("Floating assistant is active")
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setOngoing(true).build();
  }

  @Override public void onDestroy() {
    try { if (added && root != null) wm.removeView(root); } catch (Exception e) {}
    try { if (web != null) { web.loadUrl("about:blank"); web.destroy(); } } catch (Exception e) {}
    added = false;
    super.onDestroy();
  }
}
