# Rovelle Codex storyboard transport

This documents the local transport contract for the storyboard loop. The
`.cjs` files are pure helpers and tests, not n8n workflow exports. No workflow
was changed. Task 12 must inspect the installed RV-00 graph and map these
logical credential references to its existing credential IDs and node versions.

## RV-00 changes

Keep the existing Telegram Trigger, private-operator allowlist, `/rv` routes,
callback routing and acknowledgement, Telegram send node, and legacy provider
routes. Do not add a Telegram Trigger.

The creator request remains `POST /rovelle/creator/telegram` with the existing
Core API credential and base URL. Pass Telegram IDs as decimal strings. Read
`update_id` from the update root for both message and callback updates. A
creator body has exactly one input field:

```json
{"telegramUserId":"976684739","chatId":"976684739","updateId":"987654321","messageText":"/new"}
```

```json
{"telegramUserId":"976684739","chatId":"976684739","updateId":"987654322","callbackToken":"rv:opaque-token"}
```

For callbacks, answer the Telegram callback query before calling Core. The
callback acknowledgement is separate from the creator HTTP request; keep the
callback query ID out of the Core body. Reuse the existing Core API credential
reference (`CORE_API_KEY`) and existing Core base URL setting.

Map `{ok:true,data:{text,inlineKeyboard,creativeJob?}}` to Telegram. Send the
reply to the triggering chat and map Core buttons as follows:

| Core button | Telegram button |
| --- | --- |
| `{text,callbackData}` | `{text,callback_data}` |
| `{text,url}` | `{text,url}` |

Only `data.creativeJob` with exactly `{id,action:"DISPATCH"}` and a valid UUID
produces a worker request. Its destination is the configured private worker
base URL plus fixed `POST /jobs`; its body is only `{"jobId":"<Core ID>"}`.
Ignore/reject extra action fields such as model-provided URLs and every unknown
action. Core remains responsible for deciding eligibility and expiry.

## Worker callbacks and Core forwarding

The worker calls two existing n8n webhooks using
`CODEX_WORKER_CALLBACK_KEY` in `x-codex-callback-key`:

| n8n webhook | Input | Forward to Core |
| --- | --- | --- |
| `POST /webhook/rovelle-codex-claim` | `{"jobId":"<UUID>"}` | `POST /rovelle/creative-jobs/<UUID>/claim`, body `{}` |
| `POST /webhook/rovelle-codex-result` | `{"jobId":"<UUID>","completion":{...}}` | `POST /rovelle/creative-jobs/<UUID>/result`, body is `completion` |

Use the dedicated `ROVELLE_CREATIVE_WORKER_KEY` credential reference in
`x-rovelle-worker-key` for Core list/claim/result requests. These endpoints
skip the general Core API key guard. Use fixed relative paths from the existing
Core base URL, disable redirects, set a 10-second request timeout, and cap
outbound claim bodies at 1 KiB and result bodies at 512 KiB. The Core creative
body limit is 512 KiB. Claim responses are bounded by the worker at 600 KiB.

The worker result callback must include its spool job ID. The current Task 8
transport sends only `completion`; add the wrapper shown above before wiring
the result webhook. The local result helper rejects callbacks without that ID,
so n8n cannot guess or accept a destination URL from the body.

Forward the Core claim envelope unchanged to the worker. For result delivery,
Core must persist first; then return its successful envelope with HTTP 200 to
the worker immediately, before attempting Telegram delivery. That response is
the worker's durable-delivery acknowledgement. After acknowledging, send the
Core-owned `data.chatId` and `data.reply` to Telegram. A Core or validation
error must not be acknowledged as saved. Telegram send failures and callback
replays may redeliver text, but they must not call Codex again or run approval.
`/mywork` recovers the stored result.

The claim/result Core routes and recovery GET use
`x-rovelle-worker-key`. Recovery runs every minute: GET
`/rovelle/creative-jobs?status=QUEUED` with no request body, then dispatch only
the returned `jobs` IDs (Core returns at most 20). Do not derive retries from
message text or recompute eligibility in n8n.

## Completion envelopes

These are the exact Task 2 completion shapes inside the result webhook's
`completion` property. The worker already has the attempt token and input hash;
it must add its spool `jobId` outside this object for n8n routing.

