// Whether a paste of 3 or more lines into the terminal asks first
// (Settings → "Confirm multi-line pastes", off by default). One value for the
// whole window, read at paste time, so a split pane or a new tab can never
// miss it the way per-pane settings once did.
let confirmMultiline = false;

export function setConfirmMultilinePaste(enabled: boolean): void {
  confirmMultiline = enabled;
}

export function shouldConfirmMultilinePaste(): boolean {
  return confirmMultiline;
}
