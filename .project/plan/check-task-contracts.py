#!/usr/bin/env python3
"""Validate gsd-path task contracts: deps exist, acyclic, no later-wave deps,
zero same-wave file overlaps, PLAN.md rows present."""
import re, sys
from pathlib import Path

tasks_dir = Path(".project/tasks")
plan = Path(".project/plan/PLAN.md").read_text()

tasks = {}
for f in sorted(tasks_dir.glob("T*.md")):
    text = f.read_text()
    fm = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not fm:
        print(f"FAIL {f.name}: no frontmatter"); sys.exit(1)
    block = fm.group(1)
    tid = re.search(r"^id: (\S+)", block, re.M).group(1)
    wave = int(re.search(r"^wave: (\d+)", block, re.M).group(1))
    deps = re.search(r"^deps: \[(.*?)\]", block, re.M).group(1)
    deps = [d.strip() for d in deps.split(",") if d.strip()]
    files_m = re.search(r"^files:\n((?:  - [^\n]*(?:\n|$))+)", block, re.M)
    files = [l.strip()[2:].strip() for l in files_m.group(1).splitlines()] if files_m else []
    tasks[tid] = {"wave": wave, "deps": deps, "files": files, "name": f.name}

errors = []

# 1. dep ids exist
for tid, t in tasks.items():
    for d in t["deps"]:
        if d not in tasks:
            errors.append(f"{tid}: dep {d} does not exist")

# 2. no dep on a later wave
for tid, t in tasks.items():
    for d in t["deps"]:
        if d in tasks and tasks[d]["wave"] > t["wave"]:
            errors.append(f"{tid} (wave {t['wave']}): depends on later-wave {d} (wave {tasks[d]['wave']})")

# 3. acyclic (DFS)
WHITE, GRAY, BLACK = 0, 1, 2
color = {t: WHITE for t in tasks}
def visit(t, stack):
    color[t] = GRAY
    for d in tasks[t]["deps"]:
        if d not in tasks: continue
        if color[d] == GRAY:
            errors.append(f"cycle: {' -> '.join(stack + [t, d])}")
        elif color[d] == WHITE:
            visit(d, stack + [t])
    color[t] = BLACK
for t in tasks:
    if color[t] == WHITE:
        visit(t, [])

# 4. file overlaps
def overlaps(a, b):
    a_dir, b_dir = a.endswith("/"), b.endswith("/")
    if a_dir and (b.startswith(a) or b_dir and b.startswith(a)) : return True
    if b_dir and a.startswith(b): return True
    return a == b

same_wave, cross_wave = [], []
tids = sorted(tasks)
for i, a in enumerate(tids):
    for b in tids[i+1:]:
        shared = [fa for fa in tasks[a]["files"] for fb in tasks[b]["files"] if overlaps(fa, fb)]
        if shared:
            entry = f"{a} (w{tasks[a]['wave']}) ∩ {b} (w{tasks[b]['wave']}): {sorted(set(shared))}"
            if tasks[a]["wave"] == tasks[b]["wave"]:
                same_wave.append(entry)
            else:
                cross_wave.append(entry)

# 5. PLAN.md row per task
for tid in tasks:
    if not re.search(rf"^\| {tid} \|", plan, re.M):
        errors.append(f"PLAN.md: no table row for {tid}")

print(f"tasks: {len(tasks)}")
if cross_wave:
    print("cross-wave shared files (allowed, layered):")
    for e in cross_wave: print(f"  {e}")
if same_wave:
    errors.append("SAME-WAVE FILE OVERLAPS:\n  " + "\n  ".join(same_wave))
if errors:
    print("\nERRORS:")
    for e in errors: print(f"  {e}")
    sys.exit(1)
print("ALL CHECKS PASS")
