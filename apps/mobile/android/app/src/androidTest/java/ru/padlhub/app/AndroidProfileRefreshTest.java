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
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;
import static ru.padlhub.app.AndroidSessionEngine.*;
import static ru.padlhub.app.AndroidSessionPolicy.*;
import static ru.padlhub.app.AndroidSessionTest.*;

/** Contract tests for the one approved, native-only profile.read refresh transport. */
@RunWith(AndroidJUnit4.class)
public class AndroidProfileRefreshTest {
    static final String JOB = "00000000-0000-4000-8000-000000000020";
    static final String COMMAND = "00000000-0000-4000-8000-000000000021";
    static final String PROVIDER_TOKEN = "initial-viva-access-token";
    static final String PROVIDER_ID = "00000000-0000-4000-8000-000000000030";
    static final String PROFILE = "{\"id\":\"" + PROVIDER_ID + "\",\"firstName\":\"Ivan\",\"deposit\":150000,\"customFields\":[]}";

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
        return "{\"revision\":\"73\",\"mode\":\"MIXED_END_USER_READS\",\"issuedAt\":\"" + iso(expiry - 60_000) + "\",\"expiresAt\":\"" + iso(expiry) + "\",\"directViva\":{\"apiBaseUrl\":\"https://api.vivacrm.ru/end-user/api\",\"providerTenantKey\":\"citysport\",\"accessTokenPath\":\"/auth/viva/access\",\"allowedRequestHeaders\":[\"Authorization\"],\"allowedMediaHosts\":[\"media.vivacrm.ru\"],\"providerPhoneSync\":false},\"operations\":[{\"operation\":\"profile.read\",\"transport\":\"DIRECT_VIVA\",\"fallback\":\"UNAVAILABLE\"},{\"operation\":\"bookings.read\",\"transport\":\"PADLHUB_API\",\"fallback\":\"PADLHUB_API\"},{\"operation\":\"bookings.details.read\",\"transport\":\"PADLHUB_API\",\"fallback\":\"PADLHUB_API\"},{\"operation\":\"bookings.history.read\",\"transport\":\"PADLHUB_API\",\"fallback\":\"PADLHUB_API\"},{\"operation\":\"subscriptions.read\",\"transport\":\"PADLHUB_API\",\"fallback\":\"PADLHUB_API\"},{\"operation\":\"schedule.read\",\"transport\":\"PADLHUB_API\",\"fallback\":\"PADLHUB_API\"}]}";
    }
    static String job(long expiry) {
        return job(iso(expiry));
    }
    static String job(String expiry) {
        return "{\"jobId\":\"" + JOB + "\",\"commandId\":\"" + COMMAND + "\",\"expiresAt\":\"" + expiry + "\"}";
    }
    static String delegation(String token, String expiry) {
        return "{\"accessToken\":\"" + token + "\",\"expiresAt\":\"" + expiry + "\"}";
    }
    /** A syntactically valid profile object padded to exactly this many UTF-8 bytes. */
    static byte[] paddedProfile(int bytes) {
        String prefix = "{\"deposit\":0,\"padding\":\"", suffix = "\"}";
        int padding = bytes - prefix.length() - suffix.length();
        char[] value = new char[padding]; Arrays.fill(value, 'x');
        return (prefix + new String(value) + suffix).getBytes(StandardCharsets.UTF_8);
    }

    static class Fixture {
        final TestClock clock = new TestClock();
        final MemoryStore store = new MemoryStore();
        final AndroidSessionPolicy policy;
        final List<Request> api = new ArrayList<>();
        final List<Request> metrics = new ArrayList<>();
        final AndroidProfileRefresh.Circuits circuits = new AndroidProfileRefresh.Circuits();
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
        String profile = PROFILE;
        byte[] profileBodyOverride;
        String providerContentType = "application/json";
        String result;
        String complete;
        int providerStatus = 200;
        String failPath, throwPath;
        int providerCalls, resultAttempts, completeAttempts;
        Runnable providerHook;
        AndroidSessionEngine engine;

        Fixture() throws Exception {
            policy = new AndroidSessionPolicy(ORIGIN, "local-padel", "test-version", "73", false);
            plan = plan(serverWall + 60_000); job = job(serverWall + 60_000);
            delegation = delegation(PROVIDER_TOKEN, iso(clock.wall + 60_000));
            result = "{\"accepted\":true,\"replayed\":false,\"observedAt\":\"" + iso(clock.wall) + "\"}";
            complete = "{\"state\":\"refreshed\",\"observedAt\":\"" + iso(clock.wall) + "\"}";
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
            if (request.path.endsWith("/profile/provider-read-jobs")) {
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
            byte[] body = profileBodyOverride == null ? profile.getBytes(StandardCharsets.UTF_8) : profileBodyOverride;
            return response(200, body, providerContentType, null);
        }
        void run() throws Exception {
            run(() -> {});
        }
        void run(AndroidProfileRefresh.Cancellation cancellation) throws Exception {
            new AndroidProfileRefresh(policy, engine, this::send, this::provider, clock, circuits).run(engine.nativeAccess(), cancellation);
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

    @Test public void acceptedJobRunsTheFixedSequenceAndRelaysOnlyTheBoundedPayload() throws Exception {
        Fixture f = new Fixture(); byte[] profileBytes = f.profile.getBytes(StandardCharsets.UTF_8);
        f.profileBodyOverride = profileBytes;
        f.run();
        assertEquals(Collections.singletonList("/v1/citysport/profile"), f.providerPaths);
        assertEquals(Collections.singletonList(PROVIDER_TOKEN), f.providerTokens);
        assertEquals(Arrays.asList("GET /routing-plan", "POST /profile/provider-read-jobs", "POST /auth/viva/access",
            "POST /profile/provider-read-jobs/" + JOB + "/results/" + COMMAND,
            "POST /profile/provider-read-jobs/" + JOB + "/complete"), paths(f.api));
        for (Request request : f.api) {
            assertEquals("android", request.headers.get("x-app-platform")); assertEquals("test-version", request.headers.get("x-app-version"));
            assertEquals("73", request.headers.get("x-app-build")); assertTrue(request.headers.get("x-correlation-id").matches("[0-9a-f-]{36}"));
            if (!"GET".equals(request.method)) assertTrue(request.headers.get("idempotency-key").matches("[0-9a-f-]{36}"));
        }
        assertEquals("{}", new String(f.api.get(1).body, StandardCharsets.UTF_8));
        Request submitted = f.api.get(3);
        String relay = new String(submitted.body, StandardCharsets.UTF_8);
        JSONObject payloadJson = new JSONObject(relay);
        assertEquals(1, payloadJson.length());
        JSONObject payload = payloadJson.getJSONObject("payload");
        assertEquals(PROVIDER_ID, payload.getString("id")); assertEquals(150000, payload.getInt("deposit"));
        assertTrue(submitted.body.length <= AndroidProfileRefresh.RELAY_LIMIT);
        assertFalse(relay.contains(PROVIDER_TOKEN));
        assertEquals("{}", new String(f.api.get(4).body, StandardCharsets.UTF_8));
        assertZeroed(profileBytes); // The provider buffer is wiped after the relay.
        assertSame(f.store.value, f.store.read());
        f.engine.nativeAccess();
        assertEquals(1, f.metrics.size());
        JSONObject metric = new JSONObject(new String(f.metrics.get(0).body, StandardCharsets.UTF_8));
        assertEquals("profile.read", metric.getString("operation")); assertEquals("SUCCESS", metric.getString("outcome"));
        assertEquals("73", metric.getString("routingRevision")); assertEquals("2xx", metric.getString("statusClass"));
        String metricText = new String(f.metrics.get(0).body, StandardCharsets.UTF_8);
        assertFalse(metricText.contains(PROVIDER_TOKEN)); assertFalse(metricText.contains(PROVIDER_ID));
    }

    @Test public void malformedPlanAndForeignDestinationAreRejectedBeforeJobOrProvider() throws Exception {
        List<String> badPlans = Arrays.asList(
            "{}",
            plan(1_790_531_060_000L).replace("MIXED_END_USER_READS", "PADLHUB_ONLY"),
            plan(1_790_531_060_000L).replace("https://api.vivacrm.ru/end-user/api", "https://evil.invalid"),
            plan(1_790_531_060_000L).replace("/auth/viva/access", "/auth/viva/other"),
            plan(1_790_531_060_000L).replace("[\"Authorization\"]", "[\"Authorization\",\"X-Leak\"]"),
            plan(1_790_531_060_000L).replace("\"citysport\"", "\"citysport/../evil\""),
            plan(1_790_531_060_000L).replace("\"operation\":\"profile.read\",\"transport\":\"DIRECT_VIVA\"", "\"operation\":\"profile.read\",\"transport\":\"PADLHUB_API\""),
            plan(1_790_531_060_000L).replace("\"operation\":\"profile.read\",\"transport\":\"DIRECT_VIVA\"", "\"operation\":\"bookings.read\",\"transport\":\"DIRECT_VIVA\""));
        for (String bad : badPlans) {
            Fixture f = new Fixture(); f.plan = bad; f.fails("NATIVE_PROFILE_PLAN_REJECTED");
            assertEquals(0, f.providerCalls); assertEquals(0, countPath(f.api, "/profile/provider-read-jobs"));
            assertEquals(0, countPath(f.api, "/auth/viva/access")); assertEquals(0, countPath(f.api, "/results/"));
        }
        Fixture malformedDate = new Fixture();
        malformedDate.responseDates.put(ROOT + "/routing-plan", "2026-10-12T00:00:00Z");
        malformedDate.fails("NATIVE_PROFILE_PLAN_REJECTED");
        assertEquals(0, countPath(malformedDate.api, "/profile/provider-read-jobs"));
    }

    @Test public void jobDiagnosticsClassifyTransportMediaJsonContractIdAndExpiryBeforeDelegation() throws Exception {
        Fixture transportFailure = new Fixture(); transportFailure.jobFailure = "NATIVE_RESPONSE_REJECTED";
        rejectsJobBeforeDelegate(transportFailure, "NATIVE_PROFILE_JOB_TRANSPORT_REJECTED");
        Fixture oversized = new Fixture(); oversized.jobBodyOverride = new byte[AndroidProfileRefresh.API_LIMIT + 1];
        rejectsJobBeforeDelegate(oversized, "NATIVE_PROFILE_JOB_TRANSPORT_REJECTED");
        Fixture media = new Fixture(); media.jobContentType = "text/plain";
        rejectsJobBeforeDelegate(media, "NATIVE_PROFILE_JOB_MEDIA_REJECTED");
        Fixture nullBody = new Fixture(); nullBody.nullJobBody = true;
        rejectsJobBeforeDelegate(nullBody, "NATIVE_PROFILE_JOB_TRANSPORT_REJECTED");
        Fixture empty = new Fixture(); empty.jobBodyOverride = new byte[0];
        rejectsJobBeforeDelegate(empty, "NATIVE_PROFILE_JOB_JSON_REJECTED");
        Fixture invalidUtf8 = new Fixture(); invalidUtf8.jobBodyOverride = new byte[] {(byte) 0xc3, (byte) 0x28};
        rejectsJobBeforeDelegate(invalidUtf8, "NATIVE_PROFILE_JOB_JSON_REJECTED");
        Fixture invalidJson = new Fixture(); invalidJson.jobBodyOverride = "{\"private-marker\":".getBytes(StandardCharsets.UTF_8);
        rejectsJobBeforeDelegate(invalidJson, "NATIVE_PROFILE_JOB_JSON_REJECTED");
        for (String root : Arrays.asList("[]", "null", "true", "42", "\"private-marker\"")) {
            Fixture wrongRoot = new Fixture(); wrongRoot.jobBodyOverride = root.getBytes(StandardCharsets.UTF_8);
            rejectsJobBeforeDelegate(wrongRoot, "NATIVE_PROFILE_JOB_CONTRACT_REJECTED");
        }
        Fixture identifier = new Fixture(); identifier.job = identifier.job.replace(JOB, "not-a-padlhub-uuid");
        rejectsJobBeforeDelegate(identifier, "NATIVE_PROFILE_JOB_ID_REJECTED");
        Fixture command = new Fixture(); command.job = command.job.replace(COMMAND, "not-a-command");
        rejectsJobBeforeDelegate(command, "NATIVE_PROFILE_JOB_ID_REJECTED");
        Fixture expiry = new Fixture(); expiry.job = expiry.job.replace(iso(expiry.serverWall + 60_000), "tomorrow");
        rejectsJobBeforeDelegate(expiry, "NATIVE_PROFILE_JOB_EXPIRY_REJECTED");
        Fixture wrongOperation = new Fixture(); wrongOperation.job = wrongOperation.job.replace("}", ",\"operation\":\"bookings.read\"}");
        rejectsJobBeforeDelegate(wrongOperation, "NATIVE_PROFILE_JOB_CONTRACT_REJECTED");
        Fixture matchingOperation = new Fixture(); matchingOperation.job = matchingOperation.job.replace("}", ",\"operation\":\"profile.read\"}");
        matchingOperation.run(); assertEquals(1, matchingOperation.providerCalls);

        String marker = "job-secret-marker";
        Fixture contract = new Fixture(); contract.job = "{\"jobId\":\"" + JOB + "\",\"commandId\":\"" + COMMAND + "\",\"expiresAt\":\"tomorrow\",\"marker\":\"" + marker + "\"}";
        try { contract.run(); fail(); } catch (Failure error) {
            assertEquals("NATIVE_PROFILE_JOB_EXPIRY_REJECTED", error.code);
            assertFalse(error.getMessage().contains(marker)); assertNull(error.getCause());
        }
        assertEquals(0, contract.providerCalls);
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
        unauthorized.responseDates.put(ROOT + "/profile/provider-read-jobs", "private-invalid-date");
        rejectsJobBeforeDelegate(unauthorized, "AUTH_SESSION_REVOKED");
        try { unauthorized.engine.nativeAccess(); fail(); }
        catch (Failure error) { assertEquals("AUTH_SESSION_REVOKED", error.code); }
    }

    @Test public void serverAnchoredJobExpiryAcceptsSkewButFailsClosedBeforeDelegationOrProvider() throws Exception {
        for (long skew : new long[] {-300_000, 300_000}) {
            Fixture f = new Fixture(); f.clock.wall = f.serverWall + skew;
            f.plan = plan(f.serverWall + 300_000); f.job = job(isoMillis(f.serverWall + 120_000));
            f.delayedPath = "/profile/provider-read-jobs"; f.elapsedBeforeResponse = 400;
            f.run(); assertEquals(1, f.providerCalls); assertEquals(1, countPath(f.api, "/results/"));
        }
        long[] expiryOffsets = {-1, 121_000};
        String[] expiryCodes = {"NATIVE_PROFILE_JOB_EXPIRED_REJECTED", "NATIVE_PROFILE_JOB_LIFETIME_REJECTED"};
        for (int i = 0; i < expiryOffsets.length; i++) {
            Fixture f = new Fixture(); f.plan = plan(f.serverWall + 300_000);
            f.job = job(isoMillis(f.serverWall + expiryOffsets[i]));
            f.fails(expiryCodes[i]);
            assertEquals(0, countPath(f.api, "/auth/viva/access")); assertEquals(0, f.providerCalls);
        }
        Fixture malformedDate = new Fixture();
        malformedDate.responseDates.put(ROOT + "/profile/provider-read-jobs", "Tue, 99 Not-a-month 2026 00:00:00 GMT");
        malformedDate.fails("NATIVE_PROFILE_JOB_DATE_REJECTED");
        assertEquals(0, countPath(malformedDate.api, "/auth/viva/access")); assertEquals(0, malformedDate.providerCalls);
        Fixture missingDate = new Fixture(); missingDate.clock.wall = missingDate.serverWall + 300_000;
        missingDate.plan = plan(missingDate.serverWall + 600_000);
        missingDate.job = job(isoMillis(missingDate.serverWall + 120_000));
        missingDate.defaultServerDate = false;
        missingDate.responseDates.put(ROOT + "/routing-plan", httpDate(missingDate.serverWall));
        missingDate.responseDates.put(ROOT + "/profile/provider-read-jobs", null);
        missingDate.fails("NATIVE_PROFILE_JOB_EXPIRED_REJECTED");
        assertEquals(0, countPath(missingDate.api, "/auth/viva/access")); assertEquals(0, missingDate.providerCalls);
    }

    @Test public void opaqueDelegationAcceptsOnlyBoundedBearerValuesAndNeverLeaksThem() throws Exception {
        String marker = "provider-secret-marker";
        for (String token : Arrays.asList("", "opaque token", "opaque\r\n" + marker, repeats("x", 8193).replace(",", ""))) {
            Fixture f = new Fixture(); f.delegation = "{\"accessToken\":\"" + token + "\",\"expiresAt\":\"" + iso(f.clock.wall + 60_000) + "\"}";
            try { f.run(); fail(); } catch (Failure error) {
                assertEquals("NATIVE_PROFILE_DELEGATION_TOKEN_REJECTED", error.code);
                assertFalse(error.getMessage().contains(marker)); assertNull(error.getCause());
            }
            assertEquals(0, f.providerCalls); assertEquals(0, countPath(f.api, "/results/"));
        }
        Fixture expired = new Fixture(); expired.delegation = delegation(PROVIDER_TOKEN, iso(expired.clock.wall));
        expired.fails("NATIVE_PROFILE_DELEGATION_EXPIRED_REJECTED"); assertEquals(0, expired.providerCalls);
    }

    @Test public void delegationDiagnosticsCloseBeforeProviderAndWipeRejectedBytes() throws Exception {
        Fixture transport = new Fixture(); transport.delegationFailure = "NATIVE_RESPONSE_REJECTED";
        rejectsDelegationBeforeProvider(transport, "NATIVE_PROFILE_DELEGATION_TRANSPORT_REJECTED");
        Fixture oversized = new Fixture(); oversized.delegationBodyOverride = new byte[AndroidProfileRefresh.API_LIMIT + 1];
        Arrays.fill(oversized.delegationBodyOverride, (byte) 0x5a);
        rejectsDelegationBeforeProvider(oversized, "NATIVE_PROFILE_DELEGATION_TRANSPORT_REJECTED");
        assertZeroed(oversized.delegationBodyOverride);
        Fixture absent = new Fixture(); absent.nullDelegationBody = true;
        rejectsDelegationBeforeProvider(absent, "NATIVE_PROFILE_DELEGATION_TRANSPORT_REJECTED");
        Fixture empty = new Fixture(); empty.delegationBodyOverride = new byte[0];
        rejectsDelegationBeforeProvider(empty, "NATIVE_PROFILE_DELEGATION_JSON_REJECTED");
        Fixture utf8 = new Fixture(); utf8.delegationBodyOverride = new byte[] {(byte) 0xc3, (byte) 0x28};
        rejectsDelegationBeforeProvider(utf8, "NATIVE_PROFILE_DELEGATION_JSON_REJECTED"); assertZeroed(utf8.delegationBodyOverride);
        Fixture media = new Fixture(); byte[] mediaBytes = delegation(PROVIDER_TOKEN, iso(media.clock.wall + 60_000)).getBytes(StandardCharsets.UTF_8);
        media.delegationBodyOverride = mediaBytes; media.delegationContentType = "text/plain";
        rejectsDelegationBeforeProvider(media, "NATIVE_PROFILE_DELEGATION_MEDIA_REJECTED"); assertZeroed(mediaBytes);
        Fixture malformed = new Fixture(); byte[] malformedBytes = "{\"private-delegation\":".getBytes(StandardCharsets.UTF_8);
        malformed.delegationBodyOverride = malformedBytes;
        rejectsDelegationBeforeProvider(malformed, "NATIVE_PROFILE_DELEGATION_JSON_REJECTED"); assertZeroed(malformedBytes);
        for (String body : Arrays.asList("[]", "null", "true", "42", "\"private-marker\"")) {
            Fixture root = new Fixture(); root.delegationBodyOverride = body.getBytes(StandardCharsets.UTF_8);
            rejectsDelegationBeforeProvider(root, "NATIVE_PROFILE_DELEGATION_CONTRACT_REJECTED"); assertZeroed(root.delegationBodyOverride);
        }
        Fixture expiry = new Fixture(); expiry.delegation = delegation(PROVIDER_TOKEN, "not-an-iso-date");
        rejectsDelegationBeforeProvider(expiry, "NATIVE_PROFILE_DELEGATION_EXPIRY_REJECTED");
        Fixture malformedDate = new Fixture(); malformedDate.responseDates.put(ROOT + "/auth/viva/access", "bad-date");
        rejectsDelegationBeforeProvider(malformedDate, "NATIVE_PROFILE_DELEGATION_DATE_REJECTED");
        Fixture negativeTransit = new Fixture(); negativeTransit.delegationHook = () -> negativeTransit.clock.elapsed--;
        rejectsDelegationBeforeProvider(negativeTransit, "NATIVE_PROFILE_DELEGATION_TIMING_REJECTED");
        Fixture slowTransit = new Fixture(); slowTransit.delegationHook = () -> slowTransit.clock.elapsed += 60_001;
        rejectsDelegationBeforeProvider(slowTransit, "NATIVE_PROFILE_DELEGATION_TIMING_REJECTED");
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

    @Test public void provider401ReissuesOneDelegationAndReplaysTheSameReadOnlyGet() throws Exception {
        Fixture f = new Fixture(); final int[] calls = {0};
        AndroidProfileRefresh.ProviderSender provider = (path, token) -> {
            f.providerPaths.add(path); f.providerTokens.add(token); calls[0]++;
            if (calls[0] == 1) return json(401, "{}");
            return json(200, PROFILE);
        };
        new AndroidProfileRefresh(f.policy, f.engine, f::send, provider, f.clock).run(f.engine.nativeAccess(), () -> {});
        assertEquals(2, calls[0]); assertEquals(f.providerPaths.get(0), f.providerPaths.get(1));
        assertEquals(2, countPath(f.api, "/auth/viva/access")); assertEquals(1, countPath(f.api, "/results/"));
    }

    @Test public void providerFailuresRedirectsOversizedAndNonJsonNeverSubmitAResult() throws Exception {
        for (int status : new int[] {403, 429, 500}) {
            Fixture f = new Fixture(); f.providerStatus = status; f.fails("NATIVE_REFRESH_UNAVAILABLE");
            assertEquals(1, f.providerCalls);
            assertEquals(0, countPath(f.api, "/results/")); assertEquals(0, countPath(f.api, "/complete"));
            assertEquals("UNAVAILABLE", new JSONObject(new String(f.metrics.get(f.metrics.size() - 1).body, StandardCharsets.UTF_8)).getString("outcome"));
        }
        Fixture redirect = new Fixture(); redirect.providerStatus = 302; redirect.fails("NATIVE_REDIRECT_REJECTED");
        assertEquals(0, countPath(redirect.api, "/results/"));
        Fixture oversized = new Fixture(); oversized.profileBodyOverride = new byte[AndroidProfileRefresh.PROVIDER_LIMIT + 1];
        Arrays.fill(oversized.profileBodyOverride, (byte) 0x7b);
        oversized.fails("NATIVE_PROFILE_READ_REJECTED");
        assertZeroed(oversized.profileBodyOverride); assertEquals(0, countPath(oversized.api, "/results/"));
        for (String body : Arrays.asList("[1,2]", "\"private-profile\"", "42", "{\"private\":", "")) {
            Fixture f = new Fixture(); f.profileBodyOverride = body.getBytes(StandardCharsets.UTF_8);
            f.fails("NATIVE_PROFILE_READ_REJECTED"); assertEquals(0, countPath(f.api, "/results/"));
        }
        Fixture media = new Fixture(); media.providerContentType = "text/plain"; media.fails("NATIVE_PROFILE_READ_REJECTED");
        assertEquals(0, countPath(media.api, "/complete"));
        Fixture missingContentType = new Fixture();
        missingContentType.providerContentType = null; missingContentType.fails("NATIVE_PROFILE_READ_REJECTED");
    }

    @Test public void oversizedRelayNeverReachesTheServer() throws Exception {
        Fixture f = new Fixture(); f.profileBodyOverride = paddedProfile(AndroidProfileRefresh.PROVIDER_LIMIT);
        f.fails("NATIVE_PROFILE_RESULT_REJECTED");
        assertEquals(1, f.providerCalls); assertEquals(0, countPath(f.api, "/results/")); assertEquals(0, countPath(f.api, "/complete"));
    }

    @Test public void rejectedResultDoesNotCompleteAndApi401RetiresNativeAuthorization() throws Exception {
        Fixture rejected = new Fixture(); rejected.result = "{\"accepted\":false,\"replayed\":false,\"observedAt\":\"" + iso(rejected.clock.wall) + "\"}";
        rejected.fails("NATIVE_PROFILE_RESULT_REJECTED"); assertEquals(0, countPath(rejected.api, "/complete"));
        Fixture replayFlag = new Fixture(); replayFlag.result = "{\"accepted\":true,\"observedAt\":\"" + iso(replayFlag.clock.wall) + "\"}";
        replayFlag.fails("NATIVE_PROFILE_RESULT_REJECTED"); assertEquals(0, countPath(replayFlag.api, "/complete"));
        Fixture missingObserved = new Fixture(); missingObserved.result = "{\"accepted\":true,\"replayed\":false}";
        missingObserved.fails("NATIVE_PROFILE_RESULT_REJECTED"); assertEquals(0, countPath(missingObserved.api, "/complete"));
        Fixture invalidObserved = new Fixture(); invalidObserved.result = "{\"accepted\":true,\"replayed\":false,\"observedAt\":\"now\"}";
        invalidObserved.fails("NATIVE_PROFILE_RESULT_REJECTED"); assertEquals(0, countPath(invalidObserved.api, "/complete"));
        Fixture wrongState = new Fixture(); wrongState.complete = "{\"state\":\"READY\",\"observedAt\":\"" + iso(wrongState.clock.wall) + "\"}";
        wrongState.fails("NATIVE_PROFILE_COMPLETION_REJECTED");
        Fixture missingCompletionObserved = new Fixture(); missingCompletionObserved.complete = "{\"state\":\"refreshed\"}";
        missingCompletionObserved.fails("NATIVE_PROFILE_COMPLETION_REJECTED");
        Fixture revoked = new Fixture(); revoked.failPath = "result";
        AndroidSessionEngine.Sender sender = request -> request.path.contains("/results/") ? json(401, "{}") : revoked.send(request);
        try { new AndroidProfileRefresh(revoked.policy, revoked.engine, sender, revoked::provider, revoked.clock).run(revoked.engine.nativeAccess(), () -> {}); fail(); }
        catch (Failure error) { assertEquals("AUTH_SESSION_REVOKED", error.code); }
        try { revoked.engine.nativeAccess(); fail(); } catch (Failure error) { assertEquals("AUTH_SESSION_REVOKED", error.code); }
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
            assertArrayEquals(one.body, two.body); assertEquals(1, countExactPath(f.api, "/profile/provider-read-jobs"));
        }
    }

    @Test public void cancellationAndLogoutStopBeforeAnyLaterWrite() throws Exception {
        Fixture cancelled = new Fixture(); final boolean[] stop = {false}; cancelled.delegationHook = () -> stop[0] = true;
        try { cancelled.run(() -> { if (stop[0]) throw new Failure("NATIVE_OPERATION_CANCELLED"); }); fail(); }
        catch (Failure error) { assertEquals("NATIVE_OPERATION_CANCELLED", error.code); }
        assertEquals(0, cancelled.providerCalls); assertEquals(0, countPath(cancelled.api, "/results/"));

        Fixture logout = new Fixture(); byte[] delegationBytes = delegation(PROVIDER_TOKEN, iso(logout.clock.wall + 60_000)).getBytes(StandardCharsets.UTF_8);
        logout.delegationBodyOverride = delegationBytes;
        logout.delegationHook = () -> { try { logout.engine.prepareLogout(NEXT_KEY); } catch (Failure error) { throw new RuntimeException(error); } };
        logout.fails("NATIVE_OPERATION_CANCELLED"); assertZeroed(delegationBytes); assertEquals(0, logout.providerCalls);

        Fixture afterProfile = new Fixture();
        afterProfile.providerHook = () -> { if (afterProfile.providerCalls == 1) afterProfile.clock.elapsed += 121_000; };
        afterProfile.fails("NATIVE_OPERATION_CANCELLED");
        assertEquals(1, afterProfile.providerCalls); assertEquals(0, countPath(afterProfile.api, "/results/"));

        Fixture providerNetwork = new Fixture(); providerNetwork.throwPath = "provider"; providerNetwork.fails("NATIVE_NETWORK_UNAVAILABLE");
        assertEquals(0, countPath(providerNetwork.api, "/results/")); assertEquals(0, countPath(providerNetwork.api, "/complete"));
    }

    @Test public void circuitBlocksImmediateRetryAndMetricsStayClosedWithoutAffectingSuccess() throws Exception {
        Fixture f = new Fixture(); f.providerStatus = 500; f.fails("NATIVE_REFRESH_UNAVAILABLE");
        int providerCalls = f.providerCalls, jobs = countExactPath(f.api, "/profile/provider-read-jobs");
        f.providerStatus = 200; f.fails("NATIVE_REFRESH_UNAVAILABLE");
        assertEquals(providerCalls, f.providerCalls); assertEquals(jobs, countExactPath(f.api, "/profile/provider-read-jobs"));
        JSONObject open = new JSONObject(new String(f.metrics.get(f.metrics.size() - 1).body, StandardCharsets.UTF_8));
        assertEquals("CIRCUIT_OPEN", open.getString("outcome")); assertEquals("profile.read", open.getString("operation"));
        f.clock.advance(1_001); f.run(); assertEquals(2, f.providerCalls); assertEquals(1, countPath(f.api, "/complete"));
        for (Request metric : f.metrics) {
            String text = new String(metric.body, StandardCharsets.UTF_8);
            JSONObject data = new JSONObject(text);
            assertTrue(data.length() == 4 || data.length() == 5); assertEquals("73", data.getString("routingRevision"));
            assertFalse(text.contains(PROVIDER_TOKEN)); assertFalse(text.contains(PROVIDER_ID));
        }
        Fixture brokenMetric = new Fixture();
        AndroidSessionEngine.Sender sender = request -> request.path.endsWith("/routing-outcomes") ? json(401, "secret-error-body") : brokenMetric.send(request);
        new AndroidProfileRefresh(brokenMetric.policy, brokenMetric.engine, sender, brokenMetric::provider, brokenMetric.clock).run(brokenMetric.engine.nativeAccess(), () -> {});
        assertEquals(1, countPath(brokenMetric.api, "/complete")); brokenMetric.engine.nativeAccess();
    }

    @Test public void telemetryRunsOnlyAfterObservationCompletionWithoutRetiringTheLease() throws Exception {
        Fixture f = new Fixture();
        AndroidSessionEngine.Sender sender = request -> {
            if (request.path.endsWith("/routing-outcomes")) {
                assertEquals(1, countPath(f.api, "/complete"));
                f.clock.elapsed += 121_000; return json(500, "private-ignored-error");
            }
            return f.send(request);
        };
        new AndroidProfileRefresh(f.policy, f.engine, sender, f::provider, f.clock).run(f.engine.nativeAccess(), () -> {});
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
