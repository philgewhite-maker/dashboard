"""Closure check: every JS module reachable from js/app.js (static and
dynamic string-literal imports) must be in sw.js CORE_ASSETS. Exits 1 and
lists the missing ones. Run: python tools/check-precache.py"""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC = re.compile(
    r"""(?:\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?|\bexport\s*(?:[\w$*{}\s,]+?)\s*from\s*|\bimport\s*\(\s*)(['"])(\.{1,2}/[^'"]+)\1""")

def refs(path):
    src = open(path, encoding='utf-8').read()
    base = os.path.dirname(path)
    for m in SPEC.finditer(src):
        yield os.path.normpath(os.path.join(base, m.group(2)))

seen, stack, missing_files = set(), [os.path.join(ROOT, 'js', 'app.js')], []
while stack:
    p = stack.pop()
    if p in seen: continue
    seen.add(p)
    if not os.path.isfile(p):
        missing_files.append(p); continue
    if p.endswith('.js'):
        stack.extend(refs(p))

sw = open(os.path.join(ROOT, 'sw.js'), encoding='utf-8').read()
block = sw[sw.index('CORE_ASSETS'):]
block = block[:block.index('];')]
core = {os.path.normpath(os.path.join(ROOT, m)) for m in re.findall(r"'(\./[^']+)'", block)}

missing = sorted(os.path.relpath(p, ROOT).replace(os.sep, '/') for p in seen if p not in core and os.path.isfile(p))
nofile = sorted(os.path.relpath(p, ROOT).replace(os.sep, '/') for p in missing_files)
dead = sorted(os.path.relpath(p, ROOT).replace(os.sep, '/') for p in core if not os.path.isfile(p))
print(f'{len(seen)} modules reachable from js/app.js; {len(core)} in CORE_ASSETS')
if missing: print('NOT in CORE_ASSETS:\n  ' + '\n  '.join(missing))
if nofile: print('Imported but file missing:\n  ' + '\n  '.join(nofile))
if dead: print('In CORE_ASSETS but file missing (addAll would fail):\n  ' + '\n  '.join(dead))
sys.exit(1 if (missing or nofile or dead) else 0)
