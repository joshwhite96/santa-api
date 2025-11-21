require('dotenv').config(); // load .env

console.log(
  'DEBUG ENV:',
  'RESEND_API_KEY present =', !!process.env.RESEND_API_KEY,
  'SENDER_EMAIL =', process.env.SENDER_EMAIL,
  'DATABASE_URL present =', !!process.env.DATABASE_URL
);

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const morgan = require('morgan');
const crypto = require('crypto');
const { Resend } = require('resend');
const { Pool } = require('pg');

const app = express();

// ---------- Resend setup ----------
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SENDER_EMAIL = process.env.SENDER_EMAIL;

let resend = null;
if (RESEND_API_KEY && SENDER_EMAIL) {
  resend = new Resend(RESEND_API_KEY);
  console.log('Resend configured.');
} else {
  console.warn('Resend NOT configured. Set RESEND_API_KEY and SENDER_EMAIL to enable email sending.');
}

// ---------- Mode: DB or JSON file ----------
const USE_DB = !!process.env.DATABASE_URL;
let pool = null;

if (USE_DB) {
  console.log('Using Supabase/Postgres via DATABASE_URL');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('supabase.co')
      ? { rejectUnauthorized: false }
      : false
  });
} else {
  console.log('Using local JSON file storage');
}

// ---------- Shared helpers ----------
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/1/O/I

function randomGroupCode() {
  let code = 'SANTA-';
  for (let i = 0; i < 6; i++) {
    const idx = Math.floor(Math.random() * CODE_CHARS.length);
    code += CODE_CHARS[idx];
  }
  return code;
}

async function generateUniqueGroupCodeDb(client) {
  while (true) {
    const code = randomGroupCode();
    const { rowCount } = await client.query(
      'select 1 from groups where code = $1',
      [code]
    );
    if (rowCount === 0) return code;
  }
}

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
    receiverId: receivers[idx].id
  }));
}

// small delay helper for throttling emails
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// throttled email sender
async function sendParticipantEmailsForGroup(group, baseUrl) {
  if (!resend || !SENDER_EMAIL) {
    throw new Error('Email sending is not configured. Missing RESEND_API_KEY or SENDER_EMAIL.');
  }

  let sentCount = 0;
  let skippedCount = 0;

  for (const p of group.participants) {
    if (!p.email) {
      skippedCount++;
      continue;
    }

    const participantUrl = `${baseUrl}/api/groups/${group.code}/participant/${p.id}`;

    try {
      const { error } = await resend.emails.send({
        from: SENDER_EMAIL,
        to: p.email,
        subject: `Your Secret Santa assignment for ${group.groupName}`,
        text: [
          `Hi ${p.name || 'there'},`,
          ``,
          `Your Secret Santa group "${group.groupName}" is ready!`,
          ``,
          `Click this link to see who you got:`,
          participantUrl,
          ``,
          `Please keep it a secret 🎅`,
        ].join('\n'),
      });

      if (error) {
        console.error('Resend error for', p.email, error);
        continue;
      }

      sentCount++;
    } catch (err) {
      console.error(`Error sending email to ${p.email}:`, err);
      continue;
    }

    // throttle: wait 250ms between each email
    await wait(250);
  }

  return { sentCount, skippedCount };
}

