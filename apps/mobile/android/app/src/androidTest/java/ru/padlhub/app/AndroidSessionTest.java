package ru.padlhub.app;

import android.content.Context;
import android.net.Uri;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;
import static ru.padlhub.app.AndroidSessionEngine.*;
import static ru.padlhub.app.AndroidSessionPolicy.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

@RunWith(AndroidJUnit4.class)
public class AndroidSessionTest {
    static final String ORIGIN = "https://lk2.padlhub.su";
    static final String ROOT = "/user/api/v1/local-padel";
    static final String REFRESH = "synthetic_refresh_credential_00000000000000001";
    static final String SUCCESSOR = "synthetic_refresh_credential_00000000000000002";
    static final String KEY = "00000000-0000-4000-8000-000000000001";
    static final String NEXT_KEY = "00000000-0000-4000-8000-000000000002";
    static final String JWT = "eyJ0ZXN0Ijp0cnVlfQ.eyJpZCI6InN5bnRoZXRpYyJ9.c3ludGhldGlj";
    static final String SESSION = "{\"accessToken\":\"" + JWT + "\",\"tokenType\":\"Bearer\",\"expiresAt\":\"2099-01-01T00:00:00Z\",\"user\":{\"id\":\"" + KEY + "\"},\"context\":{\"userId\":\"" + KEY + "\",\"tenantId\":\"" + NEXT_KEY + "\"}}";
    static final String VERIFY = ROOT + "/auth/challenges/" + KEY + "/verify";
    static final String VERIFY_BODY = "{\"code\":\"0000\",\"acceptance\":{\"publicOfferAccepted\":true,\"personalDataPolicyAccepted\":true}}";

    AndroidSessionPolicy policy() throws Failure { return new AndroidSessionPolicy(ORIGIN, "local-padel", "test", "2", false); }
    Credential credential() { return new Credential(ORIGIN + "|local-padel", REFRESH, System.currentTimeMillis() + 60_000, null, null); }
    static Map<String, String> headers(String intent, String key) {
        Map<String, String> result = new HashMap<>(); result.put("idempotency-key", key);
        if (intent != null) result.put("x-session-intent", intent);
        return result;
    }
    static String cookie(String value) { return "phub_refresh=" + value + "; Path=" + ROOT + "/auth; Max-Age=3600; Secure; HttpOnly; SameSite=Lax"; }
    static Response session(String value) { return response(200, SESSION, Collections.singletonList(cookie(value))); }
    static Response response(int status, String body, List<String> cookies) {
        return new Response(status, Collections.singletonMap("content-type", "application/json"), cookies, body.getBytes(StandardCharsets.UTF_8));
    }
    static class MemoryStore implements Store {
        Credential value;
        boolean failWrite;
        String logout;
        public Credential read() { return value; }
        public void write(Credential next) throws Failure { if (failWrite) throw new Failure("NATIVE_STORAGE_UNAVAILABLE"); value = next; }
        public void clear() { value = null; }
        public String logoutIntent() { return logout; }
        public void beginLogout(String key) { if (logout == null) logout = key; }
        public void clearLogoutIntent() { logout = null; }
    }
    interface Attempt { void run() throws Exception; }
    void fails(String code, Attempt attempt) throws Exception {
        try { attempt.run(); fail("Expected " + code); }
        catch (Failure error) { assertEquals(code, error.code); }
    }

    @Test public void configAndCallerArePinnedToReviewedOrigins() throws Exception {
        for (String origin : Arrays.asList("http://lk2.padlhub.su", ORIGIN + "/", ORIGIN + ":443", ORIGIN + ".evil.invalid", "https://lk.nano.padlhub.su"))
            fails("NATIVE_CONFIGURATION_REQUIRED", () -> new AndroidSessionPolicy(origin, "local-padel", "test", "2", false));
        new AndroidSessionPolicy("https://lk.nano.padlhub.su", "local-padel", "test", "2", true);
        assertTrue(PadlHubAndroidSessionPlugin.bundledOrigin(Uri.parse("https://localhost/profile")));
        for (String uri : Arrays.asList("http://localhost", "https://localhost.evil.invalid", "https://user@localhost", "https://localhost:444", "file:///asset", ORIGIN))
            assertFalse(PadlHubAndroidSessionPlugin.bundledOrigin(Uri.parse(uri)));
    }

