import { Check, Copy, Share2, X } from "lucide-react";
import QRCode from "qrcode";
import { type ReactNode, useEffect, useState } from "react";
import type { BuiltInRoomId } from "@vcr/protocol";
import { colorFor } from "./emotes";

/** Small shared pieces of the portal and call screens. */

/** A line about a built-in room for room lists. */
export function builtInRoomBlurb(id: BuiltInRoomId | null): string {
  return id === "presentation"
    ? "Built-in · a projector screen, standing desks and seats for 26"
    : "Built-in · sofas, a desk and a puzzle table";
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

/** A person's initials on their color, like every call app's fallback avatar. */
export function Avatar(props: { name: string; id: string; size?: number; online?: boolean }) {
  const size = props.size ?? 40;
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.4, background: colorFor(props.id) }}
      aria-hidden
    >
      {initials(props.name)}
      {props.online !== undefined && <span className={`presence${props.online ? " on" : ""}`} />}
    </span>
  );
}

export function Dialog(props: {
  title: string;
  onClose(): void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);
  return (
    <div className="dialog-backdrop" onClick={props.onClose}>
      <div
        className={`dialog${props.wide ? " wide" : ""}`}
        role="dialog"
        aria-modal
        aria-label={props.title}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2>{props.title}</h2>
          <button className="icon-button" onClick={props.onClose} aria-label="Close">
            <X size={20} />
          </button>
        </header>
        {props.children}
      </div>
    </div>
  );
}

/** Copy to clipboard, falling back to selecting the text when the clipboard is blocked. */
export function CopyButton(props: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      className="secondary"
      onClick={() =>
        void navigator.clipboard
          .writeText(props.text)
          .then(() => setState("copied"))
          .catch(() => setState("failed"))
      }
    >
      {state === "copied" ? <Check size={18} /> : <Copy size={18} />}
      {state === "copied"
        ? "Copied"
        : state === "failed"
          ? "Select and copy"
          : (props.label ?? "Copy")}
    </button>
  );
}

export function QrCode({ text, size = 200 }: { text: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    QRCode.toDataURL(text, { width: size * 2, margin: 1 })
      .then((url) => active && setSrc(url))
      .catch(() => active && setSrc(null));
    return () => {
      active = false;
    };
  }, [text, size]);
  return src ? (
    <img className="qr" src={src} width={size} height={size} alt="QR code for the link" />
  ) : (
    <div className="qr" style={{ width: size, height: size }} />
  );
}

/** A link to hand to someone: the address, copy, the phone's share sheet, and a QR code. */
export function ShareLink(props: { url: string; hint?: ReactNode; shareTitle: string }) {
  const canShare = typeof navigator.share === "function";
  return (
    <div className="share-link">
      <QrCode text={props.url} />
      <div className="share-link-side">
        {props.hint && <p className="muted">{props.hint}</p>}
        <input
          className="link-field"
          readOnly
          value={props.url}
          onFocus={(e) => e.target.select()}
        />
        <div className="row">
          <CopyButton text={props.url} label="Copy link" />
          {canShare && (
            <button
              className="secondary"
              onClick={() =>
                void navigator.share({ title: props.shareTitle, url: props.url }).catch(() => {})
              }
            >
              <Share2 size={18} /> Share
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Formats elapsed seconds as m:ss or h:mm:ss. */
export function elapsed(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
