export const demoAccounts = Object.freeze([
  Object.freeze({ role: "admin", label: "管理员", description: "完整权限，可导入、对账、月结和审计", email: "demo@hyperrecon.local", password: "HyperRecon-Demo-2026!" }),
  Object.freeze({ role: "operator", label: "操作员", description: "数据接入、对账运行、异常调查与方案提交", email: "operator@hyperrecon.local", password: "HyperRecon-Operator-2026!" }),
  Object.freeze({ role: "reviewer", label: "复核人", description: "批准或驳回异常方案并执行月结", email: "reviewer@hyperrecon.local", password: "HyperRecon-Reviewer-2026!" }),
  Object.freeze({ role: "auditor", label: "审计只读", description: "只读查看资金证据和审计记录", email: "auditor@hyperrecon.local", password: "HyperRecon-Auditor-2026!" }),
]);
