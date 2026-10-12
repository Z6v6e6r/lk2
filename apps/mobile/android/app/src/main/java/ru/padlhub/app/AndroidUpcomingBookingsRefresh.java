package ru.padlhub.app;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.CookieHandler;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.Executor;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import static ru.padlhub.app.AndroidSessionPolicy.Failure;
import static ru.padlhub.app.AndroidSessionEngine.Response;

/** One fixed, owner-approved device transport. No provider bytes cross the native bridge. */
final class AndroidUpcomingBookingsRefresh {
    static final int PROVIDER_LIMIT = 1024 * 1024;
    static final int RELAY_LIMIT = 6 * 1024 * 1024;
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

    /** Two session-bound, memory-only circuits; monotonic time prevents wall-clock rollback. */
    static final class Circuits {
        private long generation = Long.MIN_VALUE;
        private final int[] failures = new int[2];
        private final long[] retryAt = new long[2];
        void bind(long next) {
            if (next != generation) { generation = next; Arrays.fill(failures, 0); Arrays.fill(retryAt, 0); }
        }
        int slot(String operation) { return "bookings.read".equals(operation) ? 0 : 1; }
        boolean open(String operation, long now) { return retryAt[slot(operation)] > now; }
        void success(String operation) { int slot = slot(operation); failures[slot] = 0; retryAt[slot] = 0; }
        void failure(String operation, long now) {
            int slot = slot(operation); failures[slot] = Math.min(5, failures[slot] + 1);
            retryAt[slot] = now + Math.min(30_000, 1_000L << (failures[slot] - 1));
        }
    }

    AndroidUpcomingBookingsRefresh(AndroidSessionPolicy policy, AndroidSessionEngine engine,
        AndroidSessionEngine.Sender api, Circuits circuits, Executor metrics) {
        this(policy, engine, api, new FixedProviderSender(), new AndroidSessionEngine.Clock() {
            public long wall() { return System.currentTimeMillis(); }
            public long elapsed() { return android.os.SystemClock.elapsedRealtime(); }
        }, circuits, metrics);
    }
    /** Package-private fake transport/clock seam; production cannot choose an origin or method. */
    AndroidUpcomingBookingsRefresh(AndroidSessionPolicy policy, AndroidSessionEngine engine,
        AndroidSessionEngine.Sender api, ProviderSender provider, AndroidSessionEngine.Clock clock) {
        this(policy, engine, api, provider, clock, new Circuits(), Runnable::run);
    }
    AndroidUpcomingBookingsRefresh(AndroidSessionPolicy policy, AndroidSessionEngine engine,
        AndroidSessionEngine.Sender api, ProviderSender provider, AndroidSessionEngine.Clock clock, Circuits circuits) {
        this(policy, engine, api, provider, clock, circuits, Runnable::run);
    }
    AndroidUpcomingBookingsRefresh(AndroidSessionPolicy policy, AndroidSessionEngine engine,
        AndroidSessionEngine.Sender api, ProviderSender provider, AndroidSessionEngine.Clock clock, Circuits circuits, Executor metrics) {
        this.policy = policy; this.engine = engine; this.api = api; this.provider = provider; this.clock = clock; this.circuits = circuits; this.metrics = metrics;
    }

    private static final class Outcome {
        final String operation, outcome; final int status; final long duration;
        Outcome(String operation, String outcome, int status, long duration) {
            this.operation = operation; this.outcome = outcome; this.status = status; this.duration = duration;
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
        Invocation(AndroidSessionEngine.NativeAccess access, Cancellation cancellation) {
            this.access = access; this.cancellation = cancellation;
        }
        void require() throws Failure {
            cancellation.require(); engine.requireNativeAccess(access); cancellation.require();
            if (Thread.currentThread().isInterrupted() || clock.elapsed() >= deadline)
                throw new Failure("NATIVE_OPERATION_CANCELLED");
        }
        void restrict(long expiresAt, long maximumLifetime) throws Failure {
            long remaining = expiresAt - clock.wall();
            if (remaining <= 0 || remaining > maximumLifetime) throw rejected();
            deadline = Math.min(deadline, clock.elapsed() + remaining);
        }
        void forget() { token = null; tenant = null; revision = null; }
    }

