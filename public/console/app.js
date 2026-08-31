import { can, canRead, canView, getRoleProfile } from "./role-model.js";

const sessionKey = "hyperrecon-console-session";
const state = {
  session: readSession(),
  pendingCredentials: null,
  workspace: null,
  sources: [], imports: [], runs: [], exceptions: [], periods: [], audit: [], operators: [], moneyFlow: { stages: [], cases: [] },
  selectedPeriodId: null,
  selectedCaseId: null,
  selectedExceptionId: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const labels = {
  overview: ["跨境资金控制", "资金驾驶舱"], sources: ["数据治理", "数据接入"], runs: ["确定性引擎", "对账运行"],
  exceptions: ["人工工作流", "异常队列"], periods: ["财务控制", "月结中心"], audit: ["可追溯性", "审计记录"],
};
const sourceLabels = { shopify: "Shopify", stripe: "Stripe", paypal: "PayPal", wise: "Wise", bank: "银行" };
const roleLabels = { admin: "管理员", reviewer: "复核人", operator: "操作员", auditor: "审计只读" };
let demoAccounts = [];
const actionLabels = {
  "tenant.bootstrapped": "工作区初始化", "session.created": "用户登录", "import_batch.committed": "导入批次提交",
  "recon_run.completed": "对账运行完成", "recon_run.failed": "对账运行失败", "close_period.created": "月结期间创建",
  "close_period.locked": "月结期间锁定", "close_period.reopened": "月结重新开账", "demo.seeded": "虚构样本初始化",
  "exception.claimed": "异常已领取", "exception.released": "异常已退回共享队列", "exception.note_added": "调查备注已添加",
  "exception.resolution_submitted": "处理方案已提交", "exception.resolution_approved": "处理方案已批准", "exception.resolution_rejected": "处理方案已驳回",
  "ai.exception_suggestion_generated": "AI 调查建议已生成",
  "exception.ai_adoption_recorded": "AI 建议使用结果已记录",
  "exception.investigation_item_added": "调查清单项目已添加",
  "exception.investigation_item_updated": "调查清单项目已更新",
};

function readSession() {
  try {
    const value = JSON.parse(sessionStorage.getItem(sessionKey));
    return value?.token && value?.tenantId ? value : null;
  } catch { return null; }
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.session?.token) headers.set("authorization", `Bearer ${state.session.token}`);
  if (options.body && !(options.body instanceof FormData) && typeof options.body !== "string") {
    headers.set("content-type", "application/json");
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, { ...options, headers });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && state.session) signOut(false);
    const error = new Error(body?.error?.code || `HTTP_${response.status}`);
    error.code = body?.error?.code;
    error.metadata = body?.error?.metadata || {};
    error.status = response.status;
    throw error;
  }
  return body;
}

async function login(credentials, tenantId) {
  const body = await api("/v1/sessions", { method: "POST", body: { ...credentials, ...(tenantId ? { tenantId } : {}) } });
  state.session = body;
  sessionStorage.setItem(sessionKey, JSON.stringify(body));
  state.pendingCredentials = null;
  $("#workspaceDialog").close();
  showApp();
  await loadAll();
}

async function loadAll() {
  if (!state.session) return;
  setBusy(true);
  const base = `/v1/tenants/${encodeURIComponent(state.session.tenantId)}`;
  const profile = getRoleProfile(state.session.role);
  try {
    const [workspace, sources, imports, runs, exceptions, periods, audit, operators, moneyFlow] = await Promise.all([
      api(`${base}/workspace`), api(`${base}/sources`), api(`${base}/import-batches`), api(`${base}/recon-runs`),
      api(`${base}/exceptions?status=active`),
      canRead(profile, "periods") ? api(`${base}/periods`) : Promise.resolve({ data: [] }),
      canRead(profile, "audit") ? api(`${base}/audit-events`) : Promise.resolve({ data: [] }),
      canRead(profile, "operators") ? api(`${base}/operators`) : Promise.resolve({ data: [] }),
      api(`${base}/money-flow`),
    ]);
    state.workspace = workspace;
    state.sources = sources.data;
    state.imports = imports.data;
    state.runs = runs.data;
    state.exceptions = exceptions.data;
    state.periods = periods.data;
    state.audit = audit.data;
    state.operators = operators.data;
    state.moneyFlow = moneyFlow;
    renderAll();
    $("#apiStatus").textContent = "连接正常";
  } catch (error) {
    $("#apiStatus").textContent = "连接失败";
    notify(messageFor(error), true);
  } finally { setBusy(false); }
}

function renderAll() {
  renderRoleChrome(); renderIdentity(); renderOverview(); renderSources(); renderImports(); renderRuns(); renderExceptions(); renderPeriods(); renderAudit(); renderSelectors();
}

function renderRoleChrome() {
  const profile = getRoleProfile(state.session?.role);
  const currentView = document.querySelector(".view.active")?.id || "overview";
  const activeView = canView(profile, currentView) ? currentView : "overview";
  document.body.dataset.role = profile.role;
  $("#mainNav").innerHTML = profile.views.map((view, index) => `<button class="nav-item ${view === activeView ? "active" : ""}" type="button" data-view="${view}"><span class="nav-index">${String(index + 1).padStart(2, "0")}</span><span class="nav-label">${escapeHtml(profile.navigation[view])}</span>${view === "exceptions" ? `<b id="exceptionBadge">0</b>` : ""}</button>`).join("");
  $$(".view").forEach((item) => item.classList.toggle("active", item.id === activeView));
  setPageIdentity(profile, activeView);
  $("#uploadForm").classList.toggle("hidden", !can(profile, "upload"));
  $("#toggleRunForm").classList.toggle("hidden", !can(profile, "run"));
  $("#runForm").classList.add("hidden");
  $("#togglePeriodForm").classList.toggle("hidden", !can(profile, "period_create"));
  $("#periodForm").classList.add("hidden");
  const sectionCopy = {
    runs: profile.role === "auditor" ? ["对账证据", "只读检查规则、匹配组和分配事实"] : profile.role === "reviewer" ? ["对账结果", "复核确定性运行与阻断异常"] : ["对账运行", "规则按固定记录水位确定性执行"],
    exceptions: profile.role === "reviewer" ? ["异常复核", "判断未匹配与歧义是否阻断月结"] : ["异常队列", "所有歧义与未匹配记录进入人工调查"],
    periods: profile.role === "auditor" ? ["月结档案", "只读检查锁定版本与 manifest 哈希"] : ["月结中心", "存在开放阻断异常时，系统拒绝锁定"],
    audit: ["审计记录", "数据库触发器禁止更新或删除审计事件"],
  };
  for (const [view, copy] of Object.entries(sectionCopy)) {
    const heading = document.querySelector(`#${view} .section-row h2`);
    const paragraph = document.querySelector(`#${view} .section-row p`);
    if (heading) heading.textContent = copy[0];
    if (paragraph) paragraph.textContent = copy[1];
  }
}

function renderIdentity() {
  $("#workspaceIdentity").innerHTML = `<strong>${escapeHtml(state.workspace?.tenant?.name || state.session.tenantName)}</strong><span>${escapeHtml(roleLabels[state.session.role] || state.session.role)}</span>`;
}

function renderOverview() {
  const counts = state.workspace.counts;
  const latestPeriod = state.periods[0];
  $("#periodBandStatus").innerHTML = latestPeriod ? status(latestPeriod.status, latestPeriod.status === "locked" ? "已锁定" : "待月结") : status("warning", "尚未建期");
  $("#currencyLegend").innerHTML = state.workspace.currencies.map((item) => `<span class="currency-chip">${escapeHtml(item.currency)}<b>${item.record_count} 条</b></span>`).join("") || `<span class="currency-chip">暂无币种</span>`;
  $("#moneyFlowBoard").innerHTML = renderMoneyFlowBoard();
  $("#overviewExceptions").innerHTML = state.exceptions.slice(0, 4).map((item) => `<button class="exception-item" type="button" data-overview-exception="${escapeHtml(item.id)}"><span class="exception-signal"></span><div><strong>${escapeHtml(actionableException(item))}</strong><small>${escapeHtml(item.external_id || "无外部流水号")} · ${escapeHtml(sourceLabels[item.source_type] || item.source_type || "未知来源")} · ${aiSuggestionLabel(item)}</small></div>${item.currency && item.amount_minor !== null ? `<b>${formatMinor(item.amount_minor, item.currency)}</b>` : status(item.severity, "需调查")}</button>`).join("") || `<div class="empty-detail compact-empty"><strong>没有开放异常</strong><p>当前运行未发现阻断项。</p></div>`;
  $("#controlHealth").innerHTML = [
    ["数据入口", counts.source_count, "个渠道与银行"], ["标准记录", counts.record_count, "条保留原始血缘"],
    ["完成运行", counts.run_count, "次确定性执行"], ["月结状态", counts.open_exception_count ? "阻断" : "可检查", counts.open_exception_count ? `${counts.open_exception_count} 条异常待处理` : "没有开放异常"],
  ].map(([name, value, note], index) => `<div class="health-row ${index === 3 && counts.open_exception_count ? "danger" : ""}"><span>${name}</span><strong>${value}</strong><small>${note}</small></div>`).join("");
  $("#scenarioExceptionCount").textContent = counts.open_exception_count;
  renderMatchedCases();
  renderBlockedStory();
  renderRoleHome();
  const exceptionBadge = $("#exceptionBadge");
  if (exceptionBadge) {
    exceptionBadge.textContent = counts.open_exception_count;
    exceptionBadge.style.display = counts.open_exception_count ? "grid" : "none";
  }
}

