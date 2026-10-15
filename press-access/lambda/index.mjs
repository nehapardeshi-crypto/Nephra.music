// Press-kit access gate: request -> email Neha -> approve/decline -> branded email with download links.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomBytes, timingSafeEqual } from "node:crypto";

const { TABLE, BUCKET, FROM, OWNER, SITE } = process.env;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ses = new SESv2Client({});
const s3 = new S3Client({});
const DAYS = 7;

const PHOTOS = [
  ["photos/NEPHRA-pink-knit.jpg", "Studio · Pink knit"],
  ["photos/NEPHRA-pink-headphones.jpg", "Studio · Headphones"],
  ["photos/NEPHRA-houndstooth.jpg", "Studio · Houndstooth"],
  ["photos/NEPHRA-halter-01.jpg", "Studio · Halter I"],
  ["photos/NEPHRA-halter-02.jpg", "Studio · Halter II"],
  ["photos/NEPHRA-white-seated.jpg", "Studio · Full length"],
];
const LOGOS = [
  ["logos/nephra-black.png", "Black"],
  ["logos/nephra-white.png", "White"],
  ["logos/nephra-disco.png", "Disco"],
  ["logos/nephra-sunset.png", "Sunset"],
  ["logos/nephra-house.png", "House"],
  ["logos/nephra-techhouse.png", "Tech House"],
];
const ZIPS = [
  ["zips/NEPHRA-Complete-Press-Kit.zip", "Everything · Photos + Logos"],
  ["zips/NEPHRA-Press-Photos.zip", "All press photos"],
  ["zips/NEPHRA-Logos.zip", "All logos"],
];
const ALLOWED = new Set([...PHOTOS, ...LOGOS, ...ZIPS].map(([k]) => k));

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clean = (s, n) => String(s ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, n);
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const res = (status, body, type = "text/html; charset=utf-8", headers = {}) => ({ statusCode: status, headers: { "content-type": type, "cache-control": "no-store", ...headers }, body });
const json = (status, obj) => res(status, JSON.stringify(obj), "application/json");

const FONT = "'Helvetica Neue',Helvetica,Arial,sans-serif";
function shell(inner, preheader = "") {
  return `<!doctype html><html><body style="margin:0;background:#0B0714;font-family:${FONT};color:#fff">
<div style="display:none;max-height:0;overflow:hidden">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0B0714"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
<tr><td style="padding:0 0 24px"><img src="${SITE}/assets/logos/nephra-white.png" width="130" alt="nephra" style="display:block;height:auto"></td></tr>
<tr><td style="height:3px;background:linear-gradient(90deg,#FF4FD8,#7C4DFF);background-color:#7C4DFF;font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td style="background:#150E24;padding:32px 28px;border-radius:0 0 12px 12px">${inner}</td></tr>
<tr><td style="padding:20px 0;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#8A7FA3;text-align:center">NEPHRA · House &amp; Techno · Hyderabad<br><a href="${SITE}" style="color:#B9A8FF;text-decoration:none">nephra.music</a></td></tr>
</table></td></tr></table></body></html>`;
}
const btn = (href, label, bg = "#7C4DFF") => `<a href="${href}" style="display:inline-block;background:${bg};color:#fff;text-decoration:none;font-weight:700;font-size:13px;letter-spacing:.1em;text-transform:uppercase;padding:14px 22px;border-radius:999px;margin:0 8px 8px 0">${label}</a>`;
const h1 = (t) => `<h1 style="margin:0 0 16px;font-size:26px;line-height:1.2;font-weight:600">${t}</h1>`;
const p = (t) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#D9D2E9">${t}</p>`;

async function send({ to, subject, html, text, replyTo }) {
  await ses.send(new SendEmailCommand({
    FromEmailAddress: FROM,
    Destination: { ToAddresses: [to] },
    ReplyToAddresses: replyTo ? [replyTo] : undefined,
    Content: { Simple: { Subject: { Data: subject, Charset: "UTF-8" }, Body: { Html: { Data: html, Charset: "UTF-8" }, Text: { Data: text, Charset: "UTF-8" } } } },
  }));
}

const baseUrl = (event) => `https://${event.requestContext.domainName}`;
const getReq = async (id) => (await ddb.send(new GetCommand({ TableName: TABLE, Key: { id } }))).Item;

