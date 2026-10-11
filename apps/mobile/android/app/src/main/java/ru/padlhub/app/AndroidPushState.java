package ru.padlhub.app;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import static ru.padlhub.app.AndroidSessionPolicy.Failure;

/** Installation metadata only: no FCM token, refresh credential or raw user identifier is written. */
final class AndroidPushState {
    static final Object LOCK = new Object();
    static final int MAX_STATE_BYTES = 1_048_576, MAX_RECENT_DELIVERIES = 2500;
    static final String OPEN_ROUTE = "phub.push.route", OPEN_ACCOUNT = "phub.push.account";
    static final String OPEN_KEY = "phub.push.open";
    private final Context context;
    final AndroidSessionPolicy policy;
    private final AtomicFile file;

    AndroidPushState(Context context, AndroidSessionPolicy policy) {
        this.context = context.getApplicationContext(); this.policy = policy;
        file = new AtomicFile(new File(context.getNoBackupFilesDir(), "padlhub-push.json"));
    }

    static AndroidPushState fromBundle(Context context) throws Failure {
        try (java.io.InputStream input = context.getAssets().open("capacitor.config.json")) {
            byte[] bytes = input.readNBytes(65_537);
            if (bytes.length > 65_536) throw new Failure("NATIVE_CONFIGURATION_REQUIRED");
            JSONObject config = new JSONObject(new String(bytes, StandardCharsets.UTF_8))
                .getJSONObject("plugins").getJSONObject("PadlHubAndroidSession");
            return new AndroidPushState(context, new AndroidSessionPolicy(config.getString("apiBaseUrl"),
                config.getString("tenantKey"), BuildConfig.VERSION_NAME, String.valueOf(BuildConfig.VERSION_CODE), BuildConfig.DEBUG));
        } catch (Failure error) { throw error; }
        catch (Exception ignored) { throw new Failure("NATIVE_CONFIGURATION_REQUIRED"); }
    }

    JSONObject read() throws Failure {
        synchronized (LOCK) {
            if (!file.getBaseFile().exists()) {
                JSONObject value = new JSONObject();
                try { value.put("installationId", UUID.randomUUID().toString()); value.put("epoch", 0L); }
                catch (Exception ignored) { throw new Failure("NATIVE_STORAGE_UNAVAILABLE"); }
                write(value); return value;
            }
            try (java.io.InputStream input = file.openRead()) {
                byte[] bytes = input.readNBytes(MAX_STATE_BYTES + 1);
                if (bytes.length > MAX_STATE_BYTES) throw new Failure("NATIVE_STORAGE_UNAVAILABLE");
                JSONObject value = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
                UUID.fromString(value.getString("installationId"));
                return value;
            } catch (Exception ignored) { throw new Failure("NATIVE_STORAGE_UNAVAILABLE"); }
        }
    }

    private void write(JSONObject value) throws Failure {
        FileOutputStream output = null;
        try {
            byte[] bytes = value.toString().getBytes(StandardCharsets.UTF_8);
            if (bytes.length > MAX_STATE_BYTES) throw new Failure("NATIVE_STORAGE_UNAVAILABLE");
            output = file.startWrite();
            output.write(bytes);
            file.finishWrite(output);
        } catch (Exception ignored) {
            if (output != null) file.failWrite(output);
            throw new Failure("NATIVE_STORAGE_UNAVAILABLE");
        }
    }

    AndroidSessionEngine.Credential credential() throws Failure {
        AndroidCredentialStore store = new AndroidCredentialStore(context, policy.scope);
        AndroidSessionEngine.Credential value = store.read();
        if (store.logoutIntent() != null || value == null || value.logoutKey != null || value.identity == null
            || !policy.scope.equals(value.scope) || value.expiresAt <= System.currentTimeMillis())
            throw new Failure("NATIVE_PUSH_SESSION_REQUIRED");
        return value;
    }

    static String digest(String value) throws Failure {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder();
            for (byte item : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", item & 255));
            return result.toString();
        } catch (Exception ignored) { throw new Failure("NATIVE_STORAGE_UNAVAILABLE"); }
    }

    String account() throws Failure {
        AndroidSessionEngine.Credential value = credential();
        return digest(policy.scope + "|" + value.identity.userId + "|" + value.identity.tenantId);
    }

    JSONObject registration(String token, long epoch, String account) throws Failure {
        synchronized (LOCK) {
            JSONObject value = read();
            if (epoch != value.optLong("epoch") || (value.has("revokeKey") && account.equals(value.optString("revokeAccount"))) || !account.equals(account()))
                throw new Failure("NATIVE_PUSH_SESSION_REQUIRED");
            if (token == null || !token.matches("[A-Za-z0-9_:.\\-]{16,4096}")) throw new Failure("NATIVE_PUSH_TOKEN_INVALID");
            try {
                String hash = digest(account + "|" + token);
                if (!hash.equals(value.optString("tokenHash")) || !value.has("registerKey")) {
                    value.put("tokenHash", hash); value.put("registerKey", UUID.randomUUID().toString());
                }
                value.put("registrationAccount", account);
                write(value);
                return new JSONObject().put("installationId", value.getString("installationId"))
                    .put("token", token).put("idempotencyKey", value.getString("registerKey"));
            } catch (Exception error) {
                if (error instanceof Failure) throw (Failure) error;
                throw new Failure("NATIVE_STORAGE_UNAVAILABLE");
            }
        }
    }

