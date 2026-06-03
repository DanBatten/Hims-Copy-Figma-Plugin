# Comment Review Loop

This is the v1 bridge for Figma comments that ask Hermes to revise a specific piece of copy.

## Flow

1. Reviewer leaves a Figma comment on the creative.
2. `hermes-figma-comment-watcher` polls Figma comments for the target file.
3. The watcher stores each comment ID under `/var/lib/hermes-figma-queue/comments` so it is not processed twice.
4. The watcher forwards a structured revision task to `HERMES_REVISION_URL`.
5. Hermes rewrites the requested field and posts a `patchTextField` job to the queue.
6. The Figma plugin applies the patch to the text node tagged with the matching `adId` and `field`.
7. When the patch job completes, the queue service adds a check reaction to the source Figma comment.

## Patch Job Contract

Hermes should post this JSON to `POST /jobs` after it has produced the revised copy:

```json
{
  "jobId": "07366-comment-123456",
  "mode": "patchTextField",
  "sourceCommentId": "123456",
  "fileKey": "hHYhpgEbsqzo9IYQ4HfwaQ",
  "target": {
    "adId": "HERS-01",
    "field": "HEADLINE"
  },
  "value": "A gentler way to find your weight loss fit."
}
```

Supported `field` values are the same copy tokens used by the plugin:

```text
TOPHAT
HEADLINE
SUBHEAD
CTA
CALLOUTS
PRIMARY_TEXT
META_HEADLINE
META_DESCRIPTION
```

## Comment Targeting

The plugin now tags generated copy text layers with plugin data:

```text
adId
field
brand
category
projectId
round
copy
```

For v1, Hermes can include an explicit target in the comment text when needed:

```text
HERS-01 HEADLINE: Could you soften this language?
```

The watcher also preserves Figma `client_meta` in the revision task so a later mapping pass can resolve comment coordinates to the nearest tagged text node.

## Required Environment

Add these to `/etc/hermes-figma-queue.env` on the queue EC2:

```bash
FIGMA_TOKEN=...
FIGMA_FILE_KEY=...
FIGMA_IMPLEMENTED_REACTION=:white_check_mark:
COMMENT_WATCH_INTERVAL_MS=60000
HERMES_REVISION_URL=https://your-hermes-intake.example.com/figma-comments
HERMES_REVISION_TOKEN=...
```

The Figma token needs comment read/write scopes so it can poll comments and add the implemented reaction.

## Service Commands

Install:

```bash
sudo cp /opt/hermes-figma-queue/deploy/hermes-figma-comment-watcher.service /etc/systemd/system/hermes-figma-comment-watcher.service
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-figma-comment-watcher
```

Check:

```bash
sudo systemctl status hermes-figma-comment-watcher
journalctl -u hermes-figma-comment-watcher -f
```
