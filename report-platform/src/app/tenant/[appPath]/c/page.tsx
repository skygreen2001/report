'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { LLM_PRESETS, presetOf, vendorLabel, initialProviderForm } from '@/lib/llm-presets';
import SchemaDoc, { type DsLite } from '@/components/SchemaDoc';

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
  const [tab, setTab] = useState<'gen' | 'reports' | 'bin' | 'doc' | 'llm'>('reports');
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
  // 模型配置（甲方自己的作用域，与开发者互不干扰；这里能看到并管理自己填的密钥）
  const [providers, setProviders] = useState<any[]>([]);
  const [providerId, setProviderId] = useState<string>('');
  const [llmForm, setLlmForm] = useState(() => initialProviderForm(true));
  const [llmTest, setLlmTest] = useState<Record<string, string>>({});
  // 数据库连接（只读：id / 名称 / 库名），用于查看数据库结构文档
  const [dsList, setDsList] = useState<DsLite[]>([]);

  async function loadBoot() {
    try {
      const r = await fetch(`${api}/bootstrap`, { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) { setErr(d.message || '加载失败'); return; }
      setAppName(d.app.name);
      setSettings(d.settings);
      setReports(d.reports || []);
      setTagTree(d.tagTree || []);
      setProviders(d.llmProviders || []);
      setDsList(d.dataSources || []);
    } catch (e: any) { setErr('加载失败：' + e.message); }
  }
  useEffect(() => { loadBoot(); }, [api]);
  // 支持 /{app}/c?tab=doc 直达结构文档
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t === 'doc' || t === 'gen' || t === 'reports') setTab(t);
  }, []);

  // —— 模型配置（甲方自己的作用域）——
  function applyPreset(vendor: string) {
    const p = LLM_PRESETS.find((x) => x.vendor === vendor);
    setLlmForm((f) => ({
      ...f, vendor,
      endpoint: p?.endpoint ?? f.endpoint,
      model: p?.models?.[0] ?? f.model,
      name: p ? p.label : f.name,
    }));
  }
  async function createProvider() {
    setErr(''); setMsg('');
    if (!llmForm.name || !llmForm.endpoint || !llmForm.model) { setErr('请填写模型名称、接口地址与模型名'); return; }
    try {
      const r = await fetch(`${api}/llm-providers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: llmForm.name, vendor: llmForm.vendor, endpoint: llmForm.endpoint,
          model: llmForm.model, apiKey: llmForm.apiKey || null, isDefault: llmForm.isDefault,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d.message || `新增失败（HTTP ${r.status}）`); return; }
      setMsg(`模型「${llmForm.name}」已添加${llmForm.isDefault ? '，并设为默认' : ''}`);
      setLlmForm(initialProviderForm(true));
      await loadBoot();
    } catch (e: any) { setErr('新增失败：' + e.message); }
  }
  async function testProviderCall(id: string, tmpKey?: string) {
    setErr(''); setMsg(''); setLlmTest((p) => ({ ...p, [id]: '测试中…' }));
    try {
      const r = await fetch(`${api}/llm-providers/${id}/test`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tmpKey ? { apiKey: tmpKey } : {}),
      });
      const d = await r.json().catch(() => ({}));
      setLlmTest((p) => ({ ...p, [id]: d.ok ? `✓ ${d.message || '连通成功'}` : `✗ ${d.message || '连通失败'}` }));
    } catch (e: any) { setLlmTest((p) => ({ ...p, [id]: '✗ ' + e.message })); }
  }
  async function makeDefaultProvider(id: string) {
    setErr(''); setMsg('');
    const r = await fetch(`${api}/llm-providers/${id}/default`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setErr(d.message || '设置失败'); return; }
    setMsg('已设为默认模型'); await loadBoot();
  }
  async function toggleProvider(p: any) {
    setErr(''); setMsg('');
    const next = p.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    const r = await fetch(`${api}/llm-providers/${p.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setErr(d.message || '操作失败'); return; }
    setMsg(next === 'ACTIVE' ? '已启用' : '已停用'); await loadBoot();
  }
  async function delProvider(p: any) {
    if (!confirm(`确认删除模型「${p.name}」？`)) return;
    setErr(''); setMsg('');
    const r = await fetch(`${api}/llm-providers/${p.id}`, { method: 'DELETE' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setErr(d.message || '删除失败'); return; }
    setMsg('已删除'); await loadBoot();
  }

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
        body: JSON.stringify({ prompt, dataSourceId: dsId, providerId: providerId || undefined }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || '生成失败');
      setGenMode(d.mode); setSql(d.sql ?? ''); setUnderstanding(d.understanding ?? (d.reason ? '降级手工模式：' + d.reason : ''));
      // 甲方未配置任何模型：直接把需求描述提交给开发者，由开发者据此生成 SQL 报表
      if (d.mode === 'manual' && d.noModel) {
        await submitRequirement(prompt);
        setSql(''); setUnderstanding('');
        setMsg('你尚未配置模型，已把需求提交给开发者，请等待开发者生成报表。');
        setErr('');
        return;
      }
      if (d.mode === 'manual') setErr('LLM 生成失败：' + (d.reason || '请检查模型配置或网络，也可点「求助开发者」'));
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  // 把需求描述直接提交给开发者（无模型时的主路径；也供「求助开发者」复用）
  async function submitRequirement(promptText: string) {
    if (!promptText?.trim()) return;
    try {
      await fetch(`${api}/requirements`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: promptText }),
      });
    } catch { /* 静默：提交失败不应阻断用户操作 */ }
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
  // 注：无模型时的「直接交需求」走 submitRequirement（见 gen）；help 用于生成失败后的补充求助。

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
    setMsg('已移入甲方回收站（开发者侧不受影响）');
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
          <div className={'node' + (tab === 'reports' ? ' on' : '')} onClick={() => setTab('reports')}>
            我的报表（{normalReports.length}）
          </div>
          <div className={'node' + (tab === 'gen' ? ' on' : '')} onClick={() => setTab('gen')}>生成新报表</div>
          <div className={'node' + (tab === 'doc' ? ' on' : '')} onClick={() => setTab('doc')}>数据库结构文档</div>
          <div className={'node' + (tab === 'llm' ? ' on' : '')} onClick={() => setTab('llm')}>模型配置</div>
          <div className={'node bin' + (tab === 'bin' ? ' on' : '')} onClick={() => setTab('bin')}>回收站（{binReports.length}）</div>
          <h4>提示</h4>
          <div className="muted" style={{ padding: '6px', fontSize: 12 }}>
            开发者发布的报表会出现在「我的报表」；也可以自己用自然语言生成。<br />
            「数据库结构文档」可查看表与字段含义，写需求时先查一下更准。
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

          {tab === 'bin' && (
            <div className="card">
              <div className="row"><strong>回收站（{binReports.length}）</strong><span className="pill rec">甲方自己的回收站 · 与开发者互不干扰</span></div>
              {binReports.length === 0
                ? <div className="muted" style={{ marginTop: 8 }}>回收站是空的。</div>
                : <div style={{ marginTop: 8 }}>{binReports.map((r) => reportRow(r, true))}</div>}
            </div>
          )}

          {tab === 'gen' && (
            <>
              <div className="card">
                <div className="row"><strong>① 描述需求</strong></div>
                <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="例如：最近30天各地区的订单金额汇总，按金额降序" />
                <div className="row" style={{ marginTop: 10 }}>
                  <select value={providerId} onChange={(e) => setProviderId(e.target.value)} style={{ maxWidth: 240 }}>
                    <option value="">默认模型</option>
                    {providers.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}
                  </select>
                  <button onClick={gen} disabled={busy || !dsId}>生成 SQL</button>
                  {!dsId && (
                    <span className="err">
                      当前应用（/{appPath}）还没有可用数据源：请开发者进入「开发者端 → 数据源」新建，并点「设为默认」
                    </span>
                  )}
                </div>
                {providers.length === 0 && (
                  <div className="muted" style={{ marginTop: 8 }}>
                    你还没有配置模型。点「生成 SQL」会把需求描述直接提交给开发者，由开发者据此生成报表；或到「模型配置」添加你自己的模型（含本地模型）。
                  </div>
                )}
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

          {tab === 'doc' && (
            <SchemaDoc api={api} dataSources={dsList} defaultId={settings?.defaultDs ?? undefined} />
          )}

          {tab === 'llm' && (
            <div className="card">
              <div className="row">
                <strong>模型配置</strong>
                <span className="muted">这是「甲方」自己的一套模型，与开发者互不干扰；可填自己的 API Key、加本地模型、连通测试、设默认。生成报表时只会用这里的模型。</span>
              </div>
              <div style={{ margin: '10px 0' }}>
                {providers.length === 0 && (
                  <div className="muted">还没配置模型。不配也能跑，只是「生成 SQL」会降级为手工模式。</div>
                )}
                {providers.map((p) => (
                  <div key={p.id} className="row" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ minWidth: 260 }}>
                      <strong>{p.name}</strong>
                      {!!p.is_default && <span className="badge">默认</span>}
                      {p.status === 'DISABLED' && <span className="pill rec">已停用</span>}
                      <div className="muted" style={{ fontSize: 12 }}>
                        {vendorLabel(p.vendor)} · {p.model}
                      </div>
                      {llmTest[p.id] && <div className="muted" style={{ fontSize: 12 }}>{llmTest[p.id]}</div>}
                    </div>
                    <div className="row">
                      <button className="ghost" style={{ padding: '2px 8px' }} onClick={() => testProviderCall(p.id)}>测试连接</button>
                      {!p.is_default && <button className="ghost" style={{ padding: '2px 8px' }} onClick={() => makeDefaultProvider(p.id)}>设为默认</button>}
                      <button className="ghost" style={{ padding: '2px 8px' }} onClick={() => toggleProvider(p)}>{p.status === 'ACTIVE' ? '停用' : '启用'}</button>
                      <button className="danger" style={{ padding: '2px 8px' }} onClick={() => delProvider(p)}>删除</button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="row">
                <select value={llmForm.vendor} onChange={(e) => applyPreset(e.target.value)} style={{ maxWidth: 220 }}>
                  {LLM_PRESETS.map((p) => <option key={p.vendor} value={p.vendor}>{p.label}</option>)}
                </select>
                <input placeholder="显示名" value={llmForm.name} onChange={(e) => setLlmForm({ ...llmForm, name: e.target.value })} />
                <input placeholder="接口地址（endpoint）" value={llmForm.endpoint} onChange={(e) => setLlmForm({ ...llmForm, endpoint: e.target.value })} />
                <input placeholder="模型名" list="llm-models-c" value={llmForm.model} onChange={(e) => setLlmForm({ ...llmForm, model: e.target.value })} />
                <datalist id="llm-models-c">
                  {(presetOf(llmForm.vendor)?.models ?? []).map((m) => <option key={m} value={m} />)}
                </datalist>
                <input type="password" placeholder={presetOf(llmForm.vendor)?.keyHint || 'API Key（本地模型可留空）'}
                  value={llmForm.apiKey} onChange={(e) => setLlmForm({ ...llmForm, apiKey: e.target.value })} />
                <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={llmForm.isDefault}
                    onChange={(e) => setLlmForm({ ...llmForm, isDefault: e.target.checked })} />设为默认
                </label>
                <button onClick={createProvider}>添加模型</button>
              </div>
              {presetOf(llmForm.vendor)?.note && <div className="muted" style={{ marginTop: 6 }}>※ {presetOf(llmForm.vendor)?.note}</div>}
            </div>
          )}

          {err && <div className="card err">⚠ {err}</div>}
          {msg && <div className="card ok">✓ {msg}</div>}
        </div>
      </div>
    </div>
  );
}
