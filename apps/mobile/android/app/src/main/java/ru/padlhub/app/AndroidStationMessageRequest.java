package ru.padlhub.app;

import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import org.json.JSONObject;

/** Only station history, original request status and an explicitly initiated text send. */
final class AndroidStationMessageRequest {
    static final String UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
    private static final String JSON_STRING = "\"(?:[^\"\\\\\\x00-\\x1f]|\\\\(?:[\"\\\\/bfnrt]|u[0-9a-fA-F]{4}))*+\"";
    private static final String ENVELOPE = "\\s*\\{\\s*\"requestId\"\\s*:\\s*" + JSON_STRING + "\\s*,\\s*\"text\"\\s*:\\s*" + JSON_STRING + "\\s*\\}\\s*";
    static boolean matches(String path) { return path.startsWith("/community-views/"); }
    static boolean send(String path, String method) {
        return "POST".equals(method) && path.matches("/community-views/" + UUID + "/message-requests");
    }
    static void validate(String path, String query, String method, Map<String,String> headers, String body, byte[] binary) throws AndroidSessionPolicy.Failure {
        boolean history = path.matches("/community-views/" + UUID + "/chat");
        boolean status = path.matches("/community-views/" + UUID + "/message-requests/" + UUID);
        boolean send = send(path, method);
        if (binary != null || !(send || ("GET".equals(method) && (history || status)))) throw AndroidSessionPolicy.rejected();
        Set<String> allowed = Set.of("authorization","accept","content-type","idempotency-key","x-correlation-id","x-app-platform","x-app-version","x-app-build");
        if (!allowed.containsAll(headers.keySet()) || !headers.getOrDefault("authorization", "").matches("Bearer [A-Za-z0-9._-]{8,8192}")) throw AndroidSessionPolicy.rejected();
        if (query != null) {
            if (!history || query.isEmpty()) throw AndroidSessionPolicy.rejected();
            Set<String> seen = new HashSet<>();
            for (String part : query.split("&", -1)) {
                String[] pair = part.split("=", -1);
                if (pair.length != 2 || !seen.add(pair[0])) throw AndroidSessionPolicy.rejected();
                if (pair[0].equals("limit")) { if (!pair[1].matches("[1-9]|[1-4][0-9]|50")) throw AndroidSessionPolicy.rejected(); }
                else if (!pair[0].equals("cursor") || !pair[1].matches("[A-Za-z0-9_-]{16,512}")) throw AndroidSessionPolicy.rejected();
            }
        }
        if (!send) {
            if (body != null || headers.containsKey("idempotency-key") || (headers.containsKey("content-type") && !headers.get("content-type").equals("application/json"))) throw AndroidSessionPolicy.rejected();
            return;
        }
        if (body == null || body.getBytes(StandardCharsets.UTF_8).length > 65_536 || !body.matches(ENVELOPE) || !"application/json".equals(headers.get("content-type"))) throw AndroidSessionPolicy.rejected();
        try {
            JSONObject json = new JSONObject(body);
            Object id = json.get("requestId"), text = json.get("text");
            if (!(id instanceof String) || !((String)id).matches(UUID) || !id.equals(headers.get("idempotency-key")) || !(text instanceof String) || ((String)text).length() > 8000
                || ((String)text).replaceAll("[\\s\\p{Z}\\uFEFF]", "").isEmpty()) throw AndroidSessionPolicy.rejected();
        } catch (AndroidSessionPolicy.Failure error) { throw error; }
        catch (Exception error) { throw AndroidSessionPolicy.rejected(); }
    }
}
