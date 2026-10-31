#!/usr/bin/env python3
"""Real UI -> API -> Worker -> E2B/Codex/model -> editable design journey.

Requires running web/API/media worker/AI worker/renderer and configured AI.
This script makes at most three AI submissions and never retries a paid turn.
Run only after explicit authorization with --allow-paid-ai. All responses are
real: no interception, route fulfillment, provider stubs or success mocks.
Reports deliberately omit credentials, request bodies and browser traces.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import time
import traceback
from urllib.parse import urlsplit
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
INITIAL_TITLE = '晨光咖啡'
EDITED_TITLE = '晨光咖啡 · 手工精修'
REVISED_TITLE = '暮色咖啡'
TERMINAL = {'succeeded', 'failed', 'cancelled'}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default=os.getenv('DESIGNX_E2E_URL', 'http://127.0.0.1:5173'))
    parser.add_argument('--output', type=Path)
    parser.add_argument('--account-file', type=Path,
                        help='Private JSON with email/password for an existing isolated test account; never copied to reports.')
    parser.add_argument('--turn-timeout', type=int, default=720)
    parser.add_argument('--allow-paid-ai', action='store_true',
                        help='Explicitly permit the three real UI submissions, including immediate cancellation of the third.')
    args = parser.parse_args()
    if not args.allow_paid_ai:
        parser.error('This real-model test requires --allow-paid-ai; it is not a mock or dry run.')
    if not 60 <= args.turn_timeout <= 1200:
        parser.error('--turn-timeout must be between 60 and 1200 seconds')
    base = args.base_url.rstrip('/')
    run_id = time.strftime('%Y%m%d-%H%M%S') + '-' + uuid4().hex[:6]
    output = args.output or ROOT / 'tests/e2e/.artifacts' / ('ai-creation-' + run_id)
    output.mkdir(parents=True, exist_ok=True)
    executable = os.getenv('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH') or subprocess.check_output(
        ['node', '-e', 'import("playwright").then(p=>console.log(p.chromium.executablePath()))'],
        cwd=ROOT, text=True).strip()
    account = json.loads(args.account_file.read_text()) if args.account_file else {
        'email': f'ai-creation-{run_id}@example.test', 'password': 'AI-Verification-' + uuid4().hex,
    }
    secrets = [str(account['password'])]
    report = {
        'runId': run_id, 'baseUrl': base, 'mocked': False, 'interception': False,
        'providerExecution': 'real configured Worker -> E2B Sandbox -> Codex SDK -> model',
        'paidSubmissionLimit': 3, 'submittedTurns': [], 'checks': [], 'projects': [],
        'pageErrors': [], 'httpErrors': [], 'httpResponses': [], 'artifacts': [], 'cleanup': [],
        'authenticationMode': 'login-isolated-account' if args.account_file else 'register-isolated-account',
    }
    current = 'startup'
    project_id = None
    authenticated = False
    started = time.monotonic()

    def scrub(value):
        if isinstance(value, dict):
            return {key: scrub(item) for key, item in value.items()
                    if key.lower() not in {'cookie', 'cookies', 'password', 'authorization', 'headers'}}
        if isinstance(value, list):
            return [scrub(item) for item in value]
        if isinstance(value, str):
            for secret in secrets:
                value = value.replace(secret, '[REDACTED]')
            value = re.sub(r'(?:sk-|e2b_)[A-Za-z0-9_-]+', '[REDACTED]', value)
            value = re.sub(r'(?i)Bearer\s+\S+', 'Bearer [REDACTED]', value)
        return value

    def check(name, details=None):
        report['checks'].append({'name': name, 'status': 'passed', 'details': details})
        print('PASS ' + name, flush=True)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, executable_path=executable)
        context = browser.new_context(viewport={'width': 1600, 'height': 1050}, accept_downloads=True)
        page = context.new_page()
        page.set_default_timeout(25000)
        page.on('pageerror', lambda error: report['pageErrors'].append(scrub(str(error))))
        page.on('dialog', lambda dialog: dialog.accept())

        def record_http(method, url, status, source):
            path = urlsplit(url).path
            if not path.startswith('/api/'):
                return
            item = {'method': method, 'path': path, 'status': status, 'source': source}
            report['httpResponses'].append(item)
            setup_401 = not authenticated and path == '/api/auth/me' and status == 401
            if status >= 400 and not setup_401:
                report['httpErrors'].append(item)

        page.on('response', lambda response: record_http(response.request.method, response.url, response.status, 'browser'))

        def api(path, method='GET', data=None, expected=200):
            response = context.request.fetch(base + '/api' + path, method=method, data=data,
                headers={'Origin': base, 'X-Requested-With': 'Design-X'}, timeout=30000)
            record_http(method, response.url, response.status, 'verification-api')
            assert response.status == expected, f'{method} {path}: HTTP {response.status}'
            return response.json()

        def poll(getter, predicate, timeout=90, interval=0.5):
            end = time.monotonic() + timeout
            while True:
                value = getter()
                if predicate(value):
                    return value
                if time.monotonic() >= end:
                    raise AssertionError(f'Condition did not complete within {timeout}s')
                page.wait_for_timeout(interval * 1000)

        def capture(name):
            page.screenshot(path=str(output / (name + '.png')), full_page=True)
            report['artifacts'].append(name + '.png')

        def close_side_panel():
            button = page.get_by_role('button', name='关闭侧边面板', exact=True)
            if button.count() and button.is_visible():
                button.click()

        def open_studio():
            page.goto(base + '/#studio/' + project_id, wait_until='domcontentloaded')
            page.get_by_label('告诉 AI 你的设计需求', exact=True).wait_for()
            page.wait_for_function('document.fonts.status === "loaded"')
            close_side_panel()

        def submit(prompt, mode, count, ratio='1:1'):
            assert len(report['submittedTurns']) < 3, 'Paid submission budget exhausted'
            page.get_by_label('方案数量', exact=True).select_option(str(count))
            page.get_by_label('生成比例', exact=True).select_option(ratio)
            page.get_by_label('告诉 AI 你的设计需求', exact=True).fill(prompt)
            with page.expect_response(lambda response:
                    response.request.method == 'POST' and
                    urlsplit(response.url).path == f'/api/projects/{project_id}/ai-turns', timeout=30000) as accepted:
                page.get_by_role('button', name='发送设计需求', exact=True).click()
            response = accepted.value
            assert response.status == 202, f'AI submission returned HTTP {response.status}; not retried'
            accepted_job = response.json()
            turn_id = accepted_job['id']
            body = response.request.post_data_json
            report['submittedTurns'].append({'id': turn_id, 'jobId': turn_id, 'expectedMode': mode,
                'requestedMode': body.get('mode'), 'count': body.get('count'), 'ratio': body.get('ratio'),
                'acceptedStatus': accepted_job.get('status')})
            assert body.get('mode') == mode, f'Expected {mode} request, got {body.get("mode")}; pending job will be cancelled'
            assert body.get('count') == count and body.get('ratio') == ratio
            return turn_id

        def wait_turn(turn_id):
            end = time.monotonic() + args.turn_timeout
            next_log = 0.0
            while True:
                turn = api('/ai-turns/' + turn_id)
                if turn['status'] in TERMINAL:
                    break
                if time.monotonic() >= end:
                    raise AssertionError(f'Turn {turn_id} exceeded {args.turn_timeout}s; will be cancelled, not retried')
                if time.monotonic() >= next_log:
                    print(f'AI {turn_id}: {turn["status"]}/{turn.get("stage", "")}', flush=True)
                    next_log = time.monotonic() + 15
                page.wait_for_timeout(2000)
            assert turn['status'] == 'succeeded', f'Turn {turn_id} ended {turn["status"]}: {scrub(turn.get("error"))}'
            card = page.locator(f'[data-ai-turn="{turn_id}"]')
            expect(card).to_have_attribute('data-ai-status', 'succeeded', timeout=30000)
            return turn

        def read_artboard(document_id):
            doc = api('/documents/' + document_id)
            assert doc['kind'] == 'artboard' and doc['projectId'] == project_id
            return doc

        def verify_design(doc, title, image_src):
            design = doc['content']
            assert design['width'] == design['height'], 'Requested 1:1 ratio was not honored'
            nodes = design['nodes']
            assert len(nodes) >= 2 and len({node['id'] for node in nodes}) == len(nodes)
            assert any(node['type'] == 'text' and node.get('text') == title for node in nodes), f'Missing exact editable title: {title}'
            images = [node for node in nodes if node['type'] == 'image']
            assert images and any(node.get('src') == image_src for node in images), 'Uploaded private reference was not used as an editable image node'
            assert all(node.get('src', '').startswith('/api/assets/') for node in images), 'Unexpected non-private image reference'
            return design

        try:
            current = 'authenticate-isolated-user-and-check-real-ai-availability'
            page.goto(base, wait_until='domcontentloaded')
            if not args.account_file:
                page.get_by_role('button', name='第一次来？创建账户', exact=True).click()
                page.get_by_label('你的名字', exact=True).fill('AI 完整链路验收')
            page.get_by_label('邮箱', exact=True).fill(account['email'])
            page.get_by_label('密码', exact=True).fill(account['password'])
            page.get_by_role('button', name='进入创作空间' if args.account_file else '创建账户', exact=True).click()
            page.get_by_role('navigation', name='主导航').wait_for()
            authenticated = True
            assert api('/health')['aiEnabled'] is True, 'Real AI must be enabled before this paid test'
            check(current)

            current = 'upload-real-private-coffee-and-seed-isolated-project'
            response = context.request.post(base + '/api/assets', multipart={
                'file': {'name': f'ai-reference-{run_id}.jpg', 'mimeType': 'image/jpeg',
                         'buffer': (ROOT / 'public/assets/coffee.jpg').read_bytes()},
            }, headers={'Origin': base}, timeout=30000)
            record_http('POST', response.url, response.status, 'fixture-api')
            assert response.status == 202
            asset_id = response.json()['id']
            asset = poll(lambda: next(item for item in api('/assets') if item['id'] == asset_id),
                         lambda item: item['status'] in {'ready', 'failed'})
            assert asset['status'] == 'ready'
            assert asset['image'] == f'/api/assets/{asset_id}/file'
            project = api('/projects', 'POST', {'title': 'AI 真实创作验收 ' + run_id, 'blank': True}, 201)
            project_id = project['id']
            report['projects'].append(project_id)
            before = api(f'/projects/{project_id}/studio')
            snapshot = before['snapshot']
            snapshot['attached'] = [{'id': asset_id, 'assetId': asset_id, 'name': '咖啡实拍参考',
                                     'url': asset['image'], 'image': asset['image']}]
            snapshot['ratio'] = '1:1'
            snapshot['count'] = '2'
            api(f'/projects/{project_id}/studio?response=ack', 'PUT', {'snapshot': snapshot, 'baseRevision': before['revision']})
            initial_ids = {item['id'] for item in snapshot['results']}
            open_studio()
            expect(page.locator('.st-attachments')).to_contain_text('咖啡实拍参考')
            check(current, {'projectId': project_id, 'assetId': asset_id, 'initialArtboardIds': sorted(initial_ids)})

            current = 'ui-generates-two-real-square-editable-designs-with-private-image'
            prompt = (
                f'请制作两张不同排版的 1:1 正方形咖啡宣传海报，必须使用已添加的“咖啡实拍参考”图片。'
                f'每张都必须有一个完整的可编辑文字图层，主标题逐字等于“{INITIAL_TITLE}”，不要拆字、换行或加标点。'
                '每张都把参考照片作为可编辑 image 图层使用，加入少量中文副标题和简洁几何装饰，文字清晰且不要遮住咖啡。'
                '只使用本回合已授权素材，完成并校验实际设计文件。'
            )
            create_id = submit(prompt, 'create', 2)
            created = wait_turn(create_id)
            assert len(created['artboardIds']) == 2
            report['createTurnId'] = create_id
            generated = [read_artboard(identifier) for identifier in created['artboardIds']]
            for doc in generated:
                verify_design(doc, INITIAL_TITLE, asset['image'])
            persisted = api(f'/projects/{project_id}/studio')
            assert {item['id'] for item in persisted['snapshot']['results']} == initial_ids | set(created['artboardIds'])
            create_card = page.locator(f'[data-ai-turn="{create_id}"]')
            create_card.get_by_role('button', name=re.compile('2 个方案已放入画布')).click()
            for identifier in created['artboardIds']:
                expect(page.locator(f'[data-board-id="{identifier}"]')).to_be_visible(timeout=20000)
            capture('01-two-real-ai-artboards')
            check(current, {'turnId': create_id, 'artboardIds': created['artboardIds'],
                'boardRevision': persisted['revision'], 'nodeCounts': [len(doc['content']['nodes']) for doc in generated]})

            current = 'reopen-retains-ai-conversation-and-authoritative-artboards'
            page.reload(wait_until='domcontentloaded')
            page.get_by_label('告诉 AI 你的设计需求', exact=True).wait_for()
            expect(page.locator(f'[data-ai-turn="{create_id}"]')).to_have_attribute('data-ai-status', 'succeeded', timeout=30000)
            listed = api(f'/projects/{project_id}/ai-turns')
            assert any(item['id'] == create_id and item['status'] == 'succeeded' for item in listed)
            for original in generated:
                assert read_artboard(original['id'])['content'] == original['content']
            check(current, {'turnId': create_id})

            current = 'editor-modifies-ai-text-and-exports-real-png'
            close_side_panel()
            page.locator(f'[data-ai-turn="{create_id}"]').get_by_role('button', name=re.compile('2 个方案已放入画布')).click()
            target_id = created['artboardIds'][0]
            target = page.locator(f'[data-board-id="{target_id}"]')
            target.get_by_role('button', name=re.compile('^选中方案 ')).click()
            target.get_by_role('button', name='精细编辑', exact=True).click()
            page.get_by_label('作品名称', exact=True).wait_for()
            page.get_by_role('button', name='选中文字：' + INITIAL_TITLE, exact=True).first.press('Enter')
            with page.expect_response(lambda response: response.request.method == 'PATCH' and
                    urlsplit(response.url).path == f'/api/projects/{project_id}/artboards/{target_id}', timeout=30000) as saved:
                page.get_by_label('文字内容', exact=True).fill(EDITED_TITLE)
                page.get_by_role('button', name='保存', exact=True).click()
            assert saved.value.status == 200
            expect(page.locator('.ed-save-state')).to_have_text('已保存', timeout=30000)
            edited = read_artboard(target_id)
            verify_design(edited, EDITED_TITLE, asset['image'])
            assert edited['revision'] > generated[0]['revision']
            page.get_by_role('button', name='导出作品', exact=True).click()
            export_dialog = page.get_by_role('dialog', name='让好设计，被看见。', exact=True)
            export_dialog.get_by_role('button', name=re.compile('^PNG')).click()
            export_dialog.get_by_label('导出尺寸', exact=True).select_option('1')
            with page.expect_download(timeout=180000) as downloaded:
                export_dialog.get_by_role('button', name='导出 PNG', exact=True).click()
            download = downloaded.value
            assert download.failure() is None
            export_path = output / 'edited-ai-artboard.png'
            download.save_as(str(export_path))
            png = export_path.read_bytes()
            assert png.startswith(b'\x89PNG\r\n\x1a\n') and len(png) > 1000
            assert struct.unpack('>II', png[16:24]) == (edited['content']['width'], edited['content']['height'])
            export_job_id = urlsplit(download.url).path.split('/api/exports/')[1].split('/')[0]
            assert api('/jobs/' + export_job_id)['status'] == 'succeeded'
            report['artifacts'].append(export_path.name)
            capture('02-real-editor-export')
            if export_dialog.is_visible():
                page.get_by_role('button', name='关闭导出弹窗', exact=True).click()
            page.get_by_role('button', name='返回工作区', exact=True).click()
            page.get_by_label('告诉 AI 你的设计需求', exact=True).wait_for()
            check(current, {'documentId': target_id, 'revision': edited['revision'], 'exportJobId': export_job_id, 'pngBytes': len(png)})

            current = 'ui-revise-produces-preview-without-overwriting-original'
            close_side_panel()
            page.locator(f'[data-ai-turn="{create_id}"]').get_by_role('button', name=re.compile('2 个方案已放入画布')).click()
            target = page.locator(f'[data-board-id="{target_id}"]')
            target.get_by_role('button', name=re.compile('^选中方案 ')).click()
            revise_button = page.get_by_role('button', name='修改选中画板', exact=True)
            if revise_button.count() and revise_button.is_visible():
                revise_button.click()
            else:
                # Existing card action has the same product intent; no API mutation fallback.
                target.get_by_role('button', name='继续修改', exact=True).click()
            versions_before = api(f'/projects/{project_id}/versions')
            original_before_apply = read_artboard(target_id)
            revise_id = submit(
                f'只修改当前引用的画板：将主标题“{EDITED_TITLE}”改为“{REVISED_TITLE}”。'
                f'新标题必须保持单个完整可编辑 text 图层，文字逐字等于“{REVISED_TITLE}”。'
                '保留图片素材地址、正方形尺寸和其他所有图层，不要另做新作品。请生成一个可预览的修改方案。',
                'revise', 1,
            )
            revised = wait_turn(revise_id)
            assert revised['targetDocumentId'] == target_id and revised['baseRevision'] == original_before_apply['revision']
            assert len(revised['proposals']) == 1
            assert read_artboard(target_id) == original_before_apply, 'Revise generation changed the original before user apply'
            verify_design({'content': revised['proposals'][0]['design']}, REVISED_TITLE, asset['image'])
            page.locator(f'[data-ai-turn="{revise_id}"]').get_by_role('button', name='预览修改方案 1', exact=True).click()
            preview = page.get_by_role('dialog', name='预览 AI 修改方案', exact=True)
            expect(preview).to_be_visible()
            capture('03-revise-preview-before-apply')
            check(current, {'turnId': revise_id, 'targetDocumentId': target_id, 'unchangedRevision': original_before_apply['revision']})

            current = 'ui-apply-checks-cas-and-retains-original-version'
            with page.expect_response(lambda response: response.request.method == 'POST' and
                    urlsplit(response.url).path == f'/api/ai-turns/{revise_id}/apply', timeout=30000) as applied_response:
                preview.get_by_role('button', name='应用到原画板', exact=True).click()
            assert applied_response.value.status == 200
            expect(preview).not_to_be_visible()
            applied = read_artboard(target_id)
            assert applied['revision'] == original_before_apply['revision'] + 1
            verify_design(applied, REVISED_TITLE, asset['image'])
            versions_after = api(f'/projects/{project_id}/versions')
            previous_ids = {version['id'] for version in versions_before}
            assert previous_ids <= {version['id'] for version in versions_after}, 'Apply removed a previous immutable version'
            assert any(version['documentId'] == target_id and version['revision'] == original_before_apply['revision'] for version in versions_after)
            assert any(version['documentId'] == target_id and version['revision'] == applied['revision'] for version in versions_after)
            report['reviseTurnId'] = revise_id
            capture('04-revised-design-applied')
            check(current, {'turnId': revise_id, 'beforeRevision': original_before_apply['revision'],
                'afterRevision': applied['revision'], 'retainedVersionIds': sorted(previous_ids)})

            current = 'immediate-ui-cancellation-never-adds-an-artboard'
            cancel_reference = page.get_by_role('button', name='取消引用方案', exact=True)
            if cancel_reference.count() and cancel_reference.is_visible():
                cancel_reference.click()
            before_cancel = api(f'/projects/{project_id}/studio')
            before_cancel_ids = {item['id'] for item in before_cancel['snapshot']['results']}
            cancel_id = submit('取消验收：制作一张新咖啡海报；本次任务将立即停止。', 'create', 1)
            cancel_card = page.locator(f'[data-ai-turn="{cancel_id}"]')
            cancel_card.get_by_role('button', name='停止本次创作', exact=True).click(timeout=10000)
            cancelled = poll(lambda: api('/jobs/' + cancel_id), lambda item: item['status'] in TERMINAL, timeout=30)
            assert cancelled['status'] == 'cancelled', 'The cancellation lost its race with completion; do not submit another paid task'
            expect(cancel_card).to_have_attribute('data-ai-status', 'cancelled', timeout=20000)
            # The worker polls cancellation and fences delayed completion. Observe a
            # bounded quiet period rather than claiming job status proves teardown.
            for _ in range(5):
                page.wait_for_timeout(2000)
                assert api('/jobs/' + cancel_id)['status'] == 'cancelled'
                assert {item['id'] for item in api(f'/projects/{project_id}/studio')['snapshot']['results']} == before_cancel_ids
            report['cancelTurnId'] = cancel_id
            capture('05-cancelled-turn-without-new-artboard')
            check(current, {'turnId': cancel_id, 'attempts': cancelled.get('attempts'),
                'cancelledBeforeWorkerStart': cancelled.get('attempts') == 0, 'lateArtifactObservationSeconds': 10,
                'artboardIdsUnchanged': sorted(before_cancel_ids)})

            assert len(report['submittedTurns']) == 3
            assert not report['pageErrors'] and not report['httpErrors'], 'Unexpected browser or HTTP failures; see sanitized report'
            check('no-mocks-no-interception-no-browser-or-http-errors')
        except Exception as error:
            report['checks'].append({'name': current, 'status': 'failed', 'error': scrub(str(error)), 'traceback': scrub(traceback.format_exc())})
            print(f'FAIL {current}: {scrub(str(error))}', file=sys.stderr, flush=True)
            if authenticated:
                try:
                    capture('failure-' + current)
                except Exception:
                    pass
        finally:
            # This only cancels this script's isolated project's unfinished turns;
            # it never retries a failed generation or deletes evidence/artifacts.
            if authenticated and project_id:
                try:
                    for item in api(f'/projects/{project_id}/ai-turns'):
                        if item['status'] in {'queued', 'running'}:
                            stopped = api('/jobs/' + item['jobId'] + '/cancel', 'POST', {})
                            report['cleanup'].append({'turnId': item['id'], 'status': stopped['status']})
                except Exception as error:
                    report['cleanup'].append({'status': 'failed', 'error': scrub(str(error))})
            context.close()
            browser.close()
            report['durationSeconds'] = round(time.monotonic() - started, 3)
            report['status'] = 'failed' if any(item['status'] == 'failed' for item in report['checks']) or any(item['status'] == 'failed' for item in report['cleanup']) else 'passed'
            (output / 'report.json').write_text(json.dumps(scrub(report), ensure_ascii=False, indent=2))
            print('Report: ' + str(output / 'report.json'), flush=True)
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
