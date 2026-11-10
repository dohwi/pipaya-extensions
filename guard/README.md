# guard

Server extension. Blocks destructive commands in the `bash` tool before they run and tells the agent why:

- deleting `/`, `/*`, `~` or `$HOME` (`rm -rf`, any flag order and either combined or separate: `-rf`, `-r -f`, `--recursive --force`; also `--no-preserve-root`)
- formatting or overwriting a disk (`mkfs`, `dd of=/dev/sdX`, `> /dev/nvme…`)
- fork bombs
- `chmod -R` / `chown -R` on `/` or `~`, with the flag before or after the mode/owner (`chmod -R 777 /`, `chmod 777 -R /`)

Ordinary deletes (`rm -rf ./build`, `rm -rf /tmp/x`) pass, and so does a non-recursive `chmod 644 /etc/x`.
The rules are in `rules.ts` (tested in `tests/`).

Every pattern stays linear: guard runs synchronously on the agent's path, so a command with a long run of flags must
not make it backtrack (`tests/redos.test.ts`). A rule that needs more than one condition (`rm`, `chmod`, `chown`)
keeps them in `re` and `needs` instead of nesting them.

## Settings

Each of the four families above has its own toggle on the extension's page in Settings. All are on, also before
anything is saved; only turning one off lets its commands through. The toggles are read on every `bash` call, so a
change applies to the next command without reloading the extension.

If the settings cannot be read at all (a broken store, an unavailable host), every family stays on: a guard that
loses its settings must not go quiet.

It only hooks `tool_call` and touches no files or network.
