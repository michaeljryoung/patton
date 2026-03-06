import '@xterm/xterm/css/xterm.css';
import './styles/main.css';
import './styles/tabs.css';
import './styles/terminal.css';
import './styles/editor.css';
import './styles/settings.css';

import { App } from './components/app';

const app = new App();
app.init().catch(console.error);
