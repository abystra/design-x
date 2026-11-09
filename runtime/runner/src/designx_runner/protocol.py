"""Design X protocol v2. The root journal is authoritative across observer reconnects."""
from __future__ import annotations
import json
import os
import re
import time
from pathlib import Path
from typing import Any

VERSION = 2
CODEX_VERSION = "0.166.0"
MAX_FRAME = 256 * 1024
IDENTIFIER = re.compile(r"^[a-zA-Z0-9_-]{1,150}$")

def validate_spec(spec: dict[str, Any]) -> dict[str, Any]:
    if spec.get("version") != VERSION or spec.get("codexVersion") != CODEX_VERSION:
        raise ValueError("Unsupported Runner/Codex protocol")
    for key in ("attemptId", "runId", "sessionId", "projectId"):
        if not isinstance(spec.get(key), str) or not IDENTIFIER.fullmatch(spec[key]):
            raise ValueError("Invalid execution identity")
    if type(spec.get("fence")) is not int or spec["fence"] < 1:
        raise ValueError("Invalid fence")
    if not isinstance(spec.get("deadline"), (int, float)) or not time.time() < spec["deadline"] <= time.time() + 3600:
        raise ValueError("Execution deadline expired or out of bounds")
    for key in ("cwd", "stateDir", "runRoot", "binary", "modelCatalog"):
        if not isinstance(spec.get(key), str) or not Path(spec[key]).is_absolute():
            raise ValueError("Absolute execution paths required")
    if not isinstance(spec.get("prompt"), str) or len(spec["prompt"].encode()) > 40000:
        raise ValueError("Prompt limit exceeded")
    images = spec.get('imagePaths', [])
    if not isinstance(images, list) or len(images) > 3 or any(path != str(Path(spec['cwd']) / f'reference-{index}.png') for index, path in enumerate(images)):
        raise ValueError('Invalid reference image paths')
    if spec.get("model") not in ("deepseek-flash", "deepseek-v4-pro"):
        raise ValueError("Model is not admitted")
    tools = spec.get("tools", [])
    if not isinstance(tools, list) or len(tools) > 20:
        raise ValueError("Invalid tool catalog")
    for tool in tools:
        if not isinstance(tool, dict) or not re.fullmatch(r"[a-zA-Z0-9_.-]{1,100}", tool.get("name", "")) or not isinstance(tool.get("inputSchema"), dict):
            raise ValueError("Invalid tool descriptor")
    if len({t['name'].replace('.', '_') for t in tools}) != len(tools):
        raise ValueError('Native tool aliases must be unique')
    limits = spec.get("limits", {})
    if type(limits.get("toolCalls")) is not int or not 1 <= limits["toolCalls"] <= 100:
        raise ValueError("Invalid tool budget")
    if type(limits.get("outputBytes")) is not int or not 1 <= limits["outputBytes"] <= 3 * 1024 * 1024:
        raise ValueError("Invalid output budget")
    return spec

class Journal:
    def __init__(self, spec: dict[str, Any]):
        self.spec = spec
        self.root = Path(spec["runRoot"])
        self.root.mkdir(parents=True, mode=0o700, exist_ok=True)
        self.path = self.root / "events.jsonl"
        self.sequence = 0

    def emit(self, type_: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        self.sequence += 1
        frame = {"version": VERSION, "attemptId": self.spec["attemptId"], "fence": self.spec["fence"],
                 "sequence": self.sequence, "type": type_, "payload": payload or {}}
        wire = json.dumps(frame, ensure_ascii=False, allow_nan=False).encode() + b"\n"
        if len(wire) > MAX_FRAME:
            raise ValueError("Runner event exceeded journal frame limit")
        with self.path.open("ab", buffering=0) as stream:
            os.chmod(self.path, 0o600)
            stream.write(wire)
            os.fsync(stream.fileno())
        return frame

def read_journal(root: Path, after: int, limit: int = 32) -> dict[str, Any]:
    if after < 0 or not 1 <= limit <= 128:
        raise ValueError("Invalid journal cursor")
    frames = []
    path = root / "events.jsonl"
    if not path.exists():
        return {"events": [], "cursor": after}
    with path.open("rb") as stream:
        while line := stream.readline(MAX_FRAME + 1):
            if len(line) > MAX_FRAME:
                raise ValueError("Oversized journal line")
            if not line.endswith(b"\n"):
                break  # Writer has not committed this complete frame yet.
            frame = json.loads(line)
            if frame["sequence"] <= after:
                continue
            frames.append(frame)
            if len(frames) >= limit:
                break
    return {"events": frames, "cursor": frames[-1]["sequence"] if frames else after}

def write_command(root: Path, command: dict[str, Any]) -> None:
    command_id = command.get("commandId")
    if not isinstance(command_id, str) or not IDENTIFIER.fullmatch(command_id):
        raise ValueError("Invalid command identity")
    wire = json.dumps(command, allow_nan=False).encode()
    if len(wire) > MAX_FRAME:
        raise ValueError("Command too large")
    directory = root / "commands"
    directory.mkdir(mode=0o700, exist_ok=True)
    path = directory / (command_id + ".json")
    if path.exists():
        if json.loads(path.read_text()) != command:
            raise ValueError("Command ID reuse")
        return
    temporary = directory / (command_id + ".tmp")
    with temporary.open("wb") as stream:
        os.chmod(temporary, 0o600)
        stream.write(wire)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