// ---------- JSON file storage ----------
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
    if (!fs.existsSync(GROUPS_FILE)) return {};
    const raw = fs.readFileSync(GROUPS_FILE, 'utf8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
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

let fileGroups = USE_DB ? null : loadGroupsFromFile();

function makeId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function generateUniqueGroupCodeFile() {
  const existingCodes = new Set(
    Object.values(fileGroups).map((g) => g.code).filter(Boolean)
  );
  let code;
  do {
    code = randomGroupCode();
  } while (existingCodes.has(code));
  return code;
}

function findFileGroupByIdOrCode(idOrCode) {
  if (fileGroups[idOrCode]) return fileGroups[idOrCode];
  return Object.values(fileGroups).find((g) => g.code === idOrCode) || null;
}

function getGroupFullFileByIdOrCode(idOrCode) {
  const g = findFileGroupByIdOrCode(idOrCode);
  if (!g) return null;

  return {
    group: {
      id: g.id,
      code: g.code,
      group_name: g.groupName,
      organizer_name: g.organizerName,
      organizer_email: g.organizerEmail,
      created_at: g.createdAt
    },
    participants: g.participants,
    assignments: g.assignments.map((a) => ({
      giver_id: a.giverId,
      receiver_id: a.receiverId
    }))
  };
}

// ---------- DB helpers ----------
async function getGroupFullDbByIdOrCode(idOrCode) {
  const groupRes = await pool.query(
    `
    select id, code, group_name, organizer_name, organizer_email, created_at
    from groups
    where code = $1
       or id::text = $1
    limit 1
    `,
    [idOrCode]
  );
  if (groupRes.rowCount === 0) return null;
  const group = groupRes.rows[0];

  const participantsRes = await pool.query(
    `
    select id, name, email
    from participants
    where group_id = $1
    order by name nulls last, email
    `,
    [group.id]
  );
  const assignmentsRes = await pool.query(
    `
    select giver_id, receiver_id
    from assignments
    where group_id = $1
    `,
    [group.id]
  );

  return {
    group,
    participants: participantsRes.rows,
    assignments: assignmentsRes.rows
  };
}

// ---------- Middleware ----------
app.use(express.json());
app.use(cors());
app.use(morgan('dev'));

// Root redirect to frontend
app.get('/', (req, res) => {
  res.redirect('/app');
});

// Serve static frontend at /app
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use('/app', express.static(PUBLIC_DIR));

// ---------- Routes ----------

// List all groups
app.get('/api/groups', async (req, res) => {
  try {
    if (USE_DB) {
      const result = await pool.query(`
        select id, code, group_name, organizer_name, organizer_email, created_at
        from groups
        order by created_at desc
      `);
      const groups = result.rows.map((g) => ({
        id: g.id,
        code: g.code,
        groupName: g.group_name,
        organizerName: g.organizer_name,
        organizerEmail: g.organizer_email,
        createdAt: g.created_at
      }));
      return res.json({ groups });
    } else {
      const groups = Object.values(fileGroups).map((g) => ({
        id: g.id,
        code: g.code,
        groupName: g.groupName,
        organizerName: g.organizerName,
        organizerEmail: g.organizerEmail,
        createdAt: g.createdAt
      }));
      return res.json({ groups });
    }
  } catch (err) {
    console.error('Error listing groups:', err);
    res.status(500).json({ error: 'Failed to list groups.' });
  }
});

// Create group
app.post('/api/groups', async (req, res) => {
  const { groupName, organizerName, organizerEmail, participants } = req.body;

  if (!groupName || !organizerName || !organizerEmail || !Array.isArray(participants)) {
    return res.status(400).json({
      error: 'groupName, organizerName, organizerEmail, and participants[] are required.'
    });
  }

  if (participants.length < 2) {
    return res.status(400).json({
      error: 'At least 2 participants are required.'
    });
  }

  if (USE_DB) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const groupCode = await generateUniqueGroupCodeDb(client);
      const groupInsert = await client.query(
        `
        insert into groups (code, group_name, organizer_name, organizer_email)
        values ($1, $2, $3, $4)
        returning id, created_at
        `,
        [groupCode, groupName, organizerName, organizerEmail]
      );

      const groupId = groupInsert.rows[0].id;
      const createdAt = groupInsert.rows[0].created_at;

      const participantList = [];
      for (const p of participants) {
        const r = await client.query(
          `
          insert into participants (group_id, name, email)
          values ($1, $2, $3)
          returning id, name, email
          `,
          [groupId, p.name || null, p.email || '']
        );
        participantList.push(r.rows[0]);
      }

      const assignments = createAssignments(participantList);
      for (const a of assignments) {
        await client.query(
          `
          insert into assignments (group_id, giver_id, receiver_id)
          values ($1, $2, $3)
          `,
          [groupId, a.giverId, a.receiverId]
        );
      }

      await client.query('COMMIT');

      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const organizerUrl = `${baseUrl}/api/groups/${groupCode}`;
      const participantUrls = participantList.map((p) => ({
        participantId: p.id,
        name: p.name,
        url: `${baseUrl}/api/groups/${groupCode}/participant/${p.id}`
      }));

      return res.status(201).json({
        groupId,
        groupCode,
        groupName,
        organizerName,
        organizerEmail,
        createdAt,
        organizerUrl,
        participantUrls
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error creating group (DB):', err);
      return res.status(500).json({ error: 'Failed to create group.' });
    } finally {
      client.release();
    }
  } else {
    try {
      const participantList = participants.map((p) => ({
        id: makeId(),
        name: p.name,
        email: p.email || ''
      }));

      const assignments = createAssignments(participantList);
      const groupId = makeId();
      const groupCode = generateUniqueGroupCodeFile();
      const createdAt = new Date().toISOString();

      const group = {
        id: groupId,
        code: groupCode,
        groupName,
        organizerName,
        organizerEmail,
        participants: participantList,
        assignments,
        createdAt
      };

      fileGroups[groupId] = group;
      saveGroupsToFile(fileGroups);

      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const organizerUrl = `${baseUrl}/api/groups/${groupCode}`;
      const participantUrls = participantList.map((p) => ({
        participantId: p.id,
        name: p.name,
        url: `${baseUrl}/api/groups/${groupCode}/participant/${p.id}`
      }));

      return res.status(201).json({
        groupId,
        groupCode,
        groupName,
        organizerName,
        organizerEmail,
        createdAt,
        organizerUrl,
        participantUrls
      });
    } catch (err) {
      console.error('Error creating group (file):', err);
      return res.status(500).json({ error: 'Failed to create group.' });
    }
  }
});

// Organizer view (JSON)
app.get('/api/groups/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const full = USE_DB
      ? await getGroupFullDbByIdOrCode(id)
      : getGroupFullFileByIdOrCode(id);

    if (!full) {
      return res.status(404).json({ error: 'Group not found.' });
    }

    const { group, participants, assignments } = full;
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    return res.json({
      id: group.id,
      code: group.code,
      groupName: group.group_name,
      organizerName: group.organizer_name,
      organizerEmail: group.organizer_email,
      createdAt: group.created_at,
      participants,
      assignments: assignments.map((a) => ({
        giverId: a.giver_id,
        receiverId: a.receiver_id
      })),
      links: {
        organizerUrl: `${baseUrl}/api/groups/${group.code}`,
        participantBaseUrl: `${baseUrl}/api/groups/${group.code}/participant/:participantId`
      }
    });
  } catch (err) {
    console.error('Error loading group:', err);
    res.status(500).json({ error: 'Failed to load group.' });
  }
});

