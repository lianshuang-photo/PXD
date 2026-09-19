#!/usr/bin/env bash
set -u
HOST="${PXDLS_HOST:-127.0.0.1}"
PORT="${PXDLS_PORT:-17880}"
BASE="http://${HOST}:${PORT}"
TINY="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
fail=0

pass() { printf 'PASS %s\n' "$1"; }
fail_step() { printf 'FAIL %s\n' "$1"; fail=1; }

json_get() {
  python3 -c "import json,sys; d=json.load(sys.stdin); $1"
}

# 1) health
h="$(curl -sS "${BASE}/health" || true)"
if printf '%s' "$h" | python3 -c 'import json,sys
d=json.load(sys.stdin)
ok = d.get("banana") is False and str(d.get("vendor","")).lower()=="mock"
sys.exit(0 if ok else 1)'; then
  pass "GET /health banana=false vendor=mock"
else
  fail_step "GET /health banana=false vendor=mock"
  printf '%s\n' "$h"
fi

# 2) recipes q= limit 8
r="$(curl -sS "${BASE}/recipes?q=&limit=8" || true)"
if printf '%s' "$r" | python3 -c 'import json,sys
d=json.load(sys.stdin)
items=d.get("items") or []
sys.exit(0 if len(items)==8 else 1)'; then
  pass "GET /recipes?q= limit 8 == 8 items"
else
  fail_step "GET /recipes?q= limit 8 == 8 items"
  printf '%s\n' "$r"
fi

# 3) load f_018 then job params
load="$(curl -sS -X POST "${BASE}/recipes/f_018/load" -H 'Content-Type: application/json' -d '{}' || true)"
job="$(curl -sS "${BASE}/job" || true)"
if printf '%s' "$job" | python3 -c 'import json,sys
d=json.load(sys.stdin)
params=d.get("params") or (d.get("job") or {}).get("params") or []
sys.exit(0 if len(params)>0 else 1)'; then
  pass "POST load f_018 + GET /job params length > 0"
else
  fail_step "POST load f_018 + GET /job params length > 0"
  printf '%s\n' "$job"
fi

# 4) plan 框脸再提亮 WITHOUT recipeId — must be face-box + brighten, not leftover recipe
p="$(curl -sS -X POST "${BASE}/plan" -H 'Content-Type: application/json' \
  -d '{"text":"框脸再提亮"}' || true)"
if printf '%s' "$p" | python3 -c 'import json,sys
d=json.load(sys.stdin)
plan=d.get("plan") or {}
steps=plan.get("steps") or []
atoms=[s.get("atom") for s in steps]
has_face="face-box" in atoms
has_bright="brighten" in atoms
has_recipe=any(s.get("recipeId") or s.get("skill") or (s.get("instruction") and s.get("atom") not in ("face-box","brighten","mask")) for s in steps)
has_mask="mask" in atoms
sys.exit(0 if has_face and has_bright and not has_recipe and not has_mask and not plan.get("refuse") else 1)'; then
  pass "POST /plan 框脸再提亮 (no recipeId) face-box+brighten, no mask"
else
  fail_step "POST /plan 框脸再提亮 (no recipeId) face-box+brighten, no mask"
  printf '%s\n' "$p"
fi

# 4b) 给选区做蒙版 — must include mask atom
m="$(curl -sS -X POST "${BASE}/plan" -H 'Content-Type: application/json' \
  -d '{"text":"给选区做蒙版"}' || true)"
if printf '%s' "$m" | python3 -c 'import json,sys
d=json.load(sys.stdin)
plan=d.get("plan") or {}
steps=plan.get("steps") or []
atoms=[s.get("atom") for s in steps]
ok = (not plan.get("refuse")) and ("mask" in atoms) and any(s.get("from")=="selection" or s.get("atom")=="mask" for s in steps)
sys.exit(0 if ok else 1)'; then
  pass "POST /plan 给选区做蒙版 has mask atom"
else
  fail_step "POST /plan 给选区做蒙版 has mask atom"
  printf '%s\n' "$m"
fi

# 4c) 加个特效 — fx atom outerGlow, not refuse
fx="$(curl -sS -X POST "${BASE}/plan" -H 'Content-Type: application/json' \
  -d '{"text":"加个特效"}' || true)"
if printf '%s' "$fx" | python3 -c 'import json,sys
d=json.load(sys.stdin)
plan=d.get("plan") or {}
steps=plan.get("steps") or []
ok = (not plan.get("refuse")) and (not d.get("refuse")) and any(s.get("atom")=="fx" and s.get("fx")=="outerGlow" for s in steps)
sys.exit(0 if ok else 1)'; then
  pass "POST /plan 加个特效 has fx outerGlow"
else
  fail_step "POST /plan 加个特效 has fx outerGlow"
  printf '%s\n' "$fx"
fi

# 4d) 框脸再提亮 still 2 steps, no fx/grade/readback
p2="$(curl -sS -X POST "${BASE}/plan" -H 'Content-Type: application/json' \
  -d '{"text":"框脸再提亮"}' || true)"
if printf '%s' "$p2" | python3 -c 'import json,sys
d=json.load(sys.stdin)
plan=d.get("plan") or {}
steps=plan.get("steps") or []
atoms=[s.get("atom") for s in steps]
ok = (not plan.get("refuse")) and len(steps)==2 and "face-box" in atoms and "brighten" in atoms and "fx" not in atoms and "grade" not in atoms and "readback" not in atoms and "select" not in atoms
sys.exit(0 if ok else 1)'; then
  pass "POST /plan 框脸再提亮 unchanged 2 steps, no fx/grade/select"
else
  fail_step "POST /plan 框脸再提亮 unchanged 2 steps, no fx/grade"
  printf '%s\n' "$p2"
