const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const morgan = require('morgan');
const crypto = require('crypto');

const app = express();

// ---------- Middleware ----------
app.use(express.json());
app.use(cors());
app.use(morgan('dev'));

// Serve static frontend at /app
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use('/app', express.static(PUBLIC_DIR));

// ---------- ID / Code helpers ----------
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/1/O/I

function makeId() {
  // Prefer crypto.randomUUID if available
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for older Node versions
  return crypto.randomBytes(16).toString('hex');
}

function generateGroupCode(existingCodes = new Set()) {
  function randomCode() {
    let code = 'SANTA-';
    for (let i = 0; i < 6; i++) {
      const idx = Math.floor(Math.random() * CODE_CHARS.length);
      code += CODE_CHARS[idx];
    }
    return code;
  }

  let code;
  do {
    code = randomCode();
  } while (existingCodes.has(code));
  return code;
}

// ---------- File-based "database" ----------
const DATA_DIR = path.join(__dirname, 'data');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadGroupsFromFile() {
  try {
    ensureDataDir();

    if (!fs.existsSync(GROUPS_FILE)) {
      return {};
    }

    const raw = fs.readFileSync(GROUPS_FILE, 'utf8');
    if (!raw.trim()) return {};

    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed;
    }
    return {};
  } catch (err) {
    console.error('Error loading groups from file:', err);
    return {};
  }
}

function saveGroupsToFile(groups) {
  try {
    ensureDataDir();
    fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving groups to file:', err);
  }
}

let groups = loadGroupsFromFile();

// Ensure each loaded group has a short code
(function ensureGroupCodesOnLoad() {
  const existingCodes = new Set();
  Object.values(groups).forEach((g) => {
    if (g.code) existingCodes.add(g.code);
  });

  let changed = false;

  Object.values(groups).forEach((g) => {
    if (!g.code) {
      g.code = generateGroupCode(existingCodes);
      existingCodes.add(g.code);
      changed = true;
    }
  });

  if (changed) {
    console.log('Assigned codes to existing groups on load.');
    saveGroupsToFile(groups);
  }
})();

// Helper: support both UUID id and code in URLs
function getGroupByIdOrCode(idOrCode) {
  if (groups[idOrCode]) return groups[idOrCode];
  return Object.values(groups).find((g) => g.code === idOrCode) || null;
}

// ---------- Secret Santa assignment logic ----------
function createAssignments(participants) {
  if (!Array.isArray(participants) || participants.length < 2) {
    throw new Error('At least 2 participants are required for assignments.');
  }

  const givers = [...participants];
  let receivers = [...participants];

  function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }

  let attempts = 0;
  const maxAttempts = 50;

  do {
    shuffle(receivers);
    attempts++;

    const badMatch = givers.some((giver, idx) => giver.id === receivers[idx].id);
    if (!badMatch) break;

    if (attempts >= maxAttempts) {
      throw new Error('Could not generate a valid assignment. Try again.');
    }
  } while (true);

  return givers.map((giver, idx) => ({
    giverId: giver.id,
    receiverId: receivers[idx].id,
  }));
}

// ---------- Routes ----------

// Health check
app.get('/', (req, res) => {
  res.send('Santa API running with Express 🎅 (Frontend at /app)');
});

// List all groups
app.get('/api/groups', (req, res) => {
  const groupList = Object.values(groups).map((g) => ({
    id: g.id,
    code: g.code,
    groupName: g.groupName,
    organizerName: g.organizerName,
    organizerEmail: g.organizerEmail,
    createdAt: g.createdAt,
  }));

  res.json({ groups: groupList });
});

