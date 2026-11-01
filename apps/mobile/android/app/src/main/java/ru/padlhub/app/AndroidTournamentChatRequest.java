package ru.padlhub.app;

import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import org.json.JSONObject;

/** Only six tournament chat operations; validated again independently of JavaScript. */
final class AndroidTournamentChatRequest {
    static final String UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
    private static final String JSON_STRING = "\"(?:[^\"\\\\\\x00-\\x1f]|\\\\(?:[\"\\\\/bfnrt]|u[0-9a-fA-F]{4}))*+\"";
    private static final String ENVELOPE = "\\s*\\{\\s*\"requestId\"\\s*:\\s*" + JSON_STRING + "\\s*,\\s*\"text\"\\s*:\\s*" + JSON_STRING + "\\s*\\}\\s*";
    static boolean history(AndroidSessionPolicy.Request request) {
        return "GET".equals(request.method) && request.path.matches("/user/api/v1/[a-z0-9][a-z0-9-]{1,62}/tournaments/" + UUID + "/chat/messages(?:\\?[^#]*)?");
    }
    static boolean matches(String path) { return path.startsWith("/tournaments/"); }
    static boolean send(String path, String method) {
        return "POST".equals(method) && path.matches("/tournaments/" + UUID + "/chat/message-requests");
    }
    static void validate(String path, String query, String method, Map<String,String> headers, String body, byte[] binary) throws AndroidSessionPolicy.Failure {
        boolean history = path.matches("/tournaments/" + UUID + "/chat/messages");
        boolean status = path.matches("/tournaments/" + UUID + "/chat/message-requests/" + UUID);
        boolean send = send(path, method);
        boolean read = "POST".equals(method) && path.matches("/tournaments/" + UUID + "/chat/read-requests");
        boolean position = path.matches("/tournaments/" + UUID + "/chat/read-position");
        boolean readStatus = path.matches("/tournaments/" + UUID + "/chat/read-requests/" + UUID);
        if (binary != null || !(send || read || ("GET".equals(method) && (history || status || position || readStatus)))) throw AndroidSessionPolicy.rejected();
        Set<String> allowed = Set.of("authorization","accept","content-type","idempotency-key","x-correlation-id","x-app-platform","x-app-version","x-app-build");
        if (!allowed.containsAll(headers.keySet()) || !headers.getOrDefault("authorization", "").matches("Bearer [A-Za-z0-9._-]{8,8192}")) throw AndroidSessionPolicy.rejected();
        if (query != null) {
            if (!history || query.isEmpty() || query.length() > 1840) throw AndroidSessionPolicy.rejected();
            Set<String> seen = new HashSet<>();
            for (String part : query.split("&", -1)) {
                String[] pair = part.split("=", -1);
                if (pair.length != 2 || !seen.add(pair[0])) throw AndroidSessionPolicy.rejected();
                if (pair[0].equals("limit")) { if (!pair[1].matches("[1-9]|[1-4][0-9]|50")) throw AndroidSessionPolicy.rejected(); }
                else if (!pair[0].equals("cursor") || !pair[1].matches("[A-Za-z0-9_-]{1,1800}")) throw AndroidSessionPolicy.rejected();
            }
        }
        if (read) {
            String readEnvelope = "\\s*\\{\\s*\"requestId\"\\s*:\\s*\"" + UUID + "\"\\s*,\\s*\"streamId\"\\s*:\\s*\"" + UUID + "\"\\s*,\\s*\"witnessHash\"\\s*:\\s*\"[a-f0-9]{64}\"\\s*,\\s*\"throughSequence\"\\s*:\\s*(?:0|[1-9][0-9]*)\\s*\\}\\s*";
            if (query != null || body == null || body.getBytes(StandardCharsets.UTF_8).length > 65536 || !body.matches(readEnvelope) || !"application/json".equals(headers.get("content-type"))) throw AndroidSessionPolicy.rejected();
            try {
                JSONObject json = new JSONObject(body);
                Object value = json.get("throughSequence");
                if (!json.getString("requestId").equals(headers.get("idempotency-key")) || !(value instanceof Integer || value instanceof Long) || ((Number)value).longValue() < 0 || ((Number)value).longValue() > 9007199254740990L) throw AndroidSessionPolicy.rejected();
            } catch (AndroidSessionPolicy.Failure error) { throw error; }
            catch (Exception error) { throw AndroidSessionPolicy.rejected(); }
            return;
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
                || ((String)text).indexOf('\0') >= 0 || ((String)text).getBytes(StandardCharsets.UTF_8).length > 32000
                || !new String(((String)text).getBytes(StandardCharsets.UTF_8),StandardCharsets.UTF_8).equals(text)
                || ((String)text).replaceAll("[\\x09-\\x0D\\x20\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]", "").isEmpty()) throw AndroidSessionPolicy.rejected();
        } catch (AndroidSessionPolicy.Failure error) { throw error; }
        catch (Exception error) { throw AndroidSessionPolicy.rejected(); }
    }
}
