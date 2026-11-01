package ru.padlhub.app;

import java.time.Instant;
import java.util.*;
import java.util.regex.*;
import org.json.JSONObject;

/** Exact private CREATE paths; no legacy/provider/general write capability. */
final class AndroidQuarterCreateRequest {
  private static final String UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  static void validate(String path, String query, String method, Map<String,String> headers, String body) throws AndroidSessionPolicy.Failure {
    if (query != null) throw AndroidSessionPolicy.rejected();
    boolean read = "GET".equals(method) && Arrays.asList("/game-create-operations/capability","/game-create-operations/locations","/game-create-operations/by-key").contains(path);
    boolean write = "POST".equals(method) && (path.equals("/game-create-operations") || path.matches("/game-create-operations/"+UUID+"/reconcile"));
    if (!read && !write) throw AndroidSessionPolicy.rejected();
    boolean keyed = write || path.endsWith("/by-key");
    if (keyed ? !headers.getOrDefault("idempotency-key","").matches("[A-Za-z0-9._:-]{16,128}") : headers.containsKey("idempotency-key")) throw AndroidSessionPolicy.rejected();
    if (read) {if (body != null) throw AndroidSessionPolicy.rejected();return;}
    try {
      if (body == null || body.length() > 1024 || (headers.containsKey("content-type") && !"application/json".equalsIgnoreCase(headers.get("content-type")))) throw AndroidSessionPolicy.rejected();
      String property = "\"(?:stationId|courtId|startsAt|subscriptionId)\"\\s*:\\s*\"[^\"\\\\\\x00-\\x1f]*\"";
      if (!body.matches("\\s*\\{\\s*"+property+"(?:\\s*,\\s*"+property+"){3}\\s*\\}\\s*")) throw AndroidSessionPolicy.rejected();
      JSONObject x = new JSONObject(body);
      if (x.length()!=4) throw AndroidSessionPolicy.rejected();
      for(String key:Arrays.asList("stationId","courtId","subscriptionId")) if (!(x.get(key) instanceof String) || !x.getString(key).matches(UUID)) throw AndroidSessionPolicy.rejected();
      String date = x.getString("startsAt");
      if (!date.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00\\.000Z") || date.startsWith("0000") || !Instant.parse(date).toString().equals(date.replace(".000Z","Z"))) throw AndroidSessionPolicy.rejected();
    } catch (AndroidSessionPolicy.Failure e) {throw e;} catch (Exception e) {throw AndroidSessionPolicy.rejected();}
  }
}
