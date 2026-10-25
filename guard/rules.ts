// The commands guard refuses. Kept apart from index.ts so they can be tested without a server.
const ROOT = String.raw`(?:\/|\/\*|~|~\/|~\/\*|\$HOME|\$HOME\/\*?)`;
export const DENY: { re: RegExp; why: string }[] = [
	{ re: new RegExp(String.raw`\brm\s+(?:-{1,2}[\w-]+\s+)*-[a-zA-Z]*(?:[rR][a-zA-Z]*f|f[a-zA-Z]*[rR])[a-zA-Z]*\s+(?:-{1,2}[\w-]+\s+)*["']?${ROOT}["']?(?:\s|;|&|\||$)`), why: "deletes the whole disk or home directory" },
	{ re: /\brm\s+.*--no-preserve-root\b/, why: "deletes the whole disk" },
	{ re: /\bmkfs(?:\.\w+)?\b/, why: "formats a disk" },
	{ re: /\bdd\b[^|;&]*\bof=\/dev\/(?:sd|nvme|hd|vd|disk|mmcblk)/, why: "overwrites a disk" },
	{ re: />\s*\/dev\/(?:sd|nvme|hd|vd|disk|mmcblk)\w*/, why: "overwrites a disk" },
	{ re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: "fork bomb" },
	{ re: new RegExp(String.raw`\bchmod\s+(?:-[a-zA-Z]*R[a-zA-Z]*\s+)\d{3,4}\s+${ROOT}(?:\s|$)`), why: "changes permissions of the whole disk" },
	{ re: new RegExp(String.raw`\bchown\s+(?:-[a-zA-Z]*R[a-zA-Z]*\s+)\S+\s+${ROOT}(?:\s|$)`), why: "changes the owner of the whole disk" },
];

/** Why `command` is refused, or null when it may run. */
export function refusal(command: string): string | null {
	for (const rule of DENY) if (rule.re.test(command)) return rule.why;
	return null;
}
