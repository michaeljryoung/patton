import { keepPlacements } from '../../shared/board-placements';
import { BOARD_TINTS, DEFAULTS, type BoardTint } from '../../shared/constants';
import type { BoardLayout, BoardPayload, BoardProject, BoardSubProject, BoardTheme } from '../../shared/types';
import { announce } from '../services/announcer';
import type { ProjectLiveState } from '../services/project-live-state';
import { rlog } from '../services/renderer-logger';
import { ConfirmDialog } from './confirm-dialog';
import { ContextMenu } from './context-menu';

/**
 * The project board: a tile board that fills a new empty tab. Themes are areas
 * with a faint tint; project tiles sit in a grid inside them and drag between
 * them; worktrees and sub-projects sit inside their parent's tile. A click opens
 * the project (the host starts Claude there and removes the board's tab).
 *
 * The board owns the arrangement (themes, their order, tile options) and saves
 * it through `window.patton.board.setLayout`, debounced. The project list itself
 * belongs to main; "+ Project" asks main to add a row.
 */
export interface ProjectBoardHost {
  /** Open or activate the project; the host then removes the board's tab.
   *  Rejects when it could not open it (the board says so). */
  openProject(path: string): Promise<void> | void;
  /** "Plain terminal", or Esc on an empty search: the host removes the board and keeps the tab as a plain shell. */
  dismiss(): void;
  /** Live state of a project folder (the host computes it with project-live-state.ts). */
  liveState(path: string): ProjectLiveState;
}

// Private drag types: a tile or area dropped on the terminal or another app
// carries no text, so nothing gets typed or opened by accident.
const TILE_DRAG_TYPE = 'application/x-patton-board-tile';
const AREA_DRAG_TYPE = 'application/x-patton-board-area';
/** Main rate-limits board:set-layout, so changes are gathered and saved once. */
const SAVE_DEBOUNCE_MS = 300;
const SAVE_RETRY_MS = 1000;
/** The virtual area for projects in no theme. Theme ids match ^[a-z0-9-]+$, so it can't collide. */
const UNSORTED = '__unsorted';
const TINTS: readonly BoardTint[] = BOARD_TINTS.filter((t) => t !== 'none');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function cloneLayout(layout: BoardLayout): BoardLayout {
  return JSON.parse(JSON.stringify(layout)) as BoardLayout;
}

