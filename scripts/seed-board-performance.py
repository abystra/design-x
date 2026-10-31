#!/usr/bin/env python3
"""Create a deterministic large Board through the real HTTP API.

Writes one private, mode-0600 fixture/account descriptor outside the repository.
The account is dedicated to performance tests; no account credentials are printed.
"""
import argparse
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import time
import urllib.request


def design(index, count):
    nodes = []
    for n in range(count):
        x, y = 15 + (n % 5) * 75, 12 + (n // 5) * 26
        base = {'id': f'node-{n:03}', 'x': x, 'y': y, 'w': 68, 'h': 22}
        if n % 10 == 0:
            nodes.append({**base, 'type': 'image', 'src': '/assets/coffee.jpg', 'fit': 'cover'})
        elif n % 3 == 0:
            nodes.append({**base, 'type': 'rect' if n % 2 else 'circle', 'color': '#c7d4be', 'opacity': 0.8})
        else:
            nodes.append({**base, 'type': 'text', 'text': f'中文设计 {index:03}-{n:03}', 'size': 10, 'color': '#24362b', 'weight': 500})
    return {'width': 400, 'height': max(300, ((count + 4) // 5) * 26 + 30), 'background': '#f5f1e8', 'nodes': nodes}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--api-url', default='http://127.0.0.1:3001')
    p.add_argument('--origin', default='http://127.0.0.1:5173')
    p.add_argument('--boards', type=int, default=200)
    p.add_argument('--nodes', type=int, default=50)
    p.add_argument('--account-file', type=Path, required=True)
    args = p.parse_args()
    assert 1 <= args.boards <= 500 and 1 <= args.nodes <= 1000
    assert not args.account_file.resolve().is_relative_to(Path(__file__).resolve().parents[1]), 'Keep credentials outside the repository'
    assert not args.account_file.exists(), 'Refusing to overwrite private fixture credentials'
    cookie_jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie_jar))
    def api(path, method='GET', body=None):
        request = urllib.request.Request(args.api_url + '/api' + path,
            data=None if body is None else json.dumps(body, ensure_ascii=False).encode(), method=method,
            headers={'Content-Type': 'application/json', 'Origin': args.origin})
        with opener.open(request, timeout=45) as response:
            return json.load(response)
    run_id = time.strftime('%Y%m%d-%H%M%S') + '-' + secrets.token_hex(3)
    account = {'email': f'perf-{run_id}@example.test', 'password': secrets.token_urlsafe(32)}
    api('/auth/register', 'POST', {**account, 'name': '性能验收专用'})
    initial_view = {'x': 60, 'y': 110, 'zoom': 0.75}
    project = api('/projects', 'POST', {'title': f'Perf {args.boards}x{args.nodes} {run_id}', 'design': design(0, args.nodes)})
    descriptor = {**account, 'projectId': project['id'], 'boards': args.boards, 'nodesPerBoard': args.nodes,
        'seedVersion': 1, 'view': initial_view, 'fixtureRunId': run_id}
    fd = os.open(args.account_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(descriptor, out)
    print(f'Created fixture project {project["id"]}; seeding {args.boards} artboards', flush=True)
    for i in range(1, args.boards):
        api('/projects/' + project['id'] + '/artboards', 'POST', {
            'title': f'性能画板 {i + 1:03}', 'design': design(i, args.nodes),
            'position': {'x': (i % 10) * 380, 'y': (i // 10) * 360}})
        if i % 25 == 0:
            print(f'Created {i + 1}/{args.boards}', flush=True)
    state = api('/projects/' + project['id'] + '/studio')
    snapshot = state['snapshot']
    snapshot['results'][0]['position'] = {'x': 0, 'y': 0}
    snapshot['notes'] = [{'id': f'perf-note-{i:03}', 'text': f'性能便签 {i:03}\n中文内容与换行',
        'position': {'x': (i % 5) * 760 + 280, 'y': (i // 5) * 360 + 80}, 'width': 180, 'height': 120, 'color': '#FFF0B5'} for i in range(100)]
    snapshot['sections'] = [{'id': f'perf-section-{i:02}', 'title': f'方案分区 {i:02}',
        'position': {'x': -30, 'y': i * 360 - 45}, 'width': 3800, 'height': 345, 'color': '#CBD8BE',
        'itemIds': [r['id'] for r in snapshot['results'][i * 10:(i + 1) * 10]] + [n['id'] for n in snapshot['notes'][i * 5:(i + 1) * 5]]} for i in range(20)]
    snapshot.update({'view': initial_view, 'selected': None, 'selection': [], 'draft': '', 'messages': []})
    # The server keeps Artboard bodies authoritative; do not duplicate them in Board saves.
    snapshot['results'] = [{k: v for k, v in r.items() if k not in ('design', 'revision')} for r in snapshot['results']]
    saved = api('/projects/' + project['id'] + '/studio', 'PUT', {'snapshot': snapshot, 'baseRevision': state['revision']})
    assert len(saved['snapshot']['results']) == args.boards
    assert sum(len(r['design']['nodes']) for r in saved['snapshot']['results']) == args.boards * args.nodes
    normalized = {'results': [{k: r[k] for k in ('id', 'position', 'design')} for r in saved['snapshot']['results']],
        'notes': saved['snapshot']['notes'], 'sections': saved['snapshot']['sections']}
    descriptor['dataHash'] = hashlib.sha256(json.dumps(normalized, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
    args.account_file.write_text(json.dumps(descriptor))
    print(json.dumps({'projectId': project['id'], 'boards': args.boards, 'nodes': args.boards * args.nodes,
        'notes': 100, 'sections': 20, 'boardJsonBytes': len(json.dumps(saved).encode()),
        'dataHash': descriptor['dataHash'], 'credentialsPrinted': False}), flush=True)


if __name__ == '__main__':
    main()
