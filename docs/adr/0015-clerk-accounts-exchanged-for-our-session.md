# ADR 0015: Clerk accounts, exchanged for our own session token

- **Status:** Accepted
- **Date:** 2026-10-22
- **Plan reference:** [PLAN.md § 10](../../PLAN.md#10-product-decisions) (managed services), D-auth in the tech stack

## Decision

Real accounts use [Clerk](https://clerk.com) for email and Google sign-in. The web app shows Clerk's sign-in; the API's `POST /auth/exchange` verifies the Clerk session token (`@clerk/backend`, only from our web origin) and issues the app's own session token. Everything downstream (API routes, realm tickets, LiveKit tokens) keeps using that token. When it expires, the web app quietly exchanges a fresh Clerk token.

Clerk doesn't collect birthdays, so a new account's first exchange returns `needs-profile`; the app then asks for a display name and date of birth. Under-13 sign-ups are refused and their Clerk account is deleted through Clerk's API, so nothing about a child is kept. We store only `ageConfirmed13PlusAt`, never the date.

## Why

- **One credential downstream.** Only `/auth/exchange` knows about Clerk; swapping providers later touches one route and one web component.
- **Managed and quick.** Hosted sign-in screens, Google OAuth, email verification and bot protection, without running our own auth.
- **The age gate stays ours.** It sits in front of account creation in our database, not in provider configuration.

## Alternatives considered

- **Supabase Auth:** cheaper at scale and open source, but more UI to build ourselves.
- **Passing Clerk's token to the realm directly:** couples the realm to Clerk and to its short token lifetime.
