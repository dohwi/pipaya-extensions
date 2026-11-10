import { expect, test } from "bun:test";
import { refusal } from "../rules.ts";

/**
 * Guard runs on the agent's path, synchronously, inside `tool_call`: a pattern that backtracks exponentially would
 * freeze the whole server on one long command. These cases are the shapes that did it (nested quantifiers over
 * overlapping flag classes); each must stay well under a millisecond.
 */
const BUDGET_MS = 50;

const time = (command: string) => {
	const at = performance.now();
	refusal(command);
	return performance.now() - at;
};

test("a long run of flags does not blow up", () => {
	const flags = (n: number) => Array.from({ length: n }, (_, i) => `--flag${i}`).join(" ");
	const commands = [
		`chmod ${flags(30)} 777 /`,
		`chmod ${flags(60)} 777 /`,
		`chown ${flags(30)} user /`,
		`chown ${flags(60)} user /`,
		`chmod ${flags(40)} 777 ./build`,
		`chown ${flags(40)} user ./data`,
		`chmod ${"-R ".repeat(80)}777 /`,
		`chown ${"-R ".repeat(80)}me /`,
		`rm ${"-f ".repeat(80)}-rf /`,
		// `rm` was the worst of the three: its flag run overlapped the combined `-rf` it then required.
		`rm ${flags(30)} -rf ./x`,
		`rm ${flags(60)} -rf ./x`,
		`rm ${flags(40)} -r -f ./x`,
		`rm ${"-rf ".repeat(60)}x`,
	];
	for (const command of commands) expect(time(command)).toBeLessThan(BUDGET_MS);
});


test("a long command that matches nothing stays cheap", () => {
	const noise = "x".repeat(20_000);
	for (const command of [`chmod ${noise}`, `chown ${noise}`, `rm ${noise}`, `${noise} /`]) expect(time(command)).toBeLessThan(BUDGET_MS);
});
