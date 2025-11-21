const groupsListEl = document.getElementById('groups-list');
const groupsEmptyEl = document.getElementById('groups-empty');
const groupDetailsEl = document.getElementById('group-details');

let groups = [];
let activeGroupCode = null;

// Fetch all groups for sidebar
async function loadGroups() {
  try {
    const res = await fetch('/api/groups');
    const data = await res.json();
    groups = data.groups || [];

    if (!groups.length) {
      groupsEmptyEl.style.display = 'block';
      groupsListEl.innerHTML = '';
      groupDetailsEl.innerHTML = 'No groups yet. Create one at /app.';
      groupDetailsEl.classList.add('muted');
      return;
    }

    groupsEmptyEl.style.display = 'none';
    renderGroupList();
  } catch (err) {
    console.error('Failed to load groups:', err);
    groupsEmptyEl.style.display = 'block';
    groupsEmptyEl.textContent = 'Error loading groups. Check console.';
  }
}

function renderGroupList() {
  groupsListEl.innerHTML = '';

  groups.forEach((g) => {
    const div = document.createElement('div');
    div.className = 'group-item' + (g.code === activeGroupCode ? ' active' : '');
    div.innerHTML = `
      <strong>${g.groupName}</strong>
      <small>${g.organizerName} (${g.organizerEmail})</small>
      <small>Code: <code>${g.code}</code></small>
    `;
    div.addEventListener('click', () => {
      activeGroupCode = g.code;
      renderGroupList();
      loadGroupDetails(g.code);
    });
    groupsListEl.appendChild(div);
  });
}

// Load one group's details (by code)
async function loadGroupDetails(codeOrId) {
  groupDetailsEl.classList.add('muted');
  groupDetailsEl.innerHTML = 'Loading group details...';

  try {
    const res = await fetch(`/api/groups/${encodeURIComponent(codeOrId)}`);
    if (!res.ok) {
      groupDetailsEl.innerHTML = 'Error loading group details.';
      return;
    }
    const group = await res.json();
    renderGroupDetails(group);
  } catch (err) {
    console.error('Failed to load group details:', err);
    groupDetailsEl.innerHTML = 'Error loading group details.';
  }
}

