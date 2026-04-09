const { fetchJson } = require("../utils/http");

class PaidSheetService {
  constructor() {
    this._emails = new Set();
    this._timer = null;
    this._lastSyncAt = 0;
  }

get lastSyncAt() {
    return this._lastSyncAt;
  }

  isVerified(email) {
    return this._emails.has(String(email || "").trim().toLowerCase());
  }

  async syncOnce() {
    const apiKey = String(process.env.PAID_SHEETS_API_KEY || "").trim();
    const sheetId = String(process.env.PAID_SHEETS_SHEET_ID || "").trim();
    const range = String(process.env.PAID_SHEETS_RANGE || "Verified!A:A").trim();
    if (!apiKey || !sheetId) {
      return;
    }

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      sheetId
    )}/values/${encodeURIComponent(range)}?majorDimension=COLUMNS&key=${encodeURIComponent(apiKey)}`;

    const data = await fetchJson(url, { method: "GET" });
    const values = (data && data.values && data.values[0]) || [];
    const set = new Set(
      values
        .map((v) => String(v || "").trim().toLowerCase())
        .filter((v) => v && v.includes("@"))
    );
    this._emails = set;
    this._lastSyncAt = Date.now();
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

