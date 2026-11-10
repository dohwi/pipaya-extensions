// The commands guard refuses, grouped by the toggle that turns each group off (see package.json `pipaya.settings`).
// Kept apart from index.ts so they can be tested without a server.
const ROOT = String.raw`(?:\/|\/\*|~|~\/|~\/\*|\$HOME|\$HOME\/\*?)`;

/** A group of rules the user can switch off on its own. The key is the setting key. */
export type RuleGroup = "wipe" | "disk" | "fork" | "permissions";

export interface Rule {
	group: RuleGroup;
	re: RegExp;
	why: string;
}

export const RULES: Rule[] = [
	{ group: "wipe", re: new RegExp(String.raw`\brm\s+(?:-{1,2}[\w-]+\s+)*-[a-zA-Z]*(?:[rR][a-zA-Z]*f|f[a-zA-Z]*[rR])[a-zA-Z]*\s+(?:-{1,2}[\w-]+\s+)*["']?${ROOT}["']?(?:\s|;|&|\||$)`), why: "deletes the whole disk or home directory" },
	{ group: "wipe", re: /\brm\s+.*--no-preserve-root\b/, why: "deletes the whole disk" },
	{ group: "disk", re: /\bmkfs(?:\.\w+)?\b/, why: "formats a disk" },
	{ group: "disk", re: /\bdd\b[^|;&]*\bof=\/dev\/(?:sd|nvme|hd|vd|disk|mmcblk)/, why: "overwrites a disk" },
	{ group: "disk", re: />\s*\/dev\/(?:sd|nvme|hd|vd|disk|mmcblk)\w*/, why: "overwrites a disk" },
	{ group: "fork", re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: "fork bomb" },
	{ group: "permissions", re: new RegExp(String.raw`\bchmod\s+(?:-[a-zA-Z]*R[a-zA-Z]*\s+)\d{3,4}\s+${ROOT}(?:\s|$)`), why: "changes permissions of the whole disk" },
	{ group: "permissions", re: new RegExp(String.raw`\bchown\s+(?:-[a-zA-Z]*R[a-zA-Z]*\s+)\S+\s+${ROOT}(?:\s|$)`), why: "changes the owner of the whole disk" },
];

export const GROUPS: readonly RuleGroup[] = ["wipe", "disk", "fork", "permissions"];

/** Every group on: what an unset setting means, so a fresh install guards everything. */
export const ALL_ON: Record<RuleGroup, boolean> = { wipe: true, disk: true, fork: true, permissions: true };

/** The groups that are on, from the saved settings (only `false` turns one off). */
export function enabledGroups(settings: unknown): Record<RuleGroup, boolean> {
	const saved = settings && typeof settings === "object" ? (settings as Record<string, unknown>) : {};
	return Object.fromEntries(GROUPS.map((g) => [g, saved[g] !== false])) as Record<RuleGroup, boolean>;
}

/** Why `command` is refused, or null when it may run. `groups` defaults to every group on. */
export function refusal(command: string, groups: Partial<Record<RuleGroup, boolean>> = ALL_ON): string | null {
	for (const rule of RULES) if (groups[rule.group] !== false && rule.re.test(command)) return rule.why;
	return null;
}
