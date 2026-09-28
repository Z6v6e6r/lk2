package ru.padlhub.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.AtomicFile;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;
import static ru.padlhub.app.AndroidSessionPolicy.*;
import static ru.padlhub.app.AndroidSessionEngine.*;
import static ru.padlhub.app.AndroidSessionTest.*;

@RunWith(AndroidJUnit4.class)
public class AndroidYandexLoginTest {
    static String token(char c) { return new String(new char[43]).replace('\0', c); }
    static final String CODE = token('c');
    static final String TARGET = "https://lk2.padlhub.su/android/oauth/yandex";
    final AndroidSessionTest assertions = new AndroidSessionTest();
    static class Journal implements AndroidYandexLogin.Store {
        AndroidYandexLogin.Pending value;
        boolean failWrite, failClear;
        public AndroidYandexLogin.Pending read() { return value; }
        public void write(AndroidYandexLogin.Pending next) throws Failure { if (failWrite) throw AndroidCredentialStore.unavailable(); value = next; }
        public void clear() throws Failure { if (failClear) throw AndroidCredentialStore.unavailable(); value = null; }
    }
    static class Fixture {
        final Journal journal = new Journal();
        final MemoryStore credentials = new MemoryStore();
        final List<Request> requests = new ArrayList<>();
        final AndroidSessionPolicy policy;
        final long[] now = { 1_000 };
        boolean failExchange, wrongEcho;
        AndroidSessionEngine engine;
        AndroidYandexLogin login;
        Fixture() throws Exception {
            policy = new AndroidSessionPolicy(ORIGIN, "local-padel", "test", "4", false); restart();
        }
        Response send(Request request) throws Failure {
            requests.add(request);
            assertFalse(request.headers.containsKey("cookie"));
            assertFalse(request.headers.containsKey("authorization"));
            if (request.path.endsWith("/start")) return response(200, "{\"launchPath\":\"" + ROOT + "/auth/viva/android/launch?code=" + CODE + "\"}", Collections.emptyList());
            if (failExchange) throw new Failure("NATIVE_NETWORK_UNAVAILABLE");
            Response accepted = session(REFRESH);
            Map<String, String> headers = new HashMap<>(accepted.headers);
            headers.put("x-android-oauth-state", wrongEcho ? token('x') : journal.value.state);
            return new Response(200, headers, accepted.cookies, accepted.body);
        }
        void restart() {
            engine = new AndroidSessionEngine(policy, credentials, this::send);
            login = new AndroidYandexLogin(policy, engine, this::send, journal, () -> now[0]);
        }
        String callback() { return TARGET + "#code=" + CODE + "&state=" + journal.value.state; }
    }

    @Test public void startOwnsProofAndBrowserTargetAndRequiresConsentAndDurableCustody() throws Exception {
        Fixture f = new Fixture();
        assertions.fails("LEGAL_ACCEPTANCE_REQUIRED", () -> f.login.start(false, true));
        f.journal.failWrite = true;
        assertions.fails("NATIVE_STORAGE_UNAVAILABLE", () -> f.login.start(true, true));
        assertTrue(f.requests.isEmpty());
        f.journal.failWrite = false;
        String launch = f.login.start(true, true);
        assertEquals(ORIGIN + ROOT + "/auth/viva/android/launch?code=" + CODE, launch);
        JSONObject start = new JSONObject(f.requests.get(0).body);
        assertEquals(AndroidYandexLogin.challenge(f.journal.value.verifier), start.getString("codeChallenge"));
        assertFalse(start.has("codeVerifier"));
        assertFalse(launch.contains(f.journal.value.verifier));
        assertions.fails("NATIVE_OAUTH_PENDING", () -> f.login.start(true, true));
        for (String suffix : new String[] { "/start", "/exchange" })
            assertions.fails("NATIVE_REQUEST_REJECTED", () -> f.policy.request(ROOT + "/auth/viva/android" + suffix, "POST", headers(null, KEY), "{}"));
    }

    @Test public void callbackParserRejectsAuthorityPathQueryDuplicatesAndForeignAttempt() throws Exception {
        Fixture f = new Fixture(); f.login.start(true, true);
        String valid = f.callback();
        for (String forged : Arrays.asList(valid.replace("https:", "http:"), valid.replace("lk2.padlhub.su", "lk2.padlhub.su.evil.invalid"),
            valid.replace("https://", "https://user@"), valid.replace("/android/", "/%61ndroid/"), valid.replace("#", "?"),
            valid + "&code=" + CODE, valid + "&next=evil", valid.replace(f.journal.value.state, token('x')),
            valid.replace("/yandex#", "/yandex/#"), valid.replace(".su/", ".su:443/"))) assertFalse(f.login.callback(forged));
        assertNull(f.journal.value.code);
        assertTrue(f.login.callback(valid));
        assertTrue(f.login.callback(valid));
        assertFalse(f.login.callback(valid.replace(CODE, token('z'))));
        assertEquals(CODE, f.journal.value.code);
    }

    @Test public void pendingAttemptSurvivesRestartAndLateCancelledCallbackCannotSignIn() throws Exception {
        Fixture f = new Fixture(); f.login.start(true, true);
        String old = f.callback();
        f.restart(); assertEquals("waiting", f.login.status());
        f.login.cancel(); assertEquals("idle", f.login.status());
        f.login.start(true, true);
        assertFalse(f.login.callback(old));
        assertNull(f.credentials.value);
    }