function renderRoleHome() {
  const profile = getRoleProfile(state.session.role);
  const isAdmin = profile.homeVariant === "admin";
  $("#adminHome").classList.toggle("hidden", !isAdmin);
  $("#roleHome").classList.toggle("hidden", isAdmin);
  if (isAdmin) return;
  const renderers = { operator: renderOperatorHome, reviewer: renderReviewerHome, auditor: renderAuditorHome };
  $("#roleHome").innerHTML = (renderers[profile.homeVariant] || renderAuditorHome)();
}

function renderOperatorHome() {
  const counts = state.workspace.counts;
  const recentImports = state.imports.slice(0, 4);
  const recentRuns = state.runs.slice(0, 4);
  return `${roleCommand("operator", "TODAY'S OPERATIONS", "把今天该处理的资金做完", "先保证数据完整，再运行对账，最后调查没有形成唯一证据的资金。", "经办岗位")}
    <div class="role-stat-strip">${[
      ["待调查异常", counts.open_exception_count, "进入调查队列", "exceptions"],
      ["成功导入批次", counts.import_count, "查看数据接入", "sources"],
      ["完成对账运行", counts.run_count, "查看运行证据", "runs"],
      ["标准资金记录", counts.record_count, "保留原始血缘", null],
    ].map(roleStat).join("")}</div>
    <div class="role-work-grid operator-grid">
      <section class="role-work-panel attention"><header><div><span class="panel-kicker">NEXT ACTION</span><h2>现在需要处理</h2></div><button class="text-button" type="button" data-role-view="exceptions">打开队列</button></header>${renderRoleExceptions("没有待调查异常，当前作业队列已清空。")}</section>
      <section class="role-work-panel"><header><div><span class="panel-kicker">RECENT INTAKE</span><h2>最近数据接入</h2></div><button class="text-button" type="button" data-role-view="sources">继续导入</button></header><div class="role-rows">${recentImports.map((item) => `<div class="role-row"><div><strong>${escapeHtml(item.original_filename)}</strong><small>${item.row_count} 行 · ${formatDateTime(item.committed_at || item.created_at)}</small></div>${status(item.status, batchLabel(item.status))}</div>`).join("") || roleEmpty("还没有导入批次")}</div></section>
      <section class="role-work-panel wide"><header><div><span class="panel-kicker">RECONCILIATION</span><h2>最近对账任务</h2></div><button class="text-button" type="button" data-role-view="runs">新建或查看运行</button></header><div class="role-run-grid">${recentRuns.map(roleRunSummary).join("") || roleEmpty("还没有对账运行")}</div></section>
    </div>${roleBoundary("职责边界", "你负责数据接入、对账执行和异常调查。月结锁定与审计记录由复核人、管理员和审计员承担。")}`;
}

function renderReviewerHome() {
  const counts = state.workspace.counts;
  const latestPeriod = state.periods[0];
  const ready = counts.open_exception_count === 0 && state.runs.some((run) => run.status === "completed");
  return `${roleCommand("reviewer", "REVIEW & CLOSE", "决定本期能不能安全月结", "从阻断异常、运行证据和期间状态出发，不参与日常数据录入。", "复核岗位")}
    <div class="role-stat-strip">${[
      ["阻断异常", counts.open_exception_count, ready ? "当前无阻断项" : "必须先完成调查", "exceptions"],
      ["完成运行", counts.run_count, "检查规则与匹配", "runs"],
      ["当前期间", latestPeriod ? (latestPeriod.status === "locked" ? "已锁定" : "开放") : "未创建", latestPeriod ? `版本 v${latestPeriod.version}` : "需要创建期间", "periods"],
      ["已锁定期间", counts.locked_period_count, "不可变月结快照", "periods"],
    ].map(roleStat).join("")}</div>
    <div class="role-work-grid reviewer-grid">
      <section class="close-readiness ${ready ? "ready" : "blocked"}"><span class="panel-kicker">CLOSE READINESS</span><strong>${ready ? "可以进入锁定检查" : "本期暂不能锁定"}</strong><p>${ready ? "没有开放阻断异常，仍需选择本期完整运行证据。" : `${counts.open_exception_count} 条开放异常仍在阻断月结。`}</p><button class="button ${ready ? "primary" : "ghost"}" type="button" data-role-view="periods">检查月结条件</button></section>
      <section class="role-work-panel"><header><div><span class="panel-kicker">REVIEW QUEUE</span><h2>需要复核的异常</h2></div><button class="text-button" type="button" data-role-view="exceptions">查看证据</button></header>${renderRoleExceptions("没有开放异常，可以继续检查运行完整性。")}</section>
      <section class="role-work-panel wide"><header><div><span class="panel-kicker">RUN EVIDENCE</span><h2>本期运行证据</h2></div><button class="text-button" type="button" data-role-view="runs">检查全部结果</button></header><div class="role-run-grid">${state.runs.slice(0, 4).map(roleRunSummary).join("") || roleEmpty("还没有对账运行")}</div></section>
    </div>${roleBoundary("经办与复核分离", "复核人只审核处理方案和执行月结，后端同样禁止复核人导入文件或发起对账。")}`;
}

function renderAuditorHome() {
  const counts = state.workspace.counts;
  const verifiedCases = state.moneyFlow.cases.length;
  return `${roleCommand("auditor", "INDEPENDENT EVIDENCE", "沿着证据查清每一笔钱", "只读检查来源、匹配分配、月结快照和操作者轨迹，不改变业务状态。", "只读岗位")}
    <div class="role-stat-strip">${[
      ["标准资金记录", counts.record_count, "可追溯到原始行", null],
      ["真实匹配证据", verifiedCases, "最新确定性运行", "runs"],
      ["锁定期间", counts.locked_period_count, "查看 manifest", "periods"],
      ["审计事件", state.audit.length, "追加写入、不可修改", "audit"],
    ].map(roleStat).join("")}</div>
    <div class="role-work-grid auditor-grid">
      <section class="role-work-panel evidence"><header><div><span class="panel-kicker">MONEY EVIDENCE</span><h2>最近匹配证据</h2></div><button class="text-button" type="button" data-role-view="runs">查看运行证据</button></header><div class="role-rows">${state.moneyFlow.cases.slice(0, 5).map((item) => `<div class="role-row"><div><strong>${escapeHtml(item.records.map((record) => record.externalId).join(" → "))}</strong><small>${escapeHtml(matchType(item.match_type))} · ${item.records.length} 条分配事实</small></div><b>${formatMinor(item.amount_minor, item.currency)}</b></div>`).join("") || roleEmpty("还没有匹配证据")}</div></section>
      <section class="role-work-panel audit"><header><div><span class="panel-kicker">AUDIT TRAIL</span><h2>最近审计活动</h2></div><button class="text-button" type="button" data-role-view="audit">查看完整日志</button></header><div class="role-rows">${state.audit.slice(0, 5).map((item) => `<div class="role-row"><div><strong>${escapeHtml(actionLabels[item.action] || item.action)}</strong><small>${formatDateTime(item.created_at)} · ${escapeHtml(item.object_type)}</small></div><span class="mono">${escapeHtml(String(item.request_id || "-").slice(0, 12))}</span></div>`).join("") || roleEmpty("还没有审计事件")}</div></section>
    </div>${roleBoundary("只读保证", "此身份没有数据导入、发起对账、创建期间或锁定月结入口。当前证据包下载仍未实现。")}`;
}

function roleCommand(variant, kicker, title, description, badge) {
  return `<section class="role-command ${variant}"><div><span class="eyebrow">${escapeHtml(kicker)}</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div><span class="role-posture">${escapeHtml(badge)}</span></section>`;
}
function roleStat([label, value, note, view]) { return `<${view ? "button" : "div"} class="role-stat" ${view ? `type="button" data-role-view="${view}"` : ""}><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></${view ? "button" : "div"}>`; }
function roleRunSummary(item) { return `<button class="role-run" type="button" data-role-view="runs"><span>${escapeHtml(item.period_start)} 至 ${escapeHtml(item.period_end)}</span><strong>${item.stats?.groupCount ?? 0} 个匹配组</strong><small>${blockingCount(item)} 条当前阻断异常 · ${runStatus(item.status)}</small></button>`; }
function renderRoleExceptions(emptyText) { return `<div class="role-rows">${state.exceptions.slice(0, 4).map((item) => `<button class="role-row actionable" type="button" data-role-view="exceptions"><div><strong>${escapeHtml(actionableException(item))}</strong><small>${escapeHtml(item.external_id || "无外部流水号")} · ${escapeHtml(sourceLabels[item.source_type] || item.source_type || "未知来源")}</small></div><b>${item.currency && item.amount_minor !== null ? formatMinor(item.amount_minor, item.currency) : "待确认"}</b></button>`).join("") || roleEmpty(emptyText)}</div>`; }
function roleEmpty(text) { return `<div class="role-empty">${escapeHtml(text)}</div>`; }
function roleBoundary(title, text) { return `<div class="role-boundary"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(text)}</span></div>`; }

