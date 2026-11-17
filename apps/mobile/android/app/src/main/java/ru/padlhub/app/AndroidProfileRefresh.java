package ru.padlhub.app;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.CookieHandler;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import static ru.padlhub.app.AndroidSessionPolicy.Failure;
import static ru.padlhub.app.AndroidSessionEngine.Response;

/**
 * One fixed, owner-approved device transport for the authenticated profile.read job.
 * The server chooses the routing plan, job, expiry and tenant; native code performs
 * only the reviewed GET and relays its bounded result back. No provider bytes, ids
 * or credentials cross the native bridge.
 */
final class AndroidProfileRefresh {
    static final int PROVIDER_LIMIT = 64 * 1024;
    static final int RELAY_LIMIT = 64 * 1024;
    static final int API_LIMIT = 64 * 1024;
    static final String PROVIDER_BASE = "https://api.vivacrm.ru/end-user/api";
    interface Cancellation { void require() throws Failure; }
    interface ProviderSender { Response get(String path, String token) throws Failure; }

    private final AndroidSessionPolicy policy;
    private final AndroidSessionEngine engine;
    private final AndroidSessionEngine.Sender api;
    private final ProviderSender provider;
    private final AndroidSessionEngine.Clock clock;
    private final Circuits circuits;
    private final Executor metrics;

    /** One session-bound, memory-only circuit; monotonic time prevents wall-clock rollback. */
    static final class Circuits {
        private long generation = Long.MIN_VALUE;
        private int failures;
        private long retryAt;
        void bind(long next) {
            if (next != generation) { generation = next; failures = 0; retryAt = 0; }
        }
        boolean open(long now) { return retryAt > now; }
        void success() { failures = 0; retryAt = 0; }
        void failure(long now) {
            failures = Math.min(5, failures + 1);
            retryAt = now + Math.min(30_000, 1_000L << (failures - 1));
        }
    }

    AndroidProfileRefresh(AndroidSessionPolicy policy, AndroidSessionEngine engine,
        AndroidSessionEngine.Sender api, Circuits circuits, Executor metrics) {
        this(policy, engine, api, new FixedProviderSender(), new AndroidSessionEngine.Clock() {
            public long wall() { return System.currentTimeMillis(); }
            public long elapsed() { return android.os.SystemClock.elapsedRealtime(); }
        }, circuits, metrics);
    }
    /** Package-private fake transport/clock seam; production cannot choose an origin or method. */
    AndroidProfileRefresh(AndroidSessionPolicy policy, AndroidSessionEngine engine,
        AndroidSessionEngine.Sender api, ProviderSender provider, AndroidSessionEngine.Clock clock) {
        this(policy, engine, api, provider, clock, new Circuits(), Runnable::run);
    }
    AndroidProfileRefresh(AndroidSessionPolicy policy, AndroidSessionEngine engine,
        AndroidSessionEngine.Sender api, ProviderSender provider, AndroidSessionEngine.Clock clock, Circuits circuits) {
        this(policy, engine, api, provider, clock, circuits, Runnable::run);
    }
    AndroidProfileRefresh(AndroidSessionPolicy policy, AndroidSessionEngine engine,
        AndroidSessionEngine.Sender api, ProviderSender provider, AndroidSessionEngine.Clock clock, Circuits circuits, Executor metrics) {
        this.policy = policy; this.engine = engine; this.api = api; this.provider = provider; this.clock = clock; this.circuits = circuits; this.metrics = metrics;
    }

