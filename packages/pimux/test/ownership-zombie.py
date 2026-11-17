# Synthetic process-state fixture; the parent deliberately waits to reap its child.
import os
import sys

pid = os.fork()
if pid == 0:
    os._exit(0)
print(pid, flush=True)
sys.stdin.readline()
os.waitpid(pid, 0)
