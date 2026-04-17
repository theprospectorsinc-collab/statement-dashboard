require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
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

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email'
];

const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email'
];

const DATA_FILE = path.join(__dirname, '..', 'data.json');
function loadData() {
  if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE));
  return { tokens: {}, completions: {}, accounts: null };
}
function saveData(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
} app.get('/auth/google/:slot', (req, res) => {
  const slot = req.params.slot;
  const oauth2Client = makeOAuthClient();
  const scopes = slot === 'drive' ? DRIVE_SCOPES : GMAIL_SCOPES;
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
    state: slot
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state: slot } = req.query;
  try {
    const oauth2Client = makeOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    const appData = loadData();
    if (slot === 'drive') {
      appData.tokens.drive = tokens;
      appData.tokens.drive_email = data.email;
    } else {
      appData.tokens[`gmail${slot}`] = tokens;
      appData.tokens[`gmail${slot}_email`] = data.email;
    }
    saveData(appData);
    res.redirect(`/?connected=${slot}&email=${encodeURIComponent(data.email)}`);
  } catch (err) {
    console.error('Auth callback error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/status', (req, res) => {
  const data = loadData();
  res.json({
    gmail1: data.tokens.gmail1 ? { connected: true, email: data.tokens.gmail1_email } : { connected: false },
    gmail2: data.tokens.gmail2 ? { connected: true, email: data.tokens.gmail2_email } : { connected: false },
    drive: data.tokens.drive ? { connected: true, email: data.tokens.drive_email } : { connected: false }
  });
});

async function uploadToDropbox(fileBuffer, filename, year, month) {
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const folderName = `${year}-${String(month+1).padStart(2,'0')} ${MONTHS[month]}`;
  const dropboxPath = `/Monthly Statements/${folderName}/${filename}`;
  const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.DROPBOX_TOKEN}`,
      'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath, mode: 'overwrite', autorename: false }),
      'Content-Type': 'application/octet-stream'
    },
    body: fileBuffer
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_summary || 'Dropbox upload failed');
  return { path: dropboxPath, name: filename };
}

app.post('/api/upload', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
  try {
    const { filename, year, month } = req.query;
    if (!process.env.DROPBOX_TOKEN) return res.status(401).json({ error: 'Dropbox not configured' });
    const result = await uploadToDropbox(req.body, filename, parseInt(year), parseInt(month));
    res.json({ success: true, fileName: result.name, path: result.path });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
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
        results.push({
          accountId: rule.accountId,
          messageId: msg.id,
          subject: headers.find(h => h.name === 'Subject')?.value || '',
          date: headers.find(h => h.name === 'Date')?.value || '',
          hasAttachment: attachments.length > 0,
          attachments: attachments.map(a => ({ name: a.filename, attachmentId: a.body.attachmentId })),
          sender: rule.sender,
          gmailSlot: slot
        });
      }
    } catch (err) { console.error(`Scan error for ${rule.sender}:`, err.message); }
  }
  return results;
}

app.get('/api/scan', async (req, res) => {
  try {
    const [r1, r2] = await Promise.all([
      scanGmail(1, EMAIL_RULES.filter(r => r.slot === 1)),
      scanGmail(2, EMAIL_RULES.filter(r => r.slot === 2))
    ]);
    res.json({ results: [...r1, ...r2] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auto-file', async (req, res) => {
  try {
    const { messageId, attachmentId, filename, accountId, year, month, gmailSlot } = req.body;
    const data = loadData();
    const gmailTokens = data.tokens[`gmail${gmailSlot}`];
    if (!gmailTokens) return res.status(401).json({ error: 'Gmail not connected' });
    const gmailClient = makeOAuthClient();
    gmailClient.setCredentials(gmailTokens);
    const gmail = google.gmail({ version: 'v1', auth: gmailClient });
    const { data: attachment } = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
    const fileBuffer = Buffer.from(attachment.data, 'base64');
    const drive = getDriveClient();
    if (!drive) return res.status(401).json({ error: 'No Drive account connected' });
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
  } catch (err) {
    console.error('Auto-file error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.get('/api/completions', (req, res) => { res.json(loadData().completions || {}); });
app.post('/api/completions', (req, res) => { const d = loadData(); d.completions = req.body; saveData(d); res.json({ success: true }); });
app.get('/api/accounts', (req, res) => { res.json(loadData().accounts || null); });
app.post('/api/accounts', (req, res) => { const d = loadData(); d.accounts = req.body; saveData(d); res.json({ success: true }); });
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

cron.schedule('0 8 * * *', async () => {
  console.log('Running daily Gmail scan...');
  const [r1, r2] = await Promise.all([
    scanGmail(1, EMAIL_RULES.filter(r => r.slot === 1)),
    scanGmail(2, EMAIL_RULES.filter(r => r.slot === 2))
  ]);
  console.log(`Scan complete: ${[...r1, ...r2].length} emails found`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Statement dashboard running on port ${PORT}`));
