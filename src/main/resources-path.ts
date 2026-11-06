import { app } from 'electron';
import { join } from 'node:path';

/** The bundled `resources/` folder (shell integration, the Claude Code hook):
 *  copied next to the asar by Forge's `extraResource` when packaged, and the
 *  repo's own folder in dev. */
export function getResourcesPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'resources');
  }
  return join(app.getAppPath(), 'resources');
}
