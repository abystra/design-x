"""Production Codex app-server stdio transport extracted from the WorkX Harness.

This module owns a process and JSON-RPC correlation, not a model/tool loop. Callers
supply an isolated cwd and a complete, deliberately restricted environment. A timed
out or cancelled request is never replayed: its server-side outcome may be unknown.
Only explicit, validated native notifications can establish a business terminal state.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal
from collections import deque
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ServerHandler = Callable[[int | str, dict[str, Any]], Awaitable[Any]]


def _reject_json_constant(_: str) -> None:
    raise ValueError("JSON must not contain NaN or Infinity")


class CodexRpcError(RuntimeError):
    """A failed transport is never evidence that a Codex turn completed."""


class CodexProtocolError(CodexRpcError):
    pass


class CodexProcessError(CodexRpcError):
    pass


class CodexRemoteError(CodexRpcError):
    def __init__(self, method: str, error: dict[str, Any]) -> None:
        # The raw message may contain user data. Do not put it into ordinary logs.
        self.error = error
        super().__init__(f"Codex rejected {method} (code {error['code']})")


class CodexRequestTimeout(CodexRpcError):
    def __init__(self, method: str, request_id: int, *, submitted: bool) -> None:
        self.method = method
        self.request_id = request_id
        self.submitted = submitted
        super().__init__(f"Codex request {method} timed out; submitted={submitted}; outcome requires reconciliation")


@dataclass
class _Pending:
    method: str
    future: asyncio.Future[Any]
    submitted: bool = False


class CodexRpc:
    """One initialized connection to one fixed app-server binary.

    Consume notifications promptly. Queue overflow fails the connection rather than
    dropping potentially important items. Diagnostics retain only bounded metadata;
    stderr is separately bounded, untrusted output for trusted-side inspection.
    Always await close(), including after a failed request.
    """

    def __init__(
        self,
        process: asyncio.subprocess.Process,
        *,
        max_line_bytes: int,
        max_notifications: int,
        max_stderr_bytes: int,
        max_pending_requests: int,
        close_timeout: float,
        handlers: Mapping[str, ServerHandler],
    ) -> None:
        self.process = process
        self.max_line_bytes = max_line_bytes
        self.max_stderr_bytes = max_stderr_bytes
        self.max_pending_requests = max_pending_requests
        self.close_timeout = close_timeout
        self._handlers = dict(handlers)
        self._next_id = 0
        self._pending: dict[int, _Pending] = {}
        self._notifications: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=max_notifications)
        self._write_lock = asyncio.Lock()
        self._notification_ready = asyncio.Event()
        self._failure: CodexRpcError | None = None
        self._shutdown_task: asyncio.Task[None] | None = None
        self._server_tasks: set[asyncio.Task[None]] = set()
        self.diagnostics: deque[dict[str, Any]] = deque(maxlen=128)
        self.stderr_tail = b""
        self.graceful_shutdown: bool | None = None
        self.initialize_result: dict[str, Any] = {}
        self._workers = [
            asyncio.create_task(self._read_stdout()),
            asyncio.create_task(self._read_stderr()),
            asyncio.create_task(self._watch_process()),
        ]

    @classmethod
    async def start(
        cls,
        binary: str,
        *,
        cwd: str,
        env: Mapping[str, str],
        client_info: Mapping[str, str],
        initialize_timeout: float = 15,
        max_line_bytes: int = 8 * 1024 * 1024,
        max_notifications: int = 256,
        max_stderr_bytes: int = 64 * 1024,
        max_pending_requests: int = 128,
        close_timeout: float = 5,
        handlers: Mapping[str, ServerHandler] | None = None,
        user: int | None = None,
        group: int | None = None,
    ) -> CodexRpc:
        if not Path(binary).is_absolute() or not Path(cwd).is_absolute():
            raise ValueError("Codex binary and cwd must be absolute paths")
        if min(max_line_bytes, max_notifications, max_stderr_bytes, max_pending_requests) < 1:
            raise ValueError("Codex transport limits must be positive")
        if initialize_timeout <= 0 or close_timeout <= 0:
            raise ValueError("Codex transport timeouts must be positive")
        process = await asyncio.create_subprocess_exec(
            binary,
            "app-server",
            "--listen",
            "stdio://",
            cwd=cwd,
            env=dict(env),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=max_line_bytes + 1,
            start_new_session=True,
            umask=0o077,
            user=user,
            group=group,
        )
        rpc = cls(
            process,
            max_line_bytes=max_line_bytes,
            max_notifications=max_notifications,
            max_stderr_bytes=max_stderr_bytes,
            max_pending_requests=max_pending_requests,
            close_timeout=close_timeout,
            handlers=handlers or {},
        )
        try:
            initialized = await rpc.request(
                "initialize",
                {"clientInfo": dict(client_info), "capabilities": {"experimentalApi": True}},
                timeout=initialize_timeout,
            )
            if not isinstance(initialized, dict) or any(
                not isinstance(initialized.get(field), str)
                for field in ("userAgent", "codexHome", "platformFamily", "platformOs")
            ):
                raise CodexProtocolError("Invalid Codex initialize response")
            rpc.initialize_result = initialized
            await rpc.notify("initialized", {})
        except BaseException:
            await rpc.close()
            raise
        return rpc

    def _check_open(self) -> None:
        if self._failure is not None:
            raise self._failure

    async def _send(self, message: dict[str, Any], pending: _Pending | None = None) -> None:
        wire = json.dumps(message, ensure_ascii=False, allow_nan=False).encode() + b"\n"
        if len(wire) > self.max_line_bytes:
            raise ValueError("Outgoing Codex protocol line exceeds its configured limit")
        async with self._write_lock:
            self._check_open()
            assert self.process.stdin is not None
            try:
                self.process.stdin.write(wire)
                if pending is not None:
                    pending.submitted = True
                await self.process.stdin.drain()
            except (BrokenPipeError, ConnectionError) as error:
                failure = CodexProcessError("Codex protocol stdin closed")
                self._fail(failure)
                raise failure from error

    async def request(self, method: str, params: dict[str, Any], *, timeout: float = 60) -> Any:
        self._check_open()
        if timeout <= 0:
            raise ValueError("Request timeout must be positive")
        if len(self._pending) >= self.max_pending_requests:
            raise CodexRpcError("Codex pending request limit reached")
        self._next_id += 1
        request_id = self._next_id
        pending = _Pending(method, asyncio.get_running_loop().create_future())
        self._pending[request_id] = pending
        try:
            async with asyncio.timeout(timeout):
                await self._send({"id": request_id, "method": method, "params": params}, pending)
                return await pending.future
        except TimeoutError:
            raise CodexRequestTimeout(method, request_id, submitted=pending.submitted) from None
        finally:
            self._pending.pop(request_id, None)
            if not pending.future.done():
                pending.future.cancel()
            elif not pending.future.cancelled():
                # A write failure can occur before we await a failed pending future.
                pending.future.exception()

    async def notify(self, method: str, params: dict[str, Any]) -> None:
        await self._send({"method": method, "params": params})

    async def next_notification(self, *, timeout: float | None = None) -> dict[str, Any]:
        # No child get() task may consume an event while its caller is cancelled.
        async with asyncio.timeout(timeout):
            while True:
                self._check_open()
                try:
                    return self._notifications.get_nowait()
                except asyncio.QueueEmpty:
                    self._notification_ready.clear()
                    await self._notification_ready.wait()

    @staticmethod
    def _valid_id(value: Any) -> bool:
        return type(value) in (int, str)

    async def _read_stdout(self) -> None:
        assert self.process.stdout is not None
        try:
            while True:
                try:
                    line = await self.process.stdout.readline()
                except ValueError:
                    raise CodexProtocolError("Codex stdout exceeded the protocol line limit") from None
                if not line:
                    raise CodexProcessError("Codex protocol stdout reached EOF")
                if len(line) > self.max_line_bytes or not line.endswith(b"\n"):
                    raise CodexProtocolError("Codex protocol line is oversized or incomplete")
                try:
                    message = json.loads(line, parse_constant=_reject_json_constant)
                except (UnicodeDecodeError, ValueError):
                    raise CodexProtocolError("Codex stdout is not JSONL") from None
                self._dispatch(message)
        except asyncio.CancelledError:
            raise
        except CodexRpcError as error:
            self._fail(error)
        except Exception:
            self._fail(CodexProtocolError("Codex protocol reader failed"))

    def _dispatch(self, message: Any) -> None:
        if not isinstance(message, dict) or message.get("jsonrpc", "2.0") != "2.0":
            raise CodexProtocolError("Invalid Codex protocol object")
        if "method" in message:
            method, params = message["method"], message.get("params", {})
            if not isinstance(method, str) or not isinstance(params, dict) or "result" in message or "error" in message:
                raise CodexProtocolError("Invalid Codex request or notification")
            if "id" not in message:
                try:
                    self._notifications.put_nowait(message)
                    self._notification_ready.set()
                except asyncio.QueueFull:
                    raise CodexProtocolError("Codex notification queue overflow; no events may be dropped") from None
                return
            if not self._valid_id(message["id"]):
                raise CodexProtocolError("Invalid Codex server request id")
            if len(self._server_tasks) >= self.max_pending_requests:
                raise CodexProtocolError("Codex server request capacity exceeded")
            task = asyncio.create_task(self._handle_server_request(message["id"], method, params))
            self._server_tasks.add(task)
            task.add_done_callback(self._server_tasks.discard)
            return
        if not self._valid_id(message.get("id")) or ("result" in message) == ("error" in message):
            raise CodexProtocolError("Invalid Codex response")
        error = message.get("error")
        if "error" in message and (
            not isinstance(error, dict)
            or type(error.get("code")) is not int
            or not isinstance(error.get("message"), str)
        ):
            raise CodexProtocolError("Invalid Codex error response")
        pending = self._pending.get(message["id"])
        if pending is None or pending.future.done():
            self.diagnostics.append({"kind": "unmatched_response", "id": message["id"]})
            return
        if error is not None:
            pending.future.set_exception(CodexRemoteError(pending.method, error))
        else:
            pending.future.set_result(message["result"])

    async def _handle_server_request(self, request_id: int | str, method: str, params: dict[str, Any]) -> None:
        handler = self._handlers.get(method)
        response: dict[str, Any] = {"id": request_id}
        if handler is None:
            self.diagnostics.append({"kind": "unsupported_server_request", "method": method})
            response["error"] = {"code": -32601, "message": "Unsupported client method"}
        else:
            try:
                response["result"] = await handler(request_id, params)
            except asyncio.CancelledError:
                raise
            except Exception:
                self.diagnostics.append({"kind": "server_handler_failed", "method": method})
                response["error"] = {"code": -32603, "message": "Client request handler failed"}
        try:
            await self._send(response)
        except asyncio.CancelledError:
            raise
        except Exception:
            self._fail(CodexProtocolError("Codex server request response could not be sent"))

    async def _read_stderr(self) -> None:
        assert self.process.stderr is not None
        try:
            while chunk := await self.process.stderr.read(8192):
                self.stderr_tail = (self.stderr_tail + chunk)[-self.max_stderr_bytes :]
        except asyncio.CancelledError:
            raise
        except Exception:
            self._fail(CodexProcessError("Codex stderr reader failed"))

    async def _watch_process(self) -> None:
        returncode = await self.process.wait()
        self._fail(CodexProcessError(f"Codex app-server exited (status {returncode})"))

    def _fail(self, error: CodexRpcError, *, graceful: bool = False) -> None:
        if self._failure is None:
            self._failure = error
            self._notification_ready.set()
            for pending in self._pending.values():
                if not pending.future.done():
                    pending.future.set_exception(error)
        if self._shutdown_task is None:
            self._shutdown_task = asyncio.create_task(self._shutdown(graceful=graceful))

    def _signal_group(self, sig: signal.Signals) -> None:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(self.process.pid, sig)

    async def _shutdown(self, *, graceful: bool) -> None:
        # In pinned 0.144.0 stdio, the last ConnectionClosed ends the processor
        # loop, drains background work, and calls shutdown_threads(). Give that
        # EOF path time to flush native state before escalating to signals.
        # codex-rs/app-server/src/lib.rs (rust-v0.144.0), lines 946-965, 1105-1114.
        self.graceful_shutdown = False
        if graceful and self.process.stdin is not None:
            self.process.stdin.close()
            try:
                await asyncio.wait_for(self.process.wait(), timeout=self.close_timeout)
                self.graceful_shutdown = self.process.returncode == 0
            except TimeoutError:
                pass
        if not self.graceful_shutdown:
            self._signal_group(signal.SIGTERM)
            try:
                await asyncio.wait_for(self.process.wait(), timeout=self.close_timeout)
            except TimeoutError:
                self._signal_group(signal.SIGKILL)
                await self.process.wait()
        # Also signal remaining children if app-server exited before its subprocesses.
        self._signal_group(signal.SIGKILL)
        if self.process.stdin is not None:
            self.process.stdin.close()
        tasks = [*self._workers, *self._server_tasks]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def close(self) -> None:
        self._fail(CodexProcessError("Codex connection closed by its owner"), graceful=self._failure is None)
        assert self._shutdown_task is not None
        await asyncio.shield(self._shutdown_task)

    async def __aenter__(self) -> CodexRpc:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()
