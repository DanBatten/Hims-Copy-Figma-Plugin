# Hermes Copy Translator

Figma plugin MVP for turning Hermes copy briefs into populated ad layouts.

## What it does

- Imports `.docx`, `.md`, or `.txt` copy docs.
- Reads structured Markdown `# Ad` blocks.
- Keeps the original `Element / Copy` Word-table parser as a legacy fallback.
- Creates one Figma frame per parsed ad.
- Groups ads into visual theme sections when JSON jobs provide theme metadata.
- Uses matching Figma templates when present, otherwise creates fallback Hers/Hims-style placeholder layouts.

## Template contract

Place template components, component sets, or frames on the current Figma page. Name them with enough information for matching, for example:

```text
HERS-01 4x5 Low Dose Start
HERS-02 4x5 Side Effects Are Normal
HIMS-01 9x16 Low Dose Start
```

Inside each template, name text layers using these tokens:

```text
{{TOPHAT}}
{{HEADLINE}}
{{SUBHEAD}}
{{CALLOUTS}}
{{CTA}}
{{PRIMARY_TEXT}}
{{META_HEADLINE}}
{{META_DESCRIPTION}}
```

The plugin replaces matching text layers with the parsed copy.

## Build and load

```bash
npm install
npm run build
```

Then in Figma:

1. Open `Plugins > Development > Import plugin from manifest...`
2. Select `figma-hermes-copy-plugin/manifest.json`
3. Run `Hermes Copy Translator`

For autonomous Hermes-to-Figma operation, see [AUTOMATION.md](AUTOMATION.md).

For the current EC2 worker setup and day-to-day commands, see [WORKER_RUNBOOK.md](WORKER_RUNBOOK.md).

## Recommended brief additions

The preferred format is structured Markdown. The old table-based Word doc parser remains as a fallback, but new briefs should use this contract:

```markdown
# Campaign
Name: WL Titration Paid Social Statics
Brands: Hims, Hers
Channel: Paid Social
Category: Weight Loss
Batch: Ad Set 1

---

# Ad
ID: HERS-01
Brand: Hers
Format: 4x5
Template: hers_product_pill_4x5_v1
Output name: HERS-01 Low Dose Start

## Creative Direction
Lead angle: Low-dose entry as the gentlest way in.
Visual direction: Wegovy Pill in soft hand-held framing.

## Fields
TOPHAT: A gentler start to weight loss
HEADLINE: Ease into losing weight.
SUBHEAD: Wegovy Pill with Hers, from $149/mo.
CTA: See if you're eligible

CALLOUTS:
- FDA-approved for weight loss
- Access to licensed provider, included
- Dose adjustments, if needed

PRIMARY_TEXT:
Lose weight without the all-or-nothing.

✓ Wegovy with Hers, starting at the lowest approved dose
✓ Licensed provider access, included

META_HEADLINE: A gentler way to lose weight
META_DESCRIPTION: Wegovy with Hers, from $149/mo
```

Field type rules:

- `TOPHAT`, `HEADLINE`, `SUBHEAD`, `CTA`, `META_HEADLINE`, and `META_DESCRIPTION` are single-line strings.
- `CALLOUTS` must be a Markdown list. Each list item becomes one visual bullet.
- `PRIMARY_TEXT` is a multi-line string. Line breaks and checkmark bullets are preserved.

Brand validation is strict: each ad-level `Brand:` must be present in campaign-level `Brands:`. The plugin refuses to parse/render the doc on mismatch.

Page routing:

- The plugin routes each import to a Figma page named from brand and category, for example `Hims - Testosterone`, `Hims - Weight Loss`, `Hims - Sex`, `Hims - Hair`, or `Hers - Weight Loss`.
- You can override the inferred page with campaign-level or ad-level `Page:`.
- All ads in an import are placed inside one large batch frame named from `Batch:`, `Ad set:`, or campaign `Name:`.
- Each individual ad frame is named from `Output name:` when present.

## Theme grouping JSON contract

Hermes should add theme metadata to every ad. Ads with the same theme name are grouped together on the Figma canvas, and the theme brief is rendered as a side text block next to that section.

Preferred shape:

```json
{
  "id": "HIMS-01",
  "brand": "Hims",
  "category": "Testosterone",
  "format": "4x5",
  "template": "hims_testosterone_4x5_v1",
  "outputName": "HIMS-01 Higher T, Low-key",
  "theme": {
    "name": "Higher T, Low-key Enclomiphene",
    "brief": "Position enclomiphene as a low-friction, low-key way to support testosterone. Keep the tone direct but not clinical. Visual system should feel premium, calm, and easy to understand."
  },
  "leadAngle": "Higher T handled without making treatment feel intense.",
  "visualDirection": "Pill-forward product layouts with simple benefit hierarchy.",
  "fields": {
    "TOPHAT": "Testosterone support, simplified.",
    "HEADLINE": "Higher T, handled.",
    "SUBHEAD": "Daily support from home.",
    "CTA": "Get started",
    "CALLOUTS": [
      "Online provider evaluation",
      "No clinic visit required"
    ],
    "PRIMARY_TEXT": "..."
  }
}
```

Also accepted:

```json
{
  "themeName": "Seasonal - Summer",
  "themeBrief": "Summer-specific angle and visual direction..."
}
```

If theme metadata is omitted, the plugin places the ad in `Theme 1` and uses `leadAngle` plus `visualDirection` as the section brief.
