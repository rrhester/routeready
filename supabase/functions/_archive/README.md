# Supabase Edge Functions for RouteReady

These functions handle the parts of the dashboard that need to run on a server with secrets — currently just the Claude AI integration. More functions (Twilio SMS, Cal.com, R2 uploads) will land here in future phases.

## Deploy via Supabase Studio (easiest, no terminal)

1. Open [https://supabase.com/dashboard/project/qkjhkpbnsxiuwmxurcip/functions](https://supabase.com/dashboard/project/qkjhkpbnsxiuwmxurcip/functions)
2. Click **Deploy a new function**.
3. Name it exactly: `claude-ai`
4. Copy the contents of [`claude-ai/index.ts`](./claude-ai/index.ts) and paste into the editor.
5. Click **Deploy function**.

The function is now live at `https://qkjhkpbnsxiuwmxurcip.supabase.co/functions/v1/claude-ai` and the dashboard knows how to call it via `sb.functions.invoke('claude-ai', ...)`.

## Deploy via CLI (alternative, for power users)

```bash
npm install -g supabase
supabase login
supabase link --project-ref qkjhkpbnsxiuwmxurcip
supabase functions deploy claude-ai
```

## How it picks up the API key

`claude-ai` reads `Claude API Key` from your `settings` table first, then falls back to a Supabase secret named `ANTHROPIC_API_KEY`. Since the key is already in your `settings` table from Phase 3, no extra setup is needed.

If you'd rather use a Supabase secret instead:

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-api03-...
```

## Verify it works

After deploy, in the dashboard:
1. Open DevTools console
2. Run:
   ```js
   await sb.functions.invoke('claude-ai', { body: { prompt: 'Say hello in one word.' } })
   ```
3. Should return `{ data: { status: 'ok', text: 'Hello' }, error: null }`.

## What this powers in the dashboard

- `aiWriteMessage` — message rewrites in the templates editor
- `aiReviewScreeningQuestion` — employment-law check on custom screening questions
- (future) `generateCoachingMessage` — AI-drafted coaching SMS

## Local testing

```bash
supabase functions serve claude-ai --env-file ./supabase/.env.local
```

Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `ANTHROPIC_API_KEY` in `.env.local`.
