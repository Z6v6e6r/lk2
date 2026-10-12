package ru.padlhub.app;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;
import static ru.padlhub.app.AndroidSessionEngine.*;
import static ru.padlhub.app.AndroidSessionPolicy.*;
import static ru.padlhub.app.AndroidSessionTest.*;

/** Contract tests for the one approved, native-only MY_BOOKINGS refresh transport. */
@RunWith(AndroidJUnit4.class)
public class AndroidUpcomingBookingsRefreshTest {
    static final String JOB = "00000000-0000-4000-8000-000000000010";
    static final String COMMAND = "00000000-0000-4000-8000-000000000011";
    static String providerToken(String tenant) {
        int flags = android.util.Base64.URL_SAFE | android.util.Base64.NO_PADDING | android.util.Base64.NO_WRAP;
        return android.util.Base64.encodeToString("{\"alg\":\"none\",\"fixture\":true}".getBytes(StandardCharsets.UTF_8), flags)
            + "." + android.util.Base64.encodeToString(("{\"tenant_key\":\"" + tenant + "\"}").getBytes(StandardCharsets.UTF_8), flags)
            + ".synthetic_signature";
    }
    static final String PROVIDER_TOKEN = providerToken("citysport");

    static class TestClock implements Clock {
        long wall = 1_790_531_000_000L, elapsed = 1_000L;
        public long wall() { return wall; }
        public long elapsed() { return elapsed; }
        void advance(long milliseconds) { wall += milliseconds; elapsed += milliseconds; }
    }

