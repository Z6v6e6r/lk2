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
import static ru.padlhub.app.AndroidSessionPolicy.Failure;

/** Disposable encrypted snapshot, separate from refresh credentials and excluded from backups. */
final class AndroidReadCacheStore implements AndroidReadCache.Store {
    final AtomicFile file;
    final AtomicFile purge;
    final String alias;
    private final String scope;

    AndroidReadCacheStore(Context context, String policyScope) throws Failure {
        scope = context.getPackageName() + "|" + policyScope + "|read-cache-v1";
        try {
            StringBuilder suffix = new StringBuilder();
            for (byte b : MessageDigest.getInstance("SHA-256").digest(scope.getBytes(StandardCharsets.UTF_8)))
                suffix.append(String.format(java.util.Locale.ROOT, "%02x", b));
            alias = context.getPackageName() + ".read-cache." + suffix;
            file = new AtomicFile(new File(context.getNoBackupFilesDir(), "read-cache-" + suffix + ".bin"));
            purge = new AtomicFile(new File(context.getNoBackupFilesDir(), "read-cache-" + suffix + ".purge"));
        } catch (Exception ignored) { throw unavailable(); }
    }

    private KeyStore keys() throws Exception {
        KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null); return keys;
    }

    private SecretKey key(boolean create) throws Exception {
        KeyStore keys = keys();
        if (keys.containsAlias(alias)) return (SecretKey) keys.getKey(alias, null);
        if (!create) throw unavailable();
        // A crash between key erasure and file cleanup must never make old ciphertext reusable.
        file.delete();
        if (exists(file)) throw unavailable();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }

    private byte[] aad(String principal) { return (scope + "|" + principal).getBytes(StandardCharsets.UTF_8); }

    @Override public byte[] read(String principal) throws Exception {
        if (exists(purge)) clear();
        if (!file.getBaseFile().exists()) return null;
        if (file.getBaseFile().length() > AndroidReadCache.MAX_BYTES + 29) throw unavailable();
        byte[] bytes = file.readFully();
        if (bytes.length < 29 || bytes[0] != AndroidReadCache.SCHEMA) throw unavailable();
        ByteBuffer record = ByteBuffer.wrap(bytes); record.get();
        byte[] iv = new byte[12]; record.get(iv);
        byte[] ciphertext = new byte[record.remaining()]; record.get(ciphertext);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, iv)); cipher.updateAAD(aad(principal));
        return cipher.doFinal(ciphertext);
    }

    @Override public void write(String principal, byte[] bytes) throws Exception {
        if (bytes.length > AndroidReadCache.MAX_BYTES) throw unavailable();
        if (exists(purge)) clear();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(true)); cipher.updateAAD(aad(principal));
        byte[] encrypted = cipher.doFinal(bytes);
        byte[] record = ByteBuffer.allocate(13 + encrypted.length).put((byte) AndroidReadCache.SCHEMA)
            .put(cipher.getIV()).put(encrypted).array();
        FileOutputStream output = null;
        try {
            output = file.startWrite(); output.write(record); file.finishWrite(output);
        } catch (Exception error) { if (output != null) file.failWrite(output); throw error; }
    }

    @Override public void clear() throws Failure {
        // Non-secret intent survives process death even when key deletion is temporarily unavailable.
        // Attempt both erasures independently if intent/key storage fails; never leave the file just
        // because the Keystore operation threw. Successful key erasure is still mandatory for logout.
        FileOutputStream marker = null;
        try {
            marker = purge.startWrite(); marker.write(1); purge.finishWrite(marker);
        } catch (Exception ignored) { if (marker != null) purge.failWrite(marker); }
        boolean erased = false;
        try {
            KeyStore keys = keys();
            if (keys.containsAlias(alias)) keys.deleteEntry(alias);
            erased = !keys.containsAlias(alias);
        } catch (Exception ignored) { /* Attempt file erasure too, preserving the pending marker. */ }
        try { file.delete(); } catch (Exception ignored) { /* An erased key already protects residual ciphertext. */ }
        if (!erased) throw unavailable();
        if (!exists(file)) purge.delete();
    }

    private boolean exists(AtomicFile record) {
        File base = record.getBaseFile();
        return base.exists() || new File(base.getPath() + ".bak").exists() || new File(base.getPath() + ".new").exists();
    }

    private static Failure unavailable() { return new Failure("NATIVE_CACHE_UNAVAILABLE"); }
}
