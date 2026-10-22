# Flockwise MCP server and public API

Flockwise speaks the Model Context Protocol, so Claude and other AI assistants can read and update church data. It also has a public REST API for tools like Zapier, n8n and custom scripts.

## API keys

A church admin makes keys in **Settings › Integrations › API keys**.

- **Read-only** keys can only use `GET` endpoints.
- **Full-access** keys can also create and change data.
- A key acts with the permissions of the staff member who made it. If that person leaves the church office, their keys stop working.
- A key cannot make more keys, change connections (Chitthi), or change staff roles.
- Keys look like `fw_live_…`. They are shown once, and only a hash is stored. Revoke a key at any time.
- Each key is limited to 600 requests a minute.

## REST API

Send the key as a bearer token to any `/v1/admin/…` endpoint in [API-ADMIN.md](API-ADMIN.md):

```bash
curl https://api.flockwise.church/v1/admin/people?q=samuel \
  -H "Authorization: Bearer fw_live_..."
```

## MCP

- **URL:** `https://api.flockwise.church/mcp` with the header `Authorization: Bearer fw_live_...`
- **Or:** `https://api.flockwise.church/mcp/fw_live_...`, for apps that only take a URL. Treat this URL like a password.
- **Transport:** Streamable HTTP. The server is stateless and replies with JSON (no SSE).

### Claude Code

```bash
claude mcp add --transport http flockwise https://api.flockwise.church/mcp \
  --header "Authorization: Bearer fw_live_..."
```

### Tools

| Tool | What it does | Needs full access |
|---|---|---|
| church_overview | This week at a glance | |
| church_insights | Attendance, giving and engagement trends | |
| search_people, get_person, person_timeline | Find people and see their history | |
| upcoming_celebrations | Birthdays and anniversaries | |
| list_events, event_attendees | Events and who is coming | |
| service_plan, volunteer_schedule | Order of service and rota | |
| list_groups | Small groups | |
| list_donations | Gifts (needs a giving role) | |
| list_care_cases, list_prayer_requests | Pastoral care | |
| add_person | Add a visitor or member | ✓ |
| create_care_case | Open a care follow-up | ✓ |
| post_announcement | Publish an announcement | ✓ |
| send_message | Email, SMS or WhatsApp to people, groups or teams | ✓ |

A read-only key does not list the full-access tools. Lists are cut to the first 50 rows.

## Chitthi (WhatsApp)

Under **Settings › Integrations**, a church pastes its Chitthi API key (from Chitthi › Settings › Developer). After that, every WhatsApp message Flockwise sends goes through the church's Chitthi workspace.

- The key is checked against `GET /api/integrations/hooks`, stored encrypted (AES-256-GCM), and never sent back to the browser.
- Messages outside WhatsApp's 24-hour window need an approved template. A template with one body value gets the whole message. With two or more values, the first is the person's first name and the second is the message.
- Set `CHITTHI_URL` only to point at a Chitthi test server. It defaults to `https://app.chitthi.live`.
- New churches sign up at `https://app.chitthi.live/signup?ref=flockwise`.
