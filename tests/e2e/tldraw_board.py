#!/usr/bin/env python3
"""Real SDK interaction checks; API fixture setup, no mocked responses.

Reuse an external 0600 performance account descriptor. Native pointer gestures
exercise the actual tldraw canvas, while persistence is verified over HTTP.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time
import traceback
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
MOD = 'Meta' if sys.platform == 'darwin' else 'Control'

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--account-file', type=Path, required=True)
    p.add_argument('--base-url', default='http://127.0.0.1:5173')
    args = p.parse_args()
    assert args.account_file.stat().st_mode & 0o077 == 0
    account = json.loads(args.account_file.read_text())
    output = ROOT / 'tests/e2e/.artifacts' / ('tldraw-' + time.strftime('%Y%m%d-%H%M%S'))
    output.mkdir(parents=True, exist_ok=True)
    report = {'mocked': False, 'checks': [], 'pageErrors': [], 'httpErrors': [], 'externalRequests': []}
    executable = subprocess.check_output(['node', '-e', 'import("playwright").then(p=>console.log(p.chromium.executablePath()))'], cwd=ROOT, text=True).strip()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, executable_path=executable)
        context = browser.new_context(viewport={'width': 1600, 'height': 1050})
        page = context.new_page()
        page.set_default_timeout(12000)
        page.on('pageerror', lambda e: report['pageErrors'].append(str(e)))
        page.on('response', lambda r: report['httpErrors'].append({'status': r.status, 'url': r.url}) if r.status >= 400 else None)
        page.on('request', lambda r: report['externalRequests'].append(r.url) if r.url.startswith('http') and not r.url.startswith(args.base_url) else None)
        page.on('dialog', lambda d: d.accept())
        def api(path, method='GET', data=None):
            response = context.request.fetch(args.base_url + '/api' + path, method=method, data=data, headers={'Origin': args.base_url})
            assert response.ok, f'{method} {path}: {response.status}'
            return response.json()
        def check(name):
            report['checks'].append({'name': name, 'status': 'passed'})
            print('PASS ' + name, flush=True)
        def flush():
            page.keyboard.press(MOD + '+s')
            expect(page.locator('.st-board-actions [role=status]')).to_have_text('已保存到工作空间', timeout=20000)
            return api(f'/projects/{pid}/studio')['snapshot']
        def zoom(): return float(page.locator('.dx-board-diagnostics').get_attribute('data-camera-zoom'))
        def close_panel():
            if page.get_by_role('button', name='关闭侧边面板', exact=True).count(): page.get_by_role('button', name='关闭侧边面板', exact=True).click()
        try:
            api('/auth/login', 'POST', {k: account[k] for k in ('email', 'password')})
            project = api('/projects', 'POST', {'title': 'tldraw 原生交互 ' + output.name, 'design': {'width': 400, 'height': 300, 'background': '#ffffff', 'nodes': []}})
            pid = project['id']; report['projectId'] = pid
            initial = api(f'/projects/{pid}/studio')
            snapshot = initial['snapshot']
            snapshot['results'][0]['position'] = {'x': 1400, 'y': 0}
            snapshot['notes'] = [{'id': f'note-{i}', 'text': f'原生便签 {i}', 'position': {'x': i * 380, 'y': 200}, 'width': 240, 'height': 180, 'color': '#FFF0B5'} for i in range(2)]
            snapshot.update({'sections': [], 'view': {'x': 50, 'y': 80, 'zoom': .75}, 'selection': [], 'selected': None})
            api(f'/projects/{pid}/studio', 'PUT', {'snapshot': snapshot, 'baseRevision': initial['revision']})
            page.goto(args.base_url + '/#studio/' + pid)
            page.get_by_label('当前创作名称', exact=True).wait_for(); close_panel()
            expect(page.locator('.dx-tldraw-board .tl-canvas')).to_be_visible()
            expect(page.locator('.st-note:visible')).to_have_count(2)
            check('default-engine-is-real-tldraw-canvas')

            # Brush from empty space across both notes, using real pointer input.
            canvas = page.locator('.st-canvas').bounding_box()
            start = (canvas['x'] + 50 - 20 * .75, canvas['y'] + 80 + 180 * .75)
            end = (canvas['x'] + 50 + 640 * .75, canvas['y'] + 80 + 400 * .75)
            page.mouse.move(*start); page.mouse.down(); page.mouse.move(*end, steps=16); page.mouse.up()
            expect(page.locator('.st-note.is-selected')).to_have_count(2)
            assert set(flush()['selection']) == {'note-0', 'note-1'}
            check('native-brush-selection-persists-original-business-ids')

            page.locator('[data-board-id="note-0"] button').first.click()
            note = page.locator('[data-board-id="note-0"]')
            bounds = note.bounding_box(); assert bounds
            # SDK 5.6 draws handles in an overlay canvas; hit the real corner.
            page.mouse.move(bounds['x'] + bounds['width'], bounds['y'] + bounds['height'])
            page.mouse.down(); page.mouse.move(bounds['x'] + bounds['width'] + 60, bounds['y'] + bounds['height'] + 30, steps=12); page.mouse.up()
            resized = flush()['notes'][0]
            assert abs(resized['width'] - 320) < 1 and abs(resized['height'] - 220) < 1, resized
            page.get_by_role('button', name='撤销画布操作', exact=True).click()
            restored = flush()['notes'][0]
            assert restored['width'] == 240 and restored['height'] == 180
            page.get_by_role('button', name='重做画布操作', exact=True).click()
            assert flush()['notes'][0] == resized
            check('native-resize-is-one-domain-undo-step-and-persists')

            # Alt changes snapping; it must not create client-only artboard IDs.
            handle = note.locator('.st-note-header > span').bounding_box(); assert handle
            before = flush()
            x, y = handle['x'] + handle['width'] / 2, handle['y'] + handle['height'] / 2
            page.keyboard.down('Alt'); page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 17, y + 11, steps=8); page.mouse.up(); page.keyboard.up('Alt')
            after = flush()
            assert len(after['notes']) == len(before['notes']) and len(after['results']) == len(before['results'])
            delta = after['notes'][0]['position']['x'] - before['notes'][0]['position']['x']
            assert abs(delta - 17 / .75) < .1, delta
            check('alt-drag-is-unsnapped-and-never-duplicates-server-documents')

            # Wheel pans through the SDK and survives a full page reload.
            before = flush()['view']
            page.mouse.move(canvas['x'] + canvas['width'] - 80, canvas['y'] + 500)
            page.mouse.wheel(35, 120); page.wait_for_timeout(300)
            after = flush()['view']
            assert after != before and after['zoom'] == before['zoom']
            page.reload(); page.get_by_label('当前创作名称', exact=True).wait_for(); close_panel()
            expect(page.locator('.dx-board-diagnostics')).to_have_attribute('data-camera-zoom', str(after['zoom']))
            actual_x = float(page.locator('.dx-board-diagnostics').get_attribute('data-camera-x'))
            assert abs(actual_x - after['x']) < .01
            check('native-wheel-camera-roundtrips-through-existing-board-protocol')

            # Explicit legacy comparison uses the same project and server data.
            expected_notes = api(f'/projects/{pid}/studio')['snapshot']['notes']
            page.screenshot(path=str(output / 'native.png'), full_page=True)
            page.goto(args.base_url + '/?boardEngine=legacy#studio/' + pid)
            page.get_by_label('当前创作名称', exact=True).wait_for(); close_panel()
            expect(page.locator('.st-world')).to_be_attached()
            assert not page.locator('.dx-tldraw-board').count()
            assert api(f'/projects/{pid}/studio')['snapshot']['notes'] == expected_notes
            check('explicit-legacy-fallback-opens-the-same-server-project')
            assert not report['pageErrors'] and not report['httpErrors'], report
            assert not report['externalRequests'], report['externalRequests']
            check('no-page-errors-http-errors-or-external-asset-requests')
            page.screenshot(path=str(output / 'legacy.png'), full_page=True)
            report['status'] = 'passed'
        except Exception as error:
            report.update({'status': 'failed', 'error': str(error), 'traceback': traceback.format_exc()})
            page.screenshot(path=str(output / 'failure.png'), full_page=True)
            print('FAIL ' + str(error), flush=True)
        finally:
            (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
            browser.close()
    print('REPORT ' + str(output / 'report.json'), flush=True)
    return 0 if report['status'] == 'passed' else 1

if __name__ == '__main__': raise SystemExit(main())