    static Response json(int status, String body) {
        return new Response(status, Collections.singletonMap("content-type", "application/json"), Collections.emptyList(), body.getBytes(StandardCharsets.UTF_8));
    }
    static String iso(long epoch) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(epoch));
    }
    static String plan(long expiry) {
        return "{\"revision\":\"73\",\"mode\":\"MIXED_END_USER_READS\",\"expiresAt\":\"" + iso(expiry) + "\",\"directViva\":{\"apiBaseUrl\":\"https://api.vivacrm.ru/end-user/api\",\"providerTenantKey\":\"citysport\",\"accessTokenPath\":\"/auth/viva/access\",\"allowedRequestHeaders\":[\"Authorization\"]},\"operations\":[{\"operation\":\"bookings.read\",\"transport\":\"PADLHUB_API\"},{\"operation\":\"bookings.details.read\",\"transport\":\"PADLHUB_API\"}]}";
    }
    static String job(long expiry) {
        return "{\"jobId\":\"" + JOB + "\",\"screen\":\"MY_BOOKINGS\",\"expiresAt\":\"" + iso(expiry) + "\",\"commands\":[{\"commandId\":\"" + COMMAND + "\",\"operation\":\"bookings.read\",\"detailsOperation\":\"bookings.details.read\",\"page\":0,\"size\":50}],\"concurrency\":1}";
    }

    static class Fixture {
        final TestClock clock = new TestClock();
        final MemoryStore store = new MemoryStore();
        final AndroidSessionPolicy policy;
        final List<Request> api = new ArrayList<>();
        final List<Request> metrics = new ArrayList<>();
        final AndroidUpcomingBookingsRefresh.Circuits circuits = new AndroidUpcomingBookingsRefresh.Circuits();
        final List<String> providerPaths = new ArrayList<>();
        final List<String> providerTokens = new ArrayList<>();
        String plan, job, delegation;
        String list = "{\"content\":[{\"id\":\"active id&1\",\"isCancelled\":false},{\"id\":42,\"isCancelled\":false},{\"id\":\"cancelled\",\"isCancelled\":true}]}";
        String details = "[{\"id\":\"active id&1\"}]";
        String result = "{\"accepted\":true,\"replayed\":false,\"itemCount\":2}";
        String complete;
        int providerStatus = 200;
        String failPath, throwPath;
        int providerCalls, resultAttempts, completeAttempts;
        Runnable providerHook;
        AndroidSessionEngine engine;

        Fixture() throws Exception {
            policy = new AndroidSessionPolicy(ORIGIN, "local-padel", "test-version", "73", false);
            plan = plan(clock.wall + 60_000); job = job(clock.wall + 60_000);
            complete = "{\"screen\":\"MY_BOOKINGS\",\"state\":\"READY\",\"completedCommands\":1,\"totalCommands\":1,\"bookings\":{\"version\":\"synthetic-v1\",\"generatedAt\":\"" + iso(clock.wall) + "\",\"staleAt\":\"" + iso(clock.wall + 60_000) + "\",\"items\":[]}}";
            delegation = "{\"accessToken\":\"" + PROVIDER_TOKEN + "\",\"expiresAt\":\"" + iso(clock.wall + 60_000) + "\"}";
            engine = new AndroidSessionEngine(policy, store, this::send, null, clock);
            engine.request(VERIFY, "POST", headers(null, KEY), VERIFY_BODY);
            api.clear();
        }
        Response send(Request request) throws Failure {
            if (request.path.equals(VERIFY)) return session(REFRESH);
            if (request.path.endsWith("/routing-outcomes")) { metrics.add(copy(request)); return json(204, ""); }
            api.add(copy(request));
            if (request.path.endsWith("/routing-plan")) return json(200, plan);
            if (request.path.endsWith("/booking-screen-read-jobs")) return json(200, job);
            if (request.path.endsWith("/auth/viva/access")) return json(200, delegation);
            if (request.path.contains("/results/")) {
                resultAttempts++;
                if ("result".equals(throwPath) && resultAttempts == 1) throw new Failure("NATIVE_NETWORK_UNAVAILABLE");
                if ("result".equals(failPath)) return json(500, "{}");
                return json(200, result);
            }
            if (request.path.endsWith("/complete")) {
                completeAttempts++;
                if ("complete".equals(throwPath) && completeAttempts == 1) throw new Failure("NATIVE_NETWORK_UNAVAILABLE");
                if ("complete".equals(failPath)) return json(500, "{}");
                return json(200, complete);
            }
            return json(500, "{}");
        }
        Response provider(String path, String token) throws Failure {
            providerPaths.add(path); providerTokens.add(token); providerCalls++;
            if (providerHook != null) providerHook.run();
            if ("provider".equals(throwPath)) throw new Failure("NATIVE_NETWORK_UNAVAILABLE");
            if (providerStatus != 200) return json(providerStatus, "{}");
            return json(200, path.contains("/list?") ? details : list);
        }
        void run() throws Exception {
            new AndroidUpcomingBookingsRefresh(policy, engine, this::send, this::provider, clock, circuits).run(engine.nativeAccess(), () -> {});
        }
        void fails(String code) throws Exception {
            try { run(); fail("Expected " + code); }
            catch (Failure error) { assertEquals(code, error.code); }
        }
        List<Request> writes() {
            List<Request> result = new ArrayList<>();
            for (Request request : api) if (!"GET".equals(request.method)) result.add(request);
            return result;
        }
        private Request copy(Request request) {
            return new Request(request.path, request.method, new HashMap<>(request.headers),
                request.body == null ? null : new String(request.body, StandardCharsets.UTF_8), request.operation);
        }
    }

    @Test public void acceptedJobUsesFixedSequenceHeadersAndOnlyActiveIds() throws Exception {
        Fixture f = new Fixture(); f.run();
        assertEquals(2, f.providerPaths.size());
        assertEquals("/v2/citysport/bookings?page=0&size=50", f.providerPaths.get(0));
        assertEquals("/v1/citysport/bookings/list?bookingIds=active+id%261&bookingIds=42", f.providerPaths.get(1));
        assertEquals(Arrays.asList(PROVIDER_TOKEN, PROVIDER_TOKEN), f.providerTokens);
        assertEquals(Arrays.asList("GET /routing-plan", "POST /booking-screen-read-jobs", "POST /auth/viva/access",
            "POST /booking-screen-read-jobs/" + JOB + "/results/" + COMMAND, "POST /booking-screen-read-jobs/" + JOB + "/complete"), paths(f.api));
        for (Request request : f.api) {
            assertEquals("android", request.headers.get("x-app-platform")); assertEquals("test-version", request.headers.get("x-app-version"));
            assertEquals("73", request.headers.get("x-app-build")); assertTrue(request.headers.get("x-correlation-id").matches("[0-9a-f-]{36}"));
            if (!"GET".equals(request.method)) assertTrue(request.headers.get("idempotency-key").matches("[0-9a-f-]{36}"));
        }
        Request submitted = f.api.get(3); JSONObject payload = new JSONObject(new String(submitted.body, StandardCharsets.UTF_8)).getJSONObject("payload");
        assertEquals(3, payload.getJSONObject("bookings").getJSONArray("content").length()); assertTrue(payload.get("details") instanceof JSONArray);
        assertEquals("{\"limit\":50}", new String(f.api.get(4).body, StandardCharsets.UTF_8));
        assertSame(f.store.value, f.store.read());
    }

    @Test public void emptyListSkipsDetailsAndRelaysAnEmptyArray() throws Exception {
        Fixture f = new Fixture(); f.list = "{\"content\":[]}"; f.run();
        assertEquals(Collections.singletonList("/v2/citysport/bookings?page=0&size=50"), f.providerPaths);
        JSONObject payload = new JSONObject(new String(f.api.get(3).body, StandardCharsets.UTF_8)).getJSONObject("payload");
        assertEquals(0, payload.getJSONArray("details").length());
    }

    @Test public void objectDetailsAreAcceptedWithoutExposingTheProviderToken() throws Exception {
        Fixture f = new Fixture(); f.details = "{\"records\":[{\"private\":\"provider-only\"}]}"; f.run();
        String relay = new String(f.api.get(3).body, StandardCharsets.UTF_8);
        assertTrue(new JSONObject(relay).getJSONObject("payload").get("details") instanceof JSONObject);
        assertFalse(relay.contains(PROVIDER_TOKEN));
    }

    @Test public void provider401RefreshesOnceAndReplaysTheSameReadOnlyGet() throws Exception {
        Fixture f = new Fixture(); final int[] calls = {0};
        AndroidUpcomingBookingsRefresh.ProviderSender provider = (path, token) -> {
            f.providerPaths.add(path); f.providerTokens.add(token); calls[0]++;
            if (calls[0] == 1) return json(401, "{}");
            return json(200, path.contains("/list?") ? f.details : f.list);
        };
        new AndroidUpcomingBookingsRefresh(f.policy, f.engine, f::send, provider, f.clock).run(f.engine.nativeAccess(), () -> {});
        assertEquals(3, calls[0]); assertEquals(f.providerPaths.get(0), f.providerPaths.get(1));
        assertEquals(2, countPath(f.api, "/auth/viva/access"));
    }

    @Test public void providerFailuresAndRedirectsDoNotSubmitCanonicalResults() throws Exception {
        for (int status : new int[] {401, 403, 429, 302}) {
            Fixture f = new Fixture(); f.providerStatus = status; f.fails(status == 302 ? "NATIVE_REDIRECT_REJECTED" : "NATIVE_REFRESH_UNAVAILABLE");
            assertEquals(1, countExactPath(f.api, "/booking-screen-read-jobs"));
            assertEquals(0, countPath(f.api, "/results/")); assertEquals(0, countPath(f.api, "/complete"));
        }
    }

    @Test public void malformedPlanAndJobAreRejectedBeforeDelegateOrProvider() throws Exception {
        String[] badPlans = {"{}", plan(1_790_531_060_000L).replace("PADLHUB_API", "DIRECT_VIVA"), plan(1_790_531_060_000L).replace("https://api.vivacrm.ru/end-user/api", "https://evil.invalid")};
        for (String bad : badPlans) {
            Fixture f = new Fixture(); f.plan = bad; f.fails("NATIVE_RESPONSE_REJECTED");
            assertEquals(0, f.providerCalls); assertEquals(0, countPath(f.api, "/auth/viva/access"));
        }
        Fixture wrongJob = new Fixture(); wrongJob.job = wrongJob.job.replace("\"concurrency\":1", "\"concurrency\":2"); wrongJob.fails("NATIVE_RESPONSE_REJECTED");
        assertEquals(0, wrongJob.providerCalls); assertEquals(0, countPath(wrongJob.api, "/auth/viva/access"));
    }

    @Test public void mismatchedOrExpiredDelegationCannotReachTheProviderOrLeakIntoFailures() throws Exception {
        Fixture mismatched = new Fixture(); String marker = "raw-provider-marker";
        mismatched.delegation = "{\"accessToken\":\"" + providerToken("other") + "\",\"expiresAt\":\"" + iso(mismatched.clock.wall + 60_000) + "\"}";
        try { mismatched.run(); fail(); } catch (Failure error) {
            assertEquals("NATIVE_RESPONSE_REJECTED", error.code); assertFalse(error.getMessage().contains(marker)); assertNull(error.getCause());
        }
        assertEquals(0, mismatched.providerCalls); assertEquals(0, countPath(mismatched.api, "/results/"));
        Fixture expired = new Fixture(); expired.delegation = "{\"accessToken\":\"" + PROVIDER_TOKEN + "_" + marker + "\",\"expiresAt\":\"" + iso(expired.clock.wall) + "\"}";
        try { expired.run(); fail(); } catch (Failure error) { assertEquals("NATIVE_RESPONSE_REJECTED", error.code); assertFalse(error.getMessage().contains(marker)); }
        assertEquals(0, expired.providerCalls);
    }

    @Test public void badListBoundariesNeverReachTheResultWrite() throws Exception {
        String fiftyOne = "{\"content\":[" + repeats("{\"id\":\"x\",\"isCancelled\":false}", 51) + "]}";
        for (String bad : Arrays.asList("{\"content\":[{\"id\":\"" + repeats("x", 129).replace(",", "") + "\",\"isCancelled\":false}]}", fiftyOne, "{\"content\":[{\"id\":\"x\"}]}", "{\"content\":[{\"id\":\"\",\"isCancelled\":false}]}", "{\"content\":[{\"id\":{},\"isCancelled\":false}]}")) {
            Fixture f = new Fixture(); Credential before = f.store.value; f.list = bad; f.fails("NATIVE_RESPONSE_REJECTED");
            assertEquals(1, f.providerPaths.size()); assertEquals(0, countPath(f.api, "/results/")); assertEquals(0, countPath(f.api, "/complete"));
            assertSame(before, f.store.value);
        }
    }

    @Test public void cancellationAndProviderFailureStopBeforeAnyLaterWrite() throws Exception {
        Fixture afterList = new Fixture(); afterList.providerHook = () -> { if (afterList.providerCalls == 1) { afterList.clock.wall -= 120_000; afterList.clock.elapsed += 61_000; } };
        afterList.fails("NATIVE_OPERATION_CANCELLED"); assertEquals(1, afterList.providerPaths.size()); assertEquals(0, countPath(afterList.api, "/results/"));
        Fixture failedDetails = new Fixture(); failedDetails.providerStatus = 500; failedDetails.fails("NATIVE_REFRESH_UNAVAILABLE");
        assertEquals(0, countPath(failedDetails.api, "/results/")); assertEquals(0, countPath(failedDetails.api, "/complete"));
    }

    @Test public void resultAndCompleteNetworkFailuresReplayTheExactSameWriteOnly() throws Exception {
        for (String stage : Arrays.asList("result", "complete")) {
            Fixture f = new Fixture(); f.throwPath = stage; f.run();
            int first = stage.equals("result") ? 3 : 4;
            assertEquals(2, stage.equals("result") ? f.resultAttempts : f.completeAttempts);
            assertEquals(paths(f.api).get(first), paths(f.api).get(first + 1));
            Request one = f.api.get(first), two = f.api.get(first + 1);
            assertEquals(one.headers.get("idempotency-key"), two.headers.get("idempotency-key"));
            assertEquals(one.headers.get("x-correlation-id"), two.headers.get("x-correlation-id"));
            assertArrayEquals(one.body, two.body); assertEquals(1, countExactPath(f.api, "/booking-screen-read-jobs"));
        }
    }

    @Test public void rejectedResultDoesNotCompleteAndApi401RetiresNativeAuthorization() throws Exception {
        Fixture rejected = new Fixture(); rejected.result = "{\"accepted\":false,\"replayed\":false,\"itemCount\":0}"; rejected.fails("NATIVE_RESPONSE_REJECTED");
        assertEquals(0, countPath(rejected.api, "/complete"));
        Fixture incomplete = new Fixture(); incomplete.result = "{\"accepted\":true}"; incomplete.fails("NATIVE_RESPONSE_REJECTED");
        assertEquals(0, countPath(incomplete.api, "/complete"));
        Fixture missingBookings = new Fixture(); missingBookings.complete = "{\"screen\":\"MY_BOOKINGS\",\"state\":\"READY\",\"completedCommands\":1,\"totalCommands\":1}";
        missingBookings.fails("NATIVE_RESPONSE_REJECTED");
        Fixture revoked = new Fixture(); revoked.failPath = "result";
        AndroidSessionEngine.Sender sender = request -> request.path.contains("/results/") ? json(401, "{}") : revoked.send(request);
        try { new AndroidUpcomingBookingsRefresh(revoked.policy, revoked.engine, sender, revoked::provider, revoked.clock).run(revoked.engine.nativeAccess(), () -> {}); fail(); }
        catch (Failure error) { assertEquals("AUTH_SESSION_REVOKED", error.code); }
        try { revoked.engine.nativeAccess(); fail(); } catch (Failure error) { assertEquals("AUTH_SESSION_REVOKED", error.code); }
    }

    @Test public void circuitBlocksImmediateRetryAndMetricsStayClosedWithoutAffectingSuccess() throws Exception {
        Fixture f = new Fixture(); f.providerStatus = 429; f.fails("NATIVE_REFRESH_UNAVAILABLE");
        int providerCalls = f.providerCalls, jobs = countExactPath(f.api, "/booking-screen-read-jobs");
        f.providerStatus = 200; f.fails("NATIVE_REFRESH_UNAVAILABLE");
        assertEquals(providerCalls, f.providerCalls); assertEquals(jobs, countExactPath(f.api, "/booking-screen-read-jobs"));
        JSONObject open = new JSONObject(new String(f.metrics.get(f.metrics.size() - 1).body, StandardCharsets.UTF_8));
        assertEquals("CIRCUIT_OPEN", open.getString("outcome")); assertEquals("bookings.read", open.getString("operation"));
        f.clock.advance(1_001); f.run();
        for (Request metric : f.metrics) {
            String text = new String(metric.body, StandardCharsets.UTF_8);
            JSONObject data = new JSONObject(text);
            assertTrue(data.length() == 4 || data.length() == 5); assertEquals("73", data.getString("routingRevision"));
            assertFalse(text.contains(PROVIDER_TOKEN)); assertFalse(text.contains("active id"));
        }
        Fixture brokenMetric = new Fixture();
        AndroidSessionEngine.Sender sender = request -> request.path.endsWith("/routing-outcomes") ? json(401, "secret-error-body") : brokenMetric.send(request);
        new AndroidUpcomingBookingsRefresh(brokenMetric.policy, brokenMetric.engine, sender, brokenMetric::provider, brokenMetric.clock).run(brokenMetric.engine.nativeAccess(), () -> {});
        assertEquals(1, countPath(brokenMetric.api, "/complete")); brokenMetric.engine.nativeAccess();
    }

    @Test public void slowTelemetryRunsOnlyAfterProjectionCompletionWithoutRetiringTheLease() throws Exception {
        Fixture f = new Fixture();
        AndroidSessionEngine.Sender sender = request -> {
            if (request.path.endsWith("/routing-outcomes")) {
                assertEquals(1, countPath(f.api, "/complete"));
                f.clock.elapsed += 121_000; return json(500, "private-ignored-error");
            }
            return f.send(request);
        };
        new AndroidUpcomingBookingsRefresh(f.policy, f.engine, sender, f::provider, f.clock).run(f.engine.nativeAccess(), () -> {});
        assertEquals(1, countPath(f.api, "/results/")); assertEquals(1, countPath(f.api, "/complete"));
        f.engine.nativeAccess();
    }

    static List<String> paths(List<Request> requests) {
        List<String> result = new ArrayList<>(); for (Request request : requests) result.add(request.method + " " + request.path.substring(ROOT.length())); return result;
    }
    static int countPath(List<Request> requests, String fragment) {
        int count = 0; for (Request request : requests) if (request.path.contains(fragment)) count++; return count;
    }
    static int countExactPath(List<Request> requests, String suffix) {
        int count = 0; for (Request request : requests) if (request.path.equals(ROOT + suffix)) count++; return count;
    }
    static String repeats(String value, int count) {
        StringBuilder result = new StringBuilder(); for (int i = 0; i < count; i++) { if (i > 0) result.append(','); result.append(value); } return result.toString();
    }
}
