package ru.padlhub.app;

import static ru.padlhub.app.AndroidSessionPolicy.Operation;
import static ru.padlhub.app.AndroidSessionPolicy.Failure;
import static ru.padlhub.app.AndroidSessionPolicy.Request;

import java.net.HttpCookie;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.json.JSONObject;

/** All calls are serialized, including durable refresh/revocation recovery. */
final class AndroidSessionEngine {
    static final class Credential {
        final String scope;
        final String value;
        final long expiresAt;
        final String refreshKey;
        final String logoutKey;
        Credential(String scope, String value, long expiresAt, String refreshKey, String logoutKey) {
            this.scope = scope; this.value = value; this.expiresAt = expiresAt;
            this.refreshKey = refreshKey; this.logoutKey = logoutKey;
        }
        Credential journal(String refreshKey, String logoutKey) {
            return new Credential(scope, value, expiresAt, refreshKey, logoutKey);
        }
    }

    interface Store {
        Credential read() throws Failure;
        void write(Credential value) throws Failure;
        void clear() throws Failure;
        String logoutIntent() throws Failure;
        void beginLogout(String key) throws Failure;
        void clearLogoutIntent() throws Failure;
    }
    interface Sender { Response send(Request request) throws Failure; }

    static final class Response {
        final int status;
        final Map<String, String> headers;
        final List<String> cookies;
        final byte[] body;
        Response(int status, Map<String, String> headers, List<String> cookies, byte[] body) {
            this.status = status; this.headers = headers; this.cookies = cookies; this.body = body;
        }
        static Response signedOut() {
            return new Response(401, Collections.singletonMap("content-type", "application/json"), Collections.emptyList(),
                "{\"code\":\"AUTH_SESSION_REVOKED\",\"message\":\"Войдите заново.\"}".getBytes(StandardCharsets.UTF_8));
        }
        static Response loggedOut() { return new Response(204, Collections.emptyMap(), Collections.emptyList(), new byte[0]); }
        Response forBridge() {
            Map<String, String> safe = new HashMap<>();
            for (Map.Entry<String, String> entry : headers.entrySet()) {
                String key = entry.getKey().toLowerCase(Locale.ROOT);
                if (key.equals("content-type") || key.equals("x-correlation-id") || key.equals("retry-after")) safe.put(key, entry.getValue());
            }
            return new Response(status, safe, Collections.emptyList(), body);
        }
    }

    private final AndroidSessionPolicy policy;
    private final Store store;
    private final Sender sender;
    private String requestedLogoutKey;

    AndroidSessionEngine(AndroidSessionPolicy policy, Store store, Sender sender) {
        this.policy = policy; this.store = store; this.sender = sender;
    }

    synchronized Response request(String path, String method, Map<String, String> headers, String body) throws Failure {
        Request request = policy.request(path, method, headers, body);
        if (request.operation == Operation.LOGOUT) {
            requestedLogoutKey = request.headers.get("idempotency-key");
            store.beginLogout(requestedLogoutKey);
        }
        String durableLogoutKey = store.logoutIntent();
        if (durableLogoutKey != null) requestedLogoutKey = durableLogoutKey;
        Credential saved = current();
        if (saved == null) { store.clearLogoutIntent(); requestedLogoutKey = null; }
        if (saved != null && requestedLogoutKey != null && saved.logoutKey == null) {
            saved = saved.journal(saved.refreshKey, requestedLogoutKey);
            store.write(saved);
        }
        Response response;
        switch (request.operation) {
            case REFRESH:
                if (saved == null) response = Response.signedOut();
                else if (saved.logoutKey != null) {
                    Response result = logout(saved, request);
                    response = result.status == 204 ? Response.signedOut() : result;
                } else response = refresh(saved, request);
                break;
            case LOGOUT:
                if (saved == null) response = Response.loggedOut();
                else {
                    saved = saved.journal(saved.refreshKey, saved.logoutKey == null ? request.headers.get("idempotency-key") : saved.logoutKey);
                    store.write(saved);
                    response = logout(saved, request);
                }
                break;
            case VERIFY:
                if (saved != null) throw AndroidSessionPolicy.rejected();
                response = checkedSend(request);
                if (response.status == 200) acceptSession(response, null);
                break;
            case CHALLENGE:
                if (saved != null) throw AndroidSessionPolicy.rejected();
                response = checkedSend(request);
                break;
            case API:
                if (saved == null || saved.logoutKey != null) response = Response.signedOut();
                else response = checkedSend(request);
                break;
            default:
                response = checkedSend(request);
        }
        return response.forBridge();
    }

    private Credential current() throws Failure {
        Credential value = store.read();
        if (value != null && (!value.scope.equals(policy.scope) || value.expiresAt <= System.currentTimeMillis())) {
            clearSession(); return null;
        }
        return value;
    }

