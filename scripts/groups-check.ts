/**
 * Side conversations in real browsers, against running servers (`pnpm dev`): four people join a
 * call and start as one group; one goes off to a corner and becomes her own group, another
 * joins her from the Groups map (everyone still hears everyone, the others as background);
 * someone listens in on that group (and the group sees it), then joins it.
 *
 *   pnpm groups-check [--headful] [--shots <dir>]
 *
 * Needs Google Chrome (or CHROME_PATH).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, launch as launchChrome, type Page } from "puppeteer-core";
import { DevLoginResponse, GuestLinkResponse, RoomsResponse } from "@vcr/protocol";

const WEB = process.env.CALL_CHECK_URL ?? "http://localhost:5173";
const API = `${WEB}/api`;
const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const args = process.argv.slice(2);
const headful = args.includes("--headful");
const shotsDir = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : undefined;
const run = Date.now().toString(36).slice(-5);

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shot(page: Page, name: string) {
  if (!shotsDir) return;
  mkdirSync(shotsDir, { recursive: true });
  await page.screenshot({ path: join(shotsDir, `${name}.png`) as `${string}.png` });
}

async function launch(): Promise<Browser> {
  const browser = await launchChrome({
    executablePath: CHROME,
    headless: !headful,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-audio-output",
      "--no-first-run",
    ],
    defaultViewport: { width: 1100, height: 760 },
  });
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

async function click(page: Page, text: string, timeout = 10_000) {
  const handle = await page.waitForFunction(
    (t) => {
      const usable = [...document.querySelectorAll<HTMLElement>("button, a")].filter(
        (el) => el.offsetParent !== null && !(el as HTMLButtonElement).disabled,
      );
      const label = (el: HTMLElement) =>
        (el.getAttribute("aria-label") || el.innerText || "").trim();
      return usable.find((el) => label(el) === t) ?? usable.find((el) => label(el).includes(t));
    },
    { timeout },
    text,
  );
  await (handle.asElement() as unknown as { click(): Promise<void> }).click();
}

const hasText = (page: Page, text: string, timeout = 10_000) =>
  page
    .waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text)
    .then(() => true)
    .catch(() => false);

interface Seen {
  active: boolean;
  /** Group member names, yours first. */
  groups: string[][];
  /** Background-routed names. */
  background: string[];
  listeners: string[];
}

/** Groups and voice routing as one page sees them, via the dev hook. */
async function seen(page: Page): Promise<Seen> {
  return page.evaluate(() => {
    const vcr = (window as unknown as { vcrDebug: Record<string, never> }).vcrDebug as unknown as {
      realm: { participants: Array<{ id: string; name: string }> };
      audio: { routes: Map<string, string> };
      groups: { active: boolean; groups: Array<{ members: string[]; listeners: string[] }> };
    };
    const name = (id: string) => vcr.realm.participants.find((p) => p.id === id)?.name ?? id;
    return {
      active: vcr.groups.active,
      groups: vcr.groups.groups.map((g) => g.members.map(name)),
      background: [...vcr.audio.routes]
        .filter(([, bus]) => bus === "background")
        .map(([id]) => name(id)),
      listeners: vcr.groups.groups.flatMap((g) => g.listeners.map(name)),
    };
  });
}

async function until(page: Page, test: (s: Seen) => boolean, timeout = 15_000) {
  const end = Date.now() + timeout;
  let last = await seen(page);
  while (!test(last) && Date.now() < end) {
    await sleep(500);
    last = await seen(page);
  }
  return { ok: test(last), last };
}

