import { Setting } from "obsidian";
import type { HabitInput, PunishmentRule } from "../../types";

function numberField(parent: HTMLElement, label: string, value: number | undefined, update: (value: number | undefined) => void): void {
  new Setting(parent).setName(label).addText(text => {
    text.inputEl.type = "number";
    text.inputEl.min = "0";
    text.inputEl.step = "any";
    text.setValue(value === undefined ? "" : String(value)).onChange(raw => update(raw.trim() ? Number(raw) : undefined));
  });
}

export function renderHabitTargetFields(parent: HTMLElement, input: HabitInput): void {
  const fields = parent.createDiv();
  new Setting(fields).setName("记录方式").addDropdown(dropdown => dropdown
    .addOption("boolean", "按次数打卡")
    .addOption("number", "记录数值")
    .addOption("trades", "按交易笔数自动统计")
    .setValue(input.source === "trades" ? "trades" : input.target?.kind ?? "boolean")
    .onChange(kind => {
      if (kind === "trades") {
        input.source = "trades";
        input.frequencyUnit = "day";
        input.frequencyInterval = 1;
        input.target = { kind: "number", unit: "笔" };
      } else {
        if (input.source === "trades") input.source = "";
        input.target = kind === "number" ? { kind: "number", unit: "" } : { kind: "boolean" };
      }
      render();
    }));
  const details = fields.createDiv();
  function render() {
    details.empty();
    const target = input.target;
    if (input.source === "trades" && target?.kind === "number") {
      details.createEl("p", { text: "按开仓日期统计实际交易笔数，每天自动更新。" });
      numberField(details, "每日目标（笔）", target.perDay, value => { target.perDay = value; });
      return;
    }
    if (target?.kind !== "number") {
      numberField(details, "目标次数", input.targetCount, value => { input.targetCount = value || 1; });
      return;
    }
    new Setting(details).setName("计量单位").addText(text => text.setValue(target.unit).setPlaceholder("例如 公里").onChange(value => { target.unit = value; }));
    numberField(details, "每日目标", target.perDay, value => { target.perDay = value; });
    numberField(details, "每周目标", target.perWeek, value => { target.perWeek = value; });
  }
  render();
}

const ruleOptions = {
  save_money: "存钱",
  reflection: "写反思",
  extra_exercise: "加量运动"
} as const;

function blankRule(kind: string): PunishmentRule {
  if (kind === "save_money") return { kind, amount: 0, currency: "CNY" };
  if (kind === "reflection") return { kind, minChars: 0 };
  return { kind: "extra_exercise", activity: "快走", amount: 0, unit: "分钟" };
}

function renderRule(parent: HTMLElement, rule: PunishmentRule): void {
  if (rule.kind === "save_money") {
    numberField(parent, "金额", rule.amount || undefined, value => { rule.amount = value ?? 0; });
    new Setting(parent).setName("币种").addDropdown(dropdown => dropdown
      .addOption("CNY", "人民币").addOption("USD", "美元").addOption("SGD", "新元")
      .setValue(rule.currency).onChange(value => { rule.currency = value as typeof rule.currency; }));
    numberField(parent, "每天增加的存钱金额（留空：人民币 50 元，其他币种按基础金额）", rule.dailyIncrease,
      value => { rule.dailyIncrease = value; });
  } else if (rule.kind === "reflection") {
    numberField(parent, "最少字数", rule.minChars || undefined, value => { rule.minChars = value ?? 0; });
    numberField(parent, "每天增加的字数（留空时按最少字数）", rule.dailyIncrease, value => { rule.dailyIncrease = value; });
  } else {
    new Setting(parent).setName("运动").addDropdown(dropdown => dropdown
      .addOption("跑步", "跑步").addOption("快走", "快走").addOption("跳绳", "跳绳")
      .setValue(rule.activity).onChange(value => { rule.activity = value as typeof rule.activity; }));
    new Setting(parent).setName("运动单位").addDropdown(dropdown => dropdown.addOption("公里", "公里").addOption("分钟", "分钟")
      .setValue(rule.unit).onChange(value => { rule.unit = value as typeof rule.unit; }));
    numberField(parent, "运动量", rule.amount || undefined, value => { rule.amount = value ?? 0; });
    numberField(parent, "每日上限（留空时为原定量的两倍）", rule.dailyLimit, value => { rule.dailyLimit = value; });
    numberField(parent, "超量每单位折合存多少钱（人民币；未设置时只记待折算量）", rule.overflowCnyPerUnit,
      value => { rule.overflowCnyPerUnit = value; });
  }
}

export function renderHabitPunishmentFields(parent: HTMLElement, input: HabitInput): void {
  new Setting(parent).setName("未达标时安排补偿待办")
    .setDesc("每天 21:00 自动核对日目标，周日同时核对周目标。欠账拖一天加一档。运动仍有单次和合计上限，存钱只记账。")
    .addToggle(toggle => toggle.setValue(input.punishment?.enabled === true).onChange(enabled => {
      input.punishment = { enabled, rules: enabled ? input.punishment?.rules ?? [] : [] };
      render();
    }));
  const details = parent.createDiv();
  function render() {
    details.empty();
    const config = input.punishment;
    if (!config?.enabled) return;
    for (let index = 0; index < Math.min(3, config.rules.length + 1); index++) {
      const rule = config.rules[index];
      new Setting(details).setName(`第 ${index + 1} 级规则`).addDropdown(dropdown => {
        dropdown.addOption("", rule ? "移除这条规则" : "选择补偿");
        for (const [key, label] of Object.entries(ruleOptions)) dropdown.addOption(key, label);
        dropdown.setValue(rule?.kind ?? "").onChange(kind => {
          if (kind === "") config.rules.splice(index, 1);
          else config.rules[index] = blankRule(kind);
          render();
        });
      });
      if (rule) renderRule(details, rule);
    }
  }
  render();
}
