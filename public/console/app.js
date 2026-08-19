const sessionKey = "hyperrecon-console-session";
const state = {
  session: readSession(),
  pendingCredentials: null,
  workspace: null,
  sources: [], imports: [], runs: [], exceptions: [], periods: [], audit: [],
  selectedPeriodId: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const labels = {
  overview: ["资金运营", "作业总览"], sources: ["数据治理", "数据接入"], runs: ["确定性引擎", "对账运行"],
  exceptions: ["人工工作流", "异常队列"], periods: ["财务控制", "月结中心"], audit: ["可追溯性", "审计记录"],
};
const sourceLabels = { shopify: "Shopify", stripe: "Stripe", paypal: "PayPal", wise: "Wise", bank: "银行" };
const roleLabels = { admin: "管理员", reviewer: "复核人", operator: "操作员", auditor: "审计只读" };
const actionLabels = {
  "tenant.bootstrapped": "工作区初始化", "session.created": "用户登录", "import_batch.committed": "导入批次提交",
  "recon_run.completed": "对账运行完成", "recon_run.failed": "对账运行失败", "close_period.created": "月结期间创建",
  "close_period.locked": "月结期间锁定", "close_period.reopened": "月结重新开账", "demo.seeded": "虚构样本初始化",
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
  try {
    const [workspace, sources, imports, runs, exceptions, periods, audit] = await Promise.all([
      api(`${base}/workspace`), api(`${base}/sources`), api(`${base}/import-batches`), api(`${base}/recon-runs`),
      api(`${base}/exceptions?status=open`), api(`${base}/periods`),
      ["admin", "auditor"].includes(state.session.role) ? api(`${base}/audit-events`) : Promise.resolve({ data: [] }),
    ]);
    state.workspace = workspace;
    state.sources = sources.data;
    state.imports = imports.data;
    state.runs = runs.data;
    state.exceptions = exceptions.data;
    state.periods = periods.data;
    state.audit = audit.data;
    renderAll();
    $("#apiStatus").textContent = "连接正常";
  } catch (error) {
    $("#apiStatus").textContent = "连接失败";
    notify(messageFor(error), true);
  } finally { setBusy(false); }
}

function renderAll() {
  renderIdentity(); renderOverview(); renderSources(); renderImports(); renderRuns(); renderExceptions(); renderPeriods(); renderAudit(); renderSelectors();
}

function renderIdentity() {
  $("#workspaceIdentity").innerHTML = `<strong>${escapeHtml(state.workspace?.tenant?.name || state.session.tenantName)}</strong><span>${escapeHtml(roleLabels[state.session.role] || state.session.role)}</span>`;
}

function renderOverview() {
  const counts = state.workspace.counts;
  const latestPeriod = state.periods[0];
  $("#periodBandStatus").innerHTML = latestPeriod ? status(latestPeriod.status, latestPeriod.status === "locked" ? "已锁定" : "待月结") : status("warning", "尚未建期");
  $("#metricStrip").innerHTML = [
    ["已配置来源", counts.source_count, "渠道与银行"], ["已提交批次", counts.import_count, "原子导入"],
    ["标准记录", counts.record_count, "保留原始血缘"], ["已完成运行", counts.run_count, "确定性执行"],
    ["开放异常", counts.open_exception_count, counts.open_exception_count ? "阻断月结" : "无阻断项"],
  ].map(([name, value, note]) => `<div class="metric"><span>${name}</span><strong>${value}</strong><small>${note}</small></div>`).join("");
  $("#currencyLegend").innerHTML = state.workspace.currencies.map((item) => `<span class="currency-chip">${escapeHtml(item.currency)}<b>${item.record_count} 条</b></span>`).join("") || `<span class="currency-chip">暂无币种</span>`;
  const steps = [
    ["01 来源", counts.source_count, "已配置数据入口"], ["02 摄取", counts.import_count, "文件已提交"],
    ["03 标准化", counts.record_count, "标准财务记录"], ["04 对账", counts.run_count, "已完成运行"],
    ["05 月结", counts.locked_period_count, counts.open_exception_count ? `${counts.open_exception_count} 条异常阻断` : "可进入锁定检查"],
  ];
  $("#flowRail").innerHTML = steps.map((item, index) => `<div class="flow-step ${index === 4 && counts.open_exception_count ? "blocked" : ""}"><span>${item[0]}</span><strong>${item[1]}</strong><small>${item[2]}</small></div>`).join("");
  $("#overviewRunRows").innerHTML = state.runs.slice(0, 5).map(runRow).join("") || emptyRow(5, "暂无对账运行");
  $("#overviewExceptions").innerHTML = state.exceptions.slice(0, 5).map((item) => `<div class="exception-item"><div><strong>${escapeHtml(exceptionLabel(item.exception_type))}</strong><small>${escapeHtml(item.external_id || "无外部流水号")} · ${escapeHtml(sourceLabels[item.source_type] || item.source_type || "未知来源")}</small></div>${item.currency && item.amount_minor !== null ? `<b>${formatMinor(item.amount_minor, item.currency)}</b>` : status(item.severity, "需调查")}</div>`).join("") || `<div class="empty-detail"><strong>没有开放异常</strong><p>当前运行未发现阻断项。</p></div>`;
  $("#exceptionBadge").textContent = counts.open_exception_count;
  $("#exceptionBadge").style.display = counts.open_exception_count ? "grid" : "none";
}

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

function runRow(item) { return `<tr data-selectable data-run-id="${escapeHtml(item.id)}"><td><strong>${escapeHtml(item.period_start)} 至 ${escapeHtml(item.period_end)}</strong><small>${escapeHtml(item.id.slice(0, 8))}</small></td><td>${status(item.status, runStatus(item.status))}</td><td>${item.stats?.groupCount ?? 0}</td><td>${item.stats?.blockingExceptionCount ?? 0}</td><td>${formatDateTime(item.completed_at)}</td></tr>`; }
function runCells(item) { return `<td><strong>${escapeHtml(item.period_start)} 至 ${escapeHtml(item.period_end)}</strong></td><td>${status(item.status, runStatus(item.status))}</td><td>${item.stats?.groupCount ?? 0}</td><td>${item.stats?.blockingExceptionCount ?? 0}</td><td class="mono">${escapeHtml(shortHash(item.rule_sha256))}</td>`; }

function renderExceptions() {
  $("#exceptionRows").innerHTML = state.exceptions.map((item) => `<tr data-selectable data-exception-id="${escapeHtml(item.id)}"><td>${status(item.severity, item.severity === "blocking" ? "阻断" : "警告")}</td><td><strong>${escapeHtml(item.external_id || "无外部流水号")}</strong><small>${escapeHtml(item.id.slice(0, 8))}</small></td><td>${escapeHtml(sourceLabels[item.source_type] || item.source_type || "未知")}</td><td>${escapeHtml(exceptionLabel(item.exception_type))}</td><td>${item.currency && item.amount_minor !== null ? formatMinor(item.amount_minor, item.currency) : "-"}</td><td>${escapeHtml(item.business_date || "-")}</td></tr>`).join("") || emptyRow(6, "当前筛选下没有异常");
}

function renderPeriods() {
  $("#periodRows").innerHTML = state.periods.map((item) => `<tr><td><strong>${escapeHtml(item.period_start)} 至 ${escapeHtml(item.period_end)}</strong><small>${item.parent_period_id ? "重新开账版本" : "初始版本"}</small></td><td>v${item.version}</td><td>${status(item.status, item.status === "locked" ? "已锁定" : "开放")}</td><td>${formatDateTime(item.locked_at)}</td><td class="mono">${item.manifest_sha256 ? escapeHtml(shortHash(item.manifest_sha256)) : "尚未生成"}</td><td>${item.status === "open" && ["reviewer", "admin"].includes(state.session.role) ? `<button class="button ghost" data-close-period="${escapeHtml(item.id)}">锁定检查</button>` : "-"}</td></tr>`).join("") || emptyRow(6, "尚未创建会计期间");
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

function showExceptionDetail(id) {
  const item = state.exceptions.find((value) => value.id === id);
  if (!item) return;
  $("#exceptionDetail").innerHTML = `<div class="detail-head"><span>${escapeHtml(item.severity === "blocking" ? "阻断异常" : "警告")}</span><h3>${escapeHtml(item.external_id || item.id)}</h3></div><div class="detail-section"><h4>异常信息</h4><div class="detail-grid"><div><span>类型</span><strong>${escapeHtml(exceptionLabel(item.exception_type))}</strong></div><div><span>状态</span><strong>${escapeHtml(item.status)}</strong></div><div><span>来源</span><strong>${escapeHtml(sourceLabels[item.source_type] || item.source_type || "未知")}</strong></div><div><span>金额</span><strong>${item.currency && item.amount_minor !== null ? formatMinor(item.amount_minor, item.currency) : "-"}</strong></div><div><span>业务日期</span><strong>${escapeHtml(item.business_date || "-")}</strong></div><div><span>记录类型</span><strong>${escapeHtml(item.record_type || "-")}</strong></div></div></div><div class="detail-section"><h4>引擎说明</h4><p>${escapeHtml(detailText(item))}</p></div><div class="scope-band"><strong>处理受限</strong><span>负责人、备注、解决方案和四眼审批尚未实现，当前只能查看证据。</span></div>`;
}

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
  $("#closeRunChoices").innerHTML = eligible.map((run) => `<label class="choice"><input type="checkbox" name="runId" value="${escapeHtml(run.id)}" /><span><strong>${escapeHtml(run.id.slice(0, 8))} · ${run.stats?.groupCount || 0} 个匹配组</strong><small>${run.stats?.blockingExceptionCount || 0} 条阻断异常 · ${escapeHtml(shortHash(run.rule_sha256))}</small></span></label>`).join("") || `<div class="empty-detail"><strong>没有可选运行</strong><p>先完成与期间完全一致的对账运行。</p></div>`;
  $("#closeDialog").showModal();
}

function navigate(view) {
  $$(".view").forEach((item) => item.classList.toggle("active", item.id === view));
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $("#pageEyebrow").textContent = labels[view][0];
  $("#pageTitle").textContent = labels[view][1];
  $(".sidebar").classList.remove("open");
}

function showApp() { $("#loginView").classList.add("hidden"); $("#appShell").classList.remove("hidden"); }
function signOut(callApi = true) {
  if (callApi && state.session) api("/v1/sessions/current", { method: "DELETE" }).catch(() => {});
  state.session = null; state.workspace = null; sessionStorage.removeItem(sessionKey);
  $("#appShell").classList.add("hidden"); $("#loginView").classList.remove("hidden");
}
function setBusy(value) { $("#refreshButton").disabled = value; }

function notify(message, error = false) {
  const toast = $("#toast"); toast.textContent = message; toast.classList.toggle("error", error); toast.classList.add("show");
  clearTimeout(notify.timer); notify.timer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function status(value, text) {
  const style = ["completed", "committed", "locked"].includes(value) ? "good" : ["blocking", "failed"].includes(value) ? "bad" : ["running", "open"].includes(value) ? "info" : "warn";
  return `<span class="status ${style}">${escapeHtml(text)}</span>`;
}
function formatMinor(value, currency) { const amount = BigInt(value || 0); const sign = amount < 0n ? "-" : ""; const absolute = amount < 0n ? -amount : amount; return `${sign}${escapeHtml(currency)} ${(absolute / 100n).toString()}.${(absolute % 100n).toString().padStart(2, "0")}`; }
function formatDateTime(value) { return value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "-"; }
function bytes(value) { const size = Number(value || 0); return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`; }
function shortHash(value) { return value ? `${String(value).slice(0, 10)}…${String(value).slice(-6)}` : "-"; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function emptyRow(columns, text) { return `<tr><td class="empty-row" colspan="${columns}">${escapeHtml(text)}</td></tr>`; }
function runStatus(value) { return ({ completed: "已完成", running: "运行中", failed: "失败" })[value] || value; }
function batchLabel(value) { return ({ committed: "已提交", preflight_failed: "预检失败", failed: "失败", uploaded: "已上传", ready: "待提交" })[value] || value; }
function exceptionLabel(value) { return ({ unmatched_source: "来源记录未匹配", unmatched_target: "目标记录未匹配", ambiguous_exact: "精确候选存在歧义", ambiguous_combination: "组合候选存在歧义" })[value] || value; }
function matchType(value) { return ({ one_to_one: "一对一", many_to_one: "多对一", one_to_many: "一对多", partial: "部分匹配" })[value] || value; }
function detailText(item) { if (item.exception_type === "unmatched_source") return "规则范围内没有找到金额、币种与日期窗口均满足的目标记录。"; if (item.exception_type === "unmatched_target") return "目标侧出现了没有对应来源记录的资金流水，需要确认漏单、跨期或来源范围。"; return `引擎拒绝自动选择候选。候选记录：${(item.details?.candidateIds || []).join(", ") || "未提供"}`; }
function messageFor(error) { return ({ INVALID_CREDENTIALS: "邮箱或密码不正确", WORKSPACE_REQUIRED: "请选择工作区", INVALID_FILTER: "筛选条件无效", PERIOD_LOCKED: "该业务日期属于已锁定期间", CLOSE_BLOCKED: "仍有开放阻断异常，不能锁定期间", INVALID_RUN_SET: "选择的运行不能组成有效月结快照", INVALID_RULE: "对账规则配置无效", FORBIDDEN: "当前角色没有执行此操作的权限", INTERNAL_ERROR: "服务发生内部错误，请查看请求日志" })[error.code] || error.code || error.message; }

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
$("#logoutButton").addEventListener("click", () => signOut());
$("#refreshButton").addEventListener("click", loadAll);
$("#menuButton").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
$$('[data-view]').forEach((button) => button.addEventListener("click", () => navigate(button.dataset.view)));

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
$("#overviewRunRows").addEventListener("click", (event) => { const row = event.target.closest("[data-run-id]"); if (row) showRunDetail(row.dataset.runId).catch((error) => notify(messageFor(error), true)); });
$("#exceptionRows").addEventListener("click", (event) => { const row = event.target.closest("[data-exception-id]"); if (row) showExceptionDetail(row.dataset.exceptionId); });
$("#exceptionStatus").addEventListener("change", () => reloadExceptions().catch((error) => notify(messageFor(error), true)));
$("#exceptionCurrency").addEventListener("change", () => reloadExceptions().catch((error) => notify(messageFor(error), true)));

$("#togglePeriodForm").addEventListener("click", () => $("#periodForm").classList.remove("hidden"));
$("#cancelPeriod").addEventListener("click", () => $("#periodForm").classList.add("hidden"));
$("#periodForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try { await api(`/v1/tenants/${state.session.tenantId}/periods`, { method: "POST", body: { periodStart: $("#periodStart").value, periodEnd: $("#periodEnd").value } }); notify("会计期间已创建"); $("#periodForm").classList.add("hidden"); await loadAll(); }
  catch (error) { notify(messageFor(error), true); }
});
$("#periodRows").addEventListener("click", (event) => { const button = event.target.closest("[data-close-period]"); if (button) openCloseDialog(button.dataset.closePeriod); });
$$('[data-close-dialog]').forEach((button) => button.addEventListener("click", () => $("#closeDialog").close()));
$("#closeForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const runIds = [...new FormData(event.target).getAll("runId")]; if (!runIds.length) return notify("至少选择一次已完成运行", true);
  try { await api(`/v1/tenants/${state.session.tenantId}/periods/${state.selectedPeriodId}/close`, { method: "POST", body: { runIds } }); $("#closeDialog").close(); notify("期间已锁定并生成 manifest 哈希"); await loadAll(); }
  catch (error) { notify(messageFor(error), true); }
});

if (state.session) { showApp(); loadAll(); }
