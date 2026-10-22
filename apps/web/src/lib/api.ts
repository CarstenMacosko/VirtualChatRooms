import { z } from "zod";
import {
  ApiError,
  type AvatarRecipe,
  AvatarResponse,
  ContactsResponse,
  DevLoginResponse,
  ExchangeResponse,
  GuestLinkInfo,
  GuestLinkResponse,
  HealthResponse,
  JoinSessionResponse,
  MeResponse,
  RoomsResponse,
  SessionInfo,
  SessionsResponse,
  VapidKeyResponse,
  type DevLoginRequest,
  type ExchangeRequest,
  type PushSubscriptionRequest,
  type SaveGroupRequest,
  type StartSessionRequest,
} from "@vcr/protocol";
import { refreshSession, useAuth } from "./auth";

/** Thin fetch wrapper for apps/api. Vite proxies /api to the API in development. */

export const API_BASE = "/api";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const NoContent = z.unknown();

async function request<T>(
  schema: z.ZodType<T>,
  path: string,
  init?: RequestInit,
  retried = false,
): Promise<T> {
  const token = useAuth.getState().auth?.token;
  const res = await fetch(API_BASE + path, {
    ...init,
    headers: {
      ...(init?.body !== undefined && { "content-type": "application/json" }),
      ...(token && { authorization: `Bearer ${token}` }),
      ...init?.headers,
    },
  });
  const body: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    // An expired session: renew it quietly if the sign-in provider still knows them; otherwise
    // sign out so they can sign in again.
    if (res.status === 401 && token) {
      if (!retried && (await refreshSession())) return request(schema, path, init, true);
      useAuth.getState().signOut();
    }
    const error = ApiError.safeParse(body);
    throw new ApiRequestError(
      res.status,
      error.success ? error.data.error : "http_error",
      error.success ? error.data.message : `Request failed (${res.status})`,
    );
  }
  return schema.parse(body);
}

const post = (body?: unknown): RequestInit => ({
  method: "POST",
  body: body === undefined ? undefined : JSON.stringify(body),
});
const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

export const api = {
  health: () => request(HealthResponse, "/health"),
  devLogin: (body: DevLoginRequest) => request(DevLoginResponse, "/auth/dev-login", post(body)),
  exchange: (body: ExchangeRequest) => request(ExchangeResponse, "/auth/exchange", post(body)),
  me: () => request(MeResponse, "/me"),
  myAvatar: () => request(AvatarResponse, "/me/avatar"),
  saveAvatar: (recipe: AvatarRecipe) =>
    request(AvatarResponse, "/me/avatar", json("PUT", { recipe })),

  contacts: () => request(ContactsResponse, "/contacts"),
  addContact: (friendCode: string) => request(ContactsResponse, "/contacts", post({ friendCode })),
  acceptContact: (userId: string) =>
    request(ContactsResponse, `/contacts/${userId}/accept`, post()),
  removeContact: (userId: string) =>
    request(ContactsResponse, `/contacts/${userId}`, { method: "DELETE" }),
  labelContact: (userId: string, label: string | null) =>
    request(ContactsResponse, `/contacts/${userId}`, json("PATCH", { label })),
  createGroup: (body: SaveGroupRequest) => request(ContactsResponse, "/contact-groups", post(body)),
  updateGroup: (id: string, body: SaveGroupRequest) =>
    request(ContactsResponse, `/contact-groups/${id}`, json("PUT", body)),
  deleteGroup: (id: string) =>
    request(ContactsResponse, `/contact-groups/${id}`, { method: "DELETE" }),

  rooms: () => request(RoomsResponse, "/rooms"),
  sessions: () => request(SessionsResponse, "/sessions"),
  session: (id: string) => request(SessionInfo, `/sessions/${id}`),
  startSession: (body: StartSessionRequest) => request(SessionInfo, "/sessions", post(body)),
  joinSession: (id: string) => request(JoinSessionResponse, `/sessions/${id}/join`, post()),
  declineSession: (id: string) => request(NoContent, `/sessions/${id}/decline`, post()),
  endSession: (id: string) => request(NoContent, `/sessions/${id}/end`, post()),
  inviteMore: (id: string, userIds: string[]) =>
    request(SessionInfo, `/sessions/${id}/invites`, post({ userIds })),
  createGuestLink: (id: string) =>
    request(GuestLinkResponse, `/sessions/${id}/guest-links`, post()),

  vapidKey: () => request(VapidKeyResponse, "/push/vapid-key"),
  savePushSubscription: (body: PushSubscriptionRequest) =>
    request(NoContent, "/push/subscriptions", post(body)),

  guestLink: (token: string) => request(GuestLinkInfo, `/guest/${token}`),
  guestJoin: (token: string, displayName: string, avatar?: AvatarRecipe | null) =>
    request(
      JoinSessionResponse,
      `/guest/${token}/join`,
      post({ displayName, ...(avatar && { avatar }) }),
    ),
};
