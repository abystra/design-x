from __future__ import annotations
import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from .adapter import Adapter
from .protocol import Journal, read_journal, validate_spec, write_command

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["run", "journal", "command"])
    parser.add_argument("--root", required=True)
    parser.add_argument("--after", type=int, default=0)
    args = parser.parse_args()
    root = Path(args.root)
    if not root.is_absolute() or root.is_symlink():
        raise ValueError("Unsafe run directory")
    if args.operation == "journal":
        print(json.dumps(read_journal(root, args.after), ensure_ascii=False))
    elif args.operation == "command":
        command = json.loads(sys.stdin.read(256 * 1024 + 1))
        write_command(root, command)
        print('{"accepted":true}')
    else:
        spec = validate_spec(json.loads((root / "spec.json").read_text()))
        if Path(spec["runRoot"]) != root:
            raise ValueError("Run identity/path mismatch")
        # A lost launch acknowledgement must never cause a second native turn.
        try:
            descriptor = os.open(root / "started", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            return
        os.write(descriptor, str(os.getpid()).encode())
        os.close(descriptor)
        asyncio.run(Adapter(spec, Journal(spec)).run())

if __name__ == "__main__":
    main()
