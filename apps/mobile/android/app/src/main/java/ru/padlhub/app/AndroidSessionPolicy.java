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
    private static final String TRAINING_UUID = "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}";
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
        final byte[] body;
        final String contentType;
        final Operation operation;
        Request(String path, String method, Map<String, String> headers, String body, Operation operation) {
            this(path, method, headers, body == null ? null : body.getBytes(StandardCharsets.UTF_8),
                body == null ? null : "application/json", operation);
        }
        private Request(String path, String method, Map<String, String> headers, byte[] body, String contentType, Operation operation) {
            this.path = path; this.method = method; this.headers = headers;
            this.body = body; this.contentType = contentType; this.operation = operation;
        }
    }

    Request request(String path, String method, Map<String, String> inputHeaders, String body) throws Failure {
        return request(path, method, inputHeaders, body, null);
    }

    Request requestBinary(String path, String method, Map<String, String> inputHeaders, byte[] body) throws Failure {
        return request(path, method, inputHeaders, null, body);
    }

    private Request request(String path, String method, Map<String, String> inputHeaders, String textBody, byte[] binaryBody) throws Failure {
        if (textBody != null && binaryBody != null) throw rejected();
        if (path == null || path.length() > 8192 || path.contains("\\") || path.contains("#")
            || path.contains("\r") || path.contains("\n")) throw rejected();
        final URI uri;
        try { uri = new URI(path); } catch (Exception ignored) { throw rejected(); }
        String cleanPath = uri.getRawPath();
        if (uri.isAbsolute() || uri.getRawAuthority() != null || cleanPath == null
            || cleanPath.contains("%") || cleanPath.contains("..") || cleanPath.contains("//")) throw rejected();
        if (!cleanPath.startsWith(userRoot + "/")) throw rejected();
        String relativePath = cleanPath.substring(userRoot.length());
        if (!validQuery(relativePath, method, (relativePath.startsWith("/games") || relativePath.startsWith("/trainings/")) ? uri.getRawQuery() : uri.getQuery())) throw rejected();
        String gameUuid = "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";
        boolean trainingRegistration = "POST".equals(method) && relativePath.matches("/trainings/" + TRAINING_UUID + "/registrations");
        boolean trainingRecovery = "GET".equals(method) && relativePath.matches("/trainings/" + TRAINING_UUID + "/registration-operation");
        boolean gameJoin = "POST".equals(method) && relativePath.matches("/games/" + gameUuid + "/join");
        // Canonical receipt reconciliation (merged main #455): GET-only recovery advanced the
        // operation; this POST asks the owner for the trusted receipt on the same idempotency key.
        boolean gameReconcile = "POST".equals(method) && relativePath.matches("/game-operations/" + gameUuid + "/reconcile");
        boolean gameRecovery = "GET".equals(method) && relativePath.matches("/games/" + gameUuid + "/join-operation");

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
            if (!("GET".equals(method) && allowedRead(relativePath))
                && !notificationWrite && !gameJoin && !gameReconcile && !trainingRegistration && !allowedMessagingWrite(relativePath, method)) throw rejected();
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
        if ((gameJoin || gameReconcile || gameRecovery || trainingRegistration || trainingRecovery) && !headers.getOrDefault("idempotency-key", "").matches("[A-Za-z0-9][A-Za-z0-9._:-]{15,127}")) throw rejected();
        String intent = operation == Operation.REFRESH ? "refresh" : operation == Operation.LOGOUT ? "logout" : null;
        if (!java.util.Objects.equals(intent, headers.get("x-session-intent"))) throw rejected();
        headers.put("accept", isBinaryContentRead(relativePath, method) ? "*/*" : "application/json");
        headers.put("x-app-platform", "android");
        headers.put("x-app-version", version);
        headers.put("x-app-build", build);
        if (!headers.containsKey("x-correlation-id")) headers.put("x-correlation-id", UUID.randomUUID().toString());
        boolean relay = isConversationMediaRelay(relativePath, method);
        if (binaryBody != null) {
            if (!relay || binaryBody.length < 1 || binaryBody.length > 15 * 1024 * 1024) throw rejected();
            headers.put("content-type", "application/octet-stream");
            return new Request(path, method, headers, binaryBody, "application/octet-stream", operation);
        }
        if (textBody != null && textBody.getBytes(StandardCharsets.UTF_8).length > maxJsonBodyBytes(relativePath, method)) throw rejected();
        if (trainingRegistration) validateTrainingBody(textBody);
        if (operation == Operation.CHALLENGE || operation == Operation.VERIFY) validateAuthBody(operation, textBody);
        else if (("GET".equals(method) || auth) && textBody != null) throw rejected();
        if (textBody != null) headers.put("content-type", "application/json");
        return new Request(path, method, headers, textBody, operation);
    }

    private boolean allowedRead(String path) {
        // Only reviewed PadlHub routes; media and provider handoffs remain separate capabilities.
        if (Arrays.asList("/context", "/routing-plan", "/profile", "/profile/privacy",
            "/profile/friends", "/profile/friend-requests", "/profile/level-history",
            "/profile/level", "/profile/level-assessment", "/profile/booking-preferences",
            "/bookings/upcoming", "/bookings/history", "/recommendations/bookings",
            "/home", "/home/base", "/locations", "/communities/mine", "/conversations",
            "/notifications", "/notifications/preferences", "/support/stations", "/support/dialogs",
            "/notification-endpoints/android/config", "/games").contains(path)) return true;
        String uuid = "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";
        if (path.equals("/trainings/catalog") || path.matches("/trainings/" + TRAINING_UUID + "/registration-operation")) return true;
        if (path.matches("/games/" + uuid + "(?:/join-conditions|/join-operation)?")) return true;
        if (path.matches("/conversations/" + uuid + "/messages")
            || path.matches("/conversations/" + uuid + "/media/" + uuid)
            || path.matches("/conversations/" + uuid + "/media/" + uuid + "/content")
            || path.matches("/support/dialogs/" + uuid + "/messages")
            || path.matches("/support/attachments/[A-Za-z0-9_-]{43}/content")) return true;
        return path.matches("/(?:profiles|profile/friends|locations)/[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}");
    }

    private boolean allowedMessagingWrite(String path, String method) {
        String uuid = "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";
        if ("POST".equals(method)) return path.equals("/conversations/direct")
            || path.equals("/conversations/game") || path.equals("/messaging/realtime-ticket")
            || path.equals("/support/messages") || path.equals("/support/attachments")
            || path.equals("/notification-endpoints/android")
            || path.matches("/conversations/" + uuid + "/(?:messages|media/uploads)")
            || path.matches("/conversations/" + uuid + "/media/" + uuid + "/finalize");
        if ("PUT".equals(method)) return path.matches("/conversations/" + uuid + "/(?:read-cursor|notification-policy)")
            || path.matches("/conversations/" + uuid + "/media/" + uuid + "/bytes");
        return "DELETE".equals(method) && path.matches("/notification-endpoints/android/" + uuid);
    }

    private boolean isConversationMediaRelay(String path, String method) {
        String uuid = "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";
        return "PUT".equals(method) && path.matches("/conversations/" + uuid + "/media/" + uuid + "/bytes");
    }

    private boolean isBinaryContentRead(String path, String method) {
        String uuid = "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";
        return "GET".equals(method) && (path.matches("/conversations/" + uuid + "/media/" + uuid + "/content")
            || path.matches("/support/attachments/[A-Za-z0-9_-]{43}/content"));
    }

    private int maxJsonBodyBytes(String path, String method) {
        return "POST".equals(method) && "/support/attachments".equals(path) ? 11_188_907 : 16_384;
    }

    private boolean validQuery(String path, String method, String query) {
        if (!"GET".equals(method)) return query == null;
        String uuid = "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";
        if (path.equals("/trainings/catalog")) return validTrainingCatalogueQuery(query, TRAINING_UUID);
        if (path.matches("/trainings/" + TRAINING_UUID + "/registration-operation")) return query == null;
        if (path.equals("/games")) {
            if (query == null) return true;
            Set<String> seen = new HashSet<>();
            for (String part : query.split("&", -1)) {
                String[] pair = part.split("=", 2);
                if (pair.length != 2 || !seen.add(pair[0])) return false;
                if (pair[0].equals("scope")) { if (!pair[1].matches("UPCOMING|HISTORY")) return false; }
                else if (pair[0].equals("limit")) { if (!pair[1].matches("[1-9]|[1-9][0-9]|100")) return false; }
                else if (pair[0].equals("cursor")) { if (!pair[1].matches("[A-Za-z0-9_-]{1,2048}")) return false; }
                else return false;
            }
            return true;
        }
        if (path.matches("/games/" + uuid + "/join-conditions")) {
            if (query == null) return false;
            Map<String, String> values = new HashMap<>();
            for (String part : query.split("&", -1)) {
                String[] pair = part.split("=", 2);
                if (pair.length != 2 || values.put(pair[0], pair[1]) != null) return false;
            }
            String revision = values.getOrDefault("expectedRevision", "");
            return values.size() == 2 && values.getOrDefault("subscriptionInstanceId", "").matches(uuid)
                && revision.matches("0|[1-9][0-9]{0,15}") && Long.parseLong(revision) <= 9_007_199_254_740_991L;
        }
        if (path.matches("/games/" + uuid + "(?:/join-operation)?")) return query == null;
        if (path.matches("/conversations/" + uuid + "/messages"))
            return query == null || query.matches("(?:afterSequence=(?:0|[1-9][0-9]{0,8}))(?:&limit=(?:[1-9]|[1-9][0-9]|100))?|limit=(?:[1-9]|[1-9][0-9]|100)(?:&afterSequence=(?:0|[1-9][0-9]{0,8}))?");
        if (path.matches("/support/dialogs/" + uuid + "/messages"))
            return query == null || query.matches("before=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}(?::|%3A)[0-9]{2}(?::|%3A)[0-9]{2}(?:\\.[0-9]{1,3})?(?:Z|[+-][0-9]{2}(?::|%3A)[0-9]{2})");
        if (path.equals("/support/stations") || path.equals("/support/dialogs")) return query == null;
        if (path.matches("/conversations/" + uuid + "/media/" + uuid + "(?:/content)?")
            || path.matches("/support/attachments/[A-Za-z0-9_-]{43}/content")) return query == null;
        return true;
    }

    private boolean validTrainingDate(String value) {
        if (value == null || !value.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}")) return false;
        java.text.SimpleDateFormat format = new java.text.SimpleDateFormat("yyyy-MM-dd", Locale.ROOT);
        format.setLenient(false);
        format.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        java.text.ParsePosition position = new java.text.ParsePosition(0);
        return format.parse(value, position) != null && position.getIndex() == value.length();
    }

    private boolean validTrainingCatalogueQuery(String query, String uuid) {
        if (query == null || query.length() > 8192) return false;
        Map<String, String> values = new HashMap<>();
        try {
            for (String part : query.split("&", -1)) {
                String[] pair = part.split("=", -1);
                if (pair.length != 2 || !pair[0].matches("[A-Za-z]+")) return false;
                String value = java.net.URLDecoder.decode(pair[1], "UTF-8");
                if (values.put(pair[0], value) != null) return false;
            }
        } catch (Exception ignored) { return false; }
        for (Map.Entry<String, String> entry : values.entrySet()) {
            String key = entry.getKey(), value = entry.getValue();
            if (key.equals("limit")) { if (!value.matches("[1-9]|[1-4][0-9]|50")) return false; }
            else if (key.equals("cursor")) { if (!value.matches(uuid)) return false; }
            else if (key.equals("localDates")) {
                String[] dates = value.split(",", -1);
                if (dates.length < 1 || dates.length > 7 || new HashSet<>(Arrays.asList(dates)).size() != dates.length) return false;
                for (String date : dates) if (!validTrainingDate(date)) return false;
            } else if (key.equals("kinds")) {
                if (!value.matches("(?:COACH_GAME|GROUP_TRAINING|SPLIT)(?:,(?:COACH_GAME|GROUP_TRAINING|SPLIT)){0,2}")) return false;
            } else if (key.equals("categoryIds") || key.equals("stationIds")) {
                if (!value.matches(uuid + "(?:," + uuid + "){0,49}")) return false;
            } else if (key.equals("availability")) { if (!value.matches("INCLUDE_FULL|EXCLUDE_FULL")) return false; }
            else if (key.equals("levelFrom") || key.equals("levelTo")) { if (!value.matches("D\\+?|C\\+?|B\\+?|A")) return false; }
            else if (key.equals("startsAfterLocal")) { if (!value.matches("(?:[01][0-9]|2[0-3]):[0-5][0-9]")) return false; }
            else return false;
        }
        if (values.containsKey("cursor")) return values.size() == (values.containsKey("limit") ? 2 : 1);
        return values.containsKey("localDates") && values.containsKey("kinds") && values.containsKey("availability");
    }

    private void validateTrainingBody(String body) throws Failure {
        String uuid = "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}";
        String date = "\\\"dateHint\\\"\\s*:\\s*\\\"[0-9]{4}-[0-9]{2}-[0-9]{2}\\\"";
        String sub = "\\\"subscriptionId\\\"\\s*:\\s*\\\"" + uuid + "\\\"";
        if (body == null || body.length() > 256 || !body.matches("\\s*\\{\\s*(?:" + date + "\\s*,\\s*" + sub + "|" + sub + "\\s*,\\s*" + date + ")\\s*\\}\\s*")) throw rejected();
        try {
            JSONObject parsed = new JSONObject(body);
            if (parsed.length() != 2 || !validTrainingDate(parsed.getString("dateHint"))) throw rejected();
        } catch (Failure error) { throw error; }
        catch (Exception ignored) { throw rejected(); }
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
