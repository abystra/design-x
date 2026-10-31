#!/usr/bin/env python3
"""Verify real Board notes, sections, organization history and project downloads.

Requires the running web/API/worker/renderer stack. Uses isolated real accounts,
without fabricated API responses or persisted authentication storage.
"""
from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import traceback
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]


def organization(snapshot):
    return {
        'results': [{'id': r['id'], 'position': r['position']} for r in snapshot['results']],
        'notes': snapshot.get('notes', []),
        'sections': snapshot.get('sections', []),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default=os.getenv('DESIGNX_E2E_URL', 'http://127.0.0.1:5173'))
    parser.add_argument('--output', type=Path)
    parser.add_argument('--core', action='store_true', help='Run only initial note/section persistence checks; reports partial.')
    args = parser.parse_args()
    run_id = time.strftime('%Y%m%d-%H%M%S') + '-' + uuid4().hex[:6]
    output = args.output or ROOT / 'tests/e2e/.artifacts' / ('board-' + run_id)
    output.mkdir(parents=True, exist_ok=True)
    executable = os.getenv('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH') or subprocess.check_output(
        ['node', '-e', 'import("playwright").then(p=>console.log(p.chromium.executablePath()))'], cwd=ROOT, text=True).strip()
    report = {'runId': run_id, 'baseUrl': args.base_url, 'mocked': False, 'checks': [], 'pageErrors': [], 'serverErrors': [], 'expected409s': [], 'artifacts': []}

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, executable_path=executable)
        context = browser.new_context(viewport={'width': 1600, 'height': 1050}, accept_downloads=True)
        context.tracing.start(screenshots=True, snapshots=True, sources=False)
        page = context.new_page()
        page.set_default_timeout(15000)
        page.on('pageerror', lambda e: report['pageErrors'].append(str(e)))
        def received(response):
            if response.status >= 500:
                report['serverErrors'].append({'url': response.url, 'status': response.status})
            if response.status == 409:
                report['expected409s'].append({'url': response.url, 'status': response.status})
        page.on('response', received)
        page.on('dialog', lambda dialog: dialog.accept())

        def api(path, method='GET', data=None):
            response = context.request.fetch(args.base_url + '/api' + path, method=method, data=data,
                headers={'Origin': args.base_url, 'X-Requested-With': 'Design-X'})
            assert response.ok, f'{method} {path}: {response.status} {response.text()[:300]}'
            return response.json()

        def check(name, details=None):
            report['checks'].append({'name': name, 'status': 'passed', 'details': details})
            print('PASS ' + name, flush=True)

        def capture(name):
            page.screenshot(path=str(output / (name + '.png')), full_page=True)
            report['artifacts'].append(name + '.png')

        def board():
            return api('/projects/' + pid + '/studio')

        def wait_board(predicate, timeout=20):
            deadline = time.monotonic() + timeout
            latest = None
            while time.monotonic() < deadline:
                latest = board()
                if predicate(latest['snapshot']):
                    return latest
                page.wait_for_timeout(100)
            raise AssertionError('Board condition not reached: ' + json.dumps(latest, ensure_ascii=False)[:2500])

        def flush():
            page.keyboard.press('Meta+s' if sys.platform == 'darwin' else 'Control+s')
            expect(page.locator('.st-board-actions [role=status]')).to_have_text('已保存到工作空间', timeout=20000)

        def open_board():
            page.goto(args.base_url + '/#studio/' + pid, wait_until='domcontentloaded')
            page.get_by_label('当前创作名称', exact=True).wait_for()
            if page.get_by_role('button', name='关闭侧边面板', exact=True).count():
                page.get_by_role('button', name='关闭侧边面板', exact=True).click()
            page.wait_for_function('document.fonts.status === "loaded"')

        def select(identifier, shift=False):
            locator = page.locator('[data-board-id="' + identifier + '"]')
            locator.locator('button').first.click(modifiers=['Shift'] if shift else [])

        def field(label, value):
            page.get_by_label(label, exact=True).fill(str(value))
            page.get_by_label(label, exact=True).press('Tab')

        def current_item(snapshot, identifier):
            return next(item for kind in ('results', 'notes', 'sections') for item in snapshot.get(kind, []) if item['id'] == identifier)

        def drag(identifier, grip, dx, dy):
            zoom = page.evaluate('''() => {
                const native = document.querySelector('.dx-board-diagnostics');
                return native ? Number(native.dataset.cameraZoom)
                    : new DOMMatrix(getComputedStyle(document.querySelector('.st-world')).transform).a;
            }''')
            handle = page.locator('[data-board-id="' + identifier + '"] ' + grip)
            bounds = handle.bounding_box()
            assert bounds, 'Drag handle missing'
            x, y = bounds['x'] + bounds['width'] / 2, bounds['y'] + bounds['height'] / 2
            page.mouse.move(x, y)
            page.mouse.down()
            page.mouse.move(x + dx * zoom, y + dy * zoom, steps=12)
            page.mouse.up()

        def history_roundtrip(before, after, name):
            page.get_by_role('button', name='撤销画布操作', exact=True).click()
            wait_board(lambda s: organization(s) == before)
            page.get_by_role('button', name='重做画布操作', exact=True).click()
            wait_board(lambda s: organization(s) == after)
            check(name)

        stage = 'setup'
        try:
            api('/auth/register', 'POST', {'email': 'board-' + run_id + '@example.test', 'password': uuid4().hex, 'name': 'Board 验收'})
            design = {'width': 400, 'height': 300, 'background': '#f6f1e5', 'nodes': [
                {'id': 'heading', 'type': 'text', 'text': 'Board 持久化基准', 'x': 25, 'y': 40, 'w': 330, 'h': 90, 'size': 26, 'color': '#24362b'}]}
            project = api('/projects', 'POST', {'title': 'Board 验收 ' + run_id, 'design': design})
            pid = project['id']
            aid = project['documentId']
            report['projectId'] = pid
            open_board()
            capture('01-initial')
            check('real-account-project-and-board-loaded')

            stage = 'note-properties'
            page.get_by_role('button', name='添加便签', exact=True).click()
            page.get_by_label('便签内容', exact=True).fill('真实便签第一行\n保留中文与换行 ' + run_id)
            field('便签宽度', 320)
            field('便签高度', 240)
            page.get_by_label('便签颜色', exact=True).fill('#cce8df')
            saved = wait_board(lambda s: len(s.get('notes', [])) == 1 and s['notes'][0]['width'] == 320 and s['notes'][0]['height'] == 240 and s['notes'][0]['color'] == '#CCE8DF')
            nid = saved['snapshot']['notes'][0]['id']
            assert saved['snapshot']['notes'][0]['text'] == '真实便签第一行\n保留中文与换行 ' + run_id
            check('note-text-size-color-persist', {'noteId': nid})

            stage = 'section-create'
            page.get_by_role('button', name='用选中内容创建分区', exact=True).click()
            page.get_by_label('分区标题', exact=True).fill('已保存分区 ' + run_id)
            saved = wait_board(lambda s: len(s.get('sections', [])) == 1 and s['sections'][0]['title'] == '已保存分区 ' + run_id)
            sid = saved['snapshot']['sections'][0]['id']
            assert saved['snapshot']['sections'][0]['itemIds'] == [nid]
            check('create-section-with-explicit-note-member', {'sectionId': sid})

            stage = 'membership'
            page.get_by_role('button', name='适应所有方案', exact=True).click()
            select(aid)
            page.get_by_label('目标分区', exact=True).select_option(sid)
            page.get_by_role('button', name='加入目标分区', exact=True).click()
            wait_board(lambda s: set(s['sections'][0]['itemIds']) == {nid, aid})
            page.get_by_role('button', name='从分区移出选中内容', exact=True).click()
            wait_board(lambda s: s['sections'][0]['itemIds'] == [nid])
            page.get_by_role('button', name='加入目标分区', exact=True).click()
            saved = wait_board(lambda s: set(s['sections'][0]['itemIds']) == {nid, aid})
            check('member-join-remove-and-rejoin-persist')

            stage = 'reload'
            expected = organization(saved['snapshot'])
            flush()
            open_board()
            actual = organization(board()['snapshot'])
            assert actual == expected
            expect(page.locator('.st-note')).to_have_count(1)
            expect(page.locator('.st-section')).to_have_count(1)
            capture('02-core-reopened')
            check('notes-sections-and-members-survive-refresh')

            if args.core:
                report['status'] = 'partial'
            else:
                stage = 'section-member-drag-deduplication'
                page.get_by_role('button', name='适应所有方案', exact=True).click()
                select(sid)
                select(nid, shift=True)
                expect(page.locator('.st-section.is-selected')).to_have_count(1)
                expect(page.locator('.st-note.is-selected')).to_have_count(1)
                before = organization(board()['snapshot'])
                drag(sid, '.st-section-grip', 80, 50)
                moved = wait_board(lambda s: current_item(s, sid)['position']['x'] == current_item(before, sid)['position']['x'] + 80)['snapshot']
                for identifier in (sid, nid, aid):
                    old = current_item(before, identifier)['position']
                    new = current_item(moved, identifier)['position']
                    assert new == {'x': old['x'] + 80, 'y': old['y'] + 50}, (identifier, old, new)
                after = organization(moved)
                check('section-plus-explicit-member-moves-each-item-once')
                history_roundtrip(before, after, 'section-drag-undo-redo-exact-organization')

                stage = 'independent-member-move-and-detach'
                select(nid)
                before = organization(board()['snapshot'])
                drag(nid, '.st-note-header > span', -40, 30)
                changed = wait_board(lambda s: current_item(s, nid)['position']['x'] == current_item(before, nid)['position']['x'] - 40)['snapshot']
                assert current_item(changed, nid)['position']['y'] == current_item(before, nid)['position']['y'] + 30
                assert current_item(changed, sid) == current_item(before, sid)
                assert current_item(changed, aid)['position'] == current_item(before, aid)['position']
                page.get_by_role('button', name='从分区移出选中内容', exact=True).click()
                wait_board(lambda s: current_item(s, sid)['itemIds'] == [aid])
                page.get_by_role('button', name='加入目标分区', exact=True).click()
                wait_board(lambda s: set(current_item(s, sid)['itemIds']) == {aid, nid})
                check('member-move-is-independent-and-membership-is-explicit')

                stage = 'mixed-selection-copy-mapping'
                page.get_by_role('button', name='适应所有方案', exact=True).click()
                select(sid)
                select(nid, shift=True)
                before = organization(board()['snapshot'])
                page.get_by_role('button', name='复制选中内容', exact=True).click()
                copied = wait_board(lambda s: len(s['sections']) == 2 and len(s['notes']) == 2 and len(s['results']) == 2, timeout=40)['snapshot']
                new_section = next(s for s in copied['sections'] if s['id'] != sid)
                new_note = next(n for n in copied['notes'] if n['id'] != nid)
                new_artboard = next(a for a in copied['results'] if a['id'] != aid)
                all_ids = [i['id'] for k in ('results', 'notes', 'sections') for i in copied[k]]
                assert len(all_ids) == len(set(all_ids))
                assert set(new_section['itemIds']) == {new_note['id'], new_artboard['id']}
                assert set(new_section['itemIds']).isdisjoint({aid, nid})
                assert set(current_item(copied, sid)['itemIds']) == {aid, nid}
                for old_id, new in ((sid, new_section), (nid, new_note), (aid, new_artboard)):
                    old = current_item(before, old_id)
                    assert new['position'] == {'x': old['position']['x'] + 40, 'y': old['position']['y'] + 40}
                assert new_note['text'] == current_item(before, nid)['text']
                assert new_artboard['design'] == design
                assert api('/documents/' + new_artboard['id'])['content'] == design
                check('mixed-section-member-copy-uses-new-ids-and-remapped-members', {'sectionId': new_section['id'], 'noteId': new_note['id'], 'artboardId': new_artboard['id']})
                history_roundtrip(before, organization(copied), 'copy-undo-redo-exact-membership-and-positions')

                stage = 'delete-section-retains-members'
                select(new_section['id'])
                before = organization(board()['snapshot'])
                page.get_by_role('button', name='删除选中内容', exact=True).click()
                removed = wait_board(lambda s: len(s['sections']) == 1)['snapshot']
                assert {r['id'] for r in removed['results']} == {aid, new_artboard['id']}
                assert {n['id'] for n in removed['notes']} == {nid, new_note['id']}
                assert removed['sections'][0]['id'] == sid
                check('delete-section-retains-unselected-artboard-and-note')
                history_roundtrip(before, organization(removed), 'delete-section-undo-redo-preserves-content')
                flush()
                persisted = organization(board()['snapshot'])
                open_board()
                assert organization(board()['snapshot']) == persisted
                expect(page.locator('.st-note')).to_have_count(2)
                expect(page.locator('.st-section')).to_have_count(1)
                capture('03-organized-reopened')
                check('expanded-organization-survives-refresh')

                stage = 'portable-project-download'
                flush()
                export_baseline = organization(board()['snapshot'])
                with page.expect_download(timeout=90000) as downloaded:
                    page.get_by_role('button', name='导出项目包', exact=True).click()
                download = downloaded.value
                assert download.failure() is None
                archive = output / 'board.dxproj'
                download.save_as(str(archive))
                packet = json.loads(archive.read_text())
                assert packet['format'] == 'designx.project' and packet['schemaVersion'] == 1
                exported_board = next(d['content'] for d in packet['documents'] if d['kind'] == 'board')
                assert organization(exported_board) == export_baseline
                document_ids = {d['id'] for d in packet['documents'] if d['kind'] == 'artboard'}
                assert {aid, new_artboard['id']}.issubset(document_ids)
                jobs = api('/jobs?projectId=' + pid)
                completed = [j for j in jobs if j['kind'] == 'render.export' and j['status'] == 'succeeded' and j.get('result', {}).get('format') == 'dxproj']
                assert completed
                report['artifacts'].append(archive.name)
                check('browser-downloads-real-dxproj-with-notes-sections-and-documents', {'bytes': archive.stat().st_size, 'jobId': completed[0]['id']})

                stage = 'board-409-preserves-local-draft'
                page.get_by_role('button', name='适应所有方案', exact=True).click()
                select(nid)
                flush()
                # Wait for the last local selection/view save before an independent
                # real API client creates a competing revision.
                page.wait_for_timeout(900)
                remote = board()
                remote_snapshot = copy.deepcopy(remote['snapshot'])
                remote_text = '服务器已提交的便签 ' + run_id
                current_item(remote_snapshot, nid)['text'] = remote_text
                remote_saved = api('/projects/' + pid + '/studio', 'PUT', {'snapshot': remote_snapshot, 'baseRevision': remote['revision']})
                local_text = '冲突后必须保留的本地便签 ' + run_id
                with page.expect_response(lambda r: r.request.method == 'PUT' and r.url.split('?')[0].endswith('/api/projects/' + pid + '/studio') and r.status == 409, timeout=20000):
                    page.get_by_label('便签内容', exact=True).fill(local_text)
                    page.keyboard.press('Meta+s' if sys.platform == 'darwin' else 'Control+s')
                expect(page.get_by_role('button', name='放弃未保存更改并载入服务器版本', exact=True)).to_be_visible()
                expect(page.get_by_label('便签内容', exact=True)).to_have_value(local_text)
                assert board() == remote_saved
                with page.expect_download() as draft_download:
                    page.get_by_role('button', name='下载未保存草稿', exact=True).click()
                draft_file = output / 'conflict-draft.json'
                draft_download.value.save_as(str(draft_file))
                draft = json.loads(draft_file.read_text())
                assert current_item(draft, nid)['text'] == local_text
                assert organization(board()['snapshot']) == organization(remote_saved['snapshot'])
                capture('04-conflict-preserved')
                page.get_by_role('button', name='放弃未保存更改并载入服务器版本', exact=True).click()
                expect(page.get_by_label('便签内容', exact=True)).to_have_value(remote_text)
                report['artifacts'].append(draft_file.name)
                check('real-409-preserves-local-note-download-and-server-version')

                stage = 'empty-board-reopen-from-project-list'
                page.get_by_role('button', name='选择与移动方案', exact=True).click()
                page.keyboard.press('Meta+a' if sys.platform == 'darwin' else 'Control+a')
                page.get_by_role('button', name='删除选中内容', exact=True).click()
                wait_board(lambda s: not s['results'] and not s['notes'] and not s['sections'])
                page.get_by_role('button', name='工作空间', exact=True).click()
                page.get_by_role('navigation', name='主导航').get_by_role('button', name='我的项目', exact=True).click()
                page.get_by_role('button', name='打开作品 ' + project['title'], exact=True).click()
                expect(page.locator('.ai-studio')).to_be_visible()
                assert page.url.endswith('#studio/' + pid), page.url
                expect(page.locator('.st-result')).to_have_count(0)
                expect(page.locator('.st-note')).to_have_count(0)
                expect(page.locator('.st-section')).to_have_count(0)
                assert not page.locator('.editor').count()
                reopened_empty = board()['snapshot']
                assert not reopened_empty['results'] and not reopened_empty['notes'] and not reopened_empty['sections']
                assert api('/documents/' + aid)['content'] == design
                capture('05-empty-board-reopened')
                check('empty-board-reopens-as-studio-from-project-list')

                stage = 'home-handoff-persists-without-editing-board'
                if page.get_by_role('button', name='关闭侧边面板', exact=True).count():
                    page.get_by_role('button', name='关闭侧边面板', exact=True).click()
                page.get_by_role('button', name='工作空间', exact=True).click()
                prompt = '从首页交接，进入画布后不编辑即离开 ' + run_id
                page.get_by_label('描述你的设计需求', exact=True).fill(prompt)
                page.locator('.composer-tabs').get_by_role('button', name='图片生成', exact=True).click()
                page.locator('.send-button').click()
                expect(page.get_by_label('告诉 AI 你的设计需求', exact=True)).to_have_value(prompt)
                page.wait_for_url('**/#studio/*')
                handoff_id = page.url.split('#studio/')[-1]
                assert handoff_id and handoff_id != pid
                # Do not edit the Board or wait for its debounce timer: leaving
                # must flush the initial Home handoff rather than treating it
                # as an already persisted server snapshot.
                if page.get_by_role('button', name='关闭侧边面板', exact=True).count():
                    page.get_by_role('button', name='关闭侧边面板', exact=True).click()
                page.get_by_role('button', name='工作空间', exact=True).click()
                page.get_by_role('navigation', name='主导航').wait_for()
                persisted_handoff = api('/projects/' + handoff_id + '/studio')['snapshot']
                assert persisted_handoff['draft'] == prompt
                assert persisted_handoff['mode'] == '图片生成'
                page.get_by_role('navigation', name='主导航').get_by_role('button', name='我的项目', exact=True).click()
                handoff_project = api('/projects/' + handoff_id + '?view=metadata')
                page.get_by_role('button', name='打开作品 ' + handoff_project['title'], exact=True).click()
                expect(page.get_by_label('告诉 AI 你的设计需求', exact=True)).to_have_value(prompt)
                page.reload(wait_until='domcontentloaded')
                expect(page.get_by_label('告诉 AI 你的设计需求', exact=True)).to_have_value(prompt)
                assert api('/projects/' + handoff_id + '/studio')['snapshot']['mode'] == '图片生成'
                capture('06-home-handoff-reopened')
                check('home-prompt-and-mode-survive-immediate-leave-reopen-and-refresh', {'projectId': handoff_id})

                stage = 'runtime-errors'
                assert not report['pageErrors'], report['pageErrors']
                assert not report['serverErrors'], report['serverErrors']
                check('no-page-errors-or-http-5xx')
                report['status'] = 'passed'
        except Exception as error:
            report['status'] = 'failed'
            report['checks'].append({'name': stage, 'status': 'failed', 'error': str(error), 'traceback': traceback.format_exc()})
            print('FAIL ' + stage + ': ' + str(error), file=sys.stderr, flush=True)
            try:
                capture('failure-' + stage)
                (output / 'failure-dom.txt').write_text(page.locator('body').inner_text())
            except Exception:
                pass
        finally:
            context.tracing.stop(path=str(output / 'trace.zip'))
            (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
            print(json.dumps({'status': report['status'], 'checks': len(report['checks']), 'output': str(output)}, ensure_ascii=False), flush=True)
            browser.close()
    return 1 if report['status'] == 'failed' else 0


if __name__ == '__main__':
    raise SystemExit(main())
