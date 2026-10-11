/** No on-device transcription on the web build — local clips don't exist there either (local-clips.web.js). */
export const nativeTranscriptionAvailable = () => false;
export const hasModel = () => false;
export async function downloadModel() {
  throw new Error('On-device transcription is not available on web');
}
export function getClipTranscript(clip) {
  return { markdown: `# Clip transcript\n\n_Not available on web._\n`, progress: { done: 0, total: clip?.chunkCount ?? 0 } };
}
export async function transcribeClip() {}
export function updateLocalClipTranscript() {}
export function deleteLocalClipTranscript() {}
export async function redoLocalClip() {}
export function deleteLocalClipAudio() {}
