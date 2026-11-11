"""把 CI 日志里 M4B-PROBE-* 行解析成 JSON：python3 -I parse_probe.py <log> <out.json>"""
import json
import re
import sys

rows = {}
for line in open(sys.argv[1], encoding='utf-8', errors='replace'):
    m = re.search(r'(M4B-PROBE-[A-Z0-9]+) (\{.*\})\s*$', line)
    if not m:
        continue
    rows.setdefault(m.group(1), []).append(json.loads(m.group(2)))
json.dump(rows, open(sys.argv[2], 'w'), ensure_ascii=False)
print({k: len(v) for k, v in rows.items()})
