package ru.padlhub.app;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.cert.X509Certificate;
import java.util.*;
import java.util.concurrent.*;
import javax.net.ssl.*;
import javax.security.auth.x500.X500Principal;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class AndroidHttpSenderTest {
    @Test public void refreshAvoidsAndroidImplicitFormContentType() throws Exception {
        Map<String, String> headers = AndroidSessionTest.headers("refresh", AndroidSessionTest.KEY);
        headers.put("cookie", "phub_refresh=" + AndroidSessionTest.REFRESH);
        String captured = sendToLoopback(new AndroidSessionPolicy.Request("/user/api/v1/local-padel/auth/session/refresh", "POST", headers, null, AndroidSessionPolicy.Operation.REFRESH));
        assertTrue(captured, captured.toLowerCase(Locale.ROOT).contains("content-type: text/plain\n"));
        assertTrue(captured, captured.endsWith("\n\n"));
        assertTrue(captured, captured.contains("idempotency-key: " + AndroidSessionTest.KEY + "\n"));
        assertTrue(captured, captured.contains("cookie: phub_refresh=" + AndroidSessionTest.REFRESH + "\n"));
    }

    @Test public void jsonAuthenticationPostKeepsItsPayloadAndMediaType() throws Exception {
        Map<String, String> headers = AndroidSessionTest.headers(null, AndroidSessionTest.KEY);
        headers.put("content-type", "application/json");
        String captured = sendToLoopback(new AndroidSessionPolicy.Request(AndroidSessionTest.VERIFY, "POST", headers, AndroidSessionTest.VERIFY_BODY, AndroidSessionPolicy.Operation.VERIFY));
        assertTrue(captured, captured.toLowerCase(Locale.ROOT).contains("content-type: application/json\n"));
        assertTrue(captured, captured.endsWith("\n\n" + AndroidSessionTest.VERIFY_BODY));
    }

    @Test public void readsStayBodylessAndLogoutAvoidsImplicitFormContentType() throws Exception {
        for (AndroidSessionPolicy.Request request : Arrays.asList(
            new AndroidSessionPolicy.Request(AndroidSessionTest.ROOT + "/profile", "GET", Collections.singletonMap("accept", "application/json"), null, AndroidSessionPolicy.Operation.API),
            new AndroidSessionPolicy.Request(AndroidSessionTest.ROOT + "/auth/session", "DELETE", AndroidSessionTest.headers("logout", AndroidSessionTest.KEY), null, AndroidSessionPolicy.Operation.LOGOUT))) {
            String captured = sendToLoopback(request);
            if (request.operation == AndroidSessionPolicy.Operation.LOGOUT)
                assertTrue(captured, captured.toLowerCase(Locale.ROOT).contains("content-type: text/plain\n"));
            else assertFalse(captured, captured.toLowerCase(Locale.ROOT).contains("content-type:"));
            assertTrue(captured, captured.endsWith("\n\n"));
        }
    }

    private String sendToLoopback(AndroidSessionPolicy.Request request) throws Exception {
        String alias = "padlhub-http-test-" + UUID.randomUUID();
        KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
        KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
        generator.initialize(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
            .setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256)
            .setCertificateSubject(new X500Principal("CN=localhost")).build());
        generator.generateKeyPair();
        X509Certificate certificate = (X509Certificate) keys.getCertificate(alias);
        PrivateKey privateKey = (PrivateKey) keys.getKey(alias, null);
        X509ExtendedKeyManager manager = new X509ExtendedKeyManager() {
            public String[] getClientAliases(String type, java.security.Principal[] issuers) { return null; }
            public String chooseClientAlias(String[] types, java.security.Principal[] issuers, Socket socket) { return null; }
            public String[] getServerAliases(String type, java.security.Principal[] issuers) { return "EC".equals(type) ? new String[] {alias} : null; }
            public String chooseServerAlias(String type, java.security.Principal[] issuers, Socket socket) { return "EC".equals(type) ? alias : null; }
            public X509Certificate[] getCertificateChain(String selected) { return new X509Certificate[] {certificate}; }
            public PrivateKey getPrivateKey(String selected) { return privateKey; }
        };
        SSLContext serverContext = SSLContext.getInstance("TLS"); serverContext.init(new KeyManager[] {manager}, null, null);
        KeyStore trusted = KeyStore.getInstance(KeyStore.getDefaultType()); trusted.load(null); trusted.setCertificateEntry(alias, certificate);
        TrustManagerFactory trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()); trust.init(trusted);
        SSLContext clientContext = SSLContext.getInstance("TLS"); clientContext.init(null, trust.getTrustManagers(), null);
        SSLSocketFactory previousFactory = HttpsURLConnection.getDefaultSSLSocketFactory();
        HostnameVerifier previousVerifier = HttpsURLConnection.getDefaultHostnameVerifier();
        ExecutorService executor = Executors.newSingleThreadExecutor();
        AndroidHttpSender sender = null;
        try (SSLServerSocket server = (SSLServerSocket) serverContext.getServerSocketFactory().createServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            server.setEnabledProtocols(new String[] {"TLSv1.2"});
            server.setEnabledCipherSuites(new String[] {"TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256"}); server.setSoTimeout(10_000);
            Future<String> wire = executor.submit(() -> {
                try (SSLSocket socket = (SSLSocket) server.accept()) {
                    socket.setSoTimeout(10_000);
                    BufferedReader input = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                    StringBuilder captured = new StringBuilder();
                    int length = 0; String type = null; String line;
                    while ((line = input.readLine()) != null && !line.isEmpty()) {
                        captured.append(line).append('\n');
                        if (line.toLowerCase(Locale.ROOT).startsWith("content-length:")) length = Integer.parseInt(line.substring(15).trim());
                        if (line.toLowerCase(Locale.ROOT).startsWith("content-type:")) type = line.substring(13).trim();
                    }
                    char[] body = new char[length]; int read = 0;
                    while (read < length) { int count = input.read(body, read, length - read); if (count < 0) throw new EOFException(); read += count; }
                    captured.append('\n').append(body);
                    // Fastify accepts empty text/plain but rejects the implicit form media type.
                    int status = (type == null && length == 0) || ("text/plain".equals(type) && length == 0) || ("application/json".equals(type) && length > 0) ? 200 : 415;
                    socket.getOutputStream().write(("HTTP/1.1 " + status + " Test\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").getBytes(StandardCharsets.UTF_8));
                    socket.getOutputStream().flush();
                    return captured.toString();
                }
            });
            // Test-only trust is pinned to a generated disposable loopback certificate.
            HttpsURLConnection.setDefaultSSLSocketFactory(clientContext.getSocketFactory());
            HttpsURLConnection.setDefaultHostnameVerifier((host, session) -> {
                try { return "127.0.0.1".equals(host) && Arrays.equals(certificate.getEncoded(), session.getPeerCertificates()[0].getEncoded()); }
                catch (Exception ignored) { return false; }
            });
            sender = new AndroidHttpSender("https://127.0.0.1:" + server.getLocalPort());
            AndroidSessionEngine.Response response;
            try { response = sender.send(request); }
            catch (AndroidSessionPolicy.Failure error) { wire.get(10, TimeUnit.SECONDS); throw error; }
            String captured = wire.get(10, TimeUnit.SECONDS);
            assertEquals(captured, 200, response.status);
            return captured;
        } finally {
            HttpsURLConnection.setDefaultSSLSocketFactory(previousFactory);
            HttpsURLConnection.setDefaultHostnameVerifier(previousVerifier);
            if (sender != null) sender.close();
            executor.shutdownNow(); keys.deleteEntry(alias);
        }
    }
}