    void run(AndroidSessionEngine.NativeAccess access, Cancellation cancellation) throws Failure {
        Invocation current = new Invocation(access, cancellation);
        byte[] list = null, details = null;
        try {
            current.require();
            JSONObject plan = object(api("/routing-plan", "GET", null, null, false, current), PROVIDER_LIMIT);
            current.restrict(timestamp(plan.optString("expiresAt", "")), 3_600_000);
            current.tenant = providerTenant(plan);
            current.revision = plan.getString("revision");
            if (!current.revision.matches("[0-9]{1,128}")) throw rejected();
            circuits.bind(access.generation);
            for (String operation : new String[] { "bookings.read", "bookings.details.read" }) {
                if (circuits.open(operation, clock.elapsed())) {
                    current.outcomes.add(new Outcome(operation, "CIRCUIT_OPEN", 0, 0));
                    throw new Failure("NATIVE_REFRESH_UNAVAILABLE");
                }
            }
            JSONObject start = object(api("/booking-screen-read-jobs", "POST", "{\"screen\":\"MY_BOOKINGS\"}",
                UUID.randomUUID().toString(), false, current), PROVIDER_LIMIT);
            Job job = job(start);
            current.restrict(job.expiresAt, 120_000);
            delegate(current);
            list = providerRead("/v2/" + current.tenant + "/bookings?page=0&size=50", "bookings.read", current);
            List<String> ids = activeIds(list);
            details = ids.isEmpty() ? "[]".getBytes(StandardCharsets.UTF_8)
                : providerRead(detailsPath(current.tenant, ids), "bookings.details.read", current);
            Object detailsValue = json(details, PROVIDER_LIMIT);
            if (!(detailsValue instanceof JSONObject) && !(detailsValue instanceof JSONArray)) throw rejected();
            JSONObject payload = new JSONObject().put("bookings", object(list, PROVIDER_LIMIT)).put("details", detailsValue);
            String relay = new JSONObject().put("payload", payload).toString();
            if (relay.getBytes(StandardCharsets.UTF_8).length > RELAY_LIMIT) throw rejected();
            JSONObject accepted = object(api("/booking-screen-read-jobs/" + job.jobId + "/results/" + job.commandId,
                "POST", relay, UUID.randomUUID().toString(), true, current), PROVIDER_LIMIT);
            Object itemCount = accepted.opt("itemCount");
            if (!Boolean.TRUE.equals(accepted.opt("accepted")) || !(accepted.opt("replayed") instanceof Boolean)
                || !(itemCount instanceof Number) || ((Number) itemCount).doubleValue() < 0
                || ((Number) itemCount).doubleValue() > 50
                || ((Number) itemCount).doubleValue() != ((Number) itemCount).intValue()) throw rejected();
            byte[] completedBytes = api("/booking-screen-read-jobs/" + job.jobId + "/complete", "POST", "{\"limit\":50}",
                UUID.randomUUID().toString(), true, current);
            try {
                JSONObject completed = object(completedBytes, PROVIDER_LIMIT);
                if (!"MY_BOOKINGS".equals(completed.opt("screen")) || !"READY".equals(completed.opt("state"))
                    || !integer(completed.opt("completedCommands"), 1) || !integer(completed.opt("totalCommands"), 1)) throw rejected();
                JSONObject bookings = completed.getJSONObject("bookings");
                if (!(bookings.opt("version") instanceof String) || bookings.getString("version").isEmpty()
                    || bookings.getJSONArray("items").length() > 50
                    || timestamp(bookings.getString("staleAt")) <= timestamp(bookings.getString("generatedAt"))) throw rejected();
            } finally { wipe(completedBytes); }
            current.require();
            emitMetrics(current); // Projection is committed before metrics can be scheduled.
        } catch (Failure error) { emitMetrics(current); throw error; }
        catch (Exception ignored) { emitMetrics(current); throw rejected(); }
        finally { wipe(list); wipe(details); current.forget(); }
    }

