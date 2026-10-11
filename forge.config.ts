import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

// Use self-signed "Patton Dev Signing" cert for stable code identity across rebuilds.
// Without this, ad-hoc signing (`--sign -`) generates a new identity hash every build,
// causing macOS TCC to forget Screen Recording and other permission grants.
// Fallback to ad-hoc if the cert isn't installed (e.g. CI or fresh machine).
const SIGNING_IDENTITY = (() => {
  try {
    const result = execSync('security find-identity -v -p codesigning 2>/dev/null', {
      encoding: 'utf8',
    });
    if (result.includes('Patton Dev Signing')) return 'Patton Dev Signing';
  } catch { /* ignore */ }
  return '-';
})();

// Local builds take their version from git, so /Applications/Patton.app reports
// the release it was built from — "1.10.2", or "1.10.2+3" three commits later —
// instead of package.json's placeholder 1.0.0. CI stamps package.json itself
// ("Set version for build" in release.yml) before building, so leave it alone
// there. Tags only arrive with `git fetch --tags`; until then a build made
// right after a release shows the previous tag plus its commits.
const LOCAL_VERSION = (() => {
  if (process.env.CI) return undefined;
  try {
    const described = execSync('git describe --tags --long --match "v[0-9]*"', {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = described.match(/^v(\d+\.\d+\.\d+)-(\d+)-g[0-9a-f]+$/);
    if (!match) return undefined;
    return match[2] === '0' ? match[1] : `${match[1]}+${match[2]}`;
  } catch {
    return undefined; // no git or no release tags: keep package.json's version
  }
})();

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Patton',
    // Info.plist version (About box, Finder); app.getVersion() comes from the
    // build's package.json, stamped in packageAfterPrune below.
    ...(LOCAL_VERSION ? { appVersion: LOCAL_VERSION } : {}),
    icon: './build/icon',
    asar: {
      unpack: '**/{*.node,node-pty/**/*}',
    },
    extraResource: ['./resources'],
  },
  hooks: {
    postPackage: async (_forgeConfig, packageResult) => {
      if (process.platform !== 'darwin') return;
      const entitlements = path.join(__dirname, 'build', 'entitlements.plist');
      for (const outputPath of packageResult.outputPaths) {
        const appPath = path.join(outputPath, 'Patton.app');
        if (!fs.existsSync(appPath)) continue;

        // Fix execute permissions on spawn-helper (npm install strips +x)
        execSync(
          `find "${appPath}" -name "spawn-helper" -exec chmod +x {} \\;`,
          { stdio: 'inherit' },
        );

        // Sign ALL Mach-O binaries: .node, .dylib, and extensionless (e.g. spawn-helper)
        execSync(
          `find "${appPath}" -type f \\( -name "*.node" -o -name "*.dylib" -o -name "spawn-helper" \\) -exec codesign --force --sign "${SIGNING_IDENTITY}" --entitlements "${entitlements}" {} \\;`,
          { stdio: 'inherit' },
        );
        // Sign all helper .app bundles inside-out
        execSync(
          `find "${appPath}" -name "*.app" -depth -exec codesign --force --sign "${SIGNING_IDENTITY}" --entitlements "${entitlements}" {} \\;`,
          { stdio: 'inherit' },
        );
        // Sign the main app bundle
        execSync(`codesign --force --sign "${SIGNING_IDENTITY}" --entitlements "${entitlements}" --deep "${appPath}"`, {
          stdio: 'inherit',
        });

        // Copy to /Applications so the dock shortcut always points at the latest
        // build. `ditto` overwrites in place instead of `rm -rf` + `cp -R`: the
        // post-commit hook runs this on EVERY commit, and deleting the bundle
        // out from under a running Patton kills it the next time it lazily
        // loads anything from the bundle (S36 — cost a live session mid-work).
        // macOS keeps a running process's open inodes alive across an
        // overwrite, which is the same no-force-quit path S31 validated for
        // installing a released DMG over the running app.
        // Trade-off: files that disappear in a newer build can linger here, so
        // remove /Applications/Patton.app by hand if you need a clean install.
        const dest = '/Applications/Patton.app';
        execSync(`ditto "${appPath}" "${dest}"`, { stdio: 'inherit' });
        console.log(`\n✅ Installed to ${dest}`);
      }
    },
    packageAfterPrune: async (_forgeConfig, buildPath) => {
      // Read dependency versions from the project root
      const projectPkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
      const pkgPath = path.join(buildPath, 'package.json');

      // Merge native deps into the build's package.json
      const buildPkg = fs.existsSync(pkgPath)
        ? JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
        : { name: projectPkg.name, version: projectPkg.version, main: projectPkg.main };

      buildPkg.dependencies = {
        'node-pty': projectPkg.dependencies['node-pty'],
        'electron-store': projectPkg.dependencies['electron-store'],
      };
      // app.getVersion() (and so main.log's startup line) reads this file.
      if (LOCAL_VERSION) buildPkg.version = LOCAL_VERSION;
      fs.writeFileSync(pkgPath, JSON.stringify(buildPkg, null, 2));

      // Install native modules in the packaged app
      execSync('npm install --omit=dev', { cwd: buildPath, stdio: 'inherit' });
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerDMG({
      icon: './build/icon.icns',
    }),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
