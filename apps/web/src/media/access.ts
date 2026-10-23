/**
 * Camera and microphone access: asking for each one separately (so a blocked camera doesn't take
 * the microphone down with it), telling apart why one failed, and plain steps to fix it on the
 * phone or browser in hand.
 */

export type Device = "mic" | "camera";

export type Access =
  /** Not asked yet, or the browser won't say (Safari before 16, some Firefox versions). */
  | "unknown"
  /** The browser will ask when we do. */
  | "prompt"
  | "granted"
  /** We asked and the prompt was closed without an answer; asking again shows it again. */
  | "dismissed"
  /** The site is blocked in the browser. */
  | "blocked"
  /** The browser itself isn't allowed to use it (macOS / Windows privacy settings). */
  | "system"
  /** No camera or microphone found. */
  | "missing"
  /** Another app or tab is using it. */
  | "busy";

export const DEVICE_NAME: Record<Device, string> = { mic: "microphone", camera: "camera" };

const PERMISSION_NAME: Record<Device, string> = { mic: "microphone", camera: "camera" };

/** What the browser says about the site's permission, without asking. */
export async function permissionState(device: Device): Promise<Access> {
  try {
    const status = await navigator.permissions.query({
      name: PERMISSION_NAME[device] as PermissionName,
    });
    return fromPermission(status.state);
  } catch {
    return "unknown";
  }
}

/** Calls back when the permission changes (someone flips it in the address bar). */
export function watchPermission(device: Device, onChange: (access: Access) => void): () => void {
  let status: PermissionStatus | null = null;
  let stopped = false;
  const listener = () => status && onChange(fromPermission(status.state));
  navigator.permissions
    ?.query({ name: PERMISSION_NAME[device] as PermissionName })
    .then((s) => {
      if (stopped) return;
      status = s;
      s.addEventListener("change", listener);
    })
    .catch(() => {});
  return () => {
    stopped = true;
    status?.removeEventListener("change", listener);
  };
}

function fromPermission(state: PermissionState): Access {
  return state === "granted" ? "granted" : state === "denied" ? "blocked" : "prompt";
}

/** Why getUserMedia (or LiveKit, which calls it) failed. */
export function accessFromError(err: unknown): Access {
  const name = err instanceof Error || err instanceof DOMException ? err.name : "";
  const message = err instanceof Error || err instanceof DOMException ? err.message : String(err);
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    // Chrome: "Permission denied by system" when macOS/Windows privacy settings block the browser,
    // "Permission dismissed" when the prompt was closed.
    return /system/i.test(message) ? "system" : /dismiss/i.test(message) ? "dismissed" : "blocked";
  }
  if (
    name === "NotFoundError" ||
    name === "DevicesNotFoundError" ||
    name === "OverconstrainedError"
  ) {
    return "missing";
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return "busy";
  }
  // LiveKit's own wrappers carry the reason in the message.
  if (/permission|not allowed|denied/i.test(message)) return "blocked";
  if (/not found|no device|requested device/i.test(message)) return "missing";
  if (/in use|could not start|not readable/i.test(message)) return "busy";
  return "busy";
}

export interface Opened {
  stream: MediaStream | null;
  mic: Access;
  camera: Access;
}

/**
 * Opens the wanted devices: both at once first (one browser prompt), then, if that fails, each
 * on its own, so one blocked device still leaves the other working and we know which is which.
 */
export async function openDevices(want: {
  mic: MediaTrackConstraints | boolean;
  camera: MediaTrackConstraints | boolean;
}): Promise<Opened> {
  const result: Opened = { stream: null, mic: "unknown", camera: "unknown" };
  if (!want.mic && !want.camera) return result;
  try {
    result.stream = await navigator.mediaDevices.getUserMedia({
      audio: want.mic,
      video: want.camera,
    });
    if (want.mic) result.mic = "granted";
    if (want.camera) result.camera = "granted";
    return result;
  } catch (err) {
    if (!want.mic || !want.camera) {
      const device = want.mic ? "mic" : "camera";
      result[device] = await refine(device, accessFromError(err));
      return result;
    }
  }
  // Both were wanted and something failed: find out which, without prompting twice for a device
  // that was only dismissed (the browser would show the prompt again for each).
  const tracks: MediaStreamTrack[] = [];
  for (const device of ["mic", "camera"] as const) {
    const known = await permissionState(device);
    if (known === "blocked" || known === "prompt") {
      result[device] = known === "prompt" ? "dismissed" : known;
      continue;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia(
        device === "mic" ? { audio: want.mic } : { video: want.camera },
      );
      tracks.push(...s.getTracks());
      result[device] = "granted";
    } catch (err) {
      result[device] = accessFromError(err);
    }
  }
  if (tracks.length) result.stream = new MediaStream(tracks);
  return result;
}

/** A refusal while the browser would still ask means the prompt was closed, not blocked. */
async function refine(device: Device, access: Access): Promise<Access> {
  if (access !== "blocked") return access;
  return (await permissionState(device)) === "prompt" ? "dismissed" : access;
}

// --- Which phone or browser this is, for the fix-it steps ---

export interface Platform {
  os: "ios" | "android" | "mac" | "windows" | "other";
  browser: "safari" | "chrome" | "edge" | "firefox" | "samsung" | "other";
  /** Set when the page is open inside another app (Instagram, Facebook, Messenger...). */
  inApp: string | null;
}

