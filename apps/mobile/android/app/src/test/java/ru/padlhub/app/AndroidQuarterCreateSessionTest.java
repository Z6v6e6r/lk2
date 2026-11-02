package ru.padlhub.app;
import org.junit.Test;
import static org.junit.Assert.*;
import static ru.padlhub.app.AndroidGameJoinSessionTest.*;
import static ru.padlhub.app.AndroidSessionPolicy.*;
import static ru.padlhub.app.AndroidSessionEngine.*;
import java.util.*;
import java.nio.charset.StandardCharsets;
public class AndroidQuarterCreateSessionTest {
  static final String PATH = ROOT + "/game-create-operations";
  static final String QUARTER = "{\"stationId\":\""+GAME+"\",\"courtId\":\""+GAME+"\",\"subscriptionId\":\""+SUBSCRIPTION+"\",\"startsAt\":\"2030-01-01T12:00:00.000Z\"}";
  @Test public void fiveRoutesPreserveOriginalRecovery() throws Exception {
    List<Request> sent=new ArrayList<>();
    AndroidSessionEngine e=new AndroidSessionEngine(policy(),new MemoryStore(),r->{sent.add(r);return new Response(200,Collections.emptyMap(),Collections.emptyList(),"{}".getBytes(StandardCharsets.UTF_8));});
    Map<String,String> read=headers();read.remove("idempotency-key");
    e.request(PATH+"/capability","GET",read,null);e.request(PATH+"/locations","GET",read,null);
    e.request(PATH,"POST",headers(),QUARTER);e.request(PATH+"/by-key","GET",headers(),null);e.request(PATH+"/"+KEY+"/reconcile","POST",headers(),QUARTER);
    assertEquals(5,sent.size());assertEquals(QUARTER,new String(sent.get(4).body,StandardCharsets.UTF_8));assertEquals(KEY,sent.get(4).headers.get("idempotency-key"));
  }
  @Test public void deniesUnknownBodyAndRoutesBeforeSender() throws Exception {
    AndroidSessionPolicy p=policy();
    for(String path:Arrays.asList(PATH+"?x=1",PATH+"/unknown",PATH+"/../games",PATH+"/"+KEY+"/reconcile?key=x",ROOT+"/games",PATH.replace("local-padel","other"))) rejected(()->p.request(path,"POST",headers(),QUARTER));
    for(String body:Arrays.asList("{}",QUARTER.replace("stationId","courtId"),QUARTER.replace("12:00:00","12:00:01"),QUARTER.replace("2030-01-01","2030-02-30"),QUARTER.replace("2030-01-01","0000-01-01"),QUARTER.replace("}",",\"price\":0}"))) rejected(()->p.request(PATH,"POST",headers(),body));
    Map<String,String> h=headers();h.put("cookie","synthetic");rejected(()->p.request(PATH,"POST",h,QUARTER));
    Map<String,String> noKey=headers();noKey.remove("idempotency-key");rejected(()->p.request(PATH+"/by-key","GET",noKey,null));
    rejected(()->p.request(PATH+"/locations?x=1","GET",noKey,null));
  }
  @Test public void httpAndNetworkNeverReplayMutation() throws Exception {
    for(int status:new int[]{401,503,0}) {
      List<Request> sent=new ArrayList<>();
      AndroidSessionEngine e=new AndroidSessionEngine(policy(),new MemoryStore(),r->{sent.add(r);if(status==0)throw new Failure("NATIVE_NETWORK_UNAVAILABLE");return new Response(status,Collections.emptyMap(),Collections.emptyList(),"{}".getBytes(StandardCharsets.UTF_8));});
      try {assertEquals(status,e.request(PATH,"POST",headers(),QUARTER).status);}catch(Failure f){assertEquals(0,status);}
      assertEquals(1,sent.size());
    }
  }
  @Test public void pendingLogoutAndAbsentSessionNeverDispatch() throws Exception {
    MemoryStore store=new MemoryStore();store.value=store.value.journal(null,KEY);
    List<Request> sent=new ArrayList<>();AndroidSessionEngine e=new AndroidSessionEngine(policy(),store,r->{sent.add(r);throw new Failure("UNEXPECTED");});
    assertEquals(401,e.request(PATH,"POST",headers(),QUARTER).status);store.clear();assertEquals(401,e.request(PATH,"POST",headers(),QUARTER).status);assertEquals(0,sent.size());
  }
}
