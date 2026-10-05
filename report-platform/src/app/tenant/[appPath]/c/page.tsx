'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

interface Settings { clientCanViewSql: boolean; defaultDs: string | null; maxRows: number; [k: string]: any; }
interface ReportItem { id: string; name: string; tag_node_id: string | null; client_state: string; created_at: string; }
interface ParamDef { name: string; label: string; }

function parseSchema(json?: string | null): ParamDef[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.map((p: any) => ({ name: String(p.name), label: String(p.label || p.name) }));
  } catch { return []; }
}

export default function ClientPage() {
  const { appPath } = useParams<{ appPath: string }>();
  const api = `/${appPath}/c/api`;
  const [tab, setTab] = useState<'gen' | 'reports'>('reports');
  const [appName, setAppName] = useState('');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [prompt, setPrompt] = useState('');
  const [sql, setSql] = useState('');
  const [understanding, setUnderstanding] = useState('');
  const [genMode, setGenMode] = useState('');
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [reportName, setReportName] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // 我的报表（开发者发布的 + 自己保存的；双轨可见性已在接口层过滤）
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [tagTree, setTagTree] = useState<any[]>([]);
  const [selId, setSelId] = useState<string>('');
  const [sel, setSel] = useState<any>(null);
  const [repSchema, setRepSchema] = useState<ParamDef[]>([]);
  const [repParams, setRepParams] = useState<Record<string, string>>({});
  const [repCols, setRepCols] = useState<string[]>([]);
  const [repRows, setRepRows] = useState<any[]>([]);
  const [repMsg, setRepMsg] = useState('');

  async function loadBoot() {
    try {
      const r = await fetch(`${api}/bootstrap`, { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) { setErr(d.message || '加载失败'); return; }
      setAppName(d.app.name);
      setSettings(d.settings);
      setReports(d.reports || []);
      setTagTree(d.tagTree || []);
    } catch (e: any) { setErr('加载失败：' + e.message); }
  }
  useEffect(() => { loadBoot(); }, [api]);

  const dsId = settings?.defaultDs ?? '';
  const nodeOf = (id: string | null) => tagTree.find((n) => n.id === id);
  const inBin = (r: ReportItem) => nodeOf(r.tag_node_id)?.kind_uniq === 'RECYCLE_BIN' || r.client_state === 'RECYCLED';
  const normalReports = reports.filter((r) => !inBin(r));
  const binReports = reports.filter((r) => inBin(r));

  async function gen() {
    setErr(''); setBusy(true); setMsg('');
    try {
      const r = await fetch(`${api}/reports/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, dataSourceId: dsId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || '生成失败');
      setGenMode(d.mode); setSql(d.sql ?? ''); setUnderstanding(d.understanding ?? (d.reason ? '降级手工模式：' + d.reason : ''));
      if (d.mode === 'manual') setErr('LLM 未配置或失败，已降级手工模式，请开发者填写 SQL。');
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  async function preview() {
    setErr(''); setBusy(true);
    try {
      const r = await fetch(`${api}/reports/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, dataSourceId: dsId, params: {} }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || '预览失败');
      setColumns(d.columns); setRows(d.rows);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  async function doExport(fmt: 'xlsx' | 'csv') {
    setErr(''); setBusy(true);
    try {
      const r = await fetch(`${api}/exports`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, dataSourceId: dsId, params: {}, format: fmt }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || '导出失败');
      pollExport(d.id);
    } catch (e: any) { setErr(e.message); setBusy(false); }
  }

  async function exportReport(fmt: 'xlsx' | 'csv') {
    setErr(''); setBusy(true);
    try {
      const r = await fetch(`${api}/exports`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportId: selId, params: repParams, format: fmt }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || '导出失败');
      pollExport(d.id);
    } catch (e: any) { setErr(e.message); setBusy(false); }
  }

  async function pollExport(id: string) {
    const t = setInterval(async () => {
      const r = await fetch(`${api}/exports/${id}`);
      const d = await r.json();
      if (d.status === 'DONE') {
        clearInterval(t); setBusy(false);
        setMsg(`导出完成（${d.rowCount} 行），开始下载…`);
        window.open(`${api}/exports/${id}`, '_blank');
      } else if (d.status === 'FAILED') {
        clearInterval(t); setBusy(false); setErr('导出失败：' + (d.error || ''));
      }
    }, 1000);
  }

  async function save() {
    setErr('');
    if (!reportName) { setErr('请填写报表名称'); return; }
    const r = await fetch(`${api}/reports`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: reportName, sqlText: sql, dataSourceId: dsId }),
    });
    const d = await r.json();
    if (!r.ok) { setErr(d.message); return; }
    setMsg('已保存为常用报表，可在「我的报表」查看');
    setReportName('');
    await loadBoot();
  }

  async function help() {
    setErr('');
    const r = await fetch(`${api}/requirements`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, failedSql: sql, errorMsg: err }),
    });
    const d = await r.json();
    if (!r.ok) { setErr(d.message); return; }
    setMsg('已提交求助，等待开发者处理');
  }

  // —— 我的报表：打开 / 执行 / 删除 / 还原 ——
  async function openReport(id: string) {
    setErr(''); setMsg(''); setRepCols([]); setRepRows([]); setRepMsg('');
    const r = await fetch(`${api}/reports/${id}`, { cache: 'no-store' });
    const d = await r.json();
    if (!r.ok) { setErr(d.message || '报表不存在或已被彻底删除'); return; }
    setSelId(id); setSel(d);
    const schema = parseSchema(d.paramsSchemaJson);
    setRepSchema(schema);
    const init: Record<string, string> = {};
    schema.forEach((p) => { init[p.name] = ''; });
    setRepParams(init);
    if (schema.length === 0) runReport(id, {});
    else setRepMsg('该报表需要参数，填好后点「查询」');
  }

  async function runReport(id: string, params: Record<string, string>) {
    setErr(''); setBusy(true); setRepMsg('');
    try {
      const r = await fetch(`${api}/reports/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportId: id, params }),
      });
      const d = await r.json();
      if (!r.ok) {
        setErr(`查询失败：${d.code}${d.message && d.message !== d.code ? ' — ' + d.message : ''}`);
        setRepCols([]); setRepRows([]); return;
      }
      setRepCols(d.columns || []); setRepRows(d.rows || []);
      setRepMsg(d.rows.length ? `共 ${d.rows.length} 行（上限 200）` : '查询成功，但返回 0 行');
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  async function delReport(id: string) {
    setErr(''); setMsg('');
    const r = await fetch(`${api}/reports/${id}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await r.json();
    if (!r.ok) { setErr(d.message || '删除失败'); return; }
    if (selId === id) { setSel(null); setSelId(''); setRepCols([]); setRepRows([]); setRepMsg(''); }
    setMsg('已移入回收站（开发者侧不受影响）');
    await loadBoot();
  }

  async function restoreRep(id: string) {
    setErr(''); setMsg('');
    const r = await fetch(`${api}/reports/${id}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await r.json();
    if (!r.ok) { setErr(d.message || '还原失败'); return; }
    setMsg('已还原');
    await loadBoot();
  }

  function reportRow(r: ReportItem, recycled: boolean) {
    return (
      <div className="row" key={r.id} style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
        <div style={{ cursor: 'pointer', minWidth: 220 }} onClick={() => openReport(r.id)}>
          <strong>{r.name}</strong>{selId === r.id && <span className="pill">当前</span>}
          <div className="muted" style={{ fontSize: 12 }}>
            {nodeOf(r.tag_node_id)?.name ?? '根目录'} · {new Date(r.created_at).toLocaleString('zh-CN')}
          </div>
        </div>
        <div className="row">
          <button className="ghost" disabled={busy} onClick={() => openReport(r.id)}>查看</button>
          {recycled
            ? <button className="ghost" disabled={busy} onClick={() => restoreRep(r.id)}>还原</button>
            : <button className="ghost" disabled={busy} onClick={() => delReport(r.id)}>删除</button>}
        </div>
      </div>
    );
  }

  return (
    <div className="layout">
      <div className="topbar">
        <span className="app-name">{appName || '报表平台'}</span>
        <span className="badge">甲方</span>
        <div className="exitbar" style={{ marginLeft: 'auto' }}>
          <a className="badge dev" href={`/${appPath}/d`}>切换开发者</a>
        </div>
      </div>
      <div className="main">
        <div className="side">
          <h4>导航</h4>
          <div className="node" onClick={() => setTab('reports')} style={tab === 'reports' ? { background: '#eef2ff', color: 'var(--primary)' } : undefined}>
            我的报表（{normalReports.length}）
          </div>
          <div className="node" onClick={() => setTab('gen')} style={tab === 'gen' ? { background: '#eef2ff', color: 'var(--primary)' } : undefined}>
            生成新报表
          </div>
          <div className="node bin" onClick={() => setTab('reports')}>回收站（{binReports.length}）</div>
          <h4>提示</h4>
          <div className="muted" style={{ padding: '6px' }}>
            开发者发布的报表会出现在「我的报表」；也可以自己用自然语言生成。
          </div>
        </div>
        <div className="content">
          {tab === 'reports' && (
            <>
              <div className="card">
                <div className="row"><strong>我的报表</strong><span className="muted">点击「查看」立即运行</span></div>
                <div style={{ marginTop: 8 }}>
                  {normalReports.length === 0
                    ? <div className="muted">还没有报表。可自己生成后保存，或等开发者发布。</div>
                    : normalReports.map((r) => reportRow(r, false))}
                </div>
                {binReports.length > 0 && (
                  <div style={{ marginTop: 14 }}>
                    <div className="row"><strong>回收站</strong><span className="pill rec">仅甲方侧不可见</span></div>
                    <div style={{ marginTop: 8 }}>{binReports.map((r) => reportRow(r, true))}</div>
                  </div>
                )}
              </div>

              {sel && (
                <div className="card">
                  <div className="row">
                    <strong>{sel.name}</strong>
                    {sel.clientHidden && <span className="pill rec">已删除</span>}
                  </div>
                  {sel.currentSql && <div className="code" style={{ marginTop: 8 }}>{sel.currentSql}</div>}
                  {repSchema.length > 0 && (
                    <div className="row" style={{ marginTop: 10 }}>
                      {repSchema.map((p) => (
                        <input key={p.name} style={{ maxWidth: 200 }} placeholder={p.label}
                          value={repParams[p.name] ?? ''}
                          onChange={(e) => setRepParams((prev) => ({ ...prev, [p.name]: e.target.value }))} />
                      ))}
                      <button disabled={busy} onClick={() => runReport(selId, repParams)}>查询</button>
                    </div>
                  )}
                  {repMsg && <div className="muted" style={{ marginTop: 8 }}>{repMsg}</div>}
                  {repCols.length > 0 && (
                    <div className="table-wrap" style={{ marginTop: 10 }}>
                      <table>
                        <thead><tr>{repCols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                        <tbody>{repRows.map((r, i) => <tr key={i}>{repCols.map((c) => <td key={c}>{String(r[c] ?? '')}</td>)}</tr>)}</tbody>
                      </table>
                    </div>
                  )}
                  <div className="row" style={{ marginTop: 10 }}>
                    <button className="ghost" disabled={busy} onClick={() => runReport(selId, repParams)}>刷新数据</button>
                    <button className="ghost" disabled={busy} onClick={() => exportReport('xlsx')}>导出 xlsx</button>
                    <button className="ghost" disabled={busy} onClick={() => exportReport('csv')}>导出 csv</button>
                  </div>
                </div>
              )}
            </>
          )}

          {tab === 'gen' && (
            <>
              <div className="card">
                <div className="row"><strong>① 描述需求</strong></div>
                <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="例如：最近30天各地区的订单金额汇总，按金额降序" />
                <div className="row" style={{ marginTop: 10 }}>
                  <button onClick={gen} disabled={busy || !dsId}>生成 SQL</button>
                  {!dsId && (
                    <span className="err">
                      当前应用（/{appPath}）还没有可用数据源：请开发者进入「开发者端 → 数据源」新建，并点「设为默认」
                    </span>
                  )}
                </div>
              </div>

              {sql && (
                <div className="card">
                  <div className="row"><strong>② 生成的 SQL</strong>{genMode && <span className="pill">{genMode === 'llm' ? 'LLM' : '手工'}</span>}</div>
                  <div className="code">{sql}</div>
                  {understanding && <div className="muted" style={{ marginTop: 6 }}>{understanding}</div>}
                  <div className="row" style={{ marginTop: 10 }}>
                    <button onClick={preview} disabled={busy}>预览（≤200 行）</button>
                    <button className="ghost" onClick={() => doExport('xlsx')} disabled={busy}>仅导出 xlsx</button>
                    <button className="ghost" onClick={() => doExport('csv')} disabled={busy}>导出 csv</button>
                  </div>
                </div>
              )}

              {columns.length > 0 && (
                <div className="card">
                  <strong>③ 预览结果（{rows.length} 行）</strong>
                  <div className="table-wrap" style={{ marginTop: 8 }}>
                    <table><thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                      <tbody>{rows.map((r, i) => <tr key={i}>{columns.map((c) => <td key={c}>{String(r[c] ?? '')}</td>)}</tr>)}</tbody>
                    </table>
                  </div>
                  <div className="row" style={{ marginTop: 10 }}>
                    <input style={{ maxWidth: 240 }} placeholder="报表名称" value={reportName} onChange={(e) => setReportName(e.target.value)} />
                    <button className="ghost" onClick={save}>保存为常用报表</button>
                    <button className="ghost" onClick={help}>求助开发者</button>
                  </div>
                </div>
              )}
            </>
          )}

          {err && <div className="card err">⚠ {err}</div>}
          {msg && <div className="card ok">✓ {msg}</div>}
        </div>
      </div>
    </div>
  );
}