    private static final class Outcome {
        final String operation, outcome; final int status; final long duration;
        Outcome(String operation, String outcome, int status, long duration) {
            this.operation = operation; this.outcome = outcome; this.status = status; this.duration = duration;
        }
    }
    private static final class ApiReply {
        final byte[] body;
        final String date;
        final long started;
        ApiReply(Response response, long started) {
            this.body = response.body; this.date = response.headers.get("date"); this.started = started;
        }
    }
    private final class Invocation {
        final AndroidSessionEngine.NativeAccess access;
        final Cancellation cancellation;
        final List<Outcome> outcomes = new ArrayList<>();
        long deadline = Long.MAX_VALUE;
        boolean tokenRefreshed;
        String token;
        long tokenDeadline;
        String tenant, revision;
        String stage = "PLAN";
        Invocation(AndroidSessionEngine.NativeAccess access, Cancellation cancellation) {
            this.access = access; this.cancellation = cancellation;
        }
        void require() throws Failure {
            cancellation.require(); engine.requireNativeAccess(access); cancellation.require();
            if (Thread.currentThread().isInterrupted() || clock.elapsed() >= deadline)
                throw new Failure("NATIVE_OPERATION_CANCELLED");
        }
        long expiryDeadline(ApiReply reply, long expiresAt, long maximumLifetime) throws Failure {
            long reference;
            try { reference = reply.date == null ? clock.wall() : httpDate(reply.date); }
            catch (Failure error) { throw expiryRejected("DATE"); }
            long now = clock.elapsed();
            long remaining = expiresAt - reference;
            if (reply.date != null) {
                // HTTP Date has second precision. Include the whole request transit and
                // parsing/scheduling delay in an upper bound on server now, so phone clock
                // skew cannot reject a valid job or extend an expired job.
                long transit = now - reply.started;
                if (remaining <= 0) throw expiryRejected("EXPIRED");
                if (remaining > maximumLifetime + 999 || transit < 0 || transit > 60_000) throw expiryRejected("LIFETIME");
                remaining -= 1_000 + transit;
            }
            // Missing Date preserves the original strict wall-clock path, never a bypass.
            if (remaining <= 0) throw expiryRejected("EXPIRED");
            if (remaining > maximumLifetime || now < 0 || now > Long.MAX_VALUE - remaining) throw expiryRejected("LIFETIME");
            return now + remaining;
        }
        Failure expiryRejected(String reason) {
            return "JOB".equals(stage) ? jobRejected(reason) : rejected();
        }
        void restrict(ApiReply reply, long expiresAt, long maximumLifetime) throws Failure {
            deadline = Math.min(deadline, expiryDeadline(reply, expiresAt, maximumLifetime));
        }
        long delegationDeadline(ApiReply reply, long expiresAt) throws Failure {
            long reference;
            try { reference = reply.date == null ? clock.wall() : httpDate(reply.date); }
            catch (Failure error) { throw delegationRejected("DATE"); }
            long now = clock.elapsed(), remaining, budget;
            try { remaining = Math.subtractExact(expiresAt, reference); budget = Math.subtractExact(deadline, now); }
            catch (ArithmeticException ignored) { throw delegationRejected("TIMING"); }
            if (now < 0 || deadline == Long.MAX_VALUE) throw delegationRejected("TIMING");
            if (remaining <= 0) throw delegationRejected("EXPIRED");
            if (reply.date != null) {
                long transit;
                try { transit = Math.subtractExact(now, reply.started); }
                catch (ArithmeticException ignored) { throw delegationRejected("TIMING"); }
                if (transit < 0 || transit > 60_000) throw delegationRejected("TIMING");
                remaining -= 1_000 + transit;
            }
            if (remaining <= 0) throw delegationRejected("EXPIRED");
            if (budget <= 0) { require(); throw delegationRejected("TIMING"); }
            // The API does not cap provider token TTL. Bound its local use to the
            // already validated plan/job deadline before adding, without extending it.
            long usable = Math.min(remaining, budget);
            if (now > Long.MAX_VALUE - usable) throw delegationRejected("TIMING");
            return now + usable;
        }
        void forget() { token = null; tenant = null; revision = null; }
    }

