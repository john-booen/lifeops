import {taskScheduleInput} from "./features/tasks/scheduleInput";
import { TASK_CATEGORIES } from "./features/tasks/capacity";
import { isLearningTrackId, LEARNING_TRACKS } from "./features/learning/model";
import { renderHabitPunishmentFields, renderHabitTargetFields } from "./features/habits/formFields";
import { automaticHabitDayDisplay, healthHabitReadingDays, isHabitRequiredOn as isHabitRequiredOnDate, numericHabitPeriods, numericHabitWindow } from "./features/habits/targets";
import { isHealthHabitSource } from "./features/health/habitSources";
import { Modal, Notice, Setting } from "obsidian";
import { addDays, endOfWeek, todayString, weekDates } from "./date";
import { taskScheduleLabel, validateTaskSchedule } from "./taskSchedule";
import { renderTaskScheduleForm } from "./taskScheduleForm";
import type {
  HabitCheckinStatus,
  HabitDashboardItem,
  HabitDefinition,
  HabitInput,
  HealthEntry,
  CaptureKind,
  LifeOpsTask,
  LifeOpsTaskInput,
  LifeOpsTaskPriority,
  LifeOpsTaskQuadrant,
  LifeOpsTaskRepeatUnit
} from "./types";

export interface QuickCaptureInput {
  content: string;
  kind: CaptureKind | "auto";
  date: string;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  [index: number]: { transcript: string };
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

export class QuickCaptureModal extends Modal {
  private value: QuickCaptureInput = {
    content: "",
    kind: "auto",
    date: todayString()
  };
  private mediaRecorder: MediaRecorder | null = null;
  private mediaStream: MediaStream | null = null;
  private audioChunks: BlobPart[] = [];
  private textArea: HTMLTextAreaElement | null = null;
  private voiceStatus: HTMLElement | null = null;
  private speechRecognition: SpeechRecognitionLike | null = null;
  private voiceBaseContent = "";
  private liveFinalText = "";
  private isRecording = false;
  private isTranscribing = false;

  constructor(
    app: import("obsidian").App,
    private readonly onSubmit: (value: QuickCaptureInput) => Promise<void>,
    private readonly onTranscribeAudio?: (audio: Blob) => Promise<string>
  ) {
    super(app);
  }

  onClose(): void {
    this.stopVoiceCapture(true);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lifeops-form-modal");
    contentEl.createEl("h2", { text: "LifeOps 快速记录" });
    contentEl.createEl("p", {
      text: "可以自动判断，也可以手动指定类型。适合随手记录待办、完成事项、日记、灵感、交易、健康和习惯。"
    });

    new Setting(contentEl).setName("类型").addDropdown((dropdown) => {
      dropdown
        .addOption("auto", "自动判断")
        .addOption("todo", "待办")
        .addOption("done", "已完成")
        .addOption("diary", "日记")
        .addOption("idea", "灵感")
        .addOption("habit", "习惯打卡")
        .addOption("trade", "交易记录")
        .addOption("health", "健康记录")
        .addOption("memo", "备忘 / 待确认")
        .setValue(this.value.kind)
        .onChange((value) => {
          this.value.kind = value as QuickCaptureInput["kind"];
        });
    });

    new Setting(contentEl).setName("日期").setDesc("记录归属日期，默认今天。").addText((text) => {
      setupDateInput(text.inputEl);
      text.setValue(this.value.date).setPlaceholder(todayString()).onChange((value) => {
        this.value.date = value.trim() || todayString();
      });
    });

    new Setting(contentEl).addTextArea((text) => {
      text.setPlaceholder("例如：明天上午整理交易模型；今天跑步 5 公里完成了；这笔交易入场太急。");
      text.inputEl.rows = 8;
      text.inputEl.style.width = "100%";
      this.textArea = text.inputEl;
      text.onChange((value) => {
        this.value.content = value;
      });
    });

    const voice = contentEl.createDiv({ cls: "lifeops-voice-capture" });
    const voiceCopy = voice.createDiv();
    voiceCopy.createDiv({ text: "语音输入", cls: "lifeops-voice-title" });
    this.voiceStatus = voiceCopy.createDiv({ text: "点击开始录音。支持实时草稿时会边说边显示。停止后使用已配置的服务转写。", cls: "lifeops-voice-status" });
    voice.createEl("button", { text: "开始录音", cls: "lifeops-voice-button" }, (button) => {
      button.onclick = () => {
        if (this.isRecording) {
          this.stopVoiceCapture();
          button.setText("开始录音");
          return;
        }
        void this.startVoiceCapture(button);
      };
    });

    const hints = contentEl.createDiv({ cls: "lifeops-capture-hints" });
    hints.createSpan({ text: "/todo 待办" });
    hints.createSpan({ text: "/done 完成" });
    hints.createSpan({ text: "/idea 灵感" });
    hints.createSpan({ text: "/trade 交易" });
    hints.createSpan({ text: "/health 健康" });

    new Setting(contentEl).addButton((button) => {
      button.setButtonText("保存").setCta().onClick(async () => {
        const content = this.value.content.trim();
        if (!content) return;
        await this.onSubmit({ ...this.value, content });
        this.close();
      });
    });
  }

  private async startVoiceCapture(button: HTMLButtonElement): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      new Notice("当前环境不支持录音。后续可以接桌面端本地录音工具或系统听写。");
      this.setVoiceStatus("当前环境不支持录音。");
      return;
    }

