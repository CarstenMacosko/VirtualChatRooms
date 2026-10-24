import { Mic, Video } from "lucide-react";
import { useState } from "react";
import {
  type Access,
  type Device,
  DEVICE_NAME,
  defaultBrowser,
  detectPlatform,
  fixSteps,
} from "../media/access";
import { Dialog } from "./ui";

const platform = detectPlatform();

/** Short status for a device that isn't working, or null when there's nothing to fix. */
export function troubleText(device: Device, access: Access): string | null {
  const name = DEVICE_NAME[device];
  if (platform.inApp && (access === "blocked" || access === "dismissed" || access === "system")) {
    return `Open this page in ${defaultBrowser(platform)} to use your ${name}`;
  }
  switch (access) {
    case "dismissed":
      return `Your ${name} isn't allowed yet`;
    case "blocked":
      return `Your ${name} is blocked`;
    case "system":
      return `Your computer is blocking the ${name}`;
    case "missing":
      return `No ${name} found`;
    case "busy":
      return `Your ${name} is being used by another app`;
    default:
      return null;
  }
}

/** One row per device that needs fixing, each opening its help. */
export function DeviceTrouble(props: {
  trouble: Partial<Record<Device, Access>>;
  onFix(device: Device): void;
}) {
  const rows = (["mic", "camera"] as const).flatMap((device) => {
    const access = props.trouble[device];
    const text = access && troubleText(device, access);
    return text ? [{ device, text }] : [];
  });
  if (!rows.length) return null;
  return (
    <div className="device-trouble">
      {rows.map(({ device, text }) => (
        <button key={device} className="trouble-row" onClick={() => props.onFix(device)}>
          {device === "mic" ? <Mic size={20} /> : <Video size={20} />}
          <span>{text}</span>
          <span className="trouble-fix">Fix it</span>
        </button>
      ))}
    </div>
  );
}

/** Step-by-step help for one device, with Try again. */
export function AccessHelp(props: {
  device: Device;
  access: Access;
  onRetry(): void;
  onClose(): void;
  /** Shown as "Continue without your camera" when given. */
  onSkip?: (() => void) | undefined;
}) {
  const name = DEVICE_NAME[props.device];
  const steps = fixSteps(props.device, props.access, platform);
  const [copied, setCopied] = useState(false);
  const title = platform.inApp
    ? `Open in ${defaultBrowser(platform)}`
    : props.access === "missing"
      ? `No ${name} found`
      : `Turn on your ${name}`;
  // Changing a setting in the phone's Settings app (or the computer's) usually needs a reload.
  const reloadFirst =
    props.access === "system" || (platform.os === "ios" && platform.browser !== "safari");

  return (
    <Dialog title={title} onClose={props.onClose}>
      <div className="access-help">
        <div className="access-icon" aria-hidden>
          {props.device === "mic" ? <Mic size={34} /> : <Video size={34} />}
        </div>
        <ol>
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {platform.inApp ? (
          <button
            className="primary big"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(window.location.href)
                .then(() => setCopied(true))
                .catch(() => {});
            }}
          >
            {copied ? "Link copied" : "Copy link"}
          </button>
        ) : reloadFirst ? (
          <button className="primary big" onClick={() => window.location.reload()}>
            Reload page
          </button>
        ) : (
          <button className="primary big" onClick={props.onRetry}>
            Try again
          </button>
        )}
        {props.onSkip && (
          <button className="ghost" onClick={props.onSkip}>
            Continue without your {name}
          </button>
        )}
      </div>
    </Dialog>
  );
}
