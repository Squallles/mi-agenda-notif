// Service Worker for Push Notifications + Alarm Burst
const API_KEY = 'miagenda-notif-sk-ad6eec2c9dcdcd64c58b7c5bda05d431';

function stopBurst() {
  return fetch(self.registration.scope + 'api/stop-alarm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({})
  }).catch(() => {});
}

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
        renotify: true,
        actions: [{ action: 'stop', title: 'Parar' }]
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

// Notification tapped or action button pressed
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    Promise.all([
      stopBurst(),
      self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(c => c.postMessage({ type: 'STOP_ALARM' }));
        if (clients.length > 0) return clients[0].focus();
        return self.clients.openWindow('/');
      })
    ])
  );
});

// Notification swiped away
self.addEventListener('notificationclose', (event) => {
  event.waitUntil(stopBurst());
});
