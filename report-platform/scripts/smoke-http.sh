#!/usr/bin/env bash
# Web 端到端冒烟：真实 HTTP 走一遍 生成 → 保存 → 预览 → 导出 → 双轨生命周期。
# 前置：next dev 已在 3111 端口运行（node node_modules/next/dist/bin/next dev -p 3111）
set -u
BASE=${BASE:-http://127.0.0.1:3111}
APP=${APP:-demo}
DS=${DS:-55526134-33e3-4523-a2ad-ec3b04bf287e}

pass=0; fail=0
chk() { # chk <label> <期望> <实际>
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ✓ $1 ($3)";
  else fail=$((fail+1)); echo "  ✗ $1 — 期望 $2，实际 $3"; fi
}
st() { curl -s -o /tmp/_sm.json -w '%{http_code}' "$@"; }
j() { local expr="$1"; shift; node -e "const d=require('/tmp/_sm.json'); console.log($expr)" "$@" 2>/dev/null || head -c 200 /tmp/_sm.json; }
# 安全构造 JSON（SQL 含换行/引号，直接拼字符串会破坏 JSON）
mkjson() {
  node -e '
    const o={};
    for (const a of process.argv.slice(1)) { const i=a.indexOf("="); o[a.slice(0,i)]=a.slice(i+1); }
    process.stdout.write(JSON.stringify(o));
  ' "$@"
}

echo "=== ① NL2SQL 生成（真实 DeepSeek）==="
c=$(st -X POST "$BASE/$APP/c/api/reports/generate" -H 'content-type: application/json' \
  -d "$(mkjson "prompt=统计各地区的订单数和总金额，按总金额降序" "dataSourceId=$DS")")
chk "生成接口状态" 200 "$c"
SQL=$(j "d.sql||''")
MODE=$(j "d.mode||''")
echo "     mode=$MODE"
echo "     sql=$(echo "$SQL" | head -c 160)"
[ -z "$SQL" ] && SQL="SELECT region, COUNT(*) AS cnt, SUM(amount) AS total FROM orders GROUP BY region ORDER BY total DESC"

echo "=== ② 保存报表（开发者）==="
NAME="冒烟报表-$(date +%s)"
c=$(st -X POST "$BASE/$APP/d/api/reports" -H 'content-type: application/json' \
  -d "$(mkjson "name=$NAME" "sqlText=$SQL" "dataSourceId=$DS")")
chk "保存接口状态" 201 "$c"
RID=$(j "d.id||''")
echo "     reportId=$RID"

echo "=== ③ 按 reportId 预览 ==="
c=$(st -X POST "$BASE/$APP/d/api/reports/preview" -H 'content-type: application/json' \
  -d "$(mkjson "reportId=$RID")")
chk "预览接口状态" 200 "$c"
echo "     返回行数: $(j "d.rows.length")"

echo "=== ④ 导出 CSV ==="
c=$(st -X POST "$BASE/$APP/c/api/exports" -H 'content-type: application/json' \
  -d "$(mkjson "reportId=$RID" "format=csv")")
chk "导出接口状态" 200 "$c"
EID=$(j "d.id||''")
sleep 4
c=$(st "$BASE/$APP/c/api/exports/mine")
chk "导出列表状态" 200 "$c"
echo "     任务状态: $(j "(d.exports[0]||{}).status"), 行数: $(j "(d.exports[0]||{}).row_count")"

echo "=== ⑤ 双轨生命周期（甲方删 → 开发者仍可见）==="
c=$(st -X POST "$BASE/$APP/c/api/reports/$RID/delete" -H 'content-type: application/json' -d '{}')
chk "甲方删除状态" 200 "$c"
c=$(st "$BASE/$APP/d/api/reports")
DEV_SEEN=$(j "d.reports.filter(r=>r.id===process.argv[1]).length" "$RID")
c=$(st "$BASE/$APP/c/api/reports")
CLI_IN_BIN=$(j "d.reports.filter(r=>r.id===process.argv[1]).length" "$RID")
# 甲方回收站节点 id（直接管道，避免临时文件复用带来的干扰）
BIN=$(curl -s "$BASE/$APP/c/api/tag-tree" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.nodes.filter(n=>n.kind==='RECYCLE_BIN')[0].id)})")
CLI_AT_BIN=$(curl -s "$BASE/$APP/c/api/reports" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.reports.filter(r=>r.id===process.argv[1] && r.tag_node_id===process.argv[2]).length)})" "$RID" "$BIN")
chk "开发者仍可见" 1 "$DEV_SEEN"
chk "甲方侧仍可列出（回收站可见）" 1 "$CLI_IN_BIN"
chk "甲方侧挂在回收站下" 1 "$CLI_AT_BIN"

echo "=== ⑥ 甲方还原 ==="
c=$(st -X POST "$BASE/$APP/c/api/reports/$RID/restore" -H 'content-type: application/json' -d '{}')
chk "还原接口状态" 200 "$c"

echo "=== ⑦ 安全拦截（HTTP 层）==="
for s in "DROP TABLE orders::STMT_NOT_READONLY" "SELECT user FROM mysql.user::SYSTEM_SCHEMA" "SELECT SLEEP(3)::DANGEROUS_FUNCTION" "SELECT * FROM orders; DROP TABLE orders::MULTI_STATEMENT"; do
  sql="${s%%::*}"; want="${s##*::}"
  c=$(st -X POST "$BASE/$APP/d/api/reports/preview" -H 'content-type: application/json' \
    -d "$(mkjson "sql=$sql" "dataSourceId=$DS")")
  got=$(j "d.code||''")
  chk "拦截 $want" "$want" "$got"
done

echo "=== ⑧ 清理（开发者物理删除）==="
st -X POST "$BASE/$APP/c/api/reports/$RID/delete" -H 'content-type: application/json' -d '{}' >/dev/null
c=$(st -X POST "$BASE/$APP/d/api/recycle-bin" -H 'content-type: application/json' \
  -d "$(node -e 'console.log(JSON.stringify({ids:[process.argv[1]]}))' "$RID")")
chk "清空接口状态" 200 "$c"

echo
echo "结果：$pass 通过 / $fail 失败"
[ "$fail" -eq 0 ]
