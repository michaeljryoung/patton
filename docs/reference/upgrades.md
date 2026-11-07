# npm and Electron upgrade notes

Read before adding or bumping a dependency (native ones above all), or upgrading npm or Electron. Moved word for word from CLAUDE.md's Gotchas (S44 slimming, 2026-11-07).

- **npm 12 skips every dependency's install scripts unless `package.json` approves it** (S39). The install still "succeeds", with a warning, and the build fails later (node-pty unbuilt). After adding or bumping a native dependency, run `npm approve-scripts --allow-scripts-pending` and approve with `npm install-scripts approve <pkg> --allow-scripts-pin=false`. CI's npm (11) ignores the field.
- **Electron 42+ changes that bite** (S37). `npm install` no longer downloads the binary (`npm start` fetches it on first run; `npx install-electron --no` does it by hand); macOS notifications go through UNNotification and need a code-signed app — refusals log `[NOTIFY] Notification not shown`; Electron 44 needs macOS 13+.