    try {
      this.stopVoiceCapture(true);
      this.audioChunks = [];
      this.voiceBaseContent = this.value.content.trim();
      this.liveFinalText = "";
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      this.mediaRecorder = new MediaRecorder(this.mediaStream, { mimeType });
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.audioChunks.push(event.data);
      };
      this.mediaRecorder.onstop = () => {
        void this.finishVoiceCapture(mimeType);
      };
      this.mediaRecorder.start();
      this.startLiveSpeechPreview();
      this.isRecording = true;
      button.setText("停止录音");
      this.setVoiceStatus(this.speechRecognition ? "正在录音，本地实时草稿已开启..." : "正在录音。当前环境不支持本地实时草稿，停止后会云端转写。");
    } catch (error) {
      this.cleanupMedia();
      this.setVoiceStatus("录音启动失败，请检查麦克风权限。");
      new Notice(error instanceof Error ? `录音启动失败：${error.message}` : "录音启动失败");
    }
  }

  private stopVoiceCapture(silent = false): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.stop();
    } else {
      this.cleanupMedia();
    }
    this.stopLiveSpeechPreview();
    this.isRecording = false;
    if (!silent) this.setVoiceStatus("语音输入已停止。");
  }

  private async finishVoiceCapture(mimeType: string): Promise<void> {
    const audio = new Blob(this.audioChunks, { type: mimeType });
    this.cleanupMedia();
    if (audio.size === 0) {
      this.setVoiceStatus("没有录到有效声音。");
      return;
    }
    if (!this.onTranscribeAudio) {
      this.setVoiceStatus("录音完成，但还没有配置转写接口。");
      return;
    }
    this.isTranscribing = true;
    this.setVoiceStatus("录音完成，正在转写...");
    try {
      const text = await this.onTranscribeAudio(audio);
      this.setCaptureContent([this.voiceBaseContent, text].filter(Boolean).join(this.voiceBaseContent ? "\n" : ""));
      this.setVoiceStatus("转写完成，已写入文本框。");
    } catch (error) {
      const message = error instanceof Error ? error.message : "语音转写失败";
      this.setVoiceStatus(`转写失败：${message}`);
      new Notice(message);
    } finally {
      this.isTranscribing = false;
    }
  }

  private cleanupMedia(): void {
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;
    this.mediaRecorder = null;
    this.audioChunks = [];
  }

  private startLiveSpeechPreview(): void {
    const speechWindow = window as unknown as {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    const SpeechRecognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "zh-CN";
      recognition.onresult = (event) => {
        let interim = "";
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const transcript = result[0]?.transcript ?? "";
          if (result.isFinal) {
            this.liveFinalText += transcript;
          } else {
            interim += transcript;
          }
        }
        const liveText = `${this.liveFinalText}${interim}`.trim();
        if (liveText) {
          this.setCaptureContent([this.voiceBaseContent, liveText].filter(Boolean).join(this.voiceBaseContent ? "\n" : ""));
        }
      };
      recognition.onerror = () => {
        this.setVoiceStatus("本地实时草稿暂不可用，录音仍会在停止后云端转写。");
      };
      recognition.start();
      this.speechRecognition = recognition;
    } catch {
      this.speechRecognition = null;
    }
  }

  private stopLiveSpeechPreview(): void {
    try {
      this.speechRecognition?.stop();
    } catch {
      // Ignore local speech preview shutdown errors.
    }
    this.speechRecognition = null;
  }

  private setCaptureContent(value: string): void {
    this.value.content = value;
    if (this.textArea) {
      this.textArea.value = value;
    }
  }

  private setVoiceStatus(text: string): void {
    if (this.voiceStatus) {
      this.voiceStatus.setText(text);
    }
  }
}

export class HealthEntryModal extends Modal {
  private value: HealthEntry = {
    date: todayString()
  };

  constructor(app: import("obsidian").App, private readonly onSubmit: (value: HealthEntry) => Promise<void>) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lifeops-form-modal");
    contentEl.createEl("h2", { text: "记录健康" });

    new Setting(contentEl).setName("日期").addText((text) => {
      text.setValue(this.value.date).setPlaceholder(todayString()).onChange((value) => {
        this.value.date = value.trim() || todayString();
      });
    });

    new Setting(contentEl).setName("睡眠小时").addText((text) => {
      text.setPlaceholder("7.5").onChange((value) => {
        this.value.sleepHours = parseOptionalNumber(value);
      });
    });

    new Setting(contentEl).setName("体重 kg").addText((text) => {
      text.setPlaceholder("72.3").onChange((value) => {
        this.value.weightKg = parseOptionalNumber(value);
      });
    });

    new Setting(contentEl).setName("步数").addText((text) => {
      text.setPlaceholder("8000").onChange((value) => {
        this.value.steps = parseOptionalNumber(value);
      });
    });

    new Setting(contentEl).setName("跑步距离（公里）").addText(text => {
      text.onChange(value => { this.value.runningKm = parseOptionalNumber(value); });
    });
    new Setting(contentEl).setName("静息心率（次/分）").addText(text => {
      text.onChange(value => { this.value.restingHeartRate = parseOptionalNumber(value); });
    });

    new Setting(contentEl).setName("运动").addText((text) => {
      text.setPlaceholder("跑步 5 公里").onChange((value) => {
        this.value.exercise = value.trim();
      });
    });

    new Setting(contentEl).setName("疲劳").setDesc("1-10，越高越疲劳。").addText((text) => {
      text.setPlaceholder("4").onChange((value) => {
        this.value.fatigue = parseOptionalNumber(value);
      });
    });

    new Setting(contentEl).setName("精力").setDesc("1-10，越高越有精神。").addText((text) => {
      text.setPlaceholder("7").onChange((value) => {
        this.value.energy = parseOptionalNumber(value);
      });
    });

