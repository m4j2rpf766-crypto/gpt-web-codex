import { useEffect, useState } from "react";
import type {
  DoctorReport,
  Language,
  LauncherSnapshot,
  LauncherState,
  LogRecord,
  OperationState,
  Surface,
} from "./types";

const api = window.codexWebLauncher;

const text = {
  en: {
    dashboard: "Overview", mcp: "MCP", activity: "Activity", settings: "Settings",
    title: "Pure MCP launcher", subtitle: "ChatGPT runs in your normal browser. This app only keeps the local Luna MCP tunnel healthy.",
    ready: "Runtime ready", setup: "Setup required", connector: "Connector", runtime: "Local runtime",
    noBrowser: "No embedded browser", noBrowserDetail: "No ChatGPT login, browser profile, debugging port, or conversation UI is created.",
    openChat: "Open ChatGPT", verify: "Run diagnostics", reconnect: "Reconnect saved tunnel",
    configure: "Configure tunnel", tunnelId: "Tunnel ID", runtimeKey: "Runtime key", replace: "Replace saved credentials",
    connect: "Connect MCP", logs: "Recent runtime events", openLogs: "Open log folder", clearError: "Dismiss",
    keepRunning: "Keep MCP running when this window closes", language: "Language", status: "Status",
    connectorHint: "Create or enable this connector in ChatGPT with Tunnel transport and Authentication None.",
    refresh: "Refresh", checking: "Working…",
  },
  "zh-CN": {
    dashboard: "概览", mcp: "MCP", activity: "活动", settings: "设置",
    title: "纯 MCP 启动器", subtitle: "ChatGPT 在你的正常浏览器中运行。本程序只负责保持本机 Luna MCP 隧道可用。",
    ready: "运行时已就绪", setup: "需要配置", connector: "连接器", runtime: "本地运行时",
    noBrowser: "没有内嵌浏览器", noBrowserDetail: "不会创建 ChatGPT 登录状态、浏览器配置、调试端口或会话界面。",
    openChat: "打开 ChatGPT", verify: "运行诊断", reconnect: "使用已保存隧道重新连接",
    configure: "配置隧道", tunnelId: "隧道 ID", runtimeKey: "运行时密钥", replace: "替换已保存的凭据",
    connect: "连接 MCP", logs: "最近运行事件", openLogs: "打开日志目录", clearError: "关闭",
    keepRunning: "关闭窗口后继续运行 MCP", language: "语言", status: "状态",
    connectorHint: "在 ChatGPT 中创建或启用此连接器，连接方式选择隧道，身份验证选择无。",
    refresh: "刷新", checking: "处理中…",
  },
} as const;