    void run(AndroidSessionEngine.NativeAccess access, Cancellation cancellation) throws Failure {
        Invocation current = new Invocation(access, cancellation);
        byte[] profile = null;
        try {
            current.require();
            ApiReply planReply = api("/routing-plan", "GET", null, null, false, current);
            JSONObject plan = object(planReply.body, API_LIMIT);
            current.restrict(planReply, timestamp(plan.optString("expiresAt", "")), 3_600_000);
            current.tenant = providerTenant(plan);
            current.revision = plan.getString("revision");
            if (!current.revision.matches("[0-9]{1,128}")) throw rejected();
            circuits.bind(access.generation);
            if (circuits.open(clock.elapsed())) {
                current.outcomes.add(new Outcome("profile.read", "CIRCUIT_OPEN", 0, 0));
                throw new Failure("NATIVE_REFRESH_UNAVAILABLE");
            }
            current.stage = "JOB";
            ApiReply jobReply = api("/profile/provider-read-jobs", "POST", "{}",
                UUID.randomUUID().toString(), false, current);
            Object decodedJob;
            try { decodedJob = parsedJson(jobReply.body, API_LIMIT); }
            catch (Failure error) { throw jobRejected("JSON"); }
            if (!(decodedJob instanceof JSONObject)) throw jobRejected("CONTRACT");
            Job job = job((JSONObject) decodedJob);
            current.restrict(jobReply, job.expiresAt, 120_000);
            delegate(current);
            current.stage = "PROFILE";
            profile = providerRead("/v1/" + current.tenant + "/profile", current);
            current.stage = "RESULT";
            String relay = relay(profile);
            JSONObject accepted = object(api("/profile/provider-read-jobs/" + job.jobId + "/results/" + job.commandId,
                "POST", relay, UUID.randomUUID().toString(), true, current).body, API_LIMIT);
            if (!Boolean.TRUE.equals(accepted.opt("accepted")) || !(accepted.opt("replayed") instanceof Boolean)) throw rejected();
            timestamp(accepted.optString("observedAt", ""));
            current.stage = "COMPLETION";
            byte[] completedBytes = api("/profile/provider-read-jobs/" + job.jobId + "/complete", "POST", "{}",
                UUID.randomUUID().toString(), true, current).body;
            try {
                JSONObject completed = object(completedBytes, API_LIMIT);
                if (!"refreshed".equals(completed.opt("state"))) throw rejected();
                timestamp(completed.optString("observedAt", ""));
            } finally { wipe(completedBytes); }
            current.require();
            emitMetrics(current); // Observation is committed before metrics can be scheduled.
        } catch (Failure error) { emitMetrics(current); throw "NATIVE_RESPONSE_REJECTED".equals(error.code) ? stageRejected(current.stage) : error; }
        catch (Exception ignored) { emitMetrics(current); throw stageRejected(current.stage); }
        finally { wipe(profile); current.forget(); }
    }

    private ApiReply api(String suffix, String method, String body, String key, boolean exactReplay, Invocation current) throws Failure {
        current.require();
        Map<String, String> headers = new HashMap<>();
        headers.put("authorization", current.access.bearer);
        headers.put("accept", "application/json");
        headers.put("x-app-platform", "android"); headers.put("x-app-version", policy.version); headers.put("x-app-build", policy.build);
        headers.put("x-correlation-id", UUID.randomUUID().toString());
        if (key != null) headers.put("idempotency-key", key);
        if (body != null) headers.put("content-type", "application/json");
        AndroidSessionPolicy.Request request = new AndroidSessionPolicy.Request(policy.userRoot + suffix, method, headers, body, AndroidSessionPolicy.Operation.API);
        if (request.body != null && request.body.length > RELAY_LIMIT) throw rejected();
        Response response = null;
        boolean returned = false;
        long started = clock.elapsed();
        try {
            try { response = api.send(request); }
            catch (Failure first) {
                // Only result/complete have exact job-result replay semantics. Never create another job.
                if (!exactReplay || !"NATIVE_NETWORK_UNAVAILABLE".equals(first.code)) throw first;
                current.require(); response = api.send(request);
            }
            current.require();
            if (response.status == 401) {
                engine.rejectNativeAccess(current.access);
                throw new Failure("AUTH_SESSION_REVOKED");
            }
            if (response.status >= 300 && response.status < 400) throw new Failure("NATIVE_REDIRECT_REJECTED");
            if (response.status < 200 || response.status >= 300) throw new Failure("NATIVE_REFRESH_UNAVAILABLE");
            if (response.body == null || response.body.length > API_LIMIT)
                throw responseRejected(current.stage, "TRANSPORT");
            if (!jsonContent(response.headers)) throw responseRejected(current.stage, "MEDIA");
            ApiReply reply = new ApiReply(response, started); returned = true; return reply;
        } catch (Failure error) {
            if ("NATIVE_NETWORK_UNAVAILABLE".equals(error.code)) throw new Failure("NATIVE_REFRESH_UNAVAILABLE");
            if ("NATIVE_RESPONSE_REJECTED".equals(error.code)) throw responseRejected(current.stage, "TRANSPORT");
            throw error;
        } finally { wipe(request.body); if (!returned && response != null) wipe(response.body); }
    }

