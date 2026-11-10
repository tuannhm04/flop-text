#!/usr/bin/env node
// flop-text: translate, summarize and ask on FLOP devnet inference.
// Gateway mode uses an API key. Direct mode runs the official `flop session run`
// so the channel is opened and paid by your own wallet.
import { readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const VERSION = "0.2.0";
const GATEWAY = (process.env.FLOP_GATEWAY_URL || "https://api.flop.network/v1").replace(/\/$/, "");
const EXPLORER = (process.env.FLOP_EXPLORER_URL || "https://explorer.devnet.flop.network").replace(/\/$/, "");
const RPC = process.env.FLOP_RPC_URL || "wss://rpc.devnet.flop.network";
const LOOKUP = "https://flop.trackingport.com/channel?id=";
const GATEWAY_ACCOUNT = "5GsXb3TmNGixuEsbtixqHnqWr9UQJ2M8bkqBQWteNekgF98S";
const ATTEST_PREFIX = "0xeb2bab4b65eab04f2cc4c3dc46706fa7c23781d711d0b132d19075ebf1516ee3";
const DEFAULT_MODEL = "qwen/qwen2.5-0.5b-instruct";
const HOME = process.env.FLOP_TEXT_HOME || join(homedir(), ".flop-text");
const HISTORY = join(HOME, "history.jsonl");
const MAX_INPUT = 6000;
const CHANNEL_ID = /^0x[0-9a-fA-F]{64}$/;

const lang = (v, d) => String(v || d).replace(/[^\p{L} -]/gu, "").trim().slice(0, 30) || d;
const TASKS = {
  translate: (text, o) => [
    { role: "system", content: "Translate the user's text into natural " + lang(o.to, "English") + ". Reply with the translation only." },
    { role: "user", content: text },
  ],
  summarize: (text, o) => [
    { role: "system", content: "Summarize the text in " + lang(o.lang, "English") + " in at most 3 short bullet points. Don't add anything that isn't in the text." },
    { role: "user", content: text },
  ],
  ask: (text, o) => [
    { role: "system", content: "You are a concise assistant. Answer in " + lang(o.lang, "English") + ". If you aren't sure, say so." },
    { role: "user", content: text },
  ],
};

const HELP = `flop-text ${VERSION}: translate, summarize and ask on FLOP devnet inference

Usage
  flop-text translate "text" [--to LANGUAGE]     default English
  flop-text summarize FILE|-|"text" [--lang LANGUAGE]
  flop-text ask "question" [--lang LANGUAGE]
  flop-text channel [CHANNEL_ID]                 settlement of a call (default: your last call)
  flop-text history                              your last 10 calls
  flop-text models                               models the gateway lists
  flop-text check                                read-only readiness check

Options
  --mode gateway|direct   default gateway
  --model SLUG            default ${DEFAULT_MODEL}
  --max-tokens N          1 to 2000, default 200
  --retries N             retries when the gateway is busy or down, default 2
  --wait SECONDS          wait between retries, default 20
  --no-save               don't record this call in history
  --json                  print the full result as JSON
  --help, --version

Gateway mode
  FLOP_API_KEY            gateway API key (or FLOP_KEY_FILE, a JSON file with "key")
Direct mode (your wallet opens and pays the channel)
  --miner SS58 --endpoint URL   a miner that serves the model and exposes its session endpoint
  --max-flop N            escrow ceiling in FLOP, default 0.5, at most 5
  FLOP_KEYSTORE, FLOP_PASSWORD_ENV   keystore path and the name of the env var holding its password
  FLOP_CLI                path to the flop CLI, default "flop" on PATH

History is kept in ${HISTORY}. It stores the time, command, model, channel ID and cost,
never your text or keys.
`;

class UsageError extends Error {}

const FLAGS = new Set(["json", "no-save", "help", "version"]);
const VALUED = new Set(["mode", "model", "max-tokens", "retries", "wait", "to", "lang", "miner", "endpoint", "max-flop"]);
const parseArgs = (argv) => {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") { o.help = true; continue; }
    if (!a.startsWith("--")) { o._.push(a); continue; }
    const k = a.slice(2);
    if (FLAGS.has(k)) { o[k] = true; continue; }
    if (!VALUED.has(k)) { throw new UsageError("Unknown option " + a + ". Run flop-text --help."); }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) { throw new UsageError("Missing value for " + a + "."); }
    o[k] = v; i++;
  }
  return o;
};