    new Setting(contentEl).setName("备注").addTextArea((text) => {
      text.inputEl.rows = 3;
      text.inputEl.style.width = "100%";
      text.setPlaceholder("今天身体状态、睡眠质量、饮食或运动感受").onChange((value) => {
        this.value.note = value.trim();
      });
    });

    new Setting(contentEl).addButton((button) => {
      button.setButtonText("保存健康记录").setCta().onClick(async () => {
        if (button.buttonEl.disabled) return;
        button.setDisabled(true);
        try {
          await this.onSubmit({ ...this.value });
          this.close();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "健康记录暂时没有保存。");
        } finally {
          button.setDisabled(false);
        }
      });
    });
  }
}

export { TradeEntryModal } from "./features/trading/form";

export class TaskModal extends Modal {
  private value: LifeOpsTaskInput = {
    title: "",
    priority: "medium",
    quadrant: "important-urgent",
    category: "work",
    project: "默认",
    date: "",
    time: "",
    startTime: "",
    endTime: "",
    dueDate: "",
    dueTime: "",
    repeatUnit: "none",
    repeatInterval: 1,
    repeatUntil: ""
  };

  constructor(
    app: import("obsidian").App,
    private readonly onSubmit: (value: LifeOpsTaskInput) => Promise<void>,
    defaults: Partial<LifeOpsTaskInput> = {},
    private readonly labels: { title?: string; submit?: string } = {}
  ) {
    super(app);
    this.value = { ...this.value, ...defaults };
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lifeops-form-modal");
    contentEl.createEl("h2", { text: this.labels.title ?? "新建任务" });

    new Setting(contentEl).setName("任务").addText((text) => {
      text.setValue(this.value.title).setPlaceholder("例如：整理交易模型").onChange((value) => {
        this.value.title = value;
      });
    });

    renderTaskScheduleForm(contentEl, this.value, () => this.onOpen());

    new Setting(contentEl).setName("优先级").addDropdown((dropdown) => {
      dropdown
        .addOption("high", "高")
        .addOption("medium", "中")
        .addOption("low", "低")
        .addOption("none", "无")
        .setValue(this.value.priority ?? "medium")
        .onChange((value) => {
          this.value.priority = value as LifeOpsTaskPriority;
        });
    });

    new Setting(contentEl).setName("四象限").addDropdown((dropdown) => {
      dropdown
        .addOption("important-urgent", "重要且紧急")
        .addOption("important-not-urgent", "重要不紧急")
        .addOption("not-important-urgent", "不重要但紧急")
        .addOption("not-important-not-urgent", "不重要不紧急")
        .setValue(this.value.quadrant ?? "important-urgent")
        .onChange((value) => {
          this.value.quadrant = value as LifeOpsTaskQuadrant;
        });
    });

    let toggleLearning = (_enabled: boolean) => {};
    new Setting(contentEl).setName("分类").addDropdown((dropdown) => {
      const currentCategory = this.value.category?.trim() || "work";
      for (const category of taskCategoryOptions(currentCategory)) {
        dropdown.addOption(category, TASK_CATEGORIES[category as keyof typeof TASK_CATEGORIES] ?? category);
      }
      dropdown.setValue(currentCategory).onChange((value) => {
        this.value.category = value;
        if (value !== "learning") this.value.learningTrackId = undefined;
        toggleLearning(value === "learning");
      });
    });
    new Setting(contentEl).setName("学习轨道").setDesc("学习类任务可指定方向，完成后同步到该轨道。").addDropdown(dropdown => {
      dropdown.addOption("", "未指定");
      for (const [id, name] of Object.entries(LEARNING_TRACKS)) dropdown.addOption(id, name);
      dropdown.setValue(this.value.learningTrackId ?? "").setDisabled(this.value.category !== "learning").onChange(value => {
        this.value.learningTrackId = isLearningTrackId(value) ? value : undefined;
      });
      toggleLearning = enabled => {
        dropdown.setDisabled(!enabled);
        if (!enabled) dropdown.setValue("");
      };
    });

    new Setting(contentEl).setName("估计时长").setDesc("分钟，留空时按历史记录估算。").addText(text => {
      text.inputEl.type = "number";
      text.inputEl.min = "1";
      text.setValue(this.value.estimateMin === undefined ? "" : String(this.value.estimateMin)).onChange(value => {
        this.value.estimateMin = value.trim() ? Number(value) : undefined;
      });
    });

    new Setting(contentEl).setName("项目").addText((text) => {
      text.setValue(this.value.project ?? "默认").onChange((value) => {
        this.value.project = value;
      });
    });

    new Setting(contentEl).setName("重复").setDesc("完成后自动生成下一次任务。").addDropdown((dropdown) => {
      dropdown
        .addOption("none", "不重复")
        .addOption("day", "按天")
        .addOption("week", "按周")
        .addOption("month", "按月")
        .setValue(this.value.repeatUnit ?? "none")
        .onChange((value) => {
          this.value.repeatUnit = value as LifeOpsTaskRepeatUnit;
        });
    });

    new Setting(contentEl).setName("重复间隔").setDesc("例如：1 表示每天/每周/每月，2 表示每 2 天/周/月。").addText((text) => {
      text.setValue(String(this.value.repeatInterval ?? 1)).setPlaceholder("1").onChange((value) => {
        const parsed = Number(value);
        this.value.repeatInterval = Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : 1;
      });
    });

    new Setting(contentEl).setName("重复截止").setDesc("可选，超过这个日期后不再生成下一次。").addText((text) => {
      setupDateInput(text.inputEl);
      text.setValue(this.value.repeatUntil ?? "").setPlaceholder("2026-12-31").onChange((value) => {
        this.value.repeatUntil = value.trim();
      });
    });

    new Setting(contentEl).setName("备注").addTextArea((text) => {
      text.inputEl.rows = 4;
      text.setValue(this.value.note ?? "").setPlaceholder("可选").onChange((value) => {
        this.value.note = value;
      });
    });

    const error = contentEl.createDiv({ cls: "lifeops-task-form-error", attr: { role: "alert" } });
    new Setting(contentEl).addButton((button) => {
      button.setButtonText(this.labels.submit ?? "保存任务").setCta().onClick(async () => {
        if (!this.value.title.trim()) return;
        try {
          const schedule=taskScheduleInput({...this.value});
          button.setDisabled(true);
          await this.onSubmit({ ...this.value,...schedule });
          this.close();
        } catch (failure) {
          error.setText(failure instanceof Error ? failure.message : "没有保存，请重试；原有记录已保留。");
          button.setDisabled(false);
        }
      });
    });
  }
}

