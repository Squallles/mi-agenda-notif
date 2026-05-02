// Service Worker for Push Notifications + Alarm
self.addEventListener('push', (event) => {
  let data = { title: 'Mi Agenda', body: 'Tienes un recordatorio' };
  try { data = event.data.json(); } catch (e) {}

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // Show system notification with persistent vibration
      self.registration.showNotification(data.title, {
        body: data.body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        vibrate: [500, 200, 500, 200, 500, 200, 500, 200, 500],
        requireInteraction: true,
        tag: 'alarm-' + Date.now(),
        renotify: true
      });

      if (windowClients.length > 0) {
        // App is open — send alarm message to play sound
        windowClients.forEach(client => {
          client.postMessage({ type: 'ALARM', title: data.title, body: data.body });
        });
        return windowClients[0].focus().catch(() => {});
      } else {
        // App is closed — open it with alarm parameter
        return self.clients.openWindow('/?alarm=' + encodeURIComponent(JSON.stringify(data)));
      }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      clients.forEach(c => c.postMessage({ type: 'STOP_ALARM' }));
      if (clients.length > 0) return clients[0].focus();
      return self.clients.openWindow('/');
    })
  );
});