function renderMoneyFlowBoard() {
  const currencies = state.workspace.currencies.map((item) => item.currency);
  if (!currencies.length) return `<div class="empty-detail"><strong>还没有资金记录</strong><p>导入来源文件后，这里会按原币种显示资金链。</p></div>`;
  return currencies.map((currency) => {
    const order = stageTotal(currency, "shopify", null, "gross_minor");
    const charge = stageTotal(currency, "stripe", "charge", "gross_minor");
    const fee = stageTotal(currency, "stripe", "charge", "fee_minor");
    const payout = absoluteMinor(stageTotal(currency, "stripe", "payout", "net_minor"));
    const bank = stageTotal(currency, "bank", "credit", "net_minor");
    const commerceGap = order - charge;
    const settlementGap = payout - bank;
    return `<article class="currency-lane">
      <header><div><span class="currency-code">${escapeHtml(currency)}</span><strong>${currencyTitle(currency)}</strong></div><span>${state.moneyFlow.stages.filter((item) => item.currency === currency).reduce((sum, item) => sum + Number(item.record_count), 0)} 条记录</span></header>
      <div class="lane-group"><span class="lane-label">订单核对</span><div class="money-track">
        ${flowNode("Shopify 订单", order, currency, "commerce")}${flowConnector(commerceGap, currency)}${flowNode("Stripe 收款", charge, currency, "processor")}${flowNode("其中手续费", fee, currency, "fee")}
      </div></div>
      <div class="lane-group"><span class="lane-label">结算核对</span><div class="money-track settlement">
        ${flowNode("Stripe 结算", payout, currency, "payout")}${flowConnector(settlementGap, currency)}${flowNode("银行到账", bank, currency, "bank")}${flowNode("账面差异", settlementGap, currency, settlementGap === 0n ? "clear" : "gap")}
      </div></div>
    </article>`;
  }).join("");
}

function stageTotal(currency, sourceType, recordType, field) {
  return state.moneyFlow.stages.filter((item) => item.currency === currency && item.source_type === sourceType && (!recordType || item.record_type === recordType)).reduce((sum, item) => sum + BigInt(item[field] || 0), 0n);
}
function absoluteMinor(value) { return value < 0n ? -value : value; }
function flowNode(label, amount, currency, type) { return `<div class="flow-node ${type}"><span>${escapeHtml(label)}</span><strong>${formatMinor(amount, currency)}</strong></div>`; }
function flowConnector(gap, currency) { const clear = gap === 0n; return `<div class="flow-connector ${clear ? "clear" : "gap"}"><i></i><span>${clear ? "金额一致" : `${formatMinor(absoluteMinor(gap), currency)} 差异`}</span></div>`; }
function currencyTitle(currency) { return ({ USD: "美元资金", EUR: "欧元资金", GBP: "英镑资金", HKD: "港币资金" })[currency] || `${currency} 资金`; }

function renderMatchedCases() {
  const cases = state.moneyFlow.cases;
  $("#matchedCaseList").innerHTML = cases.map((item, index) => {
    const sources = item.records.filter((record) => record.role === "source");
    const targets = item.records.filter((record) => record.role === "target");
    return `<button class="case-item ${state.selectedCaseId === item.id || (!state.selectedCaseId && index === 0) ? "active" : ""}" type="button" data-case-id="${escapeHtml(item.id)}"><span class="case-index">${String(index + 1).padStart(2, "0")}</span><div><strong>${escapeHtml(sources.map((record) => record.externalId).join(" + "))}</strong><small>${escapeHtml(sources.map((record) => sourceLabels[record.sourceType] || record.sourceType).join(" + "))} → ${escapeHtml(targets.map((record) => sourceLabels[record.sourceType] || record.sourceType).join(" + "))}</small></div><b>${formatMinor(item.amount_minor, item.currency)}</b><span class="case-state">已核对</span></button>`;
  }).join("") || `<div class="empty-detail"><strong>还没有匹配证据</strong><p>完成一次对账运行后，这里会显示真实匹配组。</p></div>`;
  const selected = cases.find((item) => item.id === state.selectedCaseId) || cases[0];
  if (selected) { state.selectedCaseId = selected.id; renderTraceDetail(selected); }
  else $("#moneyTraceDetail").innerHTML = "";
}

function renderTraceDetail(item) {
  const records = item.records;
  $("#moneyTraceDetail").innerHTML = `<div class="trace-head"><div><span class="panel-kicker">VERIFIED MATCH</span><h3>${escapeHtml(matchType(item.match_type))} · ${formatMinor(item.amount_minor, item.currency)}</h3></div>${status("completed", "金额守恒")}</div><div class="trace-timeline">${records.map((record, index) => `<div class="trace-event"><span class="trace-dot ${record.role}">${index + 1}</span><div><small>${escapeHtml(record.businessDate || "-")} · ${escapeHtml(sourceLabels[record.sourceType] || record.sourceType)}</small><strong>${escapeHtml(record.externalId)}</strong><p>${escapeHtml(recordTypeLabel(record.recordType))} · 分配 ${formatMinor(record.allocatedMinor, item.currency)}</p></div><b>${formatMinor(record.grossMinor ?? record.netMinor, item.currency)}</b></div>`).join("")}</div><div class="trace-proof"><div><span>匹配方式</span><strong>${escapeHtml(matchType(item.match_type))}</strong></div><div><span>匹配组</span><strong class="mono">${escapeHtml(item.id.slice(0, 12))}</strong></div><div><span>对账运行</span><strong class="mono">${escapeHtml(item.recon_run_id.slice(0, 12))}</strong></div></div>`;
}

function renderBlockedStory() {
  $("#blockedStory").innerHTML = state.exceptions.map((item, index) => `<button class="blocked-case" type="button" data-overview-exception="${escapeHtml(item.id)}"><span class="blocked-index">${String(index + 1).padStart(2, "0")}</span><div class="blocked-route"><div class="blocked-node"><small>${escapeHtml(sourceLabels[item.source_type] || item.source_type || "未知来源")}</small><strong>${escapeHtml(item.external_id || "无外部流水号")}</strong><b>${item.currency && item.amount_minor !== null ? formatMinor(item.amount_minor, item.currency) : "金额待确认"}</b></div><div class="broken-line"><i></i><span>未形成唯一匹配</span></div><div class="blocked-node missing"><small>目标证据</small><strong>需要人工调查</strong><b>${escapeHtml(exceptionLabel(item.exception_type))}</b></div></div><span class="blocking-label">阻断月结</span></button>`).join("") || `<div class="empty-detail"><strong>没有异常阻断</strong><p>当前所有对账运行均无开放异常。</p></div>`;
}

function actionableException(item) { if (item.exception_type === "unmatched_source") return "有订单或来源记录，但没有找到对应资金"; if (item.exception_type === "unmatched_target") return "平台出现资金，但没有找到对应业务记录"; return "存在多个候选，系统拒绝自动选择"; }
function recordTypeLabel(value) { return ({ order: "订单", order_paid: "已付款订单", order_partially_refunded: "部分退款订单", charge: "平台收款", payout: "结算批次", credit: "银行入账", transaction: "资金交易" })[value] || value; }

function renderSources() {
  $("#sourceRows").innerHTML = state.sources.map((item) => `<tr><td><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.id)}</small></td><td>${escapeHtml(sourceLabels[item.source_type] || item.source_type)}</td><td>${item.import_count}</td><td>${item.imported_rows}</td><td>${formatDateTime(item.last_import_at)}</td><td>${status(item.last_import_at ? "committed" : "warning", item.last_import_at ? "已接入" : "待首批数据")}</td></tr>`).join("") || emptyRow(6, "尚未配置来源");
}

function renderImports() {
  const sources = new Map(state.sources.map((item) => [item.id, item]));
  $("#importRows").innerHTML = state.imports.map((item) => `<tr><td><strong>${escapeHtml(item.original_filename)}</strong><small>${bytes(item.byte_size)}</small></td><td>${escapeHtml(sourceLabels[sources.get(item.data_source_id)?.source_type] || "未知")}</td><td>${item.row_count}</td><td>${status(item.status, batchLabel(item.status))}</td><td>${formatDateTime(item.committed_at || item.created_at)}</td><td class="mono">${escapeHtml(shortHash(item.sha256))}</td></tr>`).join("") || emptyRow(6, "尚无导入批次");
}

