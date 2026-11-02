package ru.padlhub.app;
import org.junit.Test;
import static org.junit.Assert.*;
import java.util.*;
import java.nio.charset.StandardCharsets;
import static ru.padlhub.app.AndroidSessionPolicy.*;
import static ru.padlhub.app.AndroidSessionEngine.Response;
public class AndroidProfileSettingsSessionTest {
  static final String ROOT="/user/api/v1/local-padel";
  static final String BODY="{\"expectedVersion\":0,\"contactPolicy\":\"NOBODY\",\"chatPolicy\":\"AUTHORIZED\"}";
  static Map<String,String> headers(){Map<String,String> h=AndroidGameJoinSessionTest.headers();h.put("idempotency-key","profile-settings:privacy:"+String.join("",Collections.nCopies(64,"a")));h.put("content-type","application/json");return h;}
  @Test public void exactOwnerPutNeverReplaysHttpFailure() throws Exception {
    for(int status:new int[]{200,401,409,503}) {
      List<Request> sent=new ArrayList<>();
      AndroidSessionEngine engine=new AndroidSessionEngine(AndroidGameJoinSessionTest.policy(),new AndroidGameJoinSessionTest.MemoryStore(),r->{sent.add(r);return new Response(status,Collections.emptyMap(),Collections.emptyList(),"{}".getBytes(StandardCharsets.UTF_8));});
      assertEquals(status,engine.request(ROOT+"/profile/privacy","PUT",headers(),BODY).status);
      assertEquals(1,sent.size());assertEquals(Operation.API,sent.get(0).operation);assertEquals(BODY,new String(sent.get(0).body,StandardCharsets.UTF_8));assertEquals(headers().get("idempotency-key"),sent.get(0).headers.get("idempotency-key"));
    }
  }
  @Test public void rejectsWrongNamespaceTypesAndDuplicateKeys() throws Exception {
    AndroidSessionPolicy policy=AndroidGameJoinSessionTest.policy();
    for(String value:new String[]{BODY.replace("\"expectedVersion\":0","\"expectedVersion\":true"),BODY.replace("\"expectedVersion\":0","\"expectedVersion\":0,\"expectedVersion\":1"),BODY.replace("expectedVersion","expected\\u0056ersion"),BODY.replace("\"NOBODY\"","[\"NOBODY\"]"),BODY+"{}"})AndroidGameJoinSessionTest.rejected(()->policy.request(ROOT+"/profile/privacy","PUT",headers(),value));
    for(String suffix:new String[]{"?userId=other","/other"})AndroidGameJoinSessionTest.rejected(()->policy.request(ROOT+"/profile/privacy"+suffix,"PUT",headers(),BODY));
    AndroidGameJoinSessionTest.rejected(()->policy.request(ROOT+"/profile/privacy","POST",headers(),BODY));
  }
  @Test public void validatesPreferencesAndPreservesNetworkFailureWithoutReplay() throws Exception {
    String body="{\"expectedVersion\":0,\"favoriteStationIds\":[],\"preferredTimeWindows\":[{\"weekday\":\"MON\",\"startsAt\":\"09:00\",\"endsAt\":\"12:00\"}],\"useHistory\":false,\"recommendFriends\":true,\"recommendationDisplay\":\"ROWS\"}";
    AndroidProfileSettingsRequest.validateBody("preferences",body);
    for(String value:new String[]{body.replace("false","0"),body.replace("09:00","13:00"),body.replace("\"ROWS\"","[\"ROWS\"]")})AndroidGameJoinSessionTest.rejected(()->AndroidProfileSettingsRequest.validateBody("preferences",value));
    List<Request> sent=new ArrayList<>();AndroidSessionEngine engine=new AndroidSessionEngine(AndroidGameJoinSessionTest.policy(),new AndroidGameJoinSessionTest.MemoryStore(),r->{sent.add(r);throw new Failure("NATIVE_NETWORK_UNAVAILABLE");});
    try{engine.request(ROOT+"/profile/privacy","PUT",headers(),BODY);fail();}catch(Failure e){assertEquals("NATIVE_NETWORK_UNAVAILABLE",e.code);}assertEquals(1,sent.size());
  }
}
