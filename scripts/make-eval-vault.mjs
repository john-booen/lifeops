import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export const EVAL_NOW = "2026-11-12T20:00:00+08:00";
export const EVAL_SEED = 20261112;
export const EVAL_MARKER = "LifeOps 评测库，内容全部为虚构数据。";
export const evalVaultRoot = fileURLToPath(new URL("../fixtures/eval-vault/", import.meta.url));
const taskFolder = "LifeOps/Goals/Tasks";
const habitFolder = "LifeOps/Goals/Habits";
const tradeFolder = "LifeOps/TradeReview";
const tradeModels = "LifeOps/Knowledge/TradeRules";
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const todayTitles = ["见客户", "写周报", "复盘交易", "跑步 5 公里", "整理发票", "阅读", "学习英语", "回复邮件", "整理资料",
  "打扫房间", "制定下周计划", "归档笔记"];

function dateAt(offset) {
  return new Date(Date.parse("2026-11-12T12:00:00+08:00") + offset * 86400_000).toISOString().slice(0, 10);
}

function makeTask(date, index, done, abandoned) {
  const today = date === "2026-11-12";
  const completedAt = done ? `${date}T18:00:00+08:00` : "";
  return {
    id: `task-eval-${date}-${index + 1}`, title: today ? todayTitles[index] : `虚构工作 ${date} 第 ${index + 1} 项`,
    status: done ? "completed" : abandoned ? "abandoned" : "active",
    priority: index < 2 ? "high" : "medium", quadrant: index < 2 ? "important-urgent" : index < 7 ? "important-not-urgent" : "not-important-not-urgent",
    category: today && index === 3 ? "life" : today && index === 6 ? "learning" : "work", project: "", date, endDate: date,
    time: today && index === 0 ? "21:00" : "", dueDate: today && index >= 7 ? "" : date, dueTime: "", repeatUnit: "none", repeatInterval: 1,
    repeatUntil: "", parentTaskId: "", note: "评测虚构任务", source: "eval-fixture", sourceNotePath: "",
    createdAt: `${date}T08:00:00+08:00`, updatedAt: completedAt || `${date}T08:00:00+08:00`,
    completedAt, completionLog: done ? [{ completedAt, note: "虚构完成记录" }] : [], sortOrder: index,
    estimateMin: today ? [45, 90, 120, 45, 30, 30, 40, 20, 30, 20, 30, 20][index] : 30
  };
}

function journal(date, period) {
  const low = ["2026-11-10", "2026-11-11", "2026-11-12"].includes(date);
  const state = low
    ? "昨晚只睡了 5.5 小时，睡眠质量 2 分。今天精力 2 分、情绪 2 分、压力 4 分，感到焦虑，容易拖延。"
    : "昨晚睡了 7.5 小时，睡眠质量 4 分。今天精力 4 分、情绪 4 分、压力 2 分。";
  const plans = date === "2026-11-12" && period === "晨" ? "\n今天要见客户、写周报、复盘交易、跑 5 公里。" : "";
  const idea = date === "2026-10-28" && period === "晚" ? "\n想到一个 AI 漫剧想法，可以先研究同类作品。" : "";
  return `---\ndate: "${date}"\nperiod: "${period}"\ntags: ["eval", "fictional"]\n---\n# ${date} ${period}间日记\n\n这是虚构日记。\n${state}${plans}${idea}\n`;
}

function makeHabits() {
  return [
    ["run", "跑步", "week", 4, { kind: "boolean" }],
    ["save", "攒钱", "day", 1, { kind: "number", unit: "元", perDay: 100 }],
    ["read", "阅读", "day", 1, { kind: "number", unit: "分钟", perDay: 30 }],
    ["trade", "每日交易", "day", 10, { kind: "number", unit: "笔", perDay: 10 }]
  ].map(([id, name, frequencyUnit, targetCount, target]) => ({
    id: `habit-eval-${id}`, name, frequencyUnit, frequencyInterval: 1, targetCount, target,
    startDate: "2026-10-16", penaltyThreshold: 3, color: "#3498db", createdAt: "2026-10-16T08:00:00+08:00",
    source: id === "trade" ? "trades" : "eval-fixture",
    punishment: { enabled: id === "run", rules: id === "run" ? [{ kind: "reflection", minChars: 200 }] : [] }
  }));
}

