# Hermes to Figma Automation

This plugin supports a worker-mode bridge:

```text
Hermes -> queue server -> Figma plugin worker -> open Figma file
```

The Figma REST API is not used for canvas writes. The plugin does the writing because the Figma Plugin API can create editable frames, pages, text layers, and component instances in the currently open Figma file.

## Local bridge setup

Start the queue server on the machine that has Figma open:

```bash
npm run queue
```

Open the target Figma file and run the development plugin. The plugin starts listening automatically.

Default local queue URL:

```text
http://localhost:8787
```

## Submit a Markdown brief as a job

Convert a structured Markdown brief to canonical JSON:

```bash
node scripts/brief-to-job.mjs /path/to/brief.md 07363-v1 > /tmp/07363-v1.json
```

Queue it:

```bash
curl -X POST http://localhost:8787/jobs \
  -H 'Authorization: Bearer YOUR_TOKEN_IF_ENABLED' \
  -H 'Content-Type: application/json' \
  --data-binary @/tmp/07363-v1.json
```

The plugin worker will poll `GET /jobs/next`, render the batch, then report to:

```text
POST /jobs/:jobId/completed
POST /jobs/:jobId/failed
```

## Canonical job JSON

```json
{
  "jobId": "07363-v1",
  "targetFileKey": "optional-figma-file-key",
  "campaign": {
    "name": "WL Titration Paid Social Statics",
    "brands": ["Hims", "Hers"],
    "category": "Weight Loss",
    "batch": "Ad Set 1"
  },
  "options": {
    "useTemplates": true,
    "includePrimaryText": false
  },
  "ads": [
    {
      "id": "HERS-01",
      "brand": "Hers",
      "format": "4x5",
      "template": "hers_low_dose_start_pill_4x5_v1",
      "outputName": "HERS-01 Low Dose Start",
      "fields": {
        "TOPHAT": "A gentler way to start",
        "HEADLINE": "Start low. Adjust as you go.",
        "SUBHEAD": "Wegovy Pill, from $149/mo",
        "CTA": "See if you're eligible",
        "CALLOUTS": [
          "FDA-approved for weight loss",
          "Provider support included"
        ],
        "PRIMARY_TEXT": "Post copy as one rendered string",
        "META_HEADLINE": "A gentler way to start Wegovy",
        "META_DESCRIPTION": "From $149/mo, if prescribed"
      }
    }
  ]
}
```

## Production note

For full autonomy, run the queue server somewhere Hermes can reach, or add a relay from EC2 to the worker machine. The Figma plugin still needs an open Figma file and a running worker session because Figma canvas writes happen inside the editor.

For EC2 setup, see [EC2_DEPLOY.md](EC2_DEPLOY.md).