    private void delegate(Invocation current) throws Failure {
        String previousStage = current.stage; current.stage = "DELEGATION";
        ApiReply reply = api("/auth/viva/access", "POST", "{}", UUID.randomUUID().toString(), false, current);
        byte[] bytes = reply.body;
        try {
            Object decoded;
            try { decoded = parsedJson(bytes, API_LIMIT); }
            catch (Failure error) { throw delegationRejected("JSON"); }
            if (!(decoded instanceof JSONObject)) throw delegationRejected("CONTRACT");
            JSONObject value = (JSONObject) decoded;
            Object rawToken = value.opt("accessToken");
            if (!(rawToken instanceof String)) throw delegationRejected("TOKEN");
            String token = (String) rawToken;
            // The authenticated PadlHub delegation contract returns an opaque provider credential.
            // RFC6750 header grammar/size only; JWT claims/tenant/subject are not client contracts.
            if (token.length() == 0 || token.length() > 8192 || !token.matches("[A-Za-z0-9._~+/-]+=*")) throw delegationRejected("TOKEN");
            long expiresAt;
            try { expiresAt = timestamp(value.optString("expiresAt", "")); }
            catch (Failure error) { throw delegationRejected("EXPIRY"); }
            long tokenDeadline = current.delegationDeadline(reply, expiresAt);
            current.require(); current.token = token; current.tokenDeadline = tokenDeadline; current.stage = previousStage;
        } catch (Failure error) { throw error; }
        catch (Exception ignored) { throw rejected(); }
        finally { wipe(bytes); }
    }

    private byte[] providerRead(String path, Invocation current) throws Failure {
        current.require();
        long started = clock.elapsed(); int status = 0; Response response = null;
        try {
            if (clock.elapsed() >= current.tokenDeadline) throw new Failure("NATIVE_REFRESH_UNAVAILABLE");
            response = provider.get(path, current.token); current.require(); status = response.status;
            if (status == 401) {
                if (current.tokenRefreshed) throw new Failure("NATIVE_REFRESH_UNAVAILABLE");
                current.tokenRefreshed = true; wipe(response.body); current.token = null;
                delegate(current); current.require();
                response = provider.get(path, current.token); current.require(); status = response.status;
            }
            if (status >= 300 && status < 400) throw new Failure("NATIVE_REDIRECT_REJECTED");
            if (status != 200) throw new Failure("NATIVE_REFRESH_UNAVAILABLE");
            if (response.body == null || response.body.length > PROVIDER_LIMIT || !jsonContent(response.headers)) throw profileRejected();
            if (!(json(response.body, PROVIDER_LIMIT) instanceof JSONObject)) throw profileRejected();
            circuits.success();
            current.outcomes.add(new Outcome("profile.read", "SUCCESS", status, clock.elapsed() - started));
            current.require();
            return response.body;
        } catch (Failure error) {
            if (response != null) wipe(response.body);
            // Cancellation/retired identity must cause no subsequent external write or metric.
            if (!"NATIVE_OPERATION_CANCELLED".equals(error.code) && !"AUTH_SESSION_REVOKED".equals(error.code)) {
                circuits.failure(clock.elapsed());
                current.outcomes.add(new Outcome("profile.read", status == 401 ? "REAUTH_REQUIRED"
                    : "NATIVE_RESPONSE_REJECTED".equals(error.code) || "NATIVE_PROFILE_READ_REJECTED".equals(error.code) ? "INVALID" : "UNAVAILABLE",
                    status, clock.elapsed() - started));
            }
            throw error;
        }
    }

    private static String relay(byte[] profile) throws Failure {
        JSONObject payload = object(profile, PROVIDER_LIMIT);
        final String relay;
        try { relay = new JSONObject().put("payload", payload).toString(); }
        catch (Exception ignored) { throw rejected(); }
        if (relay.getBytes(StandardCharsets.UTF_8).length > RELAY_LIMIT) throw rejected();
        return relay;
    }