// Participant view – "You got X"
app.get('/api/groups/:id/participant/:participantId', async (req, res) => {
  const { id, participantId } = req.params;

  try {
    const full = USE_DB
      ? await getGroupFullDbByIdOrCode(id)
      : getGroupFullFileByIdOrCode(id);

    if (!full) {
      return res.status(404).send('<h1>Group not found.</h1>');
    }

    const { group, participants, assignments } = full;

    const participant = participants.find((p) => p.id === participantId);
    if (!participant) {
      return res.status(404).send('<h1>Participant not found in this group.</h1>');
    }

    const assignment = assignments.find((a) => a.giver_id === participantId);
    if (!assignment) {
      return res.status(500).send('<h1>Assignment not found for this participant.</h1>');
    }

    const receiver = participants.find((p) => p.id === assignment.receiver_id);
    if (!receiver) {
      return res.status(500).send('<h1>Assigned person not found.</h1>');
    }

    const title = `Who did you get? – ${group.group_name}`;
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
    .name span {
      white-space: nowrap;
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
      Group: <strong>${group.group_name}</strong><br/>
      Code: <code>${group.code}</code>
    </div>
    <div class="tag">Share this page link only with yourself</div>
  </div>
</body>
</html>
    `.trim();

    res.send(html);
  } catch (err) {
    console.error('Error rendering participant view:', err);
    res.status(500).send('<h1>Something went wrong.</h1>');
  }
});

// Regenerate assignments (keeping just in case)
app.post('/api/groups/:id/regenerate', async (req, res) => {
  const { id } = req.params;

  if (USE_DB) {
    const client = await pool.connect();
    try {
      const full = await getGroupFullDbByIdOrCode(id);
      if (!full) {
        client.release();
        return res.status(404).json({ error: 'Group not found.' });
      }

      const { group, participants } = full;

      if (participants.length < 2) {
        client.release();
        return res.status(400).json({
          error: 'At least 2 participants are required to regenerate assignments.'
        });
      }

      const newAssignments = createAssignments(participants);

      await client.query('BEGIN');
      await client.query('delete from assignments where group_id = $1', [group.id]);

      for (const a of newAssignments) {
        await client.query(
          `
          insert into assignments (group_id, giver_id, receiver_id)
          values ($1, $2, $3)
          `,
          [group.id, a.giverId, a.receiverId]
        );
      }

      await client.query('COMMIT');

      return res.json({
        message: 'Assignments regenerated successfully.',
        groupId: group.id,
        groupCode: group.code,
        assignments: newAssignments
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error regenerating assignments (DB):', err);
      return res.status(500).json({ error: 'Failed to regenerate assignments.' });
    } finally {
      client.release();
    }
  } else {
    try {
      const full = getGroupFullFileByIdOrCode(id);
      if (!full) {
        return res.status(404).json({ error: 'Group not found.' });
      }

      const { group, participants } = full;
      if (participants.length < 2) {
        return res.status(400).json({
          error: 'At least 2 participants are required to regenerate assignments.'
        });
      }

      const newAssignments = createAssignments(participants);
      const fileGroup = findFileGroupByIdOrCode(id);
      if (fileGroup) {
        fileGroup.assignments = newAssignments.map((a) => ({
          giverId: a.giverId,
          receiverId: a.receiverId
        }));
        saveGroupsToFile(fileGroups);
      }

      return res.json({
        message: 'Assignments regenerated successfully.',
        groupId: group.id,
        groupCode: group.code,
        assignments: newAssignments
      });
    } catch (err) {
      console.error('Error regenerating assignments (file):', err);
      return res.status(500).json({ error: 'Failed to regenerate assignments.' });
    }
  }
});

// EDIT group (title + organizer info)
app.patch('/api/groups/:id', async (req, res) => {
  const { id } = req.params;
  const { groupName, organizerName, organizerEmail } = req.body;

  if (!groupName || !organizerName || !organizerEmail) {
    return res.status(400).json({
      error: 'groupName, organizerName, and organizerEmail are required.'
    });
  }

  try {
    if (USE_DB) {
      const result = await pool.query(
        `
        update groups
        set group_name = $2,
            organizer_name = $3,
            organizer_email = $4
        where id::text = $1
           or code = $1
        returning id
        `,
        [id, groupName, organizerName, organizerEmail]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Group not found.' });
      }

      const full = await getGroupFullDbByIdOrCode(id);
      const { group, participants, assignments } = full;
      const baseUrl = `${req.protocol}://${req.get('host')}`;

      return res.json({
        id: group.id,
        code: group.code,
        groupName: group.group_name,
        organizerName: group.organizer_name,
        organizerEmail: group.organizer_email,
        createdAt: group.created_at,
        participants,
        assignments: assignments.map((a) => ({
          giverId: a.giver_id,
          receiverId: a.receiver_id
        })),
        links: {
          organizerUrl: `${baseUrl}/api/groups/${group.code}`,
          participantBaseUrl: `${baseUrl}/api/groups/${group.code}/participant/:participantId`
        }
      });
    } else {
      const g = findFileGroupByIdOrCode(id);
      if (!g) {
        return res.status(404).json({ error: 'Group not found.' });
      }

      g.groupName = groupName;
      g.organizerName = organizerName;
      g.organizerEmail = organizerEmail;
      saveGroupsToFile(fileGroups);

      const full = getGroupFullFileByIdOrCode(id);
      const { group, participants, assignments } = full;
      const baseUrl = `${req.protocol}://${req.get('host')}`;

      return res.json({
        id: group.id,
        code: group.code,
        groupName: group.group_name,
        organizerName: group.organizer_name,
        organizerEmail: group.organizer_email,
        createdAt: group.created_at,
        participants,
        assignments: assignments.map((a) => ({
          giverId: a.giver_id,
          receiverId: a.receiver_id
        })),
        links: {
          organizerUrl: `${baseUrl}/api/groups/${group.code}`,
          participantBaseUrl: `${baseUrl}/api/groups/${group.code}/participant/:participantId`
        }
      });
    }
  } catch (err) {
    console.error('Error updating group:', err);
    res.status(500).json({ error: 'Failed to update group.' });
  }
});

