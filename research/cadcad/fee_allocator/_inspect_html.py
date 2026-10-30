import re
from pathlib import Path

t = Path("../allocator/out/simple_dashboard.html").read_text(encoding="utf-8")
patterns = [
    r'<p class="sub">.*?</p>',
    r'<p class="note">The top chart.*?</p>',
    r'<div class="warn"><b>Last 20 days.*?</div>',
    r'<div class="warn"><b>Why our strategy.*?</div>',
    r'<div class="rule"><b>Every 2h.*?</div>',
    r'<div class="kpi"><div class="kpi-label">0.30 pool time.*?</div></div>',
    r'<div class="rule"><b>Deploy to us.*?</div>',
]
for p in patterns:
    for m in re.findall(p, t, re.S):
        print("---")
        print(m)