    private void emitMetrics(Invocation current) {
        if (current.outcomes.isEmpty()) return;
        List<Outcome> outcomes = new ArrayList<>(current.outcomes); current.outcomes.clear();
        // This lease has no provider token/payload or job deadline. Logout still cancels it.
        Invocation telemetry = new Invocation(current.access, current.cancellation); telemetry.revision = current.revision;
        try {
            metrics.execute(() -> {
                try { for (Outcome outcome : outcomes) metric(telemetry, outcome.operation, outcome.outcome, outcome.status, outcome.duration); }
                finally { telemetry.forget(); }
            });
        } catch (java.util.concurrent.RejectedExecutionException ignored) { telemetry.forget(); }
    }

    /** Existing authenticated, redacted telemetry only; failure never retries or changes the observation/session. */
    private void metric(Invocation current, String operation, String outcome, int status, long duration) {
        AndroidSessionPolicy.Request request = null; Response response = null;
        try {
            current.require();
            JSONObject body = new JSONObject().put("operation", operation).put("routingRevision", current.revision)
                .put("outcome", outcome).put("durationMs", Math.min(60_000, Math.max(0, duration)));
            if (status >= 100 && status < 600) body.put("statusClass", (status / 100) + "xx");
            Map<String, String> headers = new HashMap<>();
            headers.put("authorization", current.access.bearer); headers.put("content-type", "application/json");
            headers.put("x-app-platform", "android"); headers.put("x-app-version", policy.version); headers.put("x-app-build", policy.build);
            headers.put("x-correlation-id", UUID.randomUUID().toString());
            request = new AndroidSessionPolicy.Request(policy.userRoot + "/routing-outcomes", "POST", headers, body.toString(), AndroidSessionPolicy.Operation.API);
            response = api.send(request); // No retry, delegation, business write or credential mutation on any status.
        } catch (Exception ignored) { /* All telemetry fields are constants/numeric; never log exception text. */ }
        finally { if (request != null) wipe(request.body); if (response != null) wipe(response.body); }
    }

    private static String providerTenant(JSONObject plan) throws Failure {
        try {
            if (!"MIXED_END_USER_READS".equals(plan.getString("mode"))) throw rejected();
            JSONObject direct = plan.getJSONObject("directViva");
            if (!PROVIDER_BASE.equals(direct.getString("apiBaseUrl")) || !"/auth/viva/access".equals(direct.getString("accessTokenPath"))) throw rejected();
            JSONArray headers = direct.getJSONArray("allowedRequestHeaders");
            if (headers.length() != 1 || !"Authorization".equals(headers.getString(0))) throw rejected();
            String tenant = direct.getString("providerTenantKey");
            if (!tenant.matches("[A-Za-z0-9_-]{1,128}")) throw rejected();
            // Generic direct routing stays closed for every write and every other read; this
            // class exists only for the authenticated profile.read job relay (ADR 0023 pattern).
            JSONArray operations = plan.getJSONArray("operations");
            boolean profile = false;
            for (int i = 0; i < operations.length(); i++) {
                JSONObject operation = operations.getJSONObject(i);
                if (!"profile.read".equals(operation.getString("operation"))) continue;
                if (profile) throw rejected();
                profile = "DIRECT_VIVA".equals(operation.getString("transport"));
            }
            if (!profile) throw rejected();
            return tenant;
        } catch (Failure error) { throw error; }
        catch (Exception ignored) { throw rejected(); }
    }