function journalSignal(date, period, path, raw) {
  const low = date >= "2026-11-10";
  const morningPlans = date === "2026-11-12" && period === "晨" ? ["见客户", "写周报", "复盘交易", "跑 5 公里"] : [];
  return {
    date, period, energy: low ? 2 : 4, mood: low ? 2 : 4, stress: low ? 4 : 2, sleepHours: low ? 5.5 : 7.5, sleepQuality: low ? 2 : 4,
    keyEvents: [], plans: morningPlans.map(text => ({ text, when: "今天" })), ideas: [], worries: low ? ["感到焦虑"] : [],
    quotes: [
      { field: "energy", text: `精力 ${low ? 2 : 4} 分` }, { field: "mood", text: `情绪 ${low ? 2 : 4} 分` },
      { field: "stress", text: `压力 ${low ? 4 : 2} 分` }, { field: "sleepHours", text: low ? "昨晚只睡了 5.5 小时" : "昨晚睡了 7.5 小时" },
      { field: "sleepQuality", text: `睡眠质量 ${low ? 2 : 4} 分` }
    ],
    sources: [{ path, sha256: createHash("sha256").update(raw).digest("hex") }]
  };
}

function addTradingFixture(files) {
  const modelNames = ["虚构突破", "虚构回踩"];
  const ruleText = "触及预设止损价立即退出。";
  const models = modelNames.map((title, index) => {
    const suffix = String(index + 1).repeat(24);
    const id = "trade-model-" + suffix;
    const sourcePath = tradeModels + "/" + title + ".md";
    const source = "# " + title + "\n\n" + ruleText + "\n";
    files.set(sourcePath, source);
    return { id, versions: [{ id: "trade-version-" + suffix, modelId: id, previousVersionId: "",
      title, market: "虚构多市场", entry: "核对预设条件", exit: ruleText, invalid: "", riskBudget: "", environment: "", costs: "",
      rationale: "评测虚构规则", sourcePath, sourceHash: createHash("sha256").update(source).digest("hex"),
      revision: 1, updatedAt: "2026-10-25T12:00:00+08:00",
      rules: [{ id: "eval-stop-" + (index + 1), text: ruleText, kind: "exit", checkable: true, sourcePath, quote: ruleText }] }] };
  });
  const markets = [
    ["A股", "AAX-EVAL", "CNY", [120, -40, 80, -30, 50, 0]],
    ["美股", "USX-EVAL", "USD", [60, -25, 45, -15, -35, 20, 0]],
    ["加密", "CRX-EVAL", "USD", [35, -50, -25, 60, -20, 25, 10]],
    ["外汇", "FXX-EVAL", "USD", [30, -10, 20, 10, -30, 15]]
  ];
  const trades = markets.flatMap(([market, symbol, currency, gains], marketIndex) => {
    const days = gains.length === 7 ? ["02", "04", "06", "09", "11", "10", "12"] : ["02", "04", "06", "09", "11", "12"];
    return [5, ...gains].map((pnl, row) => {
      const index = row - 1, date = row ? "2026-11-" + days[index] : "2026-10-26";
      const hour = 9 + marketIndex;
      const openedAt = date + "T" + String(hour).padStart(2, "0") + ":00:00+08:00";
      const closedAt = date + "T" + String(hour).padStart(2, "0") + ":20:00+08:00";
      const model = models[row ? index % 2 : 0], version = model.versions[0];
      const violated = index === 4 && (market === "美股" || market === "加密");
      const notes = violated ? "本人记录触及预设止损价后继续持有，未按止损退出。" : "虚构评测交易。";
      const direction = index % 3 === 1 ? "short" : "long";
      return { id: "trade-eval-" + (marketIndex + 1) + "-" + row, openedAt, closedAt, market, symbol, direction, qty: 10, entry: 100,
        exit: 100 + pnl / (direction === "long" ? 10 : -10), stop: direction === "long" ? 98 : 102, fees: 0,
        pnl, pnlSource: "stated", currency, riskAmount: 20, rMultiple: pnl / 20, modelId: model.id, modelVersionId: version.id,
        planned: !violated, ruleViolations: violated ? [version.rules[0].id] : [], ruleCheckStatus: "checked",
        notes, attachments: [], source: { kind: "form" }, createdAt: openedAt, updatedAt: closedAt };
    });
  });
  files.set(tradeModels + "/LifeOps交易研究.json", JSON.stringify({ version: 1, models, cases: [] }, null, 2) + "\n");
  files.set(tradeFolder + "/LifeOps交易记录.json", JSON.stringify({ version: 1, trades }, null, 2) + "\n");
}

