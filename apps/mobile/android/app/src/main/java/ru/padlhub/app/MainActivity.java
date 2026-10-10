package ru.padlhub.app;

import android.os.Bundle;
import android.graphics.Color;
import android.view.View;
import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PadlHubAndroidSessionPlugin.class);
        super.onCreate(savedInstanceState);
        containWebViewInSafeArea();
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

    private void containWebViewInSafeArea() {
        // One native viewport protects every screen and fixed element, including during scrolling.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        View viewport = (View) getBridge().getWebView().getParent();
        viewport.setBackgroundColor(Color.rgb(251, 251, 250));
        ViewCompat.setOnApplyWindowInsetsListener(viewport, (view, insets) -> {
            int bars = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();
            Insets safe = insets.getInsets(bars);
            Insets keyboard = insets.getInsets(WindowInsetsCompat.Type.ime());
            view.setPadding(safe.left, safe.top, safe.right, Math.max(safe.bottom, keyboard.bottom));
            // The WebView is already contained. Passing the same insets to Chromium adds them twice.
            return new WindowInsetsCompat.Builder(insets)
                .setInsets(bars | WindowInsetsCompat.Type.ime(), Insets.NONE)
                .build();
        });
        viewport.post(() -> ViewCompat.requestApplyInsets(viewport));
    }
}
