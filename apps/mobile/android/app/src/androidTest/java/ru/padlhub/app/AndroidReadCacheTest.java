package ru.padlhub.app;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.*;
import static org.junit.Assert.*;
import static ru.padlhub.app.AndroidSessionEngine.*;
import static ru.padlhub.app.AndroidSessionPolicy.*;
import static ru.padlhub.app.AndroidSessionTest.*;

@RunWith(AndroidJUnit4.class)
public class AndroidReadCacheTest {
    static final String HOME = ROOT + "/home/base";
    static final String LOCATIONS = ROOT + "/locations";
    static final String HOME_BODY = "{\"viewerUserId\":\"" + KEY + "\",\"snapshot\":{},\"quickActions\":[],\"communities\":{},\"promotions\":{},\"locations\":[],\"additionalLinks\":[],\"capabilities\":{}}";
    static final Map<String, String> AUTH = Collections.singletonMap("authorization", "Bearer " + JWT);
    static class TestClock implements Clock {
        long wall = 1_790_531_000_000L, elapsed = 1000;
        public long wall() { return wall; }
        public long elapsed() { return elapsed; }
        void advance(long ms) { wall += ms; elapsed += ms; }
    }
    static class CacheStore implements AndroidReadCache.Store {
        byte[] bytes;
        String principal;
        boolean failWrite, failClear, purge;
        public byte[] read(String who) throws Exception {
            if (purge) clear();
            if (bytes != null && !who.equals(principal)) throw new Exception("Wrong identity");
            return bytes;
        }
        public void write(String who, byte[] value) throws Exception {
            if (purge) clear();
            if (failWrite) throw new Exception("Full device");
            principal = who; bytes = value;
        }
        public void clear() throws Failure {
            purge = true;
            if (failClear) throw new Failure("NATIVE_CACHE_UNAVAILABLE");
            bytes = null; principal = null; purge = false;
        }
    }
    static class Fixture {
        final TestClock clock = new TestClock();
        final MemoryStore credentials = new MemoryStore();
        final CacheStore disk = new CacheStore();
        final AndroidSessionPolicy policy;
        AndroidSessionEngine engine;
        int calls;
        int apiStatus = 200;
        String failure, sessionBody = SESSION, locationsBody = "{\"items\":[]}";
        Fixture() throws Exception {
            policy = new AndroidSessionPolicy(ORIGIN, "local-padel", "test", "3", false);
            restart();
            engine.request(VERIFY, "POST", headers(null, KEY), VERIFY_BODY);
        }
        void restart() {
            engine = new AndroidSessionEngine(policy, credentials, request -> {
                if (request.operation == Operation.REFRESH || request.operation == Operation.VERIFY)
                    return response(200, sessionBody, Collections.singletonList(cookie(SUCCESSOR)));
                calls++;
                if (failure != null) throw new Failure(failure);
                if (request.operation == Operation.LOGOUT) return Response.loggedOut();
                return response(apiStatus, request.path.equals(HOME) ? HOME_BODY : locationsBody, Collections.emptyList());
            }, new AndroidReadCache(ROOT, disk), clock);
        }
        Response read(String path) throws Exception { return engine.request(path, "GET", AUTH, null); }
        Response refresh() throws Exception { return engine.request(ROOT + "/auth/session/refresh", "POST", headers("refresh", KEY), null); }
    }

    @Test public void freshTtlBoundaryIsNotSlidingAndStaleNeedsTransientFailure() throws Exception {
        for (String path : Arrays.asList(HOME, LOCATIONS)) {
            Fixture f = new Fixture(); long ttl = path.equals(HOME) ? 30_000 : 60_000;
            assertNull(f.read(path).cache); long savedAt = f.clock.wall;
            f.clock.advance(ttl - 1);
            Response hit = f.read(path); assertFalse(hit.cache.stale); assertEquals(savedAt, hit.cache.savedAt); assertEquals(1, f.calls);
            f.clock.advance(1); f.failure = "NATIVE_NETWORK_UNAVAILABLE";
            Response fallback = f.read(path); assertTrue(fallback.cache.stale); assertEquals(savedAt, fallback.cache.savedAt); assertEquals(2, f.calls);
            f.failure = null; f.clock.advance(1);
            assertNull(f.read(path).cache); assertEquals(3, f.calls);
            assertEquals(f.clock.wall, f.read(path).cache.savedAt);
        }
    }