const IN_APP: [RegExp, string][] = [
  [/Instagram/i, "Instagram"],
  [/Messenger|Orca-Android|MessengerForiOS/i, "Messenger"],
  [/FBAN|FBAV|FB_IAB|FBIOS/i, "Facebook"],
  [/Snapchat/i, "Snapchat"],
  [/TikTok|musical_ly|BytedanceWebview/i, "TikTok"],
  [/LinkedInApp/i, "LinkedIn"],
  [/MicroMessenger/i, "WeChat"],
  [/\bLine\//i, "LINE"],
  [/Twitter/i, "X"],
  [/GSA\//i, "the Google app"],
];

export function detectPlatform(ua = navigator.userAgent): Platform {
  const ios =
    /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  const os: Platform["os"] = ios
    ? "ios"
    : /Android/i.test(ua)
      ? "android"
      : /Macintosh|Mac OS X/i.test(ua)
        ? "mac"
        : /Windows/i.test(ua)
          ? "windows"
          : "other";
  const browser: Platform["browser"] = /SamsungBrowser/i.test(ua)
    ? "samsung"
    : /Edg(e|A|iOS)?\//i.test(ua)
      ? "edge"
      : /Firefox|FxiOS/i.test(ua)
        ? "firefox"
        : /Chrome|CriOS|Chromium/i.test(ua)
          ? "chrome"
          : /Safari/i.test(ua)
            ? "safari"
            : "other";
  let inApp = IN_APP.find(([re]) => re.test(ua))?.[1] ?? null;
  // Android apps that show pages in a bare WebView.
  if (!inApp && os === "android" && /; wv\)/.test(ua)) inApp = "this app";
  return { os, browser, inApp };
}

const BROWSER_NAME: Record<Platform["browser"], string> = {
  safari: "Safari",
  chrome: "Chrome",
  edge: "Edge",
  firefox: "Firefox",
  samsung: "Samsung Internet",
  other: "your browser",
};

/** The browser to suggest when the page is stuck inside another app. */
export function defaultBrowser(p: Platform) {
  return p.os === "ios" ? "Safari" : "Chrome";
}

/**
 * Plain, short steps to fix `access` for `device`, for this phone or browser. The last step is
 * always to come back and try again (the help screen has the button).
 */
export function fixSteps(device: Device, access: Access, p: Platform): string[] {
  const name = DEVICE_NAME[device];
  const Name = name[0]!.toUpperCase() + name.slice(1);
  const site = window.location.host;
  const browser = BROWSER_NAME[p.browser];

  if (p.inApp) {
    return [
      `This page is open inside ${p.inApp}, which doesn't share your ${name} with websites.`,
      p.os === "ios"
        ? `Tap ••• or the share button, then "Open in ${defaultBrowser(p)}" (or copy the link below and paste it into ${defaultBrowser(p)}).`
        : `Tap ⋮ at the top, then "Open in browser" or "Open in Chrome" (or copy the link below).`,
    ];
  }

  if (access === "dismissed") {
    return [`Tap "Try again" below.`, `When ${browser} asks to use your ${name}, tap "Allow".`];
  }

  if (access === "missing") {
    return device === "mic"
      ? [
          "No microphone was found.",
          "Plug in a headset or check that your microphone is turned on and connected.",
        ]
      : [
          "No camera was found.",
          "Plug in a camera or check that it's turned on. You can still join with just your voice.",
        ];
  }

  if (access === "busy") {
    return [
      `Another app or tab is using your ${name}.`,
      p.os === "ios" || p.os === "android"
        ? `Close FaceTime, WhatsApp, Zoom or other call apps, and other tabs with calls.`
        : `Close Zoom, Teams, FaceTime, Photo Booth or other tabs with calls.`,
      p.os === "windows" || p.os === "mac"
        ? `Still stuck? Unplug and replug the ${name}, or restart ${browser}.`
        : `Still stuck? Close ${browser} completely and open the link again.`,
    ];
  }

  if (access === "system") {
    return p.os === "windows"
      ? [
          `Windows is keeping ${browser} from using your ${name}.`,
          `Open Start → Settings → Privacy & security → ${Name}.`,
          `Turn on "${Name} access" and "Let desktop apps access your ${name}".`,
        ]
      : [
          `Your Mac is keeping ${browser} from using your ${name}.`,
          `Open the Apple menu → System Settings → Privacy & Security → ${Name}.`,
          `Turn on ${browser}, then quit ${browser} and open this link again.`,
        ];
  }

  // Blocked for this site (or dismissed / not asked yet).
  switch (p.os) {
    case "ios":
      if (p.browser === "safari") {
        return [
          `Tap the "aA" button on the left of the address bar.`,
          `Tap "Website Settings", then set ${Name} to "Allow".`,
          `Not there? Open the Settings app → Safari (under Apps on newer iPhones) → ${Name} → "Allow".`,
        ];
      }
      return [
        `Open the iPhone's Settings app.`,
        `Scroll down to ${browser} (under Apps on newer iPhones) and turn on ${Name}.`,
        `Come back here and reload the page.`,
      ];
    case "android":
      if (p.browser === "samsung") {
        return [
          `Tap the icon on the left of the address bar, then "Permissions" and allow ${Name}.`,
          `Not there? Open Settings → Apps → Samsung Internet → Permissions → ${Name} → Allow.`,
        ];
      }
      return [
        `Tap the icon on the left of the address bar (next to ${site}).`,
        `Tap "Permissions" and turn on ${Name}.`,
        `Not there? Open Settings → Apps → ${browser} → Permissions → ${Name} → Allow.`,
      ];
    default:
      if (p.browser === "safari") {
        return [`In the menu bar, click Safari → Settings for ${site}.`, `Set ${Name} to "Allow".`];
      }
      if (p.browser === "firefox") {
        return [
          `Click the crossed-out ${name} icon in the address bar.`,
          `Click the × next to "Blocked" so Firefox asks again.`,
        ];
      }
      return [
        `Click the icon on the left of the address bar (next to ${site}).`,
        `Turn on ${Name} (or choose "Allow").`,
      ];
  }
}
