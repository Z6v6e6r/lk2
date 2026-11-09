package ru.padlhub.app;

import org.junit.Test;
import static org.junit.Assert.*;
import static ru.padlhub.app.AndroidSessionPolicy.*;
import static ru.padlhub.app.AndroidSessionEngine.*;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.*;

/** Host-JVM tests of the real Java profile.read transport; not device or provider acceptance. */
public class AndroidProfileRefreshSessionTest {
    static final String ORIGIN = "https://lk2.padlhub.su";
    static final String ROOT = "/user/api/v1/local-padel";
    static final String KEY = "00000000-0000-4000-8000-000000000001";
    static final String NEXT_KEY = "00000000-0000-4000-8000-000000000002";
    static final String JOB = "00000000-0000-4000-8000-000000000020";
    static final String COMMAND = "00000000-0000-4000-8000-000000000021";
    static final String PROVIDER_ID = "00000000-0000-4000-8000-000000000030";
    static final String PROVIDER_TOKEN = "initial-viva-access-token";
    static final String PROFILE = "{\"id\":\"" + PROVIDER_ID + "\",\"deposit\":150000,\"customFields\":[]}";
    static final String REFRESH = "synthetic_refresh_credential_00000000000000001";
    static final String JWT = "eyJ0ZXN0Ijp0cnVlfQ.eyJpZCI6InN5bnRoZXRpYyJ9.c3ludGhldGlj";
    static final String SESSION = "{\"accessToken\":\"" + JWT + "\",\"tokenType\":\"Bearer\",\"expiresAt\":\"2099-01-01T00:00:00Z\",\"user\":{\"id\":\"" + KEY + "\"},\"context\":{\"userId\":\"" + KEY + "\",\"tenantId\":\"" + NEXT_KEY + "\"}}";
    static final String VERIFY = ROOT + "/auth/challenges/" + KEY + "/verify";
    static final String VERIFY_BODY = "{\"code\":\"0000\",\"acceptance\":{\"publicOfferAccepted\":true,\"personalDataPolicyAccepted\":true}}";