export function App() {
  const [snapshot, setSnapshot] = useState<LauncherSnapshot | null>(null);
  const [surface, setSurface] = useState<Surface>("dashboard");
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [operation, setOperation] = useState<OperationState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.snapshot().then((next) => {
      if (cancelled) return;
      setSnapshot(next);
      setLogs(next.logs);
      setOperation(next.operation);
    }).catch((cause) => setError(messageOf(cause)));
    const offState = api.onStateChanged((state) => setSnapshot((current) => current ? { ...current, state } : current));
    const offOperation = api.onOperation((next) => {
      setOperation(next);
      if (next.status === "failed") setError(next.message);
    });
    const offLog = api.onLog((record) => setLogs((current) => [...current.slice(-299), record]));
    const offUpdate = api.onUpdateState((update) => setSnapshot((current) => current ? { ...current, update } : current));
    return () => { cancelled = true; offState(); offOperation(); offLog(); offUpdate(); };
  }, []);

  if (!api) return <div className="pure-loading">Launcher IPC is unavailable.</div>;
  if (!snapshot) return <div className="pure-loading">Starting GPT Web Codex…</div>;
  const language = snapshot.state.language ?? "zh-CN";
  const copy = text[language];
  const busy = operation?.status === "running";
  const updateState = (state: LauncherState) => setSnapshot((current) => current ? { ...current, state } : current);

  return (
    <div className="pure-app">
      <header className="pure-titlebar">
        <div className="pure-brand-mark">G</div>
        <strong>GPT Web Codex</strong>
        <span className="pure-version">v{snapshot.version}</span>
        <div className="pure-window-actions">
          <button onClick={() => api.windowControl("minimize")}>—</button>
          <button onClick={() => api.windowControl("zoom")}>□</button>
          <button onClick={() => api.windowControl("close")}>×</button>
        </div>
      </header>
      <div className="pure-shell">
        <aside className="pure-sidebar">
          <div className="pure-sidebar-heading">MCP CONTROL</div>
          {(["dashboard", "mcp", "activity", "settings"] as Surface[]).map((item) => (
            <button className={surface === item ? "active" : ""} key={item} onClick={() => setSurface(item)}>
              <span>{item === "dashboard" ? "◉" : item === "mcp" ? "⌘" : item === "activity" ? "≋" : "⚙"}</span>
              {copy[item]}
            </button>
          ))}
          <div className="pure-sidebar-foot">
            <span className={snapshot.mcpCredentialsConfigured ? "dot ready" : "dot"} />
            {snapshot.mcpCredentialsConfigured ? copy.ready : copy.setup}
          </div>
        </aside>
        <main className="pure-main">
          {surface === "dashboard" ? <Dashboard copy={copy} snapshot={snapshot} busy={busy} setError={setError} updateState={updateState} /> : null}
          {surface === "mcp" ? <McpPanel copy={copy} snapshot={snapshot} busy={busy} setError={setError} updateState={updateState} /> : null}
          {surface === "activity" ? <Activity copy={copy} logs={logs} /> : null}
          {surface === "settings" ? <Settings copy={copy} language={language} snapshot={snapshot} setError={setError} updateState={updateState} /> : null}
        </main>
      </div>
      {operation ? <div className={`pure-operation ${operation.status}`}><span />{operation.message}</div> : null}
      {error ? <div className="pure-error"><span>{error}</span><button onClick={() => setError(null)}>{copy.clearError}</button></div> : null}
    </div>
  );
}

function Dashboard({ copy, snapshot, busy, setError, updateState }: PanelProps) {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const runDoctor = async () => {
    setError(null);
    try { const next = await api!.verifyMcp(); setReport(next); }
    catch (cause) { setError(messageOf(cause)); }
  };
  return (
    <section>
      <PageHeader title={copy.title} subtitle={copy.subtitle} />
      <div className="pure-status-grid">
        <StatusCard title={copy.runtime} value={snapshot.mcpCredentialsConfigured ? copy.ready : copy.setup} tone={snapshot.mcpCredentialsConfigured ? "ready" : "warn"} />
        <StatusCard title={copy.connector} value={snapshot.connectorName} tone="neutral" />
        <StatusCard title={copy.noBrowser} value="Chrome / Edge / Firefox" tone="ready" />
      </div>
      <div className="pure-card pure-callout">
        <div><h3>{copy.noBrowser}</h3><p>{copy.noBrowserDetail}</p></div>
        <div className="pure-actions">
          <button className="primary" onClick={() => void api!.openExternal(snapshot.urls.connectors)}>{copy.openChat}</button>
          <button disabled={busy} onClick={() => void runDoctor()}>{busy ? copy.checking : copy.verify}</button>
        </div>
      </div>
      {report ? <DoctorResults report={report} /> : null}
    </section>
  );
}

