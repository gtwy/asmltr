package com.asmltr.assistant;
import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;

/**
 * The headset/wired-button assistant entry point. A Bluetooth headset's assistant button fires an
 * ACTIVITY intent (ACTION_VOICE_COMMAND / ACTION_ASSIST / hands-free voice search) — separate from the
 * power-button "digital assistant" role that goes to the VoiceInteractionService. Apps only appear in
 * that "Complete action using" chooser if they register an activity for it, which we didn't. This
 * invisible activity does: on launch it kicks the floating overlay into listen mode, then finishes.
 */
public class AssistActivity extends Activity {
  @Override protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    try {
      if (Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(this)) {
        Intent i = new Intent(this, OverlayService.class).setAction(OverlayService.ACTION_LISTEN);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
      } else {
        // no overlay permission yet → open the app so the user can grant it / talk
        Intent i = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (i != null) { i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); startActivity(i); }
      }
    } catch (Exception e) {}
    finish();
  }
}
