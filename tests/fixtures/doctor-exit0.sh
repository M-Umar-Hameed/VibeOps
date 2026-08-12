#!/bin/sh
# POSIX counterpart of doctor-exit0.cmd. Spawned directly as cmd[0], so it needs
# a shebang and mode 755; git records the exec bit.
echo "fake-agent v1.0.0 (doctor exit0 fixture)"
exit 0
