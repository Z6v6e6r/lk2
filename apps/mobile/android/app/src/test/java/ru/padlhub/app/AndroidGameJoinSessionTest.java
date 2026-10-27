package ru.padlhub.app;

import org.junit.Test;
import static org.junit.Assert.*;
import static ru.padlhub.app.AndroidSessionPolicy.*;
import static ru.padlhub.app.AndroidSessionEngine.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Host-JVM tests of the real Java policy/engine; not device or provider acceptance. */
public class AndroidGameJoinSessionTest {
    static final String ORIGIN = "https://lk2.padlhub.su";
    static final String ROOT = "/user/api/v1/local-padel";
    static final String GAME = "11111111-1111-4111-8111-111111111111";
    static final String SUBSCRIPTION = "22222222-2222-4222-8222-222222222222";
    static final String KEY = "33333333-3333-4333-8333-333333333333";
    static final String BODY = "{\"expectedRevision\":1,\"subscriptionInstanceId\":\"" + SUBSCRIPTION + "\",\"priceConsent\":{\"amountMinor\":0,\"currency\":\"RUB\"}}";
    static AndroidSessionPolicy policy() throws Failure {
        return new AndroidSessionPolicy(ORIGIN, "local-padel", "test", "2", false);
    }
    static Map<String, String> headers() {
        Map<String, String> result = new HashMap<>();
        result.put("authorization", "Bearer synthetic-access");
        result.put("idempotency-key", KEY);
        return result;
    }
    static class MemoryStore implements Store {
        Credential value = new Credential(ORIGIN + "|local-padel", "synthetic_refresh_credential_00000000000000001", System.currentTimeMillis() + 60_000, null, null);
        public Credential read() { return value; }
        public void write(Credential next) { value = next; }
        public void clear() { value = null; }
        public String logoutIntent() { return null; }
        public void beginLogout(String key) { }
        public void clearLogoutIntent() { }
    }
    interface Attempt { void run() throws Exception; }
    static void rejected(Attempt attempt) throws Exception {
        try { attempt.run(); fail("Expected NATIVE_REQUEST_REJECTED"); }
        catch (Failure failure) { assertEquals("NATIVE_REQUEST_REJECTED", failure.code); }
    }

    @Test public void forwardsOriginalPaidJoinAndExplicitSameKeyReadback() throws Exception {
        List<Request> sent = new ArrayList<>();
        AndroidSessionEngine engine = new AndroidSessionEngine(policy(), new MemoryStore(), request -> {
            sent.add(request);
            return new Response(200, Collections.singletonMap("content-type", "application/json"), Collections.emptyList(), "{}".getBytes(StandardCharsets.UTF_8));
        });
        engine.request(ROOT + "/games?scope=UPCOMING&limit=20", "GET", headers(), null);
        engine.request(ROOT + "/games/" + GAME, "GET", headers(), null);
        engine.request(ROOT + "/games/" + GAME + "/join-conditions?expectedRevision=1&subscriptionInstanceId=" + SUBSCRIPTION, "GET", headers(), null);
        engine.request(ROOT + "/games/" + GAME + "/join", "POST", headers(), BODY);
        engine.request(ROOT + "/games/" + GAME + "/join-operation", "GET", headers(), null);
        assertEquals(5, sent.size());
        assertEquals(1, sent.stream().filter(request -> request.method.equals("POST")).count());
        assertEquals(BODY, new String(sent.get(3).body, StandardCharsets.UTF_8));
        assertEquals(KEY, sent.get(3).headers.get("idempotency-key"));
        assertEquals(KEY, sent.get(4).headers.get("idempotency-key"));
        assertEquals(Operation.API, sent.get(4).operation);
    }

    @Test public void doesNotReplayPaidJoinOrRefreshAfterHttpFailure() throws Exception {
        for (int status : new int[] { 401, 503 }) {
            List<Request> sent = new ArrayList<>();
            AndroidSessionEngine engine = new AndroidSessionEngine(policy(), new MemoryStore(), request -> {
                sent.add(request);
                return new Response(status, Collections.emptyMap(), Collections.emptyList(), "{}".getBytes(StandardCharsets.UTF_8));
            });
            assertEquals(status, engine.request(ROOT + "/games/" + GAME + "/join", "POST", headers(), BODY).status);
            assertEquals(1, sent.size());
            assertEquals(KEY, sent.get(0).headers.get("idempotency-key"));
        }
    }

