'use client';
import { useEffect, useMemo, useState } from 'react';

// 数据库结构文档（数据字典）：表清单 + 字段明细 + 索引 + 外键
// 甲乙两端共用；后端接口 GET/POST /api/data-sources/{id}/schema
export interface DocColumn {
  name: string; type: string; nullable: boolean;
  key: '' | 'PRI' | 'UNI' | 'MUL'; defaultValue: string | null; extra: string; comment: string;
}
export interface DocTable {
  name: string; comment: string; engine: string; rows: number; collation: string;
  createdAt: string | null; sizeBytes: number;
  columns: DocColumn[];
  indexes: { name: string; columns: string[]; unique: boolean }[];
  foreignKeys: { constraint: string; column: string; refTable: string; refColumn: string }[];
}
export interface Doc {
  dsId: string; dsName: string; database: string; generatedAt: string;
  tableCount: number; columnCount: number; tables: DocTable[];
}
export interface DsLite { id: string; name: string; database_name: string; }

function fmtBytes(n: number): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
function fmtRows(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
  return n.toLocaleString('zh-CN');
}
function fmtTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false });
}
function yes(v: boolean) { return v ? <span className="muted">—</span> : <span style={{ color: 'var(--danger)' }}>必填</span>; }

export default function SchemaDoc({
  api, dataSources, defaultId,
}: { api: string; dataSources: DsLite[]; defaultId?: string }) {
  const [dsId, setDsId] = useState<string>(defaultId || dataSources[0]?.id || '');
  const [doc, setDoc] = useState<Doc | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string>('');

  async function load(id: string, force = false) {
    if (!id) return;
    setLoading(true); setErr('');
    try {
      const r = force
        ? await fetch(`${api}/data-sources/${id}/schema`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        : await fetch(`${api}/data-sources/${id}/schema`, { cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d.message || `加载失败（HTTP ${r.status}）`); setDoc(null); return; }
      setDoc(d.doc);
      setSel((prev) => (d.doc?.tables?.some((t: DocTable) => t.name === prev) ? prev : d.doc?.tables?.[0]?.name ?? ''));
    } catch (e: any) { setErr('加载失败：' + e.message); setDoc(null); }
    finally { setLoading(false); }
  }

  useEffect(() => { if (dsId) load(dsId); /* eslint-disable-next-line */ }, [dsId, api]);
  // 默认数据源后到（bootstrap 异步）时补一次选中
  useEffect(() => { if (!dsId && defaultId) setDsId(defaultId); }, [defaultId, dsId]);

  const filtered = useMemo(() => {
    if (!doc) return [];
    const kw = q.trim().toLowerCase();
    if (!kw) return doc.tables;
    return doc.tables.filter(
      (t) =>
        t.name.toLowerCase().includes(kw) ||
        (t.comment || '').toLowerCase().includes(kw) ||
        t.columns.some((c) => c.name.toLowerCase().includes(kw) || (c.comment || '').toLowerCase().includes(kw)),
    );
  }, [doc, q]);

  const table = doc?.tables.find((t) => t.name === sel) ?? null;

  if (dataSources.length === 0) {
    return (
      <div className="doc-panel">
        <div className="doc-empty">该应用还没有数据库连接，无法生成结构文档。请先在「数据源」中新建连接。</div>
      </div>
    );
  }

  return (
    <div>
      <div className="doc-head">
        <span className="doc-title">数据库结构文档</span>
        <select
          value={dsId}
          onChange={(e) => setDsId(e.target.value)}
          style={{ width: 260 }}
        >
          {dataSources.map((d) => (
            <option key={d.id} value={d.id}>{d.name} · {d.database_name}</option>
          ))}
        </select>
        <input
          placeholder="搜索表名 / 字段名 / 注释"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ width: 260 }}
        />
        <button className="ghost" onClick={() => load(dsId, true)} disabled={loading || !dsId}>
          {loading ? '读取中…' : '重新抓取结构'}
        </button>
        {doc && (
          <span className="doc-stat">
            {doc.tableCount} 张表 · {doc.columnCount} 个字段 · 更新于 {fmtTime(doc.generatedAt)}
          </span>
        )}
      </div>

      {err && <div className="card err">⚠ {err}</div>}

      <div className="doc-layout">
        <div className="doc-panel">
          <div className="doc-panel-head">
            <strong>表清单</strong>
            <span className="doc-stat">{filtered.length}{q ? ` / ${doc?.tables.length ?? 0}` : ''}</span>
          </div>
          <div className="doc-search">
            <input placeholder="过滤…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="doc-list">
            {filtered.map((t) => (
              <div key={t.name} className={'doc-item' + (sel === t.name ? ' on' : '')} onClick={() => setSel(t.name)}>
                <div className="t">{t.name}</div>
                {t.comment && <div className="c">{t.comment}</div>}
                <div className="n">{t.columns.length} 字段 · 约 {fmtRows(t.rows)} 行</div>
              </div>
            ))}
            {filtered.length === 0 && <div className="doc-empty">{loading ? '读取中…' : '没有匹配的表'}</div>}
          </div>
        </div>

        <div className="doc-panel">
          {!table ? (
            <div className="doc-empty">{loading ? '正在读取数据库结构…' : '请在左侧选择一张表'}</div>
          ) : (
            <div className="doc-detail">
              <div className="doc-detail-head">
                <div className="name">{table.name}</div>
                <div className="cmt">{table.comment || '（该表未填写注释）'}</div>
                <div className="doc-chips">
                  <span className="doc-chip blue">{table.engine || '—'}</span>
                  <span className="doc-chip">约 {fmtRows(table.rows)} 行</span>
                  <span className="doc-chip">{table.columns.length} 字段</span>
                  <span className="doc-chip">{fmtBytes(table.sizeBytes)}</span>
                  <span className="doc-chip">{table.collation || '—'}</span>
                  <span className="doc-chip">创建于 {fmtTime(table.createdAt)}</span>
                </div>
              </div>

              <div className="doc-sec">
                <h5>字段明细（{table.columns.length}）</h5>
                <div className="table-wrap" style={{ maxHeight: 420 }}>
                  <table className="doc-table">
                    <thead>
                      <tr>
                        <th style={{ width: 40 }}>#</th>
                        <th>字段名称</th>
                        <th>数据类型</th>
                        <th style={{ width: 64 }}>主键</th>
                        <th style={{ width: 64 }}>必填</th>
                        <th style={{ width: 120 }}>默认值</th>
                        <th>说明</th>
                      </tr>
                    </thead>
                    <tbody>
                      {table.columns.map((c, i) => (
                        <tr key={c.name + i}>
                          <td className="muted">{i + 1}</td>
                          <td><span className="doc-colname">{c.name}</span></td>
                          <td>
                            <span className="doc-type">{c.type}</span>
                            {c.extra && c.extra !== '' && (
                              <div><span className="doc-chip orange">{c.extra}</span></div>
                            )}
                          </td>
                          <td>
                            {c.key === 'PRI' && <span className="doc-chip red">主键</span>}
                            {c.key === 'UNI' && <span className="doc-chip blue">唯一</span>}
                            {c.key === 'MUL' && <span className="doc-chip">索引</span>}
                            {!c.key && <span className="muted">—</span>}
                          </td>
                          <td>{yes(c.nullable)}</td>
                          <td className="muted">{c.defaultValue == null ? '—' : c.defaultValue}</td>
                          <td>{c.comment || <span className="muted">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="doc-sec">
                <h5>索引（{table.indexes.length}）</h5>
                {table.indexes.length === 0
                  ? <div className="muted">无</div>
                  : table.indexes.map((x) => (
                    <div key={x.name} className="doc-kv" style={{ marginBottom: 6 }}>
                      <span className="doc-chip blue">{x.name}</span>
                      <span className="doc-type">{x.columns.join(', ')}</span>
                      {x.unique && <span className="doc-chip green">唯一</span>}
                    </div>
                  ))}
              </div>

              {table.foreignKeys.length > 0 && (
                <div className="doc-sec">
                  <h5>外键（{table.foreignKeys.length}）</h5>
                  {table.foreignKeys.map((f) => (
                    <div key={f.constraint} className="doc-kv" style={{ marginBottom: 6 }}>
                      <span className="doc-type">{f.column}</span>
                      <span className="muted">→</span>
                      <span className="doc-colname">{f.refTable}.{f.refColumn}</span>
                      <span className="muted">{f.constraint}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
