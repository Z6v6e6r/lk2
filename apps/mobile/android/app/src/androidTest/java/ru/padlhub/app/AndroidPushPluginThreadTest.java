package ru.padlhub.app;

import android.app.Instrumentation;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.os.Looper;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginHandle;
import java.io.File;
import java.lang.reflect.Field;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Real WebView/Capacitor worker regression; no FCM token request, login or network transport. */
@RunWith(AndroidJUnit4.class)
public class AndroidPushPluginThreadTest {
    Instrumentation instrumentation;
    MainActivity activity;
    PluginHandle handle;
    File directory;

    @Before public void setup() throws Exception {
        instrumentation = InstrumentationRegistry.getInstrumentation();
        Context base = instrumentation.getTargetContext();
        activity = (MainActivity) instrumentation.startActivitySync(
            new Intent(base, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        handle = activity.getBridge().getPlugin("PadlHubAndroidPush");
        directory = new File(base.getCacheDir(), "push-thread-test-" + UUID.randomUUID());
        assertTrue(directory.mkdirs());
        Context context = new ContextWrapper(base) {
            @Override public File getNoBackupFilesDir() { return directory; }
            @Override public Context getApplicationContext() { return this; }
        };
        AndroidSessionPolicy policy = new AndroidSessionPolicy("https://lk2.padlhub.su",
            "thread-test-" + UUID.randomUUID(), "test", "9", false);
        Field field = PadlHubAndroidPushPlugin.class.getDeclaredField("state");
        field.setAccessible(true);
        instrumentation.runOnMainSync(() -> {
            try { field.set(handle.getInstance(), new AndroidPushState(context, policy)); }
            catch (IllegalAccessException error) { throw new AssertionError(error); }
        });
        awaitOrigin(true);
    }

    @After public void cleanup() throws Exception {
        if (activity != null) instrumentation.runOnMainSync(activity::finish);
        if (directory != null) {
            File[] files = directory.listFiles();
            if (files != null) for (File file : files) assertTrue(file.delete());
            assertTrue(directory.delete());
        }
    }

    static final class ResultCall extends PluginCall {
        final CountDownLatch done = new CountDownLatch(1);
        volatile JSObject value;
        volatile String code;
        volatile Looper callbackLooper;
        ResultCall(String method) {
            super(null, "PadlHubAndroidPush", "thread-test", method, new JSObject());
        }
        @Override public void resolve(JSObject result) { value = result; complete(); }
        @Override public void resolve() { value = new JSObject(); complete(); }
        @Override public void reject(String message, String errorCode) { code = errorCode; complete(); }
        private void complete() { callbackLooper = Looper.myLooper(); done.countDown(); }
    }

    ResultCall callFromWorker(String method) throws Exception {
        ResultCall call = new ResultCall(method);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        CountDownLatch invoked = new CountDownLatch(1);
        new Thread(() -> {
            try {
                assertNotSame(Looper.getMainLooper(), Looper.myLooper());
                handle.invoke(method, call);
            } catch (Throwable error) { failure.set(error); }
            finally { invoked.countDown(); }
        }, "push-regression-worker").start();
        assertTrue("Plugin invocation completed", invoked.await(5, TimeUnit.SECONDS));
        assertNull("Background plugin call must not touch WebView", failure.get());
        assertTrue("Plugin response completed", call.done.await(5, TimeUnit.SECONDS));
        assertSame("Response follows main-thread origin validation", Looper.getMainLooper(), call.callbackLooper);
        return call;
    }

    @Test public void backgroundStatusAndSuspendUseMainLooperWithARealWebView() throws Exception {
        ResultCall status = callFromWorker("status");
        assertNull(status.code);
        assertNotNull(status.value.getString("installationId"));
        assertFalse(status.value.getBoolean("active"));
        ResultCall suspend = callFromWorker("suspend");
        assertNull(suspend.code);
        assertNotNull(suspend.value.getString("installationId"));
        assertNull(callFromWorker("takeOpened").code);
    }

    @Test public void allPushCommandsRejectAnUntrustedDocumentOnMainLooper() throws Exception {
        instrumentation.runOnMainSync(() -> activity.getBridge().getWebView().loadDataWithBaseURL(
            "https://untrusted.invalid/", "<!doctype html><title>Local negative fixture</title>",
            "text/html", "UTF-8", null));
        awaitOrigin(false);
        File stateFile = new File(directory, "padlhub-push.json");
        byte[] before = stateFile.exists() ? java.nio.file.Files.readAllBytes(stateFile.toPath()) : null;
        for (String method : new String[] { "status", "registration", "activate", "suspend", "finishRevoke", "takeOpened" }) {
            assertEquals(method, "NATIVE_REQUEST_REJECTED", callFromWorker(method).code);
        }
        byte[] after = stateFile.exists() ? java.nio.file.Files.readAllBytes(stateFile.toPath()) : null;
        assertArrayEquals("Denied calls must not change push state", before, after);
    }

    @Test public void javascriptStatusThroughTheActualCapacitorWorkerResolves() throws Exception {
        boolean ready = false;
        for (int i = 0; i < 200; i++) {
            if ("true".equals(evaluate("typeof window.Capacitor?.nativePromise === 'function'"))) { ready = true; break; }
            Thread.sleep(100);
        }
        assertTrue("Actual Capacitor bridge loaded", ready);
        String script = "window.__pushThreadResult='pending'; Capacitor.nativePromise('PadlHubAndroidPush','status',{})"
            + ".then(v => window.__pushThreadResult=(typeof v.configured==='boolean' ? 'resolved' : 'invalid'))"
            + ".catch(e => window.__pushThreadResult='rejected'); true";
        evaluate(script);
        for (int i = 0; i < 100; i++) {
            String result = evaluate("window.__pushThreadResult");
            if ("\"resolved\"".equals(result)) return;
            assertNotEquals("Native bridge rejected the bundled page", "\"rejected\"", result);
            Thread.sleep(100);
        }
        fail("CapacitorPlugins status response did not resolve");
    }

    void awaitOrigin(boolean bundled) throws Exception {
        for (int i = 0; i < 200; i++) {
            AtomicReference<String> url = new AtomicReference<>();
            instrumentation.runOnMainSync(() -> url.set(activity.getBridge().getWebView().getUrl()));
            if (url.get() != null && PadlHubAndroidSessionPlugin.bundledOrigin(android.net.Uri.parse(url.get())) == bundled) return;
            Thread.sleep(100);
        }
        fail("Expected WebView origin was not loaded");
    }

    String evaluate(String script) throws Exception {
        AtomicReference<String> value = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        instrumentation.runOnMainSync(() -> activity.getBridge().getWebView().evaluateJavascript(script,
            result -> { value.set(result); done.countDown(); }));
        assertTrue("JavaScript callback", done.await(5, TimeUnit.SECONDS));
        return value.get();
    }
}
