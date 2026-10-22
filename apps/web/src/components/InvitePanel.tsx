import { useEffect, useState } from "react";
import type { ContactsResponse, SessionInfo } from "@vcr/protocol";
import { api, ApiRequestError } from "../lib/api";
import { useLive } from "../lib/live";

const STATUS_LABEL = {
  ringing: "Ringing…",
  accepted: "Joined",
  declined: "Declined",
  missed: "Missed",
} as const;

/** Host-only: ring more contacts into this gathering, or copy a guest link for kids. */
export function InvitePanel(props: { sessionId: string; onClose(): void }) {
  const [contacts, setContacts] = useState<ContactsResponse | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const sessionsVersion = useLive((s) => s.sessionsVersion);

  useEffect(() => {
    void api.contacts().then(setContacts);
  }, []);
  // Refetch whenever a live event says invites changed.
  useEffect(() => {
    void api.session(props.sessionId).then(setSession);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- sessionsVersion triggers the refetch
  }, [props.sessionId, sessionsVersion]);

  const statusOf = new Map(session?.invites.map((i) => [i.userId, i.status]));

  async function ring() {
    try {
      setSession(await api.inviteMore(props.sessionId, [...selected]));
      setSelected(new Set());
      setMessage("Ringing them now.");
    } catch (err) {
      setMessage(err instanceof ApiRequestError ? err.message : "Couldn't ring them.");
    }
  }

  async function copyGuestLink() {
    try {
      const link = await api.createGuestLink(props.sessionId);
      const url = `${window.location.origin}${link.path}`;
      await navigator.clipboard.writeText(url);
      setMessage("Guest link copied. It works until this gathering ends.");
    } catch (err) {
      setMessage(err instanceof ApiRequestError ? err.message : "Couldn't create a guest link.");
    }
  }

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div
        className="card modal"
        role="dialog"
        aria-label="Invite people"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Invite people</h2>
        {!contacts ? (
          <p className="muted">Loading contacts…</p>
        ) : contacts.contacts.length === 0 ? (
          <p className="muted">No contacts yet. Add people by friend code on the home screen.</p>
        ) : (
          <ul className="checklist">
            {contacts.contacts.map((c) => {
              const status = statusOf.get(c.userId);
              const inviteable = status !== "accepted" && status !== "ringing";
              return (
                <li key={c.userId}>
                  <label>
                    <input
                      type="checkbox"
                      disabled={!inviteable}
                      checked={selected.has(c.userId)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(c.userId);
                        else next.delete(c.userId);
                        setSelected(next);
                      }}
                    />
                    <span className={`dot ${c.online ? "on" : ""}`} aria-hidden />
                    {c.label ?? c.displayName}
                    {status && <span className="muted"> · {STATUS_LABEL[status]}</span>}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <div className="row">
          <button onClick={ring} disabled={selected.size === 0}>
            Ring {selected.size || ""}
          </button>
          <button className="secondary" onClick={copyGuestLink}>
            Copy guest link
          </button>
        </div>
        <p className="hint">
          Guest links are for people without an account, like kids under 13 on a parent's device.
          Nothing about guests is stored.
        </p>
        {message && <p className="muted">{message}</p>}
        <div className="row end">
          <button className="link" onClick={props.onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
