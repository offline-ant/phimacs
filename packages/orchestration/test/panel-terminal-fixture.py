"""Stdlib terminal parity probe. Invoke through uv run --no-project python."""
import argparse
import json
import os
import select
import signal
import sys
import termios
import tty

parser = argparse.ArgumentParser()
parser.add_argument("--events")
parser.add_argument("--size")
args = parser.parse_args()
if args.size:
    fd = os.open(args.size, os.O_RDONLY | os.O_NOCTTY)
    try:
        size = os.get_terminal_size(fd)
        print(json.dumps({"rows": size.lines, "columns": size.columns}))
    finally:
        os.close(fd)
    sys.exit(0)
if not args.events:
    parser.error("--events is required")

log = open(args.events, "a", encoding="utf-8", buffering=1)
original = termios.tcgetattr(0)


def report(event, **extra):
    size = os.get_terminal_size(0)
    log.write(json.dumps({"event": event, "rows": size.lines, "columns": size.columns, **extra}) + "\n")


def draw(reason):
    size = os.get_terminal_size(0)
    rows, cols = max(1, size.lines), max(1, size.columns)
    title = f"FULLSCREEN rows={size.lines} cols={size.columns}"
    output = f"\x1b[2J\x1b[H{title}\x1b[5;11HMARK:{reason}\x1b[{rows};{cols}H@"
    os.write(1, output.encode("ascii"))


def resized(_signal, _frame):
    draw("winch")
    report("resize", signal="SIGWINCH")


def terminate(_signal, _frame):
    raise SystemExit(0)


signal.signal(signal.SIGTERM, terminate)
try:
    os.write(1, b"ECHO_READY\r\n")
    report("echo-ready", echo=bool(original[3] & termios.ECHO))
    line = os.read(0, 4096)
    report("echo-line", hex=line.hex())
    tty.setraw(0)
    signal.signal(signal.SIGWINCH, resized)
    os.write(1, b"\x1b[?1049h")
    draw("initial")
    report("raw-ready")
    while True:
        readable, _, _ = select.select([0], [], [])
        if readable:
            data = os.read(0, 4096)
            if not data:
                break
            report("bytes", hex=data.hex())
            if b"q" in data:
                break
finally:
    os.write(1, b"\x1b[?1049l")
    termios.tcsetattr(0, termios.TCSANOW, original)
    log.close()
