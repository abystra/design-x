#!/usr/bin/env python3
"""Print comparable medians from board_performance.py aggregate reports."""
import argparse
import json
from pathlib import Path
from statistics import median

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('reports', type=Path, nargs='+')
args = p.parse_args()
for path in args.reports:
    report = json.loads(path.read_text())
    trials = report['trials']
    good = [t for t in trials if t.get('status') == 'passed' and not t.get('timedOut') and t.get('processExitCode') == 0]
    print(json.dumps({'report': str(path), 'label': report['label'], 'successfulTrials': len(good), 'totalTrials': len(trials)}, ensure_ascii=False))
    if not good:
        continue
    print(json.dumps({'loadMedian': {
        'boardDomReadyMs': median(t['load']['boardDomReadyMs'] for t in good),
        'fontsImagesReadyMsObserved': median(t['load']['fontsImagesReadyMs'] for t in good),
        'imageReadinessScopes': sorted({t['load'].get('imageReadiness', {}).get('scope', 'legacy: all document.images') for t in good}),
        'elements': median(t['load']['dom']['elements'] for t in good),
        'mountedArtboards': median(t['load']['dom']['mountedArtboards'] for t in good),
        'requests': median(t['load']['requests'] for t in good),
        'resourceEncodedBytes': median(sum(r['encodedBodySize'] for r in t['load']['resources']) for t in good),
    }}, ensure_ascii=False))
    for phase in ('idle', 'pan', 'zoom', 'fit-all'):
        rows = [t['phases'][phase] for t in good]
        print(json.dumps({'phase': phase, 'medianOfTrials': {
            'elapsedSeconds': median(r['elapsedSeconds'] for r in rows),
            'rafP50Ms': median(r['raf']['p50Ms'] for r in rows),
            'rafP95Ms': median(r['raf']['p95Ms'] for r in rows),
            'scriptSeconds': median(r['cdpDelta']['ScriptDuration'] for r in rows),
            'layoutSeconds': median(r['cdpDelta']['LayoutDuration'] for r in rows),
            'heapUsedBytes': median(r['heapUsedBytes'] for r in rows),
            'mountedArtboards': median(r['dom']['mountedArtboards'] for r in rows),
            'requests': median(r['requests'] for r in rows),
        }, 'largestFrameGapMs': max(r['raf']['maxMs'] for r in rows),
            'longTasksAcrossTrials': sum(r['longTasks']['count'] for r in rows)}, ensure_ascii=False))
