import { expect, test } from "bun:test";
import { refusal } from "../rules.ts";

test("refuses commands that wipe a disk or the home directory", () => {
	for (const cmd of [
		"rm -rf /", "rm -fr /", "rm -Rf /", "sudo rm -rf /", "rm -rf /*", "rm -rf ~", "rm -rf ~/", "rm -rf $HOME", "rm -rf -- /",
		"rm -rf --no-preserve-root /", "cd x && rm -rf / ; ls", "mkfs.ext4 /dev/sda1", "dd if=/dev/zero of=/dev/sda bs=1M",
		"cat x > /dev/nvme0n1", ":(){ :|:& };:", "chmod -R 777 /", "chown -R me /",
	]) expect(refusal(cmd)).not.toBeNull();
});

test("lets ordinary commands through", () => {
	for (const cmd of [
		"rm -rf ./build", "rm -rf /tmp/x", "rm -rf ~/project/dist", "rm file", "ls /", "dd if=a of=b", "chmod 644 /etc/x", "echo rm -rf",
		"rm -rf node_modules", "git rm -r --cached .",
	]) expect(refusal(cmd)).toBeNull();
});
