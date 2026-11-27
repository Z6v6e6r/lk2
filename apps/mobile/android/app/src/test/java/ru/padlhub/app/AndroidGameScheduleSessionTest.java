package ru.padlhub.app;

import org.junit.Test;
import java.util.Map;
import static org.junit.Assert.*;
import static ru.padlhub.app.AndroidGameJoinSessionTest.*;

public class AndroidGameScheduleSessionTest {
    private static final String PATH = ROOT + "/games/create-schedule";
    private static final String QUERY = "?stationId=" + GAME + "&day=2030-11-27&durationMinutes=60";
    private static final String SLOT = "&slotId=" + "a".repeat(64);

    @Test public void allowsOnlyAuthenticatedCanonicalListAndQuote() throws Exception {
        for (String path : new String[]{PATH + QUERY, PATH + QUERY + SLOT}) {
            AndroidSessionPolicy.Request request = policy().request(path, "GET", conditionHeaders(), null);
            assertEquals(path, request.path);
            assertEquals(AndroidSessionPolicy.Operation.API, request.operation);
            assertNull(request.body);
            assertEquals("Bearer synthetic-access", request.headers.get("authorization"));
        }
        rejected(() -> policy().request(PATH + QUERY, "GET", Map.of(), null));
    }

    @Test public void rejectsUnknownInputsAndAdjacentCommands() throws Exception {
        for (String path : new String[]{PATH, PATH + "/other" + QUERY, PATH + QUERY + "&userId=" + GAME,
                PATH + QUERY + "&day=2030-11-27", PATH + QUERY.replace("=60", "=45"), PATH + QUERY + "&slotId=short",
                PATH.replace("local-padel", "another-tenant") + QUERY, ROOT + "/games/whole-court-offer"}) {
            rejected(() -> policy().request(path, "GET", conditionHeaders(), null));
        }
        rejected(() -> policy().request(PATH + QUERY, "GET", headers(), "{}"));
        rejected(() -> policy().request(PATH + QUERY, "POST", headers(), "{}"));
        rejected(() -> policy().request(ROOT + "/games", "POST", headers(), "{}"));
    }
}
