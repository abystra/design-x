import asyncio
import contextlib
import os
import signal
import sys
from pathlib import Path

import pytest

from designx_runner.codex_rpc import (
    CodexProcessError,
    CodexProtocolError,
    CodexRemoteError,
    CodexRequestTimeout,
    CodexRpc,
    CodexRpcError,
)

# Test-only executable: no model integration, selectable production engine or SDK.
SERVER = r"""
import json, os, signal, subprocess, sys, time
assert sys.argv[1:] == ["app-server", "--listen", "stdio://"]
def send(message):
    print(json.dumps(message), flush=True)
deferred = []
waiting_server_request = None
for line in sys.stdin:
    message = json.loads(line)
    method, request_id = message.get("method"), message.get("id")
    params = message.get("params", {})
    if method == "initialize":
        assert params["capabilities"] == {"experimentalApi": True}
        if os.environ.get("FIXTURE_INITIALIZE") == "malformed":
            send({"id": request_id, "result": "not a handshake"})
        elif os.environ.get("FIXTURE_INITIALIZE") == "fail":
            sys.exit(4)
        else:
            send({"id": request_id, "result": {
                "userAgent":"fixture", "codexHome":"/isolated", "platformOs":"linux", "platformFamily":"unix"
            }})
    elif method == "initialized":
        send({"method":"fixture/initialized", "params":{}})
    elif method == "hold":
        deferred.append(request_id)
    elif method == "flush":
        send({"id": request_id, "result": params})
        for previous in reversed(deferred):
            send({"id": previous, "result": {"held": previous}})
        deferred.clear()
    elif method == "notify":
        send({"method":"future/unknown/event", "params": {"value":"diagnostic"}})
        send({"id":request_id, "result":{}})
    elif method == "serverRequest":
        waiting_server_request = request_id
        send({"id":"server-1", "method":params["method"], "params":{"action":"write"}})
    elif method is None and request_id == "server-1":
        send({"id":waiting_server_request, "result":message})
    elif method == "flood":
        for i in range(20):
            send({"method":"item/started", "params":{"itemId":str(i)}})
    elif method == "malformed":
        print("not-json", flush=True)
    elif method == "oversized":
        print("x" * 8192, flush=True)
    elif method == "nonfinite":
        print('{"id":' + str(request_id) + ',"result":NaN}', flush=True)
    elif method == "invalidObject":
        send(params["payload"])
    elif method == "exit":
        sys.exit(9)
    elif method == "eof":
        os.close(1)
        time.sleep(30)
    elif method == "stderr":
        sys.stderr.write("x" * 32768 + "STDERR_ONLY\n")
        sys.stderr.flush()
        send({"id":request_id,"result":{}})
    elif method == "env":
        send({"id":request_id,"result":{
            "leak":os.environ.get("WORKX_TEST_PARENT_SECRET"), "allowed":os.environ.get("FIXTURE_ONLY")
        }})
    elif method == "privateState":
        from pathlib import Path
        path = Path("native-state-file")
        path.write_bytes(b"native fixture bytes")
        send({"id":request_id,"result":{"mode":path.stat().st_mode & 0o777}})
    elif method == "remoteError":
        send({"id":request_id,"error":{"code":-32000,"message":"sensitive-user-text"}})
    elif method == "resistClose":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        child = subprocess.Popen([sys.executable,"-c","import time; time.sleep(30)"])
        send({"id":request_id,"result":{"child_pid":child.pid}})
        while True:
            time.sleep(1)
    else:
        send({"id":request_id,"result":params})
if os.environ.get("FIXTURE_FLUSH_PATH"):
    from pathlib import Path
    time.sleep(0.05)
    Path(os.environ["FIXTURE_FLUSH_PATH"]).write_text("flushed after EOF")
"""


@pytest.fixture
def binary(tmp_path):
    fixture = tmp_path / "test_only_codex"
    fixture.write_text(f"#!{sys.executable}\n" + SERVER)
    fixture.chmod(0o700)
    return str(fixture)


async def start(binary, tmp_path, **kwargs):
    rpc = await CodexRpc.start(
        binary,
        cwd=str(tmp_path),
        env=kwargs.pop("env", {}),
        client_info={"name": "workx_test", "version": "0.0.0"},
        close_timeout=0.1,
        **kwargs,
    )
    assert (await rpc.next_notification(timeout=2))["method"] == "fixture/initialized"
    return rpc


