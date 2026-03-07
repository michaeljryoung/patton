import type { Pane } from './pane';

export type SplitDirection = 'vertical' | 'horizontal';

export interface SplitNode {
  type: 'split';
  direction: SplitDirection;
  ratio: number;
  children: [SplitTreeNode, SplitTreeNode];
}

export type SplitTreeNode = Pane | SplitNode;

export function isPane(node: SplitTreeNode): node is Pane {
  return !('type' in node && node.type === 'split');
}

export function isSplitNode(node: SplitTreeNode): node is SplitNode {
  return 'type' in node && node.type === 'split';
}

/** Replace a pane with a SplitNode containing the original + a new pane. */
export function splitPane(
  tree: SplitTreeNode,
  target: Pane,
  newPane: Pane,
  direction: SplitDirection,
): SplitTreeNode {
  if (isPane(tree)) {
    if (tree === target) {
      return {
        type: 'split',
        direction,
        ratio: 0.5,
        children: [tree, newPane],
      };
    }
    return tree;
  }

  // Recurse into children — short-circuit after finding target
  const newLeft = splitPane(tree.children[0], target, newPane, direction);
  if (newLeft !== tree.children[0]) {
    return { ...tree, children: [newLeft, tree.children[1]] };
  }

  const newRight = splitPane(tree.children[1], target, newPane, direction);
  if (newRight !== tree.children[1]) {
    return { ...tree, children: [tree.children[0], newRight] };
  }

  return tree;
}

/** Remove a pane from the tree. Returns the new root (or null if tree is now empty). */
export function closePane(
  tree: SplitTreeNode,
  target: Pane,
): SplitTreeNode | null {
  if (isPane(tree)) {
    return tree === target ? null : tree;
  }

  const left = tree.children[0];
  const right = tree.children[1];

  // If one child is the target pane, return the other
  if (isPane(left) && left === target) return right;
  if (isPane(right) && right === target) return left;

  // Recurse
  const newLeft = closePane(left, target);
  const newRight = closePane(right, target);

  if (newLeft === null) return newRight;
  if (newRight === null) return newLeft;

  if (newLeft !== left || newRight !== right) {
    return { ...tree, children: [newLeft, newRight] };
  }
  return tree;
}

/** Swap two panes in the tree (mutates in place). Returns true if swap succeeded. */
export function swapPanes(
  tree: SplitTreeNode,
  paneA: Pane,
  paneB: Pane,
): boolean {
  if (paneA === paneB) return false;

  // Find both parents and their child indices
  type Location = { parent: SplitNode; index: 0 | 1 };
  function findLocation(node: SplitTreeNode, target: Pane): Location | null {
    if (isPane(node)) return null;
    if (node.children[0] === target) return { parent: node, index: 0 };
    if (node.children[1] === target) return { parent: node, index: 1 };
    return findLocation(node.children[0], target) || findLocation(node.children[1], target);
  }

  // Handle case where one pane IS the root (single pane can't be in a split)
  if (isPane(tree)) return false;

  const locA = findLocation(tree, paneA);
  const locB = findLocation(tree, paneB);
  if (!locA || !locB) return false;

  // Swap references in their parent nodes
  locA.parent.children[locA.index] = paneB;
  locB.parent.children[locB.index] = paneA;
  return true;
}

/** Get all panes in the tree (left-to-right / top-to-bottom order). */
export function getAllPanes(tree: SplitTreeNode): Pane[] {
  if (isPane(tree)) return [tree];
  return [...getAllPanes(tree.children[0]), ...getAllPanes(tree.children[1])];
}

/** Find the parent SplitNode of a given node, or null if it's the root. */
export function findParent(
  tree: SplitTreeNode,
  target: SplitTreeNode,
): SplitNode | null {
  if (isPane(tree)) return null;
  if (tree.children[0] === target || tree.children[1] === target) return tree;

  const leftResult = findParent(tree.children[0], target);
  if (leftResult) return leftResult;
  return findParent(tree.children[1], target);
}

/**
 * Find the pane in a given direction from the focused pane.
 * Direction map:
 *   - 'left'/'right' applies to vertical splits
 *   - 'up'/'down' applies to horizontal splits
 */
export function findPaneInDirection(
  tree: SplitTreeNode,
  focused: Pane,
  direction: 'up' | 'down' | 'left' | 'right',
): Pane | null {
  // Get the bounding rects for all panes
  const panes = getAllPanes(tree);
  if (panes.length <= 1) return null;

  const focusedRect = focused.element.getBoundingClientRect();
  const focusCenterX = focusedRect.left + focusedRect.width / 2;
  const focusCenterY = focusedRect.top + focusedRect.height / 2;

  let bestPane: Pane | null = null;
  let bestDistance = Infinity;

  for (const pane of panes) {
    if (pane === focused) continue;

    const rect = pane.element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    // Check if pane is in the correct direction
    let isInDirection = false;
    let distance = 0;

    switch (direction) {
      case 'left':
        isInDirection = centerX < focusCenterX;
        distance = Math.abs(focusCenterX - centerX) + Math.abs(focusCenterY - centerY) * 0.5;
        break;
      case 'right':
        isInDirection = centerX > focusCenterX;
        distance = Math.abs(centerX - focusCenterX) + Math.abs(focusCenterY - centerY) * 0.5;
        break;
      case 'up':
        isInDirection = centerY < focusCenterY;
        distance = Math.abs(focusCenterY - centerY) + Math.abs(focusCenterX - centerX) * 0.5;
        break;
      case 'down':
        isInDirection = centerY > focusCenterY;
        distance = Math.abs(centerY - focusCenterY) + Math.abs(focusCenterX - centerX) * 0.5;
        break;
    }

    if (isInDirection && distance < bestDistance) {
      bestDistance = distance;
      bestPane = pane;
    }
  }

  return bestPane;
}