function page(title, body) {
  return res(200, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;background:#0B0714;color:#fff;font-family:${FONT};display:grid;place-items:center;min-height:100vh"><div style="max-width:480px;padding:32px;text-align:center">
<img src="${SITE}/assets/logos/nephra-white.png" width="120" alt="nephra" style="margin-bottom:24px"><h1 style="font-weight:600">${esc(title)}</h1><div style="color:#D9D2E9;line-height:1.6">${body}</div></div></body></html>`);
}

// ---- POST /request
async function handleRequest(event) {
  let b;
  try { b = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Invalid request" }); }
  const name = clean(b.name, 120), company = clean(b.company, 160), phone = clean(b.phone, 40), email = clean(b.email, 160).toLowerCase();
  if (!name || !company || !phone || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: "Please fill in all fields with a valid email." });
  const id = randomBytes(9).toString("hex"), token = randomBytes(24).toString("hex");
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { id, token, status: "pending", name, company, phone, email, createdAt: new Date().toISOString(), ttl: Math.floor(Date.now() / 1000) + 400 * 86400 } }));
  const base = baseUrl(event);
  const review = (a) => `${base}/review?id=${id}&t=${token}&a=${a}`;
  const row = (k, v) => `<tr><td style="padding:8px 0;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#8A7FA3;width:110px">${k}</td><td style="padding:8px 0;font-size:15px;color:#fff">${v}</td></tr>`;
  await send({
    to: OWNER, replyTo: email,
    subject: `Press kit request · ${name} (${company})`,
    html: shell(`${h1("New press kit request")}${p("Someone has asked for the press photos and logos.")}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border-top:1px solid #2A2040;border-bottom:1px solid #2A2040">
${row("Name", esc(name))}${row("Company", esc(company))}${row("Phone", esc(phone))}${row("Email", `<a href="mailto:${esc(email)}" style="color:#B9A8FF">${esc(email)}</a>`)}</table>
${btn(review("approve"), "Approve")}${btn(review("decline"), "Decline", "#3A2D55")}
${p(`<span style="font-size:13px;color:#8A7FA3">Approving emails them a branded message with download links valid for ${DAYS} days. Declining sends a polite note. You can also just reply to this email to reach them.</span>`)}`, `${name} from ${company} requests the press kit`),
    text: `New press kit request\n\nName: ${name}\nCompany: ${company}\nPhone: ${phone}\nEmail: ${email}\n\nApprove: ${review("approve")}\nDecline: ${review("decline")}\n`,
  });
  await send({
    to: email, replyTo: OWNER,
    subject: "We've received your NEPHRA press kit request",
    html: shell(`${h1(`Thanks, ${esc(name.split(" ")[0])}.`)}${p("Your request for the NEPHRA press photos and logos is with Neha. You'll hear back by email shortly.")}${p("In the meantime, the Press Deck PDF is always available on the press kit page.")}${btn(`${SITE}/#press`, "Visit press kit")}`, "Your request is with Neha"),
    text: `Thanks, ${name}. Your request for the NEPHRA press photos and logos is with Neha. You'll hear back by email shortly.\n${SITE}/#press\n`,
  });
  return json(200, { ok: true });
}

