#!/usr/bin/env python3
"""Real cross-account .dxproj export/import browser journey.

API calls prepare isolated fixtures and verify persisted records. Export,
import, reopening, editing, error handling and mobile interactions use the UI.
No response mocking or transport interception is used.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import traceback
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
ASSET_URL = re.compile(r'^/api/assets/([a-zA-Z0-9-]+)/(file|thumbnail)$')


def authored_ids(board):
    ids = {board['id']}
    for result in board['results']:
        ids.update([result['id'], result['documentId'], result['projectId']])
        for node in result['design']['nodes']:
            ids.add(node['id'])
            if node.get('groupId'):
                ids.add(node['groupId'])
    ids.update(item['id'] for item in board['notes'] + board['sections'])
    ids.update(message['id'] for message in board.get('messages', []))
    return ids


def asset_urls(value, field=''):
    # Human-authored text can deliberately mention an old URL/ID verbatim.
    human = {'text', 'prompt', 'draft', 'title', 'name', 'description', 'subtitle', 'label'}
    if isinstance(value, str):
        return {value} if field not in human and ASSET_URL.fullmatch(value) else set()
    if isinstance(value, list):
        return set().union(*(asset_urls(item, field) for item in value)) if value else set()
    if isinstance(value, dict):
        return set().union(*(asset_urls(item, key) for key, item in value.items())) if value else set()
    return set()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default=os.getenv('DESIGNX_E2E_URL', 'http://127.0.0.1:5173'))
    parser.add_argument('--output', type=Path)
    parser.add_argument('--accounts-file', type=Path,
        help='Optional private JSON file with a/b email/password test accounts; reuse via UI login to avoid registration rate limits.')
    args = parser.parse_args()
    run_id = time.strftime('%Y%m%d-%H%M%S') + '-' + uuid4().hex[:6]
    output = args.output or ROOT / 'tests/e2e/.artifacts' / ('import-' + run_id)
    output.mkdir(parents=True, exist_ok=True)
    executable = os.getenv('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH') or subprocess.check_output(
        ['node', '-e', 'import("playwright").then(p=>console.log(p.chromium.executablePath()))'], cwd=ROOT, text=True).strip()
    report = {'runId': run_id, 'baseUrl': args.base_url, 'mocked': False, 'checks': [], 'projects': [], 'pageErrors': [], 'serverErrors': [], 'artifacts': []}
    reused_accounts = json.loads(args.accounts_file.read_text()) if args.accounts_file else None
    report['accountSetup'] = 'reuse isolated test accounts through UI login' if reused_accounts else 'register two isolated accounts through UI'
    report['authenticationMode'] = 'login-reused-test-accounts' if reused_accounts else 'register-new-test-accounts'
    current = 'startup'

    def check(name, details=None):
        report['checks'].append({'name': name, 'status': 'passed', 'details': details})
        print('PASS ' + name, flush=True)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, executable_path=executable)
        contexts, pages = [], []

        def new_user(label):
            context = browser.new_context(viewport={'width': 1500, 'height': 1000}, accept_downloads=True)
            context.tracing.start(screenshots=True, snapshots=True, sources=False)
            contexts.append((label, context))
            page = context.new_page()
            page.set_default_timeout(20000)
            page.on('pageerror', lambda error: report['pageErrors'].append(str(error)))
            page.on('response', lambda response: report['serverErrors'].append({'url': response.url, 'status': response.status}) if response.status >= 500 else None)
            page.on('dialog', lambda dialog: dialog.accept())
            pages.append((label, page))
            page.goto(args.base_url, wait_until='domcontentloaded')
            if reused_accounts:
                account = reused_accounts[label]
                page.get_by_label('邮箱', exact=True).fill(account['email'])
                page.get_by_label('密码', exact=True).fill(account['password'])
                page.get_by_role('button', name='进入创作空间', exact=True).click()
            else:
                page.get_by_role('button', name='第一次来？创建账户').click()
                page.get_by_label('你的名字').fill('项目导入验收 ' + label)
                page.get_by_label('邮箱', exact=True).fill(f'import-{label}-{run_id}@example.test')
                page.get_by_label('密码', exact=True).fill('Import-Test-' + uuid4().hex)
                page.get_by_role('button', name='创建账户', exact=True).click()
            page.get_by_role('navigation', name='主导航').wait_for()
            return context, page

        def api(context, path, method='GET', data=None, expected=200):
            response = context.request.fetch(args.base_url + '/api' + path, method=method, data=data,
                headers={'Origin': args.base_url, 'X-Requested-With': 'Design-X'})
            assert response.status == expected, f'{method} {path}: {response.status} {response.text()[:350]}'
            return response.json()

        def poll(getter, predicate, timeout=90):
            end = time.monotonic() + timeout
            while True:
                value = getter()
                if predicate(value):
                    return value
                if time.monotonic() > end:
                    raise AssertionError(f'Condition not reached within {timeout}s: {str(value)[:500]}')
                time.sleep(0.25)

        def upload(context, asset_name):
            response = context.request.post(args.base_url + '/api/assets', multipart={
                'file': {'name': f'{asset_name}-{run_id}.jpg', 'mimeType': 'image/jpeg', 'buffer': (ROOT / f'public/assets/{asset_name}.jpg').read_bytes()},
            }, headers={'Origin': args.base_url, 'X-Requested-With': 'Design-X'})
            assert response.status == 202, response.text()
            pending = response.json()
            asset = poll(lambda: next(a for a in api(context, '/assets') if a['id'] == pending['id']), lambda a: a['status'] in ['ready', 'failed'])
            assert asset['status'] == 'ready', asset
            return asset

        def screenshot(page, name):
            page.screenshot(path=str(output / (name + '.png')), full_page=True)
            report['artifacts'].append(name + '.png')

        def close_panel(page):
            button = page.get_by_role('button', name='关闭侧边面板', exact=True)
            if button.is_visible():
                button.click()

        def export_board(page, name):
            with page.expect_download(timeout=150000) as download:
                page.get_by_role('button', name='导出项目包', exact=True).click()
            item = download.value
            assert item.suggested_filename.endswith('.dxproj'), item.suggested_filename
            path = output / name
            item.save_as(str(path))
            assert not item.failure()
            packet = json.loads(path.read_text())
            assert packet['format'] == 'designx.project' and packet['schemaVersion'] == 1
            report['artifacts'].append(name)
            return path, packet

        def go_projects(page):
            if page.locator('.ai-studio').is_visible():
                page.get_by_role('button', name='工作空间', exact=True).click()
            page.get_by_role('navigation', name='主导航').get_by_role('button', name='我的项目', exact=True).click()
            page.get_by_role('button', name='导入项目', exact=True).wait_for()

        def open_import(page):
            page.get_by_role('button', name='导入项目', exact=True).click()
            dialog = page.get_by_role('dialog', name='导入项目', exact=True)
            expect(dialog).to_be_visible()
            return dialog

        def assert_focus_trapped(page, dialog):
            first = dialog.get_by_role('button', name='关闭导入项目', exact=True)
            first.focus()
            page.keyboard.press('Shift+Tab')
            assert page.evaluate('document.activeElement.closest(".dx-import-modal") !== null')
            for _ in range(7):
                page.keyboard.press('Tab')
                assert page.evaluate('document.activeElement.closest(".dx-import-modal") !== null')

        try:
            current = 'two-isolated-accounts'
            context_a, page_a = new_user('a')
            context_b, page_b = new_user('b')
            check(current)

            current = 'real-private-assets-and-complete-board-fixture'
            photo = upload(context_a, 'coffee')
            board_only = upload(context_a, 'skincare')
            title = '导入往返验收 ' + run_id
            group_id = 'source-group-' + uuid4().hex
            design = {'width': 600, 'height': 800, 'background': '#fff8ed', 'nodes': [
                {'id': 'source-photo', 'type': 'image', 'src': photo['image'], 'assetId': photo['id'], 'x': 20, 'y': 180, 'w': 560, 'h': 560, 'fit': 'cover', 'groupId': group_id},
                {'id': 'source-title', 'type': 'text', 'text': '跨空间继续创作', 'x': 30, 'y': 50, 'w': 500, 'h': 90, 'size': 40, 'color': '#283c29', 'groupId': group_id},
            ]}
            project = api(context_a, '/projects', 'POST', {'title': title, 'design': design}, 201)
            source_id = project['id']
            extra = api(context_a, f'/projects/{source_id}/artboards', 'POST', {
                'title': '第二张画板', 'design': {'width': 800, 'height': 600, 'background': '#e9f2e5', 'nodes': [
                    {'id': 'source-extra-text', 'type': 'text', 'text': '第二张画板文字', 'x': 40, 'y': 70, 'w': 650, 'h': 100, 'size': 45, 'color': '#24392d'},
                ]}, 'position': {'x': 390, 'y': 50},
            })
            source = api(context_a, f'/projects/{source_id}/studio')
            note_id, section_id = 'source-note-' + uuid4().hex, 'source-section-' + uuid4().hex
            note_text = f'保留原文，不替换说明中的 ID：{note_id}\n以及素材地址：{photo["image"]}\n中文、emoji 🌿 与换行。'
            library = {'id': board_only['id'], 'assetId': board_only['id'], 'name': '仅工作区素材', 'url': board_only['image'], 'image': board_only['image'], 'thumbnail': board_only['thumbnail'], 'status': 'ready'}
            board = source['snapshot']
            board.update({'title': title, 'notes': [{'id': note_id, 'text': note_text, 'position': {'x': 730, 'y': 65}, 'width': 310, 'height': 240, 'color': '#FFF0B5'}],
                'sections': [{'id': section_id, 'title': '研究与方案', 'position': {'x': 350, 'y': -15}, 'width': 740, 'height': 460, 'color': '#CBD8BE', 'itemIds': [extra['id'], note_id]}],
                'assets': [library], 'attached': [library], 'selected': note_id, 'selection': [note_id, extra['id']], 'reference': extra['id'],
                'draft': '保留原始需求 ' + source_id, 'messages': [{'id': 'source-message-' + uuid4().hex, 'role': 'user', 'text': '原文内 ID ' + note_id, 'resultIds': [extra['id']], 'assets': [library]}],
                'view': {'x': 20, 'y': 130, 'zoom': 0.65},
            })
            api(context_a, f'/projects/{source_id}/studio', 'PUT', {'baseRevision': source['revision'], 'snapshot': board})
            source_board = api(context_a, f'/projects/{source_id}/studio')['snapshot']
            assert len(source_board['results']) == 2
            assert board_only['image'] not in asset_urls([result['design'] for result in source_board['results']])
            report['projects'].append({'account': 'a', 'id': source_id})
            check(current, {'projectId': source_id, 'privateAssetIds': [photo['id'], board_only['id']]})

            current = 'board-ui-exports-portable-project-and-board-only-media'
            page_a.goto(args.base_url + '/#studio/' + source_id, wait_until='domcontentloaded')
            page_a.get_by_role('button', name='导出项目包', exact=True).wait_for()
            close_panel(page_a)
            export_path, packet = export_board(page_a, 'source.dxproj')
            assert len([doc for doc in packet['documents'] if doc['kind'] == 'artboard']) == 2
            assert photo['image'] in packet['assets'] and board_only['image'] in packet['assets']
            assert board_only['thumbnail'] in packet['assets']
            assert all(value.startswith('data:image/') for value in packet['assets'].values())
            check(current, {'fileBytes': export_path.stat().st_size, 'packedSources': sorted(packet['assets'])})
            screenshot(page_a, '01-source-board')

            current = 'workspace-ui-imports-and-opens-new-project'
            go_projects(page_b)
            dialog = open_import(page_b)
            dialog.get_by_label('选择项目文件', exact=True).set_input_files(str(export_path))
            with page_b.expect_response(lambda r: r.request.method == 'POST' and r.url.endswith('/api/projects/import')) as response:
                dialog.get_by_role('button', name='开始导入', exact=True).click()
            assert response.value.status == 202, response.value.text()
            job_id = response.value.json()['id']
            expect(dialog.get_by_role('heading', name='项目已导入', exact=True)).to_be_visible(timeout=120000)
            expect(dialog.get_by_role('button', name='打开项目', exact=True)).to_be_focused()
            imported_job = api(context_b, '/jobs/' + job_id)
            assert imported_job['status'] == 'succeeded'
            imported_id = imported_job['result']['projectId']
            dialog.get_by_role('button', name='打开项目', exact=True).click()
            expect(page_b).to_have_url(re.compile(r'#studio/' + re.escape(imported_id) + '$'))
            expect(page_b.locator('.st-note')).to_have_count(1)
            expect(page_b.locator('.st-section')).to_have_count(1)
            close_panel(page_b)
            report['projects'].append({'account': 'b', 'id': imported_id})
            check(current, {'jobId': job_id, 'projectId': imported_id})

            current = 'all-document-item-node-group-and-asset-references-remapped'
            imported_board = api(context_b, f'/projects/{imported_id}/studio')['snapshot']
            assert imported_id != source_id and len(imported_board['results']) == 2
            assert authored_ids(source_board).isdisjoint(authored_ids(imported_board))
            for result in imported_board['results']:
                original = next(item for item in source_board['results'] if item['title'] == result['title'])
                assert len(result['design']['nodes']) == len(original['design']['nodes'])
                assert result['design']['width'] == original['design']['width']
                assert result['design']['height'] == original['design']['height']
                original_groups = [node.get('groupId') for node in original['design']['nodes']]
                new_groups = [node.get('groupId') for node in result['design']['nodes']]
                for first in range(len(original_groups)):
                    for second in range(len(original_groups)):
                        assert (original_groups[first] == original_groups[second]) == (new_groups[first] == new_groups[second])
            assert imported_board['notes'][0]['text'] == note_text
            for key in ['position', 'width', 'height', 'color']:
                assert imported_board['notes'][0][key] == source_board['notes'][0][key]
                assert imported_board['sections'][0][key] == source_board['sections'][0][key]
            by_title = {result['title']: result for result in imported_board['results']}
            extra_new = by_title['第二张画板']['id']
            note_new = imported_board['notes'][0]['id']
            assert set(imported_board['sections'][0]['itemIds']) == {extra_new, note_new}
            assert imported_board['selected'] == note_new
            assert set(imported_board['selection']) == {extra_new, note_new}
            assert imported_board['reference'] == extra_new
            assert imported_board['messages'][0]['resultIds'] == [extra_new]
            assert imported_board['messages'][0]['text'] == source_board['messages'][0]['text']
            assert imported_board['draft'] == source_board['draft']
            new_urls = asset_urls(imported_board)
            assert new_urls and new_urls.isdisjoint(asset_urls(source_board))
            for result in imported_board['results']:
                for layer in result['design']['nodes']:
                    if layer.get('src'):
                        # The current node schema stores the asset relation in
                        # src and strips unsupported assetId metadata. Any
                        # retained explicit ID must agree with that URL.
                        if 'assetId' in layer:
                            assert layer['assetId'] == ASSET_URL.fullmatch(layer['src']).group(1)
            for item in imported_board['assets'] + imported_board['attached'] + imported_board['messages'][0]['assets']:
                assert item['id'] == item['assetId'] == ASSET_URL.fullmatch(item['url']).group(1)
            check(current, {'newAssetUrls': sorted(new_urls), 'noteId': note_new, 'sectionMembers': imported_board['sections'][0]['itemIds']})

            current = 'private-assets-readable-only-by-owning-account'
            for url in sorted(new_urls):
                readable = context_b.request.get(args.base_url + url)
                assert readable.ok and readable.headers['content-type'].startswith('image/') and len(readable.body()) > 100
                assert context_a.request.get(args.base_url + url).status == 404
            for url in sorted(asset_urls(source_board)):
                assert context_b.request.get(args.base_url + url).status == 404
            assert context_a.request.get(args.base_url + f'/api/projects/{imported_id}').status == 404
            assert context_b.request.get(args.base_url + f'/api/projects/{source_id}').status == 404
            check(current)
            screenshot(page_b, '02-imported-board')

            current = 'refresh-edit-save-and-reexport-imported-project'
            page_b.reload(wait_until='domcontentloaded')
            page_b.get_by_role('button', name='选中便签 1', exact=True).wait_for()
            close_panel(page_b)
            page_b.get_by_role('button', name='选中便签 1', exact=True).click()
            revised_text = note_text + '\n导入后继续编辑并保存。'
            page_b.get_by_label('便签内容', exact=True).fill(revised_text)
            page_b.keyboard.press('ControlOrMeta+s')
            persisted = poll(lambda: api(context_b, f'/projects/{imported_id}/studio')['snapshot'], lambda b: b['notes'][0]['text'] == revised_text)
            assert persisted['sections'][0]['itemIds'] == imported_board['sections'][0]['itemIds']
            second_path, second_packet = export_board(page_b, 'reexported.dxproj')
            second_board = next(doc['content'] for doc in second_packet['documents'] if doc['kind'] == 'board')
            assert second_board['notes'][0]['text'] == revised_text
            assert {doc['id'] for doc in packet['documents']}.isdisjoint({doc['id'] for doc in second_packet['documents']})
            assert set(second_packet['assets']) == asset_urls(persisted)
            assert all(old not in second_packet['assets'] for old in asset_urls(source_board))
            assert api(context_a, f'/projects/{source_id}/studio')['snapshot']['notes'][0]['text'] == note_text
            check(current, {'fileBytes': second_path.stat().st_size})

            current = 'invalid-files-and-unknown-version-do-not-create-projects'
            go_projects(page_b)
            before_ids = {item['id'] for item in api(context_b, '/projects')}
            before_jobs = {item['id'] for item in api(context_b, '/jobs') if item['kind'] == 'project.import'}
            dialog = open_import(page_b)
            dialog.get_by_label('选择项目文件', exact=True).set_input_files({'name': 'wrong.txt', 'mimeType': 'text/plain', 'buffer': b'not a project'})
            expect(dialog.get_by_role('alert')).to_contain_text('.dxproj')
            expect(dialog.get_by_role('button', name='开始导入', exact=True)).to_be_disabled()
            for filename, payload, expected_text in [
                ('broken.dxproj', b'{broken json', '不是有效的'),
                ('future.dxproj', json.dumps({**packet, 'schemaVersion': 999}, ensure_ascii=False).encode(), '不支持此项目版本'),
            ]:
                dialog.get_by_label('选择项目文件', exact=True).set_input_files({'name': filename, 'mimeType': 'application/json', 'buffer': payload})
                with page_b.expect_response(lambda r: r.request.method == 'POST' and r.url.endswith('/api/projects/import')) as invalid_response:
                    dialog.get_by_role('button', name='开始导入', exact=True).click()
                assert invalid_response.value.status == 422
                expect(dialog.get_by_role('alert')).to_contain_text(expected_text)
                assert {item['id'] for item in api(context_b, '/projects')} == before_ids
                assert {item['id'] for item in api(context_b, '/jobs') if item['kind'] == 'project.import'} == before_jobs
            dialog.get_by_role('button', name='关闭导入项目', exact=True).click()
            expect(dialog).not_to_be_visible()
            dialog = open_import(page_b)
            dialog.get_by_label('选择项目文件', exact=True).set_input_files(str(export_path))
            expect(dialog.get_by_role('button', name='开始导入', exact=True)).to_be_enabled()
            check(current)

            current = 'mobile-390px-file-dialog-and-keyboard-focus-trap'
            page_b.set_viewport_size({'width': 390, 'height': 844})
            long_name = '长文件名称与说明' * 20 + '.dxproj'
            dialog.get_by_label('选择项目文件', exact=True).set_input_files({'name': long_name, 'mimeType': 'application/json', 'buffer': export_path.read_bytes()})
            assert_focus_trapped(page_b, dialog)
            bounds = dialog.bounding_box()
            assert bounds and bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= 391
            assert page_b.evaluate('document.documentElement.scrollWidth <= innerWidth')
            assert dialog.evaluate('(element) => element.scrollWidth <= element.clientWidth + 1')
            assert dialog.get_by_role('button', name='关闭导入项目', exact=True).is_enabled()
            screenshot(page_b, '03-mobile-import-dialog')
            page_b.keyboard.press('Escape')
            expect(dialog).not_to_be_visible()
            expect(page_b.get_by_role('button', name='导入项目', exact=True)).to_be_focused()
            check(current, {'viewport': 390, 'modalWidth': bounds['width']})

            current = 'accepted-import-continues-after-close-and-opens-from-activity'
            page_b.set_viewport_size({'width': 1500, 'height': 1000})
            dialog = open_import(page_b)
            dialog.get_by_label('选择项目文件', exact=True).set_input_files(str(second_path))
            with page_b.expect_response(lambda r: r.request.method == 'POST' and r.url.endswith('/api/projects/import')) as accepted:
                dialog.get_by_role('button', name='开始导入', exact=True).click()
            assert accepted.value.status == 202
            background_job_id = accepted.value.json()['id']
            dialog.get_by_role('button', name='关闭导入项目', exact=True).click()
            expect(dialog).not_to_be_visible()
            background_job = poll(lambda: api(context_b, '/jobs/' + background_job_id), lambda job: job['status'] in ['succeeded', 'failed', 'cancelled'])
            assert background_job['status'] == 'succeeded', background_job
            page_b.get_by_role('button', name='查看消息', exact=True).click()
            page_b.locator('.job-row').filter(has_text='项目导入').first.get_by_role('button', name='打开项目', exact=True).click()
            background_id = background_job['result']['projectId']
            expect(page_b).to_have_url(re.compile(r'#studio/' + re.escape(background_id) + '$'))
            expect(page_b.locator('.st-note')).to_have_count(1)
            assert api(context_b, f'/projects/{background_id}/studio')['snapshot']['notes'][0]['text'] == revised_text
            report['projects'].append({'account': 'b', 'id': background_id})
            check(current, {'jobId': background_job_id, 'projectId': background_id})

            assert not report['pageErrors'] and not report['serverErrors'], {'pageErrors': report['pageErrors'], 'serverErrors': report['serverErrors']}
            check('no-uncaught-browser-errors-or-server-5xx')
        except Exception as error:
            report['checks'].append({'name': current, 'status': 'failed', 'error': str(error), 'traceback': traceback.format_exc()})
            print(f'FAIL {current}: {error}', file=sys.stderr, flush=True)
            for label, page in pages:
                try:
                    screenshot(page, 'failure-' + label)
                    (output / ('failure-' + label + '.txt')).write_text(page.locator('body').inner_text())
                except Exception:
                    pass
        finally:
            for label, context in contexts:
                context.tracing.stop(path=str(output / ('trace-' + label + '.zip')))
                context.close()
            browser.close()
            report['status'] = 'failed' if any(check['status'] == 'failed' for check in report['checks']) else 'passed'
            (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
            print('Report: ' + str(output / 'report.json'), flush=True)
    return 1 if report['status'] == 'failed' else 0


if __name__ == '__main__':
    raise SystemExit(main())