function addLearningFixture(files) {
  const root = "LifeOps/Output/AI", ideas = "LifeOps/Knowledge/Ideas", reading = "LifeOps/Knowledge/Reading";
  const learning = "LifeOps/Knowledge/Learning", article = reading + "/角色设定表与镜头连续性.md";
  const note = (path, properties, body) => files.set(path, "---\n" + JSON.stringify(properties) + "\n---\n\n" + body + "\n");
  const json = (path, data) => files.set(path, JSON.stringify(data, null, 2) + "\n");
  const hash = path => createHash("sha256").update(files.get(path)).digest("hex");
  const ideaData = [
    ["AI 漫剧", "seed", "2026-10-28", "研究同类作品", "想用虚构角色制作三分钟样片，先比较同类作品的镜头一致性。"],
    ["读书索引", "building", "2026-11-11", "整理第一批卡片", "用三个主题整理虚构书单。"],
    ["英语跟读助手", "validating", "2026-11-10", "对比两段跟读录音", "测试一段英语跟读练习的反馈方式。"],
    ["虚构时间盒", "exploring", "2026-11-09", "写一页使用场景", "探索如何分配学习和休息时间。"],
    ["收藏旧站点", "parked", "2026-10-25", "", "已暂停的虚构收藏整理。"]
  ];
  const ideaIds = ideaData.map((_, index) => "idea-eval-" + String(index + 1).repeat(16));
  for (const [index, [title, status, date, nextAction, description]] of ideaData.entries()) {
    note(ideas + "/" + title + ".md", { lifeops: "idea", ideaId: ideaIds[index], status,
      created: index === 0 ? date : "2026-10-23", lastProgress: date, nextAction, nextReview: index === 0 ? "2026-11-11" : "2026-11-20",
      sources: index === 0 ? ["[[LifeOps/Journal/2026/10/2026-10-28晚]]"] : [] }, "# " + title + "\n\n" + description);
  }
  note(article, { source: "评测虚构文章" }, "# 角色设定表与镜头连续性\n\n先固定角色服装、色彩和标志道具，再对照连续镜头检查差异。");
  json(root + "/Reading/index.json", { version: 1, entries: [{ path: article, title: "角色设定表与镜头连续性",
    summary: "固定服装、色彩和标志道具后，用相邻镜头核对角色一致性。",
    ideaIds: [ideaIds[0]], trackIds: ["ai"], keywords: ["角色设定", "镜头连续性", "一致性"], sourceRevision: hash(article),
    updatedAt: "2026-11-11T18:00:00+08:00" }] });
  const englishNote = learning + "/英语/虚构跟读.md", quantNote = learning + "/量化/虚构回测基础.md";
  files.set(englishNote, "# 虚构跟读\n\n记录句子重音、连读与弱读，先慢速听辨再跟读。\n");
  const questions = [
    ["样本外检验使用什么数据？", "样本外数据不参与参数选择。"],
    ["回测的净收益怎样计算？", "净收益等于毛收益减去交易成本。"],
    ["未来函数会给回测带来什么问题？", "未来函数会引入交易当时不可得的信息。"]
  ];
  files.set(quantNote, "# 虚构回测基础\n\n" + questions.map(([, answer]) => answer).join("\n\n") + "\n");
  const makeUnits = (id, titles, done) => titles.map((title, index) => ({
    id: "unit-" + id + "-" + (index + 1), title, status: index < done ? "done" : "todo",
    ...(index < done ? { doneAt: "2026-11-10" } : {})
  }));
  const englishUnits = makeUnits("english", ["音标和重音", "基础听辨", "连读与弱读", "短句跟读", "常用词块", "日常问答", "听写练习", "录音自评"], 2);
  json(root + "/Learning/LifeOps学习轨道.json", { version: 1, tracks: [
    { id: "english", name: "英语", goal: "完成一段英语口语自我介绍", weeklyMinutes: 150, folders: [learning + "/英语"], units: englishUnits,
      sessions: [{ date: "2026-11-09", minutes: 30, notePath: englishNote }, { date: "2026-11-11", minutes: 45, notePath: englishNote }],
      nextPlan: { from: "2026-11-16", goal: "先把连读与弱读练顺", weeklyMinutes: 100, folders: [learning + "/英语"], units: englishUnits.slice(2, 4) } },
    { id: "quant", name: "量化", goal: "理解回测可信度", weeklyMinutes: 120, folders: [learning + "/量化"],
      units: makeUnits("quant", ["回测前提", "样本外检验", "手续费", "未来函数", "滑点", "参数稳定性", "回测报告", "复盘样例"], 1),
      sessions: [{ date: "2026-11-10", minutes: 40, notePath: quantNote }] }
  ] });
  const cards = questions.map(([question, answer], index) => ({ id: "quiz-eval-quant-" + (index + 1), trackId: "quant", question, answer,
    sourcePath: quantNote, sourceQuote: answer, ease: 3, intervalDays: 0, due: "2026-11-12", history: [] }));
  json(root + "/Learning/LifeOps复习卡.json", { version: 1, cards, active: { date: "2026-11-12", cardIds: cards.map(card => card.id) } });
}

