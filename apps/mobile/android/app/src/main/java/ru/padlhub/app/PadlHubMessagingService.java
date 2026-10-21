package ru.padlhub.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/** Data-only FCM: native identity and local consent are checked before displaying anything. */
public final class PadlHubMessagingService extends FirebaseMessagingService {
    static final String CHANNEL = "padlhub_events";
    @Override public void onNewToken(String token) { PadlHubAndroidPushPlugin.changed(); }
    @Override public void onMessageReceived(RemoteMessage message) {
        synchronized (AndroidPushState.LOCK) {
            try {
                if (!NotificationManagerCompat.from(this).areNotificationsEnabled()
                    || (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)) return;
                AndroidPushState state = AndroidPushState.fromBundle(this);
                if (!state.accept(message.getData())) return;
                NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                if (Build.VERSION.SDK_INT >= 26)
                    manager.createNotificationChannel(new NotificationChannel(CHANNEL, "События ПадлХАБ", NotificationManager.IMPORTANCE_DEFAULT));
                Intent intent = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    .putExtra(AndroidPushState.OPEN_KEY, state.openKey(message.getData().get("deliveryId")));
                String delivery = message.getData().get("deliveryId");
                intent.setData(android.net.Uri.parse("padlhub-push://delivery/" + delivery));
                PendingIntent open = PendingIntent.getActivity(this, delivery.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                manager.notify(delivery, 0, new NotificationCompat.Builder(this, CHANNEL)
                    .setSmallIcon(R.drawable.ic_stat_padlhub).setContentTitle("ПадлХАБ")
                    .setContentText("У вас новое уведомление").setContentIntent(open).setAutoCancel(true)
                    .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build());
            } catch (Exception ignored) { /* Fail closed; no payload, token or exception logging. */ }
        }
    }
}