function folderName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/** "under 1 h ago", "4 h ago", "2 d ago", "3 wk ago". */
export function ageText(lastSessionAt: number | undefined, now: number = Date.now(), suffix = ' ago'): string | null {
  if (lastSessionAt === undefined) return null;
  const diff = Math.max(0, now - lastSessionAt);
  if (diff < HOUR) return `under 1 h${suffix}`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h${suffix}`;
  if (diff < 14 * DAY) return `${Math.floor(diff / DAY)} d${suffix}`;
  return `${Math.floor(diff / (7 * DAY))} wk${suffix}`;
}

interface StateLine {
  text: string;
  /** 'needs' (green dot), 'open' (blue dot), or '' (no dot). */
  dot: 'needs' | 'open' | '';
}

function stateLine(state: ProjectLiveState, lastSessionAt: number | undefined, missing: boolean | undefined): StateLine {
  if (state.waiting > 0) return { text: 'needs you', dot: 'needs' };
  if (state.working > 0) return { text: 'working', dot: '' };
  if (state.isOpen) return { text: 'open here', dot: 'open' };
  if (missing) return { text: 'folder missing', dot: '' };
  return { text: ageText(lastSessionAt) ?? 'no sessions yet', dot: '' };
}

/** A shown area: a theme, or the virtual Unsorted area. */
interface Area {
  id: string;
  name: string;
  tint: BoardTint;
  theme: BoardTheme | null;
  projects: BoardProject[];
}

type DropTarget =
  | { kind: 'tile'; areaId: string; anchor: string | null; after: boolean; mark: HTMLElement; cls: string }
  | { kind: 'area'; anchorId: string; after: boolean; mark: HTMLElement; cls: string };

export class ProjectBoard {
  readonly element: HTMLElement;
  private payload: BoardPayload;
  private layout: BoardLayout;
  private readonly searchInput: HTMLInputElement;
  private readonly countEl: HTMLElement;
  private readonly formEl: HTMLElement;
  private readonly areasEl: HTMLElement;
  private readonly contextMenu = new ContextMenu();
  private readonly confirmDialog = new ConfirmDialog(document.body);

  // Held while a drag, rename, note or form is open; applied when it closes.
  private dragKind: 'tile' | 'area' | null = null;
  private dragId: string | null = null;
  private editing = 0;
  private heldPayload: BoardPayload | null = null;
  private heldLayout: BoardLayout | null = null;

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Saves sent and not yet answered. While any is, an echoed layout is older
   *  than ours (main answers after it echoes), so it is not taken. */
  private savesInFlight = 0;
  private saveRetried = false;
  /** The add count main gave with our project list; sent with every save. */
  private generation: number;
  /** The folder picker is open (a second click must not open another). */
  private picking = false;
  /** Bumped on every local change, so a save's reply never overwrites a newer change. */
  private revision = 0;
  private disposed = false;

  constructor(private readonly host: ProjectBoardHost, payload: BoardPayload) {
    this.payload = payload;
    this.layout = cloneLayout(payload.layout);
    this.generation = payload.generation ?? 0;

    this.element = document.createElement('section');
    this.element.className = 'pboard';
    this.element.setAttribute('role', 'region');
    this.element.setAttribute('aria-label', 'Projects');

    const head = document.createElement('div');
    head.className = 'pboard-head';
    const title = document.createElement('h1');
    title.className = 'pboard-title';
    title.textContent = 'Projects';
    this.countEl = document.createElement('span');
    this.countEl.className = 'pboard-count';
    this.searchInput = document.createElement('input');
    this.searchInput.type = 'search';
    this.searchInput.className = 'pboard-search';
    this.searchInput.placeholder = 'Find a project';
    this.searchInput.setAttribute('aria-label', 'Find a project');
    this.searchInput.spellcheck = false;
    const addTheme = this.button('+ Theme', 'pboard-btn pboard-add-theme', () => this.addTheme());
    const addProject = this.button('+ Project', 'pboard-btn pboard-add-project', () => {
      this.pickProject().catch((err) => rlog('error', '[BOARD] pick failed', String(err)));
    });
    const plain = this.button('Plain terminal', 'pboard-btn pboard-plain', () => this.host.dismiss());
    head.append(title, this.countEl, this.searchInput, addTheme, addProject, plain);

    this.formEl = document.createElement('div');
    this.formEl.className = 'pboard-form';
    this.formEl.hidden = true;

    this.areasEl = document.createElement('div');
    this.areasEl.className = 'pboard-areas';

    this.element.append(head, this.formEl, this.areasEl);

    this.searchInput.addEventListener('input', () => this.applyFilter());
    this.searchInput.addEventListener('keydown', (e) => this.onSearchKey(e));
    this.setupDrag();
    this.render();
  }

  // ── Public API (the host's contract) ──

  focus(): void {
    this.searchInput.focus();
  }

  setPayload(payload: BoardPayload): void {
    if (this.disposed) return;
    if (this.isBusy()) {
      this.heldPayload = payload;
      return;
    }
    this.adoptPayload(payload);
    this.render();
  }

  setLayout(layout: BoardLayout): void {
    if (this.disposed) return;
    if (this.isBusy()) {
      this.heldLayout = layout;
      return;
    }
    if (this.adoptLayout(layout)) this.render();
  }

  refreshLiveState(): void {
    if (this.disposed) return;
    const tiles = this.areasEl.querySelectorAll<HTMLElement>('.pb-tile');
    for (const tile of tiles) {
      const project = this.projectByPath(tile.dataset.path ?? '');
      if (project) this.paintTileState(tile, project);
    }
    const chips = this.areasEl.querySelectorAll<HTMLElement>('.pb-chip');
    for (const chip of chips) {
      const sub = this.subByPath(chip.dataset.path ?? '');
      if (sub) this.paintChip(chip, sub);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    // Save what's pending now: the board is going away.
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.sendSave();
    }
    this.disposed = true;
    this.contextMenu.dispose();
    this.confirmDialog.dispose();
    this.element.remove();
  }

  // ── Model ──

  private isBusy(): boolean {
    return this.dragKind !== null || this.editing > 0;
  }

  /** A save of ours is waiting or on its way: our layout is newer than main's. */
  private hasUnsavedLayout(): boolean {
    return this.saveTimer !== null || this.savesInFlight > 0;
  }

  private adoptPayload(payload: BoardPayload): void {
    const known = new Set(this.payload.projects.map((p) => p.path));
    this.payload = payload;
    this.generation = Math.max(this.generation, payload.generation ?? 0);
    if (!this.hasUnsavedLayout()) {
      this.layout = cloneLayout(payload.layout);
      return;
    }
    // A change of ours not yet saved is newer than the payload's layout, but
    // projects new to this board take the theme main gave them, so our next
    // save carries their placement instead of dropping it.
    const added = payload.projects.map((p) => p.path).filter((p) => !known.has(p));
    if (keepPlacements(this.layout, payload.layout, added) > 0) {
      rlog('info', '[BOARD] kept the placement of a project added meanwhile', { count: added.length });
      this.changed();
    }
  }

  /** Take another window's (or our own echoed) save, unless one of ours is
   *  waiting or on its way (its own answer or echo will follow). */
  private adoptLayout(layout: BoardLayout): boolean {
    if (this.hasUnsavedLayout()) return false;
    this.layout = cloneLayout(layout);
    return true;
  }

  /** Apply what was held back while busy, then redraw. */
  private release(): void {
    if (this.isBusy()) return;
    if (this.heldPayload) this.adoptPayload(this.heldPayload);
    if (this.heldLayout) this.adoptLayout(this.heldLayout);
    this.heldPayload = null;
    this.heldLayout = null;
    this.render();
  }

  private projectByPath(path: string): BoardProject | undefined {
    return this.payload.projects.find((p) => p.path === path);
  }

  private subByPath(path: string): BoardSubProject | undefined {
    for (const p of this.payload.projects) {
      const sub = p.subProjects.find((s) => s.path === path);
      if (sub) return sub;
    }
    return undefined;
  }

  private themeById(id: string): BoardTheme | undefined {
    return this.layout.themes.find((t) => t.id === id);
  }

  /** The areas as shown: themes in order, then Unsorted when it has projects. */
  private areas(): Area[] {
    const byPath = new Map(this.payload.projects.map((p) => [p.path, p]));
    const placed = new Set<string>();
    const areas: Area[] = [];
    for (const theme of this.layout.themes) {
      const projects: BoardProject[] = [];
      for (const path of theme.projects) {
        const project = byPath.get(path);
        if (project && !placed.has(path)) {
          placed.add(path);
          projects.push(project);
        }
      }
      areas.push({ id: theme.id, name: theme.name, tint: theme.tint, theme, projects });
    }
    const unsorted = this.payload.projects.filter((p) => !placed.has(p.path));
    if (unsorted.length > 0) areas.push({ id: UNSORTED, name: 'Unsorted', tint: 'none', theme: null, projects: unsorted });
    return areas;
  }

  private areaOf(path: string): Area | undefined {
    return this.areas().find((a) => a.projects.some((p) => p.path === path));
  }

  /**
   * Move a project to an area: before or after `anchor` (a shown project in it),
   * or at its end when `anchor` is null. Only the moved path is spliced, so
   * paths not in the current list keep their places in every theme.
   */
  private placeProject(path: string, areaId: string, anchor: string | null, after: boolean): void {
    for (const theme of this.layout.themes) theme.projects = theme.projects.filter((p) => p !== path);
    if (areaId === UNSORTED) return;
    const theme = this.themeById(areaId);
    if (!theme) return;
    const at = anchor ? theme.projects.indexOf(anchor) : -1;
    if (at === -1) theme.projects.push(path);
    else theme.projects.splice(after ? at + 1 : at, 0, path);
  }

  private changed(): void {
    this.revision++;
    this.scheduleSave();
  }

  // ── Saving ──

  private scheduleSave(delay = SAVE_DEBOUNCE_MS): void {
    if (this.disposed) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.sendSave();
    }, delay);
  }

  /** Save now: used before adding a project, so main's layout includes ours. */
  private async flushSave(): Promise<void> {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await this.sendSave();
  }

  private sendSave(): Promise<void> {
    const sent = this.revision;
    this.savesInFlight++;
    return window.patton.board.setLayout(cloneLayout(this.layout), this.generation).then(
      (stored) => {
        this.savesInFlight--;
        if (stored === null) {
          rlog('warn', '[BOARD] save refused', { retried: this.saveRetried });
          if (!this.saveRetried && !this.disposed) {
            this.saveRetried = true;
            if (!this.saveTimer) this.scheduleSave(SAVE_RETRY_MS);
          } else {
            this.saveRetried = false;
            announce("The board's arrangement could not be saved", 'assertive');
          }
          return;
        }
        this.saveRetried = false;
        // Main may have trimmed it; take its copy unless something changed since.
        if (sent === this.revision && !this.hasUnsavedLayout() && !this.isBusy() && !this.disposed) {
          this.layout = cloneLayout(stored);
        }
      },
      (err) => {
        this.savesInFlight--;
        rlog('error', '[BOARD] save failed', String(err));
        announce("The board's arrangement could not be saved", 'assertive');
      },
    );
  }

  // ── Rendering ──

  private render(): void {
    if (this.disposed || this.isBusy()) return;
    const active = document.activeElement as HTMLElement | null;
    const focusPath = this.areasEl.contains(active) ? active?.dataset.path : undefined;
    const focusArea = this.areasEl.contains(active) ? active?.dataset.areaMenu : undefined;

    const subCount = this.payload.projects.reduce((n, p) => n + p.subProjects.length, 0);
    const total = this.payload.projects.length + subCount;
    this.countEl.textContent = String(total);
    this.countEl.setAttribute('aria-label', `${total} projects`);

    this.areasEl.replaceChildren();
    if (!this.payload.listFound) {
      this.areasEl.appendChild(this.emptyNote(`No project list at ${this.payload.listFile}. Set one in Settings → Project list file.`));
      return;
    }
    if (this.payload.projects.length === 0 && this.layout.themes.length === 0) {
      // + Project adds only inside a project table, so invite it only when there is one.
      this.areasEl.appendChild(this.emptyNote(this.payload.listTable
        ? 'The project list is empty. Use + Project to add one.'
        : `${this.payload.listFile} has no project table. Add a header row | Project | Path | with a separator row |---|---| under it, `
          + 'or choose another file in Settings → Project list file.'));
      return;
    }
    for (const area of this.areas()) this.areasEl.appendChild(this.renderArea(area));
    this.applyFilter();

    if (focusPath) this.tileButton(focusPath)?.focus();
    else if (focusArea) this.areasEl.querySelector<HTMLElement>(`[data-area-menu="${CSS.escape(focusArea)}"]`)?.focus();
  }

  private emptyNote(text: string): HTMLElement {
    const p = document.createElement('p');
    p.className = 'pboard-empty';
    p.textContent = text;
    return p;
  }

  private renderArea(area: Area): HTMLElement {
    const section = document.createElement('section');
    section.className = 'pb-area';
    section.dataset.areaId = area.id;
    section.dataset.tint = area.tint;
    section.setAttribute('role', 'group');
    const headingId = `pb-area-${area.id}-${Math.random().toString(36).slice(2, 7)}`;
    section.setAttribute('aria-labelledby', headingId);

    const head = document.createElement('div');
    head.className = 'pb-area-head';
    const heading = document.createElement('h2');
    heading.className = 'pb-area-title';
    heading.id = headingId;
    const swatch = document.createElement('i');
    swatch.className = 'pb-swatch';
    swatch.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'pb-area-name';
    name.textContent = area.name;
    heading.append(swatch, name);
    const count = document.createElement('span');
    count.className = 'pb-area-count';
    count.textContent = String(area.projects.length);
    count.setAttribute('aria-label', `${area.projects.length} projects`);
    head.append(heading, count);

    if (area.theme) {
      const theme = area.theme;
      head.draggable = true;
      const menuBtn = this.button('⋯', 'pb-area-menu', () => {
        const rect = menuBtn.getBoundingClientRect();
        this.showAreaMenu(theme, rect.left, rect.bottom + 2, menuBtn, true);
      });
      menuBtn.dataset.areaMenu = theme.id;
      menuBtn.setAttribute('aria-label', `${theme.name} theme menu`);
      menuBtn.setAttribute('aria-haspopup', 'menu');
      menuBtn.addEventListener('keydown', (e) => {
        if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
          e.preventDefault();
          const rect = menuBtn.getBoundingClientRect();
          this.showAreaMenu(theme, rect.left, rect.bottom + 2, menuBtn, true);
        }
      });
      head.appendChild(menuBtn);
      name.addEventListener('dblclick', () => this.startRename(theme.id, false));
      head.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.showAreaMenu(theme, e.clientX, e.clientY, menuBtn, false);
      });
      head.addEventListener('dragstart', (e) => {
        if (!e.dataTransfer || (e.target as HTMLElement | null)?.closest?.('.pb-tile')) return;
        this.dragKind = 'area';
        this.dragId = theme.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(AREA_DRAG_TYPE, theme.id);
        section.classList.add('is-dragging');
      });
      head.addEventListener('dragend', () => this.endDrag());
    }

    const list = document.createElement('ul');
    list.className = 'pb-tiles';
    for (const project of area.projects) list.appendChild(this.renderTile(project, area));
    section.append(head, list);
    return section;
  }

  private renderTile(project: BoardProject, area: Area): HTMLElement {
    const li = document.createElement('li');
    li.className = 'pb-tile';
    li.dataset.path = project.path;
    const options = this.layout.tiles[project.path];
    if (project.subProjects.length > 0 || options?.wide) li.classList.add('wide');
    if (project.missing) li.classList.add('is-missing');
    li.draggable = true;

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'pb-tile-main';
    main.dataset.path = project.path;
    const name = document.createElement('span');
    name.className = 'pb-name';
    name.textContent = project.name;
    const meta = document.createElement('span');
    meta.className = 'pb-meta';
    main.append(name, meta);
    if (options?.note) {
      const note = document.createElement('span');
      note.className = 'pb-note';
      note.textContent = options.note;
      main.appendChild(note);
    }
    if (project.missing) main.setAttribute('aria-disabled', 'true');
    li.appendChild(main);

    if (project.subProjects.length > 0) {
      const subs = document.createElement('div');
      subs.className = 'pb-subs';
      for (const sub of project.subProjects) subs.appendChild(this.renderChip(sub));
      li.appendChild(subs);
    }

    main.dataset.areaName = area.name;
    this.paintTileState(li, project);

    main.addEventListener('click', () => this.openProject(project));
    main.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.openProject(project);
      } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault();
        const rect = main.getBoundingClientRect();
        this.showTileMenu(project, rect.left + 8, rect.bottom - 4, main, true);
      }
    });
    li.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement | null)?.closest?.('.pb-chip')) return;
      e.preventDefault();
      this.showTileMenu(project, e.clientX, e.clientY, main, false);
    });
    li.addEventListener('dragstart', (e) => {
      if (!e.dataTransfer) return;
      e.stopPropagation();
      this.dragKind = 'tile';
      this.dragId = project.path;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(TILE_DRAG_TYPE, project.path);
      li.classList.add('is-dragging');
    });
    li.addEventListener('dragend', () => this.endDrag());
    return li;
  }

  private renderChip(sub: BoardSubProject): HTMLElement {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'pb-chip';
    chip.dataset.path = sub.path;
    if (sub.missing) chip.classList.add('is-missing');
    this.paintChip(chip, sub);
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openSub(sub);
    });
    chip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        this.openSub(sub);
      }
    });
    return chip;
  }

  private paintChip(chip: HTMLElement, sub: BoardSubProject): void {
    const state = this.host.liveState(sub.path);
    let stateText: string;
    if (state.waiting > 0) stateText = 'needs you';
    else if (state.working > 0) stateText = 'working';
    else if (state.isOpen) stateText = 'open';
    else if (sub.missing) stateText = 'missing';
    else stateText = ageText(sub.lastSessionAt, Date.now(), '') ?? 'no sessions';
    const label = `${sub.kind === 'worktree' ? '⎇ ' : ''}${sub.displayName}`;
    chip.replaceChildren();
    const name = document.createElement('span');
    name.textContent = label;
    const meta = document.createElement('b');
    meta.textContent = stateText;
    chip.append(name, document.createTextNode(' '), meta);
    chip.classList.toggle('needs', state.waiting > 0);
    chip.setAttribute('aria-label', `${sub.kind === 'worktree' ? 'Worktree ' : ''}${sub.displayName}, ${stateText}${sub.missing ? ', folder missing' : ''}`);
  }

  /** The tile's state line, current-tab edge and full label, painted in place. */
  private paintTileState(li: HTMLElement, project: BoardProject): void {
    const main = li.querySelector<HTMLElement>('.pb-tile-main');
    const meta = li.querySelector<HTMLElement>('.pb-meta');
    if (!main || !meta) return;
    const state = this.host.liveState(project.path);
    const line = stateLine(state, project.lastSessionAt, project.missing);
    meta.replaceChildren();
    meta.className = 'pb-meta';
    if (line.dot) {
      meta.classList.add(line.dot === 'needs' ? 'needs' : 'is-open');
      const dot = document.createElement('i');
      dot.className = 'pb-dot';
      dot.setAttribute('aria-hidden', 'true');
      meta.appendChild(dot);
    }
    meta.appendChild(document.createTextNode(line.text));
    li.classList.toggle('is-current', state.isCurrent);
    const parts = [project.name, main.dataset.areaName ?? '', line.text];
    if (project.missing && line.text !== 'folder missing') parts.push('folder missing');
    if (state.isCurrent) parts.push('this tab');
    const note = this.layout.tiles[project.path]?.note;
    if (note) parts.push(note);
    main.setAttribute('aria-label', parts.filter(Boolean).join(', '));
  }

  private tileButton(path: string): HTMLElement | null {
    return this.areasEl.querySelector<HTMLElement>(`.pb-tile-main[data-path="${CSS.escape(path)}"]`);
  }

  // ── Search ──

  private applyFilter(): void {
    const query = this.searchInput.value.trim().toLowerCase();
    for (const section of this.areasEl.querySelectorAll<HTMLElement>('.pb-area')) {
      const areaName = (section.querySelector('.pb-area-name')?.textContent ?? '').toLowerCase();
      const areaHit = query !== '' && areaName.includes(query);
      let shown = 0;
      for (const li of section.querySelectorAll<HTMLElement>('.pb-tile')) {
        const hit = !query || areaHit || this.tileMatch(li.dataset.path ?? '', query) !== null;
        li.hidden = !hit;
        if (hit) shown++;
      }
      section.hidden = query !== '' && shown === 0;
    }
  }

  /** The path a search match opens: the project, or the first sub-project that matched. */
  private tileMatch(path: string, query: string): string | null {
    const project = this.projectByPath(path);
    if (!project) return null;
    if (project.name.toLowerCase().includes(query)) return project.path;
    const sub = project.subProjects.find((s) => s.name.toLowerCase().includes(query) || s.displayName.toLowerCase().includes(query));
    return sub ? sub.path : null;
  }

  private onSearchKey(e: KeyboardEvent): void {
    // Enter or Esc that confirms or cancels an input method's composition is the IME's.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (this.searchInput.value) {
        this.searchInput.value = '';
        this.applyFilter();
      } else {
        this.host.dismiss();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const query = this.searchInput.value.trim().toLowerCase();
      const first = Array.from(this.areasEl.querySelectorAll<HTMLElement>('.pb-tile')).find(
        (li) => !li.hidden && !(li.closest('.pb-area') as HTMLElement | null)?.hidden && !li.classList.contains('is-missing'),
      );
      if (!first) {
        announce('No project matches', 'polite');
        return;
      }
      const path = first.dataset.path ?? '';
      const target = query ? this.tileMatch(path, query) ?? path : path;
      const sub = target !== path ? this.subByPath(target) : undefined;
      if (sub) this.openSub(sub);
      else {
        const project = this.projectByPath(path);
        if (project) this.openProject(project);
      }
    }
  }

  // ── Opening ──

  private openProject(project: BoardProject): void {
    if (project.missing) {
      announce(`${project.name}'s folder is missing`, 'assertive');
      return;
    }
    this.openPath(project.path, project.name);
  }

  private openSub(sub: BoardSubProject): void {
    if (sub.missing) {
      announce(`${sub.displayName}'s folder is missing`, 'assertive');
      return;
    }
    this.openPath(sub.path, sub.displayName);
  }

  private openPath(path: string, name: string): void {
    const failed = (err: unknown) => {
      rlog('error', '[BOARD] open failed', String(err));
      announce(`Could not open ${name}`, 'assertive');
    };
    rlog('info', '[BOARD] open', { sub: !this.projectByPath(path) });
    try {
      Promise.resolve(this.host.openProject(path)).catch(failed);
    } catch (err) {
      failed(err);
    }
  }

  // ── Drag: tiles within and between areas, area heads to reorder areas ──

  private setupDrag(): void {
    const onDragOver = (e: DragEvent) => {
      if (!this.dragKind || !e.dataTransfer) return; // a file or text from elsewhere: not ours
      const target = this.dropTarget(e);
      if (!target) {
        this.clearDropMarks();
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (target.mark.classList.contains(target.cls)) return;
      this.clearDropMarks();
      target.mark.classList.add(target.cls);
    };
    const onDragLeave = (e: DragEvent) => {
      const into = e.relatedTarget as Node | null;
      if (!into || !this.areasEl.contains(into)) this.clearDropMarks();
    };
    const onDrop = (e: DragEvent) => {
      if (!this.dragKind || !this.dragId) return;
      const target = this.dropTarget(e);
      if (!target) return;
      e.preventDefault();
      const kind = this.dragKind;
      const id = this.dragId;
      if (kind === 'tile' && target.kind === 'tile') this.dropTile(id, target.areaId, target.anchor, target.after);
      else if (kind === 'area' && target.kind === 'area') this.dropArea(id, target.anchorId, target.after);
      this.endDrag();
    };
    // Chromium skips dragend when a drag is torn down inside dragstart. A new
    // press on the board means any earlier drag is over.
    const onPointerDown = () => this.endDrag();
    this.areasEl.addEventListener('dragover', onDragOver);
    this.areasEl.addEventListener('dragleave', onDragLeave);
    this.areasEl.addEventListener('drop', onDrop);
    this.element.addEventListener('mousedown', onPointerDown, true);
  }

  private dropTarget(e: DragEvent): DropTarget | null {
    const el = e.target as HTMLElement | null;
    const section = el?.closest?.<HTMLElement>('.pb-area');
    if (!section) return null;
    const areaId = section.dataset.areaId ?? '';

    if (this.dragKind === 'area') {
      if (areaId === UNSORTED || areaId === this.dragId) return null;
      const rect = section.getBoundingClientRect();
      const after = e.clientX > rect.left + rect.width / 2;
      return { kind: 'area', anchorId: areaId, after, mark: section, cls: after ? 'drop-after' : 'drop-before' };
    }

    // A tile. Unsorted keeps no order of its own: a drop there unsorts it.
    if (areaId === UNSORTED) return { kind: 'tile', areaId, anchor: null, after: false, mark: section, cls: 'drop-into' };
    const tile = el?.closest?.<HTMLElement>('.pb-tile');
    if (tile && tile.dataset.path === this.dragId) return null;
    if (!tile || el?.closest?.('.pb-area-head')) {
      // The head or the area's empty space: append.
      return { kind: 'tile', areaId, anchor: null, after: false, mark: section, cls: 'drop-into' };
    }
    const rect = tile.getBoundingClientRect();
    const after = tile.classList.contains('wide')
      ? e.clientY > rect.top + rect.height / 2
      : e.clientX > rect.left + rect.width / 2;
    return { kind: 'tile', areaId, anchor: tile.dataset.path ?? null, after, mark: tile, cls: after ? 'drop-after' : 'drop-before' };
  }

  private dropTile(path: string, areaId: string, anchor: string | null, after: boolean): void {
    const project = this.projectByPath(path);
    if (!project) return;
    this.placeProject(path, areaId, anchor, after);
    this.changed();
    rlog('info', '[BOARD] tile moved', { via: 'drag', unsorted: areaId === UNSORTED });
    announce(`Moved ${project.name} to ${areaId === UNSORTED ? 'Unsorted' : this.themeById(areaId)?.name ?? 'a theme'}`);
  }

  private dropArea(id: string, anchorId: string, after: boolean): void {
    const themes = this.layout.themes;
    const from = themes.findIndex((t) => t.id === id);
    if (from === -1) return;
    const [theme] = themes.splice(from, 1);
    const at = themes.findIndex((t) => t.id === anchorId);
    themes.splice(at === -1 ? themes.length : after ? at + 1 : at, 0, theme);
    this.changed();
    rlog('info', '[BOARD] theme moved', { via: 'drag' });
    announce(`Moved ${theme.name} to position ${themes.indexOf(theme) + 1} of ${themes.length}`);
  }

  private clearDropMarks(): void {
    this.areasEl.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-into'));
  }

  /** The drag is over (dropped, or cancelled): catch up on anything held back. */
  private endDrag(): void {
    if (!this.dragKind) return;
    this.dragKind = null;
    this.dragId = null;
    this.clearDropMarks();
    this.areasEl.querySelectorAll('.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
    this.release();
  }

  // ── Area menu: rename, tint, move, delete ──

  private showAreaMenu(theme: BoardTheme, x: number, y: number, returnTo: HTMLElement, viaKeyboard: boolean): void {
    const index = this.layout.themes.indexOf(theme);
    this.contextMenu.show(x, y, [
      { label: 'Rename…', action: () => this.startRename(theme.id, false) },
      { label: 'Tint…', action: () => this.showTintMenu(theme, x, y, returnTo, viaKeyboard) },
      { label: 'Move left', disabled: index <= 0, action: () => this.moveTheme(theme, -1) },
      { label: 'Move right', disabled: index >= this.layout.themes.length - 1, action: () => this.moveTheme(theme, 1) },
      { separator: true as const },
      { label: 'Delete theme…', action: () => { this.deleteTheme(theme).catch((err) => rlog('error', '[BOARD] delete failed', String(err))); } },
    ], returnTo, viaKeyboard);
  }

  private showTintMenu(theme: BoardTheme, x: number, y: number, returnTo: HTMLElement, viaKeyboard: boolean): void {
    const label = (t: BoardTint) => (t === 'none' ? 'None' : t[0].toUpperCase() + t.slice(1));
    this.contextMenu.show(x, y, BOARD_TINTS.map((tint) => ({
      label: `${tint === theme.tint ? '✓ ' : ''}${label(tint)}`,
      action: () => {
        // The layout may have been replaced while the menu was open: change
        // the theme it holds now, by id.
        const current = this.themeById(theme.id);
        if (!current) return;
        current.tint = tint;
        this.changed();
        this.render();
        announce(`${current.name} tint set to ${label(tint)}`);
      },
    })), returnTo, viaKeyboard);
  }

  private moveTheme(menuTheme: BoardTheme, direction: -1 | 1): void {
    const themes = this.layout.themes;
    // By id: the layout may have been replaced while the menu was open.
    const from = themes.findIndex((t) => t.id === menuTheme.id);
    const theme = themes[from];
    const to = from + direction;
    if (from === -1 || to < 0 || to >= themes.length) return;
    [themes[from], themes[to]] = [themes[to], themes[from]];
    this.changed();
    this.render();
    this.areasEl.querySelector<HTMLElement>(`[data-area-menu="${CSS.escape(theme.id)}"]`)?.focus();
    rlog('info', '[BOARD] theme moved', { via: 'menu', direction });
    announce(`Moved ${theme.name} ${direction < 0 ? 'left' : 'right'}`);
  }

  private async deleteTheme(theme: BoardTheme): Promise<void> {
    const shown = this.areas().find((a) => a.id === theme.id)?.projects.length ?? 0;
    if (shown > 0) {
      this.editing++;
      let ok = false;
      try {
        ok = await this.confirmDialog.confirm({
          title: 'Delete theme?',
          message: `"${theme.name}" will be removed from the board. Its ${shown === 1 ? 'project moves' : `${shown} projects move`} to Unsorted; no folder is touched.`,
          confirmLabel: 'Delete',
        });
      } finally {
        this.editing--;
      }
      if (!ok) {
        this.release();
        return;
      }
    }
    this.layout.themes = this.layout.themes.filter((t) => t.id !== theme.id);
    this.changed();
    this.release();
    rlog('info', '[BOARD] theme deleted', { projects: shown });
    announce(`Deleted ${theme.name}${shown ? '; its projects are in Unsorted' : ''}`);
  }

  /** Inline rename of an area's name. A new theme cancelled with Esc is removed. */
  private startRename(themeId: string, isNew: boolean): void {
    const theme = this.themeById(themeId);
    const section = this.areasEl.querySelector<HTMLElement>(`.pb-area[data-area-id="${CSS.escape(themeId)}"]`);
    const nameEl = section?.querySelector<HTMLElement>('.pb-area-name');
    const head = section?.querySelector<HTMLElement>('.pb-area-head');
    if (!theme || !nameEl || !head) return;
    this.editing++;
    head.draggable = false;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pb-input pb-rename';
    input.value = theme.name;
    input.maxLength = DEFAULTS.BOARD_THEME_NAME_MAX_CHARS;
    input.spellcheck = false;
    input.setAttribute('aria-label', isNew ? 'New theme name' : `Rename ${theme.name}`);
    nameEl.hidden = true;
    nameEl.after(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      this.editing--;
      const name = input.value.replace(/\s+/g, ' ').trim();
      input.remove();
      nameEl.hidden = false;
      if (commit && name && name !== theme.name) {
        theme.name = name;
        this.changed();
        announce(isNew ? `Added theme ${name}` : `Renamed to ${name}`);
      } else if (!commit && isNew) {
        this.layout.themes = this.layout.themes.filter((t) => t.id !== theme.id);
        this.changed();
        announce('New theme cancelled');
      } else if (isNew) {
        announce(`Added theme ${theme.name}`);
      }
      this.release();
      this.areasEl.querySelector<HTMLElement>(`[data-area-menu="${CSS.escape(theme.id)}"]`)?.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  // ── Tile menu: open, wide, note, move ──

  private showTileMenu(project: BoardProject, x: number, y: number, returnTo: HTMLElement, viaKeyboard: boolean): void {
    const area = this.areaOf(project.path);
    const pos = area ? area.projects.findIndex((p) => p.path === project.path) : -1;
    const sorted = !!area && area.id !== UNSORTED;
    const wide = !!this.layout.tiles[project.path]?.wide;
    this.contextMenu.show(x, y, [
      { label: 'Open', disabled: !!project.missing, action: () => this.openProject(project) },
      ...(project.subProjects.length === 0
        ? [{ label: wide ? 'Make narrow' : 'Make wide', action: () => this.setWide(project, !wide) }]
        : []),
      { label: 'Note…', action: () => this.startNote(project) },
      { label: 'Move to…', action: () => this.showMoveToMenu(project, x, y, returnTo, viaKeyboard) },
      ...(sorted
        ? [
            { label: 'Move earlier', disabled: pos <= 0, action: () => this.moveTile(project, -1) },
            { label: 'Move later', disabled: !area || pos >= area.projects.length - 1, action: () => this.moveTile(project, 1) },
          ]
        : []),
    ], returnTo, viaKeyboard);
  }

  private showMoveToMenu(project: BoardProject, x: number, y: number, returnTo: HTMLElement, viaKeyboard: boolean): void {
    const current = this.areaOf(project.path)?.id;
    this.contextMenu.show(x, y, [
      ...this.layout.themes.map((theme) => ({
        label: theme.name,
        disabled: theme.id === current,
        action: () => this.moveTo(project, theme.id),
      })),
      ...(current !== UNSORTED ? [{ label: 'Unsorted', action: () => this.moveTo(project, UNSORTED) }] : []),
      { separator: true as const },
      {
        label: 'New theme…',
        action: () => {
          const theme = this.createTheme();
          if (!theme) return;
          this.placeProject(project.path, theme.id, null, false);
          this.changed();
          this.render();
          this.startRename(theme.id, true);
        },
      },
    ], returnTo, viaKeyboard);
  }

  private moveTo(project: BoardProject, areaId: string): void {
    this.placeProject(project.path, areaId, null, false);
    this.changed();
    this.render();
    this.tileButton(project.path)?.focus();
    rlog('info', '[BOARD] tile moved', { via: 'menu', unsorted: areaId === UNSORTED });
    announce(`Moved ${project.name} to ${areaId === UNSORTED ? 'Unsorted' : this.themeById(areaId)?.name ?? 'a theme'}`);
  }

  private moveTile(project: BoardProject, direction: -1 | 1): void {
    const area = this.areaOf(project.path);
    if (!area || area.id === UNSORTED) return;
    const pos = area.projects.findIndex((p) => p.path === project.path);
    const neighbour = area.projects[pos + direction];
    if (!neighbour) return;
    this.placeProject(project.path, area.id, neighbour.path, direction > 0);
    this.changed();
    this.render();
    this.tileButton(project.path)?.focus();
    rlog('info', '[BOARD] tile moved', { via: 'menu', direction });
    announce(`Moved ${project.name} ${direction < 0 ? 'earlier' : 'later'}, position ${pos + direction + 1} of ${area.projects.length}`);
  }

  private setTileOptions(path: string, change: { wide?: boolean; note?: string }): void {
    const next = { ...this.layout.tiles[path], ...change };
    if (!next.wide) delete next.wide;
    if (!next.note) delete next.note;
    if (Object.keys(next).length === 0) delete this.layout.tiles[path];
    else this.layout.tiles[path] = next;
    this.changed();
  }

  private setWide(project: BoardProject, wide: boolean): void {
    this.setTileOptions(project.path, { wide });
    this.render();
    this.tileButton(project.path)?.focus();
    announce(`${project.name} is ${wide ? 'wide' : 'narrow'}`);
  }

  private startNote(project: BoardProject): void {
    const li = this.areasEl.querySelector<HTMLElement>(`.pb-tile[data-path="${CSS.escape(project.path)}"]`);
    const main = li?.querySelector<HTMLElement>('.pb-tile-main');
    if (!li || !main) return;
    this.editing++;
    li.draggable = false;
    const noteEl = main.querySelector<HTMLElement>('.pb-note');
    if (noteEl) noteEl.hidden = true;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pb-input pb-note-input';
    input.value = this.layout.tiles[project.path]?.note ?? '';
    input.maxLength = DEFAULTS.BOARD_NOTE_MAX_CHARS;
    input.spellcheck = false;
    input.placeholder = 'A one-line note';
    input.setAttribute('aria-label', `Note for ${project.name}`);
    main.after(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      this.editing--;
      const note = input.value.replace(/\s+/g, ' ').trim().slice(0, DEFAULTS.BOARD_NOTE_MAX_CHARS);
      input.remove();
      if (noteEl) noteEl.hidden = false;
      li.draggable = true;
      if (commit && note !== (this.layout.tiles[project.path]?.note ?? '')) {
        this.setTileOptions(project.path, { note });
        announce(note ? `Note saved for ${project.name}` : `Note removed from ${project.name}`);
      }
      this.release();
      this.tileButton(project.path)?.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  // ── + Theme ──

  private createTheme(): BoardTheme | null {
    if (this.layout.themes.length >= DEFAULTS.BOARD_THEMES_MAX) {
      announce(`The board holds at most ${DEFAULTS.BOARD_THEMES_MAX} themes`, 'assertive');
      return null;
    }
    const ids = new Set(this.layout.themes.map((t) => t.id));
    let id = '';
    do id = `theme-${Math.random().toString(36).slice(2, 10)}`;
    while (ids.has(id) || !/^[a-z0-9-]{1,40}$/.test(id));
    const used = new Set(this.layout.themes.map((t) => t.tint));
    const tint = TINTS.find((t) => !used.has(t)) ?? TINTS[this.layout.themes.length % TINTS.length];
    const theme: BoardTheme = { id, name: 'New theme', tint, projects: [] };
    this.layout.themes.push(theme);
    rlog('info', '[BOARD] theme added', { tint });
    return theme;
  }

  private addTheme(): void {
    if (this.isBusy()) return;
    const theme = this.createTheme();
    if (!theme) return;
    this.changed();
    this.render();
    this.startRename(theme.id, true);
  }

  // ── + Project ──

  private async pickProject(): Promise<void> {
    // One picker at a time: a double click must not open two forms.
    if (this.isBusy() || this.picking) return;
    this.picking = true;
    let path: string | null;
    try {
      path = await window.patton.board.pickFolder();
    } catch (err) {
      rlog('error', '[BOARD] pick failed', String(err));
      announce('Could not open the folder picker', 'assertive');
      return;
    } finally {
      this.picking = false;
    }
    if (!path || this.disposed) return;
    if (this.isBusy()) {
      rlog('info', '[BOARD] picked folder dropped', { reason: 'board busy' });
      return;
    }
    rlog('info', '[BOARD] picked a folder');
    this.showAddForm(path);
  }

  private showAddForm(path: string): void {
    this.editing++;
    this.formEl.replaceChildren();
    const form = document.createElement('form');
    form.className = 'pboard-add';
    form.setAttribute('aria-label', 'Add a project');

    const pathEl = document.createElement('span');
    pathEl.className = 'pboard-add-path';
    pathEl.textContent = path;

    const nameLabel = document.createElement('label');
    nameLabel.textContent = 'Name ';
    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'pb-input pboard-add-name';
    name.value = folderName(path).slice(0, DEFAULTS.BOARD_PROJECT_NAME_MAX_CHARS);
    name.maxLength = DEFAULTS.BOARD_PROJECT_NAME_MAX_CHARS;
    name.spellcheck = false;
    nameLabel.appendChild(name);

    const themeLabel = document.createElement('label');
    themeLabel.textContent = 'Theme ';
    const select = document.createElement('select');
    select.className = 'pboard-add-select';
    for (const theme of this.layout.themes) select.add(new Option(theme.name, theme.id));
    select.add(new Option('Unsorted', ''));
    select.value = this.layout.themes[0]?.id ?? '';
    themeLabel.appendChild(select);

    const add = document.createElement('button');
    add.type = 'submit';
    add.className = 'pboard-btn pboard-add-submit';
    add.textContent = 'Add';
    const cancel = this.button('Cancel', 'pboard-btn pboard-add-cancel', () => close());
    const error = document.createElement('p');
    error.className = 'pboard-add-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;

    form.append(pathEl, nameLabel, themeLabel, add, cancel, error);
    this.formEl.appendChild(form);
    this.formEl.hidden = false;
    name.focus();
    name.select();

    let closed = false;
    const close = (payload?: BoardPayload) => {
      if (closed) return;
      closed = true;
      this.editing--;
      this.formEl.hidden = true;
      this.formEl.replaceChildren();
      if (payload) {
        // Fresher than anything held back while the form was open.
        this.heldPayload = null;
        this.heldLayout = null;
        this.adoptPayload(payload);
      }
      this.release();
    };
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        this.searchInput.focus();
      }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const label = name.value.replace(/\s+/g, ' ').trim();
      if (!label) {
        error.textContent = 'Give the project a name.';
        error.hidden = false;
        return;
      }
      add.disabled = true;
      const themeId = select.value || undefined;
      this.flushSave()
        .then(() => window.patton.board.addProject({ path, name: label, ...(themeId ? { themeId } : {}) }))
        .then((result) => {
          if (this.disposed) return;
          if (closed) {
            // Cancelled while the add was on its way: the row was still
            // written, so show it rather than drop the fresh board.
            if (!result.error) {
              rlog('info', '[BOARD] project added after the form closed', { themed: Boolean(themeId) });
              this.setPayload(result);
              announce(`Added ${label}`);
            }
            return;
          }
          if (result.error) {
            rlog('warn', '[BOARD] add refused', { reason: result.error });
            error.textContent = `Could not add the project: ${result.error}.`;
            error.hidden = false;
            add.disabled = false;
            name.focus();
            return;
          }
          rlog('info', '[BOARD] project added', { themed: Boolean(themeId) });
          close(result);
          announce(`Added ${label}`);
          this.tileButton(path)?.focus();
        })
        .catch((err) => {
          rlog('error', '[BOARD] add failed', String(err));
          if (closed || this.disposed) return;
          error.textContent = 'Could not add the project: something went wrong saving it.';
          error.hidden = false;
          add.disabled = false;
        });
    });
  }

  // ── Helpers ──

  private button(text: string, className: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  }
}