function renderRuns() {
  $("#runRows").innerHTML = state.runs.map((item) => `<tr data-selectable data-run-id="${escapeHtml(item.id)}"><td><strong>${escapeHtml(item.id.slice(0, 8))}</strong><small>${formatDateTime(item.started_at)}</small></td>${runCells(item)}</tr>`).join("") || emptyRow(6, "尚无对账运行");
}

function runRow(item) { return `<tr data-selectable data-run-id="${escapeHtml(item.id)}"><td><strong>${escapeHtml(item.period_start)} 至 ${escapeHtml(item.period_end)}</strong><small>${escapeHtml(item.id.slice(0, 8))}</small></td><td>${status(item.status, runStatus(item.status))}</td><td>${item.stats?.groupCount ?? 0}</td><td>${blockingCount(item)}</td><td>${formatDateTime(item.completed_at)}</td></tr>`; }
function runCells(item) { return `<td><strong>${escapeHtml(item.period_start)} 至 ${escapeHtml(item.period_end)}</strong></td><td>${status(item.status, runStatus(item.status))}</td><td>${item.stats?.groupCount ?? 0}</td><td>${blockingCount(item)}</td><td class="mono">${escapeHtml(shortHash(item.rule_sha256))}</td>`; }

function renderExceptions() {
  $("#exceptionRows").innerHTML = state.exceptions.map((item) => `<tr data-selectable data-exception-id="${escapeHtml(item.id)}"><td>${status(item.severity, item.severity === "blocking" ? "阻断" : "警告")}</td><td><strong>${escapeHtml(item.external_id || "无外部流水号")}</strong><small>${escapeHtml(sourceLabels[item.source_type] || item.source_type || "未知来源")} · ${escapeHtml(item.id.slice(0, 8))}</small></td><td>${status(item.status, workflowStatus(item.status))}</td><td>${escapeHtml(item.assignee_email || "共享队列")}</td><td>${escapeHtml(exceptionLabel(item.exception_type))}</td><td>${Number(item.ai_suggestion_count) > 0 ? status("completed", aiSuggestionLabel(item)) : status("warning", "未生成")}</td><td>${item.currency && item.amount_minor !== null ? formatMinor(item.amount_minor, item.currency) : "-"}</td><td>${escapeHtml(item.business_date || "-")}</td></tr>`).join("") || emptyRow(8, "当前筛选下没有异常");
}

function aiSuggestionLabel(item) {
  const count = Number(item.ai_suggestion_count) || 0;
  return count > 0 ? `AI 建议 ${count} 条` : "暂无 AI 建议";
}

function renderPeriods() {
  $("#periodRows").innerHTML = state.periods.map((item) => `<tr data-selectable data-period-id="${escapeHtml(item.id)}"><td><strong>${escapeHtml(item.period_start)} 至 ${escapeHtml(item.period_end)}</strong><small>${item.parent_period_id ? "重新开账版本" : "初始版本"}</small></td><td>v${item.version}</td><td>${status(item.status, item.status === "locked" ? "已锁定" : "开放")}</td><td>${formatDateTime(item.locked_at)}</td><td class="mono">${item.manifest_sha256 ? escapeHtml(shortHash(item.manifest_sha256)) : "尚未生成"}</td><td><div class="table-actions"><button class="button ghost" type="button" data-period-archive="${escapeHtml(item.id)}">打开档案</button>${item.status === "open" && ["reviewer", "admin"].includes(state.session.role) ? `<button class="button ghost" type="button" data-close-period="${escapeHtml(item.id)}">锁定检查</button>` : ""}</div></td></tr>`).join("") || emptyRow(6, "尚未创建会计期间");
}

function renderAudit() {
  $("#auditRows").innerHTML = state.audit.map((item) => `<tr><td>${formatDateTime(item.created_at)}</td><td><strong>${escapeHtml(actionLabels[item.action] || item.action)}</strong><small>${escapeHtml(item.action)}</small></td><td>${escapeHtml(item.object_type)}<small>${escapeHtml(String(item.object_id).slice(0, 16))}</small></td><td class="mono">${escapeHtml(String(item.actor_id || "系统").slice(0, 12))}</td><td class="mono">${escapeHtml(String(item.request_id || "-").slice(0, 20))}</td><td>${escapeHtml(item.reason || "-")}</td></tr>`).join("") || emptyRow(6, state.session.role === "admin" || state.session.role === "auditor" ? "暂无审计事件" : "当前角色无权查看审计记录");
}

function renderSelectors() {
  const sourceOptions = state.sources.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(sourceLabels[item.source_type] || item.source_type)}</option>`).join("");
  $("#uploadSource").innerHTML = sourceOptions;
  const types = [...new Set(state.sources.map((item) => item.source_type))];
  const typeOptions = types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(sourceLabels[type] || type)}</option>`).join("");
  $("#runSource").innerHTML = typeOptions;
  $("#runTarget").innerHTML = typeOptions;
  if (types.includes("shopify")) $("#runSource").value = "shopify";
  if (types.includes("stripe")) $("#runTarget").value = "stripe";
}

async function showRunDetail(runId) {
  navigate("runs");
  const detail = await api(`/v1/tenants/${encodeURIComponent(state.session.tenantId)}/recon-runs/${encodeURIComponent(runId)}`);
  const groups = detail.groups.map((group) => `<div class="allocation"><span>${escapeHtml(matchType(group.match_type))} · ${group.allocations.length} 条分配</span><strong>${formatMinor(group.amount_minor, group.currency)}</strong></div>`).join("") || `<p>本次运行没有匹配组。</p>`;
  $("#runDetail").innerHTML = `<div class="detail-head"><span>运行证据</span><h3>${escapeHtml(detail.id)}</h3></div><div class="detail-section"><h4>固定上下文</h4><div class="detail-grid"><div><span>期间</span><strong>${escapeHtml(detail.period_start)} 至 ${escapeHtml(detail.period_end)}</strong></div><div><span>引擎</span><strong>${escapeHtml(detail.engine_version)}</strong></div><div><span>记录水位</span><strong>${formatDateTime(detail.record_highwater)}</strong></div><div><span>规则哈希</span><strong class="mono">${escapeHtml(shortHash(detail.rule_sha256))}</strong></div></div></div><div class="detail-section"><h4>匹配分配</h4>${groups}</div><div class="detail-section"><h4>阻断异常</h4><strong>${detail.exceptions.length} 条</strong></div>`;
}

