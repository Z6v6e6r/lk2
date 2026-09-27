package ru.padlhub.app;

import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import static ru.padlhub.app.AndroidSessionPolicy.Failure;

@CapacitorPlugin(name = "PadlHubAndroidSession")
public final class PadlHubAndroidSessionPlugin extends Plugin {
    private final ThreadPoolExecutor queue = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(64));
    private AndroidSessionPolicy policy;
    private AndroidSessionEngine engine;
    private AndroidHttpSender sender;

    @Override public void load() {
        try {
            policy = new AndroidSessionPolicy(getConfig().getString("apiBaseUrl", ""), getConfig().getString("tenantKey", ""),
                BuildConfig.VERSION_NAME, String.valueOf(BuildConfig.VERSION_CODE), BuildConfig.DEBUG);
            sender = new AndroidHttpSender(policy.origin);
            engine = new AndroidSessionEngine(policy, new AndroidCredentialStore(getContext(), policy.scope), sender);
        } catch (Failure ignored) { /* No credential, phone, OTP or raw native exception logging. */ }
    }

    static boolean bundledOrigin(Uri uri) {
        return uri != null && "https".equals(uri.getScheme()) && "localhost".equals(uri.getHost())
            && uri.getUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    private boolean trustedPage() {
        String url = getBridge().getWebView().getUrl();
        return androidx.webkit.WebViewFeature.isFeatureSupported(androidx.webkit.WebViewFeature.WEB_MESSAGE_LISTENER)
            && !getBridge().getConfig().isUsingLegacyBridge() && url != null && bundledOrigin(Uri.parse(url));
    }

    @PluginMethod public void configuration(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!trustedPage() || policy == null || engine == null) {
                call.reject("Native configuration unavailable", "NATIVE_CONFIGURATION_REQUIRED");
                return;
            }
            call.resolve(new JSObject().put("apiBaseUrl", policy.origin).put("tenantKey", policy.tenant)
                .put("appVersion", policy.version).put("appBuild", policy.build));
        });
    }

    @PluginMethod public void request(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!trustedPage() || engine == null) {
                call.reject("Native request rejected", "NATIVE_REQUEST_REJECTED");
                return;
            }
            try {
                JSObject raw = call.getObject("headers");
                if (raw == null || raw.length() > 16) throw AndroidSessionPolicy.rejected();
                Map<String, String> headers = new HashMap<>();
                for (Iterator<String> keys = raw.keys(); keys.hasNext();) {
                    String key = keys.next();
                    Object value = raw.get(key);
                    if (!(value instanceof String)) throw AndroidSessionPolicy.rejected();
                    headers.put(key, (String) value);
                }
                String path = call.getString("path");
                String method = call.getString("method");
                String body = call.getString("body");
                // Reject malformed requests before they occupy the serial lifecycle queue.
                policy.request(path, method, headers, body);
                queue.execute(() -> {
                    try {
                        AndroidSessionEngine.Response response = engine.request(path, method, headers, body);
                        JSObject safeHeaders = new JSObject();
                        for (Map.Entry<String, String> entry : response.headers.entrySet()) safeHeaders.put(entry.getKey(), entry.getValue());
                        JSObject result = new JSObject().put("status", response.status)
                            .put("headers", safeHeaders)
                            .put("body", Base64.encodeToString(response.body, Base64.NO_WRAP));
                        getActivity().runOnUiThread(() -> {
                            if (trustedPage()) call.resolve(result);
                            else call.reject("Native request rejected", "NATIVE_REQUEST_REJECTED");
                        });
                    } catch (Failure error) {
                        call.reject("Native session unavailable", error.code);
                    }
                });
            } catch (Exception ignored) {
                call.reject("Native request rejected", "NATIVE_REQUEST_REJECTED");
            }
        });
    }

    @Override public Boolean shouldOverrideLoad(Uri url) {
        if (bundledOrigin(url)) return false;
        if ("https".equals(url.getScheme()) && url.getUserInfo() == null) {
            try { getActivity().startActivity(new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE)); }
            catch (android.content.ActivityNotFoundException ignored) { /* Remain in the local app. */ }
        }
        return true;
    }

    @Override protected void handleOnDestroy() {
        queue.shutdownNow();
        if (sender != null) sender.close();
    }
}
