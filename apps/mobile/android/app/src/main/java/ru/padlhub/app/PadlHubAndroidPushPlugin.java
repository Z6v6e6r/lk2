package ru.padlhub.app;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Looper;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import java.lang.ref.WeakReference;
import org.json.JSONObject;
import static ru.padlhub.app.AndroidSessionPolicy.Failure;

@CapacitorPlugin(name = "PadlHubAndroidPush", permissions = @Permission(alias = "notifications", strings = Manifest.permission.POST_NOTIFICATIONS))
public final class PadlHubAndroidPushPlugin extends Plugin {
    private static WeakReference<PadlHubAndroidPushPlugin> current = new WeakReference<>(null);
    private AndroidPushState state;
    @Override public void load() {
        current = new WeakReference<>(this);
        try {
            state = AndroidPushState.fromBundle(getContext());
            if (configured()) FirebaseMessaging.getInstance().setAutoInitEnabled(false);
        } catch (Exception ignored) { /* Default configuration stays unavailable. */ }
    }
    private boolean trusted() {
        // Capacitor invokes plugin methods on its worker. WebView belongs to the main Looper.
        if (Looper.myLooper() != Looper.getMainLooper() || state == null
            || getActivity() == null || getActivity().isFinishing() || getActivity().isDestroyed()) return false;
        String url = getBridge().getWebView().getUrl();
        return !getBridge().getConfig().isUsingLegacyBridge()
            && androidx.webkit.WebViewFeature.isFeatureSupported(androidx.webkit.WebViewFeature.WEB_MESSAGE_LISTENER)
            && url != null && PadlHubAndroidSessionPlugin.bundledOrigin(Uri.parse(url));
    }
    private boolean configured() { return !FirebaseApp.getApps(getContext()).isEmpty(); }
    private boolean granted() {
        return (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED)
            && NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
    }
    private void reject(PluginCall call, Exception error) {
        call.reject("Native notifications unavailable", error instanceof Failure ? ((Failure) error).code : "NATIVE_PUSH_UNAVAILABLE");
    }
    @PluginMethod public void status(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            if (!trusted()) { call.reject("Native request rejected", "NATIVE_REQUEST_REJECTED"); return; }
            try {
                JSONObject value = state.read();
                boolean active;
                try { active = state.active(); } catch (Failure ignored) { active = false; }
                call.resolve(new JSObject(state.pending(value).toString()).put("configured", configured())
                    .put("active", active)
                    .put("state", !configured() ? "unsupported" : active && granted() ? "subscribed"
                        : granted() || (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.DENIED) ? "prompt" : "denied"));
            } catch (Exception error) { reject(call, error); }
        });
    }
    @PluginMethod public void registration(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            if (!trusted()) { call.reject("Native request rejected", "NATIVE_REQUEST_REJECTED"); return; }
            if (!configured()) { call.reject("Native notifications unavailable", "NATIVE_PUSH_CONFIGURATION_REQUIRED"); return; }
            if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED
                && Boolean.TRUE.equals(call.getBoolean("requestPermission"))) {
                requestPermissionForAlias("notifications", call, "notificationPermission"); return;
            }
            registerToken(call);
        });
    }
    @PermissionCallback private void notificationPermission(PluginCall call) {
        getBridge().executeOnMainThread(() -> registerToken(call));
    }
    private void registerToken(PluginCall call) {
        if (!trusted() || !granted()) { call.reject("Notifications permission required", "NATIVE_PUSH_PERMISSION_DENIED"); return; }
        try {
            final long epoch = state.read().optLong("epoch");
            final String account = state.account();
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> getBridge().executeOnMainThread(() -> {
                if (!trusted()) { call.reject("Native request rejected", "NATIVE_REQUEST_REJECTED"); return; }
                if (!task.isSuccessful()) { call.reject("Native notifications unavailable", "NATIVE_PUSH_UNAVAILABLE"); return; }
                try { call.resolve(new JSObject(state.registration(task.getResult(), epoch, account).toString())); }
                catch (Exception error) { reject(call, error); }
            }));
        } catch (Exception error) { reject(call, error); }
    }
    @PluginMethod public void activate(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            if (!trusted()) { call.reject("Native request rejected", "NATIVE_REQUEST_REJECTED"); return; }
            try { state.activate(call.getString("idempotencyKey", ""), call.getString("endpointId")); call.resolve(); }
            catch (Exception error) { reject(call, error); }
        });
    }
    @PluginMethod public void suspend(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            if (!trusted()) { call.reject("Native request rejected", "NATIVE_REQUEST_REJECTED"); return; }
            try { call.resolve(new JSObject(state.suspend().toString())); }
            catch (Exception error) { reject(call, error); }
        });
    }
    @PluginMethod public void finishRevoke(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            if (!trusted()) { call.reject("Native request rejected", "NATIVE_REQUEST_REJECTED"); return; }
            try { state.finishRevoke(call.getString("idempotencyKey", "")); call.resolve(); }
            catch (Exception error) { reject(call, error); }
        });
    }
    @PluginMethod public void takeOpened(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            if (!trusted()) { call.reject("Native request rejected", "NATIVE_REQUEST_REJECTED"); return; }
            try {
                String route = state.opened(getActivity().getIntent());
                JSObject value = new JSObject(); if (route != null) value.put("route", route); call.resolve(value);
            } catch (Exception error) { reject(call, error); }
        });
    }
    static void changed() {
        PadlHubAndroidPushPlugin plugin = current.get();
        if (plugin != null && plugin.getActivity() != null) plugin.getActivity().runOnUiThread(() -> {
            if (plugin.trusted()) plugin.notifyListeners("registrationChanged", new JSObject());
        });
    }
    @Override protected void handleOnNewIntent(Intent intent) {
        getBridge().executeOnMainThread(() -> {
            if (getActivity() == null || getActivity().isFinishing() || getActivity().isDestroyed()) return;
            getActivity().setIntent(intent);
            if (trusted()) notifyListeners("notificationOpened", new JSObject());
        });
    }
    @Override protected void handleOnDestroy() {
        if (current.get() == this) current.clear();
        super.handleOnDestroy();
    }
}
