package ru.padlhub.app;
import java.util.*;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.regex.*;
import org.json.JSONObject;

final class AndroidGameJoinRequest {
  static final String UUID_PATTERN="[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  static boolean matches(String path){return path.matches("/games/[^/]+/join.*")||path.startsWith("/game-operations/");}
  static boolean integer(Object v){return v instanceof Number&&((Number)v).doubleValue()>=0&&((Number)v).doubleValue()<=9007199254740991d&&Math.floor(((Number)v).doubleValue())==((Number)v).doubleValue();}
  static void body(String body)throws AndroidSessionPolicy.Failure {
    try {
      if(body==null||body.contains("\\")||body.getBytes(StandardCharsets.UTF_8).length>2048)throw rejected();
      JSONObject v=new JSONObject(body);Set<String> keys=new HashSet<>();v.keys().forEachRemaining(keys::add);
      if(!new HashSet<>(Arrays.asList("expectedRevision","invitationId","subscriptionInstanceId","priceConsent")).containsAll(keys)||!integer(v.opt("expectedRevision")))throw rejected();
      if(v.has("invitationId")&&(!(v.opt("invitationId") instanceof String)||!v.getString("invitationId").matches(UUID_PATTERN)))throw rejected();
      if(v.has("subscriptionInstanceId")){
        if(!(v.opt("subscriptionInstanceId") instanceof String)||!v.getString("subscriptionInstanceId").matches(UUID_PATTERN))throw rejected();
        JSONObject c=v.getJSONObject("priceConsent");if(c.length()!=2||!integer(c.opt("amountMinor"))||!"RUB".equals(c.opt("currency")))throw rejected();keys.add("amountMinor");keys.add("currency");
      }else if(v.has("priceConsent"))throw rejected();
      for(String key:keys){Matcher m=Pattern.compile("\""+key+"\"\\s*:").matcher(body);int n=0;while(m.find())n++;if(n!=1)throw rejected();}
    }catch(AndroidSessionPolicy.Failure e){throw e;}catch(Exception e){throw rejected();}
  }
  static AndroidSessionPolicy.Request request(AndroidSessionPolicy policy,String path,String rawQuery,String method,Map<String,String> input,String body,byte[] binary)throws AndroidSessionPolicy.Failure {
    if(binary!=null)throw rejected();
    Matcher game=Pattern.compile("/games/("+UUID_PATTERN+")/(join|join-conditions|join-operation)").matcher(path),op=Pattern.compile("/game-operations/("+UUID_PATTERN+")(/reconcile)?").matcher(path);
    String id,resource;
    if(game.matches()){id=game.group(1);resource=game.group(2);}else if(op.matches()){id=op.group(1);resource=op.group(2)==null?"operation":"reconcile";}else throw rejected();
    Map<String,String> h=new HashMap<>();Set<String> allowed=new HashSet<>(Arrays.asList("authorization","accept","content-type","idempotency-key","x-correlation-id","x-app-platform","x-app-version","x-app-build"));
    for(Map.Entry<String,String> e:input.entrySet()){String name=e.getKey().toLowerCase(Locale.ROOT),value=e.getValue();if(!allowed.contains(name)||h.containsKey(name)||value==null||value.length()>8192||value.contains("\r")||value.contains("\n"))throw rejected();h.put(name,value);}
    if(!h.getOrDefault("authorization","").matches("Bearer [A-Za-z0-9._-]{8,8192}"))throw rejected();
    boolean conditions=resource.equals("join-conditions"),join=resource.equals("join"),reconcile=resource.equals("reconcile");
    if(!method.equals(join||reconcile?"POST":"GET"))throw rejected();
    if(conditions){
      if(body!=null||h.containsKey("idempotency-key")||rawQuery==null)throw rejected();
      Map<String,String> q=new HashMap<>();try{for(String pair:rawQuery.split("&",-1)){String[] kv=pair.split("=",-1);if(kv.length!=2)throw rejected();String key=URLDecoder.decode(kv[0],"UTF-8"),value=URLDecoder.decode(kv[1],"UTF-8");if(q.put(key,value)!=null)throw rejected();}
        if(q.size()!=2||!q.getOrDefault("expectedRevision","").matches("[0-9]+")||!q.getOrDefault("subscriptionInstanceId","").matches(UUID_PATTERN))throw rejected();long n=Long.parseLong(q.get("expectedRevision"));if(n<0||n>9007199254740991L)throw rejected();
      }catch(AndroidSessionPolicy.Failure e){throw e;}catch(Exception e){throw rejected();}
    }else{
      if(rawQuery!=null||!h.getOrDefault("idempotency-key","").matches("[A-Za-z0-9][A-Za-z0-9._:-]{15,127}"))throw rejected();
      if(reconcile&&!h.get("idempotency-key").equals("join-reconcile:"+id))throw rejected();
    }
    if(join){body(body);if(h.containsKey("content-type")&&!"application/json".equals(h.get("content-type")))throw rejected();h.put("content-type","application/json");}
    else if(body!=null||h.containsKey("content-type"))throw rejected();
    if(reconcile){body="{}";h.put("content-type","application/json");}
    h.put("accept","application/json");h.put("x-app-platform","android");h.put("x-app-version",policy.version);h.put("x-app-build",policy.build);if(!h.containsKey("x-correlation-id"))h.put("x-correlation-id",UUID.randomUUID().toString());
    return new AndroidSessionPolicy.Request(policy.userRoot+path+(rawQuery==null?"":"?"+rawQuery),method,h,body,AndroidSessionPolicy.Operation.API);
  }
  static AndroidSessionPolicy.Request catalogue(AndroidSessionPolicy policy,String path,String query,String method,Map<String,String> input,String body)throws AndroidSessionPolicy.Failure {
    String root=policy.userRoot.replace("/user/","/public/")+"/games";
    if(!path.equals(root)||!method.equals("GET")||body!=null)throw rejected();
    Map<String,String> h=new HashMap<>();Set<String> allowed=new HashSet<>(Arrays.asList("accept","x-correlation-id","x-app-platform","x-app-version","x-app-build"));
    for(Map.Entry<String,String> e:input.entrySet()){String k=e.getKey().toLowerCase(Locale.ROOT),v=e.getValue();if(!allowed.contains(k)||h.containsKey(k)||v==null||v.length()>8192||v.contains("\r")||v.contains("\n"))throw rejected();h.put(k,v);}
    if(query!=null){Set<String> seen=new HashSet<>();try{for(String part:query.split("&",-1)){String[] p=part.split("=",-1);if(p.length!=2)throw rejected();String k=URLDecoder.decode(p[0],"UTF-8"),v=URLDecoder.decode(p[1],"UTF-8");if(!seen.add(k)||!(k.equals("limit")?v.matches("[1-9]|[1-4][0-9]|50"):k.equals("availability")?v.matches("JOINABLE|INCLUDE_FULL"):k.equals("cursor")?v.matches("[A-Za-z0-9_-]{1,2048}"):false))throw rejected();}}catch(AndroidSessionPolicy.Failure e){throw e;}catch(Exception e){throw rejected();}}
    h.put("accept","application/json");h.put("x-app-platform","android");h.put("x-app-version",policy.version);h.put("x-app-build",policy.build);if(!h.containsKey("x-correlation-id"))h.put("x-correlation-id",UUID.randomUUID().toString());
    return new AndroidSessionPolicy.Request(path+(query==null?"":"?"+query),method,h,null,AndroidSessionPolicy.Operation.PUBLIC);
  }
  private static AndroidSessionPolicy.Failure rejected(){return new AndroidSessionPolicy.Failure("NATIVE_REQUEST_REJECTED");}
}