export class CalendarNoteModal extends Modal {
  private value = "";

  constructor(app: import("obsidian").App, private readonly date: string, private readonly onSubmit: (value: string) => Promise<void>) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lifeops-form-modal");
    contentEl.createEl("h2", { text: `${this.date} 备注` });
    new Setting(contentEl).setName("当天备注").setDesc("保存后写入当天日记的“日记”小节。").addTextArea((text) => {
      text.setPlaceholder("记录当天安排、提醒、想法或复盘线索");
      text.inputEl.rows = 7;
      text.inputEl.style.width = "100%";
      text.onChange((value) => {
        this.value = value;
      });
    });
    new Setting(contentEl).addButton((button) => {
      button.setButtonText("保存备注").setCta().onClick(async () => {
        if (!this.value.trim()) return;
        await this.onSubmit(this.value);
        this.close();
      });
    });
  }
}

export interface TaskActions {
  complete(note?: string): Promise<void>;
  completeAndLog(note?: string): Promise<void>;
  edit(): void;
  abandon(): Promise<void>;
  skipRepeat(): Promise<void>;
  stopRepeat(): Promise<void>;
  moveToDate(date: string): Promise<void>;
  postpone(days: number): Promise<void>;
  duplicateToDate(date: string): Promise<void>;
  moveOrder(direction: "up" | "down"): Promise<void>;
  delete(): Promise<void>;
}

export class TaskActionsModal extends Modal {
  private targetDate = todayString();
  private completionNote = "";

  constructor(app: import("obsidian").App, private readonly task: LifeOpsTask, private readonly actions: TaskActions) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lifeops-task-actions-modal");
    contentEl.createEl("h2", { text: "任务详情" });
    contentEl.createDiv({ text: this.task.title, cls: "lifeops-modal-task-title" });

    const meta = contentEl.createDiv({ cls: "lifeops-modal-meta" });
    meta.createSpan({ text: this.task.date || "无日期" });
    if (taskScheduleLabel(this.task)) meta.createSpan({ text: taskScheduleLabel(this.task) });
    if (this.task.dueDate) meta.createSpan({ text: this.task.dueTime ? `截止 ${this.task.dueDate} ${this.task.dueTime}` : `截止 ${this.task.dueDate}` });
    if (this.task.repeatUnit !== "none") meta.createSpan({ text: repeatLabel(this.task) });
    meta.createSpan({ text: this.task.project });
    meta.createSpan({ text: this.task.category });

    const overview = contentEl.createDiv({ cls: `lifeops-modal-status-banner status-${this.task.status}` });
    overview.createDiv({ text: taskStatusLabel(this.task.status), cls: "lifeops-modal-status-title" });
    overview.createDiv({ text: taskStatusCopy(this.task), cls: "lifeops-modal-status-copy" });

    contentEl.createEl("h3", { text: "任务档案" });
    const detail = contentEl.createDiv({ cls: "lifeops-modal-detail-grid" });
    this.detailItem(detail, "状态", taskStatusLabel(this.task.status));
    this.detailItem(detail, "安排", this.task.endDate ? `${this.task.date || "无日期"} -> ${this.task.endDate}` : this.task.date || "无日期");
    this.detailItem(detail, "计划时段", taskScheduleLabel(this.task) || "未安排时间");
    this.detailItem(detail, "截止", this.task.dueDate ? `${this.task.dueDate}${this.task.dueTime ? ` ${this.task.dueTime}` : ""}` : "未设置");
    this.detailItem(detail, "重复", this.task.repeatUnit === "none" ? "不重复" : repeatLabel(this.task));
    this.detailItem(detail, "象限", quadrantLabel(this.task.quadrant));
    this.detailItem(detail, "来源", this.task.source || "obsidian");
    this.detailItem(detail, "创建", formatDateTime(this.task.createdAt));
    this.detailItem(detail, "更新", formatDateTime(this.task.updatedAt));
    if (this.task.completedAt) this.detailItem(detail, "完成", formatDateTime(this.task.completedAt));
    if (this.task.note) {
      contentEl.createEl("h3", { text: "任务备注" });
      contentEl.createDiv({ text: this.task.note, cls: "lifeops-modal-note" });
    }

