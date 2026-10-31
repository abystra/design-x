#!/usr/bin/env python3
"""Regress a real 200-Artboard Board, including objects outside the DOM.

Seed with scripts/seed-board-performance.py first. Run sequentially with the
performance benchmark: this suite temporarily changes and finally restores the
dedicated fixture. HTTP responses and stored documents are never mocked.
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

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
MOD = 'Meta' if sys.platform == 'darwin' else 'Control'


def organization(snapshot):
    return {
        'results': [{'id': r['id'], 'position': r['position']} for r in snapshot['results']],
        'notes': snapshot.get('notes', []), 'sections': snapshot.get('sections', []),
    }


def items(snapshot):
    return {item['id']: item for key in ('results', 'notes', 'sections') for item in snapshot[key]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--account-file', type=Path, required=True)
    parser.add_argument('--base-url', default='http://127.0.0.1:5173')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    assert args.account_file.stat().st_mode & 0o077 == 0, 'Fixture credentials must be private (0600)'
    account = json.loads(args.account_file.read_text())
    pid = account['projectId']
    output = args.output or ROOT / 'tests/e2e/.artifacts' / ('virtualization-' + time.strftime('%Y%m%d-%H%M%S'))
    output.mkdir(parents=True, exist_ok=True)
    executable = os.getenv('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH') or subprocess.check_output(
        ['node', '-e', 'import("playwright").then(p=>console.log(p.chromium.executablePath()))'], cwd=ROOT, text=True).strip()
    report = {'mocked': False, 'projectId': pid, 'checks': [], 'pageErrors': [], 'httpErrors': [], 'artifacts': []}
    original = None
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, executable_path=executable)
        context = browser.new_context(viewport={'width': 1440, 'height': 900}, device_scale_factor=1)
        context.tracing.start(screenshots=True, snapshots=True, sources=False)
        page = context.new_page()
        page.set_default_timeout(15000)
        page.on('pageerror', lambda e: report['pageErrors'].append(str(e)))
        page.on('response', lambda r: report['httpErrors'].append({'status': r.status, 'url': r.url}) if r.status >= 400 else None)
        page.on('dialog', lambda d: d.accept())

        def api(path, method='GET', data=None):
            response = context.request.fetch(args.base_url + '/api' + path, method=method, data=data,
                headers={'Origin': args.base_url, 'X-Requested-With': 'Design-X'})
            assert response.ok, f'{method} {path}: {response.status} {response.text()[:300]}'
            return response.json()

        def board():
            return api('/projects/' + pid + '/studio')

        def wait_state(predicate, timeout=25):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                current = board()
                if predicate(current['snapshot']):
                    return current['snapshot']
                page.wait_for_timeout(400)
            raise AssertionError('Persisted Board did not reach expected state')

        def check(name, details=None):
            report['checks'].append({'name': name, 'status': 'passed', 'details': details})
            print('PASS ' + name, flush=True)

        def capture(name):
            page.screenshot(path=str(output / (name + '.png')))
            report['artifacts'].append(name + '.png')

        def reset(view=None):
            # Unmount before changing the fixture to avoid a deliberately stale
            # client racing the test setup's revision-protected API write.
            page.goto('about:blank')
            state = board()
            snapshot = copy.deepcopy(original)
            snapshot.update({'view': view or account['view'], 'selection': [], 'selected': None})
            snapshot['results'] = [{k: v for k, v in r.items() if k not in ('design', 'revision')} for r in snapshot['results']]
            api('/projects/' + pid + '/studio?response=ack', 'PUT', {'snapshot': snapshot, 'baseRevision': state['revision']})
            page.goto(args.base_url + '/#studio/' + pid, wait_until='domcontentloaded')
            page.get_by_label('当前创作名称', exact=True).wait_for()
            if page.get_by_role('button', name='关闭侧边面板', exact=True).count():
                page.get_by_role('button', name='关闭侧边面板', exact=True).click()
            page.wait_for_function('document.fonts.status === "loaded"')
            page.locator('.st-result').first.wait_for()

        def mounted():
            return page.locator('.st-result').count()

        def exposed_point(locator):
            # A section header can overlap Artboard titles; use real hit-testing
            # so the test never silently drags a different object above it.
            point = locator.evaluate('''el => {
              const r=el.getBoundingClientRect(),c=document.querySelector('.st-canvas').getBoundingClientRect();
              for(let y=Math.max(r.top+3,c.top+65);y<Math.min(r.bottom-2,c.bottom-75);y+=5)
                for(let x=Math.max(r.left+3,c.left+8);x<Math.min(r.right-2,c.right-250);x+=8){
                  const hit=document.elementFromPoint(x,y);
                  if(hit&&(hit===el||el.contains(hit))&&!hit.closest('button,input,textarea'))return {x,y};
                }
              return null;
            }''')
            assert point, 'No exposed non-button drag surface: ' + str(locator)
            return point['x'], point['y']

        def flush():
            page.keyboard.press(MOD + '+s')
            expect(page.locator('.st-board-actions [role=status]')).to_have_text('已保存到工作空间', timeout=25000)

        def undo_to(expected):
            page.get_by_role('button', name='撤销画布操作', exact=True).click()
            return wait_state(lambda s: organization(s) == expected)

        stage = 'setup'
        try:
            api('/auth/login', 'POST', {'email': account['email'], 'password': account['password']})
            original = board()['snapshot']
            assert len(original['results']) == 200
            original_org = organization(original)
            original_designs = {r['id']: r['design'] for r in original['results']}
            first, last = original['results'][0], original['results'][-1]
            reset()
            assert 0 < mounted() < 50, f'Initial mounted count: {mounted()}'
            expect(page.locator('[data-board-id="' + last['id'] + '"]')).to_have_count(0)
            check('only-visible-and-overscan-artboards-mount', {'mounted': mounted(), 'total': 200})
            capture('01-initial-virtualized')

            stage = 'fit-all-and-changing-render-target'
            page.get_by_role('button', name='适应所有方案', exact=True).click()
            page.wait_for_function('document.querySelector(".st-world").dataset.renderPending === "0"')
            world = page.locator('.st-world')
            assert world.get_attribute('data-rendered-items') == world.get_attribute('data-render-target-count')
            canvas = page.locator('.st-canvas').bounding_box()
            view = world.evaluate('el=>{const m=new DOMMatrix(getComputedStyle(el).transform);return {x:m.e,y:m.f,zoom:m.a}}')
            actual = set(page.locator('.st-result').evaluate_all('(els)=>els.map(e=>e.dataset.boardId)'))
            visible = {r['id'] for r in original['results']
                if view['x'] + r['position']['x'] * view['zoom'] < canvas['width']
                and view['x'] + (r['position']['x'] + 260) * view['zoom'] > 0
                and view['y'] + r['position']['y'] * view['zoom'] < canvas['height']
                and view['y'] + (r['position']['y'] + 260 * r['design']['height'] / r['design']['width']) * view['zoom'] > 0}
            assert visible <= actual and len(visible) > 50
            # The target changes while an overview may be rendering. Returning
            # to a close view must discard pending offscreen work.
            for _ in range(6):
                page.get_by_role('button', name='放大画布', exact=True).click()
            page.get_by_role('button', name='适应所有方案', exact=True).click()
            for _ in range(8):
                page.get_by_role('button', name='放大画布', exact=True).click()
            page.wait_for_function('document.querySelector(".st-world").dataset.renderPending === "0"')
            assert world.get_attribute('data-rendered-items') == world.get_attribute('data-render-target-count')
            assert 0 < mounted() < 50
            check('overview-finishes-real-rendering-and-new-viewport-cancels-stale-mounts', {'overviewVisibleArtboards': len(visible)})
            flush()
            reset()

            stage = 'full-data-selection-and-history'
            page.get_by_role('button', name='选择与移动方案', exact=True).click()
            page.locator('.st-design-select').first.click()
            page.keyboard.press(MOD + '+a')
            expect(page.locator('.st-item-inspector')).to_contain_text('已选 320 项')
            assert mounted() < 50, 'Selecting all must not mount all selected objects'
            page.keyboard.press('Shift+ArrowRight')
            moved = wait_state(lambda s: s['results'][-1]['position']['x'] == last['position']['x'] + 10)
            before_items, after_items = items(original), items(moved)
            for identifier, before in before_items.items():
                assert after_items[identifier]['position'] == {'x': before['position']['x'] + 10, 'y': before['position']['y']}, identifier
            assert {r['id']: r['design'] for r in moved['results']} == original_designs
            check('select-all-moves-all-320-items-once-with-offscreen-members')
            undo_to(original_org)
            page.get_by_role('button', name='重做画布操作', exact=True).click()
            wait_state(lambda s: organization(s) == organization(moved))
            undo_to(original_org)
            check('large-board-undo-redo-preserves-all-designs-and-memberships')

            stage = 'offscreen-delete-and-undo'
            page.get_by_role('button', name='删除选中内容', exact=True).click()
            wait_state(lambda s: not s['results'] and not s['notes'] and not s['sections'])
            restored = undo_to(original_org)
            assert {r['id']: r['design'] for r in restored['results']} == original_designs
            assert 0 < mounted() < 50
            check('delete-all-and-undo-restore-offscreen-artboards-notes-sections')

            stage = 'section-drag-offscreen-members'
            reset()
            section = original['sections'][0]
            grip = page.locator('[data-board-id="' + section['id'] + '"] .st-section-grip')
            x, y = exposed_point(grip)
            gesture_saves = []
            def count_gesture_saves(request):
                if request.method == 'PUT' and '/studio' in request.url:
                    gesture_saves.append(request.url)
            page.on('request', count_gesture_saves)
            page.mouse.move(x, y)
            page.mouse.down()
            page.mouse.move(x + 25, y + 15, steps=5)
            page.wait_for_timeout(900)
            assert not gesture_saves, 'Autosave must not interrupt a pointer gesture'
            assert organization(board()['snapshot']) == original_org
            page.mouse.move(x + 75, y + 45, steps=12)
            page.mouse.up()
            dragged = wait_state(lambda s: s['sections'][0]['position']['x'] == section['position']['x'] + 100)
            affected = {section['id'], *section['itemIds']}
            for identifier, before in items(original).items():
                expected = {'x': before['position']['x'] + 100, 'y': before['position']['y'] + 60} if identifier in affected else before['position']
                assert items(dragged)[identifier]['position'] == expected, identifier
            assert mounted() < 50
            assert len(gesture_saves) == 1, 'A completed drag should produce one settled save'
            page.remove_listener('request', count_gesture_saves)
            check('section-drag-updates-offscreen-members-without-mounting-all')
            check('long-drag-defers-autosave-until-pointer-release')
            undo_to(original_org)

            stage = 'cancelled-pointer-cleanup'
            note = original['notes'][0]
            handle = page.locator('[data-board-id="' + note['id'] + '"] .st-note-content')
            x, y = exposed_point(handle)
            page.mouse.move(x, y)
            page.mouse.down()
            page.mouse.move(x + 60, y + 30, steps=8)
            # A real browser pointer gesture followed by the platform's cancel
            # event; no HTTP fault or fabricated response is involved.
            page.locator('.st-canvas').dispatch_event('pointercancel', {'pointerId': 1, 'bubbles': True})
            page.mouse.up()
            cancelled = wait_state(lambda s: s['notes'][0]['position']['x'] == note['position']['x'] + 80)
            assert cancelled['notes'][0]['position']['y'] == note['position']['y'] + 40
            undo_to(original_org)
            check('pointer-cancel-commits-visible-position-once-and-releases-gesture')

            stage = 'keyboard-during-active-drag'
            handle = page.locator('[data-board-id="' + note['id'] + '"] .st-note-content')
            for command in ('Delete', MOD + '+z'):
                x, y = exposed_point(handle)
                page.mouse.move(x, y)
                page.mouse.down()
                page.mouse.move(x + 60, y + 30, steps=8)
                page.keyboard.press(command)
                page.mouse.up()
                if command == 'Delete':
                    deleted = wait_state(lambda s: all(n['id'] != note['id'] for n in s['notes']))
                    assert len(deleted['notes']) == 99
                    # The first undo restores the deleted note at the settled
                    # drag position; the second undo restores the drag itself.
                    page.get_by_role('button', name='撤销画布操作', exact=True).click()
                    wait_state(lambda s: len(s['notes']) == 100 and s['notes'][0]['position']['x'] == note['position']['x'] + 80)
                    undo_to(original_org)
                else:
                    page.wait_for_timeout(800)
                    assert organization(board()['snapshot']) == original_org
            check('delete-and-undo-during-drag-cannot-resurrect-stale-organization')

            stage = 'pan-capture-survives-virtual-unmount'
            reset()
            page.get_by_role('button', name='拖动画布', exact=True).click()
            origin_label = page.locator('[data-board-id="' + first['id'] + '"] .st-result-label > span')
            bounds = origin_label.bounding_box()
            assert bounds
            x, y = bounds['x'] + bounds['width'] - 4, bounds['y'] + bounds['height'] / 2
            page.mouse.move(x, y)
            page.mouse.down()
            page.mouse.move(5, 500, steps=20)
            expect(page.locator('[data-board-id="' + first['id'] + '"]')).to_have_count(0)
            page.mouse.move(150, 540, steps=10)
            page.mouse.up()
            expected_view = {'x': account['view']['x'] + 150 - x, 'y': account['view']['y'] + 540 - y, 'zoom': .75}
            wait_state(lambda s: all(abs(s['view'][key] - value) < .01 for key, value in expected_view.items()))
            check('pan-continues-after-its-origin-artboard-is-virtualized-away')

            stage = 'pan-and-reopen'
            reset()
            initial_ids = set(page.locator('.st-result').evaluate_all('(els)=>els.map(e=>e.dataset.boardId)'))
            page.get_by_role('button', name='拖动画布', exact=True).click()
            for _ in range(3):
                point = page.locator('.st-canvas').evaluate('''el => {
                  const r=el.getBoundingClientRect();
                  for(let y=r.bottom-120;y>r.bottom-230;y-=8)
                    for(let x=r.right-100;x>r.right-250;x-=8){
                      const hit=document.elementFromPoint(x,y);
                      if(hit&&el.contains(hit)&&!hit.closest('button,input,textarea,.st-item-inspector'))return {x,y};
                    }
                  return null;
                }''')
                assert point
                page.mouse.move(point['x'], point['y'])
                page.mouse.down()
                page.mouse.move(point['x'] - 520, point['y'] - 440, steps=20)
                page.mouse.up()
            pan_state = wait_state(lambda s: s['view']['y'] < -1000)
            current_ids = set(page.locator('.st-result').evaluate_all('(els)=>els.map(e=>e.dataset.boardId)'))
            assert current_ids and current_ids != initial_ids and mounted() < 50
            assert len(pan_state['results']) == 200
            assert organization(pan_state) == original_org
            flush()
            page.reload(wait_until='domcontentloaded')
            page.get_by_label('当前创作名称', exact=True).wait_for()
            page.wait_for_function('(ids)=>ids.every(id=>document.querySelector(`[data-board-id="${id}"]`))', arg=list(current_ids))
            check('pan-swaps-visible-dom-and-persists-viewport-with-all-data-intact', {'mounted': mounted(), 'view': pan_state['view']})

            stage = 'far-artboard-and-editor-return'
            reset({'x': 60 - last['position']['x'] * .75, 'y': 110 - last['position']['y'] * .75, 'zoom': .75})
            far = page.locator('[data-board-id="' + last['id'] + '"]')
            expect(far).to_be_visible()
            expect(far.locator('.st-result-label')).to_contain_text('200 /')
            expect(far.locator('[data-node-id]')).to_have_count(account['nodesPerBoard'])
            expect(page.locator('[data-board-id="' + first['id'] + '"]')).to_have_count(0)
            far.locator('.st-design-select').dblclick()
            page.get_by_label('作品名称', exact=True).wait_for()
            expect(page.locator('.ed-node')).to_have_count(account['nodesPerBoard'])
            page.get_by_role('button', name='返回工作区', exact=True).click()
            expect(page.locator('[data-board-id="' + last['id'] + '"]')).to_be_visible()
            assert organization(board()['snapshot']) == original_org
            check('far-artboard-keeps-global-number-and-real-renderer-editor-return')
            capture('02-far-artboard')

            stage = 'project-reopen-request-budget'
            page.get_by_role('button', name='工作空间', exact=True).click()
            page.get_by_role('navigation', name='主导航').wait_for()
            reads = []
            def count_board_reads(request):
                if request.method == 'GET' and request.url.endswith('/api/projects/' + pid + '/studio'):
                    reads.append(request.url)
            page.on('request', count_board_reads)
            page.locator('.home-projects button').filter(has_text=original['title']).click()
            page.get_by_label('当前创作名称', exact=True).wait_for()
            assert len(reads) == 1, f'Opening a project fetched the full Board {len(reads)} times'
            page.remove_listener('request', count_board_reads)
            check('project-reopen-fetches-full-board-once')
            assert not report['pageErrors'] and not report['httpErrors'], report
            report['status'] = 'passed'
        except Exception as error:
            report.update({'status': 'failed', 'failureStage': stage, 'error': str(error), 'traceback': traceback.format_exc()})
            print('FAIL ' + stage + ': ' + str(error), flush=True)
            try:
                capture('failure-' + stage)
                (output / 'failure.txt').write_text(page.locator('body').inner_text())
            except Exception:
                pass
        finally:
            try:
                page.goto('about:blank')
                if original:
                    current = board()
                    clean = copy.deepcopy(original)
                    clean['results'] = [{k: v for k, v in r.items() if k not in ('design', 'revision')} for r in clean['results']]
                    api('/projects/' + pid + '/studio?response=ack', 'PUT', {'snapshot': clean, 'baseRevision': current['revision']})
                    report['fixtureRestored'] = True
            except Exception as error:
                report.update({'fixtureRestored': False, 'restoreError': str(error), 'status': 'failed'})
            context.tracing.stop(path=str(output / 'trace.zip'))
            browser.close()
            (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print('REPORT ' + str(output / 'report.json'), flush=True)
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