// ---- GET/POST /review
async function handleReview(event) {
  const q = event.queryStringParameters || {};
  const item = q.id ? await getReq(q.id) : null;
  if (!item || !same(item.token, q.t || "")) return page("Link not valid", "<p>This review link is invalid.</p>");
  const action = q.a === "decline" ? "decline" : "approve";
  if (item.status !== "pending") return page("Already handled", `<p>This request from ${esc(item.name)} was already <b>${esc(item.status)}</b>.</p>`);
  if (event.requestContext.http.method === "GET") {
    const label = action === "approve" ? "Approve & send assets" : "Decline & send note";
    return page(`${action === "approve" ? "Approve" : "Decline"} request?`,
      `<p><b>${esc(item.name)}</b><br>${esc(item.company)}<br>${esc(item.email)} · ${esc(item.phone)}</p>
<form method="POST" action="/review?id=${esc(item.id)}&t=${esc(item.token)}&a=${action}"><button style="background:${action === "approve" ? "#7C4DFF" : "#3A2D55"};color:#fff;border:0;border-radius:999px;padding:14px 24px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;cursor:pointer">${label}</button></form>`);
  }
  const status = action === "approve" ? "approved" : "declined";
  const dlToken = randomBytes(24).toString("hex");
  const expiresAt = Date.now() + DAYS * 86400 * 1000;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: { id: item.id },
      UpdateExpression: "SET #s = :s, decidedAt = :d, dlToken = :k, expiresAt = :e",
      ConditionExpression: "#s = :p", ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": status, ":p": "pending", ":d": new Date().toISOString(), ":k": dlToken, ":e": expiresAt },
    }));
  } catch { return page("Already handled", "<p>This request was already handled.</p>"); }
  if (action === "approve") {
    const base = baseUrl(event);
    const link = (key) => `${base}/dl?id=${item.id}&k=${dlToken}&f=${encodeURIComponent(key)}`;
    const list = (arr) => arr.map(([k, l]) => `<tr><td style="padding:10px 0;border-bottom:1px solid #2A2040;font-size:14px;color:#D9D2E9">${esc(l)}</td><td align="right" style="padding:10px 0;border-bottom:1px solid #2A2040"><a href="${link(k)}" style="color:#B9A8FF;font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;text-decoration:none">↓ Download</a></td></tr>`).join("");
    const sect = (t, arr) => `<div style="margin:24px 0 4px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#FF4FD8;font-weight:700">${t}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${list(arr)}</table>`;
    const textList = (arr) => arr.map(([k, l]) => `${l}: ${link(k)}`).join("\n");
    await send({
      to: item.email, replyTo: OWNER,
      subject: "Your NEPHRA press kit is ready",
      html: shell(`${h1(`You're approved, ${esc(item.name.split(" ")[0])}.`)}${p("Thanks for your interest in NEPHRA. Here are the full-resolution press photos and logos.")}
${btn(link(ZIPS[0][0]), "↓ Download everything (ZIP)")}${sect("Zip bundles", ZIPS.slice(1))}${sect("Press photos", PHOTOS)}${sect("Logos", LOGOS)}
<div style="height:20px"></div>${p(`<span style="font-size:13px;color:#8A7FA3">Links are valid for ${DAYS} days. Please credit photos as supplied and use logos unaltered. For bookings or questions, just reply to this email.</span>`)}
${p("— Team NEPHRA")}`, "Full-resolution photos and logos inside"),
      text: `You're approved, ${item.name}.\n\nEverything (ZIP): ${link(ZIPS[0][0])}\n\n${textList(ZIPS.slice(1))}\n\nPhotos\n${textList(PHOTOS)}\n\nLogos\n${textList(LOGOS)}\n\nLinks valid for ${DAYS} days. Reply to this email with any questions.\n— Team NEPHRA\n`,
    });
    return page("Approved ✓", `<p>A branded email with download links has been sent to <b>${esc(item.email)}</b>.</p>`);
  }
  await send({
    to: item.email, replyTo: OWNER,
    subject: "About your NEPHRA press kit request",
    html: shell(`${h1(`Hi ${esc(item.name.split(" ")[0])},`)}${p("Thank you for your interest in NEPHRA and for taking the time to ask for the press assets.")}${p("We're unable to share the press photos and logos for this request right now. If you think this was a mistake, or you'd like to tell us more about your project, just reply to this email and we'll take another look.")}${p("The Press Deck PDF remains available on the press kit page.")}${btn(`${SITE}/#press`, "Visit press kit")}${p("— Team NEPHRA")}`, "An update on your request"),
    text: `Hi ${item.name},\n\nThank you for your interest in NEPHRA. We're unable to share the press photos and logos for this request right now. If you think this was a mistake, reply to this email and we'll take another look.\n\nThe Press Deck PDF remains available at ${SITE}/#press\n\n— Team NEPHRA\n`,
  });
  return page("Declined", `<p>A polite note has been sent to <b>${esc(item.email)}</b>.</p>`);
}

// ---- GET /dl : checks approval + expiry, then redirects to a short-lived presigned URL
async function handleDownload(event) {
  const q = event.queryStringParameters || {};
  const item = q.id ? await getReq(q.id) : null;
  if (!item || item.status !== "approved" || !same(item.dlToken, q.k || "") || !ALLOWED.has(q.f)) return page("Link not valid", "<p>This download link is invalid.</p>");
  if (Date.now() > item.expiresAt) return page("Link expired", `<p>These links have expired. Reply to your approval email or write to ${esc(OWNER)} for a fresh set.</p>`);
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: q.f, ResponseContentDisposition: `attachment; filename="${q.f.split("/").pop()}"` }), { expiresIn: 300 });
  return res(302, "", "text/plain", { location: url });
}

export const handler = async (event) => {
  try {
    const path = event.rawPath, method = event.requestContext.http.method;
    if (method === "OPTIONS") return res(204, "");
    if (path === "/request" && method === "POST") return await handleRequest(event);
    if (path === "/review" && (method === "GET" || method === "POST")) return await handleReview(event);
    if (path === "/dl" && method === "GET") return await handleDownload(event);
    return res(404, "Not found", "text/plain");
  } catch (e) {
    console.error(e);
    return event.rawPath === "/request" ? json(500, { error: "Something went wrong. Please try again." }) : page("Something went wrong", "<p>Please try again.</p>");
  }
};