    if (this.task.status === "active") {
      new Setting(contentEl).setName("完成备注").setDesc("可选。点击完成时会写入任务完成记录。").addTextArea((text) => {
        text.inputEl.rows = 3;
        text.inputEl.style.width = "100%";
        text.setPlaceholder("这次完成的结果、问题或复盘线索");
        text.onChange((value) => {
          this.completionNote = value;
        });
      });

      contentEl.createEl("h3", { text: "快捷操作" });
      const quick = contentEl.createDiv({ cls: "lifeops-modal-action-grid" });
      this.modalButton(quick, "完成", async () => this.actions.complete(this.completionNote));
      this.modalButton(quick, "完成并记", async () => this.actions.completeAndLog(this.completionNote));
      this.modalButton(quick, "编辑详情", async () => this.actions.edit(), false);
      this.modalButton(quick, "放弃", async () => this.actions.abandon());
    } else {
      contentEl.createEl("h3", { text: "快捷操作" });
      const quick = contentEl.createDiv({ cls: "lifeops-modal-action-grid" });
      this.modalButton(quick, "编辑详情", async () => this.actions.edit(), false);
      this.modalButton(quick, "复制到明天", async () => this.actions.duplicateToDate(addDays(todayString(), 1)));
    }

    if (this.task.status === "active" && this.task.repeatUnit !== "none") {
      contentEl.createEl("h3", { text: "重复管理" });
      const repeat = contentEl.createDiv({ cls: "lifeops-modal-action-grid" });
      this.modalButton(repeat, "跳过本次", async () => this.actions.skipRepeat());
      this.modalButton(repeat, "复制下一次", async () => this.actions.duplicateToDate(nextRepeatDate(this.task)));
      this.modalButton(repeat, "停止重复", async () => this.actions.stopRepeat(), true);
    }

    if (this.task.status === "active") {
      contentEl.createEl("h3", { text: "日期流转" });
      const dates = contentEl.createDiv({ cls: "lifeops-modal-action-grid" });
      this.modalButton(dates, "移到今天", async () => this.actions.moveToDate(todayString()));
      this.modalButton(dates, "移到明天", async () => this.actions.moveToDate(addDays(todayString(), 1)));
      this.modalButton(dates, "移到本周五", async () => this.actions.moveToDate(endOfWeek(todayString())));
      this.modalButton(dates, "延后一天", async () => this.actions.postpone(1));
      this.modalButton(dates, "复制到明天", async () => this.actions.duplicateToDate(addDays(todayString(), 1)));
    }

    new Setting(contentEl).setName("指定日期").addText((text) => {
      setupDateInput(text.inputEl);
      text.setValue(this.task.date || todayString()).onChange((value) => {
        this.targetDate = value.trim();
      });
    }).addButton((button) => {
      button.setButtonText("移动").onClick(async () => {
        if (!this.targetDate) return;
        await this.actions.moveToDate(this.targetDate);
        this.close();
      });
    }).addButton((button) => {
      button.setButtonText("复制").onClick(async () => {
        if (!this.targetDate) return;
        await this.actions.duplicateToDate(this.targetDate);
        this.close();
      });
    });

    contentEl.createEl("h3", { text: "排序与删除" });
    const manage = contentEl.createDiv({ cls: "lifeops-modal-action-grid" });
    this.modalButton(manage, "上移", async () => this.actions.moveOrder("up"));
    this.modalButton(manage, "下移", async () => this.actions.moveOrder("down"));
    this.modalButton(manage, "删除任务", async () => {
      if (!window.confirm(`删除任务：${this.task.title}？`)) return;
      await this.actions.delete();
    }, true);

    contentEl.createEl("h3", { text: "完成记录" });
    const history = contentEl.createDiv({ cls: "lifeops-modal-history lifeops-modal-timeline" });
    const completionLog = this.task.completionLog?.length ? this.task.completionLog : this.task.completedAt ? [{ completedAt: this.task.completedAt, note: "" }] : [];
    if (completionLog.length === 0) {
      history.createDiv({ text: "暂时没有完成记录。", cls: "lifeops-muted" });
    } else {
      for (const item of completionLog.slice().reverse()) {
        const row = history.createDiv({ cls: "lifeops-modal-history-row" });
        row.createSpan({ text: formatDateTime(item.completedAt), cls: "lifeops-modal-history-time" });
        row.createSpan({ text: item.note || "完成任务", cls: "lifeops-modal-history-note" });
      }
    }
  }

  private detailItem(container: HTMLElement, label: string, value: string): void {
    const item = container.createDiv({ cls: "lifeops-modal-detail-item" });
    item.createSpan({ text: label });
    item.createEl("strong", { text: value });
  }

  private modalButton(container: HTMLElement, label: string, action: () => Promise<void> | void, danger = false): void {
    container.createEl("button", { text: label, cls: danger ? "lifeops-action-danger" : "" }, (button) => {
      button.onclick = async () => {
        await action();
        this.close();
      };
    });
  }
}

function taskStatusLabel(status: LifeOpsTask["status"]): string {
  if (status === "completed") return "已完成";
  if (status === "abandoned") return "已放弃";
  return "进行中";
}

function taskStatusCopy(task: LifeOpsTask): string {
  if (task.status === "completed") return task.completedAt ? `完成于 ${formatDateTime(task.completedAt)}` : "这个任务已经完成。";
  if (task.status === "abandoned") return "这个任务已放弃，仍会保留在历史记录里。";
  if (task.dueDate && task.dueDate < todayString()) return "已经超过截止日期，需要尽快处理或重新安排。";
  if (task.dueDate) return `截止于 ${task.dueDate}${task.dueTime ? ` ${task.dueTime}` : ""}。`;
  return "任务仍在进行中，可以完成、延期、移动或编辑。";
}

function quadrantLabel(quadrant: LifeOpsTask["quadrant"]): string {
  switch (quadrant) {
    case "important-urgent":
      return "重要且紧急";
    case "important-not-urgent":
      return "重要不紧急";
    case "not-important-urgent":
      return "不重要但紧急";
    default:
      return "不重要不紧急";
  }
}

