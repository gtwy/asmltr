package com.asmltr.assistant;
import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.ByteArrayOutputStream;
import java.util.ArrayDeque;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Phase 2 — the actuator + eyes for full on-screen control. An AccessibilityService can perform
 * gestures (tap/swipe/long-press), global navigation (back/home/recents), read the on-screen view tree
 * (text + bounds), set text into fields, and take screenshots — everything an agent needs to operate the
 * phone like a person. Kept as a singleton so DeviceTools can reach the running instance; when the user
 * hasn't enabled it in Settings→Accessibility, getInstance() is null and the device tools say so.
 */
public class AsmltrAccessibilityService extends AccessibilityService {
  private static AsmltrAccessibilityService INSTANCE;
  public static AsmltrAccessibilityService getInstance() { return INSTANCE; }

  @Override public void onServiceConnected() { super.onServiceConnected(); INSTANCE = this; }
  @Override public void onDestroy() { if (INSTANCE == this) INSTANCE = null; super.onDestroy(); }
  @Override public void onAccessibilityEvent(AccessibilityEvent e) { /* we drive, we don't observe */ }
  @Override public void onInterrupt() {}

  // ── gestures ────────────────────────────────────────────────────────────────
  public boolean tap(float x, float y) { return stroke(x, y, x, y, 60); }
  public boolean longPress(float x, float y) { return stroke(x, y, x, y, 700); }
  public boolean swipe(float x1, float y1, float x2, float y2, int ms) { return stroke(x1, y1, x2, y2, ms > 0 ? ms : 300); }
  private boolean stroke(float x1, float y1, float x2, float y2, int ms) {
    if (Build.VERSION.SDK_INT < 24) return false;
    Path p = new Path(); p.moveTo(x1, y1); p.lineTo(x2, y2);
    GestureDescription g = new GestureDescription.Builder().addStroke(new GestureDescription.StrokeDescription(p, 0, ms)).build();
    final CountDownLatch latch = new CountDownLatch(1); final boolean[] ok = { false };
    boolean dispatched = dispatchGesture(g, new GestureResultCallback() {
      @Override public void onCompleted(GestureDescription d) { ok[0] = true; latch.countDown(); }
      @Override public void onCancelled(GestureDescription d) { latch.countDown(); }
    }, null);
    if (!dispatched) return false;
    try { latch.await(4, TimeUnit.SECONDS); } catch (InterruptedException e) {}
    return ok[0];
  }

  public boolean global(String action) {
    int a;
    switch (action == null ? "" : action) {
      case "back": a = GLOBAL_ACTION_BACK; break;
      case "home": a = GLOBAL_ACTION_HOME; break;
      case "recents": a = GLOBAL_ACTION_RECENTS; break;
      case "notifications": a = GLOBAL_ACTION_NOTIFICATIONS; break;
      case "quick_settings": a = GLOBAL_ACTION_QUICK_SETTINGS; break;
      case "lock": a = Build.VERSION.SDK_INT >= 28 ? GLOBAL_ACTION_LOCK_SCREEN : GLOBAL_ACTION_HOME; break;
      default: return false;
    }
    return performGlobalAction(a);
  }

  // ── read the screen (a compact "DOM" the agent reasons over) ─────────────────
  public JSONArray readScreen(int max) {
    JSONArray out = new JSONArray();
    AccessibilityNodeInfo root = getRootInActiveWindow();
    if (root == null) return out;
    ArrayDeque<AccessibilityNodeInfo> q = new ArrayDeque<>(); q.add(root);
    int n = 0;
    while (!q.isEmpty() && n < max) {
      AccessibilityNodeInfo node = q.poll(); if (node == null) continue;
      CharSequence t = node.getText(), d = node.getContentDescription();
      String text = t != null ? t.toString() : "", desc = d != null ? d.toString() : "";
      boolean interesting = !text.isEmpty() || !desc.isEmpty() || node.isClickable() || node.isEditable();
      if (interesting) {
        Rect r = new Rect(); node.getBoundsInScreen(r);
        try {
          JSONObject o = new JSONObject();
          if (!text.isEmpty()) o.put("text", clip(text));
          if (!desc.isEmpty()) o.put("desc", clip(desc));
          CharSequence cls = node.getClassName(); if (cls != null) o.put("cls", shortCls(cls.toString()));
          o.put("bounds", new JSONArray().put(r.left).put(r.top).put(r.right).put(r.bottom));
          o.put("cx", r.centerX()); o.put("cy", r.centerY());
          if (node.isClickable()) o.put("clickable", true);
          if (node.isEditable()) o.put("editable", true);
          out.put(o); n++;
        } catch (Exception e) {}
      }
      for (int i = 0; i < node.getChildCount(); i++) { AccessibilityNodeInfo c = node.getChild(i); if (c != null) q.add(c); }
    }
    return out;
  }
  private static String clip(String s) { return s.length() > 120 ? s.substring(0, 120) : s; }
  private static String shortCls(String s) { int i = s.lastIndexOf('.'); return i >= 0 ? s.substring(i + 1) : s; }

