package ru.padlhub.app;

import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

final class AndroidSelfLeaveRequest {
  static boolean matches(String path) { return path.matches("/games/[^/]+/(?:participants|leave-operation)(?:/.*)?"); }
  static AndroidSessionPolicy.Request request(AndroidSessionPolicy policy,String path,String query,String method,Map<String,String> input,String body,byte[] binary) throws AndroidSessionPolicy.Failure {
    String uuid="[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
    boolean leave=path.matches("/games/"+uuid+"/participants/me"),status=path.matches("/games/"+uuid+"/leave-operation"),retry=path.matches("/games/"+uuid+"/leave-operation/reconcile");
    if (query!=null || body!=null || binary!=null || !(leave&&"DELETE".equals(method) || status&&"GET".equals(method) || retry&&"POST".equals(method))) throw rejected();
    Set<String> allowed=new HashSet<>(Arrays.asList("authorization","accept","content-type","idempotency-key","x-correlation-id","x-app-platform","x-app-version","x-app-build"));
    Map<String,String> headers=new HashMap<>();
    for(Map.Entry<String,String> e:input.entrySet()) {
      String name=e.getKey().toLowerCase(Locale.ROOT),value=e.getValue();
      if(!allowed.contains(name)||headers.containsKey(name)||value==null||value.length()>8192||value.contains("\r")||value.contains("\n"))throw rejected();
      headers.put(name,value);
    }
    if(!headers.getOrDefault("authorization","").matches("Bearer [A-Za-z0-9._-]{8,8192}") || !headers.getOrDefault("idempotency-key","").matches("[A-Za-z0-9][A-Za-z0-9._:-]{15,127}") || headers.containsKey("content-type")&&!"text/plain".equals(headers.get("content-type")))throw rejected();
    headers.put("accept","application/json");headers.put("x-app-platform","android");headers.put("x-app-version",policy.version);headers.put("x-app-build",policy.build);
    if(!headers.containsKey("x-correlation-id"))headers.put("x-correlation-id",UUID.randomUUID().toString());
    // Suppress HttpsURLConnection's implicit form encoding for an empty POST/DELETE.
    if(!status)headers.put("content-type","text/plain");
    return new AndroidSessionPolicy.Request(policy.userRoot+path,method,headers,(String)null,AndroidSessionPolicy.Operation.API);
  }
  private static AndroidSessionPolicy.Failure rejected(){return new AndroidSessionPolicy.Failure("NATIVE_REQUEST_REJECTED");}
}