function repeatLabel(task: LifeOpsTask): string {
  const unit = task.repeatUnit === "day" ? "天" : task.repeatUnit === "week" ? "周" : "月";
  const base = task.repeatInterval > 1 ? `每 ${task.repeatInterval} ${unit}` : `每${unit}`;
  return task.repeatUntil ? `${base}，至 ${task.repeatUntil}` : base;
}

function nextRepeatDate(task: LifeOpsTask): string {
  const base = task.date || todayString();
  if (task.repeatUnit === "month") return addMonths(base, task.repeatInterval);
  return addDays(base, task.repeatUnit === "week" ? task.repeatInterval * 7 : task.repeatInterval);
}

function addMonths(dateString: string, months: number): string {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(year, month - 1 + months, 1);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, lastDay));
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatDateTime(value: string): string {
  if (!value) return "未记录";
  return value.replace("T", " ").slice(0, 16);
}

function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(trimmed) ? Number(trimmed) : NaN;
}

export class HabitModal extends Modal {
  private value: HabitInput = {
    name: "",
    frequencyUnit: "day",
    frequencyInterval: 1,
    targetCount: 1,
    startDate: todayString(),
    penaltyThreshold: 3,
    color: "#27ae60"
  };

  constructor(
    app: import("obsidian").App,
    private readonly onSubmit: (value: HabitInput) => Promise<void>,
    defaults: Partial<HabitInput> = {},
    private readonly labels: { title?: string; submit?: string } = {}
  ) {
    super(app);
    this.value = { ...this.value, ...structuredClone(defaults) };
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lifeops-form-modal");
    contentEl.createEl("h2", { text: this.labels.title ?? "新建习惯" });

    new Setting(contentEl).setName("习惯名称").addText((text) => {
      text.setValue(this.value.name).setPlaceholder("例如：跑步 / 背单词 / 复盘").onChange((value) => {
        this.value.name = value;
      });
    });

    new Setting(contentEl).setName("频率单位").addDropdown((dropdown) => {
      dropdown
        .addOption("day", "按天")
        .addOption("week", "按周")
        .setValue(this.value.frequencyUnit)
        .onChange((value) => {
          this.value.frequencyUnit = value as HabitInput["frequencyUnit"];
        });
    });

    new Setting(contentEl).setName("间隔").setDesc("1=每天/每周，2=两天一次/两周一次，3=三天一次/三周一次。").addText((text) => {
      text.setValue(String(this.value.frequencyInterval)).onChange((value) => {
        this.value.frequencyInterval = Number(value) || 1;
      });
    });

    renderHabitTargetFields(contentEl, this.value);

    new Setting(contentEl).setName("开始日期").addText((text) => {
      setupDateInput(text.inputEl);
      text.setValue(this.value.startDate ?? todayString()).onChange((value) => {
        this.value.startDate = value.trim();
      });
    });

    renderHabitPunishmentFields(contentEl, this.value);

    new Setting(contentEl).setName("颜色").addText((text) => {
      text.setValue(this.value.color ?? "#27ae60").onChange((value) => {
        this.value.color = value.trim() || "#27ae60";
      });
    });

    new Setting(contentEl).addButton((button) => {
      button.setButtonText(this.labels.submit ?? "保存习惯").setCta().onClick(async () => {
        if (!this.value.name.trim()) return;
        try {
          await this.onSubmit(this.value);
          this.close();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "暂时无法保存习惯。");
        }
      });
    });
  }
}

export interface HabitCheckinInput {
  status: HabitCheckinStatus;
  date: string;
  note: string;
  value?: number;
}

export class HabitCheckinModal extends Modal {
  private value: HabitCheckinInput = {
    status: "done",
    date: todayString(),
    note: ""
  };

  constructor(
    app: import("obsidian").App,
    private readonly habit: HabitDefinition,
    private readonly onSubmit: (value: HabitCheckinInput) => Promise<void>,
    defaults: Partial<HabitCheckinInput> = {}
  ) {
    super(app);
    this.value = { ...this.value, ...defaults };
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lifeops-form-modal");
    contentEl.createEl("h2", { text: "记录打卡" });
    contentEl.createEl("p", {
      text: `${this.habit.name} · ${habitFrequencyLabel(this.habit)}。可补记日期，也可以给这次打卡留下备注。`
    });

    new Setting(contentEl).setName("状态").addDropdown((dropdown) => {
      dropdown
        .addOption("done", "完成")
        .addOption("missed", "未完成")
        .addOption("leave", "请假")
        .setValue(this.value.status)
        .onChange((value) => {
          this.value.status = value as HabitCheckinStatus;
        });
    });

    new Setting(contentEl).setName("日期").addText((text) => {
      setupDateInput(text.inputEl);
      text.setValue(this.value.date).setPlaceholder(todayString()).onChange((value) => {
        this.value.date = value.trim() || todayString();
      });
    });

    if (this.habit.target?.kind === "number") {
      new Setting(contentEl).setName(`实际数值（${this.habit.target.unit}）`).setDesc("记录完成时填写本次实际量。").addText(text => {
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        text.inputEl.step = "any";
        text.setValue(this.value.value === undefined ? "" : String(this.value.value)).onChange(value => {
          this.value.value = value.trim() ? Number(value) : undefined;
        });
      });
    }

    new Setting(contentEl).setName("备注").addTextArea((text) => {
      text.inputEl.rows = 4;
      text.inputEl.style.width = "100%";
      text.setPlaceholder("例如：跑了 5 公里；状态不好但完成了；今天请假原因。").onChange((value) => {
        this.value.note = value;
      });
    });

    new Setting(contentEl).addButton((button) => {
      button.setButtonText("保存记录").setCta().onClick(async () => {
        try {
          const { value, ...entry } = this.value;
          await this.onSubmit(entry.status === "done" && value !== undefined ? { ...entry, value } : entry);
          this.close();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "暂时无法保存打卡。");
        }
      });
    });
  }
}