    void activate(String key, String endpointId) throws Failure {
        synchronized (LOCK) {
            JSONObject value = read();
            if ((value.has("revokeKey") && account().equals(value.optString("revokeAccount"))) || !key.equals(value.optString("registerKey"))
                || !account().equals(value.optString("registrationAccount"))) throw new Failure("NATIVE_PUSH_SESSION_REQUIRED");
            try {
                if (endpointId == null || !UUID.fromString(endpointId).toString().equalsIgnoreCase(endpointId)) throw new Failure("NATIVE_REQUEST_REJECTED");
                value.put("activeAccount", account()); value.put("endpointId", endpointId); value.put("active", true);
                // Acknowledged commands must not reactivate a later revoked endpoint by replaying an old result.
                value.remove("registerKey"); value.remove("revokeKey"); value.remove("revokeAccount"); write(value);
            }
            catch (Exception error) {
                if (error instanceof Failure) throw (Failure) error;
                throw new Failure("NATIVE_STORAGE_UNAVAILABLE");
            }
        }
    }

    JSONObject suspend() throws Failure {
        synchronized (LOCK) {
            JSONObject value = read();
            try {
                if ((value.has("registerKey") || value.optBoolean("active")) && !value.has("revokeKey")) {
                    value.put("revokeKey", UUID.randomUUID().toString());
                    value.put("revokeAccount", value.optString("registrationAccount", value.optString("activeAccount")));
                }
                value.put("active", false); value.put("epoch", value.optLong("epoch") + 1);
                write(value);
                ((NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE)).cancelAll();
                return pending(value);
            } catch (Exception error) {
                if (error instanceof Failure) throw (Failure) error;
                throw new Failure("NATIVE_STORAGE_UNAVAILABLE");
            }
        }
    }

    JSONObject pending(JSONObject value) throws Failure {
        try {
            JSONObject result = new JSONObject().put("installationId", value.getString("installationId"))
                .put("pendingRevoke", value.has("revokeKey"));
            if (value.has("revokeKey")) {
                result.put("idempotencyKey", value.getString("revokeKey"));
                boolean current = false;
                try { current = account().equals(value.optString("revokeAccount")); } catch (Failure ignored) { }
                result.put("revokeCurrentAccount", current);
            }
            return result;
        } catch (Exception ignored) { throw new Failure("NATIVE_STORAGE_UNAVAILABLE"); }
    }

    void finishRevoke(String key) throws Failure {
        synchronized (LOCK) {
            JSONObject value = read();
            if (!key.equals(value.optString("revokeKey"))) throw new Failure("NATIVE_REQUEST_REJECTED");
            for (String field : new String[]{"registerKey", "tokenHash", "activeAccount", "registrationAccount", "revokeKey", "revokeAccount", "recent", "endpointId"}) value.remove(field);
            write(value);
        }
    }

    boolean active() throws Failure {
        JSONObject value = read();
        return value.optBoolean("active") && !value.has("revokeKey") && account().equals(value.optString("activeAccount"));
    }

    static String route(String value) {
        return value != null && value.matches("/chats/[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}")
            ? value : "/notifications";
    }

    boolean accept(Map<String, String> data) throws Failure {
        synchronized (LOCK) {
            if (!active()
                || !read().optString("endpointId").equals(data.get("endpointId"))) return false;
            String delivery = data.get("deliveryId");
            try { if (delivery == null || !UUID.fromString(delivery).toString().equalsIgnoreCase(delivery)) return false; }
            catch (IllegalArgumentException ignored) { return false; }
            JSONObject value = read();
            JSONArray previous = value.optJSONArray("recent");
            if (previous == null) previous = new JSONArray();
            JSONArray next = new JSONArray();
            long now = System.currentTimeMillis();
            for (int i = 0; i < previous.length(); i++) {
                JSONObject entry = previous.optJSONObject(i);
                if (entry == null || entry.optLong("until") < now) continue;
                if (delivery.equals(entry.optString("id"))) return false;
                next.put(entry);
            }
            // Fail closed at capacity; never evict an unexpired id during the provider retry horizon.
            // Entry capabilities and canonical routes also fit inside the 1 MiB storage read cap.
            if (next.length() >= MAX_RECENT_DELIVERIES) return false;
            try {
                next.put(new JSONObject().put("id", delivery).put("until", now + 172_800_000L)
                    .put("account", account()).put("route", route(data.get("deepLink")))
                    .put("openKey", UUID.randomUUID().toString()));
                value.put("recent", next); write(value); return true;
            }
            catch (Exception ignored) { throw new Failure("NATIVE_STORAGE_UNAVAILABLE"); }
        }
    }

    String openKey(String delivery) throws Failure {
        synchronized (LOCK) {
            if (!active()) return null;
            JSONArray recent = read().optJSONArray("recent");
            if (recent == null) return null;
            for (int i = 0; i < recent.length(); i++) {
                JSONObject entry = recent.optJSONObject(i);
                if (entry != null && delivery.equals(entry.optString("id")) && account().equals(entry.optString("account")))
                    return entry.optString("openKey", null);
            }
            return null;
        }
    }

    String opened(Intent intent) throws Failure {
        synchronized (LOCK) {
            if (intent == null) return null;
            String key = intent.getStringExtra(OPEN_KEY);
            intent.removeExtra(OPEN_KEY);
            intent.removeExtra(OPEN_ROUTE); intent.removeExtra(OPEN_ACCOUNT);
            if (key == null || !active()) return null;
            JSONObject value = read();
            JSONArray recent = value.optJSONArray("recent");
            if (recent == null) return null;
            for (int i = 0; i < recent.length(); i++) {
                JSONObject entry = recent.optJSONObject(i);
                if (entry == null || !key.equals(entry.optString("openKey"))
                    || entry.optLong("until") < System.currentTimeMillis()
                    || !account().equals(entry.optString("account"))) continue;
                entry.remove("openKey"); write(value);
                return route(entry.optString("route"));
            }
            return null;
        }
    }
}
