import { expect, test } from "bun:test";
import { ALL_ON, enabledGroups, groupsFrom, refusal } from "../rules.ts";

test("refuses commands that wipe a disk or the home directory", () => {
	for (const cmd of [
		"rm -rf /", "rm -fr /", "rm -Rf /", "sudo rm -rf /", "rm -rf /*", "rm -rf ~", "rm -rf ~/", "rm -rf $HOME", "rm -rf -- /",
		"rm -rf --no-preserve-root /", "cd x && rm -rf / ; ls", "mkfs.ext4 /dev/sda1", "dd if=/dev/zero of=/dev/sda bs=1M",
		"cat x > /dev/nvme0n1", ":(){ :|:& };:", "chmod -R 777 /", "chown -R me /",
	]) expect(refusal(cmd)).not.toBeNull();
});

test("rm counts a recursive and a force flag in any order and either combined or separate", () => {
	for (const cmd of [
		"rm -rf /", "rm -fr /", "rm -Rf /", "rm -rfv /", "rm -r -f /", "rm -f -r /", "rm -R -f /", "rm -v -r -f /",
		"rm --recursive --force /", "rm --force --recursive /", "rm -r -f ~", "rm -r -f $HOME",
	]) expect(refusal(cmd)).not.toBeNull();
});

test("lets ordinary commands through", () => {
	for (const cmd of [
		"rm -rf ./build", "rm -rf /tmp/x", "rm -rf ~/project/dist", "rm file", "ls /", "dd if=a of=b", "chmod 644 /etc/x", "echo rm -rf",
		"rm -rf node_modules", "git rm -r --cached .", "chmod 777 /", "chown me /", "chmod -R 777 ./build", "chown -R me /tmp/x",
	]) expect(refusal(cmd)).toBeNull();
});

test("the recursive flag counts on either side of the mode or owner", () => {
	for (const cmd of [
		"chmod -R 777 /", "chmod 777 -R /", "chmod --recursive 777 /", "chmod 777 --recursive /", "chmod -fR 777 /",
		"chown -R me /", "chown me -R /", "chown --recursive root:root /", "chown root:root --recursive /",
	]) expect(refusal(cmd)).not.toBeNull();
});

test("every rule belongs to a group that can be switched off", () => {
	expect(Object.keys(ALL_ON).sort()).toEqual(["disk", "fork", "permissions", "wipe"]);
});

test("an unset setting leaves its group on; only an explicit false turns it off", () => {
	expect(enabledGroups(undefined)).toEqual(ALL_ON);
	expect(enabledGroups({})).toEqual(ALL_ON);
	expect(enabledGroups({ wipe: "no", disk: 0, fork: null })).toEqual(ALL_ON);
	expect(enabledGroups({ wipe: false })).toEqual({ ...ALL_ON, wipe: false });
});

test("settings that cannot be read leave every group on", () => {
	expect(groupsFrom(() => ({ wipe: false }))).toEqual({ ...ALL_ON, wipe: false });
	expect(groupsFrom(() => { throw new Error("settings are not available"); })).toEqual(ALL_ON);
	expect(refusal("rm -rf /", groupsFrom(() => { throw new Error("settings are not available"); }))).not.toBeNull();
});

test("a group that is off lets its commands through and leaves the others alone", () => {
	const off = (key: keyof typeof ALL_ON) => ({ ...ALL_ON, [key]: false });
	expect(refusal("rm -rf /", off("wipe"))).toBeNull();
	expect(refusal("rm -rf /", off("disk"))).not.toBeNull();
	expect(refusal("mkfs.ext4 /dev/sda1", off("disk"))).toBeNull();
	expect(refusal(":(){ :|:& };:", off("fork"))).toBeNull();
	expect(refusal("chmod -R 777 /", off("permissions"))).toBeNull();
	expect(refusal("rm -rf ./build", off("wipe"))).toBeNull();
});
