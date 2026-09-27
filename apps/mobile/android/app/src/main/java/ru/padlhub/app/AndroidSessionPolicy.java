package ru.padlhub.app;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.json.JSONObject;

/** The native bundle owns the destination. JavaScript cannot choose a host or tenant. */
final class AndroidSessionPolicy {
    final String origin;
    final String tenant;
    final String version;
    final String build;
    final String userRoot;
    final String authRoot;
    final String scope;

    AndroidSessionPolicy(String origin, String tenant, String version, String build, boolean debug) throws Failure {
        if (!("https://lk2.padlhub.su".equals(origin)
            || (debug && "https://lk.nano.padlhub.su".equals(origin)))
            || tenant == null || !tenant.matches("[a-z0-9][a-z0-9-]{1,62}")) {
            throw new Failure("NATIVE_CONFIGURATION_REQUIRED");
        }
        this.origin = origin;
        this.tenant = tenant;
        this.version = version;
        this.build = build;
        userRoot = "/user/api/v1/" + tenant;
        authRoot = userRoot + "/auth";
        scope = origin + "|" + tenant;
    }

    enum Operation { CHALLENGE, VERIFY, REFRESH, LOGOUT, API, PUBLIC }

    static final class Failure extends Exception {
        final String code;
        Failure(String code) { super(code); this.code = code; }
    }

    static final class Request {
        final String path;
        final String method;
        final Map<String, String> headers;
        final String body;
        final Operation operation;
        Request(String path, String method, Map<String, String> headers, String body, Operation operation) {
            this.path = path; this.method = method; this.headers = headers;
            this.body = body; this.operation = operation;
        }
    }

    Request request(String path, String method, Map<String, String> inputHeaders, String body) throws Failure {
        if (path == null || path.length() > 8192 || path.contains("\\") || path.contains("#")
            || path.contains("\r") || path.contains("\n")) throw rejected();
        final URI uri;
        try { uri = new URI(path); } catch (Exception ignored) { throw rejected(); }
        String cleanPath = uri.getRawPath();
        if (uri.isAbsolute() || uri.getRawAuthority() != null || cleanPath == null
            || cleanPath.contains("%") || cleanPath.contains("..") || cleanPath.contains("//")) throw rejected();
        if (!cleanPath.startsWith(userRoot + "/")) throw rejected();

        Operation operation;
        if (cleanPath.equals(authRoot + "/challenges") && "POST".equals(method)) operation = Operation.CHALLENGE;
        else if (cleanPath.matches(java.util.regex.Pattern.quote(authRoot) + "/challenges/[a-fA-F0-9-]{36}/verify") && "POST".equals(method)) {
            String id = cleanPath.substring((authRoot + "/challenges/").length(), cleanPath.length() - "/verify".length());
            try { if (!UUID.fromString(id).toString().equalsIgnoreCase(id)) throw rejected(); }
            catch (IllegalArgumentException ignored) { throw rejected(); }
            operation = Operation.VERIFY;
        } else if (cleanPath.equals(authRoot + "/session/refresh") && "POST".equals(method)) operation = Operation.REFRESH;
        else if (cleanPath.equals(authRoot + "/session") && "DELETE".equals(method)) operation = Operation.LOGOUT;
        else {
            if (cleanPath.contains("/auth/")) throw rejected();
            boolean notificationWrite = "PUT".equals(method) && (cleanPath.equals(userRoot + "/notifications/read-cursor")
                || cleanPath.equals(userRoot + "/notifications/preferences"));
            if (!("GET".equals(method) && allowedRead(cleanPath.substring(userRoot.length()))) && !notificationWrite) throw rejected();
            operation = Operation.API;
        }
        boolean auth = operation != Operation.API && operation != Operation.PUBLIC;
        if (auth && uri.getRawQuery() != null) throw rejected();
        Map<String, String> headers = new HashMap<>();
        Set<String> allowed = new HashSet<>(Arrays.asList("accept", "content-type", "authorization",
            "idempotency-key", "x-correlation-id", "x-app-platform", "x-app-version", "x-app-build", "x-session-intent"));
        for (Map.Entry<String, String> entry : inputHeaders.entrySet()) {
            String name = entry.getKey().toLowerCase(Locale.ROOT);
            String value = entry.getValue();
            if (!allowed.contains(name) || headers.containsKey(name) || value == null
                || value.length() > 8192 || value.contains("\r") || value.contains("\n")) throw rejected();
            headers.put(name, value);
        }
        if (auth && headers.containsKey("authorization")) throw rejected();
        if (operation == Operation.PUBLIC) headers.remove("authorization");
        if (operation == Operation.API && !headers.getOrDefault("authorization", "").matches("Bearer [A-Za-z0-9._-]{8,8192}")) throw rejected();
        if (!"GET".equals(method) && !headers.getOrDefault("idempotency-key", "").matches("[A-Za-z0-9._:-]{16,128}")) throw rejected();
        String intent = operation == Operation.REFRESH ? "refresh" : operation == Operation.LOGOUT ? "logout" : null;
        if (!java.util.Objects.equals(intent, headers.get("x-session-intent"))) throw rejected();
        headers.put("accept", "application/json");
        headers.put("x-app-platform", "android");
        headers.put("x-app-version", version);
        headers.put("x-app-build", build);
        if (!headers.containsKey("x-correlation-id")) headers.put("x-correlation-id", UUID.randomUUID().toString());
        if (body != null && body.getBytes(StandardCharsets.UTF_8).length > 16_384) throw rejected();
        if (operation == Operation.CHALLENGE || operation == Operation.VERIFY) validateAuthBody(operation, body);
        else if (("GET".equals(method) || auth) && body != null) throw rejected();
        if (body != null) headers.put("content-type", "application/json");
        return new Request(path, method, headers, body, operation);
    }

    private boolean allowedRead(String path) {
        // This shipped slice has canonical reads and notification preferences only.
        // New routes need an explicit native review, even when the web SDK knows them.
        if (Arrays.asList("/context", "/routing-plan", "/profile", "/profile/privacy",
            "/profile/friends", "/profile/friend-requests", "/profile/level-history",
            "/profile/level", "/profile/level-assessment", "/profile/booking-preferences",
            "/bookings/upcoming", "/bookings/history", "/recommendations/bookings",
            "/home", "/home/base", "/locations", "/communities/mine", "/conversations",
            "/notifications", "/notifications/preferences").contains(path)) return true;
        return path.matches("/(?:profiles|profile/friends|locations)/[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}");
    }

    private void validateAuthBody(Operation operation, String body) throws Failure {
        try {
            if (body == null || body.length() > 4096) throw rejected();
            JSONObject json = new JSONObject(body);
            if (operation == Operation.CHALLENGE) {
                if (json.length() != 2 || !"phone_otp".equals(json.getString("method"))
                    || !json.getString("phone").matches("\\+7[0-9]{10}")) throw rejected();
            } else {
                JSONObject consent = json.getJSONObject("acceptance");
                if (json.length() != 2 || !json.getString("code").matches("[0-9]{4}") || consent.length() != 2
                    || !Boolean.TRUE.equals(consent.get("publicOfferAccepted"))
                    || !Boolean.TRUE.equals(consent.get("personalDataPolicyAccepted"))) throw rejected();
            }
        } catch (Failure error) { throw error; }
        catch (Exception ignored) { throw rejected(); }
    }

    static Failure rejected() { return new Failure("NATIVE_REQUEST_REJECTED"); }
}
