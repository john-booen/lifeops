# MOSS-Live 隔离对照

这是独立的合成录音比较工具，尚未接入日用插件。先比较姓名、时间纠正和流式回复，再决定是否值得接入；默认语音继续按现有设置使用。

实现依据为[MOSS 官方实时协议](https://platform.moss.cn/docs/reference/moss-live/)和[模型说明](https://platform.moss.cn/docs/models/moss-live-1.0)，核对日期2026-11-22。使用固定快照 `moss-live-1.0-2026-11-02`，仅会话记忆、关闭委派和工具。音频采用16 kHz单声道PCM输入、48 kHz PCM输出，服务器负责播放进度；本工具不创建麦克风或播放器。连接按服务条款计费，以控制台账单为准。

## 准备与运行

先准备已有的全虚构合成PCM夹具：`TEST_VAULT_ONLY.md`说明内容全部为虚构数据，`cases.json`列出样本ID、原句、预期和PCM SHA256，对应音频为`<id>.pcm`。旧语音对照的数组格式和本工具的对象格式均可复制。必须明确它是合成录音，不使用私人录音代替。

`MOSS_TRIAL_SOURCE`指向原夹具，`MOSS_TRIAL_FIXTURE`指向系统临时目录下尚不存在的`lifeops-moss-fictional-任意标识`目录。

```sh
node scripts/eval/prepare-moss-trial.mjs --from "$MOSS_TRIAL_SOURCE" --output "$MOSS_TRIAL_FIXTURE" --synthetic-only
node scripts/eval/moss-live-trial.mjs --preflight --fixture "$MOSS_TRIAL_FIXTURE" --config "$MOSS_TRIAL_FIXTURE/.obsidian/plugins/lifeops-assistant/data.json"
```

准备器不读取原夹具的密钥，也不覆盖已有目录。它生成空的独立MOSS配置，预检退出码2表示缺少对应条件，尚未建立连接。在新夹具的插件`data.json`内配置`mossLiveTrial`：

- `apiKey`：独立MOSS密钥，留在本机插件设置，不发到聊天或提交仓库。
- `syntheticAudioDisclosureAccepted`：确认将所选虚构录音发给MOSS后设为`true`。
- `plaintextCredentialStorageAccepted`：接受该虚构库插件设置的本地明文存储后设为`true`。
- `authorizationOrigin`：明确准用MOSS时填写`wss://api.mosi.cn`。

保留生成的官方地址与模型。预检退出码0后，可显式运行一次：

```sh
node scripts/eval/moss-live-trial.mjs --run --fixture "$MOSS_TRIAL_FIXTURE" --config "$MOSS_TRIAL_FIXTURE/.obsidian/plugins/lifeops-assistant/data.json"
```

最多一条连接，默认60秒、硬上限90秒；最多4段、共30秒输入。不会自动重连或转用其他服务。Ctrl+C会终止并关闭连接。每次运行保留一个新的`moss-trial-*.json`，包括转写、修订、响应终态、音频字节数、时序与资源关闭状态。

## 怎么判断

固定录音与预期在运行前锁定哈希，转写和最终回复分别核对姓名、时间的预先列明等价表达；纠正样本可用`replyMustNotInclude`拒绝回复中的旧时刻，避免只因转写出现了新时刻便判通过。要在已有回复音频期间发送第二段，可给后一段标记`after: "reply_audio"`；工具会等待前一条音频开始，并要求对应回复出现停止及中断终态。语音活动事件本身不会被当作中断；中断事件也不单独证明语义识别正确。

正常完成与中途取消已经过真实回环WebSocket路径验证，回环结果标记`injected-test`，不计为真实模型效果。真实MOSS识别率、语义打断、真人听感及LifeOps任务执行仍分别待验；收到音频不等于实际播放，工具汇总也不等于任务已执行。没有独立MOSS配置时，预检会停在建立连接之前。
