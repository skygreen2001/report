'use client';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { LLM_PRESETS, presetOf, vendorLabel, initialProviderForm } from '@/lib/llm-presets';
import SchemaDoc from '@/components/SchemaDoc';

interface Boot { app: any; role: string; settings: any; reports: any[]; tagTree: any[]; dataSources: any[]; llmProviders?: any[]; }

export default function DevPage() {
  const { appPath } = useParams<{ appPath: string }>();
  const api = `/${appPath}/d/api`;
  const [boot, setBoot] = useState<Boot | null>(null);
  const [tab, setTab] = useState<'ds' | 'reports' | 'bin' | 'apps' | 'req' | 'llm' | 'doc'>('ds');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  // 数据源表单
  const [dsForm, setDsForm] = useState({ name: '', host: '127.0.0.1', port: 3306, database_name: 'biz_demo', username: 'report_ro', password: 'ReportRo@2026' });
  const [dsList, setDsList] = useState<any[]>([]);
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  // 删除被占用源时的「改派并删除」交互
  const [reassign, setReassign] = useState<{ id: string; name: string } | null>(null);
  const [reassignTarget, setReassignTarget] = useState('');

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

  // 数据库结构文档（当前查看的数据源；不传则用应用默认）
  const [docDs, setDocDs] = useState<string>('');

  // 应用管理
  const [apps, setApps] = useState<any[]>([]);
  const [appForm, setAppForm] = useState({ name: '', pathPrefix: '' });

  // 模型配置（国内厂商 + 本地模型）
  const [providers, setProviders] = useState<any[]>([]);
  const [llmForm, setLlmForm] = useState(() => initialProviderForm(true));
  const [llmTest, setLlmTest] = useState<Record<string, string>>({});

  // 需求
  const [reqs, setReqs] = useState<any[]>([]);
  // 据此需求生成 SQL（开发者用自己配置的模型）：内联生成器状态
  const [genReq, setGenReq] = useState<any>(null);
  const [reqPrompt, setReqPrompt] = useState('');
  const [reqDsId, setReqDsId] = useState('');
  const [reqProviderId, setReqProviderId] = useState('');
  const [reqSql, setReqSql] = useState('');
  const [reqUnderstanding, setReqUnderstanding] = useState('');
  // 多库都有同名/相似表时的候选库（生成后由开发者选择用哪个库）
  const [reqCandidates, setReqCandidates] = useState<any[]>([]);
  const [reqCols, setReqCols] = useState<string[]>([]);
  const [reqRows, setReqRows] = useState<any[]>([]);
  const [reqPrevMsg, setReqPrevMsg] = useState('');
  const [reqReportName, setReqReportName] = useState('');
  const [reqBusy, setReqBusy] = useState(false);
  // 生成中的独立加载态（切菜单不丢失）+ 取消能力
  const [reqGenLoading, setReqGenLoading] = useState(false);
  const [reqCancelled, setReqCancelled] = useState(false);
  const [reqStopped, setReqStopped] = useState(false);
  const [reqStage, setReqStage] = useState('');
  const reqAbortRef = useRef<AbortController | null>(null);
  const reqTaskRef = useRef<string>('');
  const reqStageTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startReqStages = () => {
    const stages = ['正在读取各数据库表结构…', '正在生成 SQL…', '正在校验表名与字段…'];
    let i = 0;
    setReqStage(stages[0]);
    reqStageTimer.current = setInterval(() => { i = (i + 1) % stages.length; setReqStage(stages[i]); }, 1400);
  };
  const stopReqStages = () => {
    if (reqStageTimer.current) { clearInterval(reqStageTimer.current); reqStageTimer.current = null; }
  };

  async function load() {
    setErr('');
    const r = await fetch(`${api}/bootstrap`, { cache: 'no-store' });
    const d = await r.json();
    if (!r.ok) { setErr(d.message || '加载失败'); return; }
    setBoot(d);
    setDsList(d.dataSources || []);
    setReports(d.reports || []);
    setProviders(d.llmProviders || []);
    // 新建报表的数据源默认取应用默认数据源
    setNewForm((f) => (f.dataSourceId ? f : { ...f, dataSourceId: d.settings?.defaultDs ?? '' }));
    if (d.app.isPlatformRoot) {
      const ar = await fetch(`${api}/applications`, { cache: 'no-store' });
      setApps((await ar.json()).applications || []);
    }
  }
  useEffect(() => { load(); }, [api]);
  // 支持 /{app}/d?tab=doc 直达结构文档
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t === 'doc' || t === 'reports' || t === 'llm' || t === 'ds') setTab(t);
  }, []);

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
  async function delDs(d: any) {
    if (!confirm(`确认删除数据源「${d.name}」？\n${boot?.settings?.defaultDs === d.id ? '（它是当前默认数据源，删除后将自动回落到其他数据源）' : ''}`)) return;
    setErr(''); setMsg('');
    try {
      const r = await fetch(`${api}/data-sources/${d.id}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        // 被引用：转入「改派并删除」流程，让用户选一个同源目标源
        if (j.code === 'DATA_SOURCE_IN_USE') {
          setReassign({ id: d.id, name: d.name });
          setReassignTarget('');
          return;
        }
        setErr(j.message || '删除失败'); return;
      }
      setMsg(j.defaultDsChanged ? '已删除，默认数据源已自动回落' : '已删除数据源');
      if (docDs === d.id) setDocDs('');
      await load();
    } catch (e: any) { setErr('删除失败：' + e.message); }
  }
  // 改派关联记录到另一同源源后删除（合并重复数据源）
  async function delDsWithTarget() {
    if (!reassign) return;
    if (!reassignTarget) { setErr('请选择改派目标数据源'); return; }
    setErr(''); setMsg('');
    try {
      const r = await fetch(`${api}/data-sources/${reassign.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetDsId: reassignTarget }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.message || '删除失败'); return; }
      const tName = dsList.find((x) => x.id === reassignTarget)?.name ?? '';
      setMsg(j.reassignedCount
        ? `已把 ${j.reassignedCount} 条关联记录改派到「${tName}」并删除「${reassign.name}」`
        : `已删除数据源「${reassign.name}」`);
      setReassign(null); setReassignTarget('');
      if (docDs === reassign.id) setDocDs('');
      await load();
    } catch (e: any) { setErr('删除失败：' + e.message); }
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
  // 开发者回收站：删除=移入开发者回收站（developer_state=RECYCLED），甲方侧不受影响
  async function delReport(id: string) {
    if (!confirm('确认移入开发者回收站？开发者与甲方各有各的回收站，本操作只影响开发者侧，甲方仍可见。')) return;
    setErr(''); setMsg('');
    const r = await fetch(`${api}/reports/${id}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await r.json();
    if (!r.ok) { setErr(d.message || '删除失败'); return; }
    if (selReport?.id === id) { setSelReport(null); setEditSql(''); }
    setMsg('已移入开发者回收站（甲方侧不受影响）');
    await load();
  }
  async function restoreRep(id: string) {
    setErr(''); setMsg('');
    const r = await fetch(`${api}/reports/${id}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await r.json();
    if (!r.ok) { setErr(d.message || '还原失败'); return; }
    setMsg('已还原到开发者报表列表');
    await load();
  }
  // SQL 里的 {{name}} 占位符（网关会校验只允许出现在值位置）
  const phNames = Array.from(
    new Set(Array.from(newForm.sqlText.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)).map((m) => m[1])),
  );

  // 当前生效的数据源（下拉没选就用应用默认）
  const effDsId = newForm.dataSourceId || boot?.settings?.defaultDs || '';
  const selDs = dsList.find((d) => d.id === effDsId);
  const selDsName = selDs ? `${selDs.name} · ${selDs.database_name}` : '（该应用还没有数据源）';

  // 开发者回收站：以 developer_state 判断（与 deleteReport/restoreReport 的 developer track 对应）
  const inDevBin = (r: any) => r.developer_state === 'RECYCLED';
  const normalReports = reports.filter((r) => !inDevBin(r));
  const binReports = reports.filter(inDevBin);

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
  async function setAppStatus(a: any, next: 'DISABLED' | 'ACTIVE') {
    const word = next === 'DISABLED' ? '停用' : '启用';
    if (!confirm(`确认${word}应用「${a.name}」？（/${a.path_prefix}）`)) return;
    setErr(''); setMsg('');
    try {
      const r = await fetch(`${api}/applications/${a.id}/${next === 'DISABLED' ? 'disable' : 'enable'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d.message || `${word}失败（HTTP ${r.status}）`); return; }
      setMsg(`应用「${a.name}」已${word}`);
      load();
    } catch (e: any) { setErr(`${word}失败：` + e.message); }
  }
  async function loadReqs() {
    const r = await fetch(`${api}/requirements`, { cache: 'no-store' });
    setReqs((await r.json()).requirements || []);
  }
  useEffect(() => { if (tab === 'req') loadReqs(); }, [tab]);

  // 点击需求卡片的「据此生成 SQL」：用该需求的描述预填内联生成器
  function startGenFromReq(q: any) {
    setErr(''); setMsg('');
    setGenReq(q);
    setReqPrompt(q.prompt || q.client_note || '');
    setReqDsId(boot?.settings?.defaultDs ?? (dsList[0]?.id ?? ''));
    setReqProviderId(''); // 空=开发者默认模型
    setReqSql(''); setReqUnderstanding(''); setReqCols([]); setReqRows([]); setReqPrevMsg('');
    setReqReportName((q.prompt || '需求报表').slice(0, 24));
  }

  async function genFromReq() {
    setErr(''); setReqGenLoading(true); setReqCancelled(false); setReqStopped(false);
    setReqCandidates([]); setReqSql(''); setReqUnderstanding(''); setReqCols([]); setReqRows([]); setReqPrevMsg('');
    startReqStages();
    const ctrl = new AbortController();
    reqAbortRef.current = ctrl;
    // 任务 id：后端据此定位并中断本次模型调用（「停止生成」用）
    const taskId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    reqTaskRef.current = taskId;
    try {
      const r = await fetch(`${api}/reports/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: reqPrompt,
          // 跨本应用所有已连接的库生成；后端会标明每个表属于哪个库
          dataSourceIds: dsList.map((d) => d.id),
          providerId: reqProviderId || undefined,
          taskId,
        }),
        signal: ctrl.signal,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || '生成失败');
      setReqCancelled(false); setReqStopped(false);
      setReqSql(d.sql ?? '');
      setReqUnderstanding(d.understanding ?? (d.reason ? '降级手工模式：' + d.reason : ''));
      // 每个库各生成一条 SQL → 给候选让开发者选用哪个库的；单库则直接定下数据源
      setReqCandidates(d.results ?? []);
      setReqDsId(d.results?.[0]?.dataSourceId ?? d.dataSourceId ?? '');
      setReqCols([]); setReqRows([]); setReqPrevMsg('');
      if (d.mode === 'manual') setErr('生成失败：' + (d.reason || '请检查开发者模型配置，或直接在下方手写 SQL'));
    } catch (e: any) {
      if (e.name === 'AbortError') { setReqCancelled(true); return; }
      setErr(e.message);
    } finally {
      stopReqStages();
      setReqGenLoading(false);
      reqAbortRef.current = null;
    }
  }

  // 取消正在进行的生成（AbortController 中断 fetch，前端立即停止等待）
  function cancelReqGen() {
    if (reqStageTimer.current) stopReqStages();
    reqAbortRef.current?.abort();
    setReqCancelled(true);
    setReqGenLoading(false);
    reqAbortRef.current = null;
  }

  // 停止生成：调后端取消端点真正中断模型调用（省算力），同时停止本页等待
  async function stopReqGen() {
    const taskId = reqTaskRef.current;
    stopReqStages();
    try {
      if (taskId) {
        await fetch(`${api}/reports/generate/cancel`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId }),
        });
      }
    } catch { /* 取消请求失败不影响前端停止 */ }
    reqAbortRef.current?.abort();
    reqAbortRef.current = null;
    reqTaskRef.current = '';
    setReqStopped(true);
    setReqGenLoading(false);
  }

  async function previewReq() {
    setErr(''); setReqBusy(true); setReqPrevMsg('');
    try {
      const r = await fetch(`${api}/reports/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: reqSql, dataSourceId: reqDsId || undefined, params: {} }),
      });
      const d = await r.json();
      if (!r.ok) { setErr(`查询失败：${d.code}${d.message && d.message !== d.code ? ' — ' + d.message : ''}`); setReqCols([]); setReqRows([]); return; }
      setReqCols(d.columns || []); setReqRows(d.rows || []);
      setReqPrevMsg(d.rows.length ? `预览成功 · ${d.rows.length} 行（上限 200）` : '查询成功，但返回 0 行');
    } catch (e: any) { setErr(e.message); } finally { setReqBusy(false); }
  }

  async function saveReqReport() {
    if (!reqSql?.trim()) { setErr('还没有 SQL，无法保存'); return; }
    setErr(''); setReqBusy(true);
    try {
      // 1) 保存为报表（开发者/甲方共享，甲方端立即可见）
      const r = await fetch(`${api}/reports`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: reqReportName || '需求报表', sqlText: reqSql, dataSourceId: reqDsId || undefined }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || '保存失败');
      const reportId = d.id;
      // 2) 标记需求完成并回填报表 id，通知甲方
      await fetch(`${api}/requirements/${genReq.id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reportId }),
      });
      setMsg(`报表「${reqReportName || '需求报表'}」已保存并通知甲方，需求已标记完成`);
      setGenReq(null); setReqSql(''); setReqCols([]); setReqRows([]); setReqPrevMsg('');
      await loadReqs();
    } catch (e: any) { setErr(e.message); } finally { setReqBusy(false); }
  }

  // —— 模型配置 ——
  function applyPreset(vendor: string) {
    const p = LLM_PRESETS.find((x) => x.vendor === vendor);
    setLlmForm((f) => ({
      ...f,
      vendor,
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
      setLlmForm(initialProviderForm(false));
      await load();
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
    setMsg('已设为默认模型'); await load();
  }

  async function toggleProvider(p: any) {
    setErr(''); setMsg('');
    const next = p.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    const r = await fetch(`${api}/llm-providers/${p.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setErr(d.message || '操作失败'); return; }
    setMsg(next === 'ACTIVE' ? '已启用' : '已停用'); await load();
  }

  async function delProvider(p: any) {
    if (!confirm(`确认删除模型「${p.name}」？`)) return;
    setErr(''); setMsg('');
    const r = await fetch(`${api}/llm-providers/${p.id}`, { method: 'DELETE' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setErr(d.message || '删除失败'); return; }
    setMsg('已删除'); await load();
  }

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
          <div className={'node' + (tab === 'ds' ? ' on' : '')} onClick={() => setTab('ds')}>数据源</div>
          <div className={'node' + (tab === 'doc' ? ' on' : '')} onClick={() => setTab('doc')}>数据库结构文档</div>
          <div className={'node' + (tab === 'req' ? ' on' : '')} onClick={() => setTab('req')}>需求收件箱</div>
          <div className={'node' + (tab === 'reports' ? ' on' : '')} onClick={() => setTab('reports')}>报表（{normalReports.length}）</div>
          <div className={'node' + (tab === 'llm' ? ' on' : '')} onClick={() => setTab('llm')}>模型配置</div>
          {boot.app.isPlatformRoot && <div className={'node' + (tab === 'apps' ? ' on' : '')} onClick={() => setTab('apps')}>应用管理</div>}
          <div className={'node' + (tab === 'bin' ? ' on' : '')} onClick={() => setTab('bin')}>回收站（{binReports.length}）</div>
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
                    <button className="ghost" style={{ padding: '2px 8px' }} onClick={() => { setDocDs(d.id); setTab('doc'); }}>结构文档</button>
                    <button className="danger" style={{ padding: '2px 8px' }} onClick={() => delDs(d)}>删除</button>
                    <span className="muted">{testResult[d.id] || ''}</span>
                  </div>
                ))}
                {dsList.length === 0 && <span className="muted">还没有数据源，请先在下方新建。</span>}
              </div>

              {reassign && (
                <div className="card err" style={{ marginTop: 12 }}>
                  <strong>数据源「{reassign.name}」被报表 / 运行记录引用，无法直接删除。</strong>
                  <div className="row" style={{ marginTop: 10 }}>
                    <span className="muted">把它关联的记录改派到：</span>
                    <select value={reassignTarget} onChange={(e) => setReassignTarget(e.target.value)} style={{ maxWidth: 320 }}>
                      <option value="">（请选择目标数据源）</option>
                      {dsList.filter((x) => x.id !== reassign.id).map((x) => (
                        <option key={x.id} value={x.id}>{x.name} · {x.database_name}</option>
                      ))}
                    </select>
                    <button className="danger" onClick={delDsWithTarget} disabled={!reassignTarget}>改派并删除</button>
                    <button className="ghost" onClick={() => { setReassign(null); setReassignTarget(''); }}>取消</button>
                  </div>
                  <div className="muted" style={{ marginTop: 6 }}>改派后该数据源会被彻底删除；目标源须为本应用内其他可用数据源。</div>
                </div>
              )}
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

          {tab === 'doc' && (
            <SchemaDoc
              key={docDs || 'default'}
              api={api}
              dataSources={dsList}
              defaultId={docDs || boot?.settings?.defaultDs || undefined}
            />
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
                <strong>已有报表（{normalReports.length}）</strong>
                <div style={{ marginTop: 8 }}>
                  {normalReports.length === 0
                    ? <span className="muted">还没有报表。</span>
                    : normalReports.map((r) => (
                      <div className="row" key={r.id} style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                        <button className="ghost" style={{ border: 'none', background: 'transparent', padding: 0 }} onClick={() => openReport(r.id)}>{r.name}</button>
                        <button className="danger" style={{ padding: '2px 8px' }} onClick={() => delReport(r.id)}>删除</button>
                      </div>
                    ))}
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

          {tab === 'bin' && (
            <div className="card">
              <div className="row"><strong>回收站（{binReports.length}）</strong><span className="pill rec">开发者自己的回收站 · 与甲方互不干扰</span></div>
              {binReports.length === 0
                ? <div className="muted" style={{ marginTop: 8 }}>回收站是空的。</div>
                : <div style={{ marginTop: 8 }}>
                    {binReports.map((r) => (
                      <div className="row" key={r.id} style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                        <span style={{ cursor: 'pointer' }} onClick={() => openReport(r.id)}>{r.name}</span>
                        <button className="ghost" style={{ padding: '2px 8px' }} onClick={() => restoreRep(r.id)}>还原</button>
                      </div>
                    ))}
                  </div>}
            </div>
          )}

          {tab === 'llm' && (
            <div className="card">
              <div className="row">
                <strong>模型配置</strong>
                <span className="muted">国内主流厂商 + 本地模型，统一 OpenAI 兼容协议；密钥 AES 加密入库，接口永不回显</span>
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
                        {vendorLabel(p.vendor)} · {p.model} · {p.endpoint} · {p.has_key ? '已配置密钥' : '无密钥（本地）'}
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
                <input placeholder="模型名" list="llm-models" value={llmForm.model} onChange={(e) => setLlmForm({ ...llmForm, model: e.target.value })} />
                <datalist id="llm-models">
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

          {tab === 'apps' && boot.app.isPlatformRoot && (
            <div className="card">
              <strong>应用管理（平台根）</strong>
              <div className="row" style={{ margin: '10px 0' }}>
                {apps.map((a) => (
                  <div key={a.id} className="pill" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {a.name} · /{a.path_prefix}
                    {a.is_platform_root && <span className="badge">平台根</span>}
                    {a.status === 'DISABLED'
                      ? <><span className="pill rec">已停用</span><button className="ghost" style={{ padding: '2px 8px' }} onClick={() => setAppStatus(a, 'ACTIVE')}>启用</button></>
                      : (!a.is_platform_root && <button className="danger" style={{ padding: '2px 8px' }} onClick={() => setAppStatus(a, 'DISABLED')}>停用</button>)}
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
              {reqs.length === 0 && <div className="muted">暂无需求。甲方在未配置模型时点「生成 SQL」，需求会自动出现在这里。</div>}
              {reqs.map((q) => (
                <div key={q.id} className="card" style={{ margin: '8px 0' }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <div className="row"><span className="pill">{q.status}</span><span className="muted">{q.prompt || q.client_note || ''}</span></div>
                    <button className="ghost" style={{ padding: '2px 8px' }} onClick={() => startGenFromReq(q)} disabled={!!genReq}>据此生成 SQL</button>
                  </div>
                  {q.failed_sql && <div className="code">{q.failed_sql}</div>}
                </div>
              ))}

              {genReq && (
                <div className="card" style={{ margin: '12px 0', border: '1px solid var(--border)' }}>
                  <div className="row"><strong>据此需求生成 SQL</strong><span className="muted">{genReq.prompt?.slice(0, 30)}</span></div>
                  {providers.length === 0 && (
                    <div className="muted" style={{ marginTop: 6 }}>你还没有配置开发者模型（请到「模型配置」添加），将无法自动生成，可改为在下方直接写 SQL。</div>
                  )}
                  <textarea value={reqPrompt} onChange={(e) => setReqPrompt(e.target.value)} placeholder="需求描述（可补充）" style={{ marginTop: 8 }} />
                  <div className="row" style={{ marginTop: 8 }}>
                    <select value={reqDsId} onChange={(e) => setReqDsId(e.target.value)} style={{ maxWidth: 240 }}>
                      {dsList.length === 0 && <option value="">（无数据源）</option>}
                      {dsList.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.database_name}</option>)}
                    </select>
                    <select value={reqProviderId} onChange={(e) => setReqProviderId(e.target.value)} style={{ maxWidth: 240 }}>
                      <option value="">默认模型</option>
                      {providers.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}
                    </select>
                    <button onClick={genFromReq} disabled={reqGenLoading}>生成 SQL</button>
                  </div>

                  {reqGenLoading && (
                    <div className="card gen-loading" style={{ marginTop: 10 }}>
                      <div className="gen-status">
                        <span className="gen-spinner" />
                        <strong>正在生成 SQL</strong>
                      </div>
                      <div className="gen-progress" />
                      <div className="gen-stage">{reqStage}</div>
                      <div className="row">
                        <button className="danger" onClick={stopReqGen}>停止生成</button>
                        <button className="ghost" onClick={cancelReqGen}>仅取消等待</button>
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        「停止生成」会中断后端模型调用（不再消耗算力）；「仅取消等待」只停止本页等待，模型仍会在服务端跑完。
                        生成期间可切到左侧其他菜单，回来后若已完成会直接显示结果。
                      </div>
                    </div>
                  )}

                  {reqStopped && !reqGenLoading && (
                    <div className="card row" style={{ marginTop: 10, justifyContent: 'space-between' }}>
                      <span className="muted">已停止生成，模型调用已中断（不再消耗算力）。可重新生成。</span>
                      <button onClick={genFromReq}>重新生成</button>
                    </div>
                  )}

                  {reqCancelled && !reqGenLoading && !reqStopped && (
                    <div className="card row" style={{ marginTop: 10, justifyContent: 'space-between' }}>
                      <span className="muted">已停止本页等待（模型仍在服务端跑完）。可重新生成，或直接在下方手动编写 SQL。</span>
                      <button onClick={genFromReq}>重新生成</button>
                    </div>
                  )}

                  {!reqGenLoading && !reqCancelled && !reqStopped && reqCandidates.length > 1 && (
                    <div className="card" style={{ marginTop: 10 }}>
                      <div className="row"><strong>多个数据库都能满足这个需求</strong><span className="pill">请选择用哪个库的 SQL</span></div>
                      <div className="row" style={{ marginTop: 8 }}>
                        {reqCandidates.map((c) => (
                          <button key={c.dataSourceId} className={reqDsId === c.dataSourceId ? '' : 'ghost'} onClick={() => { setReqDsId(c.dataSourceId); setReqSql(c.sql); }}>
                            {c.name} · {c.databaseName} <span className="muted">（{c.tables.join(', ')}）</span>
                          </button>
                        ))}
                      </div>
                      <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                        不同库的表名/字段不同，生成的 SQL 也不同。选好后点「预览」确认数据，再保存。
                      </div>
                    </div>
                  )}

                  {!reqGenLoading && !reqCancelled && !reqStopped && reqSql && (
                    <div className="card" style={{ marginTop: 10 }}>
                      <div className="row"><strong>② 生成的 SQL</strong>{reqUnderstanding && <span className="muted">{reqUnderstanding}</span>}</div>
                      <div className="code">{reqSql}</div>
                      <div className="row" style={{ marginTop: 8 }}>
                        <button className="ghost" onClick={previewReq} disabled={reqBusy}>预览（≤200 行）</button>
                      </div>
                    </div>
                  )}

                  {reqCols.length > 0 && (
                    <div className="card" style={{ marginTop: 10 }}>
                      <strong>③ 预览结果（{reqRows.length} 行）</strong>
                      <div className="table-wrap" style={{ marginTop: 8 }}>
                        <table><thead><tr>{reqCols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                          <tbody>{reqRows.map((r, i) => <tr key={i}>{reqCols.map((c) => <td key={c}>{String(r[c] ?? '')}</td>)}</tr>)}</tbody>
                        </table>
                      </div>
                      <div className="row" style={{ marginTop: 8 }}>
                        <input style={{ maxWidth: 240 }} placeholder="报表名称" value={reqReportName} onChange={(e) => setReqReportName(e.target.value)} />
                        <button className="ghost" onClick={saveReqReport} disabled={reqBusy}>保存为报表并通知甲方</button>
                        <button className="danger" style={{ padding: '2px 8px' }} onClick={() => { setGenReq(null); setReqSql(''); setReqCols([]); setReqRows([]); }}>取消</button>
                      </div>
                    </div>
                  )}
                  {reqPrevMsg && <div className="muted" style={{ marginTop: 6 }}>{reqPrevMsg}</div>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
