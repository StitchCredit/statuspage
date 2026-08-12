/**
 * StatusGator → Better Stack Bridge
 * 
 * Polls StatusGator API (free plan, 15 req/min) for credit bureau statuses
 * and creates/resolves status reports on your Better Stack status page.
 * 
 * Run this on a cron every 2-5 minutes via:
 *   - GitHub Actions (free, scheduled workflow)
 *   - AWS Lambda + EventBridge (free tier)
 *   - Railway / Render cron (free tier)
 *   - Or any server with cron
 * 
 * Environment variables required:
 *   STATUSGATOR_API_KEY     - From StatusGator dashboard (Settings > API)
 *   BETTERSTACK_API_TOKEN   - From Better Stack > API tokens
 *   BETTERSTACK_STATUS_PAGE_ID - Your status page ID (from API or URL)
 * 
 * Setup steps:
 *   1. StatusGator free plan: add 3 service monitors (Equifax, TransUnion, Experian)
 *   2. Better Stack: add 3 "Manually Tracked" resources on your status page
 *      for each bureau, note their status_page_resource_id
 *   3. Update BUREAU_CONFIG below with your StatusGator monitor IDs
 *      and Better Stack resource IDs
 *   4. Deploy and schedule every 2-5 minutes
 */

// ─── Configuration ──────────────────────────────────────────────────────────
const fs = require("fs");
const path = require("path");

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    const value = raw.replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
loadDotEnv();

function cleanEnv(name, fallback = "") {
  const value = process.env[name];
  if (typeof value !== "string") return fallback;
  // Guard against copied secrets with spaces or wrapping quotes.
  return value.trim().replace(/^['"]|['"]$/g, "") || fallback;
}

const STATUSGATOR_API_KEY = cleanEnv("STATUSGATOR_API_KEY");
const BETTERSTACK_API_TOKEN = cleanEnv("BETTERSTACK_API_TOKEN");
const BETTERSTACK_STATUS_PAGE_ID = cleanEnv("BETTERSTACK_STATUS_PAGE_ID");
const STATUSGATOR_BOARD_ID = cleanEnv("STATUSGATOR_BOARD_ID", "pHomklVeMg");
const STATUSGATOR_API_KEY_LEXISMERIDIAN = cleanEnv(
  "STATUSGATOR_API_KEY_LEXISMERIDIAN"
);
const STATUSGATOR_BOARD_ID_LEXISMERIDIAN = cleanEnv(
  "STATUSGATOR_BOARD_ID_LEXISMERIDIAN"
);
const FORCE_STATUS_BUREAU = cleanEnv("FORCE_STATUS_BUREAU");
const FORCE_STATUS_VALUE = cleanEnv("FORCE_STATUS_VALUE").toLowerCase();
const NOTIFY_WEBHOOK_URL = cleanEnv("NOTIFY_WEBHOOK_URL"); // Slack incoming webhook or any HTTP endpoint

const STATUSGATOR_SOURCES = {
  primary: {
    apiKey: STATUSGATOR_API_KEY,
    boardId: STATUSGATOR_BOARD_ID,
  },
  secondary: {
    apiKey: STATUSGATOR_API_KEY_LEXISMERIDIAN,
    boardId: STATUSGATOR_BOARD_ID_LEXISMERIDIAN,
  },
};

/**
 * Map your StatusGator monitors to Better Stack status page resources.
 * 
 * To find your StatusGator monitor IDs:
 *   GET https://statusgator.com/api/v3/monitors
 *   with header: Authorization: Bearer <STATUSGATOR_API_KEY>
 * 
 * To find your Better Stack resource IDs:
 *   GET https://uptime.betterstack.com/api/v2/status-pages/<PAGE_ID>/resources
 *   with header: Authorization: Bearer <BETTERSTACK_API_TOKEN>
 */
const BUREAU_CONFIG = [
  {
    name: "Equifax",
    statusgatorMonitorId: "AhL6s1igzR",
    betterstackResourceId: "8804844",
    statusgatorSource: "primary",
  },
  {
    name: "TransUnion",
    statusgatorMonitorId: "hvMTBvQ85W",
    betterstackResourceId: "8804845",
    statusgatorSource: "primary",
  },
  {
    name: "Experian",
    statusgatorMonitorId: "K2JC5Q8YFG",
    betterstackResourceId: "8804846",
    statusgatorSource: "primary",
  },
  {
    name: "LexisNexis Risk",
    statusgatorMonitorId: "K2FQ5Q8YFG",
    betterstackResourceId: "8810940",
    statusgatorSource: "secondary",
  },
  {
    name: "MeridianLink",
    statusgatorMonitorId: "IWJIvBlcSU",
    betterstackResourceId: "8810941",
    statusgatorSource: "secondary",
  },
];

// ─── State tracking ─────────────────────────────────────────────────────────
// In a serverless/cron context, use a simple JSON file or KV store.
// For GitHub Actions, you can use artifacts or a gist.
// For simplicity, this uses a local JSON file.

const STATE_FILE = path.join(__dirname, ".bridge-state.json");

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
    // State shape: { "Equifax": { status: "up", reportId: null }, ... }
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── StatusGator API ────────────────────────────────────────────────────────

async function fetchStatusGatorMonitor(monitorId, sourceKey = "primary") {
  const source = STATUSGATOR_SOURCES[sourceKey];
  if (!source?.apiKey || !source?.boardId) {
    throw new Error(
      `StatusGator source "${sourceKey}" is not configured. Check its API key and board ID env vars.`
    );
  }

  const headers = { Authorization: `Bearer ${source.apiKey}` };
  const res = await fetch(
    `https://statusgator.com/api/v3/boards/${source.boardId}/monitors`,
    {
      headers: {
        ...headers,
        Accept: "application/json",
      },
    }
  );

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401) {
      throw new Error(
        `StatusGator API 401 Access denied for source "${sourceKey}". Verify its API key is valid for that org and has API access.`
      );
    }
    throw new Error(`StatusGator API error: ${res.status} - ${body}`);
  }

  const payload = await res.json();
  const monitors = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.monitors)
      ? payload.monitors
      : Array.isArray(payload)
        ? payload
        : [];

  const selected = monitors.find((m) => {
    const id = m?.id || m?.monitor_id || m?.attributes?.id;
    return String(id) === String(monitorId);
  });

  if (!selected) {
    throw new Error(
      `StatusGator monitor ${monitorId} not found on board ${source.boardId} (source "${sourceKey}")`
    );
  }

  const rawStatus =
    selected?.filtered_status ||
    selected?.unfiltered_status ||
    selected?.attributes?.status ||
    selected?.status ||
    selected?.current_status ||
    selected?.monitor_status;

  return {
    data: {
      attributes: {
        status: rawStatus,
      },
    },
  };
}

