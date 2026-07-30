package com.asmltr.assistant;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;

/**
 * Native audio cues. The web overlay's WebAudio "listen" beep is inaudible when the overlay wakes from
 * CLOSED (wake word / headset button): the WebView isn't alive yet and the Bluetooth A2DP route isn't
 * warm, so the first tone is dropped/clipped. This plays the cue natively from the always-on service —
 * which already holds a warm audio route — with a short silent primer to spin up the A2DP link first,
 * so it lands on Bluetooth headphones even with the screen off and nothing on screen.
 *
 * Dependency-free: a generated PCM sine pair written to a one-shot AudioTrack on the MEDIA route (which
 * is what A2DP carries). Mirrors the web cue: rising 440→660 = "listening", falling 660→440 = "stopped".
 */
public class Chime {
  private static final int SR = 44100;

  /** Rising two-tone "now listening" cue, routed to Bluetooth/media. */
  public static void listen(Context ctx) { play(440, 660); }
  /** Falling two-tone "stopped, mic off" cue. */
  public static void stop(Context ctx) { play(660, 440); }

  private static void play(final int f1, final int f2) {
    new Thread(() -> {
      try {
        // 0.30s silent primer (warm the idle A2DP route) + two 0.12s tones with a small gap.
        short[] buf = build(f1, f2);
        AudioTrack track = new AudioTrack.Builder()
            .setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)                 // MEDIA → carried over A2DP
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build())
            .setAudioFormat(new AudioFormat.Builder()
                .setSampleRate(SR)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .build())
            .setBufferSizeInBytes(buf.length * 2)
            .setTransferMode(AudioTrack.MODE_STATIC)
            .build();
        track.write(buf, 0, buf.length);
        track.setNotificationMarkerPosition(buf.length);
        track.setPlaybackPositionUpdateListener(new AudioTrack.OnPlaybackPositionUpdateListener() {
          @Override public void onMarkerReached(AudioTrack t) { try { t.stop(); t.release(); } catch (Throwable x) {} }
          @Override public void onPeriodicNotification(AudioTrack t) {}
        });
        track.play();
      } catch (Throwable t) { /* a cue is best-effort — never crash the service */ }
    }, "asmltr-chime").start();
  }

  private static short[] build(int f1, int f2) {
    int primer = (int) (SR * 0.30);   // silent — warms the BT route before the first audible sample
    int tone = (int) (SR * 0.12);
    int gap = (int) (SR * 0.02);
    short[] out = new short[primer + tone + gap + tone];
    int i = primer;                    // leave the primer as zeros (silence)
    writeTone(out, i, tone, f1); i += tone + gap;
    writeTone(out, i, tone, f2);
    return out;
  }

  // A single sine tone with 6ms linear fades in/out (kills the click at edges).
  private static void writeTone(short[] out, int off, int n, int freq) {
    int fade = (int) (SR * 0.006);
    for (int k = 0; k < n && off + k < out.length; k++) {
      double amp = 0.35;
      if (k < fade) amp *= (double) k / fade;
      else if (k > n - fade) amp *= (double) (n - k) / fade;
      out[off + k] = (short) (Math.sin(2 * Math.PI * freq * k / SR) * amp * Short.MAX_VALUE);
    }
  }
}