```json
{
  "jobId": "00000000-0000-4000-8000-000000000001",
  "completion": {
    "attemptToken": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "inputHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "status": "COMPLETED",
    "metadata": {
      "instructionVersion": "storyboard-v1",
      "sdkVersion": "0.154.0",
      "model": "configured-model",
      "threadId": null,
      "usage": null
    },
    "result": {
      "synopsis": "Two friends learn to share.",
      "script": "They find one toy and take turns.",
      "shots": [
        {
          "sequence": 1,
          "durationSeconds": 4,
          "direction": "Two friends discover one toy.",
          "narration": "They take turns.",
          "imagePrompt": "Two friendly characters sharing a toy."
        }
      ]
    }
  }
}
```

```json
{
  "jobId": "00000000-0000-4000-8000-000000000001",
  "completion": {
    "attemptToken": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "inputHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "status": "FAILED",
    "metadata": {
      "instructionVersion": "storyboard-v1",
      "sdkVersion": "0.154.0",
      "model": "configured-model",
      "threadId": null,
      "usage": null
    },
    "errorCode": "EXECUTION_FAILED"
  }
}
```

Core returns the authoritative reply/destination:

```json
{
  "ok": true,
  "data": {
    "chatId": "976684739",
    "reply": {
      "text": "Creative draft saved.",
      "inlineKeyboard": [[{"text":"Review","callbackData":"rv:opaque-token"}]]
    }
  }
}
```

Do not take `chatId`, user identity, approval, retry, or destination from the
completion payload. Core validates and persists the completion before
returning the reply, and it returns the same response for an identical replay.

## Configuration, credentials, and retention

| Owner | Setting | Direction/use |
| --- | --- | --- |
| Core | `ROVELLE_CREATIVE_ENABLED` | Feature flag; defaults off |
| Core | `ROVELLE_TELEGRAM_BOT_ID` | Stable configured bot ID for receipt keys |
| Core | `ROVELLE_CREATIVE_WORKER_KEY` | At least 32 bytes; n8n sends as `x-rovelle-worker-key` |
| Existing Core API | `CORE_API_KEY` | Existing creator HTTP Request credential only |
| Worker transport | `CODEX_WORKER_BIND_ADDRESS`, `CODEX_WORKER_PORT` | Private listener; port defaults to 8080 |
| Worker transport | `CODEX_WORKER_DISPATCH_KEY` | At least 32 bytes; n8n sends as `x-codex-dispatch-key` |
| Worker transport | `CODEX_WORKER_CALLBACK_KEY` | At least 32 bytes and differs from dispatch key; worker sends as `x-codex-callback-key` |
| Worker transport | `CODEX_N8N_BASE_URL` | Worker callback target; HTTP(S) origin only |
| Worker transport | `CODEX_WORKER_SPOOL_DIR` | Persistent spool; defaults to `/var/lib/codex-worker` |
| Worker transport | `CODEX_WORKER_SPOOL_MAX_BYTES` | Defaults to 64 MiB |
| Executor | `CODEX_EXECUTOR_BASE_URL`, `CODEX_EXECUTOR_BIND_ADDRESS`, `CODEX_EXECUTOR_PORT` | Private transport-to-executor route; port is 8081 |
| Executor | `CODEX_CREATIVE_MODEL`, `CODEX_CREATIVE_WORK_DIR`, `CODEX_API_KEY` | Configured model, optional absolute work-dir override, and provider credential |

The `.cjs` `credentialRef` values are logical names, never secret values or
live n8n credential IDs. Task 12 must map them to the saved credentials and
preserve the existing Core and Telegram credential references. The worker
retains acknowledged spool records for 24 hours, then removes them; its spool
has a 64 MiB default capacity. At rollout, disable n8n execution-data retention
for these sensitive creator and worker executions. Never place spool tokens,
raw SDK logs, or bearer links in alerts.

The Node tests exercise only local pure functions. They intercept no external
side effects because they make no network, provider, database, Telegram, or n8n
calls. Actual n8n node IDs, credential IDs, node versions, execution retention,
and rollback version remain Task 12 inspection items.