    @Test public void restartRequiresLiveRefreshThenReusesThePersistedSnapshot() throws Exception {
        Fixture f = new Fixture(); f.read(HOME); int before = f.calls;
        f.restart(); f.failure = "NATIVE_NETWORK_UNAVAILABLE";
        new AndroidSessionTest().fails("NATIVE_NETWORK_UNAVAILABLE", () -> f.read(HOME));
        assertEquals(before + 1, f.calls);
        f.refresh();
        assertNotNull(f.read(HOME).cache); assertEquals(before + 1, f.calls);
    }

    @Test public void differentBearerExpiredAccessAndPendingRotationNeverGetCachedData() throws Exception {
        Fixture f = new Fixture(); f.read(HOME); f.failure = "NATIVE_NETWORK_UNAVAILABLE";
        new AndroidSessionTest().fails("NATIVE_NETWORK_UNAVAILABLE", () -> f.engine.request(HOME, "GET", Collections.singletonMap("authorization", "Bearer other-token"), null));
        // Only monotonic time advances: rolling the wall clock back cannot extend the access grant.
        f.clock.elapsed += 3_600_000;
        new AndroidSessionTest().fails("NATIVE_NETWORK_UNAVAILABLE", () -> f.read(HOME));
        f.refresh(); f.credentials.value = f.credentials.value.journal(KEY, null);
        new AndroidSessionTest().fails("NATIVE_NETWORK_UNAVAILABLE", () -> f.read(HOME));
    }

    @Test public void hardExpiryAndWallClockRollbackDiscardTheCopy() throws Exception {
        for (long age : new long[] { 15 * 60_000, -1 }) {
            Fixture f = new Fixture(); f.read(HOME); f.clock.advance(age); f.failure = "NATIVE_NETWORK_UNAVAILABLE";
            new AndroidSessionTest().fails("NATIVE_NETWORK_UNAVAILABLE", () -> f.read(HOME));
        }
        Fixture f = new Fixture(); f.read(LOCATIONS); f.clock.advance(24 * 60 * 60_000L);
        f.credentials.value = new Credential(f.policy.scope, REFRESH, f.clock.wall + 3600_000, null, null, new Principal(KEY, NEXT_KEY));
        f.refresh(); f.failure = "NATIVE_NETWORK_UNAVAILABLE";
        new AndroidSessionTest().fails("NATIVE_NETWORK_UNAVAILABLE", () -> f.read(LOCATIONS));
    }

    @Test public void httpDenialsAndTlsNeverFallBackAndDenialsInvalidate() throws Exception {
        for (int status : new int[] { 400, 401, 403, 404, 409, 422, 429, 500 }) {
            Fixture f = new Fixture(); f.read(HOME); f.read(LOCATIONS); f.clock.advance(30_000); f.apiStatus = status;
            Response response = f.read(HOME); assertEquals(status, response.status); assertNull(response.cache);
            if (status == 401) assertNull(f.disk.bytes);
            if (status == 403 || status == 404) {
                assertNotNull(f.read(LOCATIONS).cache);
                f.failure = "NATIVE_NETWORK_UNAVAILABLE";
                new AndroidSessionTest().fails("NATIVE_NETWORK_UNAVAILABLE", () -> f.read(HOME));
            }
        }
        for (String failure : Arrays.asList("NATIVE_TLS_REJECTED", "NATIVE_REDIRECT_REJECTED", "NATIVE_RESPONSE_REJECTED", "NATIVE_STORAGE_UNAVAILABLE")) {
            Fixture f = new Fixture(); f.read(HOME); f.clock.advance(30_000); f.failure = failure;
            new AndroidSessionTest().fails(failure, () -> f.read(HOME));
        }
        for (int status : new int[] { 502, 503, 504 }) {
            Fixture f = new Fixture(); f.read(HOME); f.clock.advance(30_000); f.apiStatus = status;
            assertTrue(f.read(HOME).cache.stale);
        }
    }

