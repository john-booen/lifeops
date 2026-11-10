const net = require("node:net");

const guardKey = Symbol.for("lifeops.offline.network.guard");
if (!globalThis[guardKey]) {
  globalThis[guardKey] = true;
  const originalConnect = net.Socket.prototype.connect;
  const originalCreateConnection = net.createConnection;

  net.Socket.prototype.connect = function guardedConnect(...args) {
    const target = connectionTarget(args);
    if (target.kind === "unix" || isLoopback(target.host)) {
      return originalConnect.apply(this, args);
    }
    throw new Error(`[LifeOps offline guard] blocked external TCP connection to ${target.host || "unknown"}:${target.port || "unknown"}`);
  };

  const guardedCreateConnection = function guardedCreateConnection(...args) {
    const target = connectionTarget(args);
    if (target.kind === "unix" || isLoopback(target.host)) {
      return originalCreateConnection.apply(net, args);
    }
    throw new Error(`[LifeOps offline guard] blocked external TCP connection to ${target.host || "unknown"}:${target.port || "unknown"}`);
  };
  net.connect = guardedCreateConnection;
  net.createConnection = guardedCreateConnection;

  globalThis.fetch = async function blockedFetch(input) {
    throw new Error(`[LifeOps offline guard] blocked fetch: ${String(input)}`);
  };
}

function connectionTarget(args) {
  const first = args[0];
  if (typeof first === "string") return { kind: "unix", host: "", port: "" };
  if (typeof first === "number") {
    return { kind: "tcp", host: typeof args[1] === "string" ? args[1] : "localhost", port: first };
  }
  if (first && typeof first === "object") {
    if (typeof first.path === "string") return { kind: "unix", host: "", port: "" };
    return { kind: "tcp", host: first.host || first.hostname || "localhost", port: first.port || "" };
  }
  return { kind: "tcp", host: "unknown", port: "" };
}

function isLoopback(host) {
  const value = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}
