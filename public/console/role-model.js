export const roleProfiles = Object.freeze({
  admin: profile({
    role: "admin", eyebrow: "跨境资金控制", title: "资金驾驶舱", homeVariant: "admin",
    views: ["overview", "sources", "runs", "exceptions", "periods", "audit"],
    navigation: { overview: "资金驾驶舱", sources: "数据接入", runs: "对账运行", exceptions: "异常与调查建议", periods: "月结中心", audit: "审计记录" },
    capabilities: ["upload", "run", "exception_assign", "exception_review", "exception_note", "period_create", "period_close", "audit_read"], reads: ["periods", "audit", "operators"],
  }),
  operator: profile({
    role: "operator", eyebrow: "日常资金作业", title: "我的作业台", homeVariant: "operator",
    views: ["overview", "sources", "runs", "exceptions"],
    navigation: { overview: "我的作业", sources: "数据接入", runs: "对账任务", exceptions: "调查队列" },
    capabilities: ["upload", "run", "exception_claim", "exception_submit", "exception_note", "ai_suggest"], reads: [],
  }),
  reviewer: profile({
    role: "reviewer", eyebrow: "财务复核控制", title: "复核与月结", homeVariant: "reviewer",
    views: ["overview", "runs", "exceptions", "periods"],
    navigation: { overview: "复核中心", runs: "对账结果", exceptions: "异常复核", periods: "月结中心" },
    capabilities: ["exception_review", "exception_note", "ai_suggest", "period_create", "period_close"], reads: ["periods"],
  }),
  auditor: profile({
    role: "auditor", eyebrow: "独立审计视角", title: "审计证据中心", homeVariant: "auditor",
    views: ["overview", "runs", "periods", "audit"],
    navigation: { overview: "审计总览", runs: "对账证据", periods: "月结档案", audit: "审计日志" },
    capabilities: ["audit_read"], reads: ["periods", "audit"],
  }),
});

const fallbackProfile = profile({
  role: "unknown", eyebrow: "受限访问", title: "只读概览", homeVariant: "auditor",
  views: ["overview"], navigation: { overview: "只读概览" }, capabilities: [], reads: [],
});

export function getRoleProfile(role) { return roleProfiles[role] || fallbackProfile; }
export function can(profileValue, capability) { return profileValue.capabilities.includes(capability); }
export function canRead(profileValue, resource) { return profileValue.reads.includes(resource); }
export function canView(profileValue, view) { return profileValue.views.includes(view); }

function profile(value) {
  return Object.freeze({
    ...value,
    views: Object.freeze([...value.views]),
    navigation: Object.freeze({ ...value.navigation }),
    capabilities: Object.freeze([...value.capabilities]),
    reads: Object.freeze([...value.reads]),
  });
}