async function fixtureBuilders() {
  const bundle = await build({
    stdin: { contents: [
      'export { renderTaskMirror } from "./src/dataFoundation/taskPersistence";',
      'export { planHabitPunishments } from "./src/features/habits/punishments";',
      'export { buildTaskFromInput } from "./src/vaultApi";',
      'export { DEFAULT_SETTINGS } from "./src/defaults";',
      'export { getStats } from "./src/features/stats/stats";',
      'export { summaryPeriod } from "./src/features/summaries/periods";',
      'export { createPersonalMemory, emptyPersonalMemoryDocument } from "./src/personalMemory";'
    ].join("\n"), resolveDir: projectRoot },
    absWorkingDir: projectRoot, bundle: true, write: false, platform: "node", format: "esm",
    alias: { obsidian: join(projectRoot, "tests/helpers/obsidianFileMock.ts") }
  });
  const moduleUrl = "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].contents).toString("base64");
  return import(moduleUrl);
}

function addStewardFixture(files, tasks, builders) {
  const { DEFAULT_SETTINGS, getStats, summaryPeriod, createPersonalMemory, emptyPersonalMemoryDocument } = builders;
  const root = DEFAULT_SETTINGS.folders.aiReports;
  const now = new Date(EVAL_NOW);
  const hash = value => createHash("sha256").update(value).digest("hex");
  const scope = hash(JSON.stringify([DEFAULT_SETTINGS.folders, [], hash("[]"), []]));
  const trades = JSON.parse(files.get(tradeFolder + "/LifeOps交易记录.json")).trades;
  for (const [level, date, through] of [
    ["week", "2026-11-08", "2026-11-08"], ["month", "2026-10-31", "2026-10-31"], ["month", "2026-11-12", "2026-11-12"]
  ]) {
    const period = summaryPeriod(level, date);
    const range = { from: period.from, to: through };
    const workload = getStats({ domain: "tasks", range }, { tasks }, now);
    const pnl = getStats({ domain: "trades", range }, { trades }, now);
    const metrics = { taskCompletionPercent: workload.completionPercent, tasksCompleted: workload.completedCount,
      energy: null, tradePnlCny: pnl.byCurrency.CNY.totalPnl, tradePnlUsd: pnl.byCurrency.USD.totalPnl };
    const body = `# 虚构${level === "week" ? "周摘要" : "月摘要"}\n\n${period.from} 至 ${through}，完成 ${metrics.tasksCompleted} 项任务，完成率 ${metrics.taskCompletionPercent}%。`
      + (level === "week" ? "工作日都有完成记录。改进重点是给未收尾的任务留一个明确的下一步。"
        : `交易净盈亏 CNY ${metrics.tradePnlCny ?? "未记录"}，USD ${metrics.tradePnlUsd ?? "未记录"}。`)
      + (period.key === "2026-10" ? "夹具的十月记录从 10 月 16 日开始。" : "")
      + (through < period.to ? "当前月统计只到 11 月 12 日。" : "");
    const folder = level === "week" ? "周" : "月";
    const properties = { lifeops: "lifeops-summary", level, from: period.from, to: period.to, through,
      sourceScope: scope, inputCount: 0, complete: through === period.to, generatedBy: "model", metrics };
    const header = "---\n" + JSON.stringify(properties) + "\n---\n", text = "\n" + body + "\n";
    files.set(`${root}/摘要/${folder}/${period.key}.md`, header + "<!-- LifeOps 指纹 " + hash(header + text) + " -->\n" + text);
  }
  const stamp = "2026-11-09T12:00:00+08:00", source = "LifeOps/Knowledge/虚构管家偏好.md";
  const contents = ["我每周三晚上整理读书笔记。", "比较方案时我习惯用两列对照表。"];
  files.set(source, "# 虚构管家偏好\n\n" + contents.join("\n\n") + "\n");
  const records = contents.map((content, index) => ({
    ...createPersonalMemory({ kind: index === 0 ? "core_profile" : "user_rule", content,
      sourceRefs: [{ sourceId: "eval-steward-" + index, path: source, capturedAt: stamp }] }, stamp),
    status: "active", confirmedAt: stamp
  }));
  files.set(root + "/Memory/personal-memory.json", JSON.stringify({ ...emptyPersonalMemoryDocument(stamp), records }, null, 2) + "\n");
}