export class HabitDetailModal extends Modal {
  constructor(app: import("obsidian").App, private readonly item: HabitDashboardItem) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const { habit } = this.item;
    const fromDevice = isHealthHabitSource(habit.source);
    const done = this.item.history.filter((checkin) => checkin.status === "done");
    const missed = this.item.history.filter((checkin) => checkin.status === "missed");
    const leave = this.item.history.filter((checkin) => checkin.status === "leave");
    const sevenDays = habitWindowStats(this.item, 7);
    const thirtyDays = habitWindowStats(this.item, 30);
    const totalDone = done.reduce((sum, checkin) => sum + Math.max(1, checkin.count || 1), 0);
    const sortedHistory = this.item.history.slice().sort((a, b) => b.date.localeCompare(a.date));

    contentEl.empty();
    contentEl.addClass("lifeops-habit-detail-modal");
    contentEl.style.setProperty("--habit-color", habit.color);
    contentEl.createEl("h2", { text: "习惯档案" });
    if (this.item.periodUnavailable) {
      contentEl.createEl("p", { text: "交易记录暂不可用，进度未知。" });
      return;
    }
    if (this.item.healthCoveragePartial) contentEl.createEl("p", { text: "只统计可读的健康记录", cls: "lifeops-muted" });

    const hero = contentEl.createDiv({ cls: `lifeops-habit-modal-hero status-${this.item.status}` });
    const heroCopy = hero.createDiv();
    heroCopy.createDiv({ text: habit.name, cls: "lifeops-habit-modal-title" });
    heroCopy.createDiv({
      text: `${habitFrequencyLabel(habit)} · ${habitRequirementLabel(this.item)} · 连续 ${this.item.streak} 天`,
      cls: "lifeops-habit-modal-subtitle"
    });
    const status = hero.createDiv({ cls: `lifeops-habit-modal-pill status-${this.item.status}` });
    status.createSpan({ text: habitStatusLabel(this.item.status) });

    const stats = contentEl.createDiv({ cls: "lifeops-habit-modal-grid" });
    const progress = this.item.healthUnrecorded ? "还没有健康记录" : `${this.item.periodDone}/${this.item.periodTarget} ${this.item.periodUnit ?? "次"}`;
    this.statItem(stats, `${this.item.periodLabel}进度`, progress);
    if (fromDevice) this.statItem(stats, "有读数", `${healthHabitReadingDays(habit, this.item.history)} 天`);
    else this.statItem(stats, "累计完成", `${totalDone} ${habit.source === "trades" ? "笔" : "次"}`);
    this.statItem(stats, "本周未完成", `${this.item.weeklyFailures} 次`);
    this.statItem(stats, "7天完成", `${sevenDays.done}/${sevenDays.required}`);
    this.statItem(stats, "30天完成", `${thirtyDays.done}/${thirtyDays.required}`);
    this.statItem(stats, "30天完成率", thirtyDays.rate === null ? "暂无数据" : `${thirtyDays.rate}%`);

    contentEl.createEl("h3", { text: "规则" });
    const rules = contentEl.createDiv({ cls: "lifeops-modal-detail-grid" });
    this.detailItem(rules, "频率", habitFrequencyLabel(habit));
    this.detailItem(rules, "开始日期", habit.startDate || "未设置");
    if (habit.target?.kind === "number") {
      for (const { period, goal } of numericHabitPeriods(habit)) {
        this.detailItem(rules, period === "day" ? "每日目标" : "每周目标", `${goal} ${habit.target.unit}`);
      }
    } else this.detailItem(rules, "周期目标", `${habit.targetCount} 次`);
    this.detailItem(rules, "补偿待办", habit.punishment?.enabled ? "已启用" : "未启用");
    this.detailItem(rules, "创建时间", formatDateTime(habit.createdAt));
    this.detailItem(rules, "颜色", habit.color);

    contentEl.createEl("h3", { text: "最近 30 天趋势" });
    const trend = contentEl.createDiv({ cls: "lifeops-habit-modal-trend" });
    for (const date of lastDates(30)) {
      const checkin = this.item.history.find((entry) => entry.date === date);
      const required = isHabitRequiredOnDate(habit, date);
      const display = automaticHabitDayDisplay(habit, checkin);
      trend.createDiv({
        text: dayNumber(date),
        cls: [
          "lifeops-habit-trend-cell",
          checkin ? `status-${display?.status ?? checkin.status}` : "",
          required ? "is-required" : "is-optional"
        ].filter(Boolean).join(" "),
        attr: { title: `${date} ${display?.label ?? (checkin ? habitStatusLabel(checkin.status) : required ? "未打卡" : "非必需")}` }
      });
    }

    const recentNotes = sortedHistory.filter((checkin) => checkin.note.trim()).slice(0, 6);
    if (recentNotes.length > 0) {
      contentEl.createEl("h3", { text: "最近备注" });
      const notes = contentEl.createDiv({ cls: "lifeops-habit-modal-history" });
      for (const checkin of recentNotes) {
        const row = notes.createDiv({ cls: `lifeops-habit-modal-row status-${checkin.status}` });
        row.createSpan({ text: checkin.date, cls: "lifeops-habit-modal-date" });
        row.createSpan({ text: checkin.note, cls: "lifeops-habit-modal-note" });
      }
    }

