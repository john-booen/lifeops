import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvalObservation, EvalQuestion } from "./scoring";
import {evaluationRouteLabels,type EvaluationRoute} from './routes';

export interface EvalResult {
  id: string;
  passed: boolean;
  issues: string[];
  inputTokens?: number;
  outputTokens?: number;
  firstTokenMs?: number;
  totalMs: number;
  models: string[];
  tools: EvalObservation["tools"];
  confirmationActions: EvalObservation["confirmationActions"];
  requests: number;
  errorCode?: string;
  judgeReason?: string;
  transportFailures: number;
  route?:EvaluationRoute;
  firstTransportMeasurement?: { firstTokenMs?: number; totalMs: number; issues: string[] };
}
interface PublishedScore {
  passRate: number;
  questionIds: string[];
  passedIds?: string[];
}
const root = "docs/eval";
const requiredIds = ["today-unfinished-01", "create-client-06", "week-habits-09", "undo-last-12", "delete-reading-14", "today-completed-16"];
const tradeStatIds = ["monthly-trade-pnl-23", "market-win-rates-24", "profitable-trade-model-25", "daily-trade-goal-28"];

async function readScore(name: string): Promise<PublishedScore | undefined> {
  const path = join(root, name);
  try { await access(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const score = JSON.parse(await readFile(path, "utf8")) as PublishedScore;
  if (!Number.isFinite(score.passRate) || score.passRate < 0 || score.passRate > 1
    || !Array.isArray(score.questionIds) || !score.questionIds.length) throw Error("评测基线格式无效");
  return score;
}

export async function writeEvaluationReport(questions: EvalQuestion[], results: EvalResult[]): Promise<void> {
  await mkdir(root, { recursive: true });
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date());
  const passed = results.filter((result) => result.passed);
  const passRate = passed.length / results.length;
  const milestone = questions.at(-1)?.milestone ?? "M1";
  const heading = `# ${date} ${milestone} 评测`;
  const lines = [
    heading, "", `固定评测时间 2026-11-12 20:00 +08:00。通过 ${passed.length}/${results.length}，通过率 ${(passRate * 100).toFixed(1)}%。`, "",
    ...[...Object.entries(evaluationRouteLabels)].map(([kind,label])=>`${label}：${results.filter(result=>result.route?.kind===kind).length}题。`),
    `路线范围：只计本轮，不含夹具/前序；未测量${results.filter(result=>!result.route).length}题。原评分的输入量、模型及工具列仍包含整题前序，未更改评分。写入工具路线不等于已经落任务；任务差分另列新增/删除/更新。`,"",
    "| 题目 | 结果 | 本轮路线 | 本轮产品请求 | 本轮任务差分 | 输入 token | 输出 token | 首字 ms | 总耗时 ms | 整题模型 | 整题工具 |",
    "|---|---|---|---:|---|---:|---:|---:|---:|---|---|",
    ...results.map((result) => `| ${result.id} | ${result.passed ? "通过" : "未通过"} | ${result.route?evaluationRouteLabels[result.route.kind]:'未测量'} | ${result.route?.productRequests??'未知'} | ${result.route?Object.values(result.route.taskChanges).join('/'):'未知'} | ${result.inputTokens ?? "未返回"} | ${result.outputTokens ?? "未返回"} | ${result.firstTokenMs ?? "无文本"} | ${result.totalMs} | ${result.models.join("、") || "本地"} | ${result.tools.map((tool) => tool.name + (tool.ok ? " ✓" : " ×")).join("、") || "无"} |`),
    "", "## 未通过明细", "",
    ...results.filter((result) => !result.passed).flatMap((result) => [
      `### ${result.id}`, "",
      ...result.issues.slice(0, 3).map((issue) => "- " + issue), ""
    ]),
    ...results.filter(result => result.passed && result.judgeReason).flatMap(result => ["", `裁判 ${result.id} 通过。${result.judgeReason}`, ""]),
    ...results.flatMap(result => {
      const first = result.firstTransportMeasurement;
      return first ? ["", `测速重测 ${result.id}。首次传输失败，回退首字 ${first.firstTokenMs ?? "未知"} ms，总耗时 ${first.totalMs} ms。${first.issues.join("、")}。表格列出新副本上唯一一次重测结果。`] : [];
    })
  ];
  const path = join(root, date + ".md");
  const previous = await readFile(path, "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  const sections = previous.trim().split(/\n(?=# )/).filter(section => section && section.split("\n", 1)[0] !== heading);
  await writeFile(path, [...sections, lines.join("\n").trimEnd()].join("\n\n") + "\n");
  if (results.every((result) => result.errorCode && result.requests === 0)) throw Error("评测运行器未到达模型入口，请先检查运行错误");
  const baseline = await readScore("baseline.json");
  const published = await readScore("latest.json");
  if (!baseline) {
    await writeFile(join(root, "baseline.json"), JSON.stringify({
      passRate, questionIds: questions.map((question) => question.id),
      passedIds: passed.map((result) => result.id), results
    }, null, 2) + "\n", { flag: "wx" });
  }
  process.stdout.write(`评测质量结果 ${passed.length}/${results.length} · ${(passRate * 100).toFixed(1)}%\n`);
  for (const prior of [baseline, published].filter((value): value is PublishedScore => !!value)) {
    const current = results.filter((result) => prior.questionIds.includes(result.id));
    if (current.length !== prior.questionIds.length) throw Error("旧评测题目缺失");
    if (current.filter((result) => result.passed).length / current.length < prior.passRate) throw Error("评测通过率低于已有基线或上次交付");
  }
  if (published && passRate < published.passRate) throw Error("评测总通过率低于上次交付");
  if (process.env.LIFEOPS_EVAL_GATE === "0.3.0-alpha.2") {
    if (results.length < 20 || passRate < 0.85 || requiredIds.some((id) => !passed.some((result) => result.id === id))) {
      throw Error("M1 发布评测门槛未满足");
    }
  }
  if (process.env.LIFEOPS_EVAL_GATE === "0.3.0-beta.1") {
    const passedIds = new Set(passed.map(result => result.id));
    if (questions.filter(question => question.milestone === "M1").length !== 20
      || questions.filter(question => question.milestone === "M2").length !== 8 || passRate < 0.85
      || [...requiredIds, ...tradeStatIds].some(id => !passedIds.has(id))) {
      throw Error("M2 发布评测门槛未满足");
    }
  }
  if (process.env.LIFEOPS_EVAL_GATE === "0.3.0-beta.2") {
    const passedIds = new Set(passed.map(result => result.id));
    if (results.length !== 36 || questions.filter(question => question.milestone === "M1").length !== 20
      || questions.filter(question => question.milestone === "M2").length !== 8
      || questions.filter(question => question.milestone === "M3").length !== 8 || passRate < 0.85
      || [...requiredIds, ...tradeStatIds].some(id => !passedIds.has(id))) {
      throw Error("M3 发布评测门槛未满足");
    }
  }
  if (process.env.LIFEOPS_EVAL_GATE === "0.4.0") {
    const milestones = { M1: 20, M2: 8, M3: 8, M4: 4 };
    const passedIds = new Set(passed.map(result => result.id));
    if (results.length !== 40 || passRate < 0.85
      || Object.entries(milestones).some(([milestone, count]) => questions.filter(question => question.milestone === milestone).length !== count)
      || [...requiredIds, ...tradeStatIds].some(id => !passedIds.has(id))) throw Error("M4 发布评测门槛未满足");
  }
}
