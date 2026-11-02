package ru.padlhub.app;
import static org.junit.Assert.*;
import org.junit.Test;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONObject;
public class AndroidStationMessageSessionTest {
 private static final String ID="11111111-1111-4111-8111-111111111111", KEY="22222222-2222-4222-8222-222222222222";
 private static final String ROOT="/user/api/v1/test/community-views/"+ID;
 private AndroidSessionPolicy policy() throws Exception {return new AndroidSessionPolicy("https://lk2.padlhub.su","test","test","1",false);}
 private Map<String,String> headers(boolean send) {Map<String,String> h=new HashMap<>();h.put("authorization","Bearer synthetic.session");if(send){h.put("content-type","application/json");h.put("idempotency-key",KEY);}return h;}
 private String body(String text){return "{\"requestId\":\""+KEY+"\",\"text\":"+JSONObject.quote(text)+"}";}
 private void denied(String path,String method,Map<String,String> h,String body) throws Exception {try{policy().request(path,method,h,body);fail("must reject");}catch(AndroidSessionPolicy.Failure e){assertEquals("NATIVE_REQUEST_REJECTED",e.code);}}
 @Test public void exactRoutesAndUtf16Limit() throws Exception {
  assertEquals("POST",policy().request(ROOT+"/message-requests","POST",headers(true),body("я".repeat(8000))).method);
  policy().request(ROOT+"/message-requests","POST",headers(true),body("😀".repeat(4000)));
  policy().request(ROOT+"/message-requests","POST",headers(true),body("\n".repeat(7999)+"a"));
  policy().request(ROOT+"/chat?limit=50&cursor="+"a".repeat(20),"GET",headers(false),null);
  policy().request(ROOT+"/message-requests/"+KEY,"GET",headers(false),null);
 }
 @Test public void strictBodyAndHeaders() throws Exception {
  for(String b:new String[]{body("a".repeat(8001)),body("\n\t "),body("x")+"{}",body("x").replace("}",",\"actor\":\"x\"}"),body("x").replace("}",",\"text\":\"x\"}")})denied(ROOT+"/message-requests","POST",headers(true),b);
  Map<String,String> h=headers(true);h.put("idempotency-key",ID);denied(ROOT+"/message-requests","POST",h,body("x"));
  h=headers(true);h.put("x-session-intent","refresh");denied(ROOT+"/message-requests","POST",h,body("x"));
  h=headers(true);h.put("content-type","text/plain");denied(ROOT+"/message-requests","POST",h,body("x"));
 }
 @Test public void rawQueryRouteAndReadOnlyNegatives() throws Exception {
  for(String path:new String[]{ROOT+"/chat?limit=51",ROOT+"/chat?limit=1&limit=2",ROOT+"/chat?cursor=%61aaaaaaaaaaaaaaa",ROOT+"/chat?phone=1",ROOT+"/message-requests/"+KEY+"?x=1",ROOT+"/chat?",ROOT+"/../chat",ROOT.replace("-4111-","-0111-")+"/chat"})denied(path,"GET",headers(false),null);
  denied(ROOT+"/chat","POST",headers(true),body("x"));denied(ROOT+"/message-requests","DELETE",headers(true),null);denied(ROOT+"/chat","GET",headers(false),"{}");
  try{policy().requestBinary(ROOT+"/message-requests","POST",headers(true),new byte[]{1});fail("binary");}catch(AndroidSessionPolicy.Failure expected){}
 }
 @Test public void otherCommandsKeepSixteenKiBBound() throws Exception {
  denied("/user/api/v1/test/conversations/"+ID+"/messages","POST",headers(true),body("я".repeat(8000))+" ".repeat(500));
 }
 @Test public void actualEngineDoesNotRetryStationPostAndRecoversOnlyByGet() throws Exception {
  for(int status:new int[]{401,403,404,503,0}) {
   java.util.List<AndroidSessionPolicy.Request> sent=new java.util.ArrayList<>();
   AndroidGameJoinSessionTest.MemoryStore store=new AndroidGameJoinSessionTest.MemoryStore();
   store.value=new AndroidSessionEngine.Credential("https://lk2.padlhub.su|test","s".repeat(40),System.currentTimeMillis()+60000,null,null);
   AndroidSessionEngine engine=new AndroidSessionEngine(policy(),store,request->{
    sent.add(request);
    if(status==0 && request.method.equals("POST"))throw new AndroidSessionPolicy.Failure("NATIVE_NETWORK_UNAVAILABLE");
    return new AndroidSessionEngine.Response(request.method.equals("POST")?status:200,java.util.Collections.emptyMap(),java.util.Collections.emptyList(),"{}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
   });
   try {assertEquals(status,engine.request(ROOT+"/message-requests","POST",headers(true),body("original")).status);assertNotEquals(0,status);}
   catch(AndroidSessionPolicy.Failure error){assertEquals(0,status);assertEquals("NATIVE_NETWORK_UNAVAILABLE",error.code);}
   assertEquals(1,sent.size());
   engine.request(ROOT+"/message-requests/"+KEY,"GET",headers(false),null);
   assertEquals(2,sent.size());assertEquals("GET",sent.get(1).method);assertEquals(KEY,sent.get(0).headers.get("idempotency-key"));
  }
 }
}
