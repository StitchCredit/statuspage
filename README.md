# StatusGator (Free) → Better Stack Bridge

Zero-cost integration to show Equifax, TransUnion, and Experian statuses on your Better Stack status page.

## How it works

```
StatusGator Free (polls bureau statuses)
        ↓ API (15 req/min on free plan)
  Bridge Script (cron every 3 min)
        ↓ API
Better Stack Status Page (crs.betteruptime.com)
```

## Setup

### 1. StatusGator (free plan)

1. Sign up at [statusgator.com](https://statusgator.com) — choose the **free plan**
2. Add 3 **Service Monitors**: search for Equifax, TransUnion, Experian
3. Go to **Settings → API** and copy your API key
4. Note your monitor IDs by calling:
   ```bash
   curl -H "Authorization: Bearer YOUR_API_KEY" \
     https://statusgator.com/api/v3/monitors
   ```

### 2. Better Stack

1. In your Better Stack status page, add 3 **Manually Tracked** resources:
   - Equifax
   - TransUnion  
   - Experian
2. Get your status page ID and resource IDs:
   ```bash
   # List status pages
   curl -H "Authorization: Bearer YOUR_TOKEN" \
     https://uptime.betterstack.com/api/v2/status-pages

   # List resources on your page
   curl -H "Authorization: Bearer YOUR_TOKEN" \
     https://uptime.betterstack.com/api/v2/status-pages/PAGE_ID/resources
   ```
3. Get an API token from **Better Stack → API tokens**

### 3. Configure the bridge

Update `BUREAU_CONFIG` in `statusgator-betterstack-bridge.js` with your actual IDs:

```js
const BUREAU_CONFIG = [
  {
    name: "Equifax",
    statusgatorMonitorId: "abc123",        // from step 1
    betterstackResourceId: "456789",       // from step 2
  },
  // ... same for TransUnion and Experian
];
```

#### Scoping a vendor to the products you actually use

Some vendors publish one status page covering dozens of products. StatusGator
collapses that to a single `up`/`warn`/`down`, so an outage in a product you
don't call still shows as a full vendor outage on your page. LexisNexis did
exactly that: their Asset Verification Solution was in major outage for a week
while every service CRS calls stayed operational.

Add `componentScope` to a bureau to bypass StatusGator for that vendor and read
their own Statuspage component list instead, reporting the worst status across
only the components you depend on:

```js
{
  name: "LexisNexis Risk",
  betterstackResourceId: "8810940",
  componentScope: {
    statusPageApi: "https://status.lexisnexisrisk.com/api/v2/components.json",
    components: [
      "LexisNexis® Accurint® XML (wsonline)", // LNR4302
      "LexisNexis® Bridger Insight® U.S. 5",  // LNR4201
      "LexisNexis® RiskView™",                // LNR4005
    ],
  },
}
```

Names are matched on letters and digits only, so punctuation and trademark
symbols can drift without breaking the match. If **none** of the configured
names match, the bridge throws and leaves that resource untouched rather than
reporting a false all-clear. If only some match, it warns and continues with
the rest. Component states map as: `operational` stays operational,
`degraded_performance` and `partial_outage` become degraded, `major_outage`
becomes downtime, and `under_maintenance` becomes maintenance.

### 4. Deploy (pick one — all free)

#### Option A: GitHub Actions (recommended)

1. Create a private repo with the bridge script
2. Add the workflow file at `.github/workflows/statusgator-sync.yml`
3. Add repo secrets:
   - `STATUSGATOR_API_KEY`
   - `BETTERSTACK_API_TOKEN`
   - `BETTERSTACK_STATUS_PAGE_ID`
4. The workflow runs every 3 minutes automatically

**Note:** GitHub Actions cron has ~1-2 min jitter and may be throttled on free plans to 5-min intervals. For most status monitoring, this is perfectly acceptable.

#### Option B: AWS Lambda + EventBridge

1. Package the script as a Lambda function
2. Create an EventBridge rule: `rate(3 minutes)`
3. Free tier: 1M requests/month

#### Option C: Railway / Render / Fly.io cron

All offer free-tier cron job hosting. Deploy the script and set the schedule.

## Free plan limits to keep in mind

| Service       | Limit                  | Impact                              |
|---------------|------------------------|-------------------------------------|
| StatusGator   | 3 monitors             | Exactly 3 bureaus — perfect fit     |
| StatusGator   | 15 req/min API         | Script makes 3 req per run — fine   |
| StatusGator   | 10 notifications/month | Doesn't matter — we use the API     |
| GitHub Actions| ~2000 min/month free   | ~3 min/run × 480 runs/day = ~1440   |

The GitHub Actions minute usage is tight on private repos (2000 min/month free). Each run takes ~10-30 seconds, so actual usage is closer to 240 min/month — well within limits.

## Troubleshooting

- **StatusGator API returns 401**: Check your API key. Free plan API access is confirmed at 15 req/min.
- **Better Stack returns 422**: Verify your resource IDs exist and are "ManuallyTrackedItem" type.
- **Report seems stuck on the status page**: The bridge treats Better Stack as the source of truth every run (it fetches each resource's live status and any open reports directly from the API), so a bad run or a mis-scoped report can't get permanently stuck from a bridge bug — the next run resolves any open report that no longer matches StatusGator's status. If something still looks wrong, check the report's `affected_resources` in the Better Stack dashboard for the correct resource ID.
- **StatusGator monitor shows no data for a bureau**: The credit bureaus don't have official status pages, so StatusGator relies on community reports. Status may stay "up" unless there's a confirmed widespread issue.