    @Test public void positiveRoutePolicyRejectsTenantTraversalProvidersAndWrites() throws Exception {
        AndroidSessionPolicy policy = policy();
        Map<String, String> auth = Collections.singletonMap("authorization", "Bearer synthetic-access");
        policy.request(ROOT + "/profile", "GET", auth, null);
        policy.request(ROOT + "/bookings/history?limit=10", "GET", auth, null);
        for (String path : Arrays.asList(ROOT + "/auth/viva/access", ROOT + "/booking-screen-read-jobs", ROOT + "/unknown", ROOT + "/profile/../context", ROOT + "/%70rofile", ROOT + "/notification-endpoints/web", "/user/api/v1/other/profile", ORIGIN + ROOT + "/profile", "/public/api/v1/local-padel/games"))
            fails("NATIVE_REQUEST_REJECTED", () -> policy.request(path, "GET", auth, null));
        fails("NATIVE_REQUEST_REJECTED", () -> policy.request(ROOT + "/profile", "PUT", headers(null, KEY), "{}"));
        fails("NATIVE_REQUEST_REJECTED", () -> policy.request(ROOT + "/auth/session/refresh?target=evil", "POST", headers("refresh", KEY), null));
        Map<String, String> injected = headers("refresh", KEY); injected.put("cookie", "synthetic");
        fails("NATIVE_REQUEST_REJECTED", () -> policy.request(ROOT + "/auth/session/refresh", "POST", injected, null));
    }

    @Test public void verifiesBeforePersistingAndHidesRefreshFromBridge() throws Exception {
        MemoryStore store = new MemoryStore();
        AndroidSessionEngine engine = new AndroidSessionEngine(policy(), store, request -> session(REFRESH));
        Response result = engine.request(VERIFY, "POST", headers(null, KEY), VERIFY_BODY);
        assertEquals(200, result.status); assertEquals(REFRESH, store.value.value);
        assertTrue(result.cookies.isEmpty()); assertFalse(result.headers.containsKey("set-cookie"));
        assertFalse(new String(result.body, StandardCharsets.UTF_8).contains(REFRESH));
    }

    @Test public void responseLostAfterRefreshReplaysSamePredecessorKeyAcrossEngineRestart() throws Exception {
        MemoryStore store = new MemoryStore(); store.value = credential();
        List<Request> sent = new ArrayList<>();
        AndroidSessionEngine first = new AndroidSessionEngine(policy(), store, request -> { sent.add(request); throw new Failure("NATIVE_NETWORK_UNAVAILABLE"); });
        fails("NATIVE_NETWORK_UNAVAILABLE", () -> first.request(ROOT + "/auth/session/refresh", "POST", headers("refresh", KEY), null));
        assertEquals(KEY, store.value.refreshKey);
        AndroidSessionEngine restarted = new AndroidSessionEngine(policy(), store, request -> { sent.add(request); return session(SUCCESSOR); });
        restarted.request(ROOT + "/auth/session/refresh", "POST", headers("refresh", NEXT_KEY), null);
        assertEquals(KEY, sent.get(1).headers.get("idempotency-key"));
        assertEquals("phub_refresh=" + REFRESH, sent.get(1).headers.get("cookie"));
        assertEquals(SUCCESSOR, store.value.value); assertNull(store.value.refreshKey);
    }

