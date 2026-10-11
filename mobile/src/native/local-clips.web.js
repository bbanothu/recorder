/** No local clips on the web build (spec: phone-recorder-on-device.md) — server-only there, unchanged. */
export async function buildLocalClip() {
  return null;
}
export const listLocalClips = () => [];
export const getLocalClip = () => null;
export const localClipFiles = () => [];
export const deleteLocalClip = () => {};
export const deleteAllLocalClips = () => {};
export const localClipSizes = () => ({ audioSizeBytes: 0, textSizeBytes: 0 });
