// Guard: refuses obviously destructive shell commands before they run (see rules.ts).
// Which families are refused is up to the user: the toggles in package.json `pipaya.settings` are read on every call,
// so a change in the settings page applies to the next command without a reload.
import { enabledGroups, refusal } from "./rules.ts";

export default (pi: any) => {
	pi.on("tool_call", (e: any) => {
		if (e.toolName !== "bash") return undefined;
		const why = refusal(String(e.args?.command ?? ""), enabledGroups(pi.settings.get()));
		return why ? { block: true, reason: `refused by guard: ${why}` } : undefined;
	});
};