    @Test public void pendingLogoutRecoversSuccessorAndNeverRestoresAccount() throws Exception {
        MemoryStore store = new MemoryStore(); store.value = credential().journal(KEY, null);
        List<Request> sent = new ArrayList<>();
        AndroidSessionEngine engine = new AndroidSessionEngine(policy(), store, request -> {
            sent.add(request);
            if (request.operation == Operation.REFRESH) return session(SUCCESSOR);
            throw new Failure("NATIVE_NETWORK_UNAVAILABLE");
        });
        fails("NATIVE_NETWORK_UNAVAILABLE", () -> engine.request(ROOT + "/auth/session", "DELETE", headers("logout", NEXT_KEY), null));
        assertEquals(SUCCESSOR, store.value.value); assertEquals(NEXT_KEY, store.value.logoutKey);
        assertEquals(401, engine.request(ROOT + "/profile", "GET", Collections.singletonMap("authorization", "Bearer synthetic-access"), null).status);
        assertEquals(2, sent.size());
        AndroidSessionEngine restarted = new AndroidSessionEngine(policy(), store, request -> { sent.add(request); return Response.loggedOut(); });
        assertEquals(401, restarted.request(ROOT + "/auth/session/refresh", "POST", headers("refresh", KEY), null).status);
        assertEquals(Operation.LOGOUT, sent.get(2).operation);
        assertEquals("phub_refresh=" + SUCCESSOR, sent.get(2).headers.get("cookie"));
        assertEquals(NEXT_KEY, sent.get(2).headers.get("idempotency-key")); assertNull(store.value);
    }

    @Test public void unavailableStorageNeverReleasesAccessOrStartsRotation() throws Exception {
        MemoryStore store = new MemoryStore(); store.failWrite = true;
        AndroidSessionEngine engine = new AndroidSessionEngine(policy(), store, request -> session(REFRESH));
        fails("NATIVE_STORAGE_UNAVAILABLE", () -> engine.request(VERIFY, "POST", headers(null, KEY), VERIFY_BODY));
        assertNull(store.value);
        store.value = credential();
        AndroidSessionEngine offline = new AndroidSessionEngine(policy(), store, request -> { fail("Must journal before sending"); return null; });
        fails("NATIVE_STORAGE_UNAVAILABLE", () -> offline.request(ROOT + "/auth/session/refresh", "POST", headers("refresh", KEY), null));
        fails("NATIVE_STORAGE_UNAVAILABLE", () -> offline.request(ROOT + "/auth/session", "DELETE", headers("logout", NEXT_KEY), null));
        fails("NATIVE_STORAGE_UNAVAILABLE", () -> offline.request(ROOT + "/profile", "GET", Collections.singletonMap("authorization", "Bearer synthetic-access"), null));
    }

    @Test public void malformedCookiesAndRedirectsPreservePredecessor() throws Exception {
        for (List<String> cookies : Arrays.asList(Collections.<String>emptyList(), Arrays.asList(cookie(SUCCESSOR), cookie(SUCCESSOR)),
            Collections.singletonList(cookie(SUCCESSOR) + "; Domain=lk2.padlhub.su"),
            Collections.singletonList(cookie(SUCCESSOR) + "; SameSite=None"),
            Collections.singletonList(cookie(SUCCESSOR).replace("; Secure", "")),
            Collections.singletonList(cookie(SUCCESSOR).replace("/auth;", "/;")))) {
            MemoryStore store = new MemoryStore(); store.value = credential();
            AndroidSessionEngine engine = new AndroidSessionEngine(policy(), store, request -> response(200, SESSION, cookies));
            fails("NATIVE_RESPONSE_REJECTED", () -> engine.request(ROOT + "/auth/session/refresh", "POST", headers("refresh", KEY), null));
            assertEquals(REFRESH, store.value.value); assertEquals(KEY, store.value.refreshKey);
        }
        MemoryStore store = new MemoryStore(); store.value = credential();
        AndroidSessionEngine redirect = new AndroidSessionEngine(policy(), store, request -> response(302, "", Collections.emptyList()));
        fails("NATIVE_REDIRECT_REJECTED", () -> redirect.request(ROOT + "/auth/session/refresh", "POST", headers("refresh", KEY), null));
        assertEquals(REFRESH, store.value.value);
    }

