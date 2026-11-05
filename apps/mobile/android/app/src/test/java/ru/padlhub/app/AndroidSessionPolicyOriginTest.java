package ru.padlhub.app;

import org.junit.Test;
import static org.junit.Assert.*;
import static ru.padlhub.app.AndroidSessionPolicy.*;
import java.util.Arrays;

/** Host-JVM tests of the reviewed native API origins; not device or provider acceptance. */
public class AndroidSessionPolicyOriginTest {
    static final String RELEASE = "https://lk2.padlhub.su";
    static final String STAGING = "https://lk.nano.padlhub.su";
    static final String TEST_STAND = "https://test.lk2.padlhub.su";

    static void rejected(String origin, boolean debug) {
        try {
            new AndroidSessionPolicy(origin, "local-padel", "test", "2", debug);
            fail("Expected rejection of " + origin + " debug=" + debug);
        } catch (Failure error) {
            assertEquals("NATIVE_CONFIGURATION_REQUIRED", error.code);
        }
    }

    @Test public void releaseAcceptsOnlyTheProductionOrigin() throws Exception {
        assertEquals(RELEASE, new AndroidSessionPolicy(RELEASE, "local-padel", "test", "2", false).origin);
        rejected(STAGING, false);
        rejected(TEST_STAND, false);
    }

    @Test public void debugAddsOnlyTheExactStagingAndTestStandOrigins() throws Exception {
        for (String origin : Arrays.asList(RELEASE, STAGING, TEST_STAND))
            assertEquals(origin, new AndroidSessionPolicy(origin, "local-padel", "test", "2", true).origin);
        for (String origin : Arrays.asList("http://test.lk2.padlhub.su", TEST_STAND + "/", TEST_STAND + ":443",
                TEST_STAND + ".evil.invalid", "https://evil.test.lk2.padlhub.su", "https://test2.lk2.padlhub.su",
                "https://TEST.lk2.padlhub.su", "https://user@test.lk2.padlhub.su"))
            rejected(origin, true);
    }

    @Test public void testStandScopeIsSeparateFromProduction() throws Exception {
        AndroidSessionPolicy stand = new AndroidSessionPolicy(TEST_STAND, "local-padel", "test", "2", true);
        AndroidSessionPolicy release = new AndroidSessionPolicy(RELEASE, "local-padel", "test", "2", true);
        assertNotEquals(release.scope, stand.scope);
        assertEquals(TEST_STAND + "|local-padel", stand.scope);
    }
}
