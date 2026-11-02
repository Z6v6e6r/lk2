package ru.padlhub.app;

import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import org.json.JSONObject;

/** Concrete v3 history and original read-request transport; no generic community command. */
final class AndroidStationStreamRequest {
    private static final String UUID = AndroidStationMessageRequest.UUID;
    // Both callers receive only the already policy-validated request; do not widen old /chat.
    static boolean history(AndroidSessionPolicy.Request request) {
        return "GET".equals(request.method) && request.path.matches("/user/api/v1/[a-z0-9][a-z0-9-]{1,62}/community-views/" + UUID + "/station-stream(?:\\?[^#]*)?");
    }
    static boolean matches(String path) {
        return path.startsWith("/community-views/") && (path.contains("station-stream") || path.contains("read-requests"));
    }
    static void validate(String path, String query, String method, Map<String,String> headers, String body, byte[] binary) throws AndroidSessionPolicy.Failure {
        boolean summaries = path.equals("/community-views/station-stream-summaries");
        boolean stream = path.matches("/community-views/" + UUID + "/station-stream");
        boolean read = path.matches("/community-views/" + UUID + "/read-requests");
        boolean status = path.matches("/community-views/" + UUID + "/read-requests/" + UUID);
        if (binary != null || !(read ? "POST".equals(method) : "GET".equals(method) && (summaries || stream || status))) throw AndroidSessionPolicy.rejected();
        Set<String> allowed = Set.of("authorization","accept","content-type","idempotency-key","x-correlation-id","x-app-platform","x-app-version","x-app-build");
        if (!allowed.containsAll(headers.keySet()) || !headers.getOrDefault("authorization", "").matches("Bearer [A-Za-z0-9._-]{8,8192}")) throw AndroidSessionPolicy.rejected();
        Set<String> keys = new HashSet<>();
        if (query != null) {
            if (query.isEmpty() || query.length() > 1960) throw AndroidSessionPolicy.rejected();
            for (String part : query.split("&", -1)) {
                String[] pair = part.split("=", -1);
                if (pair.length != 2 || !keys.add(pair[0])) throw AndroidSessionPolicy.rejected();
                if (summaries && pair[0].equals("communityIds")) {
                    if (!pair[1].matches(UUID + "(?:(?:%2C|,)" + UUID + "){0,49}")) throw AndroidSessionPolicy.rejected();
                    String[] ids = pair[1].split("%2C|,", -1);
                    if (new HashSet<>(java.util.Arrays.asList(ids)).size() != ids.length) throw AndroidSessionPolicy.rejected();
                } else if (!(stream && (pair[0].equals("limit") ? pair[1].matches("[1-9]|[1-4][0-9]|50") : pair[0].equals("cursor") && pair[1].matches("[A-Za-z0-9_-]{16,1024}")))) throw AndroidSessionPolicy.rejected();
            }
        }
        if (summaries && !keys.contains("communityIds")) throw AndroidSessionPolicy.rejected();
        if (!read) {
            if (body != null || headers.containsKey("idempotency-key") || (headers.containsKey("content-type") && !headers.get("content-type").equals("application/json"))) throw AndroidSessionPolicy.rejected();
            return;
        }
        String envelope = "\\s*\\{\\s*\"requestId\"\\s*:\\s*\"" + UUID + "\"\\s*,\\s*\"streamId\"\\s*:\\s*\"" + UUID + "\"\\s*,\\s*\"membershipEpoch\"\\s*:\\s*(?:0|[1-9][0-9]*)\\s*,\\s*\"throughSequence\"\\s*:\\s*(?:0|[1-9][0-9]*)\\s*\\}\\s*";
        if (query != null || body == null || body.getBytes(StandardCharsets.UTF_8).length > 16384 || !body.matches(envelope) || !"application/json".equals(headers.get("content-type"))) throw AndroidSessionPolicy.rejected();
        try {
            JSONObject json = new JSONObject(body);
            if (!json.getString("requestId").equals(headers.get("idempotency-key"))) throw AndroidSessionPolicy.rejected();
            for (String field : new String[]{"membershipEpoch","throughSequence"}) {
                Object value = json.get(field);
                if (!(value instanceof Integer || value instanceof Long) || ((Number)value).longValue() < 0 || ((Number)value).longValue() > 9007199254740990L) throw AndroidSessionPolicy.rejected();
            }
        } catch (AndroidSessionPolicy.Failure error) { throw error; }
        catch (Exception error) { throw AndroidSessionPolicy.rejected(); }
    }
}