async function showExceptionDetail(id) {
  state.selectedExceptionId = id;
  const item = await api(`/v1/tenants/${encodeURIComponent(state.session.tenantId)}/exceptions/${encodeURIComponent(id)}`);
  const profile = getRoleProfile(state.session.role);
  const isMine = item.assignee_id === (state.session.userId || state.workspace.userId);
  const replacementRuns = state.runs.filter((run) => run.id !== item.recon_run_id && run.status === "completed" && run.period_start === item.period_start && run.period_end === item.period_end && blockingCount(run) === 0);
  const notes = item.notes.map((note) => `<article class="workflow-event"><div><strong>${escapeHtml(note.author_email)}</strong><time>${formatDateTime(note.created_at)}</time></div><p>${escapeHtml(note.body)}</p></article>`).join("") || `<p class="workflow-empty">尚无调查备注。</p>`;
  const proposals = item.proposals.map((proposal) => `<article class="workflow-event proposal"><div><strong>方案 v${proposal.proposal_version} · ${escapeHtml(resolutionLabel(proposal.resolution_type))}</strong>${status(proposal.decision || "pending_review", proposal.decision ? decisionLabel(proposal.decision) : "待复核")}</div><p>${escapeHtml(proposal.summary)}</p><small>${escapeHtml(proposal.submitted_by_email)} · ${formatDateTime(proposal.created_at)}${proposal.replacement_run_id ? ` · 新运行 ${escapeHtml(proposal.replacement_run_id.slice(0, 8))}` : ""}</small>${proposal.decision_reason ? `<blockquote>${escapeHtml(proposal.decision_reason)}</blockquote>` : ""}</article>`).join("") || `<p class="workflow-empty">尚未提交处理方案。</p>`;
  const canAdopt = item.status === "investigating" && isMine && can(profile, "exception_submit");
  const adoptionsByAudit = new Map((item.adoptions || []).map((adoption) => [String(adoption.ai_audit_id), adoption]));
  const aiSuggestions = (item.aiSuggestions || []).map((suggestion) => renderAiSuggestion(suggestion, adoptionsByAudit.get(String(suggestion.auditId)), canAdopt)).join("") || `<p class="workflow-empty">尚未生成 AI 调查建议。</p>`;
  const investigationItems = renderInvestigationItems(item.investigationItems || [], canAdopt);
  const manualItemForm = canAdopt ? `<form data-add-investigation-item class="workflow-form investigation-add"><label>新增人工检查项<input name="title" minlength="2" maxlength="500" required /></label><label class="check-control"><input name="required" type="checkbox" checked />提交复核前必须完成</label><button class="button ghost" type="submit">加入清单</button></form>` : "";
  const aiAction = can(profile, "ai_suggest") && item.status !== "resolved" ? `<div class="ai-suggestion-action"><div><strong>AI 调查助手</strong><small>仅发送异常分类元数据，不发送金额、币种、日期、流水号、租户、人员或人工备注。</small></div><button class="button ghost" type="button" data-generate-ai-suggestion>生成建议</button></div>` : "";
  let actions = "";
  if (item.status === "open" && can(profile, "exception_claim")) actions = `<button class="button primary" type="button" data-claim-exception>领取处理</button>`;
  if (item.status === "open" && can(profile, "exception_assign")) actions = `<form data-assign-exception class="workflow-form"><label>分派给操作员<select name="assigneeId" required>${state.operators.map((operator) => `<option value="${escapeHtml(operator.id)}">${escapeHtml(operator.email)}</option>`).join("")}</select></label><button class="button primary" type="submit">确认分派</button></form>`;
  if (item.status === "investigating" && isMine && can(profile, "exception_submit")) actions = `${noteForm()}<form data-submit-resolution class="workflow-form"><label>处理类型<select name="resolutionType"><option value="timing_difference">到账时间差</option><option value="fee_difference">手续费差异</option><option value="duplicate_record">重复记录</option><option value="manual_link">人工关联</option><option value="source_correction">来源数据更正</option><option value="other">其他</option></select></label><label>调查结论<textarea name="summary" minlength="10" maxlength="2000" required></textarea></label><label class="check-control"><input name="financialImpact" type="checkbox" />会改变金额或匹配关系</label><label>对应的新对账运行<select name="replacementRunId"><option value="">不需要</option>${replacementRuns.map((run) => `<option value="${escapeHtml(run.id)}">${escapeHtml(run.id.slice(0, 8))} · ${run.stats?.groupCount || 0} 个匹配组</option>`).join("")}</select></label><div class="form-actions"><button class="button ghost" type="button" data-release-exception>退回共享队列</button><button class="button primary" type="submit">提交复核</button></div></form>`;
  if (item.status === "pending_review" && can(profile, "exception_review")) actions = `${noteForm()}<form data-decide-resolution class="workflow-form"><label>复核意见<textarea name="reason" maxlength="2000" placeholder="驳回时至少填写 10 个字"></textarea></label><div class="form-actions"><button class="button danger" name="decision" value="rejected" type="submit">驳回</button><button class="button primary" name="decision" value="approved" type="submit">批准</button></div></form>`;
  if (!actions && item.status !== "resolved") actions = `<div class="scope-band"><strong>当前步骤</strong><span>${item.assignee_email ? `由 ${escapeHtml(item.assignee_email)} 处理，其他人可以查看但不能重复提交。` : "等待操作员领取。"}</span></div>`;
  $("#exceptionDetail").innerHTML = `<div class="detail-head"><span>${escapeHtml(item.severity === "blocking" ? "阻断异常" : "警告")}</span><h3>${escapeHtml(item.external_id || item.id)}</h3></div><div class="detail-section"><h4>异常信息</h4><div class="detail-grid"><div><span>类型</span><strong>${escapeHtml(exceptionLabel(item.exception_type))}</strong></div><div><span>状态</span><strong>${escapeHtml(workflowStatus(item.status))}</strong></div><div><span>负责人</span><strong>${escapeHtml(item.assignee_email || "共享队列")}</strong></div><div><span>金额</span><strong>${item.currency && item.amount_minor !== null ? formatMinor(item.amount_minor, item.currency) : "-"}</strong></div><div><span>业务日期</span><strong>${escapeHtml(item.business_date || "-")}</strong></div><div><span>版本</span><strong>v${item.workflow_version}</strong></div></div></div><div class="detail-section"><h4>引擎说明</h4><p>${escapeHtml(detailText(item))}</p></div><div class="detail-section ai-suggestion-section"><div class="detail-section-title"><h4>AI 调查建议</h4><span>只读参考</span></div>${aiAction}<div class="workflow-history">${aiSuggestions}</div></div><div class="detail-section investigation-section"><div class="detail-section-title"><h4>调查清单</h4><span>人工确认</span></div>${investigationItems}${manualItemForm}</div><div class="detail-section"><h4>调查备注</h4><div class="workflow-history">${notes}</div></div><div class="detail-section"><h4>处理与复核记录</h4><div class="workflow-history">${proposals}</div></div><div class="detail-section workflow-actions" data-workflow-version="${item.workflow_version}">${actions || `<div class="scope-band"><strong>已完成</strong><span>处理方案已由 ${escapeHtml(item.resolved_by_email || "复核人")} 批准，原始记录和全部处理历史均已保留。</span></div>`}</div>`;
}

function noteForm() { return `<form data-add-note class="workflow-form"><label>追加调查备注<textarea name="body" minlength="2" maxlength="2000" required></textarea></label><button class="button ghost" type="submit">添加备注</button></form>`; }

function renderAiSuggestion(item, adoption, canAdopt) {
  const suggestion = item.suggestion || {};
  const adoptionView = adoption
    ? `<div class="adoption-result">${status(adoption.decision === "rejected" ? "warning" : "completed", adoptionLabel(adoption.decision))}<span>${escapeHtml(adoption.decided_by_email)} · ${formatDateTime(adoption.created_at)}</span>${adoption.reason ? `<p>原因：${escapeHtml(adoption.reason)}</p>` : ""}</div>`
    : canAdopt ? adoptionForm(item) : `<p class="workflow-empty">等待负责人判断是否采纳。</p>`;
  return `<article class="workflow-event ai-suggestion"><div><strong>${escapeHtml(item.model || "AI")} · ${escapeHtml(confidenceLabel(suggestion.confidence))}</strong><time>${formatDateTime(item.createdAt)}</time></div><p><b>可能原因</b>${escapeHtml(suggestion.likelyCause || "-")}</p>${suggestionGroup("已知依据", suggestion.evidence)}${suggestionGroup("待补证据", suggestion.missingEvidence)}${suggestionGroup("建议检查", suggestion.nextSteps)}${suggestionGroup("注意事项", suggestion.cautions)}<small>${escapeHtml(item.actorEmail || "-")} 生成 · 审计记录 #${escapeHtml(item.auditId)}</small>${adoptionView}</article>`;
}

function suggestionGroup(label, items) {
  const list = Array.isArray(items) ? items : [];
  return `<div class="ai-suggestion-group"><b>${escapeHtml(label)}</b><ul>${list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`;
}

function adoptionForm(item) {
  const steps = item.suggestion?.nextSteps || [];
  const partialOption = steps.length > 1 ? `<option value="partially_accepted">部分采纳</option>` : "";
  return `<form data-adopt-ai-suggestion data-ai-audit-id="${escapeHtml(item.auditId)}" class="workflow-form adoption-form"><label>使用方式<select name="decision"><option value="accepted">采纳全部建议</option>${partialOption}<option value="rejected">不采纳</option></select></label><fieldset data-adoption-steps><legend>加入调查清单的步骤</legend>${steps.map((step) => `<label class="check-control"><input type="checkbox" name="selectedSteps" value="${escapeHtml(step)}" checked disabled />${escapeHtml(step)}</label>`).join("")}</fieldset><label>不采纳原因<textarea name="reason" minlength="2" maxlength="2000" placeholder="选择不采纳时必须填写" disabled></textarea></label><button class="button ghost" type="submit">记录使用结果</button></form>`;
}

function renderInvestigationItems(items, canEdit) {
  if (!items.length) return `<p class="workflow-empty">尚未建立调查清单。</p>`;
  return `<div class="investigation-list">${items.map((item) => canEdit ? renderEditableInvestigationItem(item) : renderReadonlyInvestigationItem(item)).join("")}</div>`;
}

function renderEditableInvestigationItem(item) {
  return `<form data-update-investigation-item data-item-id="${escapeHtml(item.id)}" class="investigation-item"><div><strong>${escapeHtml(item.title)}</strong><small>${item.source === "ai" ? "来自 AI 建议" : "人工添加"} · ${item.required ? "必查" : "选查"}</small></div><label>状态<select name="status"><option value="todo" ${item.status === "todo" ? "selected" : ""}>待检查</option><option value="done" ${item.status === "done" ? "selected" : ""}>已确认</option><option value="not_applicable" ${item.status === "not_applicable" ? "selected" : ""}>不适用</option></select></label><label>检查结果<textarea name="result" maxlength="2000">${escapeHtml(item.result || "")}</textarea></label><button class="button ghost" type="submit">保存</button></form>`;
}

function renderReadonlyInvestigationItem(item) {
  return `<article class="investigation-item readonly"><div><strong>${escapeHtml(item.title)}</strong><small>${item.source === "ai" ? "来自 AI 建议" : "人工添加"} · ${item.required ? "必查" : "选查"}</small></div>${status(item.status === "done" ? "completed" : item.status === "todo" ? "warning" : "info", investigationStatus(item.status))}<p>${escapeHtml(item.result || "尚未填写结果")}</p></article>`;
}

