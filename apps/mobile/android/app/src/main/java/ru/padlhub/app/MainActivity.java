package ru.padlhub.app;

import android.os.Bundle;
import android.graphics.Color;
import android.view.View;
import android.view.ViewGroup;
import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private ViewGroup viewport;
    private View statusBarScrim;
    private Insets safeInsets = Insets.NONE;
    private int keyboardBottom;
    private boolean statusBarUnderlap;
    private java.util.function.DoubleConsumer viewportInsetsListener;
    private double lastPublishedInset = -1;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PadlHubAndroidSessionPlugin.class);
        registerPlugin(PadlHubViewportPlugin.class);
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
        viewport = (ViewGroup) getBridge().getWebView().getParent();
        viewport.setBackgroundColor(Color.rgb(251, 251, 250));
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            getWindow().setStatusBarContrastEnforced(false);
        }
        statusBarScrim = new View(this);
        statusBarScrim.setTag("phub-status-bar-scrim");
        statusBarScrim.setBackgroundColor(Color.argb(24, 0, 0, 0));
        statusBarScrim.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        statusBarScrim.setClickable(false);
        statusBarScrim.setFocusable(false);
        viewport.addView(statusBarScrim, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0));
        ViewCompat.setOnApplyWindowInsetsListener(viewport, (view, insets) -> {
            int bars = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();
            safeInsets = insets.getInsets(bars);
            keyboardBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
            applyViewportInsets();
            // The WebView is already contained. Passing the same insets to Chromium adds them twice.
            return new WindowInsetsCompat.Builder(insets)
                .setInsets(bars | WindowInsetsCompat.Type.ime(), Insets.NONE)
                .build();
        });
        viewport.post(() -> ViewCompat.requestApplyInsets(viewport));
    }

    void setStatusBarUnderlap(boolean enabled) {
        statusBarUnderlap = enabled;
        applyViewportInsets();
    }

    double statusBarContentInset() {
        return statusBarUnderlap ? safeInsets.top / getResources().getDisplayMetrics().density : 0;
    }

    void observeViewportInsets(java.util.function.DoubleConsumer listener) {
        viewportInsetsListener = listener;
    }

    private void applyViewportInsets() {
        if (viewport == null) return;
        viewport.setPadding(safeInsets.left, statusBarUnderlap ? 0 : safeInsets.top,
            safeInsets.right, Math.max(safeInsets.bottom, keyboardBottom));
        ViewGroup.LayoutParams scrimLayout = statusBarScrim.getLayoutParams();
        if (scrimLayout.height != safeInsets.top) {
            scrimLayout.height = safeInsets.top;
            statusBarScrim.setLayoutParams(scrimLayout);
        }
        statusBarScrim.setVisibility(statusBarUnderlap ? View.VISIBLE : View.GONE);
        double top = statusBarContentInset();
        if (viewportInsetsListener != null && top != lastPublishedInset) {
            lastPublishedInset = top;
            viewportInsetsListener.accept(top);
        }
    }
}
