// Guard: refuses obviously destructive shell commands before they run (see rules.ts).
// Which families are refused is up to the user: the toggles in package.json `pipaya.settings` are read on every call,
// so a change in the settings page applies to the next command without a reload. If they cannot be read, every
// family stays on (see `groupsFrom`): a guard that loses its settings must not go quiet.
import { groupsFrom, refusal } from "./rules.ts";

export default (pi: any) => {
	pi.on("tool_call", (e: any) => {
		if (e.toolName !== "bash") return undefined;
		const why = refusal(String(e.args?.command ?? ""), groupsFrom(() => pi.settings.get()));
		return why ? { block: true, reason: `refused by guard: ${why}` } : undefined;
	});
};
