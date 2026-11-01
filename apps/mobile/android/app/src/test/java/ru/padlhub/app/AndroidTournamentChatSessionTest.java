package ru.padlhub.app;
import static org.junit.Assert.*;
import org.junit.Test;
import java.util.HashMap;
import java.util.Map;
public class AndroidTournamentChatSessionTest {
 private static final String ID="11111111-1111-4111-8111-111111111111", KEY="22222222-2222-4222-8222-222222222222";
 private static final String ROOT="/user/api/v1/test/tournaments/"+ID+"/chat/";
 private AndroidSessionPolicy policy() throws Exception {return new AndroidSessionPolicy("https://lk2.padlhub.su","test","test","1",false);}
 private Map<String,String> headers(boolean write) {Map<String,String> h=new HashMap<>();h.put("authorization","Bearer synthetic.session");if(write){h.put("content-type","application/json");h.put("idempotency-key",KEY);}return h;}
 private String read(){return "{\"requestId\":\""+KEY+"\",\"streamId\":\""+ID+"\",\"witnessHash\":\""+"a".repeat(64)+"\",\"throughSequence\":42}";}
 private String send(String text){return "{\"requestId\":\""+KEY+"\",\"text\":"+org.json.JSONObject.quote(text)+"}";}
 private void denied(String path,String method,Map<String,String> h,String body) throws Exception {try {policy().request(path,method,h,body);fail(path);}catch(AndroidSessionPolicy.Failure expected){assertEquals("NATIVE_REQUEST_REJECTED",expected.code);}}
 @Test public void sixOperationsUseOriginalIdentity() throws Exception {
  for(String path:new String[]{"messages?limit=50&cursor="+"a".repeat(1800),"read-position","message-requests/"+KEY,"read-requests/"+KEY})assertEquals("GET",policy().request(ROOT+path,"GET",headers(false),null).method);
  for(String path:new String[]{"message-requests","read-requests"})assertEquals(KEY,policy().request(ROOT+path,"POST",headers(true),path.equals("read-requests")?read():send("hello")).headers.get("idempotency-key"));
 }
 @Test public void strictPathsQueriesAndHeaders() throws Exception {
  for(String path:new String[]{"messages?limit=51","messages?limit=1&limit=2","messages?cursor=%61","messages?cursor="+"a".repeat(1801),"messages?","messages#x","read-position?limit=1","../chat/messages","%6dessages","messages/","message-requests/"+KEY+"?x=1"})denied(ROOT+path,"GET",headers(false),null);
  denied(ROOT.replace("/test/","/foreign/")+"messages","GET",headers(false),null);
  Map<String,String> h=headers(true);h.put("cookie","secret");denied(ROOT+"message-requests","POST",h,send("hello"));
  h=headers(true);h.put("idempotency-key",ID);denied(ROOT+"message-requests","POST",h,send("hello"));
 }
 @Test public void unicodeAndDuplicateSendFields() throws Exception {
  for(String text:new String[]{"😀".repeat(4000),"漢".repeat(8000),"\u0085"})policy().request(ROOT+"message-requests","POST",headers(true),send(text));
  for(String text:new String[]{"", " \uFEFF", "\0", "\ud800", "x".repeat(8001)})denied(ROOT+"message-requests","POST",headers(true),send(text));
  denied(ROOT+"message-requests","POST",headers(true),send("a").replace("}",",\"text\":\"b\"}"));
  try{policy().requestBinary(ROOT+"message-requests","POST",headers(true),new byte[]{1});fail("binary");}catch(AndroidSessionPolicy.Failure expected){}
 }
 @Test public void strictReadTupleAndMethods() throws Exception {
  for(String number:new String[]{"true","-1","1.1","9007199254740991","4.2e1","\"42\""})denied(ROOT+"read-requests","POST",headers(true),read().replace(":42",":"+number));
  denied(ROOT+"read-requests","POST",headers(true),read().replace("}",",\"throughSequence\":42}"));
  denied(ROOT+"read-requests","GET",headers(false),null);
  denied(ROOT+"read-position","POST",headers(true),read());
  denied(ROOT+"read-requests","POST",headers(true),read()+" ".repeat(17000));
 }
 @Test public void engineNeverRetriesEitherCommandAndUsesOriginalGetRecovery() throws Exception {
  for(String path:new String[]{"message-requests","read-requests"})for(int status:new int[]{401,403,404,503,0}) {
   java.util.List<AndroidSessionPolicy.Request> sent=new java.util.ArrayList<>();
   AndroidGameJoinSessionTest.MemoryStore store=new AndroidGameJoinSessionTest.MemoryStore();store.value=new AndroidSessionEngine.Credential("https://lk2.padlhub.su|test","s".repeat(40),System.currentTimeMillis()+60000,null,null);
   AndroidSessionEngine engine=new AndroidSessionEngine(policy(),store,request->{sent.add(request);if(status==0 && request.method.equals("POST"))throw new AndroidSessionPolicy.Failure("NATIVE_NETWORK_UNAVAILABLE");return new AndroidSessionEngine.Response(request.method.equals("POST")?status:200,java.util.Collections.emptyMap(),java.util.Collections.emptyList(),"{}".getBytes(java.nio.charset.StandardCharsets.UTF_8));});
   try {assertEquals(status,engine.request(ROOT+path,"POST",headers(true),path.equals("read-requests")?read():send("hello")).status);assertNotEquals(0,status);}catch(AndroidSessionPolicy.Failure error){assertEquals(0,status);}
   assertEquals(1,sent.size());engine.request(ROOT+path+"/"+KEY,"GET",headers(false),null);assertEquals(2,sent.size());assertEquals("GET",sent.get(1).method);
  }
 }
 @Test public void onlyHistoryGetsThreeMiBInSenderAndEngine() throws Exception {
  AndroidSessionPolicy p=policy();AndroidSessionPolicy.Request history=p.request(ROOT+"messages?limit=50","GET",headers(false),null);
  assertEquals(3*1024*1024,AndroidHttpSender.responseLimit(history));
  for(String path:new String[]{"read-position","message-requests/"+KEY,"read-requests/"+KEY})assertEquals(1024*1024,AndroidHttpSender.responseLimit(p.request(ROOT+path,"GET",headers(false),null)));
  for(int size:new int[]{2_400_000,3*1024*1024+1}) {
   AndroidGameJoinSessionTest.MemoryStore store=new AndroidGameJoinSessionTest.MemoryStore();store.value=new AndroidSessionEngine.Credential("https://lk2.padlhub.su|test","s".repeat(40),System.currentTimeMillis()+60000,null,null);
   AndroidSessionEngine engine=new AndroidSessionEngine(p,store,request->new AndroidSessionEngine.Response(200,java.util.Collections.emptyMap(),java.util.Collections.emptyList(),new byte[size]));
   try {assertEquals(size,engine.request(history.path,"GET",headers(false),null).body.length);assertTrue(size<=3*1024*1024);}catch(AndroidSessionPolicy.Failure e){assertTrue(size>3*1024*1024);}
   try {engine.request(ROOT+"read-position","GET",headers(false),null);fail("lower cap");}catch(AndroidSessionPolicy.Failure expected){}
  }
 }
}
