"""Build the designx-matfs binary for the E2B template (linux/amd64, static). No credentials are used."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main() -> None:
    go = shutil.which("go")
    if not go:
        raise SystemExit("Install Go before building designx-matfs")
    subprocess.run([go, "test", "./..."], cwd=ROOT, check=True)  # noqa: S603
    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    binary = dist / "designx-matfs"
    subprocess.run(  # noqa: S603 -- fixed toolchain and in-repo source
        [go, "build", "-trimpath", "-ldflags", "-s -w", "-o", str(binary), "."],
        cwd=ROOT,
        env={**os.environ, "CGO_ENABLED": "0", "GOOS": "linux", "GOARCH": "amd64"},
        check=True,
    )
    go_sum = hashlib.sha256((ROOT / "go.sum").read_bytes()).hexdigest()
    manifest = {
        "name": "designx-matfs",
        "go_sum_sha256": go_sum,
        "sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
    }
    (dist / "provenance.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest))


if __name__ == "__main__":
    main()
