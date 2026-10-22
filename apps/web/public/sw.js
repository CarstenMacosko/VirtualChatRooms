// Service worker: shows incoming calls as notifications while the app is closed (Web Push).
// Payloads are PushPayload from @vcr/protocol: { type: "ring", ... } or { type: "ring-cancelled" }.

self.addEventListener("push", (event) => {
  let data;
  try {
    data = event.data?.json();
  } catch {
    return;
  }
  if (!data) return;

  if (data.type === "ring") {
    event.waitUntil(
      self.registration.showNotification(`${data.from.displayName} is calling`, {
        body: `Join them in ${data.roomName}`,
        tag: data.sessionId,
        renotify: true,
        requireInteraction: true,
        data: { url: `/s/${data.sessionId}` },
        actions: [{ action: "answer", title: "Answer" }],
      }),
    );
  } else if (data.type === "ring-cancelled") {
    // Answered on another device, declined, missed, or the gathering ended.
    event.waitUntil(
      self.registration
        .getNotifications({ tag: data.sessionId })
        .then((list) => list.forEach((n) => n.close())),
    );
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) return open.focus().then((w) => w.navigate(url));
      return self.clients.openWindow(url);
    }),
  );
});
