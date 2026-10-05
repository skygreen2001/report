'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

interface Boot { app: any; role: string; settings: any; reports: any[]; tagTree: any[]; dataSources: any[]; }

export default function DevPage() {
  const { appPath } = useParams<{ appPath: string }>();
  const api = `/${appPath}/d/api`;
  const [boot, setBoot] = useState<Boot | null>(null);
  const [tab, setTab] = useState<'ds' | 'reports' | 'apps' | 'req'>('ds');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  // 数据源表单
  const [dsForm, setDsForm] = useState({ name: '', host: '127.0.0.1', port: 3306, database_name: 'biz_demo', username: 'report_ro', password: 'ReportRo@2026' });
  const [dsList, setDsList] = useState<any[]>([]);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  // 报表编辑
  const [selReport, setSelReport] = useState<any>(null);
  const [editSql, setEditSql] = useState('');
  const [reports, setReports] = useState<any[]>([]);

  // 直接写 SQL 建报表
  const [busy, setBusy] = useState(false);
  const [newForm, setNewForm] = useState({ name: '', sqlText: '', dataSourceId: '' });
  const [newParams, setNewParams] = useState<Record<string, string>>({});
  const [prevCols, setPrevCols] = useState<string[]>([]);
  const [prevRows, setPrevRows] = useState<any[]>([]);
  const [prevMsg, setPrevMsg] = useState('');

  // 应用管理
  const [apps, setApps] = useState<any[]>([]);
  const [appForm, setAppForm] = useState({ name: '', pathPrefix: '' });

  // 需求
  const [reqs, setReqs] = useState<any[]>([]);

  async function load() {
    setErr('');
    const r = await fetch(`${api}/bootstrap`, { cache: 'no-store' });
    const d = await r.json();
    if (!r.ok) { setErr(d.message || '加载失败'); return; }
    setBoot(d);
    setDsList(d.dataSources || []);
    setReports(d.reports || []);
    // 新建报表的数据源默认取应用默认数据源
    setNewForm((f) => (f.dataSourceId ? f : { ...f, dataSourceId: d.settings?.defaultDs ?? '' }));
    if (d.app.isPlatformRoot) {
      const ar = await fetch(`${api}/applications`, { cache: 'no-store' });
      setApps((await ar.json()).applications || []);
    }
  }
  useEffect(() => { load(); }, [api]);

  async function createDs() {
    setErr('');
    const r = await fetch(`${api}/data-sources`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dsForm),
    });
    const d = await r.json();
    if (!r.ok) { setErr(d.message); return; }
    setMsg('数据源已创建'); load();
  }
  async function testDs(id: string) {
    const r = await fetch(`${api}/data-sources/${id}/test`, { method: 'POST' });
    const d = await r.json();
    setTestResult((p) => ({ ...p, [id]: d.ok ? (d.isReadonly ? '连接成功 · 只读✓' : '连接成功 · 但非只读✗') : '连接失败' }));
  }
  async function makeDefault(id: string) {
    setErr(''); setMsg('');
    const r = await fetch(`${api}/data-sources/${id}/default`, { method: 'POST' });
    const d = await r.json();
    if (!r.ok) { setErr(d.message || '设置失败'); return; }
    setMsg('已设为默认数据源'); await load();
  }
  async function openReport(id: string) {
    const r = await fetch(`${api}/reports/${id}`, { cache: 'no-store' });
    const d = await r.json();
    setSelReport(d); setEditSql(d.currentSql || '');
  }
  async function saveSql() {
    if (!selReport) return;
    const r = await fetch(`${api}/reports/${selReport.id}/sql`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sqlText: editSql }),
    });
    const d = await r.json();
    if (!r.ok) { setErr(d.message); return; }
    setMsg('SQL 已更新，甲方刷新即见新结果（REQ-COL-03）'); load();
  }
  // SQL 里的 {{name}} 占位符（网关会校验只允许出现在值位置）
  const phNames = Array.from(
    new Set(Array.from(newForm.sqlText.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)).map((m) => m[1])),
  );

  // 当前生效的数据源（下拉没选就用应用默认）
  const effDsId = newForm.dataSourceId || boot?.settings?.defaultDs || '';
  const selDs = dsList.find((d) => d.id === effDsId);
  const selDsName = selDs ? `${selDs.name} · ${selDs.database_name}` : '（该应用还没有数据源）';

  async function previewNew() {
    setErr(''); setMsg(''); setPrevMsg(''); setBusy(true);
    try {
      const r = await fetch(`${api}/reports/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: newForm.sqlText, dataSourceId: newForm.dataSourceId || undefined, params: newParams }),
      });
      const d = await r.json();
      if (!r.ok) { setErr(`查询失败：${d.code}${d.message && d.message !== d.code ? ' — ' + d.message : ''}`); setPrevCols([]); setPrevRows([]); setPrevMsg(''); return; }
      setPrevCols(d.columns || []); setPrevRows(d.rows || []);
      setPrevMsg(d.rows.length ? `预览成功 · ${d.rows.length} 行（上限 200）` : '查询成功，但返回 0 行');
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  async function saveNewReport() {
    setErr(''); setMsg(''); setBusy(true);
    try {
      const r = await fetch(`${api}/reports`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newForm.name,
          sqlText: newForm.sqlText,
          dataSourceId: newForm.dataSourceId || undefined,
          // 无 {{param}} 占位符时干脆不带这个字段（服务端已兼容 null）
          ...(phNames.length
            ? { paramsSchemaJson: JSON.stringify(phNames.map((n) => ({ name: n, label: n, type: 'string', required: true }))) }
            : {}),
        }),
      });
      const d = await r.json();
      if (!r.ok) { setErr(d.message || '保存失败'); return; }
      setMsg(`报表「${newForm.name}」已保存，甲方端立即可见`);
      setNewForm({ name: '', sqlText: '', dataSourceId: boot?.settings?.defaultDs ?? '' });
      setNewParams({}); setPrevCols([]); setPrevRows([]); setPrevMsg('');
      await load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  async function createApp() {
    const r = await fetch(`${api}/applications`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(appForm),
    });
    const d = await r.json();
    if (!r.ok) { setErr(d.message); return; }
    setMsg('应用已创建'); load();
  }
  async function disableApp(id: string) {
    const r = await fetch(`${api}/applications/${id}:disable`, { method: 'POST' });
    const d = await r.json();
    if (!r.ok) { setErr(d.message); return; }
    setMsg('应用已停用'); load();
  }
  async function loadReqs() {
    const r = await fetch(`${api}/requirements`, { cache: 'no-store' });
    setReqs((await r.json()).requirements || []);
  }
  useEffect(() => { if (tab === 'req') loadReqs(); }, [tab]);

  if (!boot) return <div className="layout"><div className="topbar"><span className="app-name">加载中…</span></div></div>;

  return (
    <div className="layout">
      <div className="topbar">
        <span className="app-name">{boot.app.name}</span>
        <span className="badge dev">开发者</span>
        <a className="badge" href={`/${appPath}/c`} style={{ marginLeft: 'auto' }}>切换甲方</a>
      </div>
      <div className="main">
        <div className="side">
          <h4>导航</h4>
          <div className={'node' + (tab === 'ds' ? ' badge' : '')} onClick={() => setTab('ds')}>数据源</div>
          <div className={'node' + (tab === 'reports' ? ' badge' : '')} onClick={() => setTab('reports')}>报表</div>
          {boot.app.isPlatformRoot && <div className={'node' + (tab === 'apps' ? ' badge' : '')} onClick={() => setTab('apps')}>应用管理</div>}
          <div className={'node' + (tab === 'req' ? ' badge' : '')} onClick={() => setTab('req')}>需求收件箱</div>
        </div>
        <div className="content">
          {err && <div className="card err">⚠ {err}</div>}
          {msg && <div className="card ok">✓ {msg}</div>}

          {tab === 'ds' && (
            <div className="card">
              <strong>数据源（只读账号）</strong>
              <div className="row" style={{ margin: '10px 0' }}>
                {dsList.map((d) => (
                  <div key={d.id} className="pill" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {d.name} · {d.database_name} · {d.username}
                    {boot?.settings?.defaultDs === d.id && <span className="badge">默认</span>}
                    <button className="ghost" style={{ padding: '2px 8px' }} onClick={() => testDs(d.id)}>测试</button>
                    {boot?.settings?.defaultDs !== d.id && (
                      <button className="ghost" style={{ padding: '2px 8px' }} onClick={() => makeDefault(d.id)}>设为默认</button>
                    )}
                    <span className="muted">{testResult[d.id] || ''}</span>
                  </div>
                ))}
                {dsList.length === 0 && <span className="muted">还没有数据源，请先在下方新建。</span>}
              </div>
              <div className="row">
                <input placeholder="名称" value={dsForm.name} onChange={(e) => setDsForm({ ...dsForm, name: e.target.value })} />
                <input placeholder="库名" value={dsForm.database_name} onChange={(e) => setDsForm({ ...dsForm, database_name: e.target.value })} />
                <input placeholder="用户名" value={dsForm.username} onChange={(e) => setDsForm({ ...dsForm, username: e.target.value })} />
                <input placeholder="密码" type="password" value={dsForm.password} onChange={(e) => setDsForm({ ...dsForm, password: e.target.value })} />
                <button onClick={createDs}>新建</button>
              </div>
              <div className="muted" style={{ marginTop: 6 }}>只读账号示例：report_ro / ReportRo@2026（仅 SELECT）。M0 验收：测试连接后 INSERT 应失败。</div>
            </div>
          )}

          {tab === 'reports' && (
            <>
              <div className="card">
                <strong>新建报表（直接写 SQL）</strong>
                <div className="row" style={{ margin: '10px 0' }}>
                  <input
                    placeholder="报表名称"
                    value={newForm.name}
                    onChange={(e) => setNewForm({ ...newForm, name: e.target.value })}
                    style={{ maxWidth: 260 }}
                  />
                  <select
                    value={newForm.dataSourceId}
                    onChange={(e) => setNewForm({ ...newForm, dataSourceId: e.target.value })}
                    style={{ maxWidth: 280 }}
                  >
                    <option value="">（默认数据源）</option>
                    {dsList.map((d) => (
                      <option key={d.id} value={d.id}>{d.name} · {d.database_name}</option>
                    ))}
                  </select>
                </div>
                <div className="muted" style={{ marginBottom: 8 }}>
                  当前数据源：<b>{selDsName}</b> — 你要查的表必须在这个库里
                </div>
                <textarea
                  value={newForm.sqlText}
                  onChange={(e) => setNewForm({ ...newForm, sqlText: e.target.value })}
                  placeholder={'SELECT region, COUNT(*) AS cnt, SUM(amount) AS total\nFROM orders\nWHERE status = {{status}}\nGROUP BY region\nORDER BY total DESC'}
                  style={{ minHeight: 140 }}
                />
                {phNames.length > 0 && (
                  <div className="row" style={{ marginTop: 8 }}>
                    <span className="muted">参数：</span>
                    {phNames.map((n) => (
                      <input
                        key={n}
                        placeholder={n}
                        value={newParams[n] ?? ''}
                        onChange={(e) => setNewParams({ ...newParams, [n]: e.target.value })}
                        style={{ maxWidth: 170 }}
                      />
                    ))}
                  </div>
                )}
                <div className="row" style={{ marginTop: 10 }}>
                  <button onClick={previewNew} disabled={busy || !newForm.sqlText.trim()}>预览（≤200 行）</button>
                  <button className="ghost" onClick={saveNewReport} disabled={busy || !newForm.name.trim() || !newForm.sqlText.trim()}>
                    保存为报表
                  </button>
                  <span className="muted">只走只读网关：写操作、系统库、多语句、SLEEP 等会被直接拒绝</span>
                </div>
                {prevMsg && (
                  <div className={prevRows.length ? 'ok' : 'err'} style={{ marginTop: 8 }}>
                    {prevRows.length ? '✓ ' : '⚠ '}{prevMsg}
                  </div>
                )}
                {prevMsg && prevRows.length === 0 && (
                  <div className="muted" style={{ marginTop: 6, lineHeight: 1.7 }}>
                    0 行说明 SQL 跑通了，只是没有匹配的数据。常见原因：
                    <br />① 状态/类型字段存的是<b>编码</b>（如 <code>status=1</code>），不是「已完成」这类中文；
                    <br />② 时间范围没覆盖到数据；
                    <br />③ 选错了数据源——表可能在另一个库里（当前数据源：<b>{selDsName}</b>）。
                  </div>
                )}
                {prevCols.length > 0 && (
                  <div className="table-wrap" style={{ marginTop: 12 }}>
                    <table>
                      <thead><tr>{prevCols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                      <tbody>
                        {prevRows.map((r, i) => (
                          <tr key={i}>{prevCols.map((c) => <td key={c}>{String(r[c] ?? '')}</td>)}</tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="card">
                <strong>已有报表（{reports.length}）</strong>
                <div className="row" style={{ margin: '10px 0' }}>
                  {reports.map((r) => (
                    <button key={r.id} className="ghost" onClick={() => openReport(r.id)}>{r.name}</button>
                  ))}
                  {reports.length === 0 && <span className="muted">还没有报表。</span>}
                </div>
                {selReport && (
                  <div>
                    <div className="row">
                      <strong>{selReport.name}</strong>
                      {selReport.clientHidden && <span className="pill rec">甲方已不可见</span>}
                      <button className="ghost" style={{ padding: '2px 8px' }} onClick={() => setSelReport(null)}>关闭</button>
                    </div>
                    <textarea value={editSql} onChange={(e) => setEditSql(e.target.value)} style={{ minHeight: 120 }} />
                    <div className="row" style={{ marginTop: 8 }}>
                      <button onClick={saveSql}>保存 SQL（新增不可变版本）</button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {tab === 'apps' && boot.app.isPlatformRoot && (
            <div className="card">
              <strong>应用管理（平台根）</strong>
              <div className="row" style={{ margin: '10px 0' }}>
                {apps.map((a) => (
                  <div key={a.id} className="pill" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {a.name} · /{a.path_prefix}
                    {!a.is_platform_root && <button className="danger" style={{ padding: '2px 8px' }} onClick={() => disableApp(a.id)}>停用</button>}
                  </div>
                ))}
              </div>
              <div className="row">
                <input placeholder="应用名" value={appForm.name} onChange={(e) => setAppForm({ ...appForm, name: e.target.value })} />
                <input placeholder="路径前缀" value={appForm.pathPrefix} onChange={(e) => setAppForm({ ...appForm, pathPrefix: e.target.value })} />
                <button onClick={createApp}>创建应用</button>
              </div>
            </div>
          )}

          {tab === 'req' && (
            <div className="card">
              <strong>需求收件箱（{reqs.length}）</strong>
              {reqs.map((q) => (
                <div key={q.id} className="card" style={{ margin: '8px 0' }}>
                  <div className="row"><span className="pill">{q.status}</span><span className="muted">{q.prompt || q.client_note || ''}</span></div>
                  {q.failed_sql && <div className="code">{q.failed_sql}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
