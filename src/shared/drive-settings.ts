/**
 * What Send to Drive's settings accept (docs/review-tab.md R8): main's store
 * validation and the Settings panel's "not saved" line use the same rules.
 * Values are trimmed first; '' means the default (the "Patton" folder; the
 * one personal account gcloud holds).
 */

/** One folder at the top of My Drive: no slash, no control characters, ≤ 100 chars. */
export function driveFolderValid(value: string): boolean {
  return value.length <= 100 && !/[\p{Cc}/]/u.test(value);
}

/** '' or an email-shaped address, ≤ 254 chars. */
export function driveAccountValid(value: string): boolean {
  return value === '' || (value.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(value));
}
