#!/usr/bin/env python3
"""Measure a real seeded Board in an isolated production preview, without mocks.

Credentials remain in a private external file. Each trial has a process-group
deadline, so a nonresponsive renderer cannot leave the measurement hanging.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import signal
import statistics
import subprocess
import sys
import time

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
INIT = """(() => {
 window.__boardPerf = {phase:'load',frames:[],longTasks:[],last:0};
 try { new PerformanceObserver(list=>{for(const e of list.getEntries())window.__boardPerf.longTasks.push({phase:window.__boardPerf.phase,start:e.startTime,duration:e.duration});}).observe({type:'longtask',buffered:true}); } catch {}
 function frame(t){const p=window.__boardPerf;if(p.last&&p.phase)p.frames.push({phase:p.phase,dt:t-p.last});p.last=t;requestAnimationFrame(frame)}
 requestAnimationFrame(frame);
})()"""


def distribution(values):
    values = sorted(values)
    def percentile(p):
        if not values: return None
        index = (len(values) - 1) * p
        lo, hi = math.floor(index), math.ceil(index)
        return round(values[lo] + (values[hi] - values[lo]) * (index - lo), 3)
    return {'samples': len(values), 'p50Ms': percentile(.5), 'p95Ms': percentile(.95),
            'maxMs': round(max(values), 3) if values else None,
            'over33ms': sum(v > 33.34 for v in values), 'over50ms': sum(v > 50 for v in values)}


def check_budgets(report):
    """Explicit local fixture budgets; RAF is a scheduling proxy, not display FPS."""
    assert report['fixture']['boards'] == 200 and report['fixture']['nodesPerBoard'] == 50
    assert report['environment']['viewport'] == {'width': 1440, 'height': 900}
    pan = report['phases']['pan']
    checks = [
        {'name': 'initialMountedArtboards', 'actual': report['load']['dom']['mountedArtboards'], 'maximum': 30, 'unit': 'artboards'},
        {'name': 'initialDomElements', 'actual': report['load']['dom']['elements'], 'maximum': 5000, 'unit': 'elements'},
        {'name': 'panRafP95', 'actual': pan['raf']['p95Ms'], 'maximum': 20, 'unit': 'ms'},
        {'name': 'panMeanScriptPerAction', 'actual': round(pan['cdpDelta']['ScriptDuration'] * 1000 / pan['actions'], 6), 'maximum': 8, 'unit': 'ms/action'},
        {'name': 'fitAllMaxLongTask', 'actual': report['phases']['fit-all']['longTasks']['maxMs'], 'maximum': 100, 'unit': 'ms'},
        {'name': 'fitAllRafP95', 'actual': report['phases']['fit-all']['raf']['p95Ms'], 'maximum': 20, 'unit': 'ms'},
    ]
    for check in checks:
        check['passed'] = check['actual'] is not None and check['actual'] <= check['maximum']
    return {'enabled': True, 'passed': all(c['passed'] for c in checks), 'checks': checks,
        'scope': 'Fixed local 200x50 fixture, 1440x900 DPR1; RAF p95 <=20ms is a 50fps scheduling proxy, not a display FPS guarantee.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--account-file', type=Path, required=True)
    parser.add_argument('--base-url', default='http://127.0.0.1:5175')
    parser.add_argument('--label', required=True)
    parser.add_argument('--build-commit', required=True)
    parser.add_argument('--source-manifest', type=Path, help='Optional manifest identifying the exact source file hashes used for this production build')
    parser.add_argument('--runs', type=int, default=3)
    parser.add_argument('--deadline', type=int, default=180)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--check-budgets', action='store_true', help='Enforce explicit local 200x50/1440x900 performance budgets')
    parser.add_argument('--single', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    assert args.account_file.stat().st_mode & 0o077 == 0, 'Account file must be private (0600)'
    if not args.single:
        output = args.output or ROOT / 'tests/perf/.artifacts' / (args.label + '-' + time.strftime('%Y%m%d-%H%M%S'))
        output.mkdir(parents=True, exist_ok=True)
        trials = []
        for i in range(args.runs):
            folder = output / f'trial-{i + 1}'
            command = [sys.executable, __file__, '--single', '--account-file', str(args.account_file),
                '--base-url', args.base_url, '--label', args.label, '--build-commit', args.build_commit, '--output', str(folder)]
            if args.check_budgets:
                command.append('--check-budgets')
            if args.source_manifest:
                command.extend(['--source-manifest',str(args.source_manifest.resolve())])
            child = subprocess.Popen(command, start_new_session=True)
            timed_out = False
            try:
                child.wait(timeout=args.deadline)
            except subprocess.TimeoutExpired:
                timed_out = True
                os.killpg(child.pid, signal.SIGTERM)
                try: child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
            report_path = folder / 'report.json'
            report = json.loads(report_path.read_text()) if report_path.exists() else {'status':'failed','phases':{}}
            report.update({'trial': i + 1, 'processExitCode': child.returncode, 'deadlineSeconds': args.deadline, 'timedOut': timed_out})
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2))
            trials.append(report)
            (output / 'report.json').write_text(json.dumps({'label': args.label, 'buildCommit': args.build_commit, 'trials': trials}, ensure_ascii=False, indent=2))
            print(json.dumps({'trial':i + 1,'status':report.get('status'),'timedOut':timed_out,'output':str(folder)}), flush=True)
        print('PERF_REPORT ' + str(output / 'report.json'), flush=True)
        return 0 if all(t.get('status') == 'passed' and not t['timedOut'] and t['processExitCode'] == 0 for t in trials) else 1

    account = json.loads(args.account_file.read_text())
    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    executable = os.getenv('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH') or subprocess.check_output(
        ['node', '-e', 'import("playwright").then(p=>console.log(p.chromium.executablePath()))'],cwd=ROOT,text=True).strip()
    report = {'label': args.label, 'buildCommit': args.build_commit, 'status':'running', 'mocked':False,
        'environment': {'platform':platform.platform(), 'machine':platform.machine(), 'python':platform.python_version(),
            'viewport':{'width':1440,'height':900}, 'deviceScaleFactor':1,'headless':True,'cpuThrottling':False,
            'cacheDisabledDuringMeasurement':True, 'preview':args.base_url},
        'fixture':{k:account[k] for k in ('projectId','boards','nodesPerBoard','seedVersion','view','fixtureRunId')},
        'phases':{}, 'pageErrors':[], 'httpErrors':[], 'budgets':{'enabled':args.check_budgets,'checks':[]},
        'limits':['Local machine and local API/PG; not production latency or 200 different image assets.',
                  'Native Playwright input dispatch and sampling add overhead; RAF intervals are not GPU presentation timestamps.',
                  'Long tasks are browser main-thread tasks >=50ms; CDP heap is a live estimate without forced GC.',
                  '200 artboards contain repeated same-origin coffee image URLs; no mocked API responses.']}
    def save(): (output / 'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    if args.source_manifest:
        manifest=json.loads(args.source_manifest.read_text())
        report['buildSource']={'manifestPath':str(args.source_manifest),'head':manifest['head'],
            'sourceSetSha256':manifest['sourceSetSha256'],'fileCount':len(manifest['files'])}
    report['checkpoint']='browser-launch'
    save()
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch(headless=True, executable_path=executable, timeout=30000)
        except Exception as error:
            report.update({'status':'failed','failureStage':'browser-launch','error':str(error)})
            save()
            return 1
        report['environment']['browserVersion'] = browser.version
        report['checkpoint']='browser-ready'
        save()
        context = browser.new_context(viewport={'width':1440,'height':900},device_scale_factor=1)
        context.add_init_script(INIT)
        page = context.new_page()
        page.set_default_timeout(30000)
        page.on('pageerror',lambda e:report['pageErrors'].append(str(e)))
        page.on('response',lambda r:report['httpErrors'].append({'status':r.status,'url':r.url}) if r.status>=400 else None)
        requests = []
        save_responses = []
        page.on('request',lambda r:requests.append({'url':r.url,'type':r.resource_type,'method':r.method}))
        page.on('response', lambda r:save_responses.append((stage, r)) if r.request.method == 'PUT' and '/studio' in r.url else None)
        def api(path,method='GET',data=None):
            r=context.request.fetch(args.base_url+'/api'+path,method=method,data=data,
                headers={'Origin':args.base_url})
            assert r.ok, f'Fixture API {method} {path}: {r.status}'
            return r.json()
        cdp = context.new_cdp_session(page)
        cdp.send('Performance.enable')
        def metrics(): return {m['name']:m['value'] for m in cdp.send('Performance.getMetrics')['metrics']}
        def dom(): return page.evaluate("""() => ({elements:document.querySelectorAll('*').length,
            mountedArtboards:document.querySelectorAll('.st-result').length,
            mountedNotes:document.querySelectorAll('.st-note').length,mountedSections:document.querySelectorAll('.st-section').length,
            images:document.images.length,worldTransform:document.querySelector('.st-world')?.style.transform,
            canvasScrollTop:document.querySelector('.st-canvas')?.scrollTop,canvasScrollLeft:document.querySelector('.st-canvas')?.scrollLeft})""")
        def begin(name):
            page.evaluate('(name)=>{window.__boardPerf.phase=name;window.__boardPerf.last=0}',name)
            return time.monotonic(), metrics(), len(requests)
        def finish(name, start, actions=0):
            ended = metrics()
            trace = page.evaluate('(name)=>({frames:window.__boardPerf.frames.filter(x=>x.phase===name).map(x=>x.dt),longTasks:window.__boardPerf.longTasks.filter(x=>x.phase===name)})',name)
            page.evaluate('window.__boardPerf.phase=null')
            selected = ['LayoutCount','RecalcStyleCount','LayoutDuration','RecalcStyleDuration','ScriptDuration','TaskDuration']
            report['phases'][name] = {'elapsedSeconds':round(time.monotonic()-start[0],3),'actions':actions,
                'raf':distribution(trace['frames']),'longTasks':{'count':len(trace['longTasks']),
                    'totalMs':round(sum(t['duration'] for t in trace['longTasks']),3),
                    'maxMs':round(max([t['duration'] for t in trace['longTasks']],default=0),3)},
                'cdpDelta':{k:round(ended.get(k,0)-start[1].get(k,0),6) for k in selected},
                'heapUsedBytes':ended.get('JSHeapUsedSize'),'dom':dom(),'requests':len(requests)-start[2]}
            save()
            result=report['phases'][name]
            print(json.dumps({'phase':name,'elapsedSeconds':result['elapsedSeconds'],'raf':result['raf'],
                'longTasks':result['longTasks'],'mountedArtboards':result['dom']['mountedArtboards'],'heapUsedBytes':result['heapUsedBytes']},ensure_ascii=False),flush=True)
        stage='login'
        try:
            report['checkpoint']='login';save()
            page.goto(args.base_url,wait_until='domcontentloaded')
            page.get_by_label('邮箱',exact=True).fill(account['email'])
            page.get_by_label('密码',exact=True).fill(account['password'])
            page.get_by_role('button',name='进入创作空间',exact=True).click()
            page.get_by_role('navigation',name='主导航').wait_for()
            report['checkpoint']='fixture-reset';save()
            # Restore the same Board/view through the real API before every trial.
            state=api('/projects/'+account['projectId']+'/studio')
            snapshot=state['snapshot']
            assert len(snapshot['results'])==account['boards']
            normalized={'results':[{k:r[k] for k in ('id','position','design')} for r in snapshot['results']],
                'notes':snapshot['notes'],'sections':snapshot['sections']}
            data_hash=hashlib.sha256(json.dumps(normalized,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
            report['fixture']['dataHash']=data_hash
            if account.get('dataHash'):
                assert data_hash==account['dataHash'], 'Fixture content/geometry changed; baseline/after comparison would be invalid'
            snapshot.update({'view':account['view'],'selection':[],'selected':None})
            snapshot['results']=[{k:v for k,v in r.items() if k not in ('design','revision')} for r in snapshot['results']]
            api('/projects/'+account['projectId']+'/studio','PUT',{'snapshot':snapshot,'baseRevision':state['revision']})
            cdp.send('Network.enable')
            cdp.send('Network.clearBrowserCache')
            cdp.send('Network.setCacheDisabled',{'cacheDisabled':True})
            stage='load'
            report['checkpoint']='board-navigation';save()
            load_start=time.monotonic()
            requests.clear()
            report['setupHttpResponses']=list(report['httpErrors'])
            report['httpErrors'].clear()
            page.goto(args.base_url+'/?perf=1#studio/'+account['projectId'],wait_until='domcontentloaded',timeout=45000)
            page.locator('.st-result').first.wait_for(state='attached',timeout=45000)
            report['load']={'boardDomReadyMs':round((time.monotonic()-load_start)*1000,3)}
            report['checkpoint']='fonts-images';save()
            page.evaluate('''async()=>{
                const visible=(image)=>{
                    const r=image.getBoundingClientRect();
                    let left=Math.max(0,r.left),top=Math.max(0,r.top),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom);
                    for(let p=image;p;p=p.parentElement){
                        const s=getComputedStyle(p),b=p.getBoundingClientRect();
                        if(s.display==='none'||s.visibility==='hidden')return false;
                        if(/hidden|clip|auto|scroll/.test(s.overflowX)){left=Math.max(left,b.left);right=Math.min(right,b.right)}
                        if(/hidden|clip|auto|scroll/.test(s.overflowY)){top=Math.max(top,b.top);bottom=Math.min(bottom,b.bottom)}
                    }
                    return right>left&&bottom>top;
                };
                const state={fonts:false,pendingImages:[],excludedImages:[],decodeErrors:[],targets:0,scope:'all mounted BoardWorld images plus UI images visible after ancestor clipping'};
                window.__boardPerf.readiness=state;
                await Promise.race([(async()=>{await document.fonts.ready;state.fonts=true;
                    await Promise.all([...document.images].map((image,index)=>{
                        const record={index,src:image.currentSrc||image.src,loading:image.loading,complete:image.complete,bounds:image.getBoundingClientRect().toJSON()};
                        if(!image.closest('.st-world')&&!visible(image)){state.excludedImages.push(record);return Promise.resolve()}
                        state.targets++;
                        state.pendingImages.push(record);
                        return image.decode().catch(error=>{state.decodeErrors.push({src:record.src,message:String(error)})}).finally(()=>{state.pendingImages=state.pendingImages.filter(x=>x!==record)});
                    }));})(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Font/image readiness timeout: '+JSON.stringify(state))),20000))]);
                if(state.decodeErrors.length)throw new Error('Image decode failed: '+JSON.stringify(state.decodeErrors));
            }''')
            report['load']['fontsImagesReadyMs']=round((time.monotonic()-load_start)*1000,3)
            report['load']['imageReadiness']=page.evaluate('window.__boardPerf.readiness')
            report['load']['dom']=dom()
            report['load']['cdp']=metrics()
            report['load']['domCounters']=cdp.send('Memory.getDOMCounters')
            report['load']['resources']=page.evaluate("performance.getEntriesByType('resource').map(r=>({name:r.name,duration:r.duration,transferSize:r.transferSize,encodedBodySize:r.encodedBodySize}))")
            report['load']['requests']=len(requests)
            report['load']['longTasks']=page.evaluate('window.__boardPerf.longTasks')
            save()
            print(json.dumps({'load':{k:v for k,v in report['load'].items() if k not in ('resources','cdp','longTasks','imageReadiness')}},ensure_ascii=False),flush=True)
            if page.get_by_role('button',name='关闭侧边面板',exact=True).count():page.get_by_role('button',name='关闭侧边面板',exact=True).click()
            page.get_by_role('button',name='拖动画布',exact=True).click()
            page.wait_for_timeout(500)
            stage='idle'; started=begin(stage);page.wait_for_timeout(2000);finish(stage,started)
            stage='pan'; started=begin(stage)
            bounds=page.locator('.st-canvas').bounding_box()
            origin_x,origin_y=bounds['x']+20,bounds['y']+400
            hit = page.evaluate('([x,y])=>{const t=document.elementFromPoint(x,y);return {valid:!!t?.closest(".st-canvas")&&!t?.closest("button,input,textarea,select"),target:t?.outerHTML.slice(0,1000)}}',[origin_x,origin_y])
            report['panStart'] = {'bounds':bounds,'x':origin_x,'y':origin_y,**hit}
            assert hit['valid'], 'Pan must start on canvas, not a control: '+str(hit)
            transform_before=page.locator('.st-world').get_attribute('style')
            pan_samples=[]
            page.mouse.move(origin_x,origin_y);page.mouse.down()
            for i in range(120):
                angle=(i+1)*2*math.pi/120
                page.mouse.move(origin_x+180*math.sin(angle),origin_y+100*(1-math.cos(angle)))
                if i in (29,59,89):pan_samples.append(page.locator('.st-world').get_attribute('style'))
                page.wait_for_timeout(max(0,((i+1)/60-(time.monotonic()-started[0]))*1000))
            page.mouse.up()
            assert all(sample!=transform_before for sample in pan_samples), 'Native pan did not move Board view'
            finish(stage,started,120)
            report['phases']['pan']['observedTransforms']=pan_samples
            save()
            stage='zoom'; started=begin(stage)
            for i in range(20):
                page.get_by_role('button',name='放大画布' if i<10 else '缩小画布',exact=True).click()
                page.wait_for_timeout(60)
            finish(stage,started,20)
            stage='fit-all';started=begin(stage)
            page.get_by_role('button',name='适应所有方案',exact=True).click()
            page.wait_for_timeout(1500)
            if args.check_budgets:
                completion_start = time.monotonic()
                page.wait_for_function('''() => {
                    const w = document.querySelector('.st-world');
                    const target = Number(w?.dataset.renderTargetCount), rendered = Number(w?.dataset.renderedItems);
                    const mounted = w?.querySelectorAll('.st-result,.st-note,.st-section').length;
                    return w?.dataset.renderPending === '0' && Number.isFinite(target) && target > 0 && rendered === target && mounted === target;
                }''', timeout=15000)
                report['fitCompletion'] = page.evaluate('''() => {const w=document.querySelector('.st-world');return {
                    pending:Number(w.dataset.renderPending),target:Number(w.dataset.renderTargetCount),rendered:Number(w.dataset.renderedItems),
                    mounted:w.querySelectorAll('.st-result,.st-note,.st-section').length}}''')
                report['fitCompletion']['extraWaitAfter1500Ms'] = round((time.monotonic()-completion_start)*1000,3)
            finish(stage,started,1)
            page.screenshot(path=str(output/'board.png'))
            # Read response bodies/sizes only after timed phases to avoid measurement work during gestures.
            report['browserSaveTransfers'] = []
            for response_stage, response in save_responses:
                body = response.body()
                parsed = json.loads(body)
                report['browserSaveTransfers'].append({'phaseAtResponse':response_stage, 'url':response.url,
                    'status':response.status, 'requestBodyUtf8Bytes':len(response.request.post_data_buffer or b''),
                    'responseDecodedBodyBytes':len(body), 'responseKeys':sorted(parsed.keys()),
                    'containsSnapshot':'snapshot' in parsed, 'ackQuery':'response=ack' in response.url,
                    'networkSizes':response.request.sizes()})
            if args.check_budgets:
                report['budgets'] = check_budgets(report)
            report['status']='passed' if not report['pageErrors'] and not report['httpErrors'] else 'failed'
            if args.check_budgets and not report['budgets']['passed']:
                report['status']='failed'
                report['failureStage']='performance-budgets'
                print('PERF_BUDGET_FAILURE '+json.dumps(report['budgets']),flush=True)
        except Exception as error:
            report.update({'status':'failed','failureStage':stage,'error':str(error)})
            print('PERF_FAILURE '+stage+': '+str(error),flush=True)
            try: page.screenshot(path=str(output/'failure.png'),timeout=5000)
            except Exception: pass
        finally:
            save()
            browser.close()
    return 0 if report['status']=='passed' else 1


if __name__=='__main__':raise SystemExit(main())