    @Test public void logoutIntentErasesCacheBeforeRevokeAndSurvivesPurgeFailure() throws Exception {
        Fixture f = new Fixture(); f.read(HOME); assertNotNull(f.read(HOME).cache);
        f.disk.failClear = true;
        new AndroidSessionTest().fails("NATIVE_CACHE_UNAVAILABLE", () -> f.engine.request(ROOT + "/auth/session", "DELETE", headers("logout", KEY), null));
        assertEquals(KEY, f.credentials.logout); assertEquals(1, f.calls);
        f.restart();
        new AndroidSessionTest().fails("NATIVE_CACHE_UNAVAILABLE", () -> f.read(HOME));
        f.disk.failClear = false; f.failure = "NATIVE_NETWORK_UNAVAILABLE";
        assertEquals(401, f.read(HOME).status); assertNull(f.disk.bytes);
        new AndroidSessionTest().fails("NATIVE_NETWORK_UNAVAILABLE", f::refresh);
        f.failure = null; assertEquals(401, f.refresh().status); assertNull(f.credentials.value);
    }

    @Test public void refreshCannotSwitchAccountAndOldCredentialCanUpgrade() throws Exception {
        Fixture f = new Fixture(); f.read(HOME);
        f.sessionBody = SESSION.replace(KEY, "00000000-0000-4000-8000-000000000099");
        new AndroidSessionTest().fails("NATIVE_RESPONSE_REJECTED", f::refresh);
        assertNull(f.disk.bytes); assertEquals(KEY, f.credentials.value.identity.userId);
        assertNotNull(f.credentials.value.refreshKey);
        f.sessionBody = SESSION;
        f.credentials.value = new Credential(f.policy.scope, REFRESH, f.clock.wall + 3600_000, null, null);
        f.restart(); f.refresh(); assertEquals(KEY, f.credentials.value.identity.userId);
    }

    @Test public void failed401PurgeCannotResurrectSnapshotAfterRefreshAndProcessDeath() throws Exception {
        Fixture f = new Fixture(); f.read(HOME); f.clock.advance(30_000);
        f.apiStatus = 401; f.disk.failClear = true;
        new AndroidSessionTest().fails("NATIVE_CACHE_UNAVAILABLE", () -> f.read(HOME));
        assertTrue(f.disk.purge);
        f.restart(); f.disk.failClear = false; f.refresh();
        assertNull(f.disk.bytes);
        f.failure = "NATIVE_NETWORK_UNAVAILABLE";
        new AndroidSessionTest().fails("NATIVE_NETWORK_UNAVAILABLE", () -> f.read(HOME));
    }

    @Test public void actualAccountSwitchNeverLoadsPreviousSnapshots() throws Exception {
        Fixture f = new Fixture(); f.read(HOME);
        // Simulate a restored, independently confirmed account with a leftover old encrypted cache.
        String other = "00000000-0000-4000-8000-000000000099";
        f.credentials.value = new Credential(f.policy.scope, REFRESH, f.clock.wall + 3600_000, null, null, new Principal(other, NEXT_KEY));
        f.sessionBody = SESSION.replace(KEY, other); f.restart(); f.refresh();
        assertNull(f.disk.bytes); f.failure = "NATIVE_NETWORK_UNAVAILABLE";
        new AndroidSessionTest().fails("NATIVE_NETWORK_UNAVAILABLE", () -> f.read(HOME));
    }

