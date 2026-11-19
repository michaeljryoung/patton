// Limits on tab groups, shared by the renderer (tab-groups.ts) and main's
// session sanitiser (main/session-groups.ts).
export const GROUP_NAME_MAX = 60;
export const GROUP_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
export const MAX_GROUPS = 50;