    private byte[] api(String suffix, String method, String body, String key, boolean exactReplay, Invocation current) throws Failure {
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
        Response response;
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
            if (response.body == null || response.body.length > PROVIDER_LIMIT || !jsonContent(response.headers)) throw rejected();
            return response.body;
        } catch (Failure error) {
            if ("NATIVE_NETWORK_UNAVAILABLE".equals(error.code)) throw new Failure("NATIVE_REFRESH_UNAVAILABLE");
            throw error;
        } finally { wipe(request.body); }
    }

    private void delegate(Invocation current) throws Failure {
        byte[] bytes = api("/auth/viva/access", "POST", "{}", UUID.randomUUID().toString(), false, current);
        try {
            JSONObject value = object(bytes, PROVIDER_LIMIT);
            String token = value.optString("accessToken", "");
            if (!token.matches("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+") || token.length() > 8192) throw rejected();
            long expiresAt = timestamp(value.optString("expiresAt", ""));
            long remaining = expiresAt - clock.wall();
            if (remaining <= 0 || remaining > 3_600_000) throw rejected();
            // The backend verifies the token's signature and identity. This local check additionally
            // prevents a mismatched provider tenant from directing that same user's credential elsewhere.
            String payload = token.split("\\.", -1)[1];
            JSONObject claims = object(android.util.Base64.decode(payload, android.util.Base64.URL_SAFE | android.util.Base64.NO_WRAP), 8192);
            if (!current.tenant.equals(claims.opt("tenant_key"))) throw rejected();
            current.require(); current.token = token; current.tokenDeadline = clock.elapsed() + remaining;
        } catch (Failure error) { throw error; }
        catch (Exception ignored) { throw rejected(); }
        finally { wipe(bytes); }
    }

    private byte[] providerRead(String path, String operation, Invocation current) throws Failure {
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
            if (response.body == null || response.body.length > PROVIDER_LIMIT || !jsonContent(response.headers)) throw rejected();
            json(response.body, PROVIDER_LIMIT);
            if ("bookings.read".equals(operation)) activeIds(response.body);
            circuits.success(operation);
            current.outcomes.add(new Outcome(operation, "SUCCESS", status, clock.elapsed() - started));
            current.require();
            return response.body;
        } catch (Failure error) {
            if (response != null) wipe(response.body);
            // Cancellation/retired identity must cause no subsequent external write or metric.
            if (!"NATIVE_OPERATION_CANCELLED".equals(error.code) && !"AUTH_SESSION_REVOKED".equals(error.code)) {
                circuits.failure(operation, clock.elapsed());
                current.outcomes.add(new Outcome(operation, status == 401 ? "REAUTH_REQUIRED"
                    : "NATIVE_RESPONSE_REJECTED".equals(error.code) ? "INVALID" : "UNAVAILABLE", status, clock.elapsed() - started));
            }
            throw error;
        }
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