    @Test public void cacheFailureDoesNotFailLiveResponseAndUnknownRoutesNeverPersist() throws Exception {
        Fixture f = new Fixture(); f.disk.failWrite = true;
        assertEquals(200, f.read(HOME).status); assertNull(f.disk.bytes);
        f.disk.failWrite = false;
        for (String path : Arrays.asList(ROOT + "/profile", ROOT + "/notifications", ROOT + "/bookings/upcoming", LOCATIONS + "?limit=10")) {
            assertNull(f.read(path).cache); assertNull(f.disk.bytes);
        }
        AndroidReadCache cache = new AndroidReadCache(ROOT, f.disk);
        cache.activate(new Principal(KEY, NEXT_KEY), f.clock.wall, f.clock.elapsed);
        cache.put(HOME, response(200, HOME_BODY.replace(KEY, NEXT_KEY), Collections.emptyList()), f.clock.wall, f.clock.elapsed);
        assertNull(cache.get(HOME, f.clock.wall, f.clock.elapsed));
        byte[] oversized = new byte[256 * 1024 + 1];
        cache.put(LOCATIONS, new Response(200, Collections.singletonMap("content-type", "application/json"), Collections.emptyList(), oversized), f.clock.wall, f.clock.elapsed);
        assertNull(cache.get(LOCATIONS, f.clock.wall, f.clock.elapsed));
        cache.put(LOCATIONS, response(200, "{\"items\":[{\"accessToken\":\"secret\"}]}", Collections.emptyList()), f.clock.wall, f.clock.elapsed);
        assertNull(cache.get(LOCATIONS, f.clock.wall, f.clock.elapsed));
    }

    @Test public void wrongSchemaAndCorruptRecordsBecomeCacheMisses() throws Exception {
        for (byte[] bytes : Arrays.asList("broken".getBytes(StandardCharsets.UTF_8),
            ("{\"schema\":99,\"principal\":\"" + NEXT_KEY + "|" + KEY + "\",\"entries\":{}}").getBytes(StandardCharsets.UTF_8), new byte[AndroidReadCache.MAX_BYTES + 1])) {
            Fixture f = new Fixture(); f.read(HOME); f.disk.bytes = bytes;
            f.restart(); f.refresh(); assertNull(f.disk.bytes);
        }
    }

    @Test public void keystoreCiphertextScopeCorruptionAndCryptoEraseSurviveRestart() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String scope = ORIGIN + "|cache-test-" + UUID.randomUUID();
        AndroidReadCacheStore store = new AndroidReadCacheStore(context, scope);
        String identity = NEXT_KEY + "|" + KEY;
        byte[] data = ("synthetic private home " + KEY).getBytes(StandardCharsets.UTF_8);
        try {
            store.write(identity, data);
            byte[] ciphertext = java.nio.file.Files.readAllBytes(store.file.getBaseFile().toPath());
            String raw = new String(ciphertext, StandardCharsets.ISO_8859_1);
            assertFalse(raw.contains(KEY)); assertFalse(raw.contains("synthetic private home")); assertFalse(raw.contains(JWT)); assertFalse(raw.contains(REFRESH));
            assertArrayEquals(data, new AndroidReadCacheStore(context, scope).read(identity));
            try { store.read("other"); fail("Wrong AAD"); } catch (javax.crypto.AEADBadTagException expected) { }
            assertNull(new AndroidReadCacheStore(context, scope + "other").read(identity));
            byte[] damaged = ciphertext.clone(); damaged[damaged.length - 1] ^= 1;
            java.nio.file.Files.write(store.file.getBaseFile().toPath(), damaged);
            try { store.read(identity); fail("Corruption"); } catch (javax.crypto.AEADBadTagException expected) { }
            store.clear();
            // Crash after key erasure, before old file cleanup: old ciphertext must stay unreadable.
            java.nio.file.Files.write(store.file.getBaseFile().toPath(), ciphertext);
            try { store.read(identity); fail("Erased key"); } catch (Failure expected) { }
            store.write(identity, "new snapshot".getBytes(StandardCharsets.UTF_8));
            assertEquals("new snapshot", new String(store.read(identity), StandardCharsets.UTF_8));
            java.io.FileOutputStream pending = store.purge.startWrite(); pending.write(1); store.purge.finishWrite(pending);
            assertNull(new AndroidReadCacheStore(context, scope).read(identity));
            assertFalse(store.file.getBaseFile().exists());
        } finally { store.clear(); }
    }
}
