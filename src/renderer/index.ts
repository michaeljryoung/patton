import '@xterm/xterm/css/xterm.css';
import './styles/main.css';
import './styles/tabs.css';
import './styles/terminal.css';
import './styles/editor.css';
import './styles/settings.css';
import './styles/board.css';

import { App } from './components/app';
import { applyUiTextScale } from './services/ui-text-scale';

// Before App builds the tab bar and sidebar: the preload already holds the saved
// value (a synchronous command-line switch from main), so the first paint is at
// size. App.init() applies the stored value again, which changes nothing.
applyUiTextScale(window.patton.settings.uiTextScaleAtLaunch, 'startup');

const app = new App();
app.init().catch(console.error);
