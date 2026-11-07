// Whether Patton answers Claude Code's `OSC 7501 ; ?` probe (Settings →
// Claude Code → "Use Claude Code's own status reports", on by default).
// Answering makes Claude drop its title glyphs and report its state over
// OSC 7501 instead; off, Claude keeps its glyphs and the glyph + Stop-hook
// path decides the dot as before v1.14. One value for the whole window, read
// at probe time, so a split pane, a new tab or the quick terminal can never
// miss it the way per-pane settings once did. A session already answered
// keeps reporting until it ends, hence "applies to sessions started after".
let answerProbe = true;

export function setProgramStatusEnabled(enabled: boolean): void {
  answerProbe = enabled;
}

export function programStatusEnabled(): boolean {
  return answerProbe;
}
