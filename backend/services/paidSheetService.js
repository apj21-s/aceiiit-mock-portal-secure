const { fetchJson } = require("../utils/http");

class PaidSheetService {
  constructor() {
    this._emails = new Set();
    this._entries = [];
    this._timer = null;
    this._lastSyncAt = 0;
  }

  get lastSyncAt() {
    return this._lastSyncAt;
  }

  get entries() {
    return this._entries;
  }

  isVerified(email) {
    if (!email) return false;
    return this._emails.has(String(email).trim().toLowerCase());
  }

  async syncOnce(options = {}) {
    const { throwOnError = false } = options;
    const apiKey = String(process.env.PAID_SHEETS_API_KEY || "").trim();
    const sheetId = String(process.env.PAID_SHEETS_SHEET_ID || "").trim();
    const rawRange = String(process.env.PAID_SHEETS_RANGE || "Verified!A:A").trim();
    if (!apiKey || !sheetId) {
      const msg = "PAID_SHEETS_API_KEY or PAID_SHEETS_SHEET_ID is missing from server environment.";
      if (throwOnError) throw new Error(msg);
      console.warn("[PaidSheetService]", msg);
      return;
    }

    const range = rawRange.includes("!") ? rawRange : `${rawRange}!A:A`;

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      sheetId
    )}/values/${encodeURIComponent(range)}?key=${encodeURIComponent(apiKey)}`;

    try {
      const data = await fetchJson(url, { method: "GET" });
      const rawRows = (data && data.values) || [];
      const emailSet = new Set();
      const entryList = [];

      for (const row of rawRows) {
        if (!Array.isArray(row) || !row.length) continue;
        const rowStr = row.join(" ");
        const emailMatches = rowStr.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
        
        if (emailMatches) {
          emailMatches.forEach((e) => {
            const clean = e.toLowerCase().trim();
            emailSet.add(clean);
            entryList.push({
              email: clean,
              rawRow: row.map((cell) => String(cell || "").trim()),
            });
          });
        }
      }

      this._emails = emailSet;
      this._entries = entryList;
      this._lastSyncAt = Date.now();
    } catch (err) {
      console.warn("[PaidSheetService] Sync failed:", err.message);
      if (throwOnError) {
        throw new Error("Google Sheets Sync Failed: " + (err.message || String(err)));
      }
    }
  }

  start() {
    const intervalSeconds = Number(process.env.PAID_SHEETS_SYNC_INTERVAL_SECONDS || 300);
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }

    this.syncOnce().catch(() => {});
    this._timer = setInterval(() => {
      this.syncOnce().catch(() => {});
    }, Math.max(30, intervalSeconds) * 1000);
  }
}

const paidSheetService = new PaidSheetService();

module.exports = { paidSheetService };