  // tap the first node whose text/desc contains the query — more robust than raw coordinates
  public boolean tapText(String query) {
    AccessibilityNodeInfo root = getRootInActiveWindow(); if (root == null || query == null) return false;
    String q = query.toLowerCase();
    ArrayDeque<AccessibilityNodeInfo> stack = new ArrayDeque<>(); stack.add(root);
    while (!stack.isEmpty()) {
      AccessibilityNodeInfo node = stack.poll(); if (node == null) continue;
      CharSequence t = node.getText(), d = node.getContentDescription();
      String hay = ((t != null ? t : "") + " " + (d != null ? d : "")).toLowerCase();
      if (hay.contains(q)) {
        AccessibilityNodeInfo target = node;
        while (target != null && !target.isClickable()) target = target.getParent();
        if (target != null && target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true;
        Rect r = new Rect(); node.getBoundsInScreen(r); return tap(r.centerX(), r.centerY());
      }
      for (int i = 0; i < node.getChildCount(); i++) { AccessibilityNodeInfo c = node.getChild(i); if (c != null) stack.add(c); }
    }
    return false;
  }

  // set text into the focused (or first editable) field
  public boolean typeText(String text) {
    AccessibilityNodeInfo root = getRootInActiveWindow(); if (root == null) return false;
    AccessibilityNodeInfo target = findFocusedEditable(root);
    if (target == null) target = findFirstEditable(root);
    if (target == null) return false;
    Bundle args = new Bundle();
    args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text == null ? "" : text);
    return target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
  }
  private AccessibilityNodeInfo findFocusedEditable(AccessibilityNodeInfo root) {
    AccessibilityNodeInfo f = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
    return (f != null && f.isEditable()) ? f : null;
  }
  private AccessibilityNodeInfo findFirstEditable(AccessibilityNodeInfo root) {
    ArrayDeque<AccessibilityNodeInfo> q = new ArrayDeque<>(); q.add(root);
    while (!q.isEmpty()) { AccessibilityNodeInfo node = q.poll(); if (node == null) continue; if (node.isEditable()) return node;
      for (int i = 0; i < node.getChildCount(); i++) { AccessibilityNodeInfo c = node.getChild(i); if (c != null) q.add(c); } }
    return null;
  }

  // ── screenshot (the eyes) — downscaled JPEG base64 ───────────────────────────
  public JSONObject screenshot(int maxDim, int quality) {
    JSONObject res = new JSONObject();
    if (Build.VERSION.SDK_INT < 30) { try { res.put("ok", false); res.put("error", "screenshot needs Android 11+"); } catch (Exception e) {} return res; }
    final CountDownLatch latch = new CountDownLatch(1);
    final JSONObject[] holder = { null };
    takeScreenshot(Display.DEFAULT_DISPLAY, Executors.newSingleThreadExecutor(), new TakeScreenshotCallback() {
      @Override public void onSuccess(ScreenshotResult sr) {
        try {
          Bitmap raw = Bitmap.wrapHardwareBuffer(sr.getHardwareBuffer(), sr.getColorSpace());
          Bitmap bmp = raw.copy(Bitmap.Config.ARGB_8888, false);
          try { sr.getHardwareBuffer().close(); } catch (Exception e) {}
          int w = bmp.getWidth(), h = bmp.getHeight();
          float scale = Math.min(1f, (float) maxDim / Math.max(w, h));
          if (scale < 1f) { bmp = Bitmap.createScaledBitmap(bmp, Math.round(w * scale), Math.round(h * scale), true); }
          ByteArrayOutputStream bos = new ByteArrayOutputStream();
          bmp.compress(Bitmap.CompressFormat.JPEG, quality, bos);
          JSONObject o = new JSONObject();
          o.put("ok", true); o.put("mime", "image/jpeg");
          o.put("w", bmp.getWidth()); o.put("h", bmp.getHeight());
          o.put("image", Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP));
          holder[0] = o;
        } catch (Exception e) { holder[0] = errObj(e.getMessage()); }
        latch.countDown();
      }
      @Override public void onFailure(int code) { holder[0] = errObj("screenshot failed (" + code + ")"); latch.countDown(); }
    });
    try { latch.await(8, TimeUnit.SECONDS); } catch (InterruptedException e) {}
    return holder[0] != null ? holder[0] : errObj("screenshot timeout");
  }
  private static JSONObject errObj(String m) { JSONObject o = new JSONObject(); try { o.put("ok", false); o.put("error", m); } catch (Exception e) {} return o; }
}