function renderGroupDetails(group) {
  groupDetailsEl.classList.remove('muted');

  const baseUrl = window.location.origin;
  const organizerUrl = `${baseUrl}/api/groups/${group.code}`;

  const rows = group.participants
    .map((p) => {
      const assignment = group.assignments.find((a) => a.giverId === p.id);
      const receiver =
        assignment && group.participants.find((x) => x.id === assignment.receiverId);

      const participantUrl = `${baseUrl}/api/groups/${group.code}/participant/${p.id}`;

      return `
        <tr>
          <td><input type="text" class="p-name" value="${p.name || ''}" /></td>
          <td><input type="email" class="p-email" value="${p.email || ''}" /></td>
          <td>${receiver ? receiver.name : '—'}</td>
          <td>
            <a href="${participantUrl}" target="_blank">View link</a>
            <button type="button" class="remove-row-btn" style="margin-left:0.4rem; padding:0.15rem 0.4rem; font-size:0.75rem;">Remove</button>
          </td>
        </tr>
      `;
    })
    .join('');

  groupDetailsEl.innerHTML = `
    <div>
      <p><strong>Group code:</strong> <code>${group.code}</code></p>

      <div style="margin-top: 0.75rem; margin-bottom: 0.75rem;">
        <label style="display:block; font-size:0.8rem; color:#6b7280; margin-bottom:0.15rem;">
          Group name
        </label>
        <input id="editGroupName" type="text" value="${group.groupName || ''}" style="width:100%; padding:0.35rem 0.45rem; border-radius:0.4rem; border:1px solid #e5e7eb; font-size:0.9rem;" />

        <label style="display:block; font-size:0.8rem; color:#6b7280; margin:0.6rem 0 0.15rem;">
          Organizer name
        </label>
        <input id="editOrganizerName" type="text" value="${group.organizerName || ''}" style="width:100%; padding:0.35rem 0.45rem; border-radius:0.4rem; border:1px solid #e5e7eb; font-size:0.9rem;" />

        <label style="display:block; font-size:0.8rem; color:#6b7280; margin:0.6rem 0 0.15rem;">
          Organizer email
        </label>
        <input id="editOrganizerEmail" type="email" value="${group.organizerEmail || ''}" style="width:100%; padding:0.35rem 0.45rem; border-radius:0.4rem; border:1px solid #e5e7eb; font-size:0.9rem;" />
      </div>

      <div class="links" style="margin-bottom: 0.75rem;">
        <a href="${organizerUrl}" target="_blank">Organizer JSON</a>
      </div>

      <div style="display:flex; flex-wrap:wrap; gap:0.5rem; margin-bottom:0.75rem;">
        <button id="saveGroupBtn">Save group details</button>
        <button id="saveParticipantsBtn" style="background:#1d4ed8;">Save participants</button>
        <button id="sendEmailsBtn">Send emails to participants</button>
        <button id="deleteGroupBtn" style="background:#111827;">Delete group</button>
      </div>

      <p class="muted" style="font-size: 0.8rem; margin-top: 0.25rem;">
        Editing participants will regenerate Secret Santa assignments. Old participant links may change.
      </p>

      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:0.75rem;">
        <h4 style="margin:0;">Participants &amp; Assignments</h4>
        <button id="addParticipantBtn" style="background:#047857; padding:0.25rem 0.8rem; font-size:0.8rem;">+ Add participant</button>
      </div>

      <table>
        <thead>
          <tr>
            <th>Participant</th>
            <th>Email</th>
            <th>Got (current)</th>
            <th>Link / Actions</th>
          </tr>
        </thead>
        <tbody id="participantsBody">
          ${rows}
        </tbody>
      </table>
    </div>
  `;

  const sendBtn = document.getElementById('sendEmailsBtn');
  const saveGroupBtn = document.getElementById('saveGroupBtn');
  const saveParticipantsBtn = document.getElementById('saveParticipantsBtn');
  const deleteBtn = document.getElementById('deleteGroupBtn');
  const addParticipantBtn = document.getElementById('addParticipantBtn');

  if (sendBtn) {
    sendBtn.addEventListener('click', () => handleSendEmails(group));
  }
  if (saveGroupBtn) {
    saveGroupBtn.addEventListener('click', () => handleSaveGroup(group));
  }
  if (saveParticipantsBtn) {
    saveParticipantsBtn.addEventListener('click', () => handleSaveParticipants(group));
  }
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => handleDeleteGroup(group));
  }
  if (addParticipantBtn) {
    addParticipantBtn.addEventListener('click', addEmptyParticipantRow);
  }

  hookRemoveRowButtons();
}

function hookRemoveRowButtons() {
  const rows = document.querySelectorAll('#participantsBody tr');
  rows.forEach((row) => {
    const btn = row.querySelector('.remove-row-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        row.remove();
      });
    }
  });
}

