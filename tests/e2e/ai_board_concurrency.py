#!/usr/bin/env python3
"""One real paid AI create while a native Board drag overlaps result delivery.

Requires --allow-paid-ai. API fixture setup and AI output are real. The only
transport fault injection fetches one actual completed GET /studio response,
holds it briefly, then fulfills the original response unchanged. No fabricated
API data, provider stub, historical-response replay, or browser trace is used.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import traceback
from urllib.parse import urlsplit
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
TERMINAL = {'succeeded', 'failed', 'cancelled'}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default=os.getenv('DESIGNX_E2E_URL', 'http://127.0.0.1:5173'))
    parser.add_argument('--account-file', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--turn-timeout', type=int, default=720)
    parser.add_argument('--allow-paid-ai', action='store_true', help='Authorize at most one real create/count=1 submission; never retry it.')
    args = parser.parse_args()
    if not args.allow_paid_ai:
        parser.error('This test requires explicit --allow-paid-ai; no request has been sent.')
    if not 60 <= args.turn_timeout <= 1200:
        parser.error('--turn-timeout must be 60..1200 seconds')
    if args.account_file.stat().st_mode & 0o077:
        parser.error('--account-file must have private 0600 permissions')
    account = json.loads(args.account_file.read_text())
    base = args.base_url.rstrip('/')
    run_id = time.strftime('%Y%m%d-%H%M%S') + '-' + uuid4().hex[:6]
    output = args.output or ROOT / 'tests/e2e/.artifacts' / ('ai-board-race-' + run_id)
    output.mkdir(parents=True, exist_ok=True)
    executable = os.getenv('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH') or subprocess.check_output(
        ['node', '-e', 'import("playwright").then(p=>console.log(p.chromium.executablePath()))'], cwd=ROOT, text=True).strip()
    report = {
        'runId': run_id, 'baseUrl': base, 'mocked': False, 'fabricatedResponses': False,
        'transportDelayInjection': True, 'responseReplay': False, 'traceEnabled': False,
        'injectionDescription': 'One freshly fetched successful Board GET is delayed, then fulfilled with its original APIResponse unchanged.',
        'providerExecution': 'real Worker -> E2B Sandbox -> Codex SDK -> configured model',
        'paidSubmissionLimit': 1, 'paidRequests': [], 'checks': [], 'pageErrors': [],
        'httpErrors': [], 'artifacts': [], 'cleanup': [],
    }
    project_id = turn_id = None
    stage = 'setup'
    gate = {'held': None, 'released': False, 'injected': False}
    start = time.monotonic()

    def scrub(value):
        if isinstance(value, dict):
            return {key: scrub(item) for key, item in value.items() if key.lower() not in {'password', 'headers', 'cookie', 'authorization'}}
        if isinstance(value, list):
            return [scrub(item) for item in value]
        if isinstance(value, str):
            value = value.replace(account['password'], '[REDACTED]')
            value = re.sub(r'(?:sk-|e2b_)[A-Za-z0-9_-]+', '[REDACTED]', value)
            return re.sub(r'(?i)Bearer\s+\S+', 'Bearer [REDACTED]', value)
        return value

    def check(name, details=None):
        report['checks'].append({'name': name, 'status': 'passed', 'details': details})
        print('PASS ' + name, flush=True)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, executable_path=executable)
        context = browser.new_context(viewport={'width': 1600, 'height': 1050})
        page = context.new_page()
        page.set_default_timeout(25000)
        page.on('pageerror', lambda error: report['pageErrors'].append(scrub(str(error))))
        page.on('dialog', lambda dialog: dialog.accept())

        def response_error(response):
            if response.status >= 400:
                report['httpErrors'].append({'path': urlsplit(response.url).path, 'status': response.status})
        page.on('response', response_error)

        def count_paid(request):
            if request.method == 'POST' and urlsplit(request.url).path.endswith('/ai-turns'):
                body = request.post_data_json
                report['paidRequests'].append({'path': urlsplit(request.url).path, 'mode': body.get('mode'), 'count': body.get('count')})
        page.on('request', count_paid)

        def api(path, method='GET', data=None, status=200):
            response = context.request.fetch(base + '/api' + path, method=method, data=data,
                headers={'Origin': base, 'X-Requested-With': 'Design-X'}, timeout=30000)
            assert response.status == status, f'{method} {path}: HTTP {response.status}'
            return response.json()

        def poll(getter, predicate, timeout=30, interval=.3):
            until = time.monotonic() + timeout
            while True:
                result = getter()
                if predicate(result):
                    return result
                assert time.monotonic() < until, f'Timed out waiting for {stage}'
                page.wait_for_timeout(interval * 1000)

        def capture(name):
            page.screenshot(path=str(output / (name + '.png')), full_page=True)
            report['artifacts'].append(name + '.png')

        def position(snapshot):
            return next(item for item in snapshot['notes'] if item['id'] == note_id)['position']

        def board():
            return api(f'/projects/{project_id}/studio')

        def assert_ai(snapshot):
            actual = {item['id'] for item in snapshot['results']}
            assert actual == initial_ids | new_ids, 'AI artboard membership was lost or duplicated'
            assert len(snapshot['notes']) == 1 and snapshot['notes'][0]['text'] == note_text

        def release_gate():
            if gate['held'] is None or gate['released']:
                return
            route, response = gate['held']
            gate['released'] = True
            report['delay']['heldMs'] = round((time.monotonic() - gate['heldAt']) * 1000, 3)
            report['delay']['releasedAtSeconds'] = round(time.monotonic() - start, 3)
            # Reuse the exact fresh APIResponse. Do not synthesize body/status/headers.
            route.fulfill(response=response)

        try:
            stage = 'real-auth-and-isolated-board-fixture'
            api('/auth/login', 'POST', {key: account[key] for key in ('email', 'password')})
            assert api('/health')['aiEnabled'] is True
            project = api('/projects', 'POST', {'title': 'AI 拖动并发验收 ' + run_id, 'blank': True}, 201)
            project_id = project['id']; report['projectId'] = project_id
            remote = board(); snapshot = remote['snapshot']
            initial_ids = {item['id'] for item in snapshot['results']}
            for item in snapshot['results']:
                item['position'] = {'x': 700, 'y': 0}
            note_id = 'race-note-' + uuid4().hex
            note_text = '已有便签：AI 完成期间拖动，正文和最终位置必须保留'
            initial_position = {'x': 80, 'y': 500}
            snapshot.update({'notes': [{'id': note_id, 'text': note_text, 'position': initial_position,
                'width': 240, 'height': 180, 'color': '#FFF0B5'}], 'sections': [],
                'view': {'x': 60, 'y': 60, 'zoom': .75}, 'selection': [], 'selected': None,
                'reference': None, 'mode': 'Agent', 'count': '1', 'ratio': '1:1', 'draft': ''})
            api(f'/projects/{project_id}/studio?response=ack', 'PUT', {'snapshot': snapshot, 'baseRevision': remote['revision']})
            page.goto(base + '/#studio/' + project_id, wait_until='domcontentloaded')
            page.get_by_label('告诉 AI 你的设计需求', exact=True).wait_for()
            close = page.get_by_role('button', name='关闭侧边面板', exact=True)
            if close.count(): close.click()
            note = page.locator(f'.st-note[data-board-id="{note_id}"]')
            expect(note).to_be_visible()
            expect(page.get_by_role('button', name='发送设计需求', exact=True)).to_have_attribute('title', '开始创作可编辑设计')
            check(stage, {'projectId': project_id, 'noteId': note_id, 'initialArtboardIds': sorted(initial_ids)})

            def delay_real_completed_board(route):
                if route.request.method != 'GET' or gate['injected']:
                    route.continue_(); return
                response = route.fetch(timeout=30000, max_retries=0)
                if response.status != 200:
                    route.fulfill(response=response); return
                fresh = response.json()
                added = {item['id'] for item in fresh['snapshot']['results']} - initial_ids
                if not added:
                    route.fulfill(response=response); return
                gate.update({'held': (route, response), 'heldAt': time.monotonic(), 'injected': True, 'newIds': added})
                report['delay'] = {'path': f'/api/projects/{project_id}/studio', 'status': response.status,
                    'originalBodySha256': hashlib.sha256(response.body()).hexdigest(), 'revision': fresh['revision'],
                    'newArtboardIds': sorted(added), 'heldAtSeconds': round(time.monotonic() - start, 3)}
                # Returning without fulfilling intentionally leaves this one GET pending.
            page.route(re.compile(r'/api/projects/' + re.escape(project_id) + r'/studio(?:\?.*)?$'), delay_real_completed_board)

            stage = 'one-real-create-count-one-submitted'
            page.get_by_label('方案数量', exact=True).select_option('1')
            page.get_by_label('生成比例', exact=True).select_option('1:1')
            page.get_by_label('告诉 AI 你的设计需求', exact=True).fill(
                '请创建一张 1:1 极简中文海报，浅米色背景，只需 2 到 3 个可编辑图层：'
                '主标题完整文字“并发验证”，副标题“保留每一次创作”，可加一个绿色矩形装饰。不要使用图片。')
            with page.expect_response(lambda response: response.request.method == 'POST'
                    and urlsplit(response.url).path == f'/api/projects/{project_id}/ai-turns', timeout=30000) as accepted:
                page.get_by_role('button', name='发送设计需求', exact=True).click()
            assert accepted.value.status == 202, 'Paid turn was not accepted; it will not be retried'
            turn_id = accepted.value.json()['id']; report['turnId'] = turn_id
            assert report['paidRequests'] == [{'path': f'/api/projects/{project_id}/ai-turns', 'mode': 'create', 'count': 1}]
            check(stage, {'turnId': turn_id})

            stage = 'real-ai-completes-and-fresh-board-response-is-held'
            until = time.monotonic() + args.turn_timeout; next_log = 0
            while True:
                turn = api('/ai-turns/' + turn_id)
                if turn['status'] in TERMINAL: break
                assert time.monotonic() < until, 'Paid turn timed out; cancel only, never retry'
                if time.monotonic() >= next_log:
                    print('AI status: ' + turn['status'] + '/' + str(turn.get('stage', '')), flush=True)
                    next_log = time.monotonic() + 15
                page.wait_for_timeout(1000)
            assert turn['status'] == 'succeeded', 'Real AI turn ended ' + turn['status']
            new_ids = set(turn['artboardIds']); assert len(new_ids) == 1 and not new_ids & initial_ids
            poll(lambda: gate['held'], bool)
            assert gate['newIds'] == new_ids
            doc = api('/documents/' + next(iter(new_ids)))
            assert any(node.get('text') == '并发验证' for node in doc['content']['nodes'])
            check(stage, {'artboardIds': sorted(new_ids), 'revision': report['delay']['revision']})

            stage = 'native-drag-spans-delivery-of-real-ai-result'
            bounds = note.bounding_box(); handle = note.locator('.st-note-header > span').bounding_box()
            assert bounds and handle
            zoom = float(page.locator('.dx-board-diagnostics').get_attribute('data-camera-zoom'))
            point = (handle['x'] + handle['width'] / 2, handle['y'] + handle['height'] / 2)
            page.mouse.move(*point); page.mouse.down()
            page.mouse.move(point[0] + 90, point[1] + 60, steps=12)
            before_delivery = note.bounding_box(); assert before_delivery
            assert abs(before_delivery['x'] - bounds['x'] - 90) < 2
            assert abs(before_delivery['y'] - bounds['y'] - 60) < 2
            report['gesture'] = {'initialPosition': initial_position, 'zoom': zoom,
                'pixelsBeforeDelivery': {'x': 90, 'y': 60}, 'pixelsAfterDelivery': {'x': 60, 'y': 30}}
            release_gate()
            page.wait_for_timeout(250)  # Allow the genuine response/React continuation to run while held.
            page.mouse.move(point[0] + 150, point[1] + 90, steps=12)
            at_release = note.bounding_box(); assert at_release
            assert abs(at_release['x'] - bounds['x'] - 150) < 2, 'AI delivery interrupted the active drag'
            assert abs(at_release['y'] - bounds['y'] - 90) < 2
            page.mouse.up()
            expected_position = {'x': initial_position['x'] + round(150 / zoom / 10) * 10,
                                 'y': initial_position['y'] + round(90 / zoom / 10) * 10}
            report['gesture']['expectedFinalPosition'] = expected_position
            check(stage, report['gesture'])

            stage = 'ai-ids-and-final-drag-position-persist-together'
            saved = poll(board, lambda value: position(value['snapshot']) == expected_position
                and {item['id'] for item in value['snapshot']['results']} == initial_ids | new_ids)
            assert_ai(saved['snapshot'])
            expect(page.locator('.st-board-actions [role=status]')).to_have_text('已保存到工作空间')
            report['finalBoardRevision'] = saved['revision']
            capture('01-ai-and-final-drag')
            check(stage, {'position': expected_position, 'artboardIds': sorted(initial_ids | new_ids)})

            stage = 'single-undo-redo-preserves-real-ai-artboards'
            page.get_by_role('button', name='撤销画布操作', exact=True).click()
            undone = poll(board, lambda value: position(value['snapshot']) == initial_position)
            assert_ai(undone['snapshot'])
            page.get_by_role('button', name='重做画布操作', exact=True).click()
            redone = poll(board, lambda value: position(value['snapshot']) == expected_position)
            assert_ai(redone['snapshot'])
            check(stage)

            stage = 'refresh-keeps-ai-and-user-change-with-one-paid-request'
            page.unroute_all(behavior='wait')
            page.reload(wait_until='domcontentloaded')
            expect(note).to_be_visible()
            reopened = board(); assert_ai(reopened['snapshot'])
            assert position(reopened['snapshot']) == expected_position
            assert len(report['paidRequests']) == 1
            assert not report['pageErrors'] and not report['httpErrors']
            capture('02-reopened')
            check(stage)
            report['status'] = 'passed'
        except Exception as error:
            report['status'] = 'failed'
            report['checks'].append({'name': stage, 'status': 'failed', 'error': scrub(str(error)), 'traceback': scrub(traceback.format_exc())})
            print('FAIL ' + stage + ': ' + scrub(str(error)), file=sys.stderr, flush=True)
            try: capture('failure')
            except Exception: pass
        finally:
            try: release_gate()
            except Exception as error: report['cleanup'].append({'releaseError': scrub(str(error))})
            if turn_id:
                try:
                    current = api('/ai-turns/' + turn_id)
                    if current['status'] not in TERMINAL:
                        api('/jobs/' + turn_id + '/cancel', 'POST')
                        report['cleanup'].append({'turnId': turn_id, 'action': 'cancelled unfinished turn; no retry'})
                except Exception as error: report['cleanup'].append({'cancelError': scrub(str(error))})
            context.close(); browser.close()
            report['elapsedSeconds'] = round(time.monotonic() - start, 3)
            (output / 'report.json').write_text(json.dumps(scrub(report), ensure_ascii=False, indent=2))
            print('REPORT ' + str(output / 'report.json'), flush=True)
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
