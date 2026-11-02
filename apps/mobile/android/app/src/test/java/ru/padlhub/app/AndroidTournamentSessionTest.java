package ru.padlhub.app;
import org.junit.Test;
import static org.junit.Assert.*;
import static ru.padlhub.app.AndroidSessionPolicy.*;
import static ru.padlhub.app.AndroidSessionEngine.*;
import java.util.*;
import java.nio.charset.StandardCharsets;
/** Real policy/engine, synthetic sender only; no device/provider acceptance. */
public class AndroidTournamentSessionTest {
 static final String ID="11111111-1111-4111-8111-111111111111",KEY="22222222-2222-4222-8222-222222222222",ROOT="/user/api/v1/local-padel/tournaments/"+ID,PUBLIC="/public/api/v1/local-padel/tournaments",DATES="?dateFrom=2026-11-01&dateTo=2026-11-16";
 static AndroidSessionPolicy policy()throws Failure{return new AndroidSessionPolicy("https://lk2.padlhub.su","local-padel","test","2",false);}
 static Map<String,String> headers(){Map<String,String> h=new HashMap<>();h.put("authorization","Bearer synthetic-access");h.put("idempotency-key",KEY);return h;}
 interface Attempt{void run()throws Exception;}
 static void denied(Attempt f)throws Exception{try{f.run();fail("expected denied");}catch(Failure e){assertEquals("NATIVE_REQUEST_REJECTED",e.code);}}
 @Test public void fixedDiscoveryHasNoCredentialAndUserCommandsKeepExactKeyAndGeneration()throws Exception{
  AndroidSessionPolicy p=policy();Request publicRead=p.request(PUBLIC+DATES,"GET",Collections.emptyMap(),null);assertEquals(Operation.PUBLIC,publicRead.operation);assertFalse(publicRead.headers.containsKey("authorization"));assertFalse(publicRead.headers.containsKey("cookie"));
  p.request(PUBLIC+"/"+ID+DATES,"GET",Collections.emptyMap(),null);
  String join="{\"action\":\"JOIN\"}",leave="{\"originalJoinOperationId\":\""+KEY+"\",\"action\":\"LEAVE\"}";
  assertEquals(join,new String(p.request(ROOT+"/registrations","POST",headers(),join).body,StandardCharsets.UTF_8));assertEquals(leave,new String(p.request(ROOT+"/registrations","POST",headers(),leave).body,StandardCharsets.UTF_8));
  Request retry=p.request(ROOT+"/registration-operations/"+KEY+"/retry","POST",headers(),null);assertEquals(KEY,retry.headers.get("idempotency-key"));assertEquals("text/plain",retry.headers.get("content-type"));assertNull(retry.body);
  Map<String,String> read=headers();read.remove("idempotency-key");p.request(ROOT+"/registration-operation","GET",read,null);p.request(ROOT+"/registration-operation?operationId="+KEY,"GET",headers(),null);p.request(ROOT+"/participants","GET",read,null);
 }
 @Test public void refusesCredentialsAndBroadenedDiscovery()throws Exception{
  AndroidSessionPolicy p=policy();denied(()->p.request(PUBLIC+DATES,"GET",headers(),null));
  for(String path:Arrays.asList(PUBLIC+DATES+"&dateFrom=2026-11-02",PUBLIC+"?dateFrom=2026-02-30&dateTo=2026-03-02",PUBLIC+"?dateFrom=2026-11-01&dateTo=2026-11-17",PUBLIC+DATES+"&source=viva",PUBLIC+DATES+"&limit=51",PUBLIC+DATES+"&availability=WAITLIST",PUBLIC+"?dateFrom=2026-11-01%26dateTo=2026-11-02",PUBLIC+"/"+ID+DATES+"&limit=1","/public/api/v1/other/tournaments"+DATES,"/public/api/v1/local-padel/games"+DATES))denied(()->p.request(path,"GET",Collections.emptyMap(),null));
  denied(()->p.request(PUBLIC+DATES,"POST",Collections.emptyMap(),"{}"));denied(()->p.request(PUBLIC+DATES,"GET",Collections.emptyMap(),"{}"));
 }
 @Test public void refusesForgedBodiesSelectorsAndSiblingMutations()throws Exception{
  AndroidSessionPolicy p=policy();for(String body:Arrays.asList("{}","null","{\"action\":\"JOIN\",\"clientId\":\"7\"}","{\"action\":\"JOIN\",\"action\":\"JOIN\"}","{\"action\":\"LEAVE\"}","{\"action\":\"JOIN\",\"gender\":\"MALE\"}"))denied(()->p.request(ROOT+"/registrations","POST",headers(),body));
  for(String path:Arrays.asList(ROOT+"/registration-operation?operationId="+KEY+"&operationId="+KEY,ROOT+"/participants?operationId="+KEY,ROOT+"/registration-operation?key="+KEY))denied(()->p.request(path,"GET",headers(),null));
  denied(()->p.request(ROOT+"/registrations","POST",Collections.emptyMap(),"{\"action\":\"JOIN\"}"));denied(()->p.request(ROOT+"/registration-operations/"+KEY+"/retry","POST",headers(),"{}"));
  denied(()->p.request(ROOT+"/registrations?","POST",headers(),"{\"action\":\"JOIN\"}"));denied(()->p.request(ROOT+"/waitlist","POST",headers(),"{}"));denied(()->p.request(ROOT+"/registrations","DELETE",headers(),null));
 }
 @Test public void engineNeverReplaysMutationOrRefreshesOnAmbiguity()throws Exception{
  for(int status:new int[]{401,503}){List<Request> sent=new ArrayList<>();AndroidSessionEngine e=new AndroidSessionEngine(policy(),new AndroidGameJoinSessionTest.MemoryStore(),r->{sent.add(r);return new Response(status,Collections.emptyMap(),Collections.emptyList(),new byte[0]);});assertEquals(status,e.request(ROOT+"/registrations","POST",headers(),"{\"action\":\"JOIN\"}").status);assertEquals(1,sent.size());}
  List<Request> sent=new ArrayList<>();AndroidSessionEngine e=new AndroidSessionEngine(policy(),new AndroidGameJoinSessionTest.MemoryStore(),r->{sent.add(r);throw new Failure("NATIVE_NETWORK_UNAVAILABLE");});try{e.request(ROOT+"/registrations","POST",headers(),"{\"action\":\"JOIN\"}");fail();}catch(Failure error){assertEquals("NATIVE_NETWORK_UNAVAILABLE",error.code);}assertEquals(1,sent.size());
 }
 @Test public void missingSessionCannotDispatchCommandButPublicDiscoveryRemainsCredentialFree()throws Exception{
  AndroidGameJoinSessionTest.MemoryStore store=new AndroidGameJoinSessionTest.MemoryStore();store.clear();List<Request> sent=new ArrayList<>();AndroidSessionEngine e=new AndroidSessionEngine(policy(),store,r->{sent.add(r);return new Response(200,Collections.emptyMap(),Collections.emptyList(),new byte[0]);});assertEquals(401,e.request(ROOT+"/registrations","POST",headers(),"{\"action\":\"JOIN\"}").status);assertEquals(0,sent.size());e.request(PUBLIC+DATES,"GET",Collections.emptyMap(),null);assertEquals(1,sent.size());assertEquals(Operation.PUBLIC,sent.get(0).operation);
 }
}
