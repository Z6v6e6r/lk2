package ru.padlhub.app;

import android.os.Bundle;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PadlHubAndroidSessionPlugin.class);
        super.onCreate(savedInstanceState);
        // Disable Capacitor's all-frame legacy fallback. Only its origin-scoped modern channel is supported.
        getBridge().getWebView().removeJavascriptInterface("androidBridge");
        getBridge().getWebView().removeJavascriptInterface("CapacitorCookiesAndroidInterface");
        getBridge().getWebView().removeJavascriptInterface("CapacitorHttpAndroidInterface");
        // CapacitorCookies installs a process-wide CookieHandler even without JS patching enabled.
        // This app's native transport owns its refresh cookie and must never use that ambient jar.
        java.net.CookieHandler.setDefault(null);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (getBridge() != null && getBridge().getWebView().canGoBack()) {
                    getBridge().getWebView().goBack();
                } else {
                    moveTaskToBack(true);
                }
            }
        });
    }
}
