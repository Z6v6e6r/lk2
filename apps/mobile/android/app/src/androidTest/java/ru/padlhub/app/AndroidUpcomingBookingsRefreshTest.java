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
    static final String PROVIDER_TOKEN = "initial-viva-access-token";

    static class TestClock implements Clock {
        long wall = 1_790_531_000_000L, elapsed = 1_000L;
        public long wall() { return wall; }
        public long elapsed() { return elapsed; }
        void advance(long milliseconds) { wall += milliseconds; elapsed += milliseconds; }
    }

    static Response json(int status, String body) {
        return json(status, body, null);
    }
    static Response json(int status, String body, String date) {
        return response(status, body.getBytes(StandardCharsets.UTF_8), "application/json", date);
    }
    static Response response(int status, byte[] body, String contentType, String date) {
        Map<String, String> headers = new HashMap<>(); headers.put("content-type", contentType);
        if (date != null) headers.put("date", date);
        return new Response(status, headers, Collections.emptyList(), body);
    }
    static String iso(long epoch) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(epoch));
    }
    static String isoMillis(long epoch) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(epoch));
    }
    static String httpDate(long epoch) {
        SimpleDateFormat format = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss 'GMT'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(epoch));
    }
    static String plan(long expiry) {
        return "{\"revision\":\"73\",\"mode\":\"MIXED_END_USER_READS\",\"issuedAt\":\"" + iso(expiry - 60_000) + "\",\"expiresAt\":\"" + iso(expiry) + "\",\"directViva\":{\"apiBaseUrl\":\"https://api.vivacrm.ru/end-user/api\",\"providerTenantKey\":\"citysport\",\"accessTokenPath\":\"/auth/viva/access\",\"allowedRequestHeaders\":[\"Authorization\"]},\"operations\":[{\"operation\":\"profile.read\",\"transport\":\"DIRECT_VIVA\",\"fallback\":\"UNAVAILABLE\"},{\"operation\":\"bookings.read\",\"transport\":\"PADLHUB_API\",\"fallback\":\"PADLHUB_API\"},{\"operation\":\"bookings.details.read\",\"transport\":\"PADLHUB_API\",\"fallback\":\"PADLHUB_API\"},{\"operation\":\"bookings.history.read\",\"transport\":\"DIRECT_VIVA\",\"fallback\":\"UNAVAILABLE\"},{\"operation\":\"subscriptions.read\",\"transport\":\"DIRECT_VIVA\",\"fallback\":\"UNAVAILABLE\"},{\"operation\":\"schedule.read\",\"transport\":\"DIRECT_VIVA\",\"fallback\":\"UNAVAILABLE\"}]}";
    }
    static String job(long expiry) {
        return job(iso(expiry));
    }
    static String job(String expiry) {
        return "{\"jobId\":\"" + JOB + "\",\"screen\":\"MY_BOOKINGS\",\"expiresAt\":\"" + expiry + "\",\"commands\":[{\"commandId\":\"" + COMMAND + "\",\"operation\":\"bookings.read\",\"detailsOperation\":\"bookings.details.read\",\"page\":0,\"size\":50}],\"concurrency\":1}";
    }
    static String delegation(String token, String expiry) {
        return "{\"accessToken\":\"" + token + "\",\"expiresAt\":\"" + expiry + "\"}";
    }

    @Test public void receiptContainsOnlyValidatedMilestonesWithoutExtraRequests() throws Exception {
        Fixture fixture = new Fixture();
        AndroidUpcomingBookingsRefresh.Receipt receipt = fixture.run();
        assertTrue(receipt.jobAccepted); assertTrue(receipt.relayAccepted); assertTrue(receipt.completed);
        assertEquals(2, fixture.providerCalls); assertEquals(1, fixture.resultAttempts); assertEquals(1, fixture.completeAttempts);
        assertEquals(3, receipt.getClass().getDeclaredFields().length);
        for (java.lang.reflect.Field field : receipt.getClass().getDeclaredFields()) {
            assertEquals(boolean.class, field.getType());
            assertTrue(java.lang.reflect.Modifier.isFinal(field.getModifiers()));
        }
        fixture.result = "{\"accepted\":false,\"replayed\":false,\"itemCount\":0}";
        fixture.fails("NATIVE_BOOKINGS_RESULT_REJECTED");
    }

    @Test public void completionCannotPublishReceiptAfterCancellationOrLogout() throws Exception {
        for (boolean logout : Arrays.asList(false, true)) {
            Fixture fixture = new Fixture();
            final boolean[] cancelled = {false};
            fixture.completionHook = () -> {
                cancelled[0] = true;
                if (logout) {
                    try { fixture.engine.prepareLogout(KEY); }
                    catch (Failure error) { throw new AssertionError(error.code); }
                }
            };
            try {
                fixture.run(() -> { if (!logout && cancelled[0]) throw new Failure("NATIVE_OPERATION_CANCELLED"); });
                fail("A late completion must not publish a receipt");
            } catch (Failure error) { assertEquals("NATIVE_OPERATION_CANCELLED", error.code); }
            assertEquals(1, fixture.completeAttempts); assertEquals(1, fixture.resultAttempts);
            assertEquals(2, fixture.providerCalls); assertTrue(fixture.metrics.isEmpty());
        }
    }

    @Test public void partialCompletionCannotPublishSuccessReceiptOrRepeatReads() throws Exception {
        Fixture fixture = new Fixture();
        fixture.complete = fixture.complete.replace("\"completedCommands\":1", "\"completedCommands\":0");
        fixture.fails("NATIVE_BOOKINGS_COMPLETION_REJECTED");
        assertEquals(1, fixture.completeAttempts); assertEquals(1, fixture.resultAttempts);
        assertEquals(2, fixture.providerCalls);
        assertEquals(1, countExactPath(fixture.api, "/booking-screen-read-jobs"));
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
        long serverWall = 1_790_531_000_123L;
        boolean defaultServerDate = true;
        final Map<String, String> responseDates = new HashMap<>();
        String delayedPath;
        long elapsedBeforeResponse;
        String jobFailure;
        String jobContentType = "application/json";
        int jobStatus = 200;
        byte[] jobBodyOverride;
        boolean nullJobBody;
        String delegationFailure;
        String delegationContentType = "application/json";
        int delegationStatus = 200;
        byte[] delegationBodyOverride;
        boolean nullDelegationBody;
        Runnable delegationHook;
        String list = "{\"content\":[{\"id\":\"active id&1\",\"isCancelled\":false},{\"id\":42,\"isCancelled\":false},{\"id\":\"cancelled\",\"isCancelled\":true}]}";
        String details = "[{\"id\":\"active id&1\"}]";
        String result = "{\"accepted\":true,\"replayed\":false,\"itemCount\":2}";
        String complete;
        int providerStatus = 200;
        String failPath, throwPath;
        int providerCalls, resultAttempts, completeAttempts;
        Runnable providerHook;
        Runnable completionHook;
        AndroidSessionEngine engine;

        Fixture() throws Exception {
            policy = new AndroidSessionPolicy(ORIGIN, "local-padel", "test-version", "73", false);
            plan = plan(serverWall + 60_000); job = job(serverWall + 60_000);
            complete = "{\"screen\":\"MY_BOOKINGS\",\"state\":\"READY\",\"completedCommands\":1,\"totalCommands\":1,\"bookings\":{\"version\":\"synthetic-v1\",\"generatedAt\":\"" + iso(clock.wall) + "\",\"staleAt\":\"" + iso(clock.wall + 60_000) + "\",\"items\":[]}}";
            delegation = delegation(PROVIDER_TOKEN, iso(clock.wall + 60_000));
            engine = new AndroidSessionEngine(policy, store, this::send, null, clock);
            engine.request(VERIFY, "POST", headers(null, KEY), VERIFY_BODY);
            api.clear();
        }
        Response send(Request request) throws Failure {
            if (request.path.equals(VERIFY)) return session(REFRESH);
            if (request.path.endsWith("/routing-outcomes")) { metrics.add(copy(request)); return json(204, "", dateFor(request.path)); }
            api.add(copy(request));
            if (delayedPath != null && request.path.endsWith(delayedPath)) clock.elapsed += elapsedBeforeResponse;
            if (request.path.endsWith("/routing-plan")) return json(200, plan, dateFor(request.path));
            if (request.path.endsWith("/booking-screen-read-jobs")) {
                if (jobFailure != null) throw new Failure(jobFailure);
                byte[] body = nullJobBody ? null : jobBodyOverride == null ? job.getBytes(StandardCharsets.UTF_8) : jobBodyOverride;
                return response(jobStatus, body, jobContentType, dateFor(request.path));
            }
            if (request.path.endsWith("/auth/viva/access")) {
                if (delegationFailure != null) throw new Failure(delegationFailure);
                byte[] body = nullDelegationBody ? null : delegationBodyOverride == null ? delegation.getBytes(StandardCharsets.UTF_8) : delegationBodyOverride;
                if (delegationHook != null) delegationHook.run();
                return response(delegationStatus, body, delegationContentType, dateFor(request.path));
            }
            if (request.path.contains("/results/")) {
                resultAttempts++;
                if ("result".equals(throwPath) && resultAttempts == 1) throw new Failure("NATIVE_NETWORK_UNAVAILABLE");
                if ("result".equals(failPath)) return json(500, "{}", dateFor(request.path));
                return json(200, result, dateFor(request.path));
            }
            if (request.path.endsWith("/complete")) {
                completeAttempts++;
                if (completionHook != null) completionHook.run();
                if ("complete".equals(throwPath) && completeAttempts == 1) throw new Failure("NATIVE_NETWORK_UNAVAILABLE");
                if ("complete".equals(failPath)) return json(500, "{}", dateFor(request.path));
                return json(200, complete, dateFor(request.path));
            }
            return json(500, "{}", dateFor(request.path));
        }
        Response provider(String path, String token) throws Failure {
            providerPaths.add(path); providerTokens.add(token); providerCalls++;
            if (providerHook != null) providerHook.run();
            if ("provider".equals(throwPath)) throw new Failure("NATIVE_NETWORK_UNAVAILABLE");
            if (providerStatus != 200) return json(providerStatus, "{}");
            return json(200, path.contains("/list?") ? details : list);
        }
        AndroidUpcomingBookingsRefresh.Receipt run() throws Exception {
            return run(() -> {});
        }
        AndroidUpcomingBookingsRefresh.Receipt run(AndroidUpcomingBookingsRefresh.Cancellation cancellation) throws Exception {
            return new AndroidUpcomingBookingsRefresh(policy, engine, this::send, this::provider, clock, circuits).run(engine.nativeAccess(), cancellation);
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
        String dateFor(String path) {
            if (responseDates.containsKey(path)) return responseDates.get(path);
            return defaultServerDate ? httpDate(serverWall) : null;
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
            Fixture f = new Fixture(); f.plan = bad; f.fails("NATIVE_BOOKINGS_PLAN_REJECTED");
            assertEquals(0, f.providerCalls); assertEquals(0, countPath(f.api, "/auth/viva/access"));
        }
        Fixture wrongJob = new Fixture(); wrongJob.job = wrongJob.job.replace("\"concurrency\":1", "\"concurrency\":2"); wrongJob.fails("NATIVE_BOOKINGS_JOB_CONTRACT_REJECTED");
        assertEquals(0, wrongJob.providerCalls); assertEquals(0, countPath(wrongJob.api, "/auth/viva/access"));
    }

    @Test public void jobDiagnosticsClassifyTransportMediaJsonCommandIdAndExpiryBeforeDelegation() throws Exception {
        Fixture transportFailure = new Fixture(); transportFailure.jobFailure = "NATIVE_RESPONSE_REJECTED";
        rejectsJobBeforeDelegate(transportFailure, "NATIVE_BOOKINGS_JOB_TRANSPORT_REJECTED");
        Fixture oversized = new Fixture(); oversized.jobBodyOverride = new byte[AndroidUpcomingBookingsRefresh.PROVIDER_LIMIT + 1];
        rejectsJobBeforeDelegate(oversized, "NATIVE_BOOKINGS_JOB_TRANSPORT_REJECTED");

        Fixture media = new Fixture(); media.jobContentType = "text/plain";
        rejectsJobBeforeDelegate(media, "NATIVE_BOOKINGS_JOB_MEDIA_REJECTED");
        Fixture empty = new Fixture(); empty.jobBodyOverride = new byte[0];
        rejectsJobBeforeDelegate(empty, "NATIVE_BOOKINGS_JOB_JSON_REJECTED");
        Fixture nullBody = new Fixture(); nullBody.nullJobBody = true;
        rejectsJobBeforeDelegate(nullBody, "NATIVE_BOOKINGS_JOB_TRANSPORT_REJECTED");
        Fixture invalidUtf8 = new Fixture(); invalidUtf8.jobBodyOverride = new byte[] {(byte) 0xc3, (byte) 0x28};
        rejectsJobBeforeDelegate(invalidUtf8, "NATIVE_BOOKINGS_JOB_JSON_REJECTED");
        Fixture invalidJson = new Fixture(); invalidJson.jobBodyOverride = "{\"private-marker\":".getBytes(StandardCharsets.UTF_8);
        rejectsJobBeforeDelegate(invalidJson, "NATIVE_BOOKINGS_JOB_JSON_REJECTED");
        for (String root : Arrays.asList("[]", "null", "true", "42", "\"private-marker\"")) {
            Fixture wrongRoot = new Fixture(); wrongRoot.jobBodyOverride = root.getBytes(StandardCharsets.UTF_8);
            rejectsJobBeforeDelegate(wrongRoot, "NATIVE_BOOKINGS_JOB_CONTRACT_REJECTED");
        }

        Fixture command = new Fixture(); JSONObject commandBody = new JSONObject(command.job); commandBody.put("commands", new JSONArray()); command.job = commandBody.toString();
        rejectsJobBeforeDelegate(command, "NATIVE_BOOKINGS_JOB_COMMAND_REJECTED");
        Fixture identifier = new Fixture(); identifier.job = identifier.job.replace(JOB, "not-a-padlhub-uuid");
        rejectsJobBeforeDelegate(identifier, "NATIVE_BOOKINGS_JOB_ID_REJECTED");
        Fixture expiry = new Fixture(); JSONObject expiryBody = new JSONObject(expiry.job); expiryBody.put("expiresAt", "tomorrow"); expiry.job = expiryBody.toString();
        rejectsJobBeforeDelegate(expiry, "NATIVE_BOOKINGS_JOB_EXPIRY_REJECTED");

        String marker = "job-secret-marker";
        Fixture contract = new Fixture(); contract.job = "{\"screen\":\"OTHER\",\"concurrency\":1,\"marker\":\"" + marker + "\"}";
        try { contract.run(); fail(); } catch (Failure error) {
            assertEquals("NATIVE_BOOKINGS_JOB_CONTRACT_REJECTED", error.code); assertFalse(error.getMessage().contains(marker)); assertNull(error.getCause());
        }
        assertEquals(0, contract.providerCalls); assertEquals(0, countPath(contract.api, "/auth/viva/access"));
        assertEquals(0, countPath(contract.api, "/results/")); assertEquals(0, countPath(contract.api, "/complete"));
    }

    @Test public void jobDiagnosticsNeverReplaceAuthCancellationTlsRedirectOrNetworkFailures() throws Exception {
        for (String code : Arrays.asList("NATIVE_OPERATION_CANCELLED", "NATIVE_TLS_REJECTED", "NATIVE_REDIRECT_REJECTED")) {
            Fixture f = new Fixture(); f.jobFailure = code; rejectsJobBeforeDelegate(f, code);
        }
        Fixture network = new Fixture(); network.jobFailure = "NATIVE_NETWORK_UNAVAILABLE";
        rejectsJobBeforeDelegate(network, "NATIVE_REFRESH_UNAVAILABLE");
        for (int status : new int[] {403, 500, 302}) {
            Fixture f = new Fixture(); f.jobStatus = status; f.jobContentType = "private-invalid-media";
            f.jobBodyOverride = "private-malformed-body".getBytes(StandardCharsets.UTF_8);
            rejectsJobBeforeDelegate(f, status == 302 ? "NATIVE_REDIRECT_REJECTED" : "NATIVE_REFRESH_UNAVAILABLE");
        }
        Fixture unauthorized = new Fixture(); unauthorized.jobStatus = 401;
        unauthorized.jobContentType = "private-invalid-media";
        unauthorized.responseDates.put(ROOT + "/booking-screen-read-jobs", "private-invalid-date");
        rejectsJobBeforeDelegate(unauthorized, "AUTH_SESSION_REVOKED");
        try { unauthorized.engine.nativeAccess(); fail(); }
        catch (Failure error) { assertEquals("AUTH_SESSION_REVOKED", error.code); }
    }

    @Test public void opaqueDelegationAcceptsOnlyBoundedBearerValuesAndNeverLeaksThem() throws Exception {
        String marker = "provider-secret-marker";
        for (String token : Arrays.asList("", "opaque token", "opaque\\r\\n" + marker, repeats("x", 8193).replace(",", ""))) {
            Fixture f = new Fixture(); f.delegation = "{\"accessToken\":\"" + token + "\",\"expiresAt\":\"" + iso(f.clock.wall + 60_000) + "\"}";
            try { f.run(); fail(); } catch (Failure error) {
                assertEquals("NATIVE_BOOKINGS_DELEGATION_TOKEN_REJECTED", error.code); assertFalse(error.getMessage().contains(marker)); assertNull(error.getCause());
            }
            assertEquals(0, f.providerCalls); assertEquals(0, countPath(f.api, "/results/"));
        }
        Fixture expired = new Fixture(); expired.delegation = "{\"accessToken\":\"" + PROVIDER_TOKEN + "\",\"expiresAt\":\"" + iso(expired.clock.wall) + "\"}";
        expired.fails("NATIVE_BOOKINGS_DELEGATION_EXPIRED_REJECTED"); assertEquals(0, expired.providerCalls);
    }

    @Test public void delegationDiagnosticsCloseBeforeProviderAndWipeRejectedBytes() throws Exception {
        Fixture transport = new Fixture(); transport.delegationFailure = "NATIVE_RESPONSE_REJECTED";
        rejectsDelegationBeforeProvider(transport, "NATIVE_BOOKINGS_DELEGATION_TRANSPORT_REJECTED");
        Fixture oversized = new Fixture(); oversized.delegationBodyOverride = new byte[AndroidUpcomingBookingsRefresh.PROVIDER_LIMIT + 1];
        Arrays.fill(oversized.delegationBodyOverride, (byte) 0x5a);
        rejectsDelegationBeforeProvider(oversized, "NATIVE_BOOKINGS_DELEGATION_TRANSPORT_REJECTED");
        assertZeroed(oversized.delegationBodyOverride);
        Fixture absent = new Fixture(); absent.nullDelegationBody = true;
        rejectsDelegationBeforeProvider(absent, "NATIVE_BOOKINGS_DELEGATION_TRANSPORT_REJECTED");
        Fixture empty = new Fixture(); empty.delegationBodyOverride = new byte[0];
        rejectsDelegationBeforeProvider(empty, "NATIVE_BOOKINGS_DELEGATION_JSON_REJECTED");
        Fixture utf8 = new Fixture(); utf8.delegationBodyOverride = new byte[] {(byte) 0xc3, (byte) 0x28};
        rejectsDelegationBeforeProvider(utf8, "NATIVE_BOOKINGS_DELEGATION_JSON_REJECTED"); assertZeroed(utf8.delegationBodyOverride);
        Fixture media = new Fixture(); byte[] mediaBytes = delegation(PROVIDER_TOKEN, iso(media.clock.wall + 60_000)).getBytes(StandardCharsets.UTF_8);
        media.delegationBodyOverride = mediaBytes; media.delegationContentType = "text/plain";
        rejectsDelegationBeforeProvider(media, "NATIVE_BOOKINGS_DELEGATION_MEDIA_REJECTED"); assertZeroed(mediaBytes);
        Fixture malformed = new Fixture(); byte[] malformedBytes = "{\"private-delegation\":".getBytes(StandardCharsets.UTF_8);
        malformed.delegationBodyOverride = malformedBytes;
        rejectsDelegationBeforeProvider(malformed, "NATIVE_BOOKINGS_DELEGATION_JSON_REJECTED"); assertZeroed(malformedBytes);
        for (String body : Arrays.asList("[]", "null", "true", "42", "\"private-marker\"")) {
            Fixture root = new Fixture(); root.delegationBodyOverride = body.getBytes(StandardCharsets.UTF_8);
            rejectsDelegationBeforeProvider(root, "NATIVE_BOOKINGS_DELEGATION_CONTRACT_REJECTED"); assertZeroed(root.delegationBodyOverride);
        }
        Fixture expiry = new Fixture(); expiry.delegation = delegation(PROVIDER_TOKEN, "not-an-iso-date");
        rejectsDelegationBeforeProvider(expiry, "NATIVE_BOOKINGS_DELEGATION_EXPIRY_REJECTED");
    }

    @Test public void delegationDeadlineAcceptsLongProviderTokensButNeverOutlivesTheJob() throws Exception {
        for (long ttl : new long[] {3_601_000, 86_400_000}) {
            Fixture f = new Fixture(); f.clock.wall = f.serverWall + 300_000;
            f.plan = plan(f.serverWall + 300_000); f.job = job(isoMillis(f.serverWall + 120_000));
            f.delegation = delegation(PROVIDER_TOKEN, isoMillis(f.serverWall + ttl));
            f.run(); assertEquals(2, f.providerCalls); assertEquals(1, countPath(f.api, "/results/"));
        }

        Fixture shorter = new Fixture(); shorter.plan = plan(shorter.serverWall + 300_000);
        shorter.job = job(isoMillis(shorter.serverWall + 120_000));
        shorter.delegation = delegation(PROVIDER_TOKEN, isoMillis(shorter.serverWall + 2_000));
        shorter.providerHook = () -> { if (shorter.providerCalls == 1) shorter.clock.elapsed += 2_000; };
        shorter.fails("NATIVE_REFRESH_UNAVAILABLE");
        assertEquals(1, shorter.providerCalls); assertEquals(0, countPath(shorter.api, "/results/"));
    }

    @Test public void delegationDateTimingAndCancellationCannotPublishOrReuseAToken() throws Exception {
        Fixture malformedDate = new Fixture(); malformedDate.responseDates.put(ROOT + "/auth/viva/access", "bad-date");
        rejectsDelegationBeforeProvider(malformedDate, "NATIVE_BOOKINGS_DELEGATION_DATE_REJECTED");
        Fixture duplicateDate = new Fixture(); String date = httpDate(duplicateDate.serverWall);
        duplicateDate.responseDates.put(ROOT + "/auth/viva/access", date + ", " + date);
        rejectsDelegationBeforeProvider(duplicateDate, "NATIVE_BOOKINGS_DELEGATION_DATE_REJECTED");
        Fixture missingAhead = new Fixture(); missingAhead.clock.wall = missingAhead.serverWall + 300_000;
        missingAhead.defaultServerDate = false;
        missingAhead.responseDates.put(ROOT + "/routing-plan", httpDate(missingAhead.serverWall));
        missingAhead.responseDates.put(ROOT + "/booking-screen-read-jobs", httpDate(missingAhead.serverWall));
        missingAhead.delegation = delegation(PROVIDER_TOKEN, isoMillis(missingAhead.serverWall + 60_000));
        rejectsDelegationBeforeProvider(missingAhead, "NATIVE_BOOKINGS_DELEGATION_EXPIRED_REJECTED");
        Fixture negativeTransit = new Fixture(); negativeTransit.plan = plan(negativeTransit.serverWall + 300_000);
        negativeTransit.job = job(isoMillis(negativeTransit.serverWall + 120_000));
        negativeTransit.delegationHook = () -> negativeTransit.clock.elapsed--;
        rejectsDelegationBeforeProvider(negativeTransit, "NATIVE_BOOKINGS_DELEGATION_TIMING_REJECTED");
        Fixture slowTransit = new Fixture(); slowTransit.plan = plan(slowTransit.serverWall + 300_000);
        slowTransit.job = job(isoMillis(slowTransit.serverWall + 120_000));
        slowTransit.delegationHook = () -> slowTransit.clock.elapsed += 60_001;
        rejectsDelegationBeforeProvider(slowTransit, "NATIVE_BOOKINGS_DELEGATION_TIMING_REJECTED");
        Fixture overflow = new Fixture(); overflow.delegationHook = () -> overflow.clock.elapsed = Long.MIN_VALUE;
        rejectsDelegationBeforeProvider(overflow, "NATIVE_BOOKINGS_DELEGATION_TIMING_REJECTED");
        Fixture negativeElapsed = new Fixture(); negativeElapsed.delegationHook = () -> negativeElapsed.clock.elapsed = -1;
        rejectsDelegationBeforeProvider(negativeElapsed, "NATIVE_BOOKINGS_DELEGATION_TIMING_REJECTED");
        Fixture expiredInTransit = new Fixture(); expiredInTransit.delegation = delegation(PROVIDER_TOKEN, isoMillis(expiredInTransit.serverWall + 2_000));
        expiredInTransit.delegationHook = () -> expiredInTransit.clock.elapsed += 1_200;
        rejectsDelegationBeforeProvider(expiredInTransit, "NATIVE_BOOKINGS_DELEGATION_EXPIRED_REJECTED");

        Fixture cancellation = new Fixture(); byte[] cancelledBytes = delegation(PROVIDER_TOKEN, iso(cancellation.clock.wall + 60_000)).getBytes(StandardCharsets.UTF_8);
        cancellation.delegationBodyOverride = cancelledBytes; final boolean[] cancelled = {false}; cancellation.delegationHook = () -> cancelled[0] = true;
        try { cancellation.run(() -> { if (cancelled[0]) throw new Failure("NATIVE_OPERATION_CANCELLED"); }); fail(); }
        catch (Failure error) { assertEquals("NATIVE_OPERATION_CANCELLED", error.code); }
        assertZeroed(cancelledBytes); assertEquals(0, cancellation.providerCalls); assertEquals(0, countPath(cancellation.api, "/results/"));
        Fixture logout = new Fixture(); byte[] logoutBytes = delegation(PROVIDER_TOKEN, iso(logout.clock.wall + 60_000)).getBytes(StandardCharsets.UTF_8);
        logout.delegationBodyOverride = logoutBytes; logout.delegationHook = () -> { try { logout.engine.prepareLogout(NEXT_KEY); } catch (Failure error) { throw new RuntimeException(error); } };
        logout.fails("NATIVE_OPERATION_CANCELLED"); assertZeroed(logoutBytes); assertEquals(0, logout.providerCalls);
    }

    @Test public void missingDelegationDateUsesWallButCannotExtendJobWhenPhoneIsBehind() throws Exception {
        Fixture f = new Fixture(); f.clock.wall = f.serverWall - 300_000;
        f.responseDates.put(ROOT + "/auth/viva/access", null);
        f.delegation = delegation(PROVIDER_TOKEN, isoMillis(f.serverWall + 86_400_000));
        f.providerHook = () -> f.clock.elapsed += 60_000;
        f.fails("NATIVE_OPERATION_CANCELLED");
        assertEquals(1, f.providerCalls); assertEquals(0, countPath(f.api, "/results/")); assertEquals(0, countPath(f.api, "/complete"));

        Fixture future = new Fixture(); future.delegation = delegation(PROVIDER_TOKEN, "9999-12-31T23:59:59.999Z");
        future.run(); assertEquals(2, future.providerCalls);
    }

    @Test public void delegationDiagnosticsNeverReplaceAuthCancellationTlsRedirectOrNetworkFailures() throws Exception {
        String[] failures = {"NATIVE_TLS_REJECTED", "NATIVE_NETWORK_UNAVAILABLE", "NATIVE_OPERATION_CANCELLED"};
        String[] codes = {"NATIVE_TLS_REJECTED", "NATIVE_REFRESH_UNAVAILABLE", "NATIVE_OPERATION_CANCELLED"};
        for (int i = 0; i < failures.length; i++) {
            Fixture f = new Fixture(); f.delegationFailure = failures[i]; rejectsDelegationBeforeProvider(f, codes[i]);
        }
        for (int status : new int[] {302, 403, 429, 500}) {
            Fixture f = new Fixture(); f.delegationStatus = status; f.delegationContentType = "private-media";
            f.delegationBodyOverride = "private-token".getBytes(StandardCharsets.UTF_8);
            rejectsDelegationBeforeProvider(f, status == 302 ? "NATIVE_REDIRECT_REJECTED" : "NATIVE_REFRESH_UNAVAILABLE");
            assertZeroed(f.delegationBodyOverride);
        }
        Fixture revoked = new Fixture(); revoked.delegationStatus = 401; revoked.delegationContentType = "private-media";
        revoked.delegationBodyOverride = "private-token".getBytes(StandardCharsets.UTF_8);
        rejectsDelegationBeforeProvider(revoked, "AUTH_SESSION_REVOKED"); assertZeroed(revoked.delegationBodyOverride);
        try { revoked.engine.nativeAccess(); fail(); } catch (Failure error) { assertEquals("AUTH_SESSION_REVOKED", error.code); }
    }

    @Test public void oneProvider401CanReissueButCannotExtendTheOriginalJobDeadline() throws Exception {
        Fixture f = new Fixture(); f.plan = plan(f.serverWall + 300_000); f.job = job(isoMillis(f.serverWall + 60_000));
        f.delegation = delegation(PROVIDER_TOKEN, isoMillis(f.serverWall + 86_400_000)); final int[] calls = {0};
        AndroidUpcomingBookingsRefresh.ProviderSender provider = (path, token) -> {
            f.providerPaths.add(path); f.providerTokens.add(token); calls[0]++;
            if (calls[0] == 1) return json(401, "{}");
            f.clock.elapsed += 60_000; return json(200, path.contains("/list?") ? f.details : f.list);
        };
        try { new AndroidUpcomingBookingsRefresh(f.policy, f.engine, f::send, provider, f.clock, f.circuits).run(f.engine.nativeAccess(), () -> {}); fail(); }
        catch (Failure error) { assertEquals("NATIVE_OPERATION_CANCELLED", error.code); }
        assertEquals(2, calls[0]); assertEquals(2, countPath(f.api, "/auth/viva/access")); assertEquals(0, countPath(f.api, "/results/"));
    }

    @Test public void badListBoundariesNeverReachTheResultWrite() throws Exception {
        String fiftyOne = "{\"content\":[" + repeats("{\"id\":\"x\",\"isCancelled\":false}", 51) + "]}";
        for (String bad : Arrays.asList("{\"content\":[{\"id\":\"" + repeats("x", 129).replace(",", "") + "\",\"isCancelled\":false}]}", fiftyOne, "{\"content\":[{\"id\":\"x\"}]}", "{\"content\":[{\"id\":\"\",\"isCancelled\":false}]}", "{\"content\":[{\"id\":{},\"isCancelled\":false}]}")) {
            Fixture f = new Fixture(); Credential before = f.store.value; f.list = bad; f.fails("NATIVE_BOOKINGS_LIST_REJECTED");
            assertEquals(1, f.providerPaths.size()); assertEquals(0, countPath(f.api, "/results/")); assertEquals(0, countPath(f.api, "/complete"));
            assertSame(before, f.store.value);
        }
    }

    @Test public void malformedDetailsAreClosedAtTheDetailsStageWithoutResultWrite() throws Exception {
        Fixture f = new Fixture(); f.details = "{\"unterminated\":";
        f.fails("NATIVE_BOOKINGS_DETAILS_REJECTED");
        assertEquals(2, f.providerPaths.size()); assertEquals(0, countPath(f.api, "/results/")); assertEquals(0, countPath(f.api, "/complete"));
    }

    @Test public void serverAnchoredJobExpiryAcceptsFiveMinuteDeviceSkewAndConsumesRequestTime() throws Exception {
        for (long skew : new long[] {-300_000, 300_000}) {
            Fixture f = new Fixture(); f.clock.wall = f.serverWall + skew;
            f.plan = plan(f.serverWall + 300_000);
            f.job = job(isoMillis(f.serverWall + 120_000));
            f.delayedPath = "/booking-screen-read-jobs"; f.elapsedBeforeResponse = 400;
            f.run();
            assertEquals(2, f.providerCalls); assertEquals(1, countPath(f.api, "/results/"));
        }
        Fixture upperBoundary = new Fixture(); upperBoundary.plan = plan(upperBoundary.serverWall + 300_000);
        // The server's HTTP Date is rounded down to the second; this is exactly max TTL + 999 ms.
        upperBoundary.job = job(isoMillis(upperBoundary.serverWall + 120_876));
        upperBoundary.run(); assertEquals(2, upperBoundary.providerCalls);
    }

    @Test public void serverAnchoredJobExpiryFailsClosedBeforeDelegationOrProvider() throws Exception {
        long[] expiryOffsets = {-1, 121_000}; String[] expiryCodes = {"NATIVE_BOOKINGS_JOB_EXPIRED_REJECTED", "NATIVE_BOOKINGS_JOB_LIFETIME_REJECTED"};
        for (int i = 0; i < expiryOffsets.length; i++) {
            Fixture f = new Fixture(); f.plan = plan(f.serverWall + 300_000);
            f.job = job(isoMillis(f.serverWall + expiryOffsets[i]));
            f.fails(expiryCodes[i]);
            assertEquals(0, countPath(f.api, "/auth/viva/access")); assertEquals(0, f.providerCalls);
        }
        Fixture malformedDate = new Fixture();
        malformedDate.responseDates.put(ROOT + "/booking-screen-read-jobs", "Tue, 99 Not-a-month 2026 00:00:00 GMT");
        malformedDate.fails("NATIVE_BOOKINGS_JOB_DATE_REJECTED");
        assertEquals(0, countPath(malformedDate.api, "/auth/viva/access")); assertEquals(0, malformedDate.providerCalls);
        Fixture malformedPlanDate = new Fixture();
        malformedPlanDate.responseDates.put(ROOT + "/routing-plan", "2026-10-12T00:00:00Z");
        malformedPlanDate.fails("NATIVE_BOOKINGS_PLAN_REJECTED");
        assertEquals(0, countExactPath(malformedPlanDate.api, "/booking-screen-read-jobs"));
    }

    @Test public void serverAnchoredExpirySubtractsRttAndMissingDateUsesStrictDeviceWallFallback() throws Exception {
        Fixture rttExpired = new Fixture(); rttExpired.plan = plan(rttExpired.serverWall + 300_000);
        rttExpired.job = job(isoMillis(rttExpired.serverWall + 2_000));
        rttExpired.delayedPath = "/booking-screen-read-jobs"; rttExpired.elapsedBeforeResponse = 1_200;
        rttExpired.fails("NATIVE_BOOKINGS_JOB_EXPIRED_REJECTED");
        assertEquals(0, rttExpired.providerCalls);

        Fixture missingDate = new Fixture(); missingDate.clock.wall = missingDate.serverWall + 300_000;
        missingDate.plan = plan(missingDate.serverWall + 600_000);
        missingDate.job = job(isoMillis(missingDate.serverWall + 120_000));
        missingDate.defaultServerDate = false;
        missingDate.responseDates.put(ROOT + "/routing-plan", httpDate(missingDate.serverWall));
        missingDate.responseDates.put(ROOT + "/booking-screen-read-jobs", null);
        missingDate.fails("NATIVE_BOOKINGS_JOB_EXPIRED_REJECTED");
        assertEquals(0, countPath(missingDate.api, "/auth/viva/access")); assertEquals(0, missingDate.providerCalls);
    }

    @Test public void expiryUsesOnlyItsOwnResponseAndResultDatesCannotAlterIt() throws Exception {
        Fixture expiredJob = new Fixture(); expiredJob.plan = plan(expiredJob.serverWall + 300_000);
        expiredJob.job = job(isoMillis(expiredJob.serverWall + 120_000));
        expiredJob.responseDates.put(ROOT + "/booking-screen-read-jobs", httpDate(expiredJob.serverWall + 130_000));
        expiredJob.fails("NATIVE_BOOKINGS_JOB_EXPIRED_REJECTED");
        assertEquals(0, countPath(expiredJob.api, "/auth/viva/access")); assertEquals(0, expiredJob.providerCalls);

        Fixture expiredToken = new Fixture();
        expiredToken.responseDates.put(ROOT + "/auth/viva/access", httpDate(expiredToken.serverWall + 70_000));
        expiredToken.fails("NATIVE_BOOKINGS_DELEGATION_EXPIRED_REJECTED"); assertEquals(0, expiredToken.providerCalls);

        Fixture malformedTokenDate = new Fixture();
        malformedTokenDate.responseDates.put(ROOT + "/auth/viva/access", "");
        malformedTokenDate.fails("NATIVE_BOOKINGS_DELEGATION_DATE_REJECTED"); assertEquals(0, malformedTokenDate.providerCalls);

        Fixture resultDates = new Fixture();
        resultDates.responseDates.put(ROOT + "/booking-screen-read-jobs/" + JOB + "/results/" + COMMAND, "ignored-invalid-result-date");
        resultDates.responseDates.put(ROOT + "/booking-screen-read-jobs/" + JOB + "/complete", "ignored-invalid-completion-date");
        resultDates.run(); assertEquals(2, resultDates.providerCalls); assertEquals(1, resultDates.completeAttempts);
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
        Fixture rejected = new Fixture(); rejected.result = "{\"accepted\":false,\"replayed\":false,\"itemCount\":0}"; rejected.fails("NATIVE_BOOKINGS_RESULT_REJECTED");
        assertEquals(0, countPath(rejected.api, "/complete"));
        Fixture incomplete = new Fixture(); incomplete.result = "{\"accepted\":true}"; incomplete.fails("NATIVE_BOOKINGS_RESULT_REJECTED");
        assertEquals(0, countPath(incomplete.api, "/complete"));
        Fixture missingBookings = new Fixture(); missingBookings.complete = "{\"screen\":\"MY_BOOKINGS\",\"state\":\"READY\",\"completedCommands\":1,\"totalCommands\":1}";
        missingBookings.fails("NATIVE_BOOKINGS_COMPLETION_REJECTED");
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
    static void rejectsJobBeforeDelegate(Fixture fixture, String code) throws Exception {
        fixture.fails(code);
        assertEquals(0, countPath(fixture.api, "/auth/viva/access")); assertEquals(0, fixture.providerCalls);
        assertEquals(0, countPath(fixture.api, "/results/")); assertEquals(0, countPath(fixture.api, "/complete"));
    }
    static void rejectsDelegationBeforeProvider(Fixture fixture, String code) throws Exception {
        try { fixture.run(); fail("Expected " + code); }
        catch (Failure error) {
            assertEquals(code, error.code); assertNull(error.getCause()); assertFalse(error.getMessage().contains("private"));
        }
        assertEquals(1, countPath(fixture.api, "/auth/viva/access")); assertEquals(0, fixture.providerCalls);
        assertEquals(0, countPath(fixture.api, "/results/")); assertEquals(0, countPath(fixture.api, "/complete"));
    }
    static void assertZeroed(byte[] bytes) { for (byte value : bytes) assertEquals(0, value); }
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
