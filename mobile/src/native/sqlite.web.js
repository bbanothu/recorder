/**
 * No on-device sqlite in the browser build: local clips stay out of scope
 * for web (spec: phone-recorder-on-device.md). `openLocalDb` returning null
 * tells RecorderContext to fall back to the server-only clip path, same as
 * before this change.
 */
export function openLocalDb() {
  return null;
}
