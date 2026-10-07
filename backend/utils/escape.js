// Output escaping for user-controlled content placed into HTML emails and ICS files.

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value) {
  return String(value === undefined || value === null ? "" : value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/** Only http(s) URLs may appear in links; anything else becomes "#". Result is HTML-escaped. */
function safeUrl(value) {
  const raw = String(value || "").trim();
  return /^https?:\/\//i.test(raw) ? escapeHtml(raw) : "#";
}

/** RFC 5545 TEXT escaping: backslash, semicolon, comma and newlines. */
function escapeIcsText(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Strips CR/LF so values can't inject extra ICS properties (used for URLs/addresses). */
function icsValue(value) {
  return String(value === undefined || value === null ? "" : value).replace(/[\r\n]+/g, " ");
}

/** RFC 5545 line folding: lines longer than 75 octets continue with a leading space. */
function foldIcsLine(line) {
  const parts = [];
  let rest = String(line);
  while (Buffer.byteLength(rest, "utf8") > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut), "utf8") > 75) cut -= 1;
    parts.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  parts.push(rest);
  return parts.join("\r\n");
}

module.exports = { escapeHtml, safeUrl, escapeIcsText, icsValue, foldIcsLine };
