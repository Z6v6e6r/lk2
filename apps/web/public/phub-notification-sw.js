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

/**
 * Shows the notification and, if the platform rejects an option it does not implement, retries with the
 * members every engine supports. iOS ignores the notification artwork and has no vibration API, and a
 * rejected options dictionary would otherwise mean no banner at all.
 */
self.phubShowNotification = function phubShowNotification(title, options) {
  return self.registration.showNotification(title, options).catch(function fallback() {
    return self.registration.showNotification(title, {
      body: options.body,
      tag: options.tag,
      data: options.data,
    });
  });
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
    self.phubShowNotification(typeof payload.title === 'string' ? payload.title : 'ПаделХАБ', {
      body: typeof payload.preview === 'string' ? payload.preview : 'Новое оповещение',
      tag: 'phub-notification-' + notificationId,
      // A repeat of the same notification replaces the older one and alerts again instead of
      // silently updating it.
      renotify: true,
      icon: '/phub-notification-icon-192.png',
      badge: '/phub-notification-badge-72.png',
      // Android honours this while the device is awake and the site's own channel allows it; the
      // operating system still owns the banner, priority and Do Not Disturb decisions.
      vibrate: [200, 100, 200],
      silent: false,
      lang: 'ru',
      dir: 'ltr',
      timestamp: Date.now(),
      data: { notificationId: notificationId, deepLink: deepLink },
    }),
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
