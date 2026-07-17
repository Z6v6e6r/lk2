self.phubSafeDeepLink = function phubSafeDeepLink(value) {
  if (
    typeof value !== 'string' ||
    value.charAt(0) !== '/' ||
    value.slice(0, 2) === '//' ||
    value.indexOf('\\') !== -1
  ) {
    return '/notifications';
  }
  try {
    var url = new URL(value, self.location.origin);
    return url.origin === self.location.origin
      ? url.pathname + url.search + url.hash
      : '/notifications';
  } catch {
    return '/notifications';
  }
};

self.addEventListener('push', function handlePush(event) {
  var payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  var notificationId =
    typeof payload.notificationId === 'string' ? payload.notificationId : 'unknown';
  var deepLink = self.phubSafeDeepLink(payload.deepLink);
  event.waitUntil(
    self.registration.showNotification(
      typeof payload.title === 'string' ? payload.title : 'ПаделХАБ',
      {
        body: typeof payload.preview === 'string' ? payload.preview : 'Новое оповещение',
        tag: 'phub-notification-' + notificationId,
        data: { notificationId: notificationId, deepLink: deepLink },
      },
    ),
  );
});

self.addEventListener('notificationclick', function handleNotificationClick(event) {
  event.notification.close();
  var deepLink = self.phubSafeDeepLink(event.notification.data && event.notification.data.deepLink);
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(function openClient(clients) {
        for (var index = 0; index < clients.length; index += 1) {
          var client = clients[index];
          if (new URL(client.url).origin === self.location.origin) {
            return client.navigate(deepLink).then(function focusClient() {
              return client.focus();
            });
          }
        }
        return self.clients.openWindow(deepLink);
      }),
  );
});
