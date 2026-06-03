# Hermes Figma Worker Runbook

This repo is deployed to an EC2 queue worker that bridges Hermes jobs into the Figma plugin worker.

## EC2 Instance

```text
Public IP: 3.22.235.122
User: ec2-user
Project path: /opt/hermes-figma-queue
Queue data: /var/lib/hermes-figma-queue
Service: hermes-figma-queue
```

SSH from this Mac:

```bash
ssh -i /Users/delilah/Library/CloudStorage/Dropbox/Projects/2026/Hims/AWS/DB-01.pem ec2-user@3.22.235.122
```

## Queue Service

The queue runs as a systemd service on EC2 and listens on EC2 localhost:

```text
http://localhost:8787
```

Check status:

```bash
sudo systemctl status hermes-figma-queue
```

Restart:

```bash
sudo systemctl restart hermes-figma-queue
```

View logs:

```bash
journalctl -u hermes-figma-queue -f
```

Environment config:

```bash
sudo cat /etc/hermes-figma-queue.env
```

The bearer token is set in:

```text
/etc/hermes-figma-queue.env
```

A local copy of the generated token was saved during setup at:

```text
/tmp/hermes-queue-token
```

## Figma Bridge Access

Because the EC2 queue is bound to localhost for safety, use an SSH tunnel from the Figma bridge machine.

Run this on the Mac and leave it open:

```bash
ssh -i /Users/delilah/Library/CloudStorage/Dropbox/Projects/2026/Hims/AWS/DB-01.pem \
  -N -L 8787:127.0.0.1:8787 \
  ec2-user@3.22.235.122
```

Then in Figma:

1. Open the target Figma file.
2. Run `Plugins > Development > Hermes Copy Translator`.
3. Leave the plugin open. It starts listening automatically.

The plugin has the local queue URL and bearer token bundled into the development build. It polls EC2 through the local tunnel, renders queued jobs into the open Figma file, and reports completion/failure. If the queue token changes, update the plugin build before reloading it in Figma.

## Hermes Job Submission On EC2

Hermes running on the EC2 instance should submit to:

```text
http://localhost:8787/jobs
```

Required header:

```http
Authorization: Bearer <token>
Content-Type: application/json
```

Example:

```bash
curl -X POST http://localhost:8787/jobs \
  -H "Authorization: Bearer $HERMES_QUEUE_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @job.json
```

## Job Lifecycle Endpoints

```text
GET  /health
POST /jobs
GET  /jobs/next
POST /jobs/:jobId/completed
POST /jobs/:jobId/failed
```

`/health` is public. All job endpoints require the bearer token when `HERMES_QUEUE_TOKEN` is configured.

## Comment Review Loop

The queue instance can also run a comment watcher that polls Figma comments and forwards new review comments to Hermes. See [COMMENT_REVIEW.md](COMMENT_REVIEW.md).

Relevant service:

```bash
sudo systemctl status hermes-figma-comment-watcher
sudo systemctl restart hermes-figma-comment-watcher
journalctl -u hermes-figma-comment-watcher -f
```

When Hermes posts a `patchTextField` job with `sourceCommentId`, the queue service adds a check reaction to that Figma comment after the plugin successfully applies the edit.

## Deploy Updates

From this Mac:

```bash
rsync -av --exclude node_modules --exclude dist --exclude queue-data \
  -e "ssh -i /Users/delilah/Library/CloudStorage/Dropbox/Projects/2026/Hims/AWS/DB-01.pem" \
  /Users/delilah/Library/CloudStorage/Dropbox/Projects/2026/Hims/figma-hermes-copy-plugin/ \
  ec2-user@3.22.235.122:/opt/hermes-figma-queue/
```

Then restart on EC2:

```bash
ssh -i /Users/delilah/Library/CloudStorage/Dropbox/Projects/2026/Hims/AWS/DB-01.pem ec2-user@3.22.235.122 \
  "sudo systemctl restart hermes-figma-queue && sudo systemctl status hermes-figma-queue --no-pager"
```

## Local Test Job

Convert a Markdown brief to JSON:

```bash
cd /Users/delilah/Library/CloudStorage/Dropbox/Projects/2026/Hims/figma-hermes-copy-plugin
node scripts/brief-to-job.mjs /path/to/brief.md test-job > /tmp/test-job.json
```

Post through the SSH tunnel:

```bash
TOKEN=$(cat /tmp/hermes-queue-token)
curl -X POST http://localhost:8787/jobs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/test-job.json
```
