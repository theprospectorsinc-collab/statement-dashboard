require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email'
];

const DATA_FILE = path.join(__dirname, '../data.json');
function loadData() {
  if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE));
  return { tokens: {}, completions: {}, accounts: null };
}
function saveData(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

app.get('/auth/google/:slot', (req, res) => {
  const slot = req.params.slot;
  const oauth2Client = makeOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: slot
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state: slot } = req.query;
  const oauth2Client = makeOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const { data } = await oauth2.userinfo.get();
  const appData = loadData();
  appData.tokens[`gmail${slot}`] = tokens;
  appData.tokens[`gmail${slot}_email`] = data.email;
  saveData(appData);
  res.redirect(`/?connected=gmail${slot}&email=${encodeURIComponent(data.email)}`);
});

app.get('/auth/status', (req, res) => {
  const data = loadData();
  res.json({
    gmail1: data.tokens.gmail1 ? { connected: true, email: data.tokens.gmail1_email } : { connected: false },
    gmail2: data.tokens.gmail2 ? { connected: true, email: data.tokens.gmail2_email } : { connected: false }
  });
});

async function getOrCreateFolder(drive, name, parentId = null) {
  const q = parentId
    ? `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
    : `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const { data } = await drive.files.list({ q, fields: 'files(id,name)', spaces: 'drive' });
  if (data.files.length > 0) return data.files[0].id;
  const { data: folder } = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', ...(parentId ? { parents: [parentId] } : {}) },
    fields: 'id'
  });
  return folder.id;
}

async function getMonthlyFolderId(drive, year, month) {
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const folderName = `${year}-${String(month+1).padStart(2,'0')} ${MONTHS[month]}`;
  const rootId = await getOrCreateFolder(drive, 'Monthly Statements');
  return getOrCreateFolder(drive, folderName, rootId);
}

app.post('/api/upload', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
  try {
    const { filename, year, month, mimeType } = req.query;
    const data = loadData();
    if (!data.tokens.gmail1) return res.status(401).json({ error: 'Google Drive not connected' });
    const oauth2Client = makeOAuthClient();
    oauth2Client.setCredentials(data.tokens.gmail1);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const folderId = await getMonthlyFolderId(drive, parseInt(year), parseInt(month));
    const { data: file } = await drive.files.create({
      requestBody: { name: filename, parents: [folderId] },
      media: { mimeType: mimeType || 'application/pdf', body: require('stream').Readable.from(req.body) },
      fields: 'id,name,webViewLink'
    });
    res.json({ success: true, fileId: file.id, fileName: file.name, url: file.webViewLink });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const EMAIL_RULES = [
  { slot: 1, accountId: 26, sender: 'system@sent-via.netsuite.com', keyword: 'invoice' },
  { slot: 2, accountId: 28, sender: 'atm@provider.com', keyword: 'balance' },
  { slot: 1, accountId: 25, sender: 'notifier@nayax.com', keyword: 'statement' },
];

async function scanGmail(slot, rules) {
  const data = loadData();
  const tokens = data.tokens[`gmail${slot}`];
  if (!tokens) return [];
  const oauth2Client = makeOAuthClient();
  oauth2Client.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const results = [];
  for (const rule of rules) {
    try {
      const { data: list } = await gmail.users.messages.list({ userId: 'me', q: `from:${rule.sender} newer_than:35d`, maxResults: 10 });
      if (!list.messages) continue;
      for (const msg of list.messages) {
        const { data: full } = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
        const headers = full.payload.headers;
        const parts = full.payload.parts || [];
        const attachments = parts.filter(p => p.filename && p.body?.attachmentId);
        let bodyLink = null;
        const bodyPart = parts.find(p => p.mimeType === 'text/html') || parts.find(p => p.mimeType === 'text/plain');
        if (bodyPart?.body?.data && attachments.length === 0) {
          const bodyText = Buffer.from(bodyPart.body.data, 'base64').toString();
          const linkMatch = bodyText.match(/https?:\/\/[^\s"'<>]+/);
          if (linkMatch) bodyLink = linkMatch[0];
        }
        results.push({
          accountId: rule.accountId, messageId: msg.id,
          subject: headers.find(h => h.name === 'Subject')?.value || '',
          date: headers.find(h => h.name === 'Date')?.value || '',
          hasAttachment: attachments.length > 0,
          attachments: attachments.map(a => ({ name: a.filename, attachmentId: a.body.attachmentId })),
          bodyLink, sender: rule.sender
        });
      }
    } catch (err) { console.error(`Scan error for ${rule.sender}:`, err.message); }
  }
  return results;
}

app.get('/api/scan', async (req, res) => {
  try {
    const [r1, r2] = await Promise.all([scanGmail(1, EMAIL_RULES.filter(r=>r.slot===1)), scanGmail(2, EMAIL_RULES.filter(r=>r.slot===2))]);
    res.json({ results: [...r1, ...r2] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auto-file', async (req, res) => {
  try {
    const { messageId, attachmentId, filename, accountId, year, month, gmailSlot } = req.body;
    const data = loadData();
    const oauth2Client = makeOAuthClient();
    oauth2Client.setCredentials(data.tokens[`gmail${gmailSlot}`]);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const { data: attachment } = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
    const fileBuffer = Buffer.from(attachment.data, 'base64');
    const folderId = await getMonthlyFolderId(drive, parseInt(year), parseInt(month));
    const { data: file } = await drive.files.create({
      requestBody: { name: filename, parents: [folderId] },
      media: { mimeType: 'application/pdf', body: require('stream').Readable.from(fileBuffer) },
      fields: 'id,name,webViewLink'
    });
    const key = `${year}-${String(month).padStart(2,'0')}_${accountId}`;
    data.completions[key] = { fileName: filename, uploadedAt: new Date().toISOString(), auto: true };
    saveData(data);
    res.json({ success: true, fileId: file.id, fileName: file.name, url: file.webViewLink });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/completions', (req, res) => { res.json(loadData().completions || {}); });
app.post('/api/completions', (req, res) => { const d=loadData(); d.completions=req.body; saveData(d); res.json({success:true}); });
app.get('/api/accounts', (req, res) => { res.json(loadData().accounts || null); });
app.post('/api/accounts', (req, res) => { const d=loadData(); d.accounts=req.body; saveData(d); res.json({success:true}); });

cron.schedule('0 8 * * *', async () => {
  console.log('Running daily Gmail scan...');
  const [r1,r2] = await Promise.all([scanGmail(1,EMAIL_RULES.filter(r=>r.slot===1)),scanGmail(2,EMAIL_RULES.filter(r=>r.slot===2))]);
  console.log(`Scan complete: ${[...r1,...r2].length} emails found`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Statement dashboard running on port ${PORT}`));
