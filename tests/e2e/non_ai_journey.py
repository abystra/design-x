#!/usr/bin/env python3
"""Real-browser journey against running Design-X services; no API mocks."""
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
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default=os.getenv('DESIGNX_E2E_URL', 'http://127.0.0.1:5173'))
    parser.add_argument('--output', type=Path)
    parser.add_argument('--skip-exports', action='store_true', help='Explicitly mark renderer checks skipped during development.')
    parser.add_argument('--expect-ai-disabled', action='store_true', help='Require AI disabled and verify the explicit unavailable path; default never sends an AI request.')
    args = parser.parse_args()
    run_id = time.strftime('%Y%m%d-%H%M%S') + '-' + uuid4().hex[:6]
    output = args.output or ROOT / 'tests/e2e/.artifacts' / run_id
    output.mkdir(parents=True, exist_ok=True)
    executable = os.getenv('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH') or subprocess.check_output(
        ['node', '-e', 'import("playwright").then(p=>console.log(p.chromium.executablePath()))'], cwd=ROOT, text=True).strip()
    report = {'runId': run_id, 'baseUrl': args.base_url, 'checks': [], 'pageErrors': [], 'failedResponses': [], 'artifacts': [], 'mocked': False}
    current = 'startup'
    email = f'e2e-{run_id}@example.test'
    password = 'designx-test-' + uuid4().hex
    project_id = None
    asset_id = None
    export_ids = []

    def check(name, details=None):
        report['checks'].append({'name': name, 'status': 'passed', 'details': details})
        print(f'PASS {name}', flush=True)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, executable_path=executable)
        context = browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
        page = context.new_page()
        page.set_default_timeout(15000)
        page.on('pageerror', lambda error: report['pageErrors'].append(str(error)))
        page.on('response', lambda response: report['failedResponses'].append({'url': response.url, 'status': response.status}) if response.status >= 500 or response.status == 429 else None)
        context.tracing.start(screenshots=True, snapshots=True, sources=False)

        def screenshot(name):
            path = output / f'{name}.png'
            page.screenshot(path=str(path), full_page=True)
            report['artifacts'].append(path.name)

        def api(path):
            response = context.request.get(args.base_url + '/api' + path)
            assert response.ok, f'GET {path}: {response.status} {response.text()[:400]}'
            return response.json()

        def nav(name):
            page.get_by_role('navigation', name='主导航').get_by_role('button', name=name, exact=True).click()

        def save():
            page.get_by_role('button', name='保存', exact=True).click()
            expect(page.locator('.ed-save-state')).to_have_text('已保存', timeout=20000)

        def register(target, address, name):
            target.goto(args.base_url)
            target.wait_for_load_state('networkidle')
            target.get_by_role('button', name='第一次来？创建账户').click()
            target.get_by_label('你的名字').fill(name)
            target.get_by_label('邮箱', exact=True).fill(address)
            target.get_by_label('密码', exact=True).fill(password)
            target.get_by_role('button', name='创建账户', exact=True).click()
            target.get_by_role('navigation', name='主导航').wait_for()

        try:
            health = context.request.get(args.base_url + '/api/health')
            assert health.ok and health.json()['status'] == 'ok', 'API and PostgreSQL must be healthy'
            ai_enabled = health.json()['aiEnabled']
            report['aiEnabled'] = ai_enabled
            report['aiSubmissionAttempted'] = False
            if args.expect_ai_disabled:
                assert ai_enabled is False, '--expect-ai-disabled requires an AI-disabled API'
            current = 'register-personal-workspace'
            register(page, email, '端到端验收')
            assert api('/auth/me')['user']['email'] == email
            assert any(c['name'] == 'dx_session' and c['httpOnly'] for c in context.cookies())
            check(current)
            screenshot('01-home')

            current = 'template-edit-save-and-reopen'
            nav('模板灵感')
            page.get_by_role('button', name=re.compile('^预览模板 ')).first.click()
            page.get_by_role('button', name='使用这个模板').click()
            page.get_by_label('作品名称', exact=True).wait_for()
            project_id = page.url.split('#editor/')[-1]
            assert project_id and '/' not in project_id, page.url
            title = f'E2E 咖啡海报 {run_id}'
            page.get_by_label('作品名称', exact=True).fill(title)
            text_node = page.get_by_role('button', name=re.compile('^选中文字：')).first
            text_node.press('Enter')
            page.get_by_label('文字内容', exact=True).fill('真实保存 · 秋日上新')
            save()
            stored = api(f'/projects/{project_id}')
            assert stored['title'] == title
            assert any(n.get('text') == '真实保存 · 秋日上新' for n in stored['design']['nodes'])
            page.evaluate('localStorage.clear()')
            page.reload(wait_until='domcontentloaded')
            expect(page.get_by_label('作品名称', exact=True)).to_have_value(title)
            expect(page.get_by_role('button', name='选中文字：真实保存 · 秋日上新', exact=True)).to_be_visible()
            assert api(f'/projects/{project_id}')['design'] == stored['design']
            check(current, {'projectId': project_id, 'revision': stored['revision']})
            screenshot('02-editor')

            current = 'upload-ingest-and-save-asset-reference'
            page.get_by_role('navigation', name='编辑工具').get_by_role('button', name='上传', exact=True).click()
            page.locator('input[type=file]').set_input_files({'name': f'e2e-upload-{run_id}.jpg', 'mimeType': 'image/jpeg', 'buffer': (ROOT / 'public/assets/coffee.jpg').read_bytes()})
            expect(page.get_by_text('素材已上传并加入画布', exact=True)).to_be_visible(timeout=90000)
            save()
            assets = api('/assets')
            uploaded = next(a for a in assets if run_id in (a.get('title') or a.get('name') or ''))
            assert uploaded['status'] == 'ready'
            asset_id = uploaded['id']
            stored = api(f'/projects/{project_id}')
            assert any(f'/api/assets/{asset_id}/' in n.get('src', '') for n in stored['design']['nodes'])
            content = context.request.get(args.base_url + f'/api/assets/{asset_id}/file')
            assert content.ok and content.headers['content-type'].startswith('image/') and len(content.body()) > 100
            check(current, {'assetId': asset_id, 'bytes': len(content.body())})

            current = 'named-version-restore'
            page.get_by_role('button', name='版本记录', exact=True).click()
            version_name = '验收基准版本'
            page.get_by_label('版本名称').fill(version_name)
            page.get_by_role('button', name='保存命名版本').click()
            expect(page.locator('.ed-version-list > div').filter(has_text=version_name).first).to_be_visible()
            baseline = api(f'/projects/{project_id}')['design']
            page.get_by_role('button', name='关闭版本记录').click()
            page.get_by_role('button', name='选中文字：真实保存 · 秋日上新', exact=True).press('Enter')
            page.get_by_label('文字内容', exact=True).fill('这段内容将在恢复版本后消失')
            save()
            page.get_by_role('button', name='版本记录', exact=True).click()
            version_row = page.locator('.ed-version-list > div').filter(has_text=version_name).first
            version_row.get_by_role('button', name='恢复', exact=True).click()
            expect(page.get_by_role('button', name='选中文字：真实保存 · 秋日上新', exact=True)).to_be_visible()
            assert api(f'/projects/{project_id}')['design'] == baseline
            check(current)

            current = 'real-png-pdf-export-downloads'
            if args.skip_exports:
                report['checks'].append({'name': current, 'status': 'skipped', 'details': 'Explicit --skip-exports; renderer was not tested.'})
            else:
                for fmt, signature in [('PNG', b'\x89PNG\r\n\x1a\n'), ('PDF', b'%PDF-')]:
                    page.get_by_role('button', name='导出作品', exact=True).click()
                    dialog = page.get_by_role('dialog', name='让好设计，被看见。')
                    dialog.get_by_role('button', name=re.compile('^' + fmt)).click()
                    dialog.get_by_label('导出尺寸').select_option('1')
                    with page.expect_download(timeout=180000) as download_info:
                        dialog.get_by_role('button', name=f'导出 {fmt}', exact=True).click()
                    download = download_info.value
                    assert download.failure() is None
                    path = output / f'export.{fmt.lower()}'
                    download.save_as(str(path))
                    payload = path.read_bytes()
                    assert payload.startswith(signature), f'{fmt}: wrong file signature'
                    assert len(payload) > 1000
                    if fmt == 'PNG':
                        assert struct.unpack('>II', payload[16:24]) == (baseline['width'], baseline['height'])
                    else:
                        assert b'%%EOF' in payload[-1024:]
                    report['artifacts'].append(path.name)
                    export_id = download.url.split('/api/exports/')[1].split('/')[0]
                    export_ids.append(export_id)
                    assert api(f'/jobs/{export_id}')['status'] == 'succeeded'
                    check(f'export-{fmt.lower()}', {'bytes': len(payload), 'jobId': export_id})

            current = 'folders-and-brand-persist'
            page.get_by_role('button', name='返回工作区').click()
            nav('我的项目')
            project_preview = page.get_by_role('img', name=title + '预览', exact=True)
            expect(project_preview).to_be_visible()
            expect(project_preview).to_contain_text('真实保存 · 秋日上新')
            page.get_by_role('button', name='新建文件夹', exact=True).click()
            folder_name = f'验收文件夹 {run_id[-6:]}'
            page.get_by_label('文件夹名称').fill(folder_name)
            page.get_by_role('button', name='创建文件夹', exact=True).click()
            expect(page.locator('.ws-folder').filter(has_text=folder_name)).to_be_visible()
            folder = next(f for f in api('/folders') if f['name'] == folder_name)
            page.get_by_role('button', name=f'{title} 更多操作', exact=True).click()
            page.get_by_role('button', name='移到文件夹', exact=True).click()
            page.locator('.ws-folder-options').get_by_role('button', name=folder_name).click()
            page.get_by_role('button', name='移动作品', exact=True).click()
            expect(page.get_by_role('dialog')).to_have_count(0)
            assert api(f'/projects/{project_id}')['folderId'] == folder['id']
            screenshot('03-projects')
            nav('资产库')
            page.get_by_role('tab', name='品牌套件', exact=True).click()
            brand_name = f'验收品牌 {run_id[-6:]}'
            page.get_by_label('品牌名称', exact=True).fill(brand_name)
            page.get_by_label('品牌标语', exact=True).fill('真实数据，持续创作')
            page.get_by_role('button', name='保存品牌套件', exact=True).click()
            expect(page.get_by_role('button', name='已保存品牌套件', exact=True)).to_be_visible()
            assert api('/preferences/brand')['name'] == brand_name
            brand_reads = []
            def count_brand_reads(request):
                if request.method == 'GET' and request.url.endswith('/api/preferences/brand'):
                    brand_reads.append(request.url)
            page.on('request', count_brand_reads)
            page.reload(wait_until='domcontentloaded')
            page.get_by_role('tab', name='品牌套件', exact=True).click()
            expect(page.get_by_label('品牌名称', exact=True)).to_have_value(brand_name)
            # Reconnecting replays real persisted export/upload events. That
            # burst must trigger a bounded refresh instead of one read per event.
            page.wait_for_timeout(700)
            page.remove_listener('request', count_brand_reads)
            assert 1 <= len(brand_reads) <= 3, f'SSE replay caused {len(brand_reads)} brand reads'
            check(current, {'folderId': folder['id'], 'brandReadsAfterReconnect': len(brand_reads)})
            screenshot('04-brand')

            current = 'ai-disabled-preserves-draft' if args.expect_ai_disabled else 'studio-draft-persists-without-ai-submission'
            page.get_by_role('button', name='开始创作', exact=True).click()
            prompt = page.get_by_label('告诉 AI 你的设计需求')
            prompt.wait_for()
            page.wait_for_url(re.compile(r'#studio/[^/]+$'))
            before_jobs = api('/jobs')
            draft = '非 AI 回归：仅保存这段需求草稿，不发送生成任务'
            prompt.fill(draft)
            if args.expect_ai_disabled:
                report['aiSubmissionAttempted'] = True
                page.get_by_role('button', name='发送设计需求').click()
                expect(page.get_by_text('AI 创作尚未配置。需求已保留，你可以添加模板、素材或空白画板继续设计。', exact=True)).to_be_visible()
            page.keyboard.press('Meta+s' if sys.platform == 'darwin' else 'Control+s')
            expect(page.locator('.st-board-actions [role=status]')).to_have_text('已保存到工作空间', timeout=20000)
            studio_id = page.url.split('#studio/')[-1]
            assert api(f'/projects/{studio_id}/studio')['snapshot']['draft'] == draft
            page.reload(wait_until='domcontentloaded')
            expect(prompt).to_have_value(draft)
            assert [j['id'] for j in api('/jobs')] == [j['id'] for j in before_jobs]
            check(current, {'aiEnabled': ai_enabled, 'submissionAttempted': bool(args.expect_ai_disabled), 'jobCountUnchanged': True, 'draftRestoredAfterReload': True})
            screenshot('05-studio-draft')

            current = 'logout-and-login-durable-data'
            page.goto(args.base_url + '/#projects', wait_until='domcontentloaded')
            page.get_by_role('button', name='退出登录').click()
            expect(page.get_by_role('heading', name='欢迎回来')).to_be_visible()
            assert context.request.get(args.base_url + '/api/auth/me').status == 401
            page.get_by_label('邮箱', exact=True).fill(email)
            page.get_by_label('密码', exact=True).fill(password)
            page.get_by_role('button', name='进入创作空间', exact=True).click()
            page.get_by_role('navigation', name='主导航').wait_for()
            assert api(f'/projects/{project_id}')['design'] == baseline
            assert any(a['id'] == asset_id for a in api('/assets'))
            assert api('/preferences/brand')['name'] == brand_name
            check(current)

            current = 'second-account-isolation'
            other_context = browser.new_context(viewport={'width': 1440, 'height': 1000})
            try:
                other = other_context.new_page()
                register(other, f'e2e-other-{run_id}@example.test', '隔离验收')
                for resource in [f'/projects/{project_id}', f'/projects/{project_id}/studio', f'/projects/{project_id}/versions', f'/assets/{asset_id}/file', f'/assets/{asset_id}/thumbnail'] + [f'/exports/{eid}/file' for eid in export_ids]:
                    response = other_context.request.get(args.base_url + '/api' + resource)
                    assert response.status == 404, f'cross-account GET {resource}: {response.status}'
                denied = other_context.request.patch(args.base_url + f'/api/projects/{project_id}', data={'title': '越权修改'}, headers={'Origin': args.base_url})
                assert denied.status == 404
                assert other_context.request.get(args.base_url + '/api/preferences/brand').json() is None
                nav_other = other.get_by_role('navigation', name='主导航')
                nav_other.get_by_role('button', name='我的项目', exact=True).click()
                expect(other.get_by_text(title, exact=True)).to_have_count(0)
                other.screenshot(path=str(output / '06-isolated-account.png'), full_page=True)
                check(current)
            finally:
                other_context.close()

            current = 'browser-console-and-http-errors'
            assert not report['pageErrors'], report['pageErrors']
            assert not report['failedResponses'], report['failedResponses']
            check(current)
            report['status'] = 'passed' if not args.skip_exports else 'partial'
        except Exception as error:
            report['status'] = 'failed'
            report['checks'].append({'name': current, 'status': 'failed', 'error': str(error)})
            report['traceback'] = traceback.format_exc()
            try:
                screenshot('failure')
                (output / 'failure-dom.txt').write_text(page.locator('body').inner_text())
            except Exception:
                pass
            print(f'FAIL {current}: {error}', file=sys.stderr, flush=True)
        finally:
            context.tracing.stop(path=str(output / 'trace.zip'))
            context.close()
            browser.close()
            report['projectId'] = project_id
            report['testEmail'] = email
            (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
            print(f'Report: {output / "report.json"}', flush=True)
    return 1 if report['status'] == 'failed' else 0


if __name__ == '__main__':
    raise SystemExit(main())