    private Response refresh(Credential value, Request original) throws Failure {
        Credential journal = value.journal(value.refreshKey == null ? original.headers.get("idempotency-key") : value.refreshKey, value.logoutKey);
        store.write(journal);
        Request request = lifecycleRequest(original, "/session/refresh", "POST", "refresh", journal.refreshKey, journal.value);
        Response response = checkedSend(request);
        if (response.status == 200) acceptSession(response, journal);
        else if (response.status == 401) clearSession();
        return response;
    }

    private Response logout(Credential value, Request original) throws Failure {
        if (value.refreshKey != null) {
            Response recovered = refresh(value, original);
            if (recovered.status == 401) return Response.loggedOut();
            if (recovered.status != 200) return recovered;
            value = current();
            if (value == null) throw new Failure("NATIVE_RESPONSE_REJECTED");
        }
        Response response = checkedSend(lifecycleRequest(original, "/session", "DELETE", "logout", value.logoutKey, value.value));
        if (response.status == 204 || response.status == 401) {
            clearSession();
            return Response.loggedOut();
        }
        return response;
    }

    private Request lifecycleRequest(Request original, String suffix, String method, String intent, String key, String cookie) {
        Map<String, String> headers = new HashMap<>(original.headers);
        headers.remove("authorization");
        headers.remove("content-type");
        headers.put("x-session-intent", intent);
        headers.put("idempotency-key", key);
        headers.put("cookie", "phub_refresh=" + cookie);
        return new Request(policy.authRoot + suffix, method, headers, null,
            "logout".equals(intent) ? Operation.LOGOUT : Operation.REFRESH);
    }

    private void clearSession() throws Failure {
        store.clear();
        // Ordering matters: a crash here leaves a marker, never a restorable credential.
        store.clearLogoutIntent();
        requestedLogoutKey = null;
    }

    private Response checkedSend(Request request) throws Failure {
        Response response = sender.send(request);
        if (response.status >= 300 && response.status < 400) throw new Failure("NATIVE_REDIRECT_REJECTED");
        if (response.status < 200 || response.status > 599 || response.body.length > 1024 * 1024) throw new Failure("NATIVE_RESPONSE_REJECTED");
        return response;
    }

    private void acceptSession(Response response, Credential previous) throws Failure {
        // Validate everything before replacing the predecessor journal or releasing an access JWT.
        try {
            JSONObject json = new JSONObject(new String(response.body, StandardCharsets.UTF_8));
            if (json.length() != 5 || !json.getString("accessToken").matches("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+") || !"Bearer".equals(json.getString("tokenType"))
                || json.getString("expiresAt").isEmpty() || json.getJSONObject("user") == null || json.getJSONObject("context") == null) {
                throw new Failure("NATIVE_RESPONSE_REJECTED");
            }
            List<HttpCookie> matched = new ArrayList<>();
            for (String raw : response.cookies) {
                if (raw.length() > 4096 || !raw.startsWith("phub_refresh=")) throw new Failure("NATIVE_RESPONSE_REJECTED");
                java.util.Set<String> attributes = new java.util.HashSet<>();
                String[] parts = raw.split(";");
                for (int i = 1; i < parts.length; i++) {
                    String attribute = parts[i].trim().split("=", 2)[0].toLowerCase(Locale.ROOT);
                    if (!attributes.add(attribute)) throw new Failure("NATIVE_RESPONSE_REJECTED");
                }
                for (HttpCookie cookie : HttpCookie.parse(raw)) {
                    if (!cookie.getName().equals("phub_refresh")) continue;
                    if (!cookie.getSecure() || !cookie.isHttpOnly() || !policy.authRoot.equals(cookie.getPath())
                        || cookie.getDomain() != null
                        || !cookie.getValue().matches("[A-Za-z0-9_-]{32,512}")
                        || cookie.getMaxAge() <= 0 || cookie.getMaxAge() > 366L * 86400
                        || !java.util.regex.Pattern.compile(";\\s*SameSite=Lax(?:;|$)", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(raw).find()) {
                        throw new Failure("NATIVE_RESPONSE_REJECTED");
                    }
                    matched.add(cookie);
                }
            }
            if (matched.size() != 1) throw new Failure("NATIVE_RESPONSE_REJECTED");
            HttpCookie cookie = matched.get(0);
            store.write(new Credential(policy.scope, cookie.getValue(), System.currentTimeMillis() + cookie.getMaxAge() * 1000,
                null, previous == null ? null : previous.logoutKey));
        } catch (Failure error) { throw error; }
        catch (Exception ignored) { throw new Failure("NATIVE_RESPONSE_REJECTED"); }
    }
}
