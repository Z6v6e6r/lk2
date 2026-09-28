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
import static ru.padlhub.app.AndroidCredentialStore.unavailable;
import static ru.padlhub.app.AndroidYandexLogin.Pending;

/** Single encrypted, no-backup OAuth journal; purpose-separated from the refresh credential. */
final class AndroidOAuthStore implements AndroidYandexLogin.Store {
    private final AtomicFile file;
    private final String alias, scope;
    private final byte[] aad;
    AndroidOAuthStore(Context context, String scope) throws Failure {
        this.scope = scope;
        aad = (context.getPackageName() + "|android-oauth-v1|" + scope).getBytes(StandardCharsets.UTF_8);
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(aad);
            StringBuilder suffix = new StringBuilder();
            for (byte value : digest) suffix.append(String.format(java.util.Locale.ROOT, "%02x", value));
            alias = context.getPackageName() + ".oauth." + suffix;
            file = new AtomicFile(new File(context.getNoBackupFilesDir(), "oauth-" + suffix + ".bin"));
        } catch (Exception ignored) { throw unavailable(); }
    }
    private SecretKey key(boolean create) throws Exception {
        KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
        if (keys.containsAlias(alias)) return (SecretKey) keys.getKey(alias, null);
        if (!create) throw unavailable();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }
    @Override public Pending read() throws Failure {
        if (!file.getBaseFile().exists() && !new File(file.getBaseFile() + ".bak").exists()) return null;
        try {
            if (file.getBaseFile().length() > 8192) throw unavailable();
            byte[] bytes = file.readFully();
            if (bytes.length < 30 || bytes.length > 8192 || bytes[0] != 1) throw unavailable();
            ByteBuffer record = ByteBuffer.wrap(bytes); record.get();
            byte[] iv = new byte[12]; record.get(iv);
            byte[] ciphertext = new byte[record.remaining()]; record.get(ciphertext);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, iv)); cipher.updateAAD(aad);
            JSONObject json = new JSONObject(new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8));
            if (!scope.equals(json.getString("scope")) || json.length() != 7) throw unavailable();
            return new Pending(token(json.getString("state")), token(json.getString("verifier")),
                command(json.getString("startKey")), command(json.getString("exchangeKey")),
                json.isNull("code") ? null : token(json.getString("code")), json.getLong("expiresAt"));
        } catch (Exception ignored) { throw unavailable(); }
    }
    @Override public void write(Pending value) throws Failure {
        FileOutputStream output = null;
        try {
            JSONObject json = new JSONObject().put("scope", scope).put("state", token(value.state)).put("verifier", token(value.verifier))
                .put("startKey", command(value.startKey)).put("exchangeKey", command(value.exchangeKey))
                .put("code", value.code == null ? JSONObject.NULL : token(value.code)).put("expiresAt", value.expiresAt);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key(true)); cipher.updateAAD(aad);
            byte[] encrypted = cipher.doFinal(json.toString().getBytes(StandardCharsets.UTF_8));
            byte[] bytes = ByteBuffer.allocate(13 + encrypted.length).put((byte) 1).put(cipher.getIV()).put(encrypted).array();
            output = file.startWrite(); output.write(bytes); file.finishWrite(output);
        } catch (Exception ignored) { if (output != null) file.failWrite(output); throw unavailable(); }
    }
    @Override public void clear() throws Failure {
        file.delete();
        if (file.getBaseFile().exists() || new File(file.getBaseFile() + ".bak").exists()) throw unavailable();
    }
    private String token(String value) throws Failure { if (!value.matches("[A-Za-z0-9_-]{43}")) throw unavailable(); return value; }
    private String command(String value) throws Failure { if (!value.matches("[a-f0-9-]{36}")) throw unavailable(); return value; }
}
