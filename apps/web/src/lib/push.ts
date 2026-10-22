import { api } from "./api";

/**
 * Web Push: lets calls ring as system notifications while the app is closed. The service worker
 * (public/sw.js) shows them; this file registers it and keeps the API's copy of this browser's
 * subscription current.
 */

export const pushSupported = () =>
  typeof Notification !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Subscribes this browser (if notifications are allowed) and tells the API. Safe to repeat. */
export async function syncPush(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== "granted") return false;
  const { publicKey } = await api.vapidKey();
  if (!publicKey) return false; // server has no VAPID keys configured
  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  // A subscription made with a different server key can't receive our pushes; replace it.
  const currentKey = subscription?.options.applicationServerKey;
  if (subscription && currentKey) {
    const a = new Uint8Array(currentKey);
    const b = keyBytes(publicKey);
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
      await subscription.unsubscribe();
      subscription = null;
    }
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(publicKey),
  });
  const json = subscription.toJSON();
  await api.savePushSubscription({
    endpoint: json.endpoint!,
    keys: { p256dh: json.keys!.p256dh!, auth: json.keys!.auth! },
  });
  return true;
}

/** Asks for notification permission (from a click), then subscribes. */
export async function enablePush(): Promise<NotificationPermission> {
  const permission = await Notification.requestPermission();
  if (permission === "granted") await syncPush().catch(() => false);
  return permission;
}
