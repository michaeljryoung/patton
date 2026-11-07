import type { BoardLayout } from './types';

/**
 * Give each of `paths` the theme it has in `source`, in `target`, when
 * `target` places it in no theme and has a theme with that id. Used for
 * projects added since a layout was made: a board (or a save) that had not
 * seen the add can't have meant to leave the new tile unsorted, so its copy
 * must not drop the placement the add made. Mutates `target`; returns how
 * many paths were placed.
 */
export function keepPlacements(target: BoardLayout, source: BoardLayout, paths: readonly string[]): number {
  let placed = 0;
  for (const path of paths) {
    if (target.themes.some((t) => t.projects.includes(path))) continue;
    const from = source.themes.find((t) => t.projects.includes(path));
    const to = from ? target.themes.find((t) => t.id === from.id) : undefined;
    if (!to) continue;
    to.projects.push(path);
    placed++;
  }
  return placed;
}