/**
 * Normalize StatusGator status to a simple state.
 * StatusGator uses: up, warn, down, maintenance
 */
function normalizeStatus(sgStatus) {
  switch (sgStatus) {
    case "up":
      return "operational";
    case "warn":
      return "degraded";
    case "down":
      return "downtime";
    case "maintenance":
      return "maintenance";
    default:
      return "operational";
  }
}

function applyForcedStatus(bureauName, currentStatus) {
  const allowed = new Set(["operational", "degraded", "downtime", "maintenance"]);
  if (!FORCE_STATUS_BUREAU || !FORCE_STATUS_VALUE) return currentStatus;
  if (!allowed.has(FORCE_STATUS_VALUE)) return currentStatus;
  if (bureauName !== FORCE_STATUS_BUREAU) return currentStatus;
  console.log(
    `  [TEST] Forcing ${bureauName} status to ${FORCE_STATUS_VALUE} via env override`
  );
  return FORCE_STATUS_VALUE;
}

// ─── Notifications ──────────────────────────────────────────────────────────

const STATUS_EMOJI = {
  degraded: "⚠️",
  downtime: "🔴",
  maintenance: "🔧",
  operational: "✅",
};

async function sendNotification(bureau, previousStatus, currentStatus) {
  if (!NOTIFY_WEBHOOK_URL) return;

  const emoji = STATUS_EMOJI[currentStatus] || "⚠️";
  const label =
    currentStatus === "downtime"
      ? "Outage"
      : currentStatus === "degraded"
        ? "Degraded"
        : currentStatus === "maintenance"
          ? "Maintenance"
          : "Recovered";

  const text = `${emoji} *${bureau.name} — ${label}*\nStatus changed: \`${previousStatus}\` → \`${currentStatus}\``;

  try {
    const res = await fetch(NOTIFY_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.warn(`  Notification webhook returned ${res.status}`);
    }
  } catch (err) {
    console.warn(`  Notification failed: ${err.message}`);
  }
}

// ─── Better Stack Status Page API ───────────────────────────────────────────