function adoptionLabel(value) { return ({ accepted: "已采纳", partially_accepted: "部分采纳", rejected: "未采纳" })[value] || value; }
function investigationStatus(value) { return ({ todo: "待检查", done: "已确认", not_applicable: "不适用" })[value] || value; }

async function reloadExceptions() {
  const params = new URLSearchParams();
  if ($("#exceptionStatus").value) params.set("status", $("#exceptionStatus").value);
  if ($("#exceptionCurrency").value) params.set("currency", $("#exceptionCurrency").value);
  const result = await api(`/v1/tenants/${encodeURIComponent(state.session.tenantId)}/exceptions?${params}`);
  state.exceptions = result.data;
  renderExceptions();
}

function openCloseDialog(periodId) {
  const period = state.periods.find((item) => item.id === periodId);
  state.selectedPeriodId = periodId;
  const eligible = state.runs.filter((run) => run.status === "completed" && run.period_start === period.period_start && run.period_end === period.period_end);
  $("#closeRunChoices").innerHTML = eligible.map((run) => `<label class="choice"><input type="checkbox" name="runId" value="${escapeHtml(run.id)}" /><span><strong>${escapeHtml(run.id.slice(0, 8))} · ${run.stats?.groupCount || 0} 个匹配组</strong><small>${blockingCount(run)} 条当前阻断异常 · ${escapeHtml(shortHash(run.rule_sha256))}</small></span></label>`).join("") || `<div class="empty-detail"><strong>没有可选运行</strong><p>先完成与期间完全一致的对账运行。</p></div>`;
  $("#closeDialog").showModal();
}

async function openPeriodArchive(periodId) {
  const archive = await api(`/v1/tenants/${encodeURIComponent(state.session.tenantId)}/periods/${encodeURIComponent(periodId)}`);
  $("#periodArchiveTitle").textContent = `${archive.period_start} 至 ${archive.period_end} · v${archive.version}`;
  $("#periodArchiveSubtitle").textContent = archive.status === "locked" ? "此版本已锁定，以下内容来自不可变月结快照。" : "此版本仍开放，尚未形成不可变月结证据。";
  $("#periodArchiveContent").innerHTML = archive.status === "locked" ? renderLockedArchive(archive) : renderOpenArchive(archive);
  $("#periodArchiveDialog").showModal();
}

function renderLockedArchive(archive) {
  const snapshot = archive.snapshot || {};
  const totals = archiveTotals(snapshot.allocationTotals || []);
  return `<section class="archive-status locked"><div><span class="panel-kicker">LOCKED SNAPSHOT</span><strong>月结证据已封存</strong><p>manifest 由快照内容稳定序列化后计算，不是手工填写。</p></div>${status("locked", "已锁定")}</section>
    <section class="archive-section"><header><span>Manifest SHA-256</span><strong class="mono archive-hash">${escapeHtml(archive.manifest_sha256)}</strong></header><div class="archive-meta-grid">${[
      ["快照格式", snapshot.schemaVersion || "-"], ["锁定时间", formatDateTime(archive.locked_at)],
      ["创建者", shortIdentity(archive.created_by)], ["锁定者", shortIdentity(archive.closed_by)],
      ["审计水位", snapshot.auditHighwater || "-"], ["期间 ID", archive.id],
    ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}</div></section>
    <section class="archive-section"><header><span>按原币种分配总额</span><strong>${totals.length} 个币种</strong></header><div class="archive-total-grid">${totals.map((item) => `<div class="archive-total"><span>${escapeHtml(item.currency)}</span><div><small>来源侧</small><strong>${formatMinor(item.source, item.currency)}</strong></div><div><small>目标侧</small><strong>${formatMinor(item.target, item.currency)}</strong></div><b class="${item.source === item.target ? "balanced" : "unbalanced"}">${item.source === item.target ? "金额守恒" : "金额不一致"}</b></div>`).join("") || roleEmpty("快照没有分配总额")}</div></section>
    <section class="archive-section"><header><span>纳入的对账运行</span><strong>${(snapshot.runs || []).length} 次</strong></header><div class="archive-records">${(snapshot.runs || []).map((run) => `<article><div><span>运行 ${escapeHtml(String(run.id).slice(0, 8))}</span><strong>${escapeHtml(run.engineVersion || "-")}</strong></div><dl><dt>完成时间</dt><dd>${formatDateTime(run.completedAt)}</dd><dt>规则哈希</dt><dd class="mono">${escapeHtml(shortHash(run.ruleSha256))}</dd><dt>匹配组</dt><dd>${run.stats?.groupCount ?? 0}</dd><dt>阻断异常</dt><dd>${run.stats?.blockingExceptionCount ?? 0}</dd></dl></article>`).join("") || roleEmpty("没有纳入对账运行")}</div></section>
    <section class="archive-section"><header><span>输入文件指纹</span><strong>${(snapshot.files || []).length} 个文件</strong></header><div class="archive-files">${(snapshot.files || []).map((file) => `<div><span class="mono">${escapeHtml(String(file.id).slice(0, 8))}</span><strong>${file.rowCount} 行 · ${escapeHtml(file.parserVersion || "-")}</strong><small class="mono">${escapeHtml(shortHash(file.sha256))}</small></div>`).join("") || roleEmpty("没有输入文件")}</div></section>
    <details class="archive-json"><summary>查看原始 manifest JSON</summary><pre>${escapeHtml(JSON.stringify(snapshot, null, 2))}</pre></details>
    <div class="role-boundary"><strong>下载边界</strong><span>正式 XLSX、PDF、签名和归档下载尚未实现；当前可以在产品内检查完整快照。</span></div>`;
}

function renderOpenArchive(archive) {
  return `<section class="archive-status open"><div><span class="panel-kicker">OPEN VERSION</span><strong>当前版本尚未封存</strong><p>需要选择期间完全一致、已完成且没有开放阻断异常的对账运行，锁定后才会生成 manifest。</p></div>${status("open", "开放")}</section><section class="archive-section"><div class="archive-meta-grid">${[
    ["创建时间", formatDateTime(archive.created_at)], ["创建者", shortIdentity(archive.created_by)],
    ["上一个版本", archive.parent_period_id ? shortIdentity(archive.parent_period_id) : "无"], ["Manifest", "尚未生成"],
  ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}</div></section><div class="role-boundary"><strong>当前限制</strong><span>开放版本没有可验证快照。正式 XLSX、PDF 和归档下载同样尚未实现。</span></div>`;
}

function archiveTotals(values) {
  const grouped = new Map();
  for (const value of values) {
    const item = grouped.get(value.currency) || { currency: value.currency, source: 0n, target: 0n };
    if (value.role === "source") item.source += BigInt(value.allocatedMinor || 0);
    if (value.role === "target") item.target += BigInt(value.allocatedMinor || 0);
    grouped.set(value.currency, item);
  }
  return [...grouped.values()].sort((left, right) => left.currency.localeCompare(right.currency));
}

function shortIdentity(value) { return value ? `${String(value).slice(0, 8)}…${String(value).slice(-4)}` : "-"; }

function navigate(view) {
  const profile = getRoleProfile(state.session?.role);
  const target = canView(profile, view) ? view : "overview";
  $$(".view").forEach((item) => item.classList.toggle("active", item.id === target));
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === target));
  setPageIdentity(profile, target);
  $(".sidebar").classList.remove("open");
}

function setPageIdentity(profile, view) {
  if (view === "overview") {
    $("#pageEyebrow").textContent = profile.eyebrow;
    $("#pageTitle").textContent = profile.title;
    return;
  }
  $("#pageEyebrow").textContent = labels[view]?.[0] || profile.eyebrow;
  $("#pageTitle").textContent = profile.navigation[view] || labels[view]?.[1] || profile.title;
}

function showApp() { $("#loginView").classList.add("hidden"); $("#appShell").classList.remove("hidden"); }
function signOut(callApi = true) {
  if (callApi && state.session) api("/v1/sessions/current", { method: "DELETE" }).catch(() => {});
  state.session = null; state.workspace = null; sessionStorage.removeItem(sessionKey);
  $$(".view").forEach((item) => item.classList.toggle("active", item.id === "overview"));
  $(".sidebar").classList.remove("open");
  $("#appShell").classList.add("hidden"); $("#loginView").classList.remove("hidden");
}
function setBusy(value) { $("#refreshButton").disabled = value; }