    contentEl.createEl("h3", { text: "记录汇总" });
    const summary = contentEl.createDiv({ cls: "lifeops-habit-modal-grid compact" });
    if (!fromDevice) this.statItem(summary, "完成日期", `${done.length} 天`);
    this.statItem(summary, "未完成", `${missed.length} 天`);
    this.statItem(summary, "请假", `${leave.length} 天`);
    this.statItem(summary, "记录总数", `${this.item.history.length} 条`);

    contentEl.createEl("h3", { text: "完整历史" });
    const history = contentEl.createDiv({ cls: "lifeops-habit-modal-history" });
    if (sortedHistory.length === 0) {
      history.createDiv({ text: "暂时没有打卡历史。", cls: "lifeops-muted" });
      return;
    }
    for (const checkin of sortedHistory.slice(0, 120)) {
      const measured = automaticHabitDayDisplay(habit, checkin);
      const status = measured?.status ?? checkin.status;
      const label = measured?.label ?? `${habitStatusLabel(checkin.status)}${checkin.count > 1 ? ` x${checkin.count}` : ""}`;
      const row = history.createDiv({ cls: `lifeops-habit-modal-row status-${status}` });
      row.createSpan({ text: checkin.date, cls: "lifeops-habit-modal-date" });
      row.createSpan({ text: label, cls: `lifeops-habit-modal-pill status-${status}` });
      row.createSpan({ text: checkin.note || formatDateTime(checkin.updatedAt), cls: "lifeops-habit-modal-note" });
    }
    if (sortedHistory.length > 120) {
      history.createDiv({ text: `还有 ${sortedHistory.length - 120} 条更早记录未显示。`, cls: "lifeops-muted" });
    }
  }

  private statItem(container: HTMLElement, label: string, value: string): void {
    const item = container.createDiv({ cls: "lifeops-habit-modal-stat" });
    item.createSpan({ text: label });
    item.createEl("strong", { text: value });
  }

  private detailItem(container: HTMLElement, label: string, value: string): void {
    const item = container.createDiv({ cls: "lifeops-modal-detail-item" });
    item.createSpan({ text: label });
    item.createEl("strong", { text: value });
  }
}

function habitStatusLabel(status: HabitCheckinStatus | "pending"): string {
  switch (status) {
    case "done":
      return "完成";
    case "missed":
      return "未完成";
    case "leave":
      return "请假";
    case "pending":
      return "待打卡";
  }
}

function setupDateInput(input: HTMLInputElement): void {
  input.type = "date";
  input.addEventListener("pointerdown", () => {
    try {
      input.showPicker?.();
    } catch {
      // Native date inputs still work when showPicker is unavailable.
    }
  });
}

function setupTimeInput(input: HTMLInputElement): void {
  input.type = "time";
  input.addEventListener("pointerdown", () => {
    try {
      input.showPicker?.();
    } catch {
      // Native time inputs still work when showPicker is unavailable.
    }
  });
}

function taskCategoryOptions(current: string): string[] {
  const presets = Object.keys(TASK_CATEGORIES).filter(category => category !== "punishment" || current === category);
  return presets.includes(current) ? presets : [current, ...presets];
}

function habitFrequencyLabel(habit: HabitDefinition): string {
  const unit = habit.frequencyUnit === "week" ? "周" : "天";
  const base = habit.frequencyInterval === 1 ? (habit.frequencyUnit === "week" ? "每周" : "每天") : `每 ${habit.frequencyInterval} ${unit}`;
  return `${base} ${habit.targetCount} 次`;
}

function habitRequirementLabel(item: HabitDashboardItem): string {
  if (item.periodLabel === "本周") {
    return item.periodDone >= item.periodTarget ? "本周已达标" : "本周待完成";
  }
  return item.requiredToday ? "今日应打卡" : "今日非必需";
}

function habitWindowStats(item: HabitDashboardItem, days: number): { required: number; done: number; rate: number | null } {
  const dates = lastDates(days);
  if (item.habit.target?.kind === "number") {
    return numericHabitWindow(item.habit, item.history, dates.filter(date => isHabitRequiredOnDate(item.habit, date)), dates);
  }
  if (item.habit.frequencyUnit === "week") {
    const weeks = new Map<string, string[]>();
    for (const date of dates) {
      const week = weekDates(date);
      const weekKey = week.join(",");
      if (!weeks.has(weekKey)) {
        weeks.set(weekKey, week);
      }
    }
    const activeWeeks = Array.from(weeks.values()).filter((week) => week.some((date) => isHabitRequiredOnDate(item.habit, date)));
    const required = activeWeeks.length * item.habit.targetCount;
    const done = activeWeeks.reduce((sum, week) => {
      const weekDone = item.history
        .filter((entry) => week.includes(entry.date) && entry.status === "done")
        .reduce((count, entry) => count + Math.max(1, entry.count || 1), 0);
      return sum + Math.min(item.habit.targetCount, weekDone);
    }, 0);
    return {
      required,
      done,
      rate: required === 0 ? 100 : Math.round((done / required) * 100)
    };
  }
  const requiredDates = dates.filter((date) => isHabitRequiredOnDate(item.habit, date));
  const done = requiredDates.filter((date) => {
    const checkin = item.history.find((entry) => entry.date === date);
    return checkin?.status === "done";
  }).length;
  return {
    required: requiredDates.length,
    done,
    rate: requiredDates.length === 0 ? 100 : Math.round((done / requiredDates.length) * 100)
  };
}

function lastDates(days: number): string[] {
  const start = addDays(todayString(), -(days - 1));
  return Array.from({ length: days }, (_, index) => addDays(start, index));
}

function dayNumber(dateString: string): string {
  return String(Number(dateString.slice(8, 10)));
}