export async function buildEvalFixture() {
  const files = new Map([["TEST_VAULT_ONLY.md", "# LifeOps 0.2 Test Vault\n\n" + EVAL_MARKER + "\n"]]);
  const tasks = [], habits = makeHabits(), checkins = [];
  let seed = EVAL_SEED;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let offset = -27; offset <= 0; offset++) {
    const date = dateAt(offset), weekday = new Date(date + "T12:00:00+08:00").getUTCDay();
    const signals = { version: 1, date, 晨: [], 晚: [] };
    for (const [period, suffix] of [["晨", "早"], ["晚", "晚"]]) {
      const path = `LifeOps/Journal/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}${suffix}.md`;
      const raw = journal(date, period);
      files.set(path, raw);
      signals[period].push(journalSignal(date, period, path, raw));
    }
    if (offset >= -2) files.set(`LifeOps/Output/AI/Signals/${date}.json`, JSON.stringify(signals, null, 2) + "\n");
    if (weekday >= 1 && weekday <= 5) {
      const count = offset === 0 ? 12 : 6 + Math.floor(random() * 4);
      const completed = offset === 0 ? 3 : Math.round(count * 0.7);
      for (let index = 0; index < count; index++) {
        const done = offset === 0 ? index >= count - completed : index < completed;
        tasks.push(makeTask(date, index, done, offset < 0 && !done));
      }
    }
    const addCheckin = (id, value, count = 1) => checkins.push({
      habitId: `habit-eval-${id}`, date, status: "done", count, value, updatedAt: date + "T18:00:00+08:00", note: "虚构打卡"
    });
    if (weekday === 1) addCheckin("run", 5);
    if (!["2026-11-10", "2026-11-11"].includes(date)) addCheckin("save", 100);
    if (offset % 2 === 0) addCheckin("read", 30);
  }
  const builders = await fixtureBuilders();
  const { buildTaskFromInput, planHabitPunishments, renderTaskMirror } = builders;
  const penalties = planHabitPunishments(habits, checkins, [], new Date(2026, 9, 18, 21));
  for (const [index, task] of penalties.entries()) {
    // This historical fixture represents a pre-accrual compensation record.
    // New accrued debt is covered by the dedicated compensation tests.
    const original = buildTaskFromInput(task, new Date("2026-10-18T21:00:00+08:00"), () => `task-eval-penalty-${index + 1}`);
    if (original.habitPunishment) delete original.habitPunishment.debt;
    if (original.id === "task-eval-penalty-1") original.title = "补偿：写反思至少 200 字（跑步本周 0/4 次）";
    tasks.push(original);
  }
  files.set(taskFolder + "/LifeOps任务库.json", JSON.stringify({ tasks }, null, 2) + "\n");
  files.set(habitFolder + "/LifeOps打卡库.json", JSON.stringify({ habits, checkins }, null, 2) + "\n");
  files.set(taskFolder + "/任务看板.md", renderTaskMirror(tasks, "# 任务看板\n\n> 评测镜像，任务以 JSON 为准。\n"));
  files.set(habitFolder + "/打卡看板.md", "# 打卡看板\n\n> 评测镜像，打卡以 JSON 为准。\n");
  addTradingFixture(files);
  addLearningFixture(files);
  addStewardFixture(files, tasks, builders);
  return files;
}

export async function makeEvalVault(root = evalVaultRoot) {
  const files = await buildEvalFixture();
  for (const [path, content] of files) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return files.size;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw Error("用法 node scripts/make-eval-vault.mjs");
  console.log(`已生成 ${await makeEvalVault()} 个虚构评测文件，固定种子 ${EVAL_SEED}。`);
}