function notify(message, error = false) {
  const toast = $("#toast"); toast.textContent = message; toast.classList.toggle("error", error); toast.classList.add("show");
  clearTimeout(notify.timer); notify.timer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function status(value, text) {
  const style = ["completed", "committed", "locked", "resolved", "approved"].includes(value) ? "good" : ["blocking", "failed", "rejected"].includes(value) ? "bad" : ["running", "open", "investigating"].includes(value) ? "info" : "warn";
  return `<span class="status ${style}">${escapeHtml(text)}</span>`;
}
function formatMinor(value, currency) { const amount = BigInt(value || 0); const sign = amount < 0n ? "-" : ""; const absolute = amount < 0n ? -amount : amount; return `${sign}${escapeHtml(currency)} ${(absolute / 100n).toString()}.${(absolute % 100n).toString().padStart(2, "0")}`; }
function formatDateTime(value) { return value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "-"; }
function bytes(value) { const size = Number(value || 0); return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`; }
function shortHash(value) { return value ? `${String(value).slice(0, 10)}…${String(value).slice(-6)}` : "-"; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function emptyRow(columns, text) { return `<tr><td class="empty-row" colspan="${columns}">${escapeHtml(text)}</td></tr>`; }
function runStatus(value) { return ({ completed: "已完成", running: "运行中", failed: "失败" })[value] || value; }
function blockingCount(run) { return Number(run.open_blocking_exception_count ?? run.stats?.blockingExceptionCount ?? 0); }
function batchLabel(value) { return ({ committed: "已提交", preflight_failed: "预检失败", failed: "失败", uploaded: "已上传", ready: "待提交" })[value] || value; }
function exceptionLabel(value) { return ({ unmatched_source: "来源记录未匹配", unmatched_target: "目标记录未匹配", ambiguous_exact: "精确候选存在歧义", ambiguous_combination: "组合候选存在歧义" })[value] || value; }
function workflowStatus(value) { return ({ open: "待领取", investigating: "调查中", pending_review: "待复核", resolved: "已解决" })[value] || value; }
function resolutionLabel(value) { return ({ timing_difference: "到账时间差", fee_difference: "手续费差异", duplicate_record: "重复记录", manual_link: "人工关联", source_correction: "来源数据更正", other: "其他" })[value] || value; }
function decisionLabel(value) { return ({ approved: "已批准", rejected: "已驳回" })[value] || value; }
function confidenceLabel(value) { return ({ low: "低置信度", medium: "中置信度", high: "高置信度" })[value] || "置信度未知"; }
function matchType(value) { return ({ one_to_one: "一对一", many_to_one: "多对一", one_to_many: "一对多", partial: "部分匹配" })[value] || value; }
function detailText(item) { if (item.exception_type === "unmatched_source") return "规则范围内没有找到金额、币种与日期窗口均满足的目标记录。"; if (item.exception_type === "unmatched_target") return "目标侧出现了没有对应来源记录的资金流水，需要确认漏单、跨期或来源范围。"; return `引擎拒绝自动选择候选。候选记录：${(item.details?.candidateIds || []).join(", ") || "未提供"}`; }
function messageFor(error) { return ({ INVALID_CREDENTIALS: "邮箱或密码不正确", WORKSPACE_REQUIRED: "请选择工作区", INVALID_FILTER: "筛选条件无效", PERIOD_LOCKED: "该业务日期属于已锁定期间", CLOSE_BLOCKED: "仍有未获批准的阻断异常，不能锁定期间", INVALID_RUN_SET: "选择的运行不能组成有效月结快照", INVALID_RULE: "对账规则配置无效", INVALID_NOTE: "备注需填写 2 至 2000 个字", INVALID_AI_ADOPTION_REASON: "不采纳时请填写至少 2 个字的原因", AI_PARTIAL_STEPS_REQUIRED: "部分采纳必须选择至少一步，并保留至少一步不采纳", AI_ADOPTION_EXISTS: "这条 AI 建议已经记录过使用结果", INVALID_INVESTIGATION_ITEM: "检查项需填写 2 至 500 个字", INVALID_INVESTIGATION_RESULT: "完成或标记不适用时，请填写检查结果或原因", INVESTIGATION_INCOMPLETE: "还有必查项目未完成，暂时不能提交复核", INVALID_SUMMARY: "调查结论需填写 10 至 2000 个字", INVALID_REASON: "驳回原因需填写至少 10 个字", INVALID_REPLACEMENT_RUN: "涉及金额或匹配变化时，请选择同期间、无阻断异常的新对账运行", INVALID_EXCEPTION_STATE: "异常当前状态不允许此操作，请刷新后重试", INVALID_ASSIGNEE: "只能分派给当前工作区的操作员", EXCEPTION_ALREADY_ASSIGNED: "该异常已被其他操作员领取", STALE_EXCEPTION: "该异常刚刚被他人更新，请刷新后重试", SELF_APPROVAL_FORBIDDEN: "提交人不能批准自己的处理方案", AI_NOT_CONFIGURED: "AI 调查助手尚未配置", AI_PROVIDER_TIMEOUT: "AI 服务响应超时，请稍后重试", AI_PROVIDER_UNAVAILABLE: "暂时无法连接 AI 服务", AI_PROVIDER_AUTH_FAILED: "AI 服务鉴权失败，请检查本机配置", AI_PROVIDER_ERROR: "AI 服务暂时返回错误", AI_PROVIDER_INVALID_RESPONSE: "AI 返回内容未通过安全格式校验", FORBIDDEN: "当前角色没有执行此操作的权限", INTERNAL_ERROR: "服务发生内部错误，请查看请求日志" })[error.code] || error.code || error.message; }

async function loadDemoAccounts() {
  try {
    const response = await fetch("/v1/demo-accounts");
    if (!response.ok) return;
    demoAccounts = (await response.json()).data || [];
    if (!demoAccounts.length) return;
    $("#quickDemo").classList.remove("hidden");
    $("#quickDemoAccounts").innerHTML = demoAccounts.map((account) => `<button class="quick-demo-account" type="button" data-demo-role="${escapeHtml(account.role)}"><span class="quick-demo-role ${escapeHtml(account.role)}">${escapeHtml(account.label.slice(0, 1))}</span><span><strong>${escapeHtml(account.label)}</strong><small>${escapeHtml(account.description)}</small></span><b>填入</b></button>`).join("");
  } catch { /* Demo mode is optional; keep the normal login form. */ }
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const credentials = { email: $("#emailInput").value.trim(), password: $("#passwordInput").value };
  try { await login(credentials); }
  catch (error) {
    if (error.code === "WORKSPACE_REQUIRED") {
      state.pendingCredentials = credentials;
      $("#workspaceChoices").innerHTML = error.metadata.workspaces.map((item) => `<button class="choice" type="button" data-tenant-id="${escapeHtml(item.tenantId)}"><span><strong>${escapeHtml(item.tenantName)}</strong><small>${escapeHtml(roleLabels[item.role] || item.role)}</small></span></button>`).join("");
      $("#workspaceDialog").showModal();
    } else notify(messageFor(error), true);
  }
});

$("#workspaceChoices").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-tenant-id]"); if (!button) return;
  try { await login(state.pendingCredentials, button.dataset.tenantId); } catch (error) { notify(messageFor(error), true); }
});
$("#quickDemoToggle").addEventListener("click", () => {
  const panel = $("#quickDemoPanel");
  const open = panel.hidden;
  panel.hidden = !open;
  $("#quickDemoToggle").setAttribute("aria-expanded", String(open));
  $("#quickDemoToggle b").textContent = open ? "×" : "＋";
});
$("#quickDemoClose").addEventListener("click", () => $("#quickDemoToggle").click());
$("#quickDemoAccounts").addEventListener("click", (event) => {
  const button = event.target.closest("[data-demo-role]"); if (!button) return;
  const account = demoAccounts.find((item) => item.role === button.dataset.demoRole); if (!account) return;
  $("#emailInput").value = account.email;
  $("#passwordInput").value = account.password;
  $("#quickDemoPanel").hidden = true;
  $("#quickDemoToggle").setAttribute("aria-expanded", "false");
  $("#quickDemoToggle b").textContent = "＋";
  $("#emailInput").focus();
});
$("#logoutButton").addEventListener("click", () => signOut());
$("#refreshButton").addEventListener("click", loadAll);
$("#menuButton").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
$("#mainNav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-view]");
  if (button) navigate(button.dataset.view);
});
$("#roleHome").addEventListener("click", (event) => {
  const button = event.target.closest("[data-role-view]");
  if (button) navigate(button.dataset.roleView);
});
$$('#adminHome [data-view]').forEach((button) => button.addEventListener("click", () => navigate(button.dataset.view)));
$$('[data-scenario]').forEach((button) => button.addEventListener("click", () => {
  $$(".scenario-tab").forEach((item) => item.classList.toggle("active", item === button));
  $$(".scenario-view").forEach((item) => item.classList.toggle("active", item.id === `${button.dataset.scenario}Scenario`));
}));
$("#matchedCaseList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-case-id]"); if (!button) return;
  state.selectedCaseId = button.dataset.caseId;
  $$(".case-item").forEach((item) => item.classList.toggle("active", item === button));
  const selected = state.moneyFlow.cases.find((item) => item.id === state.selectedCaseId);
  if (selected) renderTraceDetail(selected);
});
for (const container of [$("#overviewExceptions"), $("#blockedStory")]) container.addEventListener("click", (event) => {
  const button = event.target.closest("[data-overview-exception]"); if (!button) return;
  navigate("exceptions"); showExceptionDetail(button.dataset.overviewException).catch((error) => notify(messageFor(error), true));
});

$("#uploadFile").addEventListener("change", () => { $("#uploadFilename").textContent = $("#uploadFile").files[0]?.name || "选择文件"; });
$("#uploadForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const file = $("#uploadFile").files[0]; if (!file) return;
  const form = new FormData(); form.append("file", file);
  try { const result = await api(`/v1/tenants/${state.session.tenantId}/sources/${$("#uploadSource").value}/import-batches`, { method: "POST", body: form }); notify(result.replayed ? "该文件已导入，返回原批次" : "文件通过预检并已提交"); event.target.reset(); $("#uploadFilename").textContent = "选择文件"; await loadAll(); }
  catch (error) { notify(messageFor(error), true); }
});

$("#toggleRunForm").addEventListener("click", () => $("#runForm").classList.remove("hidden"));
$("#cancelRun").addEventListener("click", () => $("#runForm").classList.add("hidden"));
$("#runForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if ($("#runSource").value === $("#runTarget").value) return notify("来源和目标不能相同", true);
  const body = { periodStart: $("#runStart").value, periodEnd: $("#runEnd").value, rule: { sourceTypes: [$("#runSource").value], targetTypes: [$("#runTarget").value], sourceAmountField: $("#sourceAmountField").value, targetAmountField: $("#targetAmountField").value, allowPartial: $("#allowPartial").checked, dateWindowDays: 7 } };
  try { const result = await api(`/v1/tenants/${state.session.tenantId}/recon-runs`, { method: "POST", headers: { "idempotency-key": `console-${Date.now()}-${crypto.randomUUID()}` }, body }); notify(result.status === "completed" ? "对账运行已完成" : "对账运行未完成"); $("#runForm").classList.add("hidden"); await loadAll(); await showRunDetail(result.runId); }
  catch (error) { notify(messageFor(error), true); }
});

$("#runRows").addEventListener("click", (event) => { const row = event.target.closest("[data-run-id]"); if (row) showRunDetail(row.dataset.runId).catch((error) => notify(messageFor(error), true)); });
$("#exceptionRows").addEventListener("click", (event) => { const row = event.target.closest("[data-exception-id]"); if (row) showExceptionDetail(row.dataset.exceptionId).catch((error) => notify(messageFor(error), true)); });
$("#exceptionStatus").addEventListener("change", () => reloadExceptions().catch((error) => notify(messageFor(error), true)));
$("#exceptionCurrency").addEventListener("change", () => reloadExceptions().catch((error) => notify(messageFor(error), true)));
$("#exceptionDetail").addEventListener("click", async (event) => {
  const claim = event.target.closest("[data-claim-exception]");
  const release = event.target.closest("[data-release-exception]");
  const aiSuggestion = event.target.closest("[data-generate-ai-suggestion]");
  if (!claim && !release && !aiSuggestion) return;
  try {
    if (aiSuggestion) {
      aiSuggestion.disabled = true;
      aiSuggestion.textContent = "正在生成";
      await exceptionMutation("ai-suggestions", {});
      notify("AI 调查建议已生成并写入审计记录");
      await refreshSelectedException();
      return;
    }
    await exceptionMutation(release ? "release" : "claim", { expectedVersion: currentWorkflowVersion() });
    notify(release ? "异常已退回共享队列" : "异常已领取，其他操作员仍可查看");
    await refreshSelectedException();
  } catch (error) { notify(messageFor(error), true); }
});
$("#exceptionDetail").addEventListener("change", (event) => {
  const decision = event.target.closest("[data-adopt-ai-suggestion] select[name='decision']");
  if (!decision) return;
  const form = decision.closest("form");
  const mode = decision.value;
  for (const checkbox of form.querySelectorAll("input[name='selectedSteps']")) {
    checkbox.disabled = mode !== "partially_accepted";
    checkbox.checked = mode === "accepted";
  }
  const reason = form.querySelector("textarea[name='reason']");
  reason.disabled = mode !== "rejected";
  reason.required = mode === "rejected";
  if (mode !== "rejected") reason.value = "";
});
$("#exceptionDetail").addEventListener("submit", async (event) => {
  const form = event.target.closest("form"); if (!form) return;
  event.preventDefault();
  const data = new FormData(form);
  try {
    if (form.matches("[data-adopt-ai-suggestion]")) {
      await exceptionMutation(`ai-suggestions/${encodeURIComponent(form.dataset.aiAuditId)}/adoption`, {
        decision: data.get("decision"), selectedSteps: data.getAll("selectedSteps"),
        reason: data.get("reason"), expectedVersion: currentWorkflowVersion(),
      });
      notify("AI 建议使用结果已记录，选中的步骤已加入调查清单");
      await refreshSelectedException();
      return;
    }
    if (form.matches("[data-add-investigation-item]")) {
      await exceptionMutation("investigation-items", {
        title: data.get("title"), required: data.get("required") === "on", expectedVersion: currentWorkflowVersion(),
      });
      notify("人工检查项已加入调查清单");
      await refreshSelectedException();
      return;
    }
    if (form.matches("[data-update-investigation-item]")) {
      await api(`/v1/tenants/${encodeURIComponent(state.session.tenantId)}/exceptions/${encodeURIComponent(state.selectedExceptionId)}/investigation-items/${encodeURIComponent(form.dataset.itemId)}`, {
        method: "PATCH", body: { status: data.get("status"), result: data.get("result"), expectedVersion: currentWorkflowVersion() },
      });
      notify("调查结果已保存");
      await refreshSelectedException();
      return;
    }
    if (form.matches("[data-assign-exception]")) await exceptionMutation("claim", { assigneeId: data.get("assigneeId"), expectedVersion: currentWorkflowVersion() });
    if (form.matches("[data-add-note]")) await exceptionMutation("notes", { body: data.get("body"), expectedVersion: currentWorkflowVersion() });
    if (form.matches("[data-submit-resolution]")) {
      const financialImpact = data.get("financialImpact") === "on";
      await exceptionMutation("resolution-proposals", { resolutionType: data.get("resolutionType"), summary: data.get("summary"), financialImpact, replacementRunId: financialImpact ? data.get("replacementRunId") || null : null, expectedVersion: currentWorkflowVersion() });
    }
    if (form.matches("[data-decide-resolution]")) await exceptionMutation("resolution-decisions", { decision: event.submitter?.value, reason: data.get("reason"), expectedVersion: currentWorkflowVersion() });
    notify(form.matches("[data-decide-resolution]") ? (event.submitter?.value === "approved" ? "处理方案已批准，月结阻断已解除" : "处理方案已驳回并退回原负责人") : form.matches("[data-submit-resolution]") ? "处理方案已提交复核" : form.matches("[data-add-note]") ? "调查备注已追加" : "异常已分派");
    await refreshSelectedException();
  } catch (error) { notify(messageFor(error), true); }
});

async function exceptionMutation(action, body) {
  return api(`/v1/tenants/${encodeURIComponent(state.session.tenantId)}/exceptions/${encodeURIComponent(state.selectedExceptionId)}/${action}`, { method: "POST", body });
}
function currentWorkflowVersion() { return Number($("#exceptionDetail .workflow-actions")?.dataset.workflowVersion); }
async function refreshSelectedException() { const id = state.selectedExceptionId; await loadAll(); await showExceptionDetail(id); }

$("#togglePeriodForm").addEventListener("click", () => $("#periodForm").classList.remove("hidden"));
$("#cancelPeriod").addEventListener("click", () => $("#periodForm").classList.add("hidden"));
$("#periodForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try { await api(`/v1/tenants/${state.session.tenantId}/periods`, { method: "POST", body: { periodStart: $("#periodStart").value, periodEnd: $("#periodEnd").value } }); notify("会计期间已创建"); $("#periodForm").classList.add("hidden"); await loadAll(); }
  catch (error) { notify(messageFor(error), true); }
});
$("#periodRows").addEventListener("click", (event) => {
  const closeButton = event.target.closest("[data-close-period]");
  if (closeButton) return openCloseDialog(closeButton.dataset.closePeriod);
  const archiveButton = event.target.closest("[data-period-archive]");
  const row = event.target.closest("[data-period-id]");
  const periodId = archiveButton?.dataset.periodArchive || row?.dataset.periodId;
  if (periodId) openPeriodArchive(periodId).catch((error) => notify(messageFor(error), true));
});
$$('[data-close-dialog]').forEach((button) => button.addEventListener("click", () => $("#closeDialog").close()));
$$('[data-archive-dialog]').forEach((button) => button.addEventListener("click", () => $("#periodArchiveDialog").close()));
$("#closeForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const runIds = [...new FormData(event.target).getAll("runId")]; if (!runIds.length) return notify("至少选择一次已完成运行", true);
  try { await api(`/v1/tenants/${state.session.tenantId}/periods/${state.selectedPeriodId}/close`, { method: "POST", body: { runIds } }); $("#closeDialog").close(); notify("期间已锁定并生成 manifest 哈希"); await loadAll(); }
  catch (error) { notify(messageFor(error), true); }
});

loadDemoAccounts();
if (state.session) { showApp(); loadAll(); }