function McpPanel({ copy, snapshot, busy, setError, updateState }: PanelProps) {
  const [tunnelId, setTunnelId] = useState("");
  const [runtimeKey, setRuntimeKey] = useState("");
  const [replace, setReplace] = useState(false);
  const canReuse = snapshot.mcpCredentialsConfigured && !replace;
  const submit = async () => {
    setError(null);
    try {
      const input = canReuse ? {} : { tunnelId: tunnelId.trim(), runtimeKey, replace: true };
      await api!.setupMcp(input);
      const report = await api!.verifyMcp();
      updateState({ ...snapshot.state, coreSetupComplete: true, mcpRuntimeInstalled: true, mcpSetupComplete: report.ok });
      setRuntimeKey("");
    } catch (cause) { setError(messageOf(cause)); }
  };
  return (
    <section>
      <PageHeader title={copy.configure} subtitle={copy.connectorHint} />
      <div className="pure-card pure-form">
        <label>{copy.connector}<input value={snapshot.connectorName} readOnly /></label>
        {!canReuse ? <>
          <label>{copy.tunnelId}<input placeholder="tunnel_…" value={tunnelId} onChange={(event) => setTunnelId(event.target.value)} /></label>
          <label>{copy.runtimeKey}<input autoComplete="off" type="password" value={runtimeKey} onChange={(event) => setRuntimeKey(event.target.value)} /></label>
        </> : null}
        {snapshot.mcpCredentialsConfigured ? <label className="pure-check"><input checked={replace} type="checkbox" onChange={(event) => setReplace(event.target.checked)} />{copy.replace}</label> : null}
        <div className="pure-actions">
          <button onClick={() => void api!.openExternal(snapshot.urls.tunnels)}>OpenAI Tunnels</button>
          <button onClick={() => void api!.openExternal(snapshot.urls.keys)}>Runtime Keys</button>
          <button className="primary" disabled={busy || (!canReuse && (!tunnelId.trim() || runtimeKey.length < 20))} onClick={() => void submit()}>
            {busy ? copy.checking : canReuse ? copy.reconnect : copy.connect}
          </button>
        </div>
      </div>
    </section>
  );
}

function Activity({ copy, logs }: { copy: typeof text.en | typeof text["zh-CN"]; logs: LogRecord[] }) {
  return <section><PageHeader title={copy.logs} subtitle="MCP / Tunnel / Luna" /><div className="pure-log-list">{logs.length ? [...logs].reverse().map((log, index) => <div className={`pure-log ${log.level}`} key={`${log.at}-${index}`}><time>{new Date(log.at).toLocaleTimeString()}</time><strong>{log.event}</strong><code>{detail(log.detail)}</code></div>) : <div className="pure-empty">No runtime events.</div>}</div></section>;
}

function Settings({ copy, language, snapshot, setError, updateState }: { copy: typeof text.en | typeof text["zh-CN"]; language: Language; snapshot: LauncherSnapshot; setError: (value: string | null) => void; updateState: (state: LauncherState) => void }) {
  const changeLanguage = async (next: Language) => { try { updateState(await api!.setLanguage(next)); } catch (cause) { setError(messageOf(cause)); } };
  const setKeepRunning = async (value: boolean) => { try { updateState(await api!.setPreference("keepRunningOnClose", value)); } catch (cause) { setError(messageOf(cause)); } };
  return <section><PageHeader title={copy.settings} subtitle="GPT Web Codex" /><div className="pure-card pure-settings"><label>{copy.language}<select value={language} onChange={(event) => void changeLanguage(event.target.value as Language)}><option value="zh-CN">简体中文</option><option value="en">English</option></select></label><label className="pure-check"><input checked={snapshot.state.keepRunningOnClose} type="checkbox" onChange={(event) => void setKeepRunning(event.target.checked)} />{copy.keepRunning}</label><button onClick={() => void api!.openLogs()}>{copy.openLogs}</button></div></section>;
}

type Copy = typeof text.en | typeof text["zh-CN"];
interface PanelProps { copy: Copy; snapshot: LauncherSnapshot; busy: boolean; setError: (value: string | null) => void; updateState: (state: LauncherState) => void; }
function PageHeader({ title, subtitle }: { title: string; subtitle: string }) { return <header className="pure-page-header"><h1>{title}</h1><p>{subtitle}</p></header>; }
function StatusCard({ title, value, tone }: { title: string; value: string; tone: string }) { return <div className={`pure-card pure-status ${tone}`}><span>{title}</span><strong>{value}</strong></div>; }
function DoctorResults({ report }: { report: DoctorReport }) { return <div className="pure-card pure-doctor">{report.checks.map((check) => <div key={check.id}><span className={`dot ${check.status === "ok" ? "ready" : check.status}`} /><div><strong>{check.message}</strong>{check.detail ? <small>{check.detail}</small> : null}</div></div>)}</div>; }
function messageOf(value: unknown) { return value instanceof Error ? value.message : String(value); }
function detail(value: Record<string, unknown>) { const raw = JSON.stringify(value); return raw === "{}" ? "" : raw; }
