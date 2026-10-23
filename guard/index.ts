// Guard: refuses obviously destructive shell commands before they run.
export default (pi: any) => {
	const DENY = [/\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~)(\s|$)/, /\bmkfs(\.\w+)?\b/, /:\(\)\s*\{\s*:\|:&\s*\};:/];
	pi.on("tool_call", (e: any) => {
		if (e.toolName !== "bash") return undefined;
		const cmd = String(e.args?.command ?? "");
		return DENY.some((r) => r.test(cmd)) ? { block: true, reason: "refused by guard" } : undefined;
	});
};