const intOpt = (o, k, d, lo, hi) => {
  if (o[k] === undefined) { return d; }
  const n = Number(o[k]);
  if (!/^\d+$/.test(o[k]) || n < lo || n > hi) { throw new UsageError("--" + k + " must be a whole number from " + lo + " to " + hi + "."); }
  return n;
};

const readInput = async (arg) => {
  if (arg === "-") { const chunks = []; for await (const c of process.stdin) { chunks.push(c); } return Buffer.concat(chunks).toString("utf8").trim(); }
  if (arg && arg.length < 300 && !arg.includes("\n") && existsSync(arg)) { return readFileSync(arg, "utf8").trim(); }
  return (arg || "").trim();
};

const gatewayKey = () => {
  if (process.env.FLOP_API_KEY) { return process.env.FLOP_API_KEY.trim(); }
  if (process.env.FLOP_KEY_FILE) {
    let j; try { j = JSON.parse(readFileSync(process.env.FLOP_KEY_FILE, "utf8")); } catch (e) { throw new Error("Couldn't read FLOP_KEY_FILE: " + e.message); }
    return String(j.key || j.api_key || "").trim();
  }
  return "";
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set([429, 502, 503, 504]);

const explain = (status, body) => {
  const t = typeof body === "string" ? body : JSON.stringify(body);
  if (status === 401 && /expired/i.test(t)) { return "Gateway key expired. Run `flop --network devnet agent credential`; if it says the allowance expired, FLOP must renew it (issue 6)."; }
  if (status === 401) { return "Gateway refused the key (401). Check FLOP_API_KEY."; }
  if (status === 402) { return "Gateway says the allowance or balance is used up (402)."; }
  if (status === 404 && /model/i.test(t)) { return "The gateway doesn't know this model. Run `flop-text models`."; }
  if (status === 429) { return "Gateway is busy (429, channel pool full). Wait a few minutes and retry."; }
  if (status === 503 && /miner/i.test(t)) { return "No admitted miner serves this model right now (503). Retry later or pick another --model."; }
  if (status === 502 || status === 503 || status === 504) { return "The FLOP gateway is down or overloaded (HTTP " + status + "). Check https://flop.trackingport.com and retry later."; }
  return "Gateway returned HTTP " + status + ".";
};

const getJson = async (url, ms) => {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(ms || 20000) });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = null; }
  return { status: r.status, ok: r.ok, body };
};

const runGateway = async (messages, o, log) => {
  const key = gatewayKey();
  if (!key) { throw new UsageError("No gateway key. Set FLOP_API_KEY or FLOP_KEY_FILE, or use --mode direct."); }
  const retries = intOpt(o, "retries", 2, 0, 10);
  const wait = intOpt(o, "wait", 20, 0, 600);
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await fetch(GATEWAY + "/chat/completions", { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" }, body: JSON.stringify({ model: o.model, max_tokens: o.maxTokens, messages }), signal: AbortSignal.timeout(Number(process.env.FLOP_TIMEOUT_MS || 120000)) });
    } catch (e) {
      // A timeout may still have opened a channel, so it is never retried automatically.
      if (e.name === "TimeoutError") { throw new Error("The gateway didn't answer in time. It may still have run the call; check `flop-text history` before retrying."); }
      if (attempt < retries) { log("Couldn't reach the gateway (" + e.message + "). Retrying in " + wait + "s..."); await sleep(wait * 1000); continue; }
      throw new Error("Couldn't reach the gateway: " + e.message);
    }
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    if (!r.ok) {
      if (RETRYABLE.has(r.status) && attempt < retries) { log(explain(r.status, body) + " Retry " + (attempt + 1) + " of " + retries + " in " + wait + "s..."); await sleep(wait * 1000); continue; }
      const e = new Error(explain(r.status, body)); e.detail = typeof body === "string" ? body.slice(0, 300) : body; throw e;
    }
    const choice = body && body.choices && body.choices[0];
    const rc = (body && body.x_flop_receipt) || {};
    return { mode: "gateway", model: body.model || o.model, reply: choice && choice.message ? String(choice.message.content || "") : "", finishReason: choice ? choice.finish_reason : null, usage: body.usage || null, reservedFlop: body.usage && body.usage.cost_flop !== undefined ? body.usage.cost_flop : null, channelId: rc.channelId || null, miner: rc.miner || null, payerOnChain: GATEWAY_ACCOUNT, attempts: attempt + 1 };
  }
};

