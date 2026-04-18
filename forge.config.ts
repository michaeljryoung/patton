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

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Patton',
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

        // Copy to /Applications so dock shortcut always points to latest build
        const dest = '/Applications/Patton.app';
        execSync(`rm -rf "${dest}" && cp -R "${appPath}" "${dest}"`, { stdio: 'inherit' });
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
