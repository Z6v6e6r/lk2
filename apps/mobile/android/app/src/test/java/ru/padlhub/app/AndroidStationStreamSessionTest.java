package ru.padlhub.app;
import static org.junit.Assert.*;
import org.junit.Test;
import java.util.HashMap;
import java.util.Map;
public class AndroidStationStreamSessionTest {
 private static final String ID="11111111-1111-4111-8111-111111111111", KEY="22222222-2222-4222-8222-222222222222";
 private static final String ROOT="/user/api/v1/test/community-views/";
 private AndroidSessionPolicy policy() throws Exception {return new AndroidSessionPolicy("https://lk2.padlhub.su","test","test","1",false);}
 private Map<String,String> headers(boolean write) {Map<String,String> h=new HashMap<>();h.put("authorization","Bearer synthetic.session");if(write){h.put("content-type","application/json");h.put("idempotency-key",KEY);}return h;}
 private String body(){return "{\"requestId\":\""+KEY+"\",\"streamId\":\""+ID+"\",\"membershipEpoch\":1,\"throughSequence\":42}";}
 private void denied(String path,String method,Map<String,String> h,String body) throws Exception {try{policy().request(path,method,h,body);fail("must reject");}catch(AndroidSessionPolicy.Failure e){assertEquals("NATIVE_REQUEST_REJECTED",e.code);}}
 @Test public void exactRoutesAndLimits() throws Exception {
  policy().request(ROOT+"station-stream-summaries?communityIds="+ID+"%2C"+KEY,"GET",headers(false),null);
  policy().request(ROOT+ID+"/station-stream?limit=50&cursor="+"a".repeat(1024),"GET",headers(false),null);
  assertEquals("POST",policy().request(ROOT+ID+"/read-requests","POST",headers(true),body()).method);
  policy().request(ROOT+ID+"/read-requests/"+KEY,"GET",headers(false),null);
  policy().request(ROOT+ID+"/read-requests","POST",headers(true),body().replace(":42",":9007199254740990"));
 }
 @Test public void strictReadTupleAndHeader() throws Exception {
  for(String b:new String[]{body().replace(":42",":9007199254740991"),body().replace(":42",":true"),body().replace(":42",":\"42\""),body().replace(":42",":4.2"),body().replace(":42",":4e2"),body().replace("}",",\"throughSequence\":42}"),body().replace("}",",\"actor\":1}"),body()+" ".repeat(16384)})denied(ROOT+ID+"/read-requests","POST",headers(true),b);
  Map<String,String> h=headers(true);h.put("idempotency-key",ID);denied(ROOT+ID+"/read-requests","POST",h,body());
  h=headers(true);h.put("x-session-intent","refresh");denied(ROOT+ID+"/read-requests","POST",h,body());
  try{policy().requestBinary(ROOT+ID+"/read-requests","POST",headers(true),new byte[]{1});fail("binary");}catch(AndroidSessionPolicy.Failure expected){}
 }
 @Test public void strictQueryAndOriginalRoutesPreserved() throws Exception {
  for(String path:new String[]{ROOT+ID+"/station-stream?limit=51",ROOT+ID+"/station-stream?limit=1&limit=2",ROOT+ID+"/station-stream?cursor="+"a".repeat(1025),ROOT+ID+"/station-stream?cursor=%61aaaaaaaaaaaaaaa",ROOT+"station-stream-summaries?communityIds="+ID+","+ID,ROOT+"station-stream-summaries?communityIds="+ID+"%252C"+KEY,ROOT+ID+"/read-requests/"+KEY+"?x=1",ROOT+ID+"/chat?cursor="+"a".repeat(513)})denied(path,"GET",headers(false),null);
  denied(ROOT+ID+"/station-stream","POST",headers(true),body());
  denied(ROOT+ID+"/read-requests","GET",headers(false),null);
  denied(ROOT+ID+"/station-stream","GET",headers(false),"{}");
 }
 @Test public void actualEngineNeverRetriesReadPostAndStatusOnlyRecovery() throws Exception {
  for(int status:new int[]{401,403,404,503,0}) {
   java.util.List<AndroidSessionPolicy.Request> sent=new java.util.ArrayList<>();
   AndroidGameJoinSessionTest.MemoryStore store=new AndroidGameJoinSessionTest.MemoryStore();
   store.value=new AndroidSessionEngine.Credential("https://lk2.padlhub.su|test","s".repeat(40),System.currentTimeMillis()+60000,null,null);
   AndroidSessionEngine engine=new AndroidSessionEngine(policy(),store,request->{sent.add(request);if(status==0 && request.method.equals("POST"))throw new AndroidSessionPolicy.Failure("NATIVE_NETWORK_UNAVAILABLE");return new AndroidSessionEngine.Response(request.method.equals("POST")?status:200,java.util.Collections.emptyMap(),java.util.Collections.emptyList(),"{}".getBytes(java.nio.charset.StandardCharsets.UTF_8));});
   try {assertEquals(status,engine.request(ROOT+ID+"/read-requests","POST",headers(true),body()).status);assertNotEquals(0,status);}catch(AndroidSessionPolicy.Failure error){assertEquals(0,status);assertEquals("NATIVE_NETWORK_UNAVAILABLE",error.code);}
   assertEquals(1,sent.size());engine.request(ROOT+ID+"/read-requests/"+KEY,"GET",headers(false),null);assertEquals(2,sent.size());assertEquals("GET",sent.get(1).method);assertEquals(KEY,sent.get(0).headers.get("idempotency-key"));
  }
 }
 @Test public void exactHistoryCapSharedByActualSenderAndEngine() throws Exception {
  AndroidSessionPolicy p=policy();
  AndroidSessionPolicy.Request history=p.request(ROOT+ID+"/station-stream?limit=50","GET",headers(false),null);
  assertEquals(3*1024*1024,AndroidHttpSender.responseLimit(history));
  for(String path:new String[]{ROOT+ID+"/chat",ROOT+"station-stream-summaries?communityIds="+ID,ROOT+ID+"/read-requests/"+KEY})assertEquals(1024*1024,AndroidHttpSender.responseLimit(p.request(path,"GET",headers(false),null)));
  for(int size:new int[]{2_400_000,3*1024*1024+1}) {
   AndroidGameJoinSessionTest.MemoryStore store=new AndroidGameJoinSessionTest.MemoryStore();store.value=new AndroidSessionEngine.Credential("https://lk2.padlhub.su|test","s".repeat(40),System.currentTimeMillis()+60000,null,null);
   AndroidSessionEngine engine=new AndroidSessionEngine(p,store,request->new AndroidSessionEngine.Response(200,java.util.Collections.emptyMap(),java.util.Collections.emptyList(),new byte[size]));
   if(size<=3*1024*1024)assertEquals(size,engine.request(history.path,"GET",headers(false),null).body.length);
   else {try {engine.request(history.path,"GET",headers(false),null);fail("oversize");}catch(AndroidSessionPolicy.Failure e){assertEquals("NATIVE_RESPONSE_REJECTED",e.code);}}
   try {engine.request(ROOT+ID+"/chat","GET",headers(false),null);fail("old cap");}catch(AndroidSessionPolicy.Failure e){assertEquals("NATIVE_RESPONSE_REJECTED",e.code);}
  }
 }

