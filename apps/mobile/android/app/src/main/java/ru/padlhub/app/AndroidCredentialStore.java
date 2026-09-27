package ru.padlhub.app;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;
import static ru.padlhub.app.AndroidSessionPolicy.Failure;
import static ru.padlhub.app.AndroidSessionEngine.Credential;

/** One atomic, authenticated record. Neither Preferences nor the WebView receives refresh tokens. */
final class AndroidCredentialStore implements AndroidSessionEngine.Store {
    private final String scope;
    private final String alias;
    private final AtomicFile file;
    private final AtomicFile logoutFile;
    private final byte[] aad;

    AndroidCredentialStore(Context context, String scope) throws Failure {
        this.scope = scope;
        aad = (context.getPackageName() + "|" + scope).getBytes(StandardCharsets.UTF_8);
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(scope.getBytes(StandardCharsets.UTF_8));
            StringBuilder suffix = new StringBuilder();
            for (byte value : digest) suffix.append(String.format(java.util.Locale.ROOT, "%02x", value));
            alias = context.getPackageName() + ".session." + suffix;
            file = new AtomicFile(new File(context.getNoBackupFilesDir(), "session-" + suffix + ".bin"));
            logoutFile = new AtomicFile(new File(context.getNoBackupFilesDir(), "session-" + suffix + ".logout"));
        } catch (Exception ignored) { throw unavailable(); }
    }

    private SecretKey key(boolean create) throws Exception {
        KeyStore keys = KeyStore.getInstance("AndroidKeyStore");
        keys.load(null);
        if (keys.containsAlias(alias)) return (SecretKey) keys.getKey(alias, null);
        if (!create) throw unavailable();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }

    @Override public synchronized Credential read() throws Failure {
        if (!file.getBaseFile().exists()) return null;
        try {
            if (file.getBaseFile().length() > 16_384) throw unavailable();
            byte[] bytes = file.readFully();
            if (bytes.length < 30 || bytes[0] != 1) throw unavailable();
            ByteBuffer record = ByteBuffer.wrap(bytes);
            record.get();
            byte[] iv = new byte[12]; record.get(iv);
            byte[] ciphertext = new byte[record.remaining()]; record.get(ciphertext);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, iv));
            cipher.updateAAD(aad);
            JSONObject json = new JSONObject(new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8));
            if (!scope.equals(json.getString("scope")) || !json.getString("value").matches("[A-Za-z0-9_-]{32,512}")) throw unavailable();
            String refresh = json.isNull("refreshKey") ? null : validKey(json.getString("refreshKey"));
            String logout = json.isNull("logoutKey") ? null : validKey(json.getString("logoutKey"));
            AndroidSessionEngine.Principal identity = null;
            if (!json.isNull("identity")) {
                JSONObject savedIdentity = json.getJSONObject("identity");
                identity = new AndroidSessionEngine.Principal(savedIdentity.getString("userId"), savedIdentity.getString("tenantId"));
            }
            return new Credential(scope, json.getString("value"), json.getLong("expiresAt"), refresh, logout, identity);
        } catch (Exception ignored) {
            // A locked/invalidated Keystore or damaged record must never become a false signed-out state.
            throw unavailable();
        }
    }

    @Override public synchronized void write(Credential value) throws Failure {
        FileOutputStream output = null;
        try {
            if (!scope.equals(value.scope)) throw unavailable();
            JSONObject json = new JSONObject().put("scope", scope).put("value", value.value).put("expiresAt", value.expiresAt)
                .put("refreshKey", value.refreshKey == null ? JSONObject.NULL : value.refreshKey)
                .put("logoutKey", value.logoutKey == null ? JSONObject.NULL : value.logoutKey)
                .put("identity", value.identity == null ? JSONObject.NULL : new JSONObject()
                    .put("userId", value.identity.userId).put("tenantId", value.identity.tenantId));
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key(true));
            cipher.updateAAD(aad);
            byte[] ciphertext = cipher.doFinal(json.toString().getBytes(StandardCharsets.UTF_8));
            byte[] bytes = ByteBuffer.allocate(1 + 12 + ciphertext.length).put((byte) 1).put(cipher.getIV()).put(ciphertext).array();
            output = file.startWrite();
            output.write(bytes);
            file.finishWrite(output);
        } catch (Exception ignored) {
            if (output != null) file.failWrite(output);
            throw unavailable();
        }
    }

    @Override public synchronized void clear() throws Failure {
        file.delete();
        if (file.getBaseFile().exists()) throw unavailable();
    }

    @Override public synchronized String logoutIntent() throws Failure {
        if (!logoutFile.getBaseFile().exists()) return null;
        try {
            if (logoutFile.getBaseFile().length() > 1024) throw unavailable();
            JSONObject record = new JSONObject(new String(logoutFile.readFully(), StandardCharsets.UTF_8));
            if (!scope.equals(record.getString("scope"))) throw unavailable();
            return validKey(record.getString("logoutKey"));
        } catch (Exception ignored) { throw unavailable(); }
    }

    @Override public synchronized void beginLogout(String key) throws Failure {
        if (logoutIntent() != null) return;
        FileOutputStream output = null;
        try {
            // Non-secret intent survives a temporarily locked Keystore or failed credential rewrite.
            byte[] bytes = new JSONObject().put("scope", scope).put("logoutKey", validKey(key)).toString().getBytes(StandardCharsets.UTF_8);
            output = logoutFile.startWrite(); output.write(bytes); logoutFile.finishWrite(output);
        } catch (Exception ignored) {
            if (output != null) logoutFile.failWrite(output);
            throw unavailable();
        }
    }

    @Override public synchronized void clearLogoutIntent() throws Failure {
        logoutFile.delete();
        if (logoutFile.getBaseFile().exists()) throw unavailable();
    }

    private String validKey(String value) throws Failure {
        if (!value.matches("[A-Za-z0-9._:-]{16,128}")) throw unavailable();
        return value;
    }

    static Failure unavailable() { return new Failure("NATIVE_STORAGE_UNAVAILABLE"); }
}
