# flop-text

A small command-line app that translates, summarizes and answers questions using FLOP devnet inference. It can also show how each call settled on chain. It's an unofficial community tool, not made by Flop Labs. Devnet FLOP has no value.

Requires Node 20 or newer.

```bash
npm install
node flop-text.mjs check
export FLOP_API_KEY=...        # from: flop --network devnet agent credential
node flop-text.mjs translate "Chào buổi sáng, validator đã sẵn sàng."
node flop-text.mjs translate "Good morning" --to Vietnamese
node flop-text.mjs summarize notes.txt
cat notes.txt | node flop-text.mjs summarize -
node flop-text.mjs ask "What does a FLOP validator do?"
node flop-text.mjs channel     # how your last call settled
```

## Commands

| Command | What it does |
|---|---|
| `translate TEXT [--to LANGUAGE]` | Translate, into English by default |
| `summarize FILE\|-\|TEXT [--lang LANGUAGE]` | Up to 3 bullet points |
| `ask TEXT [--lang LANGUAGE]` | A short answer |
| `channel [CHANNEL_ID]` | Whether a call settled or was refunded, what the miner got, and who the chain records as payer. Defaults to your last call. |
| `history` | Your last 10 calls with their channel IDs |
| `models` | Models the gateway lists |
| `check` | Read-only check: chain, gateway, key, wallet balance, appraisal profiles |

Options:
- `--model SLUG`
- `--max-tokens N`: default 200
- `--retries N` and `--wait SECONDS`: busy or down gateways (429, 502, 503, 504) are retried twice, 20 seconds apart
- `--no-save`
- `--json`

A call that times out is never retried automatically, because it may already have run. Check `history` first.

The exit code is 0 on success, 1 when FLOP or the network fails, and 2 for a usage error.

## Two ways to pay

| Mode | How it pays | Who the chain records as payer |
|---|---|---|
| `gateway` (default) | A gateway API key | The gateway account `5GsXb3…`, not your wallet ([issue 133](https://github.com/flop-labs/network/issues/133)) |
| `direct` | Your own wallet, through the official `flop session run` | Your wallet |

The gateway receipt's `cost_flop` is the amount reserved. What the miner was actually paid shows in `flop-text channel` or at [flop.trackingport.com/channel](https://flop.trackingport.com/channel). FLOP also takes a 1% audit fee at settlement.

## Direct mode

```bash
export FLOP_KEYSTORE=/path/to/keystore.json FLOP_PASSWORD_ENV=FLOP_KEY_PASSWORD
node flop-text.mjs ask "Hello" --mode direct --miner 5... --endpoint https://miner.example/session --max-flop 0.5
```

- Direct mode needs `@flop-labs/cli` 0.4.1 or newer on PATH, or set `FLOP_CLI`.
- `--max-flop` caps the escrow, defaults to 0.5, and is refused above 5.
- It needs a miner that serves the model and exposes its session endpoint. As of November 10, 2026, devnet miners don't publish one, so direct mode works only with a miner whose operator gives you the endpoint.
- If a run fails, flop-text prints the channel ID when it can. Check that channel before you retry.

## Privacy

History is saved in `~/.flop-text/history.jsonl` (mode 600), or under `FLOP_TEXT_HOME` if you set it. Each entry holds only the time, command, model, channel ID and reserved cost, never your text or keys. Use `--no-save` to skip it.

Never paste a seed phrase or key into a prompt. Inputs over 6,000 characters are refused.

## Tests

`npm test` runs offline against a local mock gateway and explorer, so it spends no FLOP.

## Settings

| Variable | Default |
|---|---|
| `FLOP_GATEWAY_URL` | `https://api.flop.network/v1` |
| `FLOP_EXPLORER_URL` | `https://explorer.devnet.flop.network` |
| `FLOP_RPC_URL` | `wss://rpc.devnet.flop.network` |
| `FLOP_TIMEOUT_MS` | `120000` |
