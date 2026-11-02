package ru.padlhub.app;

import java.util.*;
import java.nio.charset.StandardCharsets;
import java.util.regex.*;
import org.json.*;

/** Two owner-scoped versioned commands; no arbitrary profile mutation. */
final class AndroidProfileSettingsRequest {
  static boolean matches(String path) { return path.startsWith("/profile/privacy") || path.startsWith("/profile/booking-preferences"); }
  private static AndroidSessionPolicy.Failure rejected() { return new AndroidSessionPolicy.Failure("NATIVE_REQUEST_REJECTED"); }
  private static Set<String> keys(JSONObject v) { Set<String> out=new HashSet<>(); v.keys().forEachRemaining(out::add); return out; }
  private static Set<String> set(String... values) { return new HashSet<>(Arrays.asList(values)); }
  private static int count(String body,String key) { Matcher m=Pattern.compile("\""+key+"\"\\s*:").matcher(body); int n=0; while(m.find())n++; return n; }
  static void validateBody(String resource,String body) throws AndroidSessionPolicy.Failure {
    try {
      if(body==null||body.contains("\\")||body.getBytes(StandardCharsets.UTF_8).length>8192)throw rejected();
      JSONTokener parser=new JSONTokener(body); Object parsed=parser.nextValue();
      if(!(parsed instanceof JSONObject)||parser.nextClean()!=0)throw rejected();
      JSONObject v=(JSONObject)parsed;
      Set<String> expected=resource.equals("privacy")?set("expectedVersion","contactPolicy","chatPolicy"):set("expectedVersion","favoriteStationIds","preferredTimeWindows","useHistory","recommendFriends","recommendationDisplay");
      if(!keys(v).equals(expected)||!AndroidGameJoinRequest.integer(v.opt("expectedVersion")))throw rejected();
      for(String key:expected)if(count(body,key)!=1)throw rejected();
      if(resource.equals("privacy")) {
        if(!set("AUTHORIZED","NOBODY").contains(v.opt("contactPolicy"))||!set("AUTHORIZED","NOBODY").contains(v.opt("chatPolicy")))throw rejected();
      } else {
        if(!resource.equals("preferences")||!(v.opt("useHistory") instanceof Boolean)||!(v.opt("recommendFriends") instanceof Boolean)||!set("CARDS","ROWS").contains(v.opt("recommendationDisplay")))throw rejected();
        JSONArray stations=v.getJSONArray("favoriteStationIds"),windows=v.getJSONArray("preferredTimeWindows");
        if(stations.length()>3||windows.length()>14)throw rejected();
        Set<String> seen=new HashSet<>();
        for(int i=0;i<stations.length();i++) {Object id=stations.get(i);if(!(id instanceof String)||!((String)id).matches(AndroidGameJoinRequest.UUID_PATTERN)||!seen.add((String)id))throw rejected();}
        seen.clear();
        for(int i=0;i<windows.length();i++) {
          JSONObject w=windows.getJSONObject(i);Object day=w.opt("weekday"),start=w.opt("startsAt"),end=w.opt("endsAt");
          if(!keys(w).equals(set("weekday","startsAt","endsAt"))||!set("ANY","MON","TUE","WED","THU","FRI","SAT","SUN").contains(day)||!(start instanceof String)||!(end instanceof String)||!((String)start).matches("(?:[01][0-9]|2[0-3]):[0-5][0-9]")||!((String)end).matches("(?:[01][0-9]|2[0-3]):[0-5][0-9]")||((String)start).compareTo((String)end)>=0||!seen.add(day+":"+start+":"+end))throw rejected();
        }
        for(String key:set("weekday","startsAt","endsAt"))if(count(body,key)!=windows.length())throw rejected();
      }
    } catch(AndroidSessionPolicy.Failure e){throw e;} catch(Exception e){throw rejected();}
  }
  static AndroidSessionPolicy.Request request(AndroidSessionPolicy policy,String path,String query,String method,Map<String,String> headers,String body,byte[] binary) throws AndroidSessionPolicy.Failure {
    String resource=path.equals("/profile/privacy")?"privacy":path.equals("/profile/booking-preferences")?"preferences":null;
    if(resource==null||!method.equals("PUT")||query!=null||binary!=null)throw rejected();
    validateBody(resource,body);
    Set<String> allowed=set("authorization","accept","content-type","idempotency-key","x-correlation-id","x-app-platform","x-app-version","x-app-build");
    Map<String,String> h=new HashMap<>();
    for(Map.Entry<String,String> entry:headers.entrySet()) {String key=entry.getKey().toLowerCase(Locale.ROOT),value=entry.getValue();if(!allowed.contains(key)||h.containsKey(key)||value==null||value.length()>8192||value.contains("\r")||value.contains("\n"))throw rejected();h.put(key,value);}
    if(!h.getOrDefault("authorization","").matches("Bearer [A-Za-z0-9._-]{8,8192}")||!h.getOrDefault("idempotency-key","").matches("profile-settings:"+resource+":[0-9a-f]{64}")||!"application/json".equals(h.get("content-type")))throw rejected();
    h.put("accept","application/json");h.put("x-app-platform","android");h.put("x-app-version",policy.version);h.put("x-app-build",policy.build);if(!h.containsKey("x-correlation-id"))h.put("x-correlation-id",UUID.randomUUID().toString());
    return new AndroidSessionPolicy.Request(policy.userRoot+path,"PUT",h,body,AndroidSessionPolicy.Operation.API);
  }
}
