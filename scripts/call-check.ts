/**
 * End-to-end call check in real browsers, against running servers (`pnpm dev`):
 * two accounts become contacts through the UI, one calls the other, both join with Chrome's fake
 * camera and microphone, a third person joins by guest link, and each checks it actually
 * receives everyone's video frames and audio. Then mute, camera off and ending the call.
 *
 *   pnpm call-check [--headful] [--shots <dir>] [--remote <public url>]
 *
 * With --remote (e.g. the `pnpm share` link), the guest, the call-link caller and a phone signing
 * in with a device link all come in through that public address, like other devices would.
 *
 * Needs Google Chrome (or CHROME_PATH). Voice and video go through LIVEKIT_URL from `.env`.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, launch as launchChrome, type Page } from "puppeteer-core";
import {
  CreateScanResponse,
  DevLoginResponse,
  GuestLinkResponse,
  MeResponse,
  RoomsResponse,
} from "@vcr/protocol";
import { writePly } from "../apps/api/src/capture/splatFile";
import { syntheticRoomSplats } from "../apps/api/test/syntheticRoom";

const WEB = process.env.CALL_CHECK_URL ?? "http://localhost:5173";
const API = `${WEB}/api`;
const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const args = process.argv.slice(2);
const headful = args.includes("--headful");
const shotsDir = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : undefined;
/** Where other devices open links: a public address, or this one. */
const REMOTE = (args.includes("--remote") ? args[args.indexOf("--remote") + 1] : WEB)!.replace(
  /\/$/,
  "",
);
const run = Date.now().toString(36).slice(-5);

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function launch(): Promise<Browser> {
  const browser = await launchChrome({
    executablePath: CHROME,
    headless: !headful,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      // Play into a virtual output, so the check doesn't depend on this machine's speakers
      // (a sleeping Mac stops its audio clock, and with it every Web Audio graph).
      "--disable-audio-output",
      "--window-size=1280,800",
      "--no-first-run",
    ],
    defaultViewport: { width: 1280, height: 800 },
  });
  // tsx names functions with an `__name` helper; functions sent to the page need it too.
  browser.on("targetcreated", (target) => {
    void target
      .page()
      .then((page) =>
        page?.evaluateOnNewDocument(
          "globalThis.__name = (f) => f; try { localStorage.setItem('vcr.debugHooks', '1') } catch {}",
        ),
      );
  });
  return browser;
}

async function shot(page: Page, name: string) {
  if (!shotsDir) return;
  mkdirSync(shotsDir, { recursive: true });
  await page.screenshot({ path: join(shotsDir, `${name}.png`) as `${string}.png` });
}

/** Clicks the first visible button (or link) whose text includes `text`. */
async function click(page: Page, text: string, timeout = 10_000) {
  const handle = await page
    .waitForFunction(
      (t) => {
        const usable = [
          ...document.querySelectorAll<HTMLElement>("button, a, [role=button]"),
        ].filter((el) => el.offsetParent !== null && !(el as HTMLButtonElement).disabled);
        const label = (el: HTMLElement) =>
          (el.getAttribute("aria-label") || el.innerText || "").trim();
        // An exact label wins over one that merely contains the text ("Add" vs "Add a room").
        return usable.find((el) => label(el) === t) ?? usable.find((el) => label(el).includes(t));
      },
      { timeout },
      text,
    )
    .catch(async () => {
      const seen = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("button")]
          .map(
            (b) =>
              `${(b.innerText || b.getAttribute("aria-label") || "").trim()}${b.offsetParent ? "" : "(hidden)"}`,
          )
          .join(" | "),
      );
      throw new Error(`couldn't find "${text}" to click; buttons: ${seen}`);
    });
  await (handle.asElement() as unknown as { click(): Promise<void> }).click();
}

const hasText = (page: Page, text: string, timeout = 10_000) =>
  page
    .waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text)
    .then(() => true)
    .catch(() => false);

