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
 * Reports that a notification was shown or opened. A service worker has no session and usually runs while
 * the page is closed, so the push payload carries a token that authorises exactly this delivery. A receipt
 * is best effort: whatever happens here must never affect the notification the person sees.
 */
self.phubReportReceipt = function phubReportReceipt(receiptToken, type) {
  if (typeof receiptToken !== 'string' || receiptToken.length < 16) return Promise.resolve();
  // The token names the tenant, so the worker needs no contour value it cannot know.
  return fetch('/user/api/v1/notifications/receipts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: receiptToken, type: type }),
    credentials: 'omit',
    keepalive: true,
  }).catch(function ignoreReceiptFailure() {
    return undefined;
  });
};

/**
 * Shows the notification and, if the platform rejects an option it does not implement, retries with the
 * members every engine supports. iOS ignores the notification artwork and has no vibration API, and a
 * rejected options dictionary would otherwise mean no banner at all.
 */
self.phubShowNotification = function phubShowNotification(title, options) {
  var receiptToken = options.data && options.data.receiptToken;
  return self.registration
    .showNotification(title, options)
    .catch(function fallback() {
      return self.registration.showNotification(title, {
        body: options.body,
        tag: options.tag,
        data: options.data,
      });
    })
    .then(function reportDisplayed() {
      // Reported only after the banner exists, so a counted display is a display.
      return self.phubReportReceipt(receiptToken, 'DISPLAYED');
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
      data: {
        notificationId: notificationId,
        deepLink: deepLink,
        // Present only when the Worker could sign a receipt for this delivery.
        ...(typeof payload.receiptToken === 'string' ? { receiptToken: payload.receiptToken } : {}),
      },
    }),
  );
});

self.addEventListener('notificationclick', function handleNotificationClick(event) {
  event.notification.close();
  var data = event.notification.data || {};
  var deepLink = self.phubSafeDeepLink(data.deepLink);
  // A click is the strongest signal the funnel has, so it is reported before the window is opened.
  event.waitUntil(self.phubReportReceipt(data.receiptToken, 'OPENED'));
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
