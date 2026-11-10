# guard

Server extension. Blocks destructive commands in the `bash` tool before they run and tells the agent why:

- deleting `/`, `/*`, `~` or `$HOME` (`rm -rf`, any flag order, `--no-preserve-root`)
- formatting or overwriting a disk (`mkfs`, `dd of=/dev/sdX`, `> /dev/nvme…`)
- fork bombs
- `chmod -R` / `chown -R` on `/` or `~`

Ordinary deletes (`rm -rf ./build`, `rm -rf /tmp/x`) pass. The rules are in `rules.ts` (tested in `tests/`).

## Settings

Each of the four families above has its own toggle on the extension's page in Settings. All are on, also before
anything is saved; only turning one off lets its commands through. The toggles are read on every `bash` call, so a
change applies to the next command without reloading the extension.

It only hooks `tool_call` and touches no files or network.