async function createStatusReport(bureau, status, message) {
  const isMaintenance = status === "maintenance";
  const isDowntime = status === "downtime";
  const titleSuffix = isMaintenance
    ? "Maintenance"
    : isDowntime
      ? "Outage"
      : "Degradation";
  const defaultMessage = isMaintenance
    ? `StatusGator reports ${bureau.name} is under maintenance.`
    : isDowntime
      ? `StatusGator reports ${bureau.name} is experiencing an outage.`
      : `StatusGator reports ${bureau.name} is experiencing degraded performance.`;

  const payload = {
    title: `${bureau.name} ${titleSuffix} Detected`,
    message: message || defaultMessage,
    report_type: isMaintenance ? "maintenance" : "manual",
    affected_resources: [
      {
        status_page_resource_id: bureau.betterstackResourceId,
        status: status,
      },
    ],
  };

  if (isMaintenance) {
    const hours = Number(cleanEnv("MAINTENANCE_DEFAULT_HOURS", "168")) || 168;
    payload.ends_at = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  }

  const res = await fetch(
    `https://uptime.betterstack.com/api/v2/status-pages/${BETTERSTACK_STATUS_PAGE_ID}/status-reports`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BETTERSTACK_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Better Stack create report error: ${res.status} - ${body}`);
  }

  const data = await res.json();
  return data.data.id;
}

async function resolveStatusReport(bureau, reportId, previousStatus) {
  if (previousStatus === "maintenance") {
    const res = await fetch(
      `https://uptime.betterstack.com/api/v2/status-pages/${BETTERSTACK_STATUS_PAGE_ID}/status-reports/${reportId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${BETTERSTACK_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ends_at: new Date().toISOString(),
        }),
      }
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Better Stack resolve error: ${res.status} - ${body}`);
    }
    return;
  }

  const res = await fetch(
    `https://uptime.betterstack.com/api/v2/status-pages/${BETTERSTACK_STATUS_PAGE_ID}/status-reports/${reportId}/status-updates`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BETTERSTACK_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "Service has recovered. StatusGator reports operational status.",
        affected_resources: [
          {
            status_page_resource_id: bureau.betterstackResourceId,
            status: "resolved",
          },
        ],
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Better Stack resolve error: ${res.status} - ${body}`);
  }
}

// ─── Main sync logic ────────────────────────────────────────────────────────

async function sync() {
  const state = loadState();

  for (const bureau of BUREAU_CONFIG) {
    try {
      console.log(`Checking ${bureau.name}...`);

      const monitorData = await fetchStatusGatorMonitor(
        bureau.statusgatorMonitorId,
        bureau.statusgatorSource || "primary"
      );

      // The API response structure may vary — adjust based on actual v3 response
      // Typically: monitorData.data.attributes.status
      const rawStatus =
        monitorData?.data?.attributes?.status ||
        monitorData?.status;

      const currentStatus = applyForcedStatus(
        bureau.name,
        normalizeStatus(rawStatus)
      );
      const previousState = state[bureau.name] || {
        status: "operational",
        reportId: null,
      };

      console.log(
        `  ${bureau.name}: ${previousState.status} → ${currentStatus}`
      );

      // Status went from OK to NOT OK → create a report
      if (
        currentStatus !== "operational" &&
        previousState.status === "operational"
      ) {
        console.log(`  ⚠ Creating status report for ${bureau.name}...`);
        const reportId = await createStatusReport(bureau, currentStatus);
        state[bureau.name] = { status: currentStatus, reportId };
        console.log(`  ✓ Report created: ${reportId}`);
        await sendNotification(bureau, previousState.status, currentStatus);
      }

      // Status went from NOT OK to OK → resolve the report
      else if (
        currentStatus === "operational" &&
        previousState.status !== "operational" &&
        previousState.reportId
      ) {
        console.log(`  ✓ Resolving report for ${bureau.name}...`);
        await resolveStatusReport(bureau, previousState.reportId, previousState.status);
        state[bureau.name] = { status: "operational", reportId: null };
        console.log(`  ✓ Report resolved`);
        await sendNotification(bureau, previousState.status, currentStatus);
      }

      // Status changed but still not OK (e.g., warn → down)
      else if (
        currentStatus !== "operational" &&
        previousState.status !== "operational" &&
        currentStatus !== previousState.status
      ) {
        // Resolve old, create new with updated severity
        if (previousState.reportId) {
          await resolveStatusReport(bureau, previousState.reportId, previousState.status);
        }
        const reportId = await createStatusReport(bureau, currentStatus);
        state[bureau.name] = { status: currentStatus, reportId };
        console.log(`  ↔ Status changed, report updated: ${reportId}`);
        await sendNotification(bureau, previousState.status, currentStatus);
      }

      // No change
      else {
        state[bureau.name] = { ...previousState, status: currentStatus };
      }
    } catch (err) {
      console.error(`  ✗ Error checking ${bureau.name}:`, err.message);
    }
  }

  saveState(state);
  console.log("Sync complete.");
}

// ─── Entry point ────────────────────────────────────────────────────────────

sync().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
