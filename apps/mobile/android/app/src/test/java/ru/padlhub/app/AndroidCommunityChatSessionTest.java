package ru.padlhub.app;

import org.junit.Test;
import static org.junit.Assert.*;
import static ru.padlhub.app.AndroidSessionPolicy.*;
import java.util.*;

/** Executes the real native policy on the host JVM; no device, network or provider calls. */
public class AndroidCommunityChatSessionTest {
    static final String ROOT = "/user/api/v1/local-padel";
    static final String ID = "11111111-1111-4111-8111-111111111111";
    static final String CHAT = ROOT + "/community-views/" + ID + "/chat";
    static final String CURSOR = "eyJ2IjoxLCJiZWZvcmVUcyI6IjIwMjYtMTAtMzFUMDA6MDA6MDBaIn0";
    static AndroidSessionPolicy policy() throws Failure {
        return new AndroidSessionPolicy("https://lk2.padlhub.su", "local-padel", "test", "2", false);
    }
    static Map<String, String> headers() {
        Map<String, String> headers = new HashMap<>();
        headers.put("authorization", "Bearer synthetic-access");
        headers.put("idempotency-key", "33333333-3333-4333-8333-333333333333");
        return headers;
    }
    static void rejected(String path, String method, Map<String, String> headers, String body) throws Exception {
        try { policy().request(path, method, headers, body); fail("Accepted forbidden request: " + method + " " + path); }
        catch (Failure failure) { assertEquals("NATIVE_REQUEST_REJECTED", failure.code); }
    }

    @Test public void readsOnlyTheSelectedTenantHistoryAndPreservesOpaquePagination() throws Exception {
        for (String query : Arrays.asList("", "?limit=1", "?limit=20", "?limit=50", "?cursor=" + CURSOR,
            "?limit=50&cursor=" + CURSOR, "?cursor=" + CURSOR + "&limit=1",
            "?cursor=" + "a".repeat(16), "?cursor=" + "a".repeat(512))) {
            Request request = policy().request(CHAT + query, "GET", headers(), null);
            assertEquals(CHAT + query, request.path);
            assertEquals(Operation.API, request.operation);
            assertEquals("GET", request.method);
            assertEquals("android", request.headers.get("x-app-platform"));
            assertEquals("application/json", request.headers.get("accept"));
            assertNull(request.body);
        }
    }

    @Test public void rejectsMethodsBodiesAndMissingBearer() throws Exception {
        for (String method : Arrays.asList("POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "get"))
            rejected(CHAT, method, headers(), null);
        rejected(CHAT, "GET", headers(), "{}");
        rejected(CHAT, "GET", Collections.emptyMap(), null);
    }

    @Test public void rejectsMalformedCrossTenantProviderAndAdjacentRoutes() throws Exception {
        for (String path : Arrays.asList(
            CHAT + "/", CHAT + "/messages", CHAT + "#fragment", CHAT.replace(ID, "not-a-uuid"),
            CHAT.replace(ID, "1-1-4-8-1"), CHAT.replace(ID, "11111111-1111-4111-8111-11111111111z"),
            CHAT.replace("/chat", "/%63hat"), CHAT.replace("/chat", "/../chat"), CHAT.replace("/chat", "//chat"),
            CHAT.replace("local-padel", "other"), CHAT.replace("local-padel", "local-padel-evil"),
            "https://lk2.padlhub.su" + CHAT, "//lk2.padlhub.su" + CHAT,
            ROOT + "/community-views/" + ID, ROOT + "/community-views/" + ID + "/feed",
            ROOT + "/community-views/" + ID + "/rating", ROOT + "/communities/" + ID + "/chat"))
            rejected(path, "GET", headers(), null);
    }

    @Test public void rejectsUnboundedDuplicateUnknownAndEncodedQueryFields() throws Exception {
        for (String query : Arrays.asList("", "limit", "limit=", "limit=0", "limit=51", "limit=-1", "limit=01",
            "limit=1.5", "limit=1e1", "limit=9999999999999999999", "limit=20&limit=20",
            "cursor=" + CURSOR + "&cursor=" + CURSOR, "cursor=", "cursor=" + "a".repeat(15),
            "cursor=" + "a".repeat(513), "cursor=" + CURSOR + "=", "cursor=" + CURSOR + "+",
            "limit=20&", "&limit=20", "limit=20&&cursor=" + CURSOR, "unknown=1", "limit=20&unknown=1",
            "Limit=20", "%6cimit=20", "limit=%32%30", "limit=20%26unknown=1",
            "cursor=" + CURSOR + "%26limit=50", "cursor=" + CURSOR + "%0a", "cursor=" + CURSOR + "%2526"))
            rejected(CHAT + "?" + query, "GET", headers(), null);
    }
}
