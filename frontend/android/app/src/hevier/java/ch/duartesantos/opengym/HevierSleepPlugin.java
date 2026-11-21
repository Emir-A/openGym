package ch.duartesantos.opengym;

import android.Manifest;
import android.app.AppOpsManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Process;
import android.provider.Settings;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * [hevier] Reads retroactive screen on/off and keyguard unlock transitions from Android's
 * UsageStatsManager so phone-only overnight sleep estimation needs no background service.
 * Requires Android 9+ (API 28) for UsageEvents screen/keyguard event types and user-granted
 * PACKAGE_USAGE_STATS ("Usage data access").
 */
@CapacitorPlugin(name = "HevierSleep")
public class HevierSleepPlugin extends Plugin {

    private static final int EVENT_SCREEN_INTERACTIVE = 15;
    private static final int EVENT_SCREEN_NON_INTERACTIVE = 16;
    private static final int EVENT_KEYGUARD_SHOWN = 17;
    private static final int EVENT_KEYGUARD_HIDDEN = 18;
    private static final long SEVEN_DAYS_MS = 7L * 24L * 3600L * 1000L;

    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "hevier-sleep");
        t.setDaemon(true);
        return t;
    });

    @Override
    protected void handleOnDestroy() {
        worker.shutdownNow();
        super.handleOnDestroy();
    }

    private static boolean isSupported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P;
    }

    /** Maps Android UsageEvents.Event screen/keyguard types to JS event names, else null. */
    static String eventTypeName(int eventType) {
        switch (eventType) {
            case EVENT_SCREEN_INTERACTIVE:
                return "screen_on";
            case EVENT_SCREEN_NON_INTERACTIVE:
                return "screen_off";
            case EVENT_KEYGUARD_SHOWN:
                return "keyguard_shown";
            case EVENT_KEYGUARD_HIDDEN:
                return "unlock";
            default:
                return null;
        }
    }

    static boolean hasUsageStats(Context ctx) {
        if (ctx == null) return false;
        AppOpsManager appOps = (AppOpsManager) ctx.getSystemService(Context.APP_OPS_SERVICE);
        if (appOps == null) return false;
        int mode = checkUsageStatsOp(appOps, ctx);
        if (mode == AppOpsManager.MODE_DEFAULT) {
            return ctx.checkCallingOrSelfPermission(Manifest.permission.PACKAGE_USAGE_STATS) == PackageManager.PERMISSION_GRANTED;
        }
        return mode == AppOpsManager.MODE_ALLOWED;
    }

    @SuppressWarnings("deprecation")
    private static int checkUsageStatsOp(AppOpsManager appOps, Context ctx) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return appOps.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.getPackageName());
        }
        return appOps.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.getPackageName());
    }

    private static Long millis(PluginCall call, String name) {
        Object v = call.getData().opt(name);
        return v instanceof Number ? ((Number) v).longValue() : null;
    }

    @PluginMethod
    public void status(PluginCall call) {
        Context ctx = getContext();
        UsageStatsManager usm = ctx != null ? (UsageStatsManager) ctx.getSystemService(Context.USAGE_STATS_SERVICE) : null;
        boolean supported = isSupported() && usm != null;
        boolean granted = supported && hasUsageStats(ctx);
        JSObject r = new JSObject();
        r.put("supported", supported);
        r.put("granted", granted);
        call.resolve(r);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Context ctx = getContext();
        if (ctx == null) {
            call.reject("no context");
            return;
        }
        try {
            Intent intent = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS, Uri.parse("package:" + ctx.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(intent);
        } catch (Exception ignored) {
            try {
                Intent fallback = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(fallback);
            } catch (Exception e) {
                call.reject("could not open usage access settings", e);
                return;
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void readScreenEvents(PluginCall call) {
        Context ctx = getContext();
        if (!isSupported() || ctx == null) {
            call.reject("unsupported on this Android version", "unsupported");
            return;
        }
        if (!hasUsageStats(ctx)) {
            call.reject("usage access not granted", "permission");
            return;
        }
        UsageStatsManager usm = (UsageStatsManager) ctx.getSystemService(Context.USAGE_STATS_SERVICE);
        if (usm == null) {
            call.reject("usage stats service unavailable", "unsupported");
            return;
        }
        long now = System.currentTimeMillis();
        Long untilBoxed = millis(call, "until");
        Long sinceBoxed = millis(call, "since");
        long until = untilBoxed != null ? untilBoxed : now;
        long since = sinceBoxed != null ? sinceBoxed : (until - SEVEN_DAYS_MS);
        if (until <= since) {
            JSObject empty = new JSObject();
            empty.put("events", new JSArray());
            call.resolve(empty);
            return;
        }
        worker.execute(() -> {
            try {
                UsageEvents events = usm.queryEvents(since, until);
                JSArray arr = new JSArray();
                if (events != null) {
                    UsageEvents.Event ev = new UsageEvents.Event();
                    while (events.hasNextEvent()) {
                        events.getNextEvent(ev);
                        String type = eventTypeName(ev.getEventType());
                        if (type == null) continue;
                        JSObject item = new JSObject();
                        item.put("t", ev.getTimeStamp());
                        item.put("type", type);
                        arr.put(item);
                    }
                }
                JSObject out = new JSObject();
                out.put("events", arr);
                call.resolve(out);
            } catch (Exception e) {
                call.reject("could not query screen events: " + e.getMessage(), "failed", e);
            }
        });
    }
}