const browsers: Browser[] = [];
try {
  const [one, two] = await Promise.all([launch(), launch()]);
  browsers.push(one, two);

  // The host starts a call in their room; three guests join by link.
  const auth = DevLoginResponse.parse(
    await (
      await fetch(`${API}/auth/dev-login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: `Ann ${run}`, birthDate: "1984-04-04" }),
      })
    ).json(),
  );
  const bearer = { authorization: `Bearer ${auth.token}` };
  const rooms = RoomsResponse.parse(
    await (await fetch(`${API}/rooms`, { headers: bearer })).json(),
  );
  const started = (await (
    await fetch(`${API}/sessions`, {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ roomId: rooms.rooms[0]!.id }),
    })
  ).json()) as { id: string };

  const ann = await one.newPage();
  await ann.goto(WEB);
  await ann.evaluate(
    (a, id) => {
      localStorage.setItem("vcr.auth", a);
      localStorage.setItem(`vcr.avatarPrompted.${id}`, "1");
      localStorage.setItem("vcr.callView", "grid");
    },
    JSON.stringify(auth),
    auth.user.id,
  );
  await ann.goto(`${WEB}/s/${started.id}`);
  await click(ann, "Join now");

  const pages: Record<string, Page> = { Ann: ann };
  for (const name of ["Ben", "Cat", "Dan"]) {
    const link = GuestLinkResponse.parse(
      await (
        await fetch(`${API}/sessions/${started.id}/guest-links`, {
          method: "POST",
          headers: bearer,
        })
      ).json(),
    );
    const context = await two.createBrowserContext();
    const page = await context.newPage();
    // Cat is on a phone.
    if (name === "Cat") {
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    }
    await page.goto(`${WEB}${link.path}`);
    await page.evaluate(() => localStorage.setItem("vcr.callView", "grid"));
    await page.waitForSelector("input");
    await page.type("input", `${name} ${run}`);
    await click(page, "Continue");
    await click(page, "Join now");
    pages[name] = page;
  }
  const full = (n: string) => `${n} ${run}`;

  const together = await until(
    ann,
    (s) => s.active && s.groups.length === 1 && s.groups[0]!.length === 4,
  );
  check("four people start as one group", together.ok, JSON.stringify(together.last.groups));
  check("nobody is in the background", together.last.background.length === 0);

  // Cat goes over to a corner of the room (as if she'd walked there).
  const cat = pages.Cat!;
  await cat.evaluate(() =>
    (window as unknown as { vcrDebug: { standAt(x: number, z: number): void } }).vcrDebug.standAt(
      -3.4,
      -2.4,
    ),
  );
  const alone = await until(ann, (s) => s.groups.length === 2);
  check(
    "Cat going off on her own becomes her own group",
    alone.ok,
    JSON.stringify(alone.last.groups),
  );
  check(
    "the others still hear Cat, as background",
    alone.last.background.join() === full("Cat"),
    JSON.stringify(alone.last.background),
  );

  // Dan, in the video grid, joins Cat from the Groups map.
  const dan = pages.Dan!;
  await dan.bringToFront();
  await click(dan, "People");
  await click(dan, "Groups");
  await click(dan, "Join");
  const pair = await until(
    ann,
    (s) =>
      s.groups.length === 2 &&
      s.groups.some((g) => g.length === 2 && g.includes(full("Cat")) && g.includes(full("Dan"))),
  );
  check("Dan joins Cat from the map", pair.ok, JSON.stringify(pair.last.groups));
  check(
    "Ann hears Cat and Dan as background, not silence",
    [...pair.last.background].sort().join() === [full("Cat"), full("Dan")].join(),
    JSON.stringify(pair.last.background),
  );

  // Ann listens in on their group.
  await ann.bringToFront();
  await click(ann, "People");
  await click(ann, "Groups");
  await click(ann, "Listen in");
  const listening = await until(ann, (s) => s.background.length === 0);
  check("listening in brings their voices up", listening.ok, JSON.stringify(listening.last));
  check("Cat sees Ann listening", await hasText(cat, `${full("Ann")} listening`));
  await shot(ann, "1-ann-listening");
  await cat.bringToFront();
  await click(cat, "More options");
  await click(cat, "Groups");
  await shot(cat, "2-cat-sees-listener");
  await ann.bringToFront();

  // Then joins them.
  await click(ann, "Join");
  const joined = await until(
    ann,
    (s) => s.groups[0]!.length === 3 && s.groups[0]!.includes(full("Cat")),
  );
  check(
    "joining from the map puts Ann in their group",
    joined.ok,
    JSON.stringify(joined.last.groups),
  );
  check(
    "Ann now hears Ben as background",
    joined.last.background.join() === full("Ben"),
    JSON.stringify(joined.last.background),
  );
  check("Ann stopped listening once she joined", joined.last.listeners.length === 0);
  await sleep(800);
  await shot(ann, "3-ann-joined");
} catch (err) {
  failures++;
  console.log(`✗ ${(err as Error).message}`);
} finally {
  await Promise.all(browsers.map((b) => b.close()));
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll group checks passed.");
process.exit(failures ? 1 : 0);
