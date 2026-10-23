import { Phone } from "lucide-react";
import { useEffect, useState } from "react";
import type { ContactsResponse, GuestLinkResponse, SessionInfo } from "@vcr/protocol";
import { api, ApiRequestError } from "../lib/api";
import { useLive } from "../lib/live";
import { publicOrigin, useShareUrl } from "../lib/share";
import { Avatar, Dialog, ShareLink } from "./ui";

const STATUS_LABEL = {
  ringing: "Ringing…",
  accepted: "In the call",
  declined: "Declined",
  missed: "Missed",
} as const;

/** Host-only: ring more contacts into this call, or share a guest link (with a QR code). */
export function InvitePanel(props: { sessionId: string; onClose(): void }) {
  const [contacts, setContacts] = useState<ContactsResponse | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [link, setLink] = useState<GuestLinkResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const sessionsVersion = useLive((s) => s.sessionsVersion);
  const shareUrl = useShareUrl();

  useEffect(() => {
    void api.contacts().then(setContacts, () => {});
    api
      .createGuestLink(props.sessionId)
      .then(setLink, (err: unknown) =>
        setMessage(err instanceof ApiRequestError ? err.message : "Couldn't make a guest link."),
      );
  }, [props.sessionId]);
  // Refetch whenever a live event says invites changed.
  useEffect(() => {
    void api.session(props.sessionId).then(setSession, () => {});
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- sessionsVersion triggers the refetch
  }, [props.sessionId, sessionsVersion]);

  const statusOf = new Map(session?.invites.map((i) => [i.userId, i.status]));

  async function ring(userId: string) {
    try {
      setSession(await api.inviteMore(props.sessionId, [userId]));
    } catch (err) {
      setMessage(err instanceof ApiRequestError ? err.message : "Couldn't ring them.");
    }
  }

  return (
    <Dialog title="Add people" onClose={props.onClose} wide>
      <h3>Ring a contact</h3>
      {!contacts ? (
        <p className="muted">Loading contacts…</p>
      ) : contacts.contacts.length === 0 ? (
        <p className="muted">No contacts yet. Share the guest link below instead.</p>
      ) : (
        <ul className="rows">
          {contacts.contacts.map((c) => {
            const status = statusOf.get(c.userId);
            const busy = status === "accepted" || status === "ringing";
            return (
              <li key={c.userId}>
                <Avatar name={c.displayName} id={c.userId} size={36} online={c.online} />
                <span className="grow">
                  <b>{c.label ?? c.displayName}</b>
                  <span className="muted">
                    {status ? STATUS_LABEL[status] : c.online ? "Online" : "Offline"}
                  </span>
                </span>
                <button className="call-button" disabled={busy} onClick={() => void ring(c.userId)}>
                  <Phone size={16} />{" "}
                  {status === "declined" || status === "missed" ? "Ring again" : "Ring"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <h3>Or share a guest link</h3>
      {link && (
        <ShareLink
          url={`${publicOrigin(shareUrl)}${link.path}`}
          shareTitle="Join my call"
          hint="Anyone with it can join this call without an account (kids too), until it ends. Nothing about guests is stored."
        />
      )}
      {message && <p className="error">{message}</p>}
    </Dialog>
  );
}