    static class TestClock implements Clock {
        long wall = 1_790_531_000_000L, elapsed = 1_000L;
        public long wall() { return wall; }
        public long elapsed() { return elapsed; }
        void advance(long milliseconds) { wall += milliseconds; elapsed += milliseconds; }
    }
    static class MemoryStore implements Store {
        Credential value;
        public Credential read() { return value; }
        public void write(Credential next) { value = next; }
        public void clear() { value = null; }
        public String logoutIntent() { return null; }
        public void beginLogout(String key) { }
        public void clearLogoutIntent() { }
    }
    static Map<String, String> headers() {
        Map<String, String> result = new HashMap<>(); result.put("idempotency-key", KEY); return result;
    }
    static Response json(int status, String body, String date) {
        Map<String, String> headers = new HashMap<>(); headers.put("content-type", "application/json");
        if (date != null) headers.put("date", date);
        return new Response(status, headers, Collections.emptyList(), body.getBytes(StandardCharsets.UTF_8));
    }
    static Response session(String value) {
        return new Response(200, Collections.singletonMap("content-type", "application/json"),
            Collections.singletonList("phub_refresh=" + value + "; Path=" + ROOT + "/auth; Max-Age=3600; Secure; HttpOnly; SameSite=Lax"),
            SESSION.getBytes(StandardCharsets.UTF_8));
    }
    static String iso(long epoch) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(epoch));
    }
    static String httpDate(long epoch) {
        SimpleDateFormat format = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss 'GMT'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(epoch));
    }
    static String plan(long expiry) {
        return "{\"revision\":\"73\",\"mode\":\"MIXED_END_USER_READS\",\"issuedAt\":\"" + iso(expiry - 60_000) + "\",\"expiresAt\":\"" + iso(expiry) + "\",\"directViva\":{\"apiBaseUrl\":\"https://api.vivacrm.ru/end-user/api\",\"providerTenantKey\":\"citysport\",\"accessTokenPath\":\"/auth/viva/access\",\"allowedRequestHeaders\":[\"Authorization\"]},\"operations\":[{\"operation\":\"profile.read\",\"transport\":\"DIRECT_VIVA\",\"fallback\":\"UNAVAILABLE\"},{\"operation\":\"bookings.read\",\"transport\":\"PADLHUB_API\",\"fallback\":\"PADLHUB_API\"},{\"operation\":\"bookings.details.read\",\"transport\":\"PADLHUB_API\",\"fallback\":\"PADLHUB_API\"},{\"operation\":\"bookings.history.read\",\"transport\":\"PADLHUB_API\",\"fallback\":\"PADLHUB_API\"},{\"operation\":\"subscriptions.read\",\"transport\":\"PADLHUB_API\",\"fallback\":\"PADLHUB_API\"},{\"operation\":\"schedule.read\",\"transport\":\"PADLHUB_API\",\"fallback\":\"PADLHUB_API\"}]}";
    }
    static String job(long expiry) {
        return "{\"jobId\":\"" + JOB + "\",\"commandId\":\"" + COMMAND + "\",\"expiresAt\":\"" + iso(expiry) + "\"}";
    }
    static String delegation(String token, String expiry) {
        return "{\"accessToken\":\"" + token + "\",\"expiresAt\":\"" + expiry + "\"}";
    }

    static class Fixture {
        final TestClock clock = new TestClock();
        final MemoryStore store = new MemoryStore();
        final AndroidSessionPolicy policy;
        final List<Request> api = new ArrayList<>();
        final List<String> providerPaths = new ArrayList<>();
        final List<String> providerTokens = new ArrayList<>();
        final AndroidProfileRefresh.Circuits circuits = new AndroidProfileRefresh.Circuits();
        String plan, job, delegation, profile = PROFILE, result, complete;
        byte[] profileBodyOverride;
        int providerStatus = 200;
        String failPath;
        int providerCalls, resultAttempts, completeAttempts;
        Runnable providerHook;
        AndroidSessionEngine engine;

        Fixture() throws Exception {
            policy = new AndroidSessionPolicy(ORIGIN, "local-padel", "test", "2", false);
            plan = plan(clock.wall + 60_000); job = job(clock.wall + 60_000);
            delegation = delegation(PROVIDER_TOKEN, iso(clock.wall + 60_000));
            result = "{\"accepted\":true,\"replayed\":false,\"observedAt\":\"" + iso(clock.wall) + "\"}";
            complete = "{\"state\":\"refreshed\",\"observedAt\":\"" + iso(clock.wall) + "\"}";
            engine = new AndroidSessionEngine(policy, store, this::send, null, clock);
            engine.request(VERIFY, "POST", headers(), VERIFY_BODY);
            api.clear();
        }
        Response send(Request request) throws Failure {
            if (request.path.equals(VERIFY)) return session(REFRESH);
            if (request.path.endsWith("/routing-outcomes")) return json(204, "", httpDate(clock.wall));
            api.add(new Request(request.path, request.method, new HashMap<>(request.headers),
                request.body == null ? null : new String(request.body, StandardCharsets.UTF_8), request.operation));
            if (request.path.endsWith("/routing-plan")) return json(200, plan, httpDate(clock.wall));
            if (request.path.endsWith("/profile/provider-read-jobs")) return json(200, job, httpDate(clock.wall));
            if (request.path.endsWith("/auth/viva/access")) return json(200, delegation, httpDate(clock.wall));
            if (request.path.contains("/results/")) {
                resultAttempts++;
                if ("result".equals(failPath)) return json(500, "{}", httpDate(clock.wall));
                return json(200, result, httpDate(clock.wall));
            }
            if (request.path.endsWith("/complete")) {
                completeAttempts++;
                return json(200, complete, httpDate(clock.wall));
            }
            return json(500, "{}", httpDate(clock.wall));
        }
        Response provider(String path, String token) {
            providerPaths.add(path); providerTokens.add(token); providerCalls++;
            if (providerHook != null) providerHook.run();
            if (providerStatus != 200) return json(providerStatus, "{}", null);
            byte[] body = profileBodyOverride == null ? profile.getBytes(StandardCharsets.UTF_8) : profileBodyOverride;
            return new Response(200, Collections.singletonMap("content-type", "application/json"), Collections.emptyList(), body);
        }
        void run() throws Exception {
            new AndroidProfileRefresh(policy, engine, this::send, this::provider, clock, circuits).run(engine.nativeAccess(), () -> {});
        }
        void fails(String code) throws Exception {
            try { run(); fail("Expected " + code); }
            catch (Failure error) { assertEquals(code, error.code); }
        }
    }

    @Test public void runsTheFixedTransportAndWipesTheProviderBuffer() throws Exception {
        Fixture f = new Fixture(); byte[] profileBytes = f.profile.getBytes(StandardCharsets.UTF_8);
        f.profileBodyOverride = profileBytes; f.run();
        assertEquals(Collections.singletonList("/v1/citysport/profile"), f.providerPaths);
        assertEquals(Collections.singletonList(PROVIDER_TOKEN), f.providerTokens);
        assertEquals(5, f.api.size());
        assertEquals("GET", f.api.get(0).method); assertTrue(f.api.get(0).path.endsWith("/routing-plan"));
        assertTrue(f.api.get(1).path.endsWith("/profile/provider-read-jobs"));
        assertTrue(f.api.get(2).path.endsWith("/auth/viva/access"));
        assertEquals(ROOT + "/profile/provider-read-jobs/" + JOB + "/results/" + COMMAND, f.api.get(3).path);
        String relay = new String(f.api.get(3).body, StandardCharsets.UTF_8);
        assertEquals(PROVIDER_ID, new org.json.JSONObject(relay).getJSONObject("payload").getString("id"));
        assertFalse(relay.contains(PROVIDER_TOKEN));
        for (byte value : profileBytes) assertEquals(0, value);
        assertEquals(1, f.completeAttempts);
        assertNotNull(f.store.value);
    }

    @Test public void malformedPlanAndExpiredJobStopBeforeDelegation() throws Exception {
        Fixture malformed = new Fixture(); malformed.plan = "{}"; malformed.fails("NATIVE_PROFILE_PLAN_REJECTED"); assertEquals(0, malformed.providerCalls);
        Fixture foreign = new Fixture(); foreign.plan = plan(foreign.clock.wall + 60_000).replace("https://api.vivacrm.ru/end-user/api", "https://evil.invalid");
        foreign.fails("NATIVE_PROFILE_PLAN_REJECTED"); assertEquals(0, foreign.providerCalls);
        Fixture direct = new Fixture(); direct.plan = plan(direct.clock.wall + 60_000).replace("\"operation\":\"profile.read\",\"transport\":\"DIRECT_VIVA\"", "\"operation\":\"profile.read\",\"transport\":\"PADLHUB_API\"");
        direct.fails("NATIVE_PROFILE_PLAN_REJECTED"); assertEquals(0, direct.providerCalls);
        Fixture expired = new Fixture(); expired.job = job(expired.clock.wall - 1); expired.fails("NATIVE_PROFILE_JOB_EXPIRED_REJECTED");
        assertEquals(0, expired.providerCalls); assertEquals(0, countPath(expired.api, "/auth/viva/access"));
        Fixture wrongId = new Fixture(); wrongId.job = wrongId.job.replace(COMMAND, "not-a-command"); wrongId.fails("NATIVE_PROFILE_JOB_ID_REJECTED");
        assertEquals(0, wrongId.providerCalls);
    }

    @Test public void providerFailuresNeverReachTheResultWrite() throws Exception {
        Fixture redirect = new Fixture(); redirect.providerStatus = 302; redirect.fails("NATIVE_REDIRECT_REJECTED");
        assertEquals(0, countPath(redirect.api, "/results/"));
        Fixture unavailable = new Fixture(); unavailable.providerStatus = 500; unavailable.fails("NATIVE_REFRESH_UNAVAILABLE");
        assertEquals(0, countPath(unavailable.api, "/results/")); assertEquals(0, unavailable.completeAttempts);
        Fixture oversized = new Fixture(); oversized.profileBodyOverride = new byte[AndroidProfileRefresh.PROVIDER_LIMIT + 1];
        Arrays.fill(oversized.profileBodyOverride, (byte) 0x7b); oversized.fails("NATIVE_PROFILE_READ_REJECTED");
        assertEquals(0, countPath(oversized.api, "/results/"));
        Fixture array = new Fixture(); array.profileBodyOverride = "[1,2]".getBytes(StandardCharsets.UTF_8);
        array.fails("NATIVE_PROFILE_READ_REJECTED"); assertEquals(0, countPath(array.api, "/results/"));
    }

    @Test public void provider401ReissuesOneDelegationAndReplaysOnlyTheGet() throws Exception {
        Fixture f = new Fixture(); final int[] calls = {0};
        AndroidProfileRefresh.ProviderSender provider = (path, token) -> {
            f.providerPaths.add(path); f.providerTokens.add(token); calls[0]++;
            if (calls[0] == 1) return json(401, "{}", null);
            return json(200, PROFILE, null);
        };
        new AndroidProfileRefresh(f.policy, f.engine, f::send, provider, f.clock).run(f.engine.nativeAccess(), () -> {});
        assertEquals(2, calls[0]); assertEquals(2, countPath(f.api, "/auth/viva/access"));
        assertEquals(1, countPath(f.api, "/results/"));
    }

    @Test public void oversizedRelayIsRejectedBeforeTheResultWrite() throws Exception {
        Fixture f = new Fixture();
        String prefix = "{\"deposit\":0,\"padding\":\"", suffix = "\"}";
        char[] padding = new char[AndroidProfileRefresh.PROVIDER_LIMIT - prefix.length() - suffix.length()];
        Arrays.fill(padding, 'x');
        f.profileBodyOverride = (prefix + new String(padding) + suffix).getBytes(StandardCharsets.UTF_8);
        f.fails("NATIVE_PROFILE_RESULT_REJECTED");
        assertEquals(1, f.providerCalls); assertEquals(0, countPath(f.api, "/results/")); assertEquals(0, f.completeAttempts);
    }

    @Test public void rejectedResultAndCancellationStopBeforeCompletion() throws Exception {
        Fixture rejected = new Fixture(); rejected.result = "{\"accepted\":false,\"replayed\":false,\"observedAt\":\"" + iso(rejected.clock.wall) + "\"}";
        rejected.fails("NATIVE_PROFILE_RESULT_REJECTED"); assertEquals(0, rejected.completeAttempts);
        Fixture wrongState = new Fixture(); wrongState.complete = "{\"state\":\"READY\",\"observedAt\":\"" + iso(wrongState.clock.wall) + "\"}";
        wrongState.fails("NATIVE_PROFILE_COMPLETION_REJECTED");
        Fixture cancelled = new Fixture(); final boolean[] stop = {false}; cancelled.providerHook = () -> stop[0] = true;
        try { new AndroidProfileRefresh(cancelled.policy, cancelled.engine, cancelled::send, cancelled::provider, cancelled.clock)
            .run(cancelled.engine.nativeAccess(), () -> { if (stop[0]) throw new Failure("NATIVE_OPERATION_CANCELLED"); }); fail(); }
        catch (Failure error) { assertEquals("NATIVE_OPERATION_CANCELLED", error.code); }
        assertEquals(1, cancelled.providerCalls); assertEquals(0, countPath(cancelled.api, "/results/"));
    }

    @Test public void circuitBlocksAnImmediateRetryAfterProviderFailure() throws Exception {
        Fixture f = new Fixture(); f.providerStatus = 500; f.fails("NATIVE_REFRESH_UNAVAILABLE");
        int jobs = countPath(f.api, "/profile/provider-read-jobs");
        f.providerStatus = 200; f.fails("NATIVE_REFRESH_UNAVAILABLE");
        assertEquals(jobs, countPath(f.api, "/profile/provider-read-jobs"));
        f.clock.advance(1_001); f.run();
        assertEquals(2, f.providerCalls); assertEquals(1, countPath(f.api, "/complete"));
    }

    @Test public void genericBridgeStillRejectsTheNativeOnlyProviderReadRoutes() throws Exception {
        AndroidSessionPolicy policy = new AndroidSessionPolicy(ORIGIN, "local-padel", "test", "2", false);
        Map<String, String> authorized = new HashMap<>();
        authorized.put("authorization", "Bearer synthetic-access"); authorized.put("idempotency-key", KEY);
        for (String path : Arrays.asList(ROOT + "/profile/provider-read-jobs",
            ROOT + "/profile/provider-read-jobs/" + JOB + "/results/" + COMMAND,
            ROOT + "/profile/provider-read-jobs/" + JOB + "/complete", ROOT + "/auth/viva/access")) {
            try { policy.request(path, "POST", authorized, "{}"); fail("Expected rejection for " + path); }
            catch (Failure error) { assertEquals("NATIVE_REQUEST_REJECTED", error.code); }
        }
    }

    static int countPath(List<Request> requests, String fragment) {
        int count = 0; for (Request request : requests) if (request.path.contains(fragment)) count++; return count;
    }
}
