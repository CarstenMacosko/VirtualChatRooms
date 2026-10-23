# ADR 0017: Links bring in other devices and people; the grid is the default call view

- **Status:** Accepted
- **Date:** 2026-10-23
- **Plan reference:** [PLAN.md § 4.4](../../PLAN.md#44-calling--sessions), [§ 10](../../PLAN.md#10-product-decisions)

## Context

Testing on real phones showed two problems:

- **Other devices couldn't sign in.** The name-only development sign-in only answers on the host's own computer (ADR 0016), and Clerk keys aren't set yet. A phone had no account, so contacts and calling didn't work across devices.
- **The call didn't feel like a call.** It opened into the 3D room with a sidebar. People expect a call app to look like FaceTime, Meet or Zoom.

## Decision

**Three kinds of links, created by someone already signed in:**

- **Device link** ("Use on your phone", a QR code). It signs another device in as you. Single use, 10 minutes.
- **Invite link.** Whoever opens it becomes your contact. Without a sign-in provider it also makes their account (same 13+ gate); with Clerk it asks them to sign in first. Reusable for a week.
- **Call link.** Your personal "call me" address. Anyone types a name and taps Call, and every device you're signed in on rings (in-app, or Web Push when closed). If you answer, they join your call as a guest. Rate-limited, and resettable.

Sessions from device and invite links last 30 days, since there's no provider to renew them. A fresh server gets its first account from `POST /admin/sign-in-link`, guarded by `ADMIN_TOKEN`.

**The call opens to a video grid:**

- A 1:1 call fills the screen with the other person, with you as a corner picture.
- More people get a gallery.
- A shared screen or a pinned person takes the stage.
- The 3D room is one button away.

In the grid, voices are mixed flat and everyone is audible. Each person's avatar keeps standing at their spawn point, so anyone in the room view still sees them.

## Why

- Links are how families already share calls (FaceTime and Meet links). They need no passwords or app store, and they work today without Clerk.
- Every link is minted by an account holder, is unguessable, and is single-use or short-lived where it grants an account. That keeps the reason the dev sign-in is local-only: nobody can become someone else by typing a name.
- A familiar call screen lowers the bar for grandparents. The room stays the differentiator, one tap away.

## Alternatives considered

- **Clerk first, then everything:** blocks cross-device testing on getting keys and configuring domains.
- **Remote dev sign-in (`ALLOW_REMOTE_DEV_LOGIN`):** anyone with the link could sign in as anyone.
- **Room first with a nicer sidebar:** keeps the 3D cost, and the unfamiliar first impression, for people who just want to see faces.
