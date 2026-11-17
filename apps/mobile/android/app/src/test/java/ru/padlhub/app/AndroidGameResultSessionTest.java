package ru.padlhub.app;

import org.junit.Test;
import static org.junit.Assert.*;
import static ru.padlhub.app.AndroidSessionPolicy.*;
import static ru.padlhub.app.AndroidSessionEngine.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Real policy/engine JVM checks; no database, device, provider or real session. */
public class AndroidGameResultSessionTest {
    static final String ROOT = AndroidGameJoinSessionTest.ROOT + "/games/" + AndroidGameJoinSessionTest.GAME + "/result-submissions";
    static final String SUBMISSION = "55555555-5555-4555-8555-555555555555";
    static final String BODY = "{\"sets\":[{\"setNumber\":1,\"teamAUserIds\":[\"11111111-1111-4111-8111-111111111111\",\"22222222-2222-4222-8222-222222222222\"],\"teamBUserIds\":[\"33333333-3333-4333-8333-333333333333\",\"44444444-4444-4444-8444-444444444444\"],\"teamA\":6,\"teamB\":4}]}";
    static AndroidSessionPolicy policy() throws Failure { return AndroidGameJoinSessionTest.policy(); }
    static Map<String,String> headers() { return AndroidGameJoinSessionTest.headers(); }
    static void rejects(String path, String method, Map<String,String> headers, String body) throws Exception {
        AndroidGameJoinSessionTest.rejected(() -> policy().request(path, method, headers, body));
    }
    @Test public void forwardsThreeExactCommandsWithOriginalBodyAndKey() throws Exception {
        List<Request> sent = new ArrayList<>();
        AndroidSessionEngine engine = new AndroidSessionEngine(policy(), new AndroidGameJoinSessionTest.MemoryStore(), request -> {
            sent.add(request); return new Response(200, Collections.emptyMap(), Collections.emptyList(), "{}".getBytes(StandardCharsets.UTF_8));
        });
        engine.request(ROOT, "POST", headers(), BODY);
        engine.request(ROOT + "/" + SUBMISSION + "/confirm", "POST", headers(), null);
        engine.request(ROOT + "/" + SUBMISSION + "/dispute", "POST", headers(), "{\"reasonCode\":\"SCORE_INCORRECT\",\"note\":\"Проверьте второй сет\"}");
        assertEquals(3, sent.size());
        assertEquals(BODY, new String(sent.get(0).body, StandardCharsets.UTF_8));
        for (Request request : sent) {
            assertEquals(Operation.API, request.operation);
            assertEquals(headers().get("idempotency-key"), request.headers.get("idempotency-key"));
        }
        assertNotNull(policy().request(ROOT + "/" + SUBMISSION + "/confirm", "POST", headers(), "{}"));
    }
    @Test public void deniesMethodsQueriesForeignTenantAndNeighbourCommands() throws Exception {
        for (String method : new String[]{"GET","PUT","PATCH","DELETE"}) rejects(ROOT, method, headers(), BODY);
        for (String path : new String[]{ROOT+"?", ROOT+"?force=1", ROOT+"/", ROOT+"/"+SUBMISSION+"/accept", ROOT.replace("local-padel","other-tenant"), ROOT.replace("-4111-","-0111-"), ROOT+"/"+SUBMISSION+"/confirm/", ROOT+"/../cancel"})
            rejects(path, "POST", headers(), BODY);
    }
    @Test public void requiresAuthOriginalKeyJsonAndBoundedBody() throws Exception {
        for (String field : new String[]{"authorization","idempotency-key"}) {
            Map<String,String> values = headers(); values.remove(field); rejects(ROOT,"POST",values,BODY);
        }
        Map<String,String> values = headers(); values.put("content-type","text/plain"); rejects(ROOT,"POST",values,BODY);
        rejects(ROOT,"POST",headers(),null);
        AndroidGameJoinSessionTest.rejected(() -> policy().requestBinary(ROOT,"POST",headers(),new byte[]{1,2,3}));
        rejects(ROOT,"POST",headers(),"x".repeat(16_385));
        for (String body : new String[]{"{}", "{\"sets\":[]}", BODY.replace("\"teamA\":6","\"teamA\":4"), BODY.replace("\"teamA\":6","\"teamA\":-1"), BODY.replace("\"teamA\":6","\"teamA\":6.5"), BODY.replace("\"setNumber\":1","\"setNumber\":2"), BODY.replace("\"sets\":","\"actorUserId\":\"arbitrary\",\"sets\":"), BODY.replace("22222222-2222-4222-8222-222222222222","11111111-1111-4111-8111-111111111111")}) rejects(ROOT,"POST",headers(),body);
        rejects(ROOT+"/"+SUBMISSION+"/confirm","POST",headers(),"{\"force\":true}");
        rejects(ROOT+"/"+SUBMISSION+"/dispute","POST",headers(),"{\"reasonCode\":\"UNKNOWN\"}");
    }
    @Test public void neverRetriesMutationOnNetworkOrHttpFailure() throws Exception {
        for (int status : new int[]{0,401,503}) {
            List<Request> sent = new ArrayList<>();
            AndroidSessionEngine engine = new AndroidSessionEngine(policy(),new AndroidGameJoinSessionTest.MemoryStore(), request -> {
                sent.add(request); if (status==0) throw new Failure("NATIVE_NETWORK_UNAVAILABLE");
                return new Response(status,Collections.emptyMap(),Collections.emptyList(),"{}".getBytes(StandardCharsets.UTF_8));
            });
            try { engine.request(ROOT,"POST",headers(),BODY); assertTrue(status!=0); } catch(Failure error) { assertEquals(0,status); }
            assertEquals(1,sent.size());
        }
    }
    @Test public void gamePushRoutesStayExactAndDoNotTrustExtraIntentPaths() {
        String game = "/games/"+AndroidGameJoinSessionTest.GAME;
        assertEquals(game, AndroidPushState.route(game));
        for (String path : new String[]{game+"?next=outside",game+"/cancel","/games/../profile","https://evil.invalid"+game})
            assertEquals("/notifications", AndroidPushState.route(path));
    }
}