def test_concurrent_out_of_order_requests_and_unknown_notifications(binary, tmp_path):
    async def exercise():
        async with await start(binary, tmp_path) as rpc:
            held = asyncio.create_task(rpc.request("hold", {}))
            # Wait until the held request is submitted, rather than relying on a timer.
            while not rpc._pending or not next(iter(rpc._pending.values())).submitted:
                await asyncio.sleep(0)
            result = await rpc.request("flush", {"second": True})
            assert result == {"second": True}
            assert (await held)["held"] != rpc._next_id
            await rpc.request("notify", {})
            event = await rpc.next_notification(timeout=2)
            assert event == {"method": "future/unknown/event", "params": {"value": "diagnostic"}}
            assert rpc.initialize_result["userAgent"] == "fixture"

    asyncio.run(exercise())


def test_timeout_and_cancel_do_not_replay_or_misassociate_late_responses(binary, tmp_path):
    async def exercise():
        async with await start(binary, tmp_path) as rpc:
            with pytest.raises(CodexRequestTimeout) as timed_out:
                await rpc.request("hold", {}, timeout=0.05)
            assert timed_out.value.submitted is True
            cancelled = asyncio.create_task(rpc.request("hold", {}))
            while not rpc._pending or not next(iter(rpc._pending.values())).submitted:
                await asyncio.sleep(0)
            cancelled.cancel()
            with pytest.raises(asyncio.CancelledError):
                await cancelled
            assert await rpc.request("flush", {"stable": "result"}) == {"stable": "result"}
            # A following response is ordered after the two late responses on stdout.
            await rpc.request("echo", {})
            assert len([d for d in rpc.diagnostics if d["kind"] == "unmatched_response"]) == 2
            assert rpc._next_id == 5  # initialize, two holds, flush, echo; no replay.
            assert not rpc._pending

    asyncio.run(exercise())


@pytest.mark.parametrize("registered", [False, True])
def test_server_requests_are_explicitly_denied_or_dispatched(binary, tmp_path, registered):
    async def handler(request_id, params):
        assert request_id == "server-1"
        assert params == {"action": "write"}
        return {"decision": "decline"}

    async def exercise():
        handlers = {"workx/testApproval": handler} if registered else {}
        async with await start(binary, tmp_path, handlers=handlers) as rpc:
            response = await rpc.request("serverRequest", {"method": "workx/testApproval"})
            if registered:
                assert response == {"id": "server-1", "result": {"decision": "decline"}}
            else:
                assert response["error"]["code"] == -32601
                assert rpc.diagnostics[-1]["kind"] == "unsupported_server_request"

    asyncio.run(exercise())


@pytest.mark.parametrize(
    ("method", "kwargs", "error"),
    [
        ("malformed", {}, CodexProtocolError),
        ("oversized", {"max_line_bytes": 1024}, CodexProtocolError),
        ("nonfinite", {}, CodexProtocolError),
        ("flood", {"max_notifications": 2}, CodexProtocolError),
        ("exit", {}, CodexProcessError),
        ("eof", {}, CodexProcessError),
    ],
)
def test_protocol_or_process_failure_fails_pending_and_closes_transport(binary, tmp_path, method, kwargs, error):
    async def exercise():
        rpc = await start(binary, tmp_path, **kwargs)
        held = asyncio.create_task(rpc.request("hold", {}))
        try:
            with pytest.raises(error):
                await rpc.request(method, {})
            with pytest.raises(error):
                await held
            with pytest.raises(error):
                await rpc.next_notification(timeout=1)
        finally:
            await rpc.close()
        assert rpc.process.returncode is not None
        assert not rpc._pending

    asyncio.run(exercise())


@pytest.mark.parametrize(
    "payload",
    [[], {"id": True, "result": {}}, {"id": 1, "result": {}, "error": {}}, {"method": "item/started", "params": []}],
)
def test_invalid_json_rpc_shapes_cannot_succeed(binary, tmp_path, payload):
    async def exercise():
        async with await start(binary, tmp_path) as rpc:
            with pytest.raises(CodexProtocolError):
                await rpc.request("invalidObject", {"payload": payload})

    asyncio.run(exercise())


def test_explicit_env_stderr_bounds_and_safe_remote_errors(binary, tmp_path, monkeypatch):
    monkeypatch.setenv("WORKX_TEST_PARENT_SECRET", "must-not-leak")

    async def exercise():
        async with await start(binary, tmp_path, env={"FIXTURE_ONLY": "allowed"}, max_stderr_bytes=256) as rpc:
            assert await rpc.request("env", {}) == {"leak": None, "allowed": "allowed"}
            await rpc.request("stderr", {})
            await rpc.request("echo", {})
            assert len(rpc.stderr_tail) == 256 and rpc.stderr_tail.endswith(b"STDERR_ONLY\n")
            with pytest.raises(CodexRemoteError) as rejected:
                await rpc.request("remoteError", {})
            assert "sensitive-user-text" not in str(rejected.value)
            assert rejected.value.error["message"] == "sensitive-user-text"
            assert await rpc.request("echo", {"still": "connected"}) == {"still": "connected"}

    asyncio.run(exercise())


