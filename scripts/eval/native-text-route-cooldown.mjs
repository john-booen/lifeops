import assert from "node:assert/strict";
import { createServer } from "node:http";

/** Actual UI and provider adapters against loopback-only synthetic responses. */
export async function nativeTextRouteCooldown(page, result) {
  const posts = [], server = createServer(async (request, response) => {
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS" };
    if (request.method === "OPTIONS") { response.writeHead(204, headers); response.end(); return; }
    try {
      assert.equal(request.method, "POST"); assert(["/primary", "/fallback"].includes(request.url));
      let body = ""; for await (const chunk of request) { body += chunk; assert(body.length < 2_000_000); }
      const data = JSON.parse(body); assert(["native-primary", "native-fallback"].includes(data.model));
      posts.push(data.model); assert(posts.length <= 6);
      if (request.url === "/primary") {
        response.writeHead(429, { ...headers, "Content-Type": "application/json" }); response.end('{"error":{"message":"fictional limit"}}'); return;
      }
      const content = "本机合成渠道已回复，未保存记录。";
      if (data.stream) {
        response.writeHead(200, { ...headers, "Content-Type": "text/event-stream" });
        response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] }) + '\n\ndata: [DONE]\n\n');
      } else {
        response.writeHead(200, { ...headers, "Content-Type": "application/json" });
        response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }));
      }
    } catch { response.writeHead(400, headers); response.end("Invalid fictional fixture request"); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const address = server.address(); assert(address && typeof address === "object");
    const state = await page.evaluate(async base => {
      const p = app.plugins.getPlugin("lifeops-assistant"), original = globalThis.__lifeOpsNativeOriginalTextTurn;
      if (typeof original !== "function") throw Error("Native text entry missing");
      const saved = p.ai, settings = structuredClone(p.settings), configured = JSON.stringify(p.settings.ai);
      settings.ai = { ...settings.ai, provider: "custom", endpoint: base + "/primary", model: "native-primary", apiKey: "fictional-primary-key",
        fallbackProvider: "deepseek", fallbackEndpoint: base + "/fallback", fallbackModel: "native-fallback", fallbackApiKey: "fictional-fallback-key", dataDisclosureAccepted: true };
      settings.privacy = { ...settings.privacy, plaintextCredentialStorageAccepted: true };
      const probe = new saved.constructor(settings), runs = [];
      probe.agentTurnStream = async (...args) => { const value = await original.apply(probe, args); runs.push(value.providerRun); return value; };
      const view = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
      const before = await p.store.readPath(p.store.taskDbPath());
      try {
        p.ai = probe; view.agentMessages = []; view.pendingAgentActions = []; view.agentMode = "text"; await view.navigateSteward("chat");
        const replies = [];
        for (const input of ["用一句话描述虚构紫色纸盒。", "接着用一句话描述虚构绿色纸盒。"]) {
          view.setAgentInput(input); await view.sendAgentMessage(); replies.push(view.agentReply);
        }
        return { runs, replies, unchanged: before === await p.store.readPath(p.store.taskDbPath()),
          settingsUnchanged: configured === JSON.stringify(p.settings.ai), providers: p.activeProviderRequests.size };
      } finally { p.ai = saved; view.agentMessages = []; view.pendingAgentActions = []; }
    }, "http://127.0.0.1:" + address.port);
    assert.deepEqual(posts, ["native-primary", "native-fallback", "native-fallback"]);
    assert(state.replies.every(text => text.includes("本机合成渠道已回复")));
    assert.equal(state.runs.length, 2); assert.equal(state.runs[0].attempts.length, 2); assert.equal(state.runs[1].attempts.length, 1);
    for (const run of state.runs) assert(run.status === "success" && run.fallbackUsed && run.requestedModel === "native-primary" && run.actualModel === "native-fallback");
    assert(state.unchanged && state.settingsUnchanged && state.providers === 0);
    result.checks.nativeTextRateLimitUsesConfiguredFallbackOnNextTurn = true;
    result.checks.nativeTextCooldownPreservesFactsSettingsAndTruthfulRouting = true;
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