// UPDATE participants (replace list + regenerate assignments)
app.put('/api/groups/:id/participants', async (req, res) => {
  const { id } = req.params;
  const { participants } = req.body;

  if (!Array.isArray(participants)) {
    return res.status(400).json({ error: 'participants[] is required.' });
  }

  const cleaned = participants
    .map((p) => ({
      name: (p.name || '').trim(),
      email: (p.email || '').trim()
    }))
    .filter((p) => p.name || p.email);

  if (cleaned.length < 2) {
    return res.status(400).json({
      error: 'At least 2 non-empty participants (name or email) are required.'
    });
  }

  if (USE_DB) {
    const client = await pool.connect();
    try {
      const full = await getGroupFullDbByIdOrCode(id);
      if (!full) {
        client.release();
        return res.status(404).json({ error: 'Group not found.' });
      }

      const { group } = full;
      const groupId = group.id;

      await client.query('BEGIN');

      await client.query('delete from assignments where group_id = $1', [groupId]);
      await client.query('delete from participants where group_id = $1', [groupId]);

      const participantList = [];
      for (const p of cleaned) {
        const r = await client.query(
          `
          insert into participants (group_id, name, email)
          values ($1, $2, $3)
          returning id, name, email
          `,
          [groupId, p.name || null, p.email || '']
        );
        participantList.push(r.rows[0]);
      }

      const assignments = createAssignments(participantList);

      for (const a of assignments) {
        await client.query(
          `
          insert into assignments (group_id, giver_id, receiver_id)
          values ($1, $2, $3)
          `,
          [groupId, a.giverId, a.receiverId]
        );
      }

      await client.query('COMMIT');

      const updated = await getGroupFullDbByIdOrCode(id);
      const { group: g2, participants: p2, assignments: a2 } = updated;
      const baseUrl = `${req.protocol}://${req.get('host')}`;

      return res.json({
        id: g2.id,
        code: g2.code,
        groupName: g2.group_name,
        organizerName: g2.organizer_name,
        organizerEmail: g2.organizer_email,
        createdAt: g2.created_at,
        participants: p2,
        assignments: a2.map((a) => ({
          giverId: a.giver_id,
          receiverId: a.receiver_id
        })),
        links: {
          organizerUrl: `${baseUrl}/api/groups/${g2.code}`,
          participantBaseUrl: `${baseUrl}/api/groups/${g2.code}/participant/:participantId`
        }
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error updating participants (DB):', err);
      return res.status(500).json({ error: 'Failed to update participants.' });
    } finally {
      client.release();
    }
  } else {
    try {
      const g = findFileGroupByIdOrCode(id);
      if (!g) {
        return res.status(404).json({ error: 'Group not found.' });
      }

      const participantList = cleaned.map((p) => ({
        id: makeId(),
        name: p.name,
        email: p.email || ''
      }));

      const assignments = createAssignments(participantList);

      g.participants = participantList;
      g.assignments = assignments.map((a) => ({
        giverId: a.giverId,
        receiverId: a.receiverId
      }));
      saveGroupsToFile(fileGroups);

      const full = getGroupFullFileByIdOrCode(id);
      const { group, participants: p2, assignments: a2 } = full;
      const baseUrl = `${req.protocol}://${req.get('host')}`;

      return res.json({
        id: group.id,
        code: group.code,
        groupName: group.group_name,
        organizerName: group.organizer_name,
        organizerEmail: group.organizer_email,
        createdAt: group.created_at,
        participants: p2,
        assignments: a2.map((a) => ({
          giverId: a.giver_id,
          receiverId: a.receiver_id
        })),
        links: {
          organizerUrl: `${baseUrl}/api/groups/${group.code}`,
          participantBaseUrl: `${baseUrl}/api/groups/${group.code}/participant/:participantId`
        }
      });
    } catch (err) {
      console.error('Error updating participants (file):', err);
      return res.status(500).json({ error: 'Failed to update participants.' });
    }
  }
});

// DELETE group
app.delete('/api/groups/:id', async (req, res) => {
  const { id } = req.params;

  try {
    if (USE_DB) {
      const result = await pool.query(
        `
        delete from groups
        where id::text = $1
           or code = $1
        `,
        [id]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Group not found.' });
      }

      return res.json({ message: 'Group deleted.' });
    } else {
      const g = findFileGroupByIdOrCode(id);
      if (!g) {
        return res.status(404).json({ error: 'Group not found.' });
      }
      delete fileGroups[g.id];
      saveGroupsToFile(fileGroups);
      return res.json({ message: 'Group deleted.' });
    }
  } catch (err) {
    console.error('Error deleting group:', err);
    res.status(500).json({ error: 'Failed to delete group.' });
  }
});

// Send emails to participants (throttled)
app.post('/api/groups/:id/send-emails', async (req, res) => {
  const { id } = req.params;

  try {
    const full = USE_DB
      ? await getGroupFullDbByIdOrCode(id)
      : getGroupFullFileByIdOrCode(id);

    if (!full) {
      return res.status(404).json({ error: 'Group not found.' });
    }

    const { group, participants } = full;

    if (!resend || !SENDER_EMAIL) {
      return res.status(500).json({
        error: 'Email sending is not configured on the server.'
      });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const { sentCount, skippedCount } = await sendParticipantEmailsForGroup(
      {
        groupName: group.group_name,
        code: group.code,
        participants
      },
      baseUrl
    );

    return res.json({
      message: 'Emails processed (throttled).',
      sentCount,
      skippedCount
    });
  } catch (err) {
    console.error('Error sending emails:', err);
    return res.status(500).json({ error: 'Failed to send emails to participants.' });
  }
});

// ---------- Start server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Express server running at http://localhost:${PORT}`);
  console.log(`Frontend available at http://localhost:${PORT}/app`);
});
