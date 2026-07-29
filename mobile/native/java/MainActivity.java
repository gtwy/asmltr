package com.asmltr.assistant;
import android.Manifest;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.webkit.WebView;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.BridgeActivity;
/** The app shell — loads the embedded dashboard. Enables WebView WebAuthn so passkeys work in-app
 *  (paired with the /.well-known/assetlinks.json Digital Asset Links on the host), and exposes
 *  AsmltrNative so config persists to SharedPreferences for the system overlay session. */
public class MainActivity extends BridgeActivity {
  @Override public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[]{ Manifest.permission.RECORD_AUDIO }, 7);
    }
    // One-time nudge for the "draw over other apps" grant so the persistent floating overlay can appear.
    SharedPreferences p = getSharedPreferences("asmltr", MODE_PRIVATE);
    if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(this) && !p.getBoolean("overlayAsked", false)) {
      p.edit().putBoolean("overlayAsked", true).apply();
      try { startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName()))); } catch (Exception e) {}
    }
    // Android 13+ needs runtime notification permission for the ongoing foreground-service notifications.
    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[]{ "android.permission.POST_NOTIFICATIONS" }, 8);
    }
    NativeConfig nc = new NativeConfig(this);
    // Bring up the persistent control link (if configured) + one-time battery-exemption nudge so it
    // stays connected in the background / Doze.
    if (!p.getString("baseUrl", "").isEmpty() && !p.getString("token", "").isEmpty()) {
      nc.startControlLink();
      if (!p.getBoolean("batteryAsked", false)) { p.edit().putBoolean("batteryAsked", true).apply(); nc.requestBatteryExemption(); }
    }
    WebView wv = getBridge().getWebView();
    wv.addJavascriptInterface(nc, "AsmltrNative");
    // Passkeys inside the WebView (Android 15+ System WebView). Requires the app to be associated with
    // the RP domain via Digital Asset Links (assetlinks.json).
    if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
      WebSettingsCompat.setWebAuthenticationSupport(wv.getSettings(), WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP);
    }
  }
}
