# guard

Server extension. Blocks destructive commands in the `bash` tool before they run and tells the agent why:

- deleting `/`, `/*`, `~` or `$HOME` (`rm -rf`, any flag order, `--no-preserve-root`)
- formatting or overwriting a disk (`mkfs`, `dd of=/dev/sdX`, `> /dev/nvme…`)
- fork bombs
- `chmod -R` / `chown -R` on `/` or `~`

Ordinary deletes (`rm -rf ./build`, `rm -rf /tmp/x`) pass. The rules are in `rules.ts` (tested in `tests/`).
It only hooks `tool_call` and touches no files or network.