    /** Existing authenticated, redacted telemetry only; failure never retries or changes the projection/session. */
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
            // These slots remain canonical PadlHub reads. The authenticated MY_BOOKINGS job,
            // separately from generic direct routing, permits the fixed relay (ADR 0020/0023).
            JSONArray operations = plan.getJSONArray("operations");
            Set<String> seen = new HashSet<>(); boolean list = false, details = false;
            for (int i = 0; i < operations.length(); i++) {
                JSONObject operation = operations.getJSONObject(i); String name = operation.getString("operation");
                if (!seen.add(name)) throw rejected();
                if ("bookings.read".equals(name)) list = "PADLHUB_API".equals(operation.getString("transport"));
                if ("bookings.details.read".equals(name)) details = "PADLHUB_API".equals(operation.getString("transport"));
            }
            if (!list || !details) throw rejected();
            return tenant;
        } catch (Failure error) { throw error; }
        catch (Exception ignored) { throw rejected(); }
    }

    private static final class Job {
        final String jobId, commandId; final long expiresAt;
        Job(String jobId, String commandId, long expiresAt) { this.jobId = jobId; this.commandId = commandId; this.expiresAt = expiresAt; }
    }
    private static Job job(JSONObject value) throws Failure {
        try {
            if (!"MY_BOOKINGS".equals(value.getString("screen")) || !integer(value.opt("concurrency"), 1)) throw rejected();
            JSONArray commands = value.getJSONArray("commands"); if (commands.length() != 1) throw rejected();
            JSONObject command = commands.getJSONObject(0);
            if (command.length() != 5 || !"bookings.read".equals(command.getString("operation"))
                || !"bookings.details.read".equals(command.getString("detailsOperation"))
                || !integer(command.opt("page"), 0) || !integer(command.opt("size"), 50)) throw rejected();
            return new Job(uuid(value.getString("jobId")), uuid(command.getString("commandId")), timestamp(value.getString("expiresAt")));
        } catch (Failure error) { throw error; }
        catch (Exception ignored) { throw rejected(); }
    }
    private static String uuid(String value) throws Failure {
        if (!value.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")) throw rejected();
        return UUID.fromString(value).toString();
    }
    private static boolean integer(Object value, int expected) {
        return value instanceof Number && ((Number) value).doubleValue() == expected;
    }
    private static List<String> activeIds(byte[] body) throws Failure {
        try {
            JSONArray content = object(body, PROVIDER_LIMIT).getJSONArray("content");
            if (content.length() > 50) throw rejected();
            List<String> ids = new ArrayList<>();
            for (int i = 0; i < content.length(); i++) {
                JSONObject booking = content.getJSONObject(i);
                Object raw = booking.get("id"); String id;
                if (raw instanceof String) id = ((String) raw).trim();
                else if (raw instanceof Number) {
                    double number = ((Number) raw).doubleValue();
                    if (Double.isNaN(number) || Double.isInfinite(number)) throw rejected();
                    id = JSONObject.numberToString((Number) raw);
                } else throw rejected();
                if (id.isEmpty() || id.length() > 200 || !(booking.get("isCancelled") instanceof Boolean)) throw rejected();
                if (!booking.getBoolean("isCancelled")) {
                    // Match bookingDetailsRequestSchema; cancelled list entries may be up to 200.
                    if (id.length() > 128) throw rejected();
                    ids.add(id);
                }
            }
            return ids;
        } catch (Failure error) { throw error; }
        catch (Exception ignored) { throw rejected(); }
    }
    private static String detailsPath(String tenant, List<String> ids) throws Failure {
        try {
            StringBuilder path = new StringBuilder("/v1/").append(tenant).append("/bookings/list?");
            for (int i = 0; i < ids.size(); i++) {
                if (i > 0) path.append('&'); path.append("bookingIds=").append(URLEncoder.encode(ids.get(i), "UTF-8"));
            }
            return path.toString();
        } catch (Exception ignored) { throw rejected(); }
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
        if (body == null || body.length == 0 || body.length > limit) throw rejected();
        try {
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(body)).toString();
            JSONTokener input = new JSONTokener(text); Object value = input.nextValue();
            if (input.nextClean() != 0 || (!(value instanceof JSONObject) && !(value instanceof JSONArray))) throw rejected();
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
                if (connection.getContentLengthLong() > PROVIDER_LIMIT) throw rejected();
                ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] buffer = new byte[8192];
                try (InputStream input = connection.getInputStream()) {
                    for (int count; (count = input.read(buffer)) != -1;) {
                        if (output.size() + count > PROVIDER_LIMIT || System.nanoTime() > until) throw rejected();
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
