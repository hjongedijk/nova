import { storage } from "#lib/util/storage.ts";

const DEVICE_KEY = "novaAudioInput";
const CHANGE_EVENT = "nova-input-device-change";

/** Chromium added SpeechRecognition.start(MediaStreamTrack) in version 135. */
export function supportsSpeechInputSelection(): boolean {
  if (!navigator.mediaDevices?.getUserMedia) return false;
  const agent = navigator.userAgent;
  const version =
    agent.match(/Edg\/(\d+)/)?.[1] ?? agent.match(/Chrome\/(\d+)/)?.[1];
  return Number(version) >= 135;
}

export function selectedInputDevice(): string {
  return storage.get(DEVICE_KEY, "");
}

export function setSelectedInputDevice(deviceId: string): void {
  storage.set(DEVICE_KEY, deviceId, "audio-input");
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Ask permission only from the explicit device-picker action, then stop the probe stream. */
export async function discoverInputDevices(): Promise<MediaDeviceInfo[]> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((track) => track.stop());
  return (await navigator.mediaDevices.enumerateDevices()).filter(
    (device) => device.kind === "audioinput",
  );
}

/** The caller owns the stream and must stop it when recognition ends. */
export async function openSelectedInputStream(): Promise<MediaStream | null> {
  const deviceId = selectedInputDevice();
  if (!deviceId) return null;
  if (!supportsSpeechInputSelection())
    throw new Error(
      "Deze browser ondersteunt geen gekozen microfoon voor spraakherkenning.",
    );
  return navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: deviceId } },
  });
}

export function stopInputStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export function onInputDeviceChange(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === DEVICE_KEY || event.key === null) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  navigator.mediaDevices?.addEventListener("devicechange", listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
    navigator.mediaDevices?.removeEventListener("devicechange", listener);
  };
}
