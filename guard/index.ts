// Guard: refuses obviously destructive shell commands before they run (see rules.ts).
import { refusal } from "./rules.ts";

export default (pi: any) => {
	pi.on("tool_call", (e: any) => {
		if (e.toolName !== "bash") return undefined;
		const why = refusal(String(e.args?.command ?? ""));
		return why ? { block: true, reason: `refused by guard: ${why}` } : undefined;
	});
};
