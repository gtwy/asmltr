package com.asmltr.assistant;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

/** Restart the persistent device link after a reboot (only if the device was configured), so the phone
 *  reconnects to asmltr on its own without the user opening the app. */
public class BootReceiver extends BroadcastReceiver {
  @Override public void onReceive(Context ctx, Intent intent) {
    SharedPreferences p = ctx.getSharedPreferences("asmltr", Context.MODE_PRIVATE);
    if (p.getString("baseUrl", "").isEmpty() || p.getString("token", "").isEmpty()) return;
    Intent svc = new Intent(ctx, DeviceControlService.class).setAction(DeviceControlService.ACTION_START);
    if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(svc); else ctx.startService(svc);
  }
}