const runDirect = async (messages, o) => {
  if (!o.miner || !o.endpoint) { throw new UsageError("Direct mode needs --miner and --endpoint of a miner that exposes its session endpoint. Devnet miners don't publish one yet."); }
  const mf = o["max-flop"] || "0.5";
  if (!/^\d+(\.\d{1,18})?$/.test(mf) || !(Number(mf) > 0) || Number(mf) > 5) { throw new UsageError("--max-flop must be a decimal above 0 and at most 5, like 0.5."); }
  const ks = process.env.FLOP_KEYSTORE; const pwEnv = process.env.FLOP_PASSWORD_ENV;
  if (!ks || !pwEnv || !process.env[pwEnv]) { throw new UsageError("Set FLOP_KEYSTORE and FLOP_PASSWORD_ENV (the name of an env var that holds the keystore password)."); }
  // `session run` takes one prompt, so the instruction is folded into it.
  const prompt = messages.map((m) => (m.role === "system" ? m.content + "\n\n" : m.content)).join("");
  const args = ["--network", "devnet", "--keystore", ks, "--password-env", pwEnv, "--json", "session", "run", "--miner", o.miner, "--model", o.model, "--endpoint", o.endpoint, "--prompt", prompt, "--max-flop", mf, "--max-tokens", String(o.maxTokens)];
  const cli = process.env.FLOP_CLI || "flop";
  const out = await new Promise((resolve, reject) => {
    const p = spawn(cli, args, { stdio: ["ignore", "pipe", "pipe"] });
    let so = "", se = ""; p.stdout.on("data", (d) => { so += d; }); p.stderr.on("data", (d) => { se += d; });
    p.on("error", (e) => reject(e.code === "ENOENT" ? new UsageError("The flop CLI wasn't found. Install @flop-labs/cli 0.4.1 or newer, or set FLOP_CLI.") : e));
    p.on("close", (code) => resolve({ code, so, se }));
  });
  let j = null; try { j = JSON.parse(out.so); } catch { /* not JSON */ }
  if (out.code !== 0 || !j || !j.reply) {
    const lines = (out.so + "\n" + out.se).split("\n").filter((l) => l.trim() && !/RPC-CORE|API\/INIT|Failed WS|^\s+at /.test(l));
    const ch = (out.so + out.se).match(/0x[0-9a-f]{64}/);
    const e = new Error("flop session run failed (exit " + out.code + ")." + (ch ? " Check channel " + ch[0] + " before retrying: " + LOOKUP + ch[0] : ""));
    e.detail = lines.slice(-6).join("\n"); throw e;
  }
  return { mode: "direct", model: o.model, reply: String(j.reply), finishReason: j.finish_reason || null, channelId: j.channel || null, miner: j.miner || null, settleTx: j.settle_tx || null, cooperative: j.cooperative, payerOnChain: "your wallet", attempts: 1 };
};

const fmtFlop = (raw) => {
  if (raw === undefined || raw === null) { return null; }
  const b = BigInt(String(raw).replace(/,/g, ""));
  if (b > 0n && b < 10n ** 12n) { return "under 0.000001 FLOP"; }
  const whole = b / 10n ** 18n; const frac = String((b % 10n ** 18n) / 10n ** 12n).padStart(6, "0").replace(/0+$/, "");
  return whole.toString() + (frac ? "." + frac : "") + " FLOP";
};

const save = (o, cmd, r) => {
  if (o["no-save"]) { return; }
  try {
    mkdirSync(HOME, { recursive: true, mode: 0o700 });
    appendFileSync(HISTORY, JSON.stringify({ at: new Date().toISOString(), command: cmd, mode: r.mode, model: r.model, channelId: r.channelId, miner: r.miner, reservedFlop: r.reservedFlop ?? null, finishReason: r.finishReason, completionTokens: r.usage ? r.usage.completion_tokens : undefined }) + "\n", { mode: 0o600 });
  } catch (e) { process.stderr.write("flop-text: couldn't save history (" + e.message + ")\n"); }
};

