// Service worker: shows incoming calls as notifications while the app is closed (Web Push).
// Payloads are PushPayload from @vcr/protocol: rings from contacts ("ring", "ring-cancelled") and
// calls through your call link ("call", "call-ended").

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
  } else if (data.type === "call") {
    event.waitUntil(
      self.registration.showNotification(`${data.from.displayName} is calling`, {
        body: "Through your call link. Open the app to answer.",
        tag: data.callId,
        renotify: true,
        requireInteraction: true,
        data: { url: "/" },
      }),
    );
  } else if (data.type === "missed-call") {
    event.waitUntil(
      self.registration.showNotification(`Missed call from ${data.from.displayName}`, {
        body: data.sessionId
          ? "They're still in the call. Tap to join."
          : "Tap to see your recent calls.",
        tag: `missed-${data.sessionId ?? data.from.displayName}`,
        data: { url: data.sessionId ? `/s/${data.sessionId}` : "/" },
      }),
    );
  } else if (data.type === "call-ended") {
    event.waitUntil(
      self.registration
        .getNotifications({ tag: data.callId })
        .then((list) => list.forEach((n) => n.close())),
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
