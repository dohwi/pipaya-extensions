// The commands guard refuses, grouped by the toggle that turns each group off (see package.json `pipaya.settings`).
// Kept apart from index.ts so they can be tested without a server.
//
// Every pattern here is matched against a command the user's agent wrote, on the agent's path, so it must stay linear:
// no nested quantifiers over overlapping character classes (see tests/redos.test.ts). A rule that needs more than one
// condition (`rm`/`chmod`/`chown`: the whole disk *and* a recursive flag) keeps them in `re` and `needs` instead of
// nesting them: a flag run and the flag the rule requires used to overlap, so long commands backtracked exponentially.
const ROOT = String.raw`(?:\/|\/\*|~|~\/|~\/\*|\$HOME|\$HOME\/\*?)`;
/** A recursive flag as a command word: `-R`, `-fR`, `-Rf`, `-r`, `--recursive`. Matched on its own, never nested. */
const RECURSIVE = /(?:^|\s)(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?=\s|$)/;
/** A force flag as a command word: `-f`, `-Rf`, `--force`. */
const FORCE = /(?:^|\s)(?:-[a-zA-Z]*f[a-zA-Z]*|--force)(?=\s|$)/;
/** Everything up to the target, inside one command: no separators, so a rule cannot run past `;` or `|`. */
const ARGS = String.raw`[^;|&\n]*`;

/** A group of rules the user can switch off on its own. The key is the setting key. */
export type RuleGroup = "wipe" | "disk" | "fork" | "permissions";

export interface Rule {
	group: RuleGroup;
	re: RegExp;
	/** Also required, each checked on its own so no pattern has to nest quantifiers. */
	needs?: readonly RegExp[];
	why: string;
}

export const RULES: Rule[] = [
	// `rm` needs both a recursive and a force flag, in any order and either combined or separate (`-rf`, `-r -f`,
	// `--recursive --force`).
	{ group: "wipe", re: new RegExp(String.raw`\brm\b${ARGS}\s["']?${ROOT}["']?(?:\s|;|&|\||$)`), needs: [RECURSIVE, FORCE], why: "deletes the whole disk or home directory" },
	{ group: "wipe", re: /\brm\s+.*--no-preserve-root\b/, why: "deletes the whole disk" },
	{ group: "disk", re: /\bmkfs(?:\.\w+)?\b/, why: "formats a disk" },
	{ group: "disk", re: /\bdd\b[^|;&]*\bof=\/dev\/(?:sd|nvme|hd|vd|disk|mmcblk)/, why: "overwrites a disk" },
	{ group: "disk", re: />\s*\/dev\/(?:sd|nvme|hd|vd|disk|mmcblk)\w*/, why: "overwrites a disk" },
	{ group: "fork", re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: "fork bomb" },
	// The recursive flag is required (a plain `chmod 644 /etc/x` is ordinary) and may sit on either side of the
	// mode/owner, so it is a separate `needs` check rather than a second pattern over the same characters.
	{ group: "permissions", re: new RegExp(String.raw`\bchmod\b${ARGS}\s${ROOT}(?:\s|;|&|\||$)`), needs: [RECURSIVE], why: "changes permissions of the whole disk" },
	{ group: "permissions", re: new RegExp(String.raw`\bchown\b${ARGS}\s${ROOT}(?:\s|;|&|\||$)`), needs: [RECURSIVE], why: "changes the owner of the whole disk" },
];

export const GROUPS: readonly RuleGroup[] = ["wipe", "disk", "fork", "permissions"];

/** Every group on: what an unset setting means, so a fresh install guards everything. Frozen: it is a default, not state. */
export const ALL_ON: Readonly<Record<RuleGroup, boolean>> = Object.freeze(
	Object.fromEntries(GROUPS.map((g) => [g, true])) as Record<RuleGroup, boolean>,
);

/** The groups that are on, from the saved settings (only `false` turns one off). */
export function enabledGroups(settings: unknown): Record<RuleGroup, boolean> {
	const saved = settings && typeof settings === "object" ? (settings as Record<string, unknown>) : {};
	return Object.fromEntries(GROUPS.map((g) => [g, saved[g] !== false])) as Record<RuleGroup, boolean>;
}

/**
 * The groups to enforce, read through `read` (normally `pi.settings.get`). A guard that cannot see its own settings
 * must not go quiet: any failure means every group stays on.
 */
export function groupsFrom(read: () => unknown): Readonly<Record<RuleGroup, boolean>> {
	try {
		return enabledGroups(read());
	} catch {
		return ALL_ON;
	}
}

/** Why `command` is refused, or null when it may run. `groups` defaults to every group on. */
export function refusal(command: string, groups: Partial<Record<RuleGroup, boolean>> = ALL_ON): string | null {
	for (const rule of RULES) {
		if (groups[rule.group] === false) continue;
		if (!rule.re.test(command)) continue;
		// `needs` looks at the whole command, not just the matching segment: splitting on `;`/`|`/`&` would break the
		// fork-bomb rule, which is made of them. The cost is an over-block in the safe direction — `chmod 755 / && ls -R`
		// counts the `-R` of the second command — never a miss.
		if (rule.needs?.some((need) => !need.test(command))) continue;
		return rule.why;
	}
	return null;
}