const readHistory = () => {
  if (!existsSync(HISTORY)) { return []; }
  return readFileSync(HISTORY, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};

const channel = async (id) => {
  if (!id) { const last = readHistory().reverse().find((h) => h.channelId); if (!last) { throw new UsageError("Give a channel ID, or make a call first so history has one."); } id = last.channelId; }
  if (!CHANNEL_ID.test(id)) { throw new UsageError("A channel ID is 0x followed by 64 hex characters."); }
  const r = await getJson(EXPLORER + "/api/compute-channels/" + id.toLowerCase());
  if (r.status === 404 || (r.ok && (!r.body || !r.body.channelId))) { throw new Error("The explorer doesn't know this channel yet. A new channel can take a minute to appear."); }
  if (!r.ok) { throw new Error("The explorer returned HTTP " + r.status + ". Retry later."); }
  const c = r.body;
  const verdict = c.status === "settled" ? "Settled: the miner was paid. FLOP also takes a 1% audit fee." : c.status === "timedout" ? "Timed out and refunded: the miner got nothing." : c.status === "open" ? "Still open. Check again in a few minutes." : "Status " + c.status + ".";
  const res = { channelId: c.channelId, status: c.status, paymentStatus: c.paymentStatus, verdict, payer: c.agent, payerIsGateway: c.agent === GATEWAY_ACCOUNT, miner: c.miner, escrow: fmtFlop(c.escrow), usageGn: c.aggregateGn ?? null, minerPaid: fmtFlop(c.minerPaid), refunded: fmtFlop(c.refunded), burned: c.burned && c.burned !== "0" ? fmtFlop(c.burned) : null, openedBlock: c.openedBlock, closedEvent: c.status !== "open" && c.latestTransition ? c.latestTransition.event : null, link: LOOKUP + c.channelId };
  const lines = [verdict, "Channel:     " + res.channelId, "Payer:       " + res.payer + (res.payerIsGateway ? " (the gateway account, not your wallet; issue 133)" : ""), "Miner:       " + res.miner, "Escrow:      " + res.escrow];
  if (res.usageGn !== null) { lines.push("Usage:       " + res.usageGn + " GN"); }
  if (res.minerPaid) { lines.push("Miner paid:  " + res.minerPaid); }
  if (res.refunded) { lines.push("Refunded:    " + res.refunded); }
  if (res.burned) { lines.push("Burned:      " + res.burned); }
  if (res.closedEvent) { lines.push("Closed by:   " + res.closedEvent); }
  lines.push("Details:     " + res.link);
  return { res, lines };
};

const models = async () => {
  const r = await getJson(GATEWAY + "/models");
  if (!r.ok || !r.body || !Array.isArray(r.body.data)) { throw new Error("Couldn't list models (HTTP " + r.status + ")."); }
  const list = r.body.data.map((m) => m.id).filter(Boolean);
  return { res: list, lines: list.length ? list.map((m) => (m === DEFAULT_MODEL ? m + "  (default)" : m)) : ["The gateway lists no models right now."] };
};

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + " timed out after " + ms / 1000 + "s")), ms))]);

