#!/usr/bin/env python3
"""Exercise the real Editor, inverse history, offline drafts and two-tab conflicts.

Requires the running web/API services. Creates one isolated test account and real
projects. One test explicitly injects transport failure with route.abort; all
responses and stored documents come from the real API, without API data mocks.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time
import traceback
from uuid import uuid4

from playwright.sync_api import Error, expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]


def fixture_design():
    return {
        'width': 600, 'height': 800, 'background': '#faf8f4',
        'nodes': [
            {'id': 'text-a', 'type': 'text', 'text': '编辑器验收文字', 'x': 40, 'y': 35, 'w': 220, 'h': 75, 'size': 26, 'color': '#24362b', 'weight': 500},
            {'id': 'rect-a', 'type': 'rect', 'label': '验收矩形', 'x': 60, 'y': 170, 'w': 150, 'h': 95, 'color': '#f2634b'},
            {'id': 'circle-b', 'type': 'circle', 'label': '验收圆形', 'x': 330, 'y': 230, 'w': 105, 'h': 105, 'color': '#8aa394'},
            {'id': 'image-c', 'type': 'image', 'label': '验收咖啡图片', 'src': '/assets/coffee.jpg', 'x': 90, 'y': 430, 'w': 350, 'h': 180, 'fit': 'contain', 'objectPosition': '50% 50%'},
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default=os.getenv('DESIGNX_E2E_URL', 'http://127.0.0.1:5173'))
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    run_id = time.strftime('%Y%m%d-%H%M%S') + '-' + uuid4().hex[:6]
    output = args.output or ROOT / 'tests/e2e/.artifacts' / ('editor-' + run_id)
    output.mkdir(parents=True, exist_ok=True)
    executable = os.getenv('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH') or subprocess.check_output(
        ['node', '-e', 'import("playwright").then(p=>console.log(p.chromium.executablePath()))'], cwd=ROOT, text=True).strip()
    report = {'runId': run_id, 'baseUrl': args.base_url, 'mocked': False, 'faultInjection': ['Abort PATCH requests in the definitive unsent-draft case'], 'checks': [], 'projects': [], 'pageErrors': [], 'serverErrors': [], 'expected409s': [], 'artifacts': []}

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, executable_path=executable)
        context = browser.new_context(viewport={'width': 1600, 'height': 1050}, accept_downloads=True)
        context.tracing.start(screenshots=True, snapshots=True, sources=False)
        pages = []

        def new_page():
            page = context.new_page()
            page.set_default_timeout(15000)
            page.on('pageerror', lambda error: report['pageErrors'].append(str(error)))
            page.on('dialog', lambda dialog: dialog.accept())
            def response_received(response):
                if response.status >= 500:
                    report['serverErrors'].append({'url': response.url, 'status': response.status})
                elif response.status == 409:
                    report['expected409s'].append({'url': response.url, 'status': response.status})
            page.on('response', response_received)
            pages.append(page)
            return page

        def api(path, method='GET', data=None):
            response = context.request.fetch(args.base_url + '/api' + path, method=method, data=data,
                headers={'Origin': args.base_url, 'X-Requested-With': 'Design-X'})
            assert response.ok, f'{method} {path}: {response.status} {response.text()[:400]}'
            return response.json()

        def create_project(suffix):
            project = api('/projects', 'POST', {'title': f'Editor {suffix} {run_id}', 'design': fixture_design()})
            report['projects'].append(project['id'])
            return project

        def open_editor(page, project):
            page.goto(args.base_url + '/#editor/' + project['id'], wait_until='domcontentloaded')
            page.get_by_label('作品名称', exact=True).wait_for()
            expect(page.get_by_label('作品名称', exact=True)).to_have_value(project['title'])
            # The application holds an SSE connection; after reconnect it may
            # never reach networkidle. The loaded document and fonts are the
            # relevant readiness signals for editor interactions.
            page.wait_for_function('document.fonts.status === "loaded"')

        def check(name, details=None):
            report['checks'].append({'name': name, 'status': 'passed', 'details': details})
            print('PASS ' + name, flush=True)

        def capture(page, name):
            path = output / (name + '.png')
            page.screenshot(path=str(path), full_page=True)
            report['artifacts'].append(path.name)

        def node(design, identifier):
            return next(n for n in design['nodes'] if n['id'] == identifier)

        def save_and_read(page, project_id):
            with page.expect_response(lambda r: r.request.method == 'PATCH' and r.url.endswith('/api/projects/' + project_id), timeout=20000) as response:
                page.get_by_role('button', name='保存', exact=True).click()
            assert response.value.ok, f'Save failed: {response.value.status}'
            expect(page.locator('.ed-save-state')).to_have_text('已保存', timeout=20000)
            return api('/projects/' + project_id)['design']

        def click_node(page, name, shift=False):
            page.get_by_role('button', name=name, exact=True).click(position={'x': 16, 'y': 18}, modifiers=['Shift'] if shift else [])

        def history_roundtrip(page, project_id, before, after, label):
            page.get_by_role('button', name='撤销', exact=True).click()
            assert save_and_read(page, project_id) == before, label + ': inverse did not restore the exact document'
            page.get_by_role('button', name='重做', exact=True).click()
            assert save_and_read(page, project_id) == after, label + ': redo did not restore the exact document'
            check(label)

        def fail(name, error):
            report['checks'].append({'name': name, 'status': 'failed', 'error': str(error), 'traceback': traceback.format_exc()})
            print(f'FAIL {name}: {error}', file=sys.stderr, flush=True)
            for index, page in enumerate(pages):
                if not page.is_closed():
                    try:
                        capture(page, f'failure-{name}-{index}')
                        (output / f'failure-{name}-{index}.txt').write_text(page.locator('body').inner_text())
                    except Exception:
                        pass

        try:
            page = new_page()
            page.goto(args.base_url)
            page.wait_for_load_state('networkidle')
            page.get_by_role('button', name='第一次来？创建账户').click()
            page.get_by_label('你的名字').fill('编辑器交互验收')
            page.get_by_label('邮箱', exact=True).fill(f'editor-{run_id}@example.test')
            page.get_by_label('密码', exact=True).fill('Editor-Verification-' + uuid4().hex)
            page.get_by_role('button', name='创建账户', exact=True).click()
            page.get_by_role('navigation', name='主导航').wait_for()
            check('register-one-isolated-account')

            try:
                project = create_project('transformations')
                pid = project['id']
                open_editor(page, project)
                capture(page, '01-editor-before')
                initial = api('/projects/' + pid)['design']

                click_node(page, '选中图层：验收矩形')
                click_node(page, '选中图层：验收圆形', shift=True)
                expect(page.locator('.ed-node-selected')).to_have_count(2)
                expect(page.get_by_role('heading', name='已选 2 个图层')).to_be_visible()
                page.get_by_role('button', name='组合选中图层', exact=True).click()
                grouped = save_and_read(page, pid)
                group_id = node(grouped, 'rect-a').get('groupId')
                assert group_id and node(grouped, 'circle-b').get('groupId') == group_id
                history_roundtrip(page, pid, initial, grouped, 'shift-select-group-inverse-redo')

                page.get_by_role('button', name='取消组合', exact=True).click()
                ungrouped = save_and_read(page, pid)
                assert not node(ungrouped, 'rect-a').get('groupId') and not node(ungrouped, 'circle-b').get('groupId')
                history_roundtrip(page, pid, grouped, ungrouped, 'ungroup-removes-field-and-history-restores-it')

                page.locator('.ed-alignment-grid').get_by_role('button', name='左', exact=True).click()
                aligned = save_and_read(page, pid)
                assert node(aligned, 'rect-a')['x'] == node(aligned, 'circle-b')['x'] == 60
                history_roundtrip(page, pid, ungrouped, aligned, 'multi-layer-alignment-inverse-redo')

                page.locator('.ed-stage').click(position={'x': 4, 'y': 4})
                click_node(page, '选中图层：验收矩形')
                page.get_by_label('旋转角度', exact=True).fill('35')
                rotated = save_and_read(page, pid)
                assert node(rotated, 'rect-a')['rotation'] == 35
                assert 'rotate(35deg)' in page.get_by_role('button', name='选中图层：验收矩形', exact=True).get_attribute('style')
                history_roundtrip(page, pid, aligned, rotated, 'rotation-inverse-redo')

                click_node(page, '选中图层：验收咖啡图片')
                page.get_by_label('图片填充方式', exact=True).select_option('cover')
                page.get_by_label('水平裁剪位置', exact=True).press('Home')
                before_vertical = save_and_read(page, pid)
                page.get_by_label('垂直裁剪位置', exact=True).press('End')
                cropped = save_and_read(page, pid)
                image = node(cropped, 'image-c')
                assert image['fit'] == 'cover' and image['objectPosition'] == '0% 100%'
                image_style = page.get_by_role('button', name='选中图层：验收咖啡图片', exact=True).locator('img').evaluate('(image) => ({fit:image.style.objectFit,position:image.style.objectPosition})')
                assert image_style == {'fit': 'cover', 'position': '0% 100%'}
                history_roundtrip(page, pid, before_vertical, cropped, 'cover-crop-position-inverse-redo')

                page.locator('.ed-stage').click(position={'x': 4, 'y': 4})
                page.get_by_label('画布宽度', exact=True).fill('1200')
                wide = save_and_read(page, pid)
                page.get_by_label('画布高度', exact=True).fill('1600')
                resized = save_and_read(page, pid)
                assert resized['width'] == 1200 and resized['height'] == 1600
                for old in cropped['nodes']:
                    updated = node(resized, old['id'])
                    for key in ['x', 'y', 'w', 'h']:
                        assert math.isclose(updated[key], 2 * old[key]), f'Resize did not scale {old["id"]}.{key}'
                history_roundtrip(page, pid, wide, resized, 'canvas-resize-geometry-inverse-redo')

                old_zoom = page.locator('.ed-board').evaluate('(board) => board.style.transform')
                page.get_by_role('button', name='缩小画布', exact=True).click()
                assert page.locator('.ed-board').evaluate('(board) => board.style.transform') != old_zoom
                page.get_by_role('button', name='放大画布', exact=True).click()
                assert page.locator('.ed-board').evaluate('(board) => board.style.transform') == old_zoom
                assert api('/projects/' + pid)['design'] == resized
                check('viewport-zoom-does-not-mutate-document')

                page.get_by_role('button', name='选中图层：验收圆形', exact=True).press('Enter')
                page.get_by_role('button', name='复制图层', exact=True).click()
                copied = save_and_read(page, pid)
                assert len(copied['nodes']) == len(resized['nodes']) + 1
                assert len({n['id'] for n in copied['nodes']}) == len(copied['nodes'])
                history_roundtrip(page, pid, resized, copied, 'copy-inverse-restores-node-membership-and-order')
                page.get_by_role('button', name='删除图层', exact=True).click()
                deleted = save_and_read(page, pid)
                assert deleted == resized
                history_roundtrip(page, pid, copied, deleted, 'delete-inverse-restores-node-membership-and-order')
                capture(page, '02-editor-transforms')
            except Exception as error:
                fail('transformations-and-inverse-history', error)

            def wait_for_cached_text(page, key, text):
                page.wait_for_function('''async ({key,text}) => {
                    const db = await new Promise((resolve,reject)=>{const r=indexedDB.open('designx-pending-documents',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
                    const draft = await new Promise(resolve=>{const r=db.transaction('drafts').objectStore('drafts').get(key);r.onsuccess=()=>resolve(r.result)});
                    db.close();return draft?.design.nodes.some(n=>n.text===text);
                }''', arg={'key': key, 'text': text})

            try:
                offline_project = create_project('unsent-draft')
                open_editor(page, offline_project)
                pid = offline_project['id']
                cache_key = pid + ':' + offline_project['documentId']
                baseline = api('/projects/' + pid)
                aborted = []
                route_pattern = '**/api/projects/' + pid
                def abort_save(route):
                    if route.request.method == 'PATCH':
                        aborted.append({'method': 'PATCH', 'url': route.request.url})
                        route.abort('internetdisconnected')
                    else:
                        route.continue_()
                # Explicit transport-failure injection, not a fabricated API
                # response. This guarantees the save cannot reach the server.
                page.route(route_pattern, abort_save)
                page.get_by_role('button', name='选中文字：编辑器验收文字', exact=True).press('Enter')
                offline_text = '未提交草稿恢复 ' + run_id
                page.get_by_label('文字内容', exact=True).fill(offline_text)
                page.get_by_role('button', name='保存', exact=True).click()
                expect(page.locator('.ed-service-error')).to_be_visible()
                wait_for_cached_text(page, cache_key, offline_text)
                assert aborted, 'Transport-failure injection was not exercised'
                assert api('/projects/' + pid)['design'] == baseline['design']
                page.reload(wait_until='domcontentloaded')
                expect(page.get_by_role('button', name='选中文字：' + offline_text, exact=True)).to_be_visible(timeout=20000)
                assert api('/projects/' + pid)['revision'] == baseline['revision']
                page.unroute(route_pattern, abort_save)
                restored = save_and_read(page, pid)
                assert any(n.get('text') == offline_text for n in restored['nodes'])
                expect(page.locator('.ed-service-error')).to_have_count(0)
                check('indexeddb-unsent-draft-refresh-and-online-sync', {'projectId': pid, 'baseRevision': baseline['revision'], 'faultInjection': 'route.abort PATCH before server receipt', 'abortedRequests': len(aborted)})
                capture(page, '03-indexeddb-recovered')
            except Exception as error:
                fail('indexeddb-unsent-draft-refresh-recovery', error)

            try:
                offline_project = create_project('offline-network')
                open_editor(page, offline_project)
                pid = offline_project['id']
                cache_key = pid + ':' + offline_project['documentId']
                baseline = api('/projects/' + pid)
                page.get_by_role('button', name='选中文字：编辑器验收文字', exact=True).press('Enter')
                context.set_offline(True)
                navigator_online = page.evaluate('navigator.onLine')
                assert navigator_online is False
                offline_text = '断网请求结果保留 ' + run_id
                page.get_by_label('文字内容', exact=True).fill(offline_text)
                page.get_by_role('button', name='保存', exact=True).click()
                expect(page.locator('.ed-service-error')).to_be_visible()
                wait_for_cached_text(page, cache_key, offline_text)
                try:
                    page.reload(wait_until='domcontentloaded', timeout=15000)
                except Error as error:
                    assert any(code in str(error) for code in ['ERR_INTERNET_DISCONNECTED', 'ERR_NETWORK_CHANGED', 'ERR_FAILED']), str(error)
                page.close()
                before_reopen = api('/projects/' + pid)
                context.set_offline(False)
                page = new_page()
                page.goto(args.base_url + '/#editor/' + pid, wait_until='domcontentloaded')
                expect(page.get_by_role('button', name='选中文字：' + offline_text, exact=True)).to_be_visible(timeout=20000)
                committed = before_reopen['revision'] != baseline['revision']
                if committed:
                    # A failed response is not proof of a failed commit. The
                    # browser's localhost offline emulation may still let an
                    # in-flight request reach the server. Do not overwrite it.
                    expect(page.get_by_role('button', name='将我的修改另存副本', exact=True)).to_be_visible()
                    assert any(n.get('text') == offline_text for n in before_reopen['design']['nodes'])
                    assert api('/projects/' + pid)['design'] == before_reopen['design']
                    outcome = 'server committed despite failed response; local content restored with conservative conflict'
                else:
                    restored = save_and_read(page, pid)
                    assert any(n.get('text') == offline_text for n in restored['nodes'])
                    outcome = 'server unchanged; local content restored and synced'
                check('real-offline-refresh-keeps-content-with-uncertain-commit-handling', {'projectId': pid, 'navigatorOnlineDuringFailure': navigator_online, 'baseRevision': baseline['revision'], 'serverRevisionBeforeReopen': before_reopen['revision'], 'outcome': outcome})
                capture(page, '04-offline-network-outcome')
            except Exception as error:
                context.set_offline(False)
                fail('real-offline-refresh-content-preservation', error)
            finally:
                context.set_offline(False)
                if page.is_closed():
                    page = new_page()

            try:
                concurrent = create_project('concurrency')
                pid = concurrent['id']
                open_editor(page, concurrent)
                second = new_page()
                open_editor(second, concurrent)
                server_text = '第一页已保存 ' + run_id
                local_text = '第二页保留修改 ' + run_id
                page.get_by_role('button', name='选中文字：编辑器验收文字', exact=True).press('Enter')
                page.get_by_label('文字内容', exact=True).fill(server_text)
                first = save_and_read(page, pid)
                second.get_by_role('button', name='选中文字：编辑器验收文字', exact=True).press('Enter')
                second.get_by_label('文字内容', exact=True).fill(local_text)
                with second.expect_response(lambda r: r.status == 409 and r.url.endswith('/api/projects/' + pid)):
                    second.get_by_role('button', name='保存', exact=True).click()
                expect(second.get_by_role('button', name='将我的修改另存副本', exact=True)).to_be_visible()
                expect(second.get_by_label('文字内容', exact=True)).to_have_value(local_text)
                assert api('/projects/' + pid)['design'] == first
                second.reload(wait_until='domcontentloaded')
                expect(second.get_by_role('button', name='将我的修改另存副本', exact=True)).to_be_visible()
                expect(second.get_by_role('button', name='选中文字：' + local_text, exact=True)).to_be_visible()
                assert api('/projects/' + pid)['design'] == first
                capture(second, '05-two-tab-conflict-reloaded')
                second.get_by_role('button', name='将我的修改另存副本', exact=True).click()
                expect(second.get_by_text('已将你的修改另存为副本', exact=True)).to_be_visible()
                copies = [p for p in api('/projects') if p['id'] != pid and p['title'] == concurrent['title'] + ' · 副本']
                assert len(copies) == 1 and any(n.get('text') == local_text for n in copies[0]['design']['nodes'])
                assert api('/projects/' + pid)['design'] == first
                report['projects'].append(copies[0]['id'])
                check('two-tabs-409-keeps-local-content-through-refresh-and-save-copy', {'originalProjectId': pid, 'copyProjectId': copies[0]['id']})
                capture(second, '06-conflict-preserved-as-copy')
                second.close()
            except Exception as error:
                fail('two-tab-optimistic-conflict', error)

            if report['pageErrors'] or report['serverErrors']:
                raise AssertionError({'pageErrors': report['pageErrors'], 'serverErrors': report['serverErrors']})
            check('no-uncaught-browser-errors-or-server-5xx')
        except Exception as error:
            fail('startup-or-browser-health', error)
        finally:
            context.set_offline(False)
            context.tracing.stop(path=str(output / 'trace.zip'))
            context.close()
            browser.close()
            report['status'] = 'failed' if any(c['status'] == 'failed' for c in report['checks']) else 'passed'
            (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
            print('Report: ' + str(output / 'report.json'), flush=True)
    return 1 if report['status'] == 'failed' else 0


if __name__ == '__main__':
    raise SystemExit(main())
