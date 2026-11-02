package ru.padlhub.app;

import org.junit.Test;
import static org.junit.Assert.*;
import static ru.padlhub.app.AndroidSessionPolicy.*;
import static ru.padlhub.app.AndroidSessionEngine.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Real policy and engine, synthetic sender; no device or provider acceptance. */
public class AndroidTrainingRegistrationSessionTest {
    static final String ROOT = "/user/api/v1/local-padel";
    static final String ID = "11111111-1111-4111-8111-111111111111";
    static final String SUB = "22222222-2222-4222-8222-222222222222";
    static final String KEY = "synthetic-training-original-key";
    static final String BODY = "{\"dateHint\":\"2035-04-02\",\"subscriptionId\":\"" + SUB + "\"}";
    static final String CATALOG = ROOT + "/trainings/catalog?localDates=2035-04-02%2C2035-04-03&kinds=GROUP_TRAINING%2CSPLIT&availability=INCLUDE_FULL&limit=20&levelFrom=D%2B";
    static AndroidSessionPolicy policy() throws Failure { return new AndroidSessionPolicy("https://lk2.padlhub.su", "local-padel", "test", "1", false); }
    static Map<String,String> headers() { Map<String,String> h = new HashMap<>(); h.put("authorization", "Bearer synthetic-access"); h.put("idempotency-key", KEY); return h; }
    static Response response(int status) { return new Response(status, Collections.singletonMap("content-type", "application/json"), Collections.emptyList(), "{}".getBytes(StandardCharsets.UTF_8)); }
    interface Attempt { void run() throws Exception; }
    static void rejected(Attempt action) throws Exception { try { action.run(); fail("expected rejection"); } catch (Failure failure) { assertEquals("NATIVE_REQUEST_REJECTED", failure.code); } }

    @Test public void catalogueRegistrationAndOriginalReadUseOnlyFixedPadlHubScope() throws Exception {
        List<Request> sent = new ArrayList<>();
        AndroidSessionEngine engine = new AndroidSessionEngine(policy(), new AndroidGameJoinSessionTest.MemoryStore(), request -> { sent.add(request); return response(200); });
        engine.request(CATALOG, "GET", headers(), null);
        engine.request(ROOT + "/trainings/catalog?cursor=" + ID + "&limit=20", "GET", headers(), null);
        engine.request(ROOT + "/trainings/" + ID + "/registrations", "POST", headers(), BODY);
        engine.request(ROOT + "/trainings/" + ID + "/registration-operation", "GET", headers(), null);
        assertEquals(4, sent.size());
        assertEquals(1, sent.stream().filter(r -> "POST".equals(r.method)).count());
        assertEquals(BODY, new String(sent.get(2).body, StandardCharsets.UTF_8));
        assertEquals(KEY, sent.get(2).headers.get("idempotency-key"));
        assertEquals(KEY, sent.get(3).headers.get("idempotency-key"));
    }
    @Test public void refusesQueryAliasesDuplicatesCrossRoutesAndBodies() throws Exception {
        AndroidSessionPolicy p = policy();
        for (String bad : Arrays.asList(CATALOG + "&limit=1", CATALOG + "&providerTenant=other", CATALOG.replace("localDates=", "%6cocalDates="), CATALOG.replace("%2C", "%252C"), CATALOG.replace("2035-04-02", "2035-02-30"), CATALOG + "&cursor=" + ID, CATALOG.replace("limit=20", "limit=51"), ROOT + "/trainings/catalog?cursor=" + ID + "&localDates=2035-04-02", ROOT + "/trainings/" + ID + "/registration-operation?refresh=true", ROOT.replace("local-padel", "other") + "/trainings/catalog", "https://provider.invalid/exercises"))
            rejected(() -> p.request(bad, "GET", headers(), null));
        rejected(() -> p.request(CATALOG, "GET", headers(), "{}"));
        rejected(() -> p.request(ROOT + "/trainings/" + ID + "/registrations", "GET", headers(), null));
        rejected(() -> p.request(ROOT + "/trainings/" + ID + "/registrations", "DELETE", headers(), null));
        rejected(() -> p.request(ROOT + "/trainings/" + ID + "/registration-operation", "POST", headers(), BODY));
    }
    @Test public void acceptsOnlyExactTrainingBodyAndOriginalKey() throws Exception {
        AndroidSessionPolicy p = policy();
        String path = ROOT + "/trainings/" + ID + "/registrations";
        for (String body : Arrays.asList("{}", "[]", BODY.replace("2035-04-02", "2035-02-30"), BODY.replace("}", ",\"paid\":true}"), BODY.replace("}", ",\"dateHint\":\"2035-04-02\"}"), BODY.replace(SUB, "private-viva-subscription"), "null")) rejected(() -> p.request(path, "POST", headers(), body));
        rejected(() -> p.request(path, "POST", headers(), null));
        rejected(() -> p.request(path.replace(ID, "11111111-1111-0111-0111-111111111111"), "POST", headers(), BODY));
        rejected(() -> p.request(ROOT + "/trainings/11111111-1111-0111-0111-111111111111/registration-operation", "GET", headers(), null));
        rejected(() -> p.request(ROOT + "/trainings/catalog?cursor=11111111-1111-0111-0111-111111111111", "GET", headers(), null));
        Map<String,String> missing = headers(); missing.remove("idempotency-key");
        rejected(() -> p.request(path, "POST", missing, BODY));
        rejected(() -> p.request(ROOT + "/trainings/" + ID + "/registration-operation", "GET", missing, null));
        Map<String,String> anonymous = headers(); anonymous.remove("authorization");
        rejected(() -> p.request(CATALOG, "GET", anonymous, null));
    }
    @Test public void neverRetriesMutationOrRefreshesAfter401OrNetworkAmbiguity() throws Exception {
        for (int status : new int[]{401,503}) {
            List<Request> sent = new ArrayList<>();
            AndroidSessionEngine engine = new AndroidSessionEngine(policy(), new AndroidGameJoinSessionTest.MemoryStore(), request -> { sent.add(request); return response(status); });
            assertEquals(status, engine.request(ROOT + "/trainings/" + ID + "/registrations", "POST", headers(), BODY).status);
            assertEquals(1, sent.size());
        }
        List<Request> sent = new ArrayList<>();
        AndroidSessionEngine engine = new AndroidSessionEngine(policy(), new AndroidGameJoinSessionTest.MemoryStore(), request -> { sent.add(request); if ("POST".equals(request.method)) throw new Failure("NATIVE_NETWORK_UNAVAILABLE"); return response(200); });
        try { engine.request(ROOT + "/trainings/" + ID + "/registrations", "POST", headers(), BODY); fail("expected network failure"); } catch (Failure failure) { assertEquals("NATIVE_NETWORK_UNAVAILABLE", failure.code); }
        engine.request(ROOT + "/trainings/" + ID + "/registration-operation", "GET", headers(), null);
        assertEquals(2, sent.size()); assertEquals("GET", sent.get(1).method); assertEquals(KEY, sent.get(1).headers.get("idempotency-key"));
    }
    @Test public void missingSessionNeverDispatchesRegistration() throws Exception {
        AndroidGameJoinSessionTest.MemoryStore store = new AndroidGameJoinSessionTest.MemoryStore(); store.value = null;
        List<Request> sent = new ArrayList<>();
        AndroidSessionEngine engine = new AndroidSessionEngine(policy(), store, request -> { sent.add(request); return response(200); });
        engine.request(ROOT + "/trainings/" + ID + "/registrations", "POST", headers(), BODY);
        assertTrue(sent.isEmpty());
    }
}
