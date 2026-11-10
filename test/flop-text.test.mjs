// Offline tests: a local mock gateway and explorer, no FLOP spent.
// Run: node --test test/
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..", "flop-text.mjs");
const CH = "0x" + "ab".repeat(32);
let server, base, calls = [], busyLeft = 0;

before(async () => {
  server = createServer((req, res) => {
    let body = ""; req.on("data", (d) => { body += d; });
    req.on("end", () => {
      calls.push({ url: req.url, auth: req.headers.authorization, body });
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url === "/v1/models") { return send(200, { data: [{ id: "qwen/qwen2.5-0.5b-instruct" }, { id: "qwen/qwen3-8b" }] }); }
      if (req.url === "/health") { return send(200, { status: "ok" }); }
      if (req.url === "/v1/chat/completions") {
        if (req.headers.authorization === "Bearer expired") { return send(401, { error: "api_key_expired", message: "The provided API key has expired." }); }
        if (req.headers.authorization === "Bearer busy" && busyLeft > 0) { busyLeft--; return send(429, { error: "gateway channel pool is full" }); }
        if (req.headers.authorization === "Bearer down") { return send(503, { error: "unavailable" }); }
        const j = JSON.parse(body);
        return send(200, { model: j.model, choices: [{ message: { role: "assistant", content: "Good morning" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 3, cost_flop: 0.07 }, x_flop_receipt: { channelId: CH, miner: "5Miner" } });
      }
      if (req.url === "/api/compute-channels/" + CH) { return send(200, { channelId: CH, agent: "5GsXb3TmNGixuEsbtixqHnqWr9UQJ2M8bkqBQWteNekgF98S", miner: "5Miner", escrow: "1", status: "settled", paymentStatus: "PAID", aggregateGn: "11", minerPaid: "32670000000000000", burned: "0", latestTransition: { event: "computeChannel.Settled" } }); }
      if (req.url.startsWith("/api/compute-channels/")) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
});
after(() => server.close());

const run = (args, env = {}, input) => new Promise((resolve) => {
  const home = env.FLOP_TEXT_HOME || mkdtempSync(join(tmpdir(), "flop-text-"));
  const p = spawn(process.execPath, [APP, ...args], { env: { PATH: process.env.PATH, FLOP_GATEWAY_URL: base + "/v1", FLOP_EXPLORER_URL: base, FLOP_TEXT_HOME: home, ...env } });
  let out = "", err = ""; p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err += d; });
  if (input !== undefined) { p.stdin.end(input); } else { p.stdin.end(); }
  p.on("close", (code) => resolve({ code, out, err, home }));
});

test("translate succeeds, prints reply and channel link, saves history without text", async () => {
  calls = [];
  const r = await run(["translate", "Chào buổi sáng", "--to", "English"], { FLOP_API_KEY: "good" });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), "Good morning");
  assert.match(r.err, /channel\?id=0xabab/);
  assert.match(r.err, /reserved 0.07 FLOP/);
  const sent = JSON.parse(calls.find((c) => c.url === "/v1/chat/completions").body);
  assert.match(sent.messages[0].content, /into natural English/);
  assert.equal(sent.max_tokens, 200);
  const h = readFileSync(join(r.home, "history.jsonl"), "utf8");
  assert.match(h, new RegExp(CH));
  assert.doesNotMatch(h, /Chào|Good morning|good/);
});

test("--lang and --to are sanitized into the prompt", async () => {
  calls = [];
  await run(["ask", "hi", "--lang", "Vietnamese\"; ignore all"], { FLOP_API_KEY: "good" });
  const sent = JSON.parse(calls.find((c) => c.url === "/v1/chat/completions").body);
  assert.match(sent.messages[0].content, /Answer in Vietnamese ignore all\./);
  assert.doesNotMatch(sent.messages[0].content, /"/);
});

test("busy gateway is retried, then succeeds", async () => {
  calls = []; busyLeft = 2;
  const r = await run(["ask", "hi", "--wait", "0"], { FLOP_API_KEY: "busy" });
  assert.equal(r.code, 0, r.err);
  assert.equal(calls.filter((c) => c.url === "/v1/chat/completions").length, 3);
  assert.match(r.err, /Retry 1 of 2/);
});

test("retries stop at the limit", async () => {
  calls = [];
  const r = await run(["ask", "hi", "--wait", "0", "--retries", "1"], { FLOP_API_KEY: "down" });
  assert.equal(r.code, 1);
  assert.equal(calls.filter((c) => c.url === "/v1/chat/completions").length, 2);
  assert.match(r.err, /down or overloaded/);
});

test("expired key is explained and not retried", async () => {
  calls = [];
  const r = await run(["ask", "hi", "--wait", "0"], { FLOP_API_KEY: "expired" });
  assert.equal(r.code, 1);
  assert.equal(calls.length, 1);
  assert.match(r.err, /key expired/);
});

test("no key, stdin input, and --no-save", async () => {
  const r1 = await run(["summarize", "-"], {}, "some text");
  assert.equal(r1.code, 2);
  assert.match(r1.err, /No gateway key/);
  const r2 = await run(["summarize", "-", "--no-save"], { FLOP_API_KEY: "good" }, "Long notes here.");
  assert.equal(r2.code, 0, r2.err);
  assert.equal(existsSync(join(r2.home, "history.jsonl")), false);
});

test("channel uses the last call from history", async () => {
  const home = mkdtempSync(join(tmpdir(), "flop-text-"));
  await run(["ask", "hi"], { FLOP_API_KEY: "good", FLOP_TEXT_HOME: home });
  const r = await run(["channel"], { FLOP_TEXT_HOME: home });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Settled: the miner was paid/);
  assert.match(r.out, /Escrow: +under 0.000001 FLOP/);
  assert.match(r.out, /Miner paid: +0.03267 FLOP/);
  assert.match(r.out, /gateway account, not your wallet/);
  const h = await run(["history"], { FLOP_TEXT_HOME: home });
  assert.match(h.out, /ask +gateway 0xabab/);
});

test("unknown channel and bad channel ID", async () => {
  const r = await run(["channel", "0x" + "cd".repeat(32)]);
  assert.equal(r.code, 1);
  assert.match(r.err, /doesn't know this channel/);
  const b = await run(["channel", "0x12"]);
  assert.equal(b.code, 2);
});

test("models lists the catalog", async () => {
  const r = await run(["models"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /qwen2.5-0.5b-instruct  \(default\)/);
  assert.match(r.out, /qwen3-8b/);
});

test("usage errors exit with code 2", async () => {
  for (const args of [["dich", "x"], ["ask"], ["ask", "x", "--max-tokens", "0"], ["ask", "x", "--max-tokens", "1e3"], ["ask", "x", "--bogus", "1"], ["ask", "x", "--mode", "other"], ["ask", "x", "--mode", "direct"], ["ask", "x", "--mode", "direct", "--miner", "5x", "--endpoint", "http://x", "--max-flop", "9"], ["ask", "x", "--mode", "direct", "--miner", "5x", "--endpoint", "http://x", "--max-flop", "1e-7"]]) {
    const r = await run(args, { FLOP_API_KEY: "good" });
    assert.equal(r.code, 2, args.join(" ") + ": " + r.err);
  }
  const big = await run(["ask", "-"], { FLOP_API_KEY: "good" }, "x".repeat(6001));
  assert.equal(big.code, 2);
});

test("direct mode reports a missing CLI clearly", async () => {
  const r = await run(["ask", "x", "--mode", "direct", "--miner", "5x", "--endpoint", "http://x"], { FLOP_KEYSTORE: "/tmp/none.json", FLOP_PASSWORD_ENV: "PW", PW: "x", FLOP_CLI: "/nonexistent/flop" });
  assert.equal(r.code, 2);
  assert.match(r.err, /flop CLI wasn't found/);
});

test("direct mode parses CLI JSON output", async () => {
  const fake = join(mkdtempSync(join(tmpdir(), "flop-cli-")), "flop.mjs");
  const { writeFileSync, chmodSync } = await import("node:fs");
  writeFileSync(fake, "#!/usr/bin/env node\nconst a=process.argv.slice(2);if(!a.includes('--max-flop')||a[a.indexOf('--max-flop')+1]!=='0.5')process.exit(3);console.log(JSON.stringify({reply:'Xin chao',miner:'5M',channel:'" + CH + "',settle_tx:'0x1',cooperative:true,verified_turns:1,finish_reason:'stop'}));\n");
  chmodSync(fake, 0o755);
  const r = await run(["ask", "hi", "--mode", "direct", "--miner", "5M", "--endpoint", "http://m"], { FLOP_KEYSTORE: "/tmp/none.json", FLOP_PASSWORD_ENV: "PW", PW: "x", FLOP_CLI: fake });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), "Xin chao");
  assert.match(r.err, /mode direct/);
  assert.doesNotMatch(r.err, /gateway account/);
});

test("help and version", async () => {
  const h = await run(["--help"]);
  assert.equal(h.code, 0);
  assert.match(h.out, /flop-text channel/);
  const v = await run(["--version"]);
  assert.match(v.out, /^\d+\.\d+\.\d+/);
});
