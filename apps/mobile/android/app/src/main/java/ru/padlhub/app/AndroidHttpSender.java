package ru.padlhub.app;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.CookieHandler;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HttpsURLConnection;
import static ru.padlhub.app.AndroidSessionPolicy.Failure;
import static ru.padlhub.app.AndroidSessionPolicy.Request;
import static ru.padlhub.app.AndroidSessionEngine.Response;

final class AndroidHttpSender implements AndroidSessionEngine.Sender {
    private final String origin;
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
    AndroidHttpSender(String origin) { this.origin = origin; }

    @Override public Response send(Request request) throws Failure {
        HttpsURLConnection connection = null;
        ScheduledFuture<?> deadline = null;
        try {
            // Do not share an ambient native cookie jar with the app's credential store.
            if (CookieHandler.getDefault() != null) throw new Failure("NATIVE_REQUEST_REJECTED");
            connection = (HttpsURLConnection) new URL(origin + request.path).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setAllowUserInteraction(false);
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(15_000);
            connection.setRequestMethod(request.method);
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setRequestProperty("Cache-Control", "no-store");
            for (Map.Entry<String, String> header : request.headers.entrySet()) connection.setRequestProperty(header.getKey(), header.getValue());
            HttpsURLConnection active = connection;
            deadline = timer.schedule(active::disconnect, 30, TimeUnit.SECONDS);
            long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
            if (request.body != null) {
                byte[] body = request.body.getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(body.length);
                try (java.io.OutputStream output = connection.getOutputStream()) { output.write(body); }
            }
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) throw new Failure("NATIVE_REDIRECT_REJECTED");
            Map<String, String> headers = new HashMap<>();
            List<String> cookies = new ArrayList<>();
            int headerSize = 0;
            for (Map.Entry<String, List<String>> entry : connection.getHeaderFields().entrySet()) {
                if (entry.getKey() == null) continue;
                for (String value : entry.getValue()) {
                    headerSize += entry.getKey().length() + value.length();
                    if (headerSize > 32_768) throw new Failure("NATIVE_RESPONSE_REJECTED");
                    if (entry.getKey().equalsIgnoreCase("set-cookie")) cookies.add(value);
                    else headers.put(entry.getKey().toLowerCase(java.util.Locale.ROOT), value);
                }
            }
            if (connection.getContentLengthLong() > 1024 * 1024) throw new Failure("NATIVE_RESPONSE_REJECTED");
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            try (InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream()) {
                if (stream != null) {
                    byte[] buffer = new byte[8192];
                    int count;
                    while ((count = stream.read(buffer)) != -1) {
                        if (body.size() + count > 1024 * 1024 || System.nanoTime() > until) throw new Failure("NATIVE_RESPONSE_REJECTED");
                        body.write(buffer, 0, count);
                    }
                }
            }
            return new Response(status, headers, cookies, body.toByteArray());
        } catch (Failure error) { throw error; }
        catch (javax.net.ssl.SSLException ignored) { throw new Failure("NATIVE_TLS_REJECTED"); }
        catch (Exception ignored) { throw new Failure("NATIVE_NETWORK_UNAVAILABLE"); }
        finally {
            if (deadline != null) deadline.cancel(false);
            if (connection != null) connection.disconnect();
        }
    }

    void close() { timer.shutdownNow(); }
}
