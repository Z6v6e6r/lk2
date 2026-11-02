package ru.padlhub.app;
import org.junit.Test;
import static org.junit.Assert.*;
import static ru.padlhub.app.AndroidSessionPolicy.*;
import static ru.padlhub.app.AndroidSessionEngine.*;
import java.util.*;
import java.nio.charset.StandardCharsets;
public class AndroidSelfLeaveSessionTest {
  static final String ROOT=AndroidGameCancelSessionTest.ROOT;
  static AndroidSessionPolicy policy() throws Failure{return AndroidGameJoinSessionTest.policy();}
  static Map<String,String> headers(){return AndroidGameJoinSessionTest.headers();}
  @Test public void exactBodylessOriginalKeyRoutesSuppressFormContentType() throws Exception {
    String[] suffixes={"/participants/me","/leave-operation","/leave-operation/reconcile"},methods={"DELETE","GET","POST"};
    for(int n=0;n<3;n++) {
      Request r=policy().request(ROOT+suffixes[n],methods[n],headers(),null);
      assertEquals(methods[n],r.method);assertEquals(ROOT+suffixes[n],r.path);assertNull(r.body);
      assertEquals(headers().get("idempotency-key"),r.headers.get("idempotency-key"));
      if(n!=1)assertEquals("text/plain",r.headers.get("content-type"));
    }
  }
  @Test public void rejectsOtherMemberBodyQueryWrongMethodAndCredentialExpansion() throws Exception {
    for(String path:new String[]{"/participants/other","/participants/me?","/leave-operation?x=1","/leave-operation/reconcile/"})AndroidGameJoinSessionTest.rejected(()->policy().request(ROOT+path,"DELETE",headers(),null));
    for(String body:new String[]{"","{}","{\"recoveryOnly\":true}"})AndroidGameJoinSessionTest.rejected(()->policy().request(ROOT+"/participants/me","DELETE",headers(),body));
    AndroidGameJoinSessionTest.rejected(()->policy().request(ROOT+"/participants/me","POST",headers(),null));
    for(String name:new String[]{"authorization","idempotency-key"}){Map<String,String> h=headers();h.remove(name);AndroidGameJoinSessionTest.rejected(()->policy().request(ROOT+"/leave-operation","GET",h,null));}
    Map<String,String> h=headers();h.put("cookie","synthetic");AndroidGameJoinSessionTest.rejected(()->policy().request(ROOT+"/participants/me","DELETE",h,null));
  }
  @Test public void neverRetriesMutationOnNetwork401Or503() throws Exception {
    for(int status:new int[]{0,401,503}) {
      List<Request> sent=new ArrayList<>();AndroidSessionEngine engine=new AndroidSessionEngine(policy(),new AndroidGameJoinSessionTest.MemoryStore(),r->{sent.add(r);if(status==0)throw new Failure("NATIVE_NETWORK_UNAVAILABLE");return new Response(status,Collections.emptyMap(),Collections.emptyList(),"{}".getBytes(StandardCharsets.UTF_8));});
      try{engine.request(ROOT+"/participants/me","DELETE",headers(),null);assertTrue(status!=0);}catch(Failure e){assertEquals(0,status);}assertEquals(1,sent.size());
    }
  }
}
