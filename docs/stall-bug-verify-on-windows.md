# Verifying the "answer just stops" fix on the real Windows machine

The fix makes every stop VISIBLE. You should no longer get a bubble that ends
with only the thinking, or half a sentence, and no message. Now you get either a
full answer or a red error box under the bubble that says why it stopped. The
English text in brackets in that box tells you which cause it was.

## 1. Install and open the logs
1. Build and install this branch the usual way (`build-windows-on-windows.ps1`), or run `npm run dev`.
2. Open the app and wait for the model to load.
3. Open the logs panel at the bottom of the window. Every line from the API starts
   with `[api]` and every line from the model server starts with `[ollama]`.
   In dev mode the same lines also show in the terminal.

## 2. What to ask
Ask each of these in a NEW conversation (Settings → clear history between them):
- A plain lookup, e.g. `מה המשקל המרבי של המסוק?` You should get a normal answer.
- A question that makes the model think for a long time and write a long answer,
  e.g. `סכם את כל נהלי החירום במסמכים, כולל כל המספרים והמגבלות, בפירוט מלא.`
  This is the question most likely to hit the output limit (`num_predict` = 2048 tokens,
  and the thinking counts toward that limit).
- A question that needs several searches, e.g. one that compares values from two
  different documents.
- Repeat the questions that failed for you before. If you still have them, ask
  them word for word.

Try at least 10 questions. The bug was intermittent.

## 3. How to tell which cause it was
If an answer stops, read the red box and the `[api]` lines just before
`[api] response stream complete`:

| What you see | Cause | What it means |
|---|---|---|
| Box: `truncated: done_reason=length ...` and log `[api] chat: answer truncated by the output limit` | The answer hit `num_predict` | The model ran out of output tokens in the middle of the answer. If you see this often, `num_predict` (in the agent package) is too low for thinking plus the answer. Send the `thinking=N chars` value. |
| Box: `no answer: done_reason=length ...` | The model hit `num_predict` while it was still thinking | The same limit, but it was hit before the model wrote any answer. |
| Box: `no answer: done_reason=stop, thinking=N chars, answer=0` | The model thought, then ended its turn without writing anything, two times in a row | This is model behaviour. The recovery nudge was tried and also came back empty. |
| Box: `Ollama stream ended without a done line` | The connection to Ollama was cut, or the runner crashed | Look for an error or a crash in the `[ollama]` lines at that moment, and check free RAM. |
| Box: `Ollama error mid-stream: ...` | Ollama reported an error after it had started answering | Ollama's own text is in the box, e.g. `model runner has unexpectedly stopped`. |
| Box: `Ollama idle timeout: no bytes for 1200000 ms` | Ollama sent nothing for 20 minutes | Ollama is stuck, or it is still reading a very long prompt on the CPU. |
| Box: `החיבור לשרת נקטע לפני סוף התשובה` | The UI's own connection to the API was cut | This one is rare and needs a closer look. Send the logs. |

Before this fix, the first five rows all ended silently. Separately, a prompt that
took Ollama more than 300 s to read (a long conversation, or the first question
after Compact) failed inside Node's `fetch` with `fetch failed`. That error was then
retried silently up to 3 times, so the user saw a freeze of up to about 15 minutes.
That 300 s limit is gone now.
If a log line says `transient Ollama connection drop, retrying`, that is still
the normal, harmless quick retry when a connection is reset.

## 4. Send back
- How many questions you asked, and how many stopped early.
- The text in the red box and about 30 log lines around it for each stop.
- If it was the `length` case: the `thinking=` and `answer=` numbers. These decide
  whether `num_predict` should be raised in the agent package. That needs a
  separate decision, because the lab must use the same value.

## Optional: a shorter idle timeout for testing
To check that the idle-timeout path works on the real machine, start the app with
`set ARISTO_OLLAMA_IDLE_TIMEOUT_MS=5000`, then ask a question that needs several
searches. On the CPU, reading a step's tool results usually takes longer than 5 s, so
you should see the idle-timeout box instead of a freeze. If every step answers in under
5 s, the check tells you nothing. Remove the variable afterwards.
