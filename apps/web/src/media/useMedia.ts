import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RealmSession } from "../lib/realm";
import { MediaSession, type MediaSnapshot } from "./MediaSession";
import type { SpatialAudio } from "./SpatialAudio";

const OFF: MediaSnapshot = {
  status: "off",
  error: null,
  micOn: false,
  cameraOn: false,
  speaking: new Set(),
  lastSpokeAt: new Map(),
  videos: new Map(),
};
const noopSubscribe = () => () => {};

/**
 * Connects LiveKit whenever the realm hands out a media grant (a new one after every realm
 * reconnect, since your LiveKit identity is your realm connection id), and wires it to the realm:
 * poses go over LiveKit's data channel, plus the realm relay while anyone isn't on LiveKit, and
 * your mic/camera state is reported so others see it.
 */
export function useMedia(
  realm: RealmSession,
  audio: SpatialAudio,
  initial: { mic: boolean; camera: boolean },
) {
  const [session, setSession] = useState<MediaSession | null>(null);
  // What you last chose, carried across reconnects.
  const wanted = useRef(initial);

  const { mediaGrant, poseHub } = realm;
  useEffect(() => {
    if (!mediaGrant) return;
    const media = new MediaSession(audio);
    media.onPose = (from, bytes) => poseHub.ingestPose(from, bytes, performance.now());
    // The session is an external connection whose lifetime this effect owns; React only needs
    // the handle.
    // oxlint-disable-next-line react/set-state-in-effect
    setSession(media);
    void media.connect(mediaGrant, wanted.current);
    return () => {
      setSession(null);
      void media.dispose();
    };
  }, [mediaGrant, audio, poseHub]);

  const snapshot = useSyncExternalStore(
    session?.subscribe ?? noopSubscribe,
    session?.getSnapshot ?? (() => OFF),
  );

  // A host mute or a failed camera changes what you have; remember that, not the old choice.
  useEffect(() => {
    if (snapshot.status === "connected") {
      wanted.current = { mic: snapshot.micOn, camera: snapshot.cameraOn };
    }
  }, [snapshot.status, snapshot.micOn, snapshot.cameraOn]);

  // Pose transport: LiveKit when connected; the realm relay too while anyone else lacks LiveKit.
  const participantsRef = useRef(realm.participants);
  useEffect(() => {
    participantsRef.current = realm.participants;
  }, [realm.participants]);
  const { selfId, sendPose } = realm;
  useEffect(() => {
    poseHub.setSender((bytes) => {
      const onLiveKit = session?.connected ?? false;
      if (onLiveKit) session!.publishPose(bytes);
      const someoneOff = participantsRef.current.some((p) => p.id !== selfId && !p.onMedia);
      if (!onLiveKit || someoneOff) sendPose(bytes);
    });
    return () => poseHub.setSender(null);
  }, [poseHub, session, selfId, sendPose]);

  // Report what you're publishing; also after a realm reconnect (new selfId).
  const { sendMediaState } = realm;
  const connected = snapshot.status === "connected";
  useEffect(() => {
    if (!selfId) return;
    sendMediaState({ micOn: snapshot.micOn, cameraOn: snapshot.cameraOn, connected });
  }, [selfId, snapshot.micOn, snapshot.cameraOn, connected, sendMediaState]);

  return {
    ...snapshot,
    setMic: (on: boolean) => {
      wanted.current = { ...wanted.current, mic: on };
      void session?.setMic(on);
    },
    setCamera: (on: boolean) => {
      wanted.current = { ...wanted.current, camera: on };
      void session?.setCamera(on);
    },
  };
}

export type MediaState = ReturnType<typeof useMedia>;
