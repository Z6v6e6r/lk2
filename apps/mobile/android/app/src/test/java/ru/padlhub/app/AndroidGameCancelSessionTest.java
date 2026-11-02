package ru.padlhub.app;
import org.junit.Test;
import static org.junit.Assert.*;
import static ru.padlhub.app.AndroidSessionPolicy.*;
import static ru.padlhub.app.AndroidSessionEngine.*;
import java.util.*;
import java.nio.charset.StandardCharsets;
public class AndroidGameCancelSessionTest {
  static final String ROOT="/user/api/v1/local-padel/games/11111111-1111-4111-8111-111111111111";
  static final String BODY="{\"reasonCode\":\"ORGANIZER_REQUEST\"}";
  static AndroidSessionPolicy policy() throws Failure {return AndroidGameJoinSessionTest.policy();}
  static Map<String,String> headers(){return AndroidGameJoinSessionTest.headers();}
  @Test public void forwardsExactCommandAndUncachedDetail() throws Exception {
    List<Request> sent=new ArrayList<>();
    AndroidSessionEngine engine=new AndroidSessionEngine(policy(),new AndroidGameJoinSessionTest.MemoryStore(),r->{sent.add(r);return new Response(200,Collections.emptyMap(),Collections.emptyList(),"{}".getBytes(StandardCharsets.UTF_8));});
    engine.request(ROOT+"/cancel","POST",headers(),BODY);
    engine.request(ROOT,"GET",headers(),null);
    assertEquals(2,sent.size());assertEquals("POST",sent.get(0).method);
    assertEquals(BODY,new String(sent.get(0).body,StandardCharsets.UTF_8));
    assertEquals(headers().get("idempotency-key"),sent.get(0).headers.get("idempotency-key"));
  }
  @Test public void refusesMethodQueryUuidAndExpandedBody() throws Exception {
    for(String method:new String[]{"GET","DELETE","PATCH"}) AndroidGameJoinSessionTest.rejected(()->policy().request(ROOT+"/cancel",method,headers(),BODY));
    for(String suffix:new String[]{"?force=true","?","/","%2f"}) AndroidGameJoinSessionTest.rejected(()->policy().request(ROOT+"/cancel"+suffix,"POST",headers(),BODY));
    AndroidGameJoinSessionTest.rejected(()->policy().request(ROOT.replace("-4111-","-0111-")+"/cancel","POST",headers(),BODY));
    for(String body:new String[]{"{}","{\"reasonCode\":\"OTHER\"}","{\"reasonCode\":\"ORGANIZER_REQUEST\",\"note\":\"extra\"}","{\"reasonCode\":[\"ORGANIZER_REQUEST\"]}"}) AndroidGameJoinSessionTest.rejected(()->policy().request(ROOT+"/cancel","POST",headers(),body));
  }
  @Test public void requiresAuthKeyAndRejectsNeighbouringWrites() throws Exception {
    for(String name:new String[]{"authorization","idempotency-key"}) {Map<String,String> h=headers();h.remove(name);AndroidGameJoinSessionTest.rejected(()->policy().request(ROOT+"/cancel","POST",h,BODY));}
    AndroidGameJoinSessionTest.rejected(()->policy().request(ROOT+"/refund","POST",headers(),BODY));
  }
  @Test public void noNativeMutationRetryOnNetworkOrHttpFailure() throws Exception {
    for(int status:new int[]{0,401,503}) {
      List<Request> sent=new ArrayList<>();
      AndroidSessionEngine engine=new AndroidSessionEngine(policy(),new AndroidGameJoinSessionTest.MemoryStore(),r->{sent.add(r);if(status==0)throw new Failure("NATIVE_NETWORK_UNAVAILABLE");return new Response(status,Collections.emptyMap(),Collections.emptyList(),"{}".getBytes(StandardCharsets.UTF_8));});
      try{engine.request(ROOT+"/cancel","POST",headers(),BODY);assertTrue(status!=0);}catch(Failure f){assertEquals(0,status);}
      assertEquals(1,sent.size());
    }
  }
}