fi

# 4e) 调色 — grade atom hue-sat, not leftover recipe, not banana
gde="$(curl -sS -X POST "${BASE}/plan" -H 'Content-Type: application/json' \
  -d '{"text":"调色"}' || true)"
if printf '%s' "$gde" | python3 -c 'import json,sys
d=json.load(sys.stdin)
plan=d.get("plan") or {}
steps=plan.get("steps") or []
atoms=[s.get("atom") for s in steps]
has_recipe=any(s.get("recipeId") or s.get("skill") for s in steps)
ok = (not plan.get("refuse")) and ("grade" in atoms) and any(s.get("atom")=="grade" for s in steps) and not has_recipe and "face-box" not in atoms and "brighten" not in atoms
sys.exit(0 if ok else 1)'; then
  pass "POST /plan 调色 has grade atom, no leftover recipe"
else
  fail_step "POST /plan 调色 has grade atom, no leftover recipe"
  printf '%s\n' "$gde"
fi

# 4f) 读回 — readback atom
rdb="$(curl -sS -X POST "${BASE}/plan" -H 'Content-Type: application/json' \
  -d '{"text":"读回"}' || true)"
if printf '%s' "$rdb" | python3 -c 'import json,sys
d=json.load(sys.stdin)
plan=d.get("plan") or {}
steps=plan.get("steps") or []
ok = (not plan.get("refuse")) and any(s.get("atom")=="readback" for s in steps)
sys.exit(0 if ok else 1)'; then
  pass "POST /plan 读回 has readback atom"
else
  fail_step "POST /plan 读回 has readback atom"
  printf '%s\n' "$rdb"
fi

# 4g) 建选区 — select atom only (not leftover recipe, not 框脸)
selp="$(curl -sS -X POST "${BASE}/plan" -H 'Content-Type: application/json' \
  -d '{"text":"建选区"}' || true)"
if printf '%s' "$selp" | python3 -c 'import json,sys
d=json.load(sys.stdin)
plan=d.get("plan") or {}
steps=plan.get("steps") or []
atoms=[s.get("atom") for s in steps]
has_recipe=any(s.get("recipeId") or s.get("skill") for s in steps)
ok = (not plan.get("refuse")) and any(s.get("atom")=="select" for s in steps) and not has_recipe and "face-box" not in atoms
sys.exit(0 if ok else 1)'; then
  pass "POST /plan 建选区 has select atom"
else
  fail_step "POST /plan 建选区 has select atom"
  printf '%s\n' "$selp"
fi

# 4h) 加调整层 — adjust-layer atom, not leftover recipe, not 框脸再提亮
al="$(curl -sS -X POST "${BASE}/plan" -H 'Content-Type: application/json' \
  -d '{"text":"加调整层"}' || true)"
if printf '%s' "$al" | python3 -c 'import json,sys
d=json.load(sys.stdin)
plan=d.get("plan") or {}
steps=plan.get("steps") or []
atoms=[s.get("atom") for s in steps]
has_recipe=any(s.get("recipeId") or s.get("skill") for s in steps)
ok = (not plan.get("refuse")) and any(s.get("atom")=="adjust-layer" and s.get("tool")=="curves-or-levels" for s in steps) and not has_recipe and "face-box" not in atoms and "brighten" not in atoms
sys.exit(0 if ok else 1)'; then
  pass "POST /plan 加调整层 has adjust-layer atom"
else
  fail_step "POST /plan 加调整层 has adjust-layer atom"
  printf '%s\n' "$al"
fi

# 4i) 框脸再提亮 still 2 steps, not adjust-layer
p3="$(curl -sS -X POST "${BASE}/plan" -H 'Content-Type: application/json' \
  -d '{"text":"框脸再提亮"}' || true)"
if printf '%s' "$p3" | python3 -c 'import json,sys
d=json.load(sys.stdin)
plan=d.get("plan") or {}
steps=plan.get("steps") or []
atoms=[s.get("atom") for s in steps]
ok = (not plan.get("refuse")) and len(steps)==2 and "face-box" in atoms and "brighten" in atoms and "adjust-layer" not in atoms
sys.exit(0 if ok else 1)'; then
  pass "POST /plan 框脸再提亮 still 2 steps, no adjust-layer"
else
  fail_step "POST /plan 框脸再提亮 still 2 steps, no adjust-layer"
  printf '%s\n' "$p3"
fi

# 5) 出一张 refuse
g="$(curl -sS -X POST "${BASE}/plan" -H 'Content-Type: application/json' \
  -d '{"text":"出一张"}' || true)"
if printf '%s' "$g" | python3 -c 'import json,sys
d=json.load(sys.stdin)
plan=d.get("plan") or {}
sys.exit(0 if (d.get("refuse") or plan.get("refuse")) else 1)'; then
  pass "POST /plan 出一张 refuse"
else
  fail_step "POST /plan 出一张 refuse"
  printf '%s\n' "$g"
fi

# 6) apply tiny image
a="$(curl -sS -X POST "${BASE}/apply" -H 'Content-Type: application/json' \
  -d "{\"image\":\"${TINY}\"}" || true)"
if printf '%s' "$a" | python3 -c 'import json,sys
d=json.load(sys.stdin)
ok = d.get("generated") is True and bool(d.get("base64")) and str(d.get("vendor","")).lower()=="mock"
sys.exit(0 if ok else 1)'; then
  pass "POST /apply tiny image generated+base64 vendor=mock"
else
  fail_step "POST /apply tiny image generated+base64 vendor=mock"
  printf '%s\n' "$a"
fi

if [ "$fail" -ne 0 ]; then
  echo "E2E FAIL"
  exit 1
fi
echo "E2E PASS"
exit 0
