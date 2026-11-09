"""Verify vendored source digests without requiring the WorkX checkout in CI."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / 'runtime/provenance.json').read_text())
assert manifest['commit'] == 'f81c31a3b09d13d8955248ec7bdefbdfc1f08a6e'
for entry in manifest['files']:
    digest = hashlib.sha256((root / entry['target']).read_bytes()).hexdigest()
    if digest != entry['targetSha256']:
        raise SystemExit('Vendored source digest mismatch: ' + entry['target'])
print('Verified pinned WorkX source and Design X port digests')
