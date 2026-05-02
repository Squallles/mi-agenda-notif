// Service Worker for Push Notifications + Alarm Burst
self.addEventListener('push', (event) => {
  let data = { title: 'Mi Agenda', body: 'Tienes un recordatorio' };
  try { data = event.data.json(); } catch (e) {}

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title, {
        body: data.body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        vibrate: [500, 200, 500, 200, 500, 200, 500],
        requireInteraction: true,
        tag: 'alarm',
        renotify: true
      }),
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        if (clients.length > 0) {
          clients.forEach(client => {
            client.postMessage({ type: 'ALARM', title: data.title, body: data.body });
          });
          return clients[0].focus().catch(() => {});
        } else {
          return self.clients.openWindow('/?alarm=' + encodeURIComponent(JSON.stringify(data)));
        }
      })
    ])
  );
});

// Stop burst when notification is dismissed (swipe away)
self.addEventListener('notificationclose', (event) => {
  event.waitUntil(
    fetch('/api/stop-alarm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'miagenda-notif-sk-ad6eec2c9dcdcd64c58b7c5bda05d431' },
      body: JSON.stringify({})
    }).catch(() => {})
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    Promise.all([
      // Stop burst on server
      fetch('/api/stop-alarm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'miagenda-notif-sk-ad6eec2c9dcdcd64c58b7c5bda05d431' },
        body: JSON.stringify({})
      }).catch(() => {}),
      // Stop alarm in open clients or open app
      self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(c => c.postMessage({ type: 'STOP_ALARM' }));
        if (clients.length > 0) return clients[0].focus();
        return self.clients.openWindow('/');
      })
    ])
  );
});