    @Test public void lostExchangeReplaysExactProofAndKeyAfterRestart() throws Exception {
        Fixture f = new Fixture(); f.login.start(true, true); f.login.callback(f.callback());
        f.failExchange = true;
        assertions.fails("NATIVE_NETWORK_UNAVAILABLE", () -> f.login.status());
        assertions.fails("NATIVE_OAUTH_FINISH_REQUIRED", () -> f.login.cancel());
        Request lost = f.requests.get(1);
        f.restart(); f.failExchange = false;
        assertEquals("complete", f.login.status());
        Request replay = f.requests.get(2);
        assertEquals(lost.body, replay.body);
        assertEquals(lost.headers.get("idempotency-key"), replay.headers.get("idempotency-key"));
        assertEquals(REFRESH, f.credentials.value.value);
        assertNull(f.journal.value);
    }

    @Test public void writeOrClearFailureNeverLosesRecoveryOrReleasesAnUnstoredSession() throws Exception {
        Fixture f = new Fixture(); f.login.start(true, true); f.login.callback(f.callback());
        String state = f.journal.value.state;
        f.credentials.failWrite = true;
        assertions.fails("NATIVE_STORAGE_UNAVAILABLE", () -> f.login.status());
        assertNull(f.credentials.value); assertNotNull(f.journal.value);
        f.credentials.failWrite = false; f.journal.failClear = true;
        assertions.fails("NATIVE_STORAGE_UNAVAILABLE", () -> f.login.status());
        assertEquals(state, f.credentials.value.oauthState);
        int sent = f.requests.size();
        f.restart(); f.journal.failClear = false;
        assertEquals("complete", f.login.status());
        assertEquals(sent, f.requests.size()); assertNull(f.journal.value);
    }

    @Test public void responseMustEchoAttemptAndCannotReplaceAnotherSessionOrPendingLogout() throws Exception {
        Fixture f = new Fixture(); f.login.start(true, true); f.login.callback(f.callback());
        f.wrongEcho = true;
        assertions.fails("NATIVE_RESPONSE_REJECTED", () -> f.login.status());
        assertNull(f.credentials.value);
        f.credentials.value = new Credential(f.policy.scope, REFRESH, System.currentTimeMillis() + 60_000, null, null);
        assertions.fails("NATIVE_REQUEST_REJECTED", () -> f.login.status());
        f.credentials.value = null;
        f.credentials.logout = KEY; f.journal.value = f.journal.value.callback(null);
        assertFalse(f.login.callback(f.callback().replace(CODE, token('q'))));
        assertEquals("idle", f.login.status()); assertNull(f.journal.value);
    }

    @Test public void expiryAndLogoutDiscardPendingProofBeforeAnotherSessionCanBeRestored() throws Exception {
        Fixture f = new Fixture(); f.login.start(true, true);
        String callback = f.callback();
        f.login.beforeRequest(Operation.LOGOUT);
        assertFalse(f.login.callback(callback));
        f.login.start(true, true); f.login.callback(f.callback());
        f.now[0] += AndroidYandexLogin.MAX_AGE + 1;
        assertions.fails("NATIVE_OAUTH_EXPIRED", () -> f.login.status());
        assertNull(f.journal.value); assertNull(f.credentials.value);
    }

    @Test public void journalIsEncryptedScopedAndFailsClosedOnTamper() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String scope = "synthetic-oauth-test|" + UUID.randomUUID();
        AndroidOAuthStore store = new AndroidOAuthStore(context, scope);
        AndroidYandexLogin.Pending value = new AndroidYandexLogin.Pending(token('s'), token('v'), KEY, NEXT_KEY, CODE, System.currentTimeMillis() + 600_000);
        java.lang.reflect.Field field = AndroidOAuthStore.class.getDeclaredField("file"); field.setAccessible(true);
        AtomicFile file = (AtomicFile) field.get(store);
        try {
            store.write(value);
            byte[] bytes = file.readFully();
            String disk = new String(bytes, StandardCharsets.ISO_8859_1);
            assertFalse(disk.contains(value.verifier)); assertFalse(disk.contains(CODE));
            assertEquals(value.verifier, new AndroidOAuthStore(context, scope).read().verifier);
            assertNull(new AndroidOAuthStore(context, scope + "other").read());
            bytes[bytes.length - 1] ^= 1;
            try (FileOutputStream output = new FileOutputStream(file.getBaseFile())) { output.write(bytes); }
            assertions.fails("NATIVE_STORAGE_UNAVAILABLE", () -> store.read());
        } finally { store.clear(); }
    }

    @Test public void effectiveManifestResolvesOnlyTheHttpsAppLinkPath() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Intent valid = new Intent(Intent.ACTION_VIEW, Uri.parse(TARGET + "#code=" + CODE + "&state=" + token('s')))
            .addCategory(Intent.CATEGORY_BROWSABLE).setPackage(context.getPackageName());
        assertNotNull(context.getPackageManager().resolveActivity(valid, android.content.pm.PackageManager.MATCH_DEFAULT_ONLY));
        valid.setData(Uri.parse("https://lk2.padlhub.su/other"));
        assertNull(context.getPackageManager().resolveActivity(valid, android.content.pm.PackageManager.MATCH_DEFAULT_ONLY));
        valid.setData(Uri.parse("ru.padlhub.app:/oauth/yandex"));
        assertNull(context.getPackageManager().resolveActivity(valid, android.content.pm.PackageManager.MATCH_DEFAULT_ONLY));
    }
}