 private static byte[] networkBytes;
 private static long declaredLength;
 private static int bodyReads;
 private static boolean disconnected;
 private static boolean handlerInstalled;
 @Test public void actualHttpSenderAbortsOversizeBeforeReadingDeclaredBody() throws Exception {
  if(!handlerInstalled) {
   java.net.URL.setURLStreamHandlerFactory(protocol->protocol.equals("r1station")?new java.net.URLStreamHandler(){
    protected java.net.URLConnection openConnection(java.net.URL url){return new javax.net.ssl.HttpsURLConnection(url){
     public void connect(){} public void disconnect(){disconnected=true;} public boolean usingProxy(){return false;}
     public String getCipherSuite(){return "SYNTHETIC";} public java.security.cert.Certificate[] getLocalCertificates(){return null;} public java.security.cert.Certificate[] getServerCertificates(){return null;}
     public int getResponseCode(){return 200;} public long getContentLengthLong(){return declaredLength;}
     public Map<String,java.util.List<String>> getHeaderFields(){return java.util.Collections.emptyMap();}
     public java.io.InputStream getInputStream(){bodyReads++;return new java.io.ByteArrayInputStream(networkBytes);}
    };}
   }:null);handlerInstalled=true;
  }
  AndroidHttpSender sender=new AndroidHttpSender("r1station://synthetic.test");
  try {
   AndroidSessionPolicy.Request request=policy().request(ROOT+ID+"/station-stream?limit=50","GET",headers(false),null);
   networkBytes=("{\"items\":["+("{\"body\":\"x"+"\\u0001".repeat(7998)+"y\"},").repeat(49)+"{\"body\":\"x"+"\\u0001".repeat(7998)+"y\"}]}").getBytes(java.nio.charset.StandardCharsets.UTF_8);
   assertTrue(networkBytes.length>2_000_000);declaredLength=networkBytes.length;bodyReads=0;disconnected=false;
   assertEquals(networkBytes.length,sender.send(request).body.length);assertEquals(1,bodyReads);assertTrue(disconnected);
   declaredLength=3*1024*1024+1;bodyReads=0;disconnected=false;
   try{sender.send(request);fail("declared oversize");}catch(AndroidSessionPolicy.Failure e){assertEquals("NATIVE_RESPONSE_REJECTED",e.code);}
   assertEquals(0,bodyReads);assertTrue(disconnected);
   networkBytes=new byte[3*1024*1024+1];declaredLength=-1;bodyReads=0;disconnected=false;
   try{sender.send(request);fail("chunk oversize");}catch(AndroidSessionPolicy.Failure e){assertEquals("NATIVE_RESPONSE_REJECTED",e.code);}
   assertEquals(1,bodyReads);assertTrue(disconnected);
  } finally {sender.close();}
 }

}
