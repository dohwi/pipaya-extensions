# guard

Server extension. Blocks `rm -rf /`, `rm -rf ~`, `mkfs` and fork bombs in the `bash` tool.
It only hooks `tool_call` and touches no files or network.
