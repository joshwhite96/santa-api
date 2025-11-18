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

    const { error } = await resend.emails.send({
      from: SENDER_EMAIL,
      to: p.email,
      subject: `Your Secret Santa assignment for ${group.groupName}`,
      text: [
        `Hi ${p.name || 'there'},`,
        '',
        `Your Secret Santa group "${group.groupName}" is ready!`,
        '',
        `Click this link to see who you got:`,
        participantUrl,
        '',
        `Please keep it a secret 🎅`,
      ].join('\n'),
      html: `
        <p>Hi ${p.name || 'there'},</p>
        <p>Your Secret Santa group <strong>${group.groupName}</strong> is ready!</p>
        <p>
          Click this link to see who you got:<br/>
          <a href="${participantUrl}" target="_blank">${participantUrl}</a>
        </p>
        <p>Please keep it a secret 🎅</p>
      `
    });

    if (error) {
      console.error('Resend error for', p.email, error);
      continue;
    }

    sentCount++;
  }

  return { sentCount, skippedCount };
}

// ---------- JSON file storage implementation ----------
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

function getGroupFullFileByIdOrCode(idOrCode) {
  if (fileGroups[idOrCode]) {
    const g = fileGroups[idOrCode];
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

  const g = Object.values(fileGroups).find((x) => x.code === idOrCode);
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

// ---------- NEW: Root redirect ----------
app.get('/', (req, res) => {
  res.redirect('/app');
});

// Serve static frontend at /app
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use('/app', express.static(PUBLIC_DIR));

// ---------- Routes ----------
app.get('/api/groups', async (req, res) => {
  try {
    if (USE_DB) {
      const result = await pool.query(`
        select id, code, group_name, organizer_name, organizer_email, created_at
        from groups
        order by created_at desc
      `);
      return res.json({ groups: result.rows });
    } else {
      return res.json({ groups: Object.values(fileGroups) });
    }
  } catch (err) {
    console.error('Error listing groups:', err);
    res.status(500).json({ error: 'Failed to list groups.' });
  }
});

// ----- Create group -----
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
    return createGroupDb(req, res);
  } else {
    return createGroupFile(req, res);
  }
});

async function createGroupDb(req, res) {
  const { groupName, organizerName, organizerEmail, participants } = req.body;
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
        [groupId, p.name, p.email]
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
    await client.query('ROLLBACK');
    console.error('Error creating group (DB):', err);
    return res.status(500).json({ error: 'Failed to create group.' });
  } finally {
    client.release();
  }
}

function createGroupFile(req, res) {
  const { groupName, organizerName, organizerEmail, participants } = req.body;

  const participantList = participants.map((p) => ({
    id: makeId(),
    name: p.name,
    email: p.email
  }));

  const assignments = createAssignments(participantList);
  const groupId = makeId();
  const groupCode = generateUniqueGroupCodeFile();
  const createdAt = new Date().toISOString();

  fileGroups[groupId] = {
    id: groupId,
    code: groupCode,
    groupName,
    organizerName,
    organizerEmail,
    participants: participantList,
    assignments,
    createdAt
  };

  saveGroupsToFile(fileGroups);

  const baseUrl = `${req.protocol}://${req.get('host')}`;

  return res.status(201).json({
    groupId,
    groupCode,
    groupName,
    organizerName,
    organizerEmail,
    createdAt,
    organizerUrl: `${baseUrl}/api/groups/${groupCode}`,
    participantUrls: participantList.map((p) => ({
      participantId: p.id,
      name: p.name,
      url: `${baseUrl}/api/groups/${groupCode}/participant/${p.id}`
    }))
  });
}

// ----- Organizer view -----
app.get('/api/groups/:id', async (req, res) => {
  const { id } = req.params;

  const full = USE_DB
    ? await getGroupFullDbByIdOrCode(id)
    : getGroupFullFileByIdOrCode(id);

  if (!full) {
    return res.status(404).json({ error: 'Group not found.' });
  }

  const { group, participants, assignments } = full;

  return res.json({
    id: group.id,
    code: group.code,
    groupName: group.group_name,
    organizerName: group.organizer_name,
    organizerEmail: group.organizer_email,
    createdAt: group.created_at,
    participants,
    assignments
  });
});

// ----- Participant page -----
app.get('/api/groups/:id/participant/:participantId', async (req, res) => {
  const { id, participantId } = req.params;

  const full = USE_DB
    ? await getGroupFullDbByIdOrCode(id)
    : getGroupFullFileByIdOrCode(id);

  if (!full) return res.status(404).send('<h1>Group not found.</h1>');

  const { group, participants, assignments } = full;

  const participant = participants.find((p) => p.id === participantId);
  if (!participant) return res.status(404).send('<h1>Participant not found.</h1>');

  const assignment = assignments.find((a) => a.giver_id === participantId);
  if (!assignment) return res.status(500).send('<h1>No assignment found.</h1>');

  const receiver = participants.find((p) => p.id === assignment.receiver_id);
  if (!receiver) return res.status(500).send('<h1>Receiver not found.</h1>');

  res.send(`
    <h1>You got: ${receiver.name}</h1>
    <p>Group: ${group.group_name}</p>
    <p>Keep it secret 🎅</p>
  `);
});

// ----- Send Emails -----
app.post('/api/groups/:id/send-emails', async (req, res) => {
  const { id } = req.params;

  const full = USE_DB
    ? await getGroupFullDbByIdOrCode(id)
    : getGroupFullFileByIdOrCode(id);

  if (!full) return res.status(404).json({ error: 'Group not found.' });

  const { group, participants } = full;

  if (!resend) {
    return res.status(500).json({ error: 'Email not configured on server.' });
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

  return res.json({ sentCount, skippedCount });
});

// ---------- Start Server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Express server running at http://localhost:${PORT}`);
  console.log(`Frontend available at http://localhost:${PORT}/app`);
});
