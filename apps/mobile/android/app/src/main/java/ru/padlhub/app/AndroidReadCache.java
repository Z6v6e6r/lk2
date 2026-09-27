package ru.padlhub.app;

import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import org.json.JSONObject;
import static ru.padlhub.app.AndroidSessionPolicy.Failure;
import static ru.padlhub.app.AndroidSessionEngine.Response;

/** Two reviewed read models only. A cache hit never extends its lifetime or grants authority. */
final class AndroidReadCache {
    static final int SCHEMA = 1;
    static final int MAX_BYTES = 1024 * 1024;
    interface Store {
        byte[] read(String principal) throws Exception;
        void write(String principal, byte[] bytes) throws Exception;
        void clear() throws Failure;
    }
    static final class Rule {
        final long freshMs, maxMs;
        final int maxBytes;
        Rule(long freshMs, long maxMs, int maxBytes) {
            this.freshMs = freshMs; this.maxMs = maxMs; this.maxBytes = maxBytes;
        }
    }
    static final class Entry {
        final byte[] body;
        final long savedAt, loadedAt, initialAge;
        Entry(byte[] body, long savedAt, long wall, long elapsed) {
            this.body = body; this.savedAt = savedAt; loadedAt = elapsed; initialAge = wall - savedAt;
        }
        long age(long wall, long elapsed) { return Math.max(wall - savedAt, initialAge + elapsed - loadedAt); }
        Response response(boolean stale) {
            return new Response(200, Collections.singletonMap("content-type", "application/json"),
                Collections.emptyList(), body, new Response.Cache(stale, savedAt));
        }
    }
    private final String root;
    private final Store store;
    private final Map<String, Entry> entries = new HashMap<>();
    private String principal;
    private String userId;

    AndroidReadCache(String root, Store store) { this.root = root; this.store = store; }

    Rule rule(String path) {
        if (path.equals(root + "/home/base")) return new Rule(30_000, 15 * 60_000, 512 * 1024);
        if (path.equals(root + "/locations")) return new Rule(60_000, 24 * 60 * 60_000, 256 * 1024);
        return null; // Query variants, other reads and all commands are deliberately absent.
    }

    void activate(AndroidSessionEngine.Principal identity, long wall, long elapsed) {
        String next = identity.tenantId + "|" + identity.userId;
        if (next.equals(principal)) return;
        entries.clear(); principal = next; userId = identity.userId;
        try {
            byte[] bytes = store.read(principal);
            if (bytes == null) return;
            if (bytes.length > MAX_BYTES) throw new IllegalArgumentException();
            JSONObject data = new JSONObject(utf8(bytes));
            if (data.getInt("schema") != SCHEMA || !principal.equals(data.getString("principal"))) throw new IllegalArgumentException();
            JSONObject records = data.getJSONObject("entries");
            if (records.length() > 2) throw new IllegalArgumentException();
            for (Iterator<String> keys = records.keys(); keys.hasNext();) {
                String path = keys.next();
                JSONObject item = records.getJSONObject(path);
                byte[] body = item.getString("body").getBytes(StandardCharsets.UTF_8);
                long savedAt = item.getLong("savedAt");
                if (!valid(path, body) || savedAt <= 0) throw new IllegalArgumentException();
                entries.put(path, new Entry(body, savedAt, wall, elapsed));
            }
            prune(wall, elapsed);
            persist();
        } catch (Exception ignored) {
            // Disposable cache failure must not destroy the authenticated session.
            entries.clear();
            try { store.clear(); } catch (Failure failure) { principal = null; }
        }
    }

    Entry get(String path, long wall, long elapsed) {
        if (principal == null || rule(path) == null) return null;
        if (prune(wall, elapsed)) persist();
        return entries.get(path);
    }

    void put(String path, Response response, long wall, long elapsed) {
        if (principal == null || response.status != 200 || !response.cookies.isEmpty()
            || !response.headers.getOrDefault("content-type", "").toLowerCase(java.util.Locale.ROOT).startsWith("application/json")
            || !valid(path, response.body)) { remove(path); return; }
        prune(wall, elapsed);
        entries.put(path, new Entry(response.body.clone(), wall, wall, elapsed));
        persist();
    }

    void remove(String path) { if (entries.remove(path) != null) persist(); }

    void clear() throws Failure {
        entries.clear(); principal = null; userId = null;
        store.clear(); // Crypto erase must finish before a successful logout can be reported.
    }

    private boolean prune(long wall, long elapsed) {
        return entries.entrySet().removeIf(item -> {
            Rule rule = rule(item.getKey()); Entry entry = item.getValue();
            return rule == null || wall < entry.savedAt || elapsed < entry.loadedAt || entry.age(wall, elapsed) >= rule.maxMs;
        });
    }

    private void persist() {
        if (principal == null) return;
        try {
            JSONObject records = new JSONObject();
            for (Map.Entry<String, Entry> item : entries.entrySet()) {
                records.put(item.getKey(), new JSONObject().put("savedAt", item.getValue().savedAt)
                    .put("body", utf8(item.getValue().body)));
            }
            byte[] bytes = new JSONObject().put("schema", SCHEMA).put("principal", principal).put("entries", records)
                .toString().getBytes(StandardCharsets.UTF_8);
            // Include JSON envelope/escaping in the cap, not just the response payloads.
            if (bytes.length > MAX_BYTES) throw new IllegalArgumentException();
            store.write(principal, bytes);
        } catch (Exception ignored) {
            entries.clear();
            try { store.clear(); } catch (Failure failure) { principal = null; }
        }
    }

    private boolean valid(String path, byte[] body) {
        Rule rule = rule(path);
        if (rule == null || body.length > rule.maxBytes) return false;
        try {
            JSONObject json = new JSONObject(utf8(body));
            if (containsSecrets(json)) return false;
            if (path.equals(root + "/locations")) return json.length() == 1 && json.getJSONArray("items").length() <= 100;
            return json.length() == 8 && userId.equals(json.getString("viewerUserId"))
                && json.getJSONObject("snapshot") != null && json.getJSONArray("quickActions") != null
                && json.getJSONObject("communities") != null && json.getJSONObject("promotions") != null
                && json.getJSONArray("locations") != null && json.getJSONArray("additionalLinks") != null
                && json.getJSONObject("capabilities") != null;
        } catch (Exception ignored) { return false; }
    }

    private static boolean containsSecrets(Object value) throws Exception {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            for (Iterator<String> keys = object.keys(); keys.hasNext();) {
                String key = keys.next();
                String normalized = key.replace("_", "").replace("-", "").toLowerCase(java.util.Locale.ROOT);
                if (java.util.Arrays.asList("accesstoken", "refreshtoken", "authorization", "cookie", "setcookie",
                    "password", "otp", "phonelast4", "balanceminor").contains(normalized) || containsSecrets(object.get(key))) return true;
            }
        } else if (value instanceof org.json.JSONArray) {
            org.json.JSONArray array = (org.json.JSONArray) value;
            for (int i = 0; i < array.length(); i++) if (containsSecrets(array.get(i))) return true;
        }
        return false;
    }

    private static String utf8(byte[] bytes) throws Exception {
        return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
    }
}
