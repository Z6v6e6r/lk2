package ru.padlhub.app;

import android.app.Instrumentation;
import android.content.Intent;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.Collections;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class AndroidStartupTest {
    String evaluate(MainActivity activity, String script) throws Exception {
        AtomicReference<String> result = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        activity.runOnUiThread(() -> activity.getBridge().getWebView().evaluateJavascript(script, value -> { result.set(value); done.countDown(); }));
        assertTrue("WebView response", done.await(5, TimeUnit.SECONDS));
        return result.get();
    }

    @Test public void configuredBundledAppUsesModernBridgeAndOpensPhoneForm() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        // This UI check explicitly requires the configured test APK, never default/offline assets.
        org.junit.Assume.assumeTrue("true".equals(InstrumentationRegistry.getArguments().getString("configuredApp")));
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(
            new Intent(instrumentation.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            assertNull(java.net.CookieHandler.getDefault());
            boolean form = false;
            for (int i = 0; i < 120; i++) {
                if ("true".equals(evaluate(activity, "document.body.innerText.includes('Получить код')"))) { form = true; break; }
                Thread.sleep(250);
            }
            assertTrue("Phone form must replace the offline placeholder", form);
            assertEquals("true", evaluate(activity, "typeof CapacitorCookiesAndroidInterface === 'undefined' && typeof CapacitorHttpAndroidInterface === 'undefined'"));
            assertEquals("true", evaluate(activity, "document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]').content.includes(\"frame-src 'none'\")"));
            assertEquals("false", evaluate(activity, "document.body.innerText.includes('ещё не подключена')"));
        } finally { activity.runOnUiThread(activity::finish); }
    }

    @Test public void optionalReadOnlyNativeTlsProbeDoesNotSendOtpOrCredentials() throws Exception {
        org.junit.Assume.assumeTrue("true".equals(InstrumentationRegistry.getArguments().getString("liveReadOnlyProbe")));
        AndroidHttpSender sender = new AndroidHttpSender("https://lk2.padlhub.su");
        try {
            AndroidSessionEngine.Response result = sender.send(new AndroidSessionPolicy.Request(
                "/user/api/v1/local-padel/context", "GET", Collections.singletonMap("accept", "application/json"), null, AndroidSessionPolicy.Operation.API));
            assertEquals("Unauthenticated native TLS reaches the existing API", 401, result.status);
            assertTrue(result.cookies.isEmpty());
        } finally { sender.close(); }
    }
}