    @Test public void preservesCallerKeyAfterNetworkFailureWithoutRetryingPost() throws Exception {
        List<Request> sent = new ArrayList<>();
        AndroidSessionEngine engine = new AndroidSessionEngine(policy(), new MemoryStore(), request -> {
            sent.add(request);
            if (request.method.equals("POST")) throw new Failure("NATIVE_NETWORK_UNAVAILABLE");
            return new Response(200, Collections.emptyMap(), Collections.emptyList(), "{}".getBytes(StandardCharsets.UTF_8));
        });
        try {
            engine.request(ROOT + "/games/" + GAME + "/join", "POST", headers(), BODY);
            fail("Expected uncertain network failure");
        } catch (Failure failure) { assertEquals("NATIVE_NETWORK_UNAVAILABLE", failure.code); }
        assertEquals(1, sent.size());
        engine.request(ROOT + "/games/" + GAME + "/join-operation", "GET", headers(), null);
        assertEquals(2, sent.size());
        assertEquals("GET", sent.get(1).method);
        assertEquals(KEY, sent.get(0).headers.get("idempotency-key"));
        assertEquals(KEY, sent.get(1).headers.get("idempotency-key"));
    }

    @Test public void acceptsHistoryCursorAndEitherConditionParameterOrder() throws Exception {
        AndroidSessionPolicy policy = policy();
        policy.request(ROOT + "/games?cursor=eyJpZCI6MX0&limit=100&scope=HISTORY", "GET", headers(), null);
        policy.request(ROOT + "/games/" + GAME + "/join-conditions?subscriptionInstanceId=" + SUBSCRIPTION + "&expectedRevision=9007199254740991", "GET", headers(), null);
        rejected(() -> policy.request(ROOT + "/games/" + GAME + "/join-conditions?expectedRevision=9007199254740992&subscriptionInstanceId=" + SUBSCRIPTION, "GET", headers(), null));
        rejected(() -> policy.request(ROOT + "/games?scope=UPCOMING%26limit=20", "GET", headers(), null));
        rejected(() -> policy.request(ROOT + "/games?cursor=first&cursor=second", "GET", headers(), null));
    }

    @Test public void keepsOtherMutationsProvidersAndCrossTenantRoutesClosed() throws Exception {
        AndroidSessionPolicy policy = policy();
        for (String path : Arrays.asList(ROOT + "/games", ROOT + "/games/" + GAME + "/cancel", ROOT + "/games/" + GAME + "/waitlist", ROOT + "/booked-operation-admissions", ROOT + "/auth/viva/access", "/user/api/v1/other/games/" + GAME, ORIGIN + ROOT + "/games/" + GAME))
            rejected(() -> policy.request(path, "POST", headers(), BODY));
        rejected(() -> policy.request(ROOT + "/games/" + GAME + "/participants/me", "DELETE", headers(), null));
        rejected(() -> policy.request(ROOT + "/games/" + GAME + "/join?retry=1", "POST", headers(), BODY));
        rejected(() -> policy.request(ROOT + "/games/" + GAME, "GET", Collections.emptyMap(), null));
    }

    @Test public void rejectsUnreviewedGameQueriesAndMissingRecoveryKey() throws Exception {
        AndroidSessionPolicy policy = policy();
        for (String path : Arrays.asList(
            "/games?scope=ALL", "/games?limit=101", "/games?scope=UPCOMING&scope=HISTORY", "/games?source=viva",
            "/games/" + GAME + "?source=viva", "/games/" + GAME + "/join-operation?key=" + KEY,
            "/games/" + GAME + "/join-conditions", "/games/" + GAME + "/join-conditions?expectedRevision=1",
            "/games/" + GAME + "/join-conditions?expectedRevision=1&subscriptionInstanceId=" + SUBSCRIPTION + "&source=viva",
            "/games/" + GAME + "/join-conditions?expectedRevision=1&expectedRevision=2&subscriptionInstanceId=" + SUBSCRIPTION))
            rejected(() -> policy.request(ROOT + path, "GET", headers(), null));
        Map<String, String> missingKey = headers(); missingKey.remove("idempotency-key");
        rejected(() -> policy.request(ROOT + "/games/" + GAME + "/join-operation", "GET", missingKey, null));
        rejected(() -> policy.request(ROOT + "/games/" + GAME + "/join", "POST", missingKey, BODY));
    }

    @Test public void forwardsCanonicalReceiptReconciliationWithTheSameKey() throws Exception {
        AndroidSessionPolicy policy = policy();
        String reconcile = ROOT + "/game-operations/" + KEY + "/reconcile";
        Request request = policy.request(reconcile, "POST", headers(), null);
        assertEquals(Operation.API, request.operation);
        assertEquals(KEY, request.headers.get("idempotency-key"));
        // The reconcile route is a POST command with a reviewed idempotency key on the same
        // operation id; no other game mutation is opened by this increment.
        Map<String, String> missingKey = headers(); missingKey.remove("idempotency-key");
        rejected(() -> policy.request(reconcile, "POST", missingKey, null));
        rejected(() -> policy.request(ROOT + "/game-operations/" + GAME + "/reconcile", "GET", headers(), null));
        rejected(() -> policy.request(ROOT + "/games/" + GAME + "/reconcile", "POST", headers(), null));
    }
}
