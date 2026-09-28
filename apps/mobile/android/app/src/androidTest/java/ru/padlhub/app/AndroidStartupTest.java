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
            assertEquals("true", evaluate(activity, "Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('Войти через Яндекс'))"));
            evaluate(activity, "Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Войти через Яндекс')).click(); true");
            awaitJs(activity, "document.querySelector('[role=alert]')?.textContent.includes('Подтвердите публичную оферту')");
            evaluate(activity, "document.querySelector('.viva-login-button').scrollIntoView({block: 'center'}); true");
            awaitJs(activity, "document.querySelector('.viva-login-button').getBoundingClientRect().bottom <= window.innerHeight");
            assertEquals("true", evaluate(activity, "document.documentElement.scrollWidth <= window.innerWidth"));
            capture("yandex-phone-portrait.png");
            activity.runOnUiThread(() -> activity.setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
            awaitJs(activity, "window.innerWidth > window.innerHeight");
            evaluate(activity, "document.querySelector('.viva-login-button').focus(); document.querySelector('.viva-login-button').scrollIntoView({block: 'center'}); true");
            awaitJs(activity, "document.querySelector('.viva-login-button').getBoundingClientRect().bottom <= window.innerHeight");
            assertEquals("true", evaluate(activity, "document.documentElement.scrollWidth <= window.innerWidth"));
            capture("yandex-phone-landscape.png");
            activity.runOnUiThread(() -> activity.setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED));
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

    private void awaitJs(MainActivity activity, String condition) throws Exception {
        for (int i = 0; i < 120; i++) {
            if ("true".equals(evaluate(activity, condition))) return;
            Thread.sleep(100);
        }
        fail("Expected rendered condition: " + condition);
    }

    private void capture(String name) throws Exception {
        if (!"true".equals(InstrumentationRegistry.getArguments().getString("captureCacheUi"))) return;
        // DOM conditions can settle before WebView's next compositor frame or rotation animation.
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        Thread.sleep(1000);
        android.graphics.Bitmap bitmap = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
        java.io.File target = new java.io.File(InstrumentationRegistry.getInstrumentation().getTargetContext().getExternalFilesDir(null), name);
        try (java.io.FileOutputStream output = new java.io.FileOutputStream(target)) { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output); }
        bitmap.recycle();
    }

    @Test public void appLinkResumesNativeCustodyAndOpensTheCabinetWithoutExposingProofToWebView() throws Exception {
        org.junit.Assume.assumeTrue("true".equals(InstrumentationRegistry.getArguments().getString("configuredApp")));
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(
            new Intent(instrumentation.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            awaitJs(activity, "document.body.innerText.includes('Получить код')");
            AndroidSessionPolicy policy = new AndroidSessionPolicy(AndroidSessionTest.ORIGIN, "local-padel", "test", "4", false);
            AndroidSessionTest.MemoryStore credentials = new AndroidSessionTest.MemoryStore();
            AndroidYandexLoginTest.Journal journal = new AndroidYandexLoginTest.Journal();
            org.json.JSONObject sessionJson = new org.json.JSONObject(AndroidSessionTest.SESSION);
            sessionJson.getJSONObject("user").put("displayName", "Тестовый игрок");
            sessionJson.getJSONObject("context").put("displayName", "Тестовый игрок").put("roles", new org.json.JSONArray().put("client"))
                .put("permissions", new org.json.JSONArray());
            String body = sessionJson.toString();
            java.util.List<AndroidSessionPolicy.Request> requests = new java.util.concurrent.CopyOnWriteArrayList<>();
            AndroidSessionEngine.Sender sender = request -> {
                requests.add(request);
                if (request.path.endsWith("/start")) return AndroidSessionTest.response(200,
                    "{\"launchPath\":\"" + policy.authRoot + "/viva/android/launch?code=" + AndroidYandexLoginTest.CODE + "\"}", Collections.emptyList());
                if (request.path.endsWith("/exchange") || request.operation == AndroidSessionPolicy.Operation.REFRESH) {
                    java.util.Map<String, String> headers = new java.util.HashMap<>(); headers.put("content-type", "application/json");
                    if (journal.value != null) headers.put("x-android-oauth-state", journal.value.state);
                    return new AndroidSessionEngine.Response(200, headers, Collections.singletonList(AndroidSessionTest.cookie(AndroidSessionTest.REFRESH)), body.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                }
                return AndroidSessionTest.response(200, "{\"items\":[]}", Collections.emptyList());
            };
            AndroidSessionEngine engine = new AndroidSessionEngine(policy, credentials, sender);
            AndroidYandexLogin oauth = new AndroidYandexLogin(policy, engine, sender, journal);
            PadlHubAndroidSessionPlugin plugin = (PadlHubAndroidSessionPlugin) activity.getBridge().getPlugin("PadlHubAndroidSession").getInstance();
            for (String name : new String[] { "engine", "oauth" }) {
                java.lang.reflect.Field field = PadlHubAndroidSessionPlugin.class.getDeclaredField(name); field.setAccessible(true);
                field.set(plugin, name.equals("engine") ? engine : oauth);
            }
            oauth.start(true, true); // Synthetic sender; deliberately never launch a live browser/provider.
            String state = journal.value.state;
            activity.runOnUiThread(() -> activity.getBridge().getWebView().loadUrl("https://localhost/locations"));
            awaitJs(activity, "document.body.innerText.includes('Отменить вход')");
            assertEquals("true", evaluate(activity, "Array.from(document.querySelectorAll('.mobile-oauth-status button')).every(b => b.getBoundingClientRect().height >= 48)"));
            capture("yandex-awaiting-return.png");
            Intent callback = new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(AndroidYandexLoginTest.TARGET + "#code=" + AndroidYandexLoginTest.CODE + "&state=" + state));
            activity.runOnUiThread(() -> plugin.handleOnNewIntent(callback));
            awaitJs(activity, "document.body.innerText.includes('Локации') && !document.body.innerText.includes('Отменить вход')");
            assertNotNull(credentials.value); assertEquals(state, credentials.value.oauthState);
            assertNull(journal.value); assertNull(callback.getData());
            assertEquals(1, requests.stream().filter(request -> request.path.endsWith("/exchange")).count());
            assertEquals("true", evaluate(activity, "!location.href.includes('code=') && !JSON.stringify(localStorage).includes('synthetic_refresh') && !JSON.stringify(sessionStorage).includes('synthetic_refresh')"));
            assertEquals("true", evaluate(activity, "document.documentElement.scrollWidth <= window.innerWidth"));
            capture("yandex-return-cabinet.png");
        } finally { activity.runOnUiThread(activity::finish); }
    }

    @Test public void staleDirectoryNoticeRendersAndDenialDiscardsRetainedBody() throws Exception {
        org.junit.Assume.assumeTrue("true".equals(InstrumentationRegistry.getArguments().getString("configuredApp")));
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(
            new Intent(instrumentation.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            awaitJs(activity, "typeof Capacitor !== 'undefined' && document.body.innerText.includes('Получить код')");
            AndroidReadCacheTest.Fixture fixture = new AndroidReadCacheTest.Fixture();
            org.json.JSONObject session = new org.json.JSONObject(AndroidSessionTest.SESSION);
            session.getJSONObject("user").put("displayName", "Тестовый игрок");
            session.getJSONObject("context").put("displayName", "Тестовый игрок")
                .put("roles", new org.json.JSONArray().put("client")).put("permissions", new org.json.JSONArray());
            fixture.sessionBody = session.toString();
            fixture.locationsBody = "{\"items\":[{\"id\":\"" + AndroidSessionTest.KEY + "\",\"title\":\"Тестовая локация из кэша\",\"city\":\"Москва\",\"courtCount\":2,\"coverImageUrl\":null,\"route\":\"/locations/" + AndroidSessionTest.KEY + "\"}]}";
            fixture.read(AndroidReadCacheTest.LOCATIONS); fixture.clock.advance(60_000);
            fixture.failure = "NATIVE_NETWORK_UNAVAILABLE";
            Object plugin = activity.getBridge().getPlugin("PadlHubAndroidSession").getInstance();
            java.lang.reflect.Field engine = PadlHubAndroidSessionPlugin.class.getDeclaredField("engine");
            engine.setAccessible(true); engine.set(plugin, fixture.engine);
            // Injection exists only in this instrumentation APK, never in the production bridge.
            activity.runOnUiThread(() -> activity.getBridge().getWebView().loadUrl("https://localhost/locations"));
            awaitJs(activity, "!!document.querySelector('.mobile-cache-notice') && document.body.innerText.includes('Тестовая локация из кэша')");
            assertEquals("true", evaluate(activity, "document.querySelector('.mobile-cache-notice').getAttribute('role') === 'status' && !!document.querySelector('.mobile-cache-notice time')"));
            assertEquals("true", evaluate(activity, "document.documentElement.scrollWidth <= window.innerWidth"));
            capture("cache-stale-portrait.png");
            activity.runOnUiThread(() -> activity.setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
            awaitJs(activity, "window.innerWidth > window.innerHeight");
            assertEquals("true", evaluate(activity, "document.documentElement.scrollWidth <= window.innerWidth"));
            capture("cache-stale-landscape.png");
            fixture.failure = null; fixture.apiStatus = 403;
            evaluate(activity, "history.pushState({}, '', '/locations/" + AndroidSessionTest.KEY + "'); dispatchEvent(new PopStateEvent('popstate')); true");
            awaitJs(activity, "!document.querySelector('.location-directory-list')");
            evaluate(activity, "history.pushState({}, '', '/locations'); dispatchEvent(new PopStateEvent('popstate')); true");
            awaitJs(activity, "document.body.innerText.includes('Не удалось загрузить локации') && !document.body.innerText.includes('Тестовая локация из кэша')");
            assertEquals("true", evaluate(activity, "!document.querySelector('.mobile-cache-notice')"));
            capture("cache-denied.png");
        } finally {
            activity.runOnUiThread(() -> { activity.setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED); activity.finish(); });
        }
    }
}