    private static final class Job {
        final String jobId, commandId; final long expiresAt;
        Job(String jobId, String commandId, long expiresAt) { this.jobId = jobId; this.commandId = commandId; this.expiresAt = expiresAt; }
    }
    private static Job job(JSONObject value) throws Failure {
        if (value.has("operation") && !"profile.read".equals(value.opt("operation"))) throw jobRejected("CONTRACT");
        String jobId, commandId;
        try { jobId = uuid(value.getString("jobId")); commandId = uuid(value.getString("commandId")); }
        catch (Exception ignored) { throw jobRejected("ID"); }
        long expiresAt;
        try { expiresAt = timestamp(value.getString("expiresAt")); }
        catch (Exception ignored) { throw jobRejected("EXPIRY"); }
        return new Job(jobId, commandId, expiresAt);
    }
    private static String uuid(String value) throws Failure {
        if (!value.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")) throw rejected();
        return UUID.fromString(value).toString();
    }
    private static long httpDate(String value) throws Failure {
        if (value.length() != 29) throw rejected();
        SimpleDateFormat format = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss 'GMT'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC")); format.setLenient(false);
        ParsePosition position = new ParsePosition(0); java.util.Date date = format.parse(value, position);
        if (date == null || position.getIndex() != value.length() || !format.format(date).equals(value)) throw rejected();
        return date.getTime();
    }
    private static long timestamp(String value) throws Failure {
        if (!value.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{3})?Z")) throw rejected();
        for (String pattern : new String[] { "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "yyyy-MM-dd'T'HH:mm:ss'Z'" }) {
            SimpleDateFormat format = new SimpleDateFormat(pattern, Locale.ROOT);
            format.setTimeZone(TimeZone.getTimeZone("UTC")); format.setLenient(false);
            ParsePosition position = new ParsePosition(0); java.util.Date date = format.parse(value, position);
            if (date != null && position.getIndex() == value.length()) return date.getTime();
        }
        throw rejected();
    }
    private static Object json(byte[] body, int limit) throws Failure {
        Object value = parsedJson(body, limit);
        if (!(value instanceof JSONObject) && !(value instanceof JSONArray)) throw rejected();
        return value;
    }
    private static Object parsedJson(byte[] body, int limit) throws Failure {
        if (body == null || body.length == 0 || body.length > limit) throw rejected();
        try {
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(body)).toString();
            JSONTokener input = new JSONTokener(text); Object value = input.nextValue();
            if (input.nextClean() != 0) throw rejected();
            return value;
        } catch (Failure error) { throw error; }
        catch (Exception ignored) { throw rejected(); }
    }
    private static JSONObject object(byte[] bytes, int limit) throws Failure {
        Object value = json(bytes, limit); if (!(value instanceof JSONObject)) throw rejected(); return (JSONObject) value;
    }
    private static boolean jsonContent(Map<String, String> headers) {
        String value = headers.get("content-type");
        return value != null && "application/json".equals(value.split(";", 2)[0].trim().toLowerCase(Locale.ROOT));
    }
    private static Failure rejected() { return new Failure("NATIVE_RESPONSE_REJECTED"); }
    private static Failure profileRejected() { return new Failure("NATIVE_PROFILE_READ_REJECTED"); }
    private static Failure responseRejected(String stage, String reason) {
        if ("JOB".equals(stage)) return jobRejected(reason);
        if ("DELEGATION".equals(stage)) return delegationRejected(reason);
        return rejected();
    }
    private static Failure delegationRejected(String reason) {
        // Compile-time classes only; never emit credential bytes, timestamps or parser details.
        switch (reason) {
            case "TRANSPORT": return new Failure("NATIVE_PROFILE_DELEGATION_TRANSPORT_REJECTED");
            case "MEDIA": return new Failure("NATIVE_PROFILE_DELEGATION_MEDIA_REJECTED");
            case "JSON": return new Failure("NATIVE_PROFILE_DELEGATION_JSON_REJECTED");
            case "CONTRACT": return new Failure("NATIVE_PROFILE_DELEGATION_CONTRACT_REJECTED");
            case "TOKEN": return new Failure("NATIVE_PROFILE_DELEGATION_TOKEN_REJECTED");
            case "EXPIRY": return new Failure("NATIVE_PROFILE_DELEGATION_EXPIRY_REJECTED");
            case "DATE": return new Failure("NATIVE_PROFILE_DELEGATION_DATE_REJECTED");
            case "EXPIRED": return new Failure("NATIVE_PROFILE_DELEGATION_EXPIRED_REJECTED");
            case "TIMING": return new Failure("NATIVE_PROFILE_DELEGATION_TIMING_REJECTED");
            default: return new Failure("NATIVE_PROFILE_DELEGATION_REJECTED");
        }
    }
    private static Failure jobRejected(String reason) {
        // Compile-time reasons only. Never include a field name, value, parser message or header.
        switch (reason) {
            case "TRANSPORT": return new Failure("NATIVE_PROFILE_JOB_TRANSPORT_REJECTED");
            case "MEDIA": return new Failure("NATIVE_PROFILE_JOB_MEDIA_REJECTED");
            case "JSON": return new Failure("NATIVE_PROFILE_JOB_JSON_REJECTED");
            case "CONTRACT": return new Failure("NATIVE_PROFILE_JOB_CONTRACT_REJECTED");
            case "ID": return new Failure("NATIVE_PROFILE_JOB_ID_REJECTED");
            case "EXPIRY": return new Failure("NATIVE_PROFILE_JOB_EXPIRY_REJECTED");
            case "DATE": return new Failure("NATIVE_PROFILE_JOB_DATE_REJECTED");
            case "EXPIRED": return new Failure("NATIVE_PROFILE_JOB_EXPIRED_REJECTED");
            case "LIFETIME": return new Failure("NATIVE_PROFILE_JOB_LIFETIME_REJECTED");
            default: return new Failure("NATIVE_PROFILE_JOB_REJECTED");
        }
    }
    private static Failure stageRejected(String stage) {
        // A closed vocabulary, never a provider field, message, header, URL or credential.
        switch (stage) {
            case "PLAN": return new Failure("NATIVE_PROFILE_PLAN_REJECTED");
            case "JOB": return new Failure("NATIVE_PROFILE_JOB_REJECTED");
            case "DELEGATION": return new Failure("NATIVE_PROFILE_DELEGATION_REJECTED");
            case "PROFILE": return new Failure("NATIVE_PROFILE_READ_REJECTED");
            case "RESULT": return new Failure("NATIVE_PROFILE_RESULT_REJECTED");
            case "COMPLETION": return new Failure("NATIVE_PROFILE_COMPLETION_REJECTED");
            default: return rejected();
        }
    }
    private static void wipe(byte[] bytes) { if (bytes != null) Arrays.fill(bytes, (byte) 0); }

    private static final class FixedProviderSender implements ProviderSender {
        public Response get(String path, String token) throws Failure {
            HttpsURLConnection connection = null;
            ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(); ScheduledFuture<?> deadline = null;
            try {
                if (CookieHandler.getDefault() != null) throw new Failure("NATIVE_REQUEST_REJECTED");
                connection = (HttpsURLConnection) new URL(PROVIDER_BASE + path).openConnection();
                connection.setInstanceFollowRedirects(false); connection.setUseCaches(false); connection.setAllowUserInteraction(false);
                connection.setConnectTimeout(8_000); connection.setReadTimeout(8_000); connection.setRequestMethod("GET");
                connection.setRequestProperty("Authorization", "Bearer " + token); connection.setRequestProperty("Accept", "application/json");
                connection.setRequestProperty("Accept-Encoding", "identity"); connection.setRequestProperty("Cache-Control", "no-store");
                HttpsURLConnection active = connection;
                deadline = timer.schedule(active::disconnect, 15, TimeUnit.SECONDS);
                long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
                int status = connection.getResponseCode();
                Map<String, String> headers = new HashMap<>(); headers.put("content-type", connection.getContentType());
                if (status != 200) return new Response(status, headers, java.util.Collections.emptyList(), new byte[0]);
                if (connection.getContentLengthLong() > PROVIDER_LIMIT) throw profileRejected();
                ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] buffer = new byte[8192];
                try (InputStream input = connection.getInputStream()) {
                    for (int count; (count = input.read(buffer)) != -1;) {
                        if (output.size() + count > PROVIDER_LIMIT || System.nanoTime() > until) throw profileRejected();
                        output.write(buffer, 0, count);
                    }
                    return new Response(status, headers, java.util.Collections.emptyList(), output.toByteArray());
                } finally { wipe(buffer); output.reset(); }
            } catch (Failure error) { throw error; }
            catch (javax.net.ssl.SSLException ignored) { throw new Failure("NATIVE_TLS_REJECTED"); }
            catch (Exception ignored) { throw new Failure("NATIVE_REFRESH_UNAVAILABLE"); }
            finally { if (deadline != null) deadline.cancel(false); timer.shutdownNow(); if (connection != null) connection.disconnect(); }
        }
    }
}