const check = async () => {
  const res = {};
  const [health] = await Promise.allSettled([getJson(GATEWAY.replace(/\/v1$/, "") + "/health", 15000)]);
  res.gateway = health.status === "fulfilled" ? (health.value.body && health.value.body.status) || "HTTP " + health.value.status : "unreachable";
  const { ApiPromise, WsProvider } = await import("@polkadot/api");
  const provider = new WsProvider(RPC, 0);
  try {
    await withTimeout(provider.connect(), 20000, "RPC connect");
    const api = await withTimeout(ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true }), 30000, "Chain metadata");
    res.runtime = api.runtimeVersion.specVersion.toNumber();
    res.attestProfiles = (await withTimeout(api.rpc.state.getKeysPaged(ATTEST_PREFIX, 20), 20000, "Profile read")).length;
    const ks = process.env.FLOP_KEYSTORE;
    if (ks && existsSync(ks)) { let addr = null; try { addr = JSON.parse(readFileSync(ks, "utf8")).address; } catch { /* unreadable */ } if (addr) { const a = await withTimeout(api.query.system.account(addr), 20000, "Balance read"); res.wallet = addr; res.walletFlop = fmtFlop(a.data.free.toString()); } }
    await api.disconnect();
  } catch (e) { res.chainError = String(e.message || e).slice(0, 160); }
  try { await provider.disconnect(); } catch { /* already closed */ }
  let key = ""; try { key = gatewayKey(); } catch (e) { res.keyError = e.message; }
  res.gatewayKey = key ? "set" : res.keyError ? "unreadable" : "not set";
  const lines = [
    "Chain:        " + (res.chainError ? "unreachable (" + res.chainError + ")" : "runtime " + res.runtime),
    "Gateway:      " + res.gateway,
    "Gateway key:  " + res.gatewayKey + (res.gatewayKey === "set" ? " (validity is only known after a call)" : ""),
    "Wallet:       " + (res.wallet ? res.wallet + ", " + res.walletFlop : "FLOP_KEYSTORE not set"),
    "Direct chat:  " + (res.attestProfiles === undefined ? "unknown" : res.attestProfiles ? res.attestProfiles + " appraisal profile(s) registered" : "no appraisal profiles yet (issue 18)"),
    "Direct mode:  needs a miner session endpoint; none is public on devnet yet",
  ];
  return { res, lines };
};

const main = async () => {
  const o = parseArgs(process.argv.slice(2));
  const cmd = o._[0];
  if (o.version) { console.log(VERSION); return; }
  if (!cmd || cmd === "help" || o.help) { process.stdout.write(HELP); return; }
  const print = (x) => console.log(o.json ? JSON.stringify(x.res, null, 2) : x.lines.join("\n"));
  if (cmd === "check") { return print(await check()); }
  if (cmd === "models") { return print(await models()); }
  if (cmd === "channel") { return print(await channel(o._[1])); }
  if (cmd === "history") { const h = readHistory().slice(-10); return print({ res: h, lines: h.length ? h.map((x) => x.at.slice(0, 16).replace("T", " ") + "  " + x.command.padEnd(9) + " " + x.mode.padEnd(7) + " " + (x.channelId || "no channel")) : ["No calls saved yet."] }); }
  if (!TASKS[cmd]) { throw new UsageError("Unknown command " + cmd + ". Run flop-text --help."); }
  const text = await readInput(o._.slice(1).join(" "));
  if (!text) { throw new UsageError("No input text. Pass text, a file path, or - for stdin."); }
  if (text.length > MAX_INPUT) { throw new UsageError("Input is " + text.length + " characters; the limit is " + MAX_INPUT + ". Split it first."); }
  o.model = o.model || DEFAULT_MODEL;
  o.maxTokens = intOpt(o, "max-tokens", 200, 1, 2000);
  const mode = o.mode || "gateway";
  if (mode !== "gateway" && mode !== "direct") { throw new UsageError("--mode must be gateway or direct."); }
  const messages = TASKS[cmd](text, o);
  const log = (m) => process.stderr.write(m + "\n");
  const r = mode === "direct" ? await runDirect(messages, o) : await runGateway(messages, o, log);
  save(o, cmd, r);
  if (o.json) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(r.reply.trim() || "(empty reply)");
  const meta = ["mode " + r.mode, "model " + r.model];
  if (r.finishReason) { meta.push("finish " + r.finishReason + (r.finishReason === "length" ? ", raise --max-tokens for more" : "")); }
  if (r.reservedFlop !== null && r.reservedFlop !== undefined) { meta.push("reserved " + r.reservedFlop + " FLOP"); }
  log("\n[" + meta.join(", ") + "]");
  if (r.channelId) { log("Channel: " + LOOKUP + r.channelId); log("Check settlement later with: flop-text channel"); }
  if (r.mode === "gateway") { log("Gateway calls are opened by the gateway account, not your wallet (issue 133)."); }
};

main().catch((e) => {
  process.stderr.write("flop-text: " + e.message + "\n");
  if (e.detail) { process.stderr.write((typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail).slice(0, 400)) + "\n"); }
  process.exit(e instanceof UsageError ? 2 : 1);
});
