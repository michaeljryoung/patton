# Homebrew tap

Read when the release workflow's `Update Homebrew cask` step fails, a cask needs a manual fix, or the tap's deploy key needs rotating. Moved word for word from CLAUDE.md's Gotchas (S44 slimming, 2026-11-07).

- **Homebrew tap auto-updates via a write-scoped SSH deploy key** (S33). `release.yml`'s `Update Homebrew cask` step regenerates `Casks/patton.rb` in `michaeljryoung/homebrew-patton` from a template — edit the template, not the tap (it also carries `depends_on macos`) — and pushes over SSH with the `HOMEBREW_DEPLOY_KEY` secret. Manual fallback: edit `version` + `sha256` and push, verifying the sha first (`curl -sL <dmg-url> | shasum -a 256`; a wrong hash breaks every `brew install`). Key rotation → `docs/session-archive.md`. **If the step fails with `Permission denied (publickey)`, the tap has lost its key:** `gh api repos/michaeljryoung/homebrew-patton/keys` lists none. It happened between the 12 Oct and 3 Nov releases (cause not found), so v1.10.4 missed the tap. Replaced 4 Nov: a new ed25519 write key on the tap ("Patton release workflow (write, 2026-11-04)") and its private half in the `HOMEBREW_DEPLOY_KEY` secret, proved by pushing the 1.10.4 cask with it; no copy is kept on the Mac. Don't re-run a failed release to fix the cask: "Compute next version" bumps again and cuts a duplicate release.

Moved from CLAUDE.md's Gotchas (S46 slimming, 2026-11-08), word for word:

- **Homebrew tap or cask trouble** (the release's `Update Homebrew cask` step fails, `Permission denied (publickey)`, a cask to fix by hand, a key to rotate) → read `docs/reference/homebrew-tap.md` first. Never re-run a failed release to fix the cask: it cuts a duplicate release.