// Create group
app.post('/api/groups', (req, res) => {
  const { groupName, organizerName, organizerEmail, participants } = req.body;

  if (!groupName || !organizerName || !organizerEmail || !Array.isArray(participants)) {
    return res.status(400).json({
      error: 'groupName, organizerName, organizerEmail, and participants[] are required.',
    });
  }

  if (participants.length < 2) {
    return res.status(400).json({
      error: 'At least 2 participants are required.',
    });
  }

  const participantList = participants.map((p) => ({
    id: makeId(),
    name: p.name,
    email: p.email || '',
  }));

  let assignments;
  try {
    assignments = createAssignments(participantList);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const groupId = makeId();
  const existingCodes = new Set(Object.values(groups).map((g) => g.code));
  const groupCode = generateGroupCode(existingCodes);
  const createdAt = new Date().toISOString();

  const group = {
    id: groupId,
    code: groupCode,
    groupName,
    organizerName,
    organizerEmail,
    participants: participantList,
    assignments,
    createdAt,
  };

  groups[groupId] = group;
  saveGroupsToFile(groups);

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const organizerUrl = `${baseUrl}/api/groups/${groupCode}`;
  const participantUrls = participantList.map((p) => ({
    participantId: p.id,
    name: p.name,
    url: `${baseUrl}/api/groups/${groupCode}/participant/${p.id}`,
  }));

  return res.status(201).json({
    groupId,
    groupCode,
    groupName,
    organizerName,
    organizerEmail,
    createdAt,
    organizerUrl,
    participantUrls,
  });
});

// Organizer view (JSON)
app.get('/api/groups/:id', (req, res) => {
  const { id } = req.params;
  const group = getGroupByIdOrCode(id);

  if (!group) {
    return res.status(404).json({ error: 'Group not found.' });
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`;

  return res.json({
    id: group.id,
    code: group.code,
    groupName: group.groupName,
    organizerName: group.organizerName,
    organizerEmail: group.organizerEmail,
    createdAt: group.createdAt,
    participants: group.participants,
    assignments: group.assignments,
    links: {
      organizerUrl: `${baseUrl}/api/groups/${group.code}`,
      participantBaseUrl: `${baseUrl}/api/groups/${group.code}/participant/:participantId`,
    },
  });
});

// Participant view – HTML "You got X" page
app.get('/api/groups/:id/participant/:participantId', (req, res) => {
  const { id, participantId } = req.params;
  const group = getGroupByIdOrCode(id);

  if (!group) {
    return res.status(404).send('<h1>Group not found.</h1>');
  }

  const participant = group.participants.find((p) => p.id === participantId);
  if (!participant) {
    return res.status(404).send('<h1>Participant not found in this group.</h1>');
  }

  const assignment = group.assignments.find((a) => a.giverId === participantId);
  if (!assignment) {
    return res.status(500).send('<h1>Assignment not found for this participant.</h1>');
  }

  const receiver = group.participants.find((p) => p.id === assignment.receiverId);
  if (!receiver) {
    return res.status(500).send('<h1>Assigned person not found.</h1>');
  }

  const title = `Who did you get? – ${group.groupName}`;
  const youName = participant.name || 'You';
  const receiverName = receiver.name || 'Someone special';

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${title}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(circle at top, #fee2e2, #f1f5f9);
      min-height: 100vh;
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #ffffff;
      border-radius: 16px;
      padding: 2rem 2.5rem;
      box-shadow: 0 10px 30px rgba(15,23,42,0.15);
      max-width: 480px;
      text-align: center;
    }
    h1 {
      font-size: 1.8rem;
      margin-bottom: 0.5rem;
    }
    h2 {
      font-size: 1.4rem;
      margin-top: 0.25rem;
      color: #4b5563;
    }
    .name {
      font-size: 1.8rem;
      font-weight: 700;
      color: #b91c1c;
      margin: 1.25rem 0 0.75rem;
    }
    .note {
      font-size: 0.95rem;
      color: #6b7280;
      margin-bottom: 1rem;
    }
    .group {
      font-size: 0.9rem;
      color: #9ca3af;
      margin-top: 0.75rem;
    }
    .tag {
      display: inline-block;
      margin-top: 0.5rem;
      background: #fee2e2;
      color: #b91c1c;
      padding: 0.2rem 0.6rem;
      border-radius: 999px;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>🎅 Secret Santa Result</h1>
    <h2>Hi ${youName}!</h2>
    <div class="name">You got <span>${receiverName}</span> 🎁</div>
    <p class="note">Don't tell anyone – keep it a secret!</p>
    <div class="group">
      Group: <strong>${group.groupName}</strong><br/>
      Code: <code>${group.code}</code>
    </div>
    <div class="tag">Share this page link only with yourself</div>
  </div>
</body>
</html>
  `.trim();

  res.send(html);
});

// Regenerate assignments
app.post('/api/groups/:id/regenerate', (req, res) => {
  const { id } = req.params;
  const group = getGroupByIdOrCode(id);

  if (!group) {
    return res.status(404).json({ error: 'Group not found.' });
  }

  if (group.participants.length < 2) {
    return res.status(400).json({
      error: 'At least 2 participants are required to regenerate assignments.',
    });
  }

  let newAssignments;
  try {
    newAssignments = createAssignments(group.participants);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  group.assignments = newAssignments;
  saveGroupsToFile(groups);

  return res.json({
    message: 'Assignments regenerated successfully.',
    groupId: group.id,
    groupCode: group.code,
    assignments: newAssignments,
  });
});

// ---------- Start server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Express server running at http://localhost:${PORT}`);
  console.log(`Frontend available at http://localhost:${PORT}/app`);
});
