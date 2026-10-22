import { eq } from "drizzle-orm";
import webpush from "web-push";
import type { PushPayload } from "@vcr/protocol";
import type { Database } from "./db/client";
import { pushSubscriptions } from "./db/schema";
import type { Env } from "./env";

/** Sends one push message; matches `webpush.sendNotification`, and tests swap in a fake. */
export type PushSender = (
  subscription: webpush.PushSubscription,
  payload: string,
  options: webpush.RequestOptions,
) => Promise<unknown>;

/**
 * Web Push for people who aren't connected to `GET /events` (the app is closed): incoming calls
 * show as system notifications, and are withdrawn when the call is answered elsewhere or ends.
 */
export class PushNotifier {
  readonly enabled: boolean;

  constructor(
    private db: Database,
    private env: Env,
    private send: PushSender = webpush.sendNotification,
  ) {
    this.enabled = Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
  }

  async notify(userId: string, payload: PushPayload) {
    if (!this.enabled) return;
    const subscriptions = await this.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
    await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          await this.send(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify(payload),
            {
              vapidDetails: {
                subject: this.env.VAPID_SUBJECT,
                publicKey: this.env.VAPID_PUBLIC_KEY,
                privateKey: this.env.VAPID_PRIVATE_KEY,
              },
              // A ring is useless once it's over; don't deliver it late.
              TTL: payload.type === "ring" ? 45 : 60,
              urgency: "high",
            },
          );
        } catch (err) {
          // 404/410: the browser unsubscribed or the subscription expired.
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            await this.db
              .delete(pushSubscriptions)
              .where(eq(pushSubscriptions.endpoint, sub.endpoint));
          }
        }
      }),
    );
  }
}