async function signedInPage(browser: Browser, displayName: string) {
  const res = await fetch(`${API}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName, birthDate: "1984-04-04" }),
  });
  const auth = DevLoginResponse.parse(await res.json());
  const page = await browser.newPage();
  page.on("dialog", (d) => void d.accept());
  page.on("pageerror", (err) => console.log(`  [${displayName}] page error: ${err.message}`));
  await page.goto(WEB);
  await page.evaluate(
    (a, id) => {
      localStorage.setItem("vcr.auth", a);
      localStorage.setItem(`vcr.avatarPrompted.${id}`, "1");
    },
    JSON.stringify(auth),
    auth.user.id,
  );
  await page.goto(WEB);
  return { page, auth };
}

/** What a page receives from someone: video frames and audio level, via the dev hook. */
async function receiving(page: Page, name: string) {
  return page.evaluate(async (who) => {
    const w = window as unknown as {
      vcrDebug?: {
        media: { videos: Map<string, { mediaStreamTrack: MediaStreamTrack }> };
        audio: { levelOf(id: string): number };
        realm: { participants: Array<{ id: string; name: string }> };
      };
    };
    const vcr = w.vcrDebug;
    if (!vcr) return { error: "no dev hook" };
    const p = vcr.realm.participants.find((x) => x.name === who);
    if (!p) return { error: `${who} not in the room` };
    // Video: frames arriving on their track.
    const track = vcr.media.videos.get(p.id)?.mediaStreamTrack;
    let frames = 0;
    let width = 0;
    if (track) {
      const video = document.createElement("video");
      video.muted = true;
      video.srcObject = new MediaStream([track]);
      await video.play().catch(() => {});
      const start = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
      await new Promise((r) => setTimeout(r, 1500));
      frames = (video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0) - start;
      width = video.videoWidth;
      video.srcObject = null;
    }
    // Audio: peak level over two seconds (the fake mic beeps once a second).
    let peak = 0;
    for (let i = 0; i < 40; i++) {
      peak = Math.max(peak, vcr.audio.levelOf(p.id));
      await new Promise((r) => setTimeout(r, 50));
    }
    return { frames, width, audio: peak };
  }, name);
}

async function expectMedia(page: Page, viewer: string, from: string) {
  let last: Awaited<ReturnType<typeof receiving>> = { error: "not checked" };
  for (let attempt = 0; attempt < 8; attempt++) {
    last = await receiving(page, from);
    if (!("error" in last) && last.frames > 5 && last.audio > 0.01) break;
    await sleep(1500);
  }
  const ok = !("error" in last) && last.frames > 5 && last.audio > 0.01;
  check(`${viewer} sees and hears ${from}`, ok, JSON.stringify(last));
}

/** Imports a synthetic room scan for `token` and waits until it's ready; returns its id. */
async function importScan(token: string, name: string) {
  const file = writePly(syntheticRoomSplats({ spacing: 0.06 }));
  const auth = { authorization: `Bearer ${token}` };
  const created = CreateScanResponse.parse(
    await (
      await fetch(`${API}/rooms/scans`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ name, fileName: "scan.ply", size: file.length }),
      })
    ).json(),
  );
  const parts = [];
  for (const part of created.upload.parts) {
    const start = (part.partNumber - 1) * created.upload.partSize;
    const url = part.url.startsWith("/") ? `${API}${part.url}` : part.url;
    const res = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(file.subarray(start, start + created.upload.partSize)),
    });
    parts.push({ partNumber: part.partNumber, etag: res.headers.get("etag") ?? "" });
  }
  await fetch(`${API}/rooms/${created.room.id}/upload/complete`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ parts }),
  });
  for (let i = 0; i < 100; i++) {
    const { rooms } = RoomsResponse.parse(
      await (await fetch(`${API}/rooms`, { headers: auth })).json(),
    );
    if (rooms.find((r) => r.id === created.room.id)?.status === "ready") return created.room.id;
    await sleep(200);
  }
  throw new Error("the scan never became ready");
}

const browsers: Browser[] = [];
try {
  const [one, two, three, four] = await Promise.all([launch(), launch(), launch(), launch()]);
  browsers.push(one, two, three, four);

  // --- Contacts through the UI ---
  const host = await signedInPage(one, `Host ${run}`);
  const friend = await signedInPage(two, `Friend ${run}`);
  const friendMe = MeResponse.parse(
    await (
      await fetch(`${API}/me`, { headers: { authorization: `Bearer ${friend.auth.token}` } })
    ).json(),
  );
  await click(host.page, "Add people");
  await host.page.waitForSelector('input[aria-label="Friend code"]');
  await host.page.type('input[aria-label="Friend code"]', friendMe.friendCode);
  await shot(host.page, "01-add-people");
  await click(host.page, "Add");
  check("host sends a contact request", await hasText(host.page, "Request sent"));
  await host.page.keyboard.press("Escape");
  check("friend sees the request live", await hasText(friend.page, "wants to add you"));
  await click(friend.page, "Accept");
  check(
    "the friendship shows on both sides",
    (await hasText(host.page, "Online")) && !(await hasText(host.page, "Waiting for them", 1000)),
  );
  await shot(host.page, "02-host-home");

  // --- Calling a contact ---
  await click(host.page, `Video call Friend ${run}`);
  check("friend's phone rings", await hasText(friend.page, "Video call ·"));
  await shot(friend.page, "03-friend-ringing");
  await click(host.page, "Join now");
  await sleep(1500);
  await shot(host.page, "04-host-calling");
  await click(friend.page, "Answer");
  await click(friend.page, "Join now");
  const sessionId = /\/s\/([^/?]+)/.exec(host.page.url())?.[1] ?? "";
  check("both are in the call", sessionId.length > 0, sessionId);
  await sleep(4000);
  await shot(host.page, "05-one-to-one");

  await expectMedia(host.page, "host", `Friend ${run}`);
  await expectMedia(friend.page, "friend", `Host ${run}`);

  // --- A guest by link, on a phone-sized screen ---
  const link = GuestLinkResponse.parse(
    await (
      await fetch(`${API}/sessions/${sessionId}/guest-links`, {
        method: "POST",
        headers: { authorization: `Bearer ${host.auth.token}` },
      })
    ).json(),
  );
  const guest = await three.newPage();
  guest.on("dialog", (d) => void d.accept());
  await guest.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await guest.goto(`${REMOTE}${link.path}`);
  await guest.waitForSelector("input");
  await guest.type("input", `Guest ${run}`);
  await click(guest, "Continue");
  await shot(guest, "06-guest-prejoin");
  await click(guest, "Join now");
  await sleep(4000);
  await shot(guest, "07-guest-phone-call");
  await expectMedia(guest, "guest", `Host ${run}`);
  await expectMedia(host.page, "host", `Guest ${run}`);
  await shot(host.page, "08-gallery");

  // --- Calling the host through their call link, from a fourth device ---
  const callLink = (await (
    await fetch(`${API}/me/call-link`, {
      headers: { authorization: `Bearer ${host.auth.token}` },
    })
  ).json()) as { path: string };
  const caller = await four.newPage();
  caller.on("dialog", (d) => void d.accept());
  await caller.goto(`${REMOTE}${callLink.path}`);
  await caller.waitForSelector("input");
  await caller.type("input", `Caller ${run}`);
  await click(caller, "Call");
  check("the call link rings the host", await hasText(host.page, "through your call link"));
  await shot(host.page, "09-host-incoming-call");
  await shot(caller, "10-caller-ringing");
  await click(host.page, "Answer");
  await sleep(6000);
  await expectMedia(caller, "caller", `Host ${run}`);
  await expectMedia(host.page, "host", `Caller ${run}`);

  // --- The friend's phone signs in with a one-time link from their computer ---
  const deviceLink = (await (
    await fetch(`${API}/me/device-links`, {
      method: "POST",
      headers: { authorization: `Bearer ${friend.auth.token}` },
    })
  ).json()) as { path: string };
  const phoneContext = await four.createBrowserContext();
  const phone = await phoneContext.newPage();
  await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await phone.goto(`${REMOTE}${deviceLink.path}`);
  await click(phone, `Continue as Friend ${run}`);
  check("a phone signs in with a device link", await hasText(phone, `Hi Friend`));
  check("the phone has the same contacts", await hasText(phone, `Host ${run}`));
  check("the phone sees the live call", await hasText(phone, "Happening now"));
  await shot(phone, "12-phone-signed-in");
  await phoneContext.close();

  // --- Chat ---
  // On a phone, chat is in the More menu.
  await click(guest, "More options");
  await click(guest, "Chat");
  await guest.waitForSelector('input[aria-label="Message"]');
  console.log(
    "  guest chat before sending:",
    JSON.stringify(await guest.$eval(".messages", (el) => (el as HTMLElement).innerText)),
  );
  await guest.type('input[aria-label="Message"]', "Hi from my phone!");
  await guest.keyboard.press("Enter");
  await click(host.page, "Chat");
  check("chat reaches others", await hasText(host.page, "Hi from my phone!"));
  await shot(host.page, "11-chat");

  // --- Background blur keeps video flowing ---
  await click(host.page, "More options");
  await click(host.page, "Blur my background");
  await sleep(5000);
  const blurred = await host.page.evaluate(
    () => (window as unknown as { vcrDebug: { media: { blur: boolean } } }).vcrDebug.media.blur,
  );
  check("background blur turns on", blurred);
  await expectMedia(friend.page, "friend (host blurred)", `Host ${run}`);
  await shot(friend.page, "11b-host-blurred");

  // --- The 3D room view, and back to the grid ---
  await click(host.page, "Show the 3D room");
  check("the room view loads", await hasText(host.page, "WASD to move", 20_000));
  await sleep(4000);
  await shot(host.page, "12-room-view");
  await expectMedia(host.page, "host (room view)", `Friend ${run}`);

  // --- The host moves everyone to a scanned room ---
  const scanId = await importScan(host.auth.token, `Den ${run}`);
  await click(host.page, "More options");
  await click(host.page, "Change room…");
  await click(host.page, "Move here");
  check(
    "everyone hears about the move",
    await hasText(friend.page, `The call moved to Den ${run}`),
  );
  const friendRoom = await friend.page.evaluate(
    () =>
      (window as unknown as { vcrDebug: { realm: { joinInfo: { room: { id: string } } | null } } })
        .vcrDebug.realm.joinInfo?.room.id,
  );
  check("the friend's call is in the new room", friendRoom === scanId, String(friendRoom));
  check("the host's room view loads the scan", await hasText(host.page, "WASD to move", 20_000));
  await sleep(4000);
  await shot(host.page, "12b-moved-to-scan");
  await expectMedia(friend.page, "friend (after the move)", `Host ${run}`);
  await click(host.page, "Show video grid");

  // --- Mute shows up for others ---
  await click(host.page, "Turn off microphone");
  await sleep(1500);
  const heard = await receiving(friend.page, `Host ${run}`);
  check(
    "muting stops the host's audio for others",
    !("error" in heard) && heard.audio < 0.01,
    JSON.stringify(heard),
  );

  // --- Ending ---
  await click(host.page, "Leave call");
  await click(host.page, "End the call for everyone");
  check("ending the call reaches the guest", await hasText(guest, "ended", 15_000));
  await shot(guest, "13-guest-ended");
  check(
    "the host's Recents show the call and the call-link caller",
    (await hasText(host.page, "Recents")) && (await hasText(host.page, `Caller ${run}`)),
  );
  await shot(host.page, "14-host-recents");
} catch (err) {
  check("call check ran to the end", false, String(err));
} finally {
  await Promise.all(browsers.map((b) => b.close().catch(() => {})));
}

console.log(failures === 0 ? "\nAll call checks passed." : `\n${failures} call check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
