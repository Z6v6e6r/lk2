package ru.padlhub.app;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class AndroidPushStateTest {
    static final String USER = "00000000-0000-4000-8000-000000000001";
    static final String OTHER = "00000000-0000-4000-8000-000000000002";
    static final String ENDPOINT = "00000000-0000-4000-8000-000000000003";
    static final String DELIVERY = "00000000-0000-4000-8000-000000000004";
    static final String TOKEN = "synthetic_fcm_registration_token_000001";
    Context context;
    File directory;
    AndroidSessionPolicy policy;
    AndroidCredentialStore credentials;
    AndroidPushState state;

    @Before public void setup() throws Exception {
        Context base = InstrumentationRegistry.getInstrumentation().getTargetContext();
        directory = new File(base.getCacheDir(), "push-test-" + UUID.randomUUID());
        assertTrue(directory.mkdirs());
        context = new ContextWrapper(base) {
            @Override public File getNoBackupFilesDir() { return directory; }
            @Override public Context getApplicationContext() { return this; }
        };
        policy = new AndroidSessionPolicy("https://lk2.padlhub.su", "push-test-" + UUID.randomUUID(), "test", "8", false);
        credentials = new AndroidCredentialStore(context, policy.scope);
        login(USER);
        state = new AndroidPushState(context, policy);
    }
    @After public void cleanup() throws Exception {
        credentials.clear(); credentials.clearLogoutIntent();
        File[] files = directory.listFiles(); if (files != null) for (File file : files) assertTrue(file.delete());
        assertTrue(directory.delete());
    }
    void login(String user) throws Exception {
        credentials.write(new AndroidSessionEngine.Credential(policy.scope,
            "synthetic_refresh_credential_000000000000001", System.currentTimeMillis() + 3_600_000,
            null, null, new AndroidSessionEngine.Principal(user, OTHER)));
    }
    JSONObject register() throws Exception { return state.registration(TOKEN, state.read().optLong("epoch"), state.account()); }
    void activate(JSONObject registration) throws Exception { state.activate(registration.getString("idempotencyKey"), ENDPOINT); }
    Map<String, String> message(String delivery) {
        Map<String, String> data = new HashMap<>(); data.put("deliveryId", delivery); data.put("endpointId", ENDPOINT); return data;
    }
    @Test public void lostAcknowledgementKeepsCommandKeyAndAcknowledgedKeyIsRetired() throws Exception {
        JSONObject first = register();
        state = new AndroidPushState(context, policy);
        assertEquals(first.getString("idempotencyKey"), register().getString("idempotencyKey"));
        activate(first);
        assertTrue(state.active());
        assertNotEquals(first.getString("idempotencyKey"), register().getString("idempotencyKey"));
        String saved = new String(java.nio.file.Files.readAllBytes(new File(directory, "padlhub-push.json").toPath()), StandardCharsets.UTF_8);
        assertFalse(saved.contains(TOKEN)); assertFalse(saved.contains(USER));
    }
    @Test public void suspendInvalidatesLateTokenCallbackAndOldAcknowledgement() throws Exception {
        JSONObject pending = register(); long epoch = state.read().optLong("epoch"); String account = state.account();
        JSONObject revoke = state.suspend();
        assertTrue(revoke.getBoolean("pendingRevoke")); assertTrue(revoke.getBoolean("revokeCurrentAccount"));
        assertEquals(revoke.getString("idempotencyKey"), state.suspend().getString("idempotencyKey"));
        try { state.registration(TOKEN, epoch, account); fail("late token accepted"); } catch (AndroidSessionPolicy.Failure expected) { }
        try { activate(pending); fail("late acknowledgement accepted"); } catch (AndroidSessionPolicy.Failure expected) { }
        assertFalse(state.accept(message(DELIVERY)));
        state.finishRevoke(revoke.getString("idempotencyKey"));
        activate(register()); assertTrue(state.active());
    }
    @Test public void accountChangeNeverRevokesThroughTheWrongPrincipalOrDisplaysOldEndpoint() throws Exception {
        activate(register()); JSONObject revoke = state.suspend(); login(OTHER);
        assertFalse(state.pending(state.read()).getBoolean("revokeCurrentAccount"));
        assertFalse(state.accept(message(DELIVERY)));
        JSONObject next = register(); activate(next);
        assertFalse(state.pending(state.read()).getBoolean("pendingRevoke"));
        assertNotEquals(revoke.getString("idempotencyKey"), next.getString("idempotencyKey"));
    }
    @Test public void deliveryDeduplicationAndAccountBindingSurviveRestart() throws Exception {
        activate(register()); Map<String, String> data = message(DELIVERY); data.put("deepLink", "/chats/" + USER);
        assertTrue(state.accept(data));
        state = new AndroidPushState(context, policy);
        assertFalse(state.accept(message(DELIVERY)));
        Map<String, String> foreign = message(UUID.randomUUID().toString()); foreign.put("endpointId", USER);
        assertFalse(state.accept(foreign));
        String key = state.openKey(DELIVERY);
        Intent opened = new Intent().putExtra(AndroidPushState.OPEN_KEY, key);
        assertEquals("/chats/" + USER, state.opened(opened)); assertNull(state.opened(opened));
        assertNull(state.opened(new Intent().putExtra(AndroidPushState.OPEN_KEY, key)));
        login(OTHER); assertFalse(state.active());
        assertEquals("/notifications", AndroidPushState.route("https://evil.invalid"));
        assertEquals("/notifications", AndroidPushState.route("/chats/../profile"));
    }
    @Test public void forgedActivityIntentCannotOpenNotificationRoute() throws Exception {
        activate(register()); assertTrue(state.accept(message(DELIVERY)));
        Intent forged = new Intent().putExtra(AndroidPushState.OPEN_ACCOUNT, state.account())
            .putExtra(AndroidPushState.OPEN_ROUTE, "/chats/" + USER);
        assertNull(state.opened(forged));
        assertNull(state.opened(new Intent().putExtra(AndroidPushState.OPEN_KEY, UUID.randomUUID().toString())));
        String key = state.openKey(DELIVERY);
        login(OTHER);
        assertNull(state.opened(new Intent().putExtra(AndroidPushState.OPEN_KEY, key)));
    }
    @Test public void fullWorstCaseJournalSurvivesRestartAndRejectsNewDelivery() throws Exception {
        activate(register());
        JSONObject value = state.read();
        org.json.JSONArray recent = new org.json.JSONArray();
        for (int i = 0; i < AndroidPushState.MAX_RECENT_DELIVERIES; i++)
            recent.put(new JSONObject().put("id", UUID.randomUUID().toString())
                .put("until", System.currentTimeMillis() + 172_800_000L)
                .put("account", state.account()).put("route", "/chats/" + USER)
                .put("openKey", UUID.randomUUID().toString()));
        value.put("recent", recent);
        byte[] bytes = value.toString().getBytes(StandardCharsets.UTF_8);
        assertTrue(bytes.length < AndroidPushState.MAX_STATE_BYTES);
        java.nio.file.Files.write(new File(directory, "padlhub-push.json").toPath(), bytes);
        state = new AndroidPushState(context, policy);
        assertTrue(state.active());
        assertFalse(state.accept(message(DELIVERY)));
        assertEquals(AndroidPushState.MAX_RECENT_DELIVERIES, state.read().getJSONArray("recent").length());
    }
}
