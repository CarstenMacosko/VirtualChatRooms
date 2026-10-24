import { z } from "zod";
import {
  AnswerCallResponse,
  ApiError,
  CallState,
  type AvatarRecipe,
  AvatarResponse,
  ContactsResponse,
  CreateScanResponse,
  DevLoginResponse,
  ExchangeResponse,
  GuestLinkInfo,
  GuestLinkResponse,
  HealthResponse,
  JoinSessionResponse,
  LinkInfo,
  LinkResponse,
  MeResponse,
  RecentCallsResponse,
  RoomInfo,
  RoomSetup,
  RoomsResponse,
  SceneAssets,
  SessionInfo,
  SessionsResponse,
  ShareInfo,
  StartCallResponse,
  VapidKeyResponse,
  type DevLoginRequest,
  type RoomSetupInput,
  type ExchangeRequest,
  type PushSubscriptionRequest,
  type AcceptInviteRequest,
  type CompleteUploadRequest,
  type CreateScanRequest,
  type SaveGroupRequest,
  type StartSessionRequest,
  type UpdateRoomRequest,
  type UploadPlan,
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
  createScan: (body: CreateScanRequest) => request(CreateScanResponse, "/rooms/scans", post(body)),
  completeUpload: (id: string, body: CompleteUploadRequest) =>
    request(RoomInfo, `/rooms/${id}/upload/complete`, post(body)),
  updateRoom: (id: string, body: UpdateRoomRequest) =>
    request(RoomInfo, `/rooms/${id}`, json("PATCH", body)),
  deleteRoom: (id: string) => request(NoContent, `/rooms/${id}`, { method: "DELETE" }),
  /** A scanned room's manifest and files, for its owner to set it up. */
  roomScene: (id: string) => request(SceneAssets, `/rooms/${id}/scene`),
  saveRoomSetup: (id: string, setup: RoomSetupInput) =>
    request(RoomSetup, `/rooms/${id}/setup`, json("PUT", setup)),
  sessions: () => request(SessionsResponse, "/sessions"),
  recentCalls: () => request(RecentCallsResponse, "/me/recent-calls"),
  session: (id: string) => request(SessionInfo, `/sessions/${id}`),
  startSession: (body: StartSessionRequest) => request(SessionInfo, "/sessions", post(body)),
  joinSession: (id: string) => request(JoinSessionResponse, `/sessions/${id}/join`, post()),
  declineSession: (id: string) => request(NoContent, `/sessions/${id}/decline`, post()),
  endSession: (id: string) => request(NoContent, `/sessions/${id}/end`, post()),
  changeRoom: (id: string, roomId: string) =>
    request(SessionInfo, `/sessions/${id}/room`, post({ roomId })),
  inviteMore: (id: string, userIds: string[]) =>
    request(SessionInfo, `/sessions/${id}/invites`, post({ userIds })),
  createGuestLink: (id: string) =>
    request(GuestLinkResponse, `/sessions/${id}/guest-links`, post()),

  share: () => request(ShareInfo, "/dev/share"),
  vapidKey: () => request(VapidKeyResponse, "/push/vapid-key"),
  savePushSubscription: (body: PushSubscriptionRequest) =>
    request(NoContent, "/push/subscriptions", post(body)),

  deviceLink: () => request(LinkResponse, "/me/device-links", post()),
  inviteLink: () => request(LinkResponse, "/me/invite-links", post()),
  callLink: () => request(LinkResponse, "/me/call-link"),
  resetCallLink: () => request(LinkResponse, "/me/call-link/reset", post()),
  linkInfo: (token: string) => request(LinkInfo, `/links/${token}`),
  claimDeviceLink: (token: string) => request(DevLoginResponse, `/links/${token}/claim`, post()),
  acceptInvite: (token: string, body: AcceptInviteRequest) =>
    request(z.union([DevLoginResponse, z.null()]), `/links/${token}/accept`, post(body)),
  startCall: (token: string, displayName: string) =>
    request(StartCallResponse, `/links/${token}/call`, post({ displayName })),
  callState: (id: string, secret: string) =>
    request(CallState, `/calls/${id}?secret=${encodeURIComponent(secret)}`),
  hangUpCall: (id: string, secret: string) =>
    request(NoContent, `/calls/${id}?secret=${encodeURIComponent(secret)}`, { method: "DELETE" }),
  answerCall: (id: string) => request(AnswerCallResponse, `/calls/${id}/answer`, post()),
  declineCall: (id: string) => request(NoContent, `/calls/${id}/decline`, post()),

  guestLink: (token: string) => request(GuestLinkInfo, `/guest/${token}`),
  guestJoin: (token: string, displayName: string, avatar?: AvatarRecipe | null) =>
    request(
      JoinSessionResponse,
      `/guest/${token}/join`,
      post({ displayName, ...(avatar && { avatar }) }),
    ),
};

/**
 * Signed asset and upload URLs are either absolute (S3/R2) or paths on the API (local storage).
 */
export const assetUrl = (url: string) => (url.startsWith("/") ? API_BASE + url : url);

const PART_ATTEMPTS = 4;

/** PUTs one part, reporting bytes sent; resolves with the part's ETag. */
function putPart(url: string, body: Blob, onBytes: (sent: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", assetUrl(url));
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => onBytes(e.loaded);
    xhr.onload = () => {
      const etag = xhr.getResponseHeader("etag");
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
      else reject(new ApiRequestError(xhr.status, "upload_failed", "Uploading failed."));
    };
    xhr.onerror = () => reject(new ApiRequestError(0, "network", "The connection dropped."));
    xhr.send(body);
  });
}

/**
 * Uploads a file in the parts the API planned, a few at a time, retrying parts that fail.
 * `onProgress` gets 0–1.
 */
export async function uploadParts(
  file: Blob,
  plan: UploadPlan,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<CompleteUploadRequest["parts"]> {
  const sent = new Map<number, number>();
  const report = () => {
    let total = 0;
    for (const v of sent.values()) total += v;
    onProgress(Math.min(1, total / file.size));
  };
  const queue = [...plan.parts];
  const done: CompleteUploadRequest["parts"] = [];
  const worker = async () => {
    for (let part = queue.shift(); part; part = queue.shift()) {
      const start = (part.partNumber - 1) * plan.partSize;
      const body = file.slice(start, start + plan.partSize);
      for (let attempt = 1; ; attempt++) {
        if (signal?.aborted) throw new ApiRequestError(0, "aborted", "Upload cancelled.");
        try {
          const etag = await putPart(part.url, body, (n) => {
            sent.set(part.partNumber, n);
            report();
          });
          sent.set(part.partNumber, body.size);
          report();
          done.push({ partNumber: part.partNumber, etag });
          break;
        } catch (err) {
          sent.set(part.partNumber, 0);
          if (attempt >= PART_ATTEMPTS) throw err;
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return done.sort((a, b) => a.partNumber - b.partNumber);
}