function addEmptyParticipantRow() {
  const tbody = document.getElementById('participantsBody');
  if (!tbody) return;

  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="p-name" value="" /></td>
    <td><input type="email" class="p-email" value="" /></td>
    <td>—</td>
    <td>
      <span style="font-size:0.75rem; color:#9ca3af;">New</span>
      <button type="button" class="remove-row-btn" style="margin-left:0.4rem; padding:0.15rem 0.4rem; font-size:0.75rem;">Remove</button>
    </td>
  `;
  tbody.appendChild(tr);
  hookRemoveRowButtons();
}

async function handleSendEmails(group) {
  const sendBtn = document.getElementById('sendEmailsBtn');
  if (!sendBtn) return;

  sendBtn.disabled = true;
  const originalText = sendBtn.textContent;
  sendBtn.textContent = 'Sending emails...';

  try {
    const res = await fetch(`/api/groups/${encodeURIComponent(group.code)}/send-emails`, {
      method: 'POST'
    });

    const data = await res.json();

    if (!res.ok) {
      alert('Failed to send emails: ' + (data.error || 'Unknown error'));
      console.error('Email send error:', data);
      return;
    }

    alert(`Emails processed. Sent: ${data.sentCount}, skipped (no email): ${data.skippedCount}.`);
  } catch (err) {
    console.error('Failed to send emails:', err);
    alert('Failed to send emails. Check console for details.');
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = originalText;
  }
}

async function handleSaveGroup(group) {
  const nameInput = document.getElementById('editGroupName');
  const orgNameInput = document.getElementById('editOrganizerName');
  const orgEmailInput = document.getElementById('editOrganizerEmail');
  const saveBtn = document.getElementById('saveGroupBtn');

  if (!nameInput || !orgNameInput || !orgEmailInput || !saveBtn) return;

  const payload = {
    groupName: nameInput.value.trim(),
    organizerName: orgNameInput.value.trim(),
    organizerEmail: orgEmailInput.value.trim()
  };

  if (!payload.groupName || !payload.organizerName || !payload.organizerEmail) {
    alert('Group name, organizer name, and organizer email are required.');
    return;
  }

  saveBtn.disabled = true;
  const original = saveBtn.textContent;
  saveBtn.textContent = 'Saving...';

  try {
    const res = await fetch(`/api/groups/${encodeURIComponent(group.code)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok) {
      alert('Failed to update group: ' + (data.error || 'Unknown error'));
      console.error('Update group error:', data);
      return;
    }

    alert('Group updated successfully.');

    await loadGroups();
    activeGroupCode = data.code;
    await loadGroupDetails(data.code);
  } catch (err) {
    console.error('Failed to update group:', err);
    alert('Failed to update group. Check console for details.');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = original;
  }
}

async function handleSaveParticipants(group) {
  const tbody = document.getElementById('participantsBody');
  const saveBtn = document.getElementById('saveParticipantsBtn');
  if (!tbody || !saveBtn) return;

  const rows = Array.from(tbody.querySelectorAll('tr'));
  const participants = [];

  rows.forEach((row) => {
    const nameInput = row.querySelector('.p-name');
    const emailInput = row.querySelector('.p-email');
    const name = nameInput ? nameInput.value.trim() : '';
    const email = emailInput ? emailInput.value.trim() : '';
    if (name || email) {
      participants.push({ name, email });
    }
  });

  if (participants.length < 2) {
    alert('You need at least 2 participants with name or email.');
    return;
  }

  saveBtn.disabled = true;
  const original = saveBtn.textContent;
  saveBtn.textContent = 'Saving participants...';

  try {
    const res = await fetch(`/api/groups/${encodeURIComponent(group.code)}/participants`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ participants })
    });

    const data = await res.json();

    if (!res.ok) {
      alert('Failed to update participants: ' + (data.error || 'Unknown error'));
      console.error('Update participants error:', data);
      return;
    }

    alert('Participants updated and assignments regenerated.');

    await loadGroups();
    activeGroupCode = data.code;
    await loadGroupDetails(data.code);
  } catch (err) {
    console.error('Failed to update participants:', err);
    alert('Failed to update participants. Check console for details.');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = original;
  }
}

async function handleDeleteGroup(group) {
  const confirmed = window.confirm(
    `Are you sure you want to delete "${group.groupName}"?\nThis cannot be undone.`
  );
  if (!confirmed) return;

  const deleteBtn = document.getElementById('deleteGroupBtn');
  if (deleteBtn) {
    deleteBtn.disabled = true;
    deleteBtn.textContent = 'Deleting...';
  }

  try {
    const res = await fetch(`/api/groups/${encodeURIComponent(group.code)}`, {
      method: 'DELETE'
    });

    let data = {};
    try {
      data = await res.json();
    } catch (_) {}

    if (!res.ok) {
      alert('Failed to delete group: ' + (data.error || 'Unknown error'));
      console.error('Delete group error:', data);
      return;
    }

    alert('Group deleted.');

    activeGroupCode = null;
    await loadGroups();
    groupDetailsEl.classList.add('muted');
    groupDetailsEl.innerHTML = 'Select a group from the left to view details.';
  } catch (err) {
    console.error('Failed to delete group:', err);
    alert('Failed to delete group. Check console for details.');
  } finally {
    if (deleteBtn) {
      deleteBtn.disabled = false;
      deleteBtn.textContent = 'Delete group';
    }
  }
}

// Initial load
loadGroups();