@pytest.mark.parametrize("initialize", ["malformed", "fail"])
def test_bad_handshake_never_returns_ready_client(binary, tmp_path, initialize):
    async def exercise():
        with pytest.raises(CodexRpcError):
            await start(binary, tmp_path, env={"FIXTURE_INITIALIZE": initialize})

    asyncio.run(exercise())


def test_close_fails_pending_and_terminates_resistant_process_group(binary, tmp_path):
    async def exercise():
        rpc = await start(binary, tmp_path)
        child_pid = (await rpc.request("resistClose", {}))["child_pid"]
        pending = asyncio.create_task(rpc.request("hold", {}))
        while not rpc._pending or not next(iter(rpc._pending.values())).submitted:
            await asyncio.sleep(0)
        await rpc.close()
        await rpc.close()  # Idempotent, even after the process has exited.
        with pytest.raises(CodexProcessError):
            await pending
        assert rpc.process.returncode == -signal.SIGKILL
        with contextlib.suppress(ProcessLookupError):
            # On Linux the killed orphan may briefly remain a zombie until reaped.
            status = Path(f"/proc/{child_pid}/status")
            if status.exists():
                assert "State:\tZ" in status.read_text()
            else:
                os.kill(child_pid, 0)
                pytest.fail("Codex subprocess survived transport cleanup")

    asyncio.run(exercise())


def test_local_limits_reject_large_requests_without_poisoning_connection(binary, tmp_path):
    async def exercise():
        async with await start(binary, tmp_path, max_line_bytes=1024, max_pending_requests=1) as rpc:
            with pytest.raises(ValueError, match="line"):
                await rpc.request("echo", {"too_big": "x" * 2048})
            held = asyncio.create_task(rpc.request("hold", {}))
            while not rpc._pending:
                await asyncio.sleep(0)
            with pytest.raises(CodexRpcError, match="limit"):
                await rpc.request("echo", {})
            held.cancel()
            with pytest.raises(asyncio.CancelledError):
                await held
            assert await rpc.request("echo", {"ready": True}) == {"ready": True}

    asyncio.run(exercise())


def test_notification_timeouts_and_cancelled_waiters_do_not_consume_later_events(binary, tmp_path):
    async def exercise():
        async with await start(binary, tmp_path) as rpc:
            with pytest.raises(TimeoutError):
                await rpc.next_notification(timeout=0.01)
            waiting = asyncio.create_task(rpc.next_notification())
            await asyncio.sleep(0)
            waiting.cancel()
            with pytest.raises(asyncio.CancelledError):
                await waiting
            await rpc.request("notify", {})
            assert (await rpc.next_notification(timeout=1))["method"] == "future/unknown/event"

    asyncio.run(exercise())


def test_owner_close_allows_eof_state_flush_before_any_signal(binary, tmp_path):
    target = tmp_path / "native-tail"

    async def exercise():
        rpc = await start(binary, tmp_path, env={"FIXTURE_FLUSH_PATH": str(target)})
        assert await rpc.request("echo", {"turn": "completed"}) == {"turn": "completed"}
        await rpc.close()
        assert rpc.graceful_shutdown is True and rpc.process.returncode == 0
        assert target.read_text() == "flushed after EOF"

    asyncio.run(exercise())


def test_native_process_creates_private_state_with_explicit_umask(binary, tmp_path):
    async def exercise():
        async with await start(binary, tmp_path) as rpc:
            assert await rpc.request("privateState", {}) == {"mode": 0o600}

    asyncio.run(exercise())


def test_waiting_server_question_does_not_block_other_rpc_or_native_notifications(binary, tmp_path):
    async def exercise():
        gate = asyncio.Event()

        async def handler(request_id, params):
            assert request_id == "server-1" and params == {"action": "write"}
            await gate.wait()
            return {"answers": {"question": {"answers": ["A"]}}}

        async with await start(binary, tmp_path, handlers={"item/tool/requestUserInput": handler}) as rpc:
            pending = asyncio.create_task(rpc.request("serverRequest", {"method": "item/tool/requestUserInput"}))
            await rpc.request("notify", {})
            assert await rpc.request("echo", {"still": "responsive"}) == {"still": "responsive"}
            assert not pending.done()
            gate.set()
            response = await pending
            assert response["id"] == "server-1"
            assert response["result"] == {"answers": {"question": {"answers": ["A"]}}}

    asyncio.run(exercise())
