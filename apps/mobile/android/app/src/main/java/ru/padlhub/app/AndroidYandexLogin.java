package ru.padlhub.app;

import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONObject;
import static ru.padlhub.app.AndroidSessionPolicy.Failure;
import static ru.padlhub.app.AndroidSessionPolicy.Operation;
import static ru.padlhub.app.AndroidSessionPolicy.Request;
import static ru.padlhub.app.AndroidSessionEngine.Response;

/** Native-only PKCE custody. Invoked on the same serial queue as refresh and logout. */
final class AndroidYandexLogin {
    static final long MAX_AGE = 600_000;
    static final Pattern CALLBACK = Pattern.compile("^https://lk2\\.padlhub\\.su/android/oauth/yandex#code=([A-Za-z0-9_-]{43})&state=([A-Za-z0-9_-]{43})$");
    static final class Pending {
        final String state, verifier, startKey, exchangeKey, code;
        final long expiresAt;
        Pending(String state, String verifier, String startKey, String exchangeKey, String code, long expiresAt) {
            this.state = state; this.verifier = verifier; this.startKey = startKey; this.exchangeKey = exchangeKey;
            this.code = code; this.expiresAt = expiresAt;
        }
        Pending callback(String value) { return new Pending(state, verifier, startKey, exchangeKey, value, expiresAt); }
    }
    interface Store {
        Pending read() throws Failure;
        void write(Pending value) throws Failure;
        void clear() throws Failure;
    }
    interface Clock { long now(); }
    private final AndroidSessionPolicy policy;
    private final AndroidSessionEngine engine;
    private final AndroidSessionEngine.Sender sender;
    private final Store store;
    private final Clock clock;

    AndroidYandexLogin(AndroidSessionPolicy policy, AndroidSessionEngine engine, AndroidSessionEngine.Sender sender, Store store) {
        this(policy, engine, sender, store, System::currentTimeMillis);
    }
    AndroidYandexLogin(AndroidSessionPolicy policy, AndroidSessionEngine engine, AndroidSessionEngine.Sender sender, Store store, Clock clock) {
        this.policy = policy; this.engine = engine; this.sender = sender; this.store = store; this.clock = clock;
    }
    private String random() {
        byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes);
        return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }
    static String challenge(String verifier) throws Exception {
        return Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)), Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    String start(boolean offer, boolean privacy) throws Failure {
        if (!offer || !privacy) throw new Failure("LEGAL_ACCEPTANCE_REQUIRED");
        if (store.read() != null) throw new Failure("NATIVE_OAUTH_PENDING");
        engine.requireOAuthSignedOut();
        Pending pending = new Pending(random(), random(), UUID.randomUUID().toString(), UUID.randomUUID().toString(), null, clock.now() + MAX_AGE);
        store.write(pending); // Never open the browser unless the proof can survive process death.
        try {
            JSONObject body = new JSONObject().put("clientState", pending.state).put("codeChallenge", challenge(pending.verifier))
                .put("acceptance", new JSONObject().put("publicOfferAccepted", true).put("personalDataPolicyAccepted", true));
            Response response = send("/start", pending.startKey, body);
            if (response.status != 200) throw new Failure("NATIVE_OAUTH_UNAVAILABLE");
            JSONObject result = new JSONObject(new String(response.body, StandardCharsets.UTF_8));
            String path = result.getString("launchPath");
            if (result.length() != 1 || !path.matches(Pattern.quote(policy.authRoot + "/viva/android/launch?code=") + "[A-Za-z0-9_-]{43}")) throw new Failure("NATIVE_RESPONSE_REJECTED");
            return policy.origin + path;
        } catch (Exception error) {
            // No browser has been opened and no exchange can have happened yet.
            store.clear();
            if (error instanceof Failure) throw (Failure) error;
            throw new Failure("NATIVE_RESPONSE_REJECTED");
        }
    }

    boolean callback(String raw) throws Failure {
        if (raw == null || raw.length() > 256) return false;
        Matcher match = CALLBACK.matcher(raw);
        if (!match.matches()) return false;
        Pending pending = store.read();
        if (pending == null || pending.expiresAt <= clock.now() || !pending.state.equals(match.group(2))) return false;
        if (engine.hasPendingLogout()) return false;
        // A repeated intent is harmless; a different code cannot replace a received callback.
        if (pending.code != null) return pending.code.equals(match.group(1));
        engine.requireOAuthSignedOut();
        store.write(pending.callback(match.group(1)));
        return true;
    }

    String status() throws Failure {
        if (engine.hasPendingLogout()) { store.clear(); return "idle"; } // Existing refresh/revoke recovery owns logout.
        Pending pending = store.read();
        if (pending == null) return "idle";
        if (engine.hasOAuthSession(pending.state)) {
            store.clear(); return "complete";
        }
        if (pending.expiresAt <= clock.now() || pending.expiresAt > clock.now() + MAX_AGE) {
            store.clear(); throw new Failure("NATIVE_OAUTH_EXPIRED");
        }
        if (pending.code == null) return "waiting";
        try {
            Response response = send("/exchange", pending.exchangeKey, new JSONObject().put("code", pending.code)
                .put("codeVerifier", pending.verifier).put("clientState", pending.state));
            if (response.status == 401 || response.status == 410 || response.status == 409) {
                store.clear(); throw new Failure("NATIVE_OAUTH_EXPIRED");
            }
            if (response.status != 200) throw new Failure("NATIVE_OAUTH_UNAVAILABLE");
            if (!pending.state.equals(response.headers.get("x-android-oauth-state"))) throw new Failure("NATIVE_RESPONSE_REJECTED");
            engine.acceptOAuthSession(response, pending.state);
            store.clear(); // A crash/clear failure is recognized by the atomic credential's attempt marker.
            return "complete";
        } catch (Failure error) { throw error; }
        catch (Exception ignored) { throw new Failure("NATIVE_RESPONSE_REJECTED"); }
    }

    void cancel() throws Failure {
        Pending pending = store.read();
        if (pending != null && pending.code != null && pending.expiresAt > clock.now()) throw new Failure("NATIVE_OAUTH_FINISH_REQUIRED");
        store.clear();
    }

    void beforeRequest(Operation operation) throws Failure {
        if (operation == Operation.LOGOUT) { store.clear(); return; }
        if (store.read() != null) throw new Failure("NATIVE_OAUTH_PENDING");
    }

    private Response send(String suffix, String key, JSONObject body) throws Failure {
        Map<String, String> headers = new HashMap<>();
        headers.put("accept", "application/json"); headers.put("content-type", "application/json");
        headers.put("idempotency-key", key); headers.put("x-correlation-id", UUID.randomUUID().toString());
        headers.put("x-app-platform", "android"); headers.put("x-app-version", policy.version); headers.put("x-app-build", policy.build);
        Response response = sender.send(new Request(policy.authRoot + "/viva/android" + suffix, "POST", headers, body.toString(), Operation.PUBLIC));
        if (response.status < 200 || response.status > 599 || (response.status >= 300 && response.status < 400)
            || response.body.length > 65536) throw new Failure("NATIVE_RESPONSE_REJECTED");
        return response;
    }
}