    @Test public void logoutIntentSurvivesCredentialWriteFailureAndProcessDeath() throws Exception {
        MemoryStore store = new MemoryStore(); store.value = credential(); store.failWrite = true;
        AndroidSessionEngine first = new AndroidSessionEngine(policy(), store, request -> { fail("No request before intent journal"); return null; });
        fails("NATIVE_STORAGE_UNAVAILABLE", () -> first.request(ROOT + "/auth/session", "DELETE", headers("logout", KEY), null));
        assertEquals(KEY, store.logout); assertNull(store.value.logoutKey);
        store.failWrite = false;
        List<Request> sent = new ArrayList<>();
        AndroidSessionEngine restarted = new AndroidSessionEngine(policy(), store, request -> { sent.add(request); return Response.loggedOut(); });
        assertEquals(401, restarted.request(ROOT + "/profile", "GET", Collections.singletonMap("authorization", "Bearer synthetic-access"), null).status);
        assertEquals(401, restarted.request(ROOT + "/auth/session/refresh", "POST", headers("refresh", NEXT_KEY), null).status);
        assertEquals(1, sent.size()); assertEquals(Operation.LOGOUT, sent.get(0).operation);
        assertEquals(KEY, sent.get(0).headers.get("idempotency-key")); assertNull(store.value); assertNull(store.logout);
    }

    @Test public void expiryRevocationAndTransientFailureAreDistinct() throws Exception {
        MemoryStore store = new MemoryStore(); store.value = credential();
        AndroidSessionEngine engine = new AndroidSessionEngine(policy(), store, request -> response(503, "{}", Collections.emptyList()));
        assertEquals(503, engine.request(ROOT + "/auth/session/refresh", "POST", headers("refresh", KEY), null).status);
        assertNotNull(store.value);
        AndroidSessionEngine revoked = new AndroidSessionEngine(policy(), store, request -> Response.signedOut());
        assertEquals(401, revoked.request(ROOT + "/auth/session/refresh", "POST", headers("refresh", NEXT_KEY), null).status);
        assertNull(store.value);
        store.value = new Credential(ORIGIN + "|local-padel", REFRESH, 1, null, null);
        AndroidSessionEngine expired = new AndroidSessionEngine(policy(), store, request -> { fail("Expired must not send"); return null; });
        assertEquals(401, expired.request(ROOT + "/auth/session/refresh", "POST", headers("refresh", KEY), null).status);
        assertNull(store.value);
    }

    @Test public void realKeystorePersistsOnlyCiphertextAndIsolatesScope() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String scope = ORIGIN + "|instrumentation-" + UUID.randomUUID();
        AndroidCredentialStore store = new AndroidCredentialStore(context, scope);
        StringBuilder suffix = new StringBuilder();
        for (byte value : java.security.MessageDigest.getInstance("SHA-256").digest(scope.getBytes(StandardCharsets.UTF_8))) suffix.append(String.format(Locale.ROOT, "%02x", value));
        java.io.File file = new java.io.File(context.getNoBackupFilesDir(), "session-" + suffix + ".bin");
        try {
            store.write(new Credential(scope, REFRESH, System.currentTimeMillis() + 60_000, KEY, NEXT_KEY));
            String bytes = new String(java.nio.file.Files.readAllBytes(file.toPath()), StandardCharsets.ISO_8859_1);
            assertFalse(bytes.contains(REFRESH)); assertFalse(bytes.contains(KEY)); assertFalse(bytes.contains(scope));
            Credential read = new AndroidCredentialStore(context, scope).read();
            assertEquals(REFRESH, read.value); assertEquals(KEY, read.refreshKey); assertEquals(NEXT_KEY, read.logoutKey);
            store.beginLogout(NEXT_KEY);
            assertEquals(NEXT_KEY, new AndroidCredentialStore(context, scope).logoutIntent());
            assertNull(new AndroidCredentialStore(context, scope + "-other").read());
            byte[] damaged = java.nio.file.Files.readAllBytes(file.toPath()); damaged[damaged.length - 1] ^= 1;
            java.nio.file.Files.write(file.toPath(), damaged);
            fails("NATIVE_STORAGE_UNAVAILABLE", store::read);
        } finally {
            store.clear();
            store.clearLogoutIntent();
            java.security.KeyStore keys = java.security.KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
            keys.deleteEntry(context.getPackageName() + ".session." + suffix);
        }
    }
}
