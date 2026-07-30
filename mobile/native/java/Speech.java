package com.asmltr.assistant;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.speech.tts.TextToSpeech;
import android.util.Base64;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;

/**
 * Native read-aloud that uses the ASSISTANT's configured voice. Headless speak paths (the control link
 * reading an asmltr-notify `speak` frame, and the notification reader) must sound like the user's chosen
 * TTS — ElevenLabs / OpenAI voice + model — not Android's built-in robot engine. So we synthesize through
 * the connector's `/gw/tts` (which honors the persisted provider/voice/model) and play the returned clip;
 * the OS TextToSpeech engine is only a fallback when the server can't be reached (offline / no key).
 */
public class Speech {
  private static TextToSpeech tts;               // lazy fallback engine
  private static volatile boolean ttsReady = false;

  /** Speak `text` in the configured voice. `requireHeadphones` gates on a BT/wired route being present. */
  public static void speak(final Context ctx, final String base, final String token, final String text, final boolean requireHeadphones) {
    if (text == null || text.trim().isEmpty()) return;
    if (requireHeadphones && !headphonesConnected(ctx)) return;
    new Thread(() -> {
      byte[] audio = synth(base, token, text);
      if (audio != null && audio.length > 0 && playClip(ctx, audio)) return; // configured voice
      nativeSpeak(ctx, text);                                                 // fallback: OS engine
    }, "asmltr-speech").start();
  }

  public static boolean headphonesConnected(Context ctx) {
    try {
      AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
      if (am == null) return false;
      for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
        int t = d.getType();
        if (t == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP || t == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
            || t == AudioDeviceInfo.TYPE_WIRED_HEADPHONES || t == AudioDeviceInfo.TYPE_WIRED_HEADSET
            || t == AudioDeviceInfo.TYPE_USB_HEADSET) return true;
      }
    } catch (Throwable t) {}
    return false;
  }

  /** POST /gw/tts { token, text } → { ok, mime, b64 }. Returns decoded audio bytes, or null on failure. */
  private static byte[] synth(String base, String token, String text) {
    if (base == null || base.isEmpty()) return null;
    HttpURLConnection c = null;
    try {
      c = (HttpURLConnection) new URL(base + "/gw/tts").openConnection();
      c.setRequestMethod("POST");
      c.setConnectTimeout(8000); c.setReadTimeout(30000);
      c.setDoOutput(true);
      c.setRequestProperty("Content-Type", "application/json");
      JSONObject body = new JSONObject(); body.put("token", token); body.put("text", text);
      try (OutputStream os = c.getOutputStream()) { os.write(body.toString().getBytes("UTF-8")); }
      if (c.getResponseCode() < 200 || c.getResponseCode() >= 300) return null;
      java.io.InputStream is = c.getInputStream();
      java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
      byte[] buf = new byte[8192]; int n; while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
      JSONObject r = new JSONObject(bo.toString("UTF-8"));
      String b64 = r.optString("b64", "");
      if (b64.isEmpty()) return null;
      return Base64.decode(b64, Base64.DEFAULT);
    } catch (Throwable t) { return null; }
    finally { if (c != null) c.disconnect(); }
  }

  /** Write the clip to a temp file and play it on the MEDIA route (→ Bluetooth A2DP). Blocks until done. */
  private static boolean playClip(Context ctx, byte[] audio) {
    File f = null;
    try {
      f = File.createTempFile("asmltr-tts", ".audio", ctx.getCacheDir());
      try (FileOutputStream fos = new FileOutputStream(f)) { fos.write(audio); }
      final MediaPlayer mp = new MediaPlayer();
      mp.setAudioAttributes(new AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
      mp.setDataSource(f.getAbsolutePath());
      final Object lock = new Object();
      final boolean[] done = { false };
      mp.setOnCompletionListener(m -> { synchronized (lock) { done[0] = true; lock.notifyAll(); } });
      mp.setOnErrorListener((m, w, e) -> { synchronized (lock) { done[0] = true; lock.notifyAll(); } return true; });
      mp.prepare();
      mp.start();
      synchronized (lock) { while (!done[0]) { try { lock.wait(30000); } catch (InterruptedException e) { break; } if (!mp.isPlaying()) break; } }
      try { mp.release(); } catch (Throwable t) {}
      return true;
    } catch (Throwable t) { return false; }
    finally { if (f != null) try { f.delete(); } catch (Throwable t) {} }
  }

  private static synchronized void nativeSpeak(Context ctx, final String text) {
    if (tts == null) tts = new TextToSpeech(ctx.getApplicationContext(), s -> {
      if (s == TextToSpeech.SUCCESS) { try { tts.setLanguage(Locale.getDefault()); } catch (Throwable t) {} ttsReady = true; }
    });
    for (int i = 0; i < 20 && !ttsReady; i++) { try { Thread.sleep(100); } catch (InterruptedException e) { break; } }
    if (!ttsReady) return;
    try { tts.speak(text, TextToSpeech.QUEUE_ADD, null, "asmltr-" + System.currentTimeMillis()); } catch (Throwable t) {}
  }
}
