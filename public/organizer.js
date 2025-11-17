const groupsListEl = document.getElementById('groups-list');
const groupsEmptyEl = document.getElementById('groups-empty');
const groupDetailsEl = document.getElementById('group-details');

let groups = [];
let activeGroupId = null;

// Fetch all groups from the API
async function loadGroups() {
  try {
    const res = await fetch('/api/groups');
    const data = await res.json();
    groups = data.groups || [];

    if (!groups.length) {
      groupsEmptyEl.style.display = 'block';
      groupsListEl.innerHTML = '';
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
    div.className = 'group-item' + (g.id === activeGroupId ? ' active' : '');
    div.innerHTML = `
      <strong>${g.groupName}</strong>
      <small>Organizer: ${g.organizerName} (${g.organizerEmail})</small><br/>
      <small>Code: <code>${g.code}</code></small>
    `;
    div.addEventListener('click', () => {
      activeGroupId = g.id;
      renderGroupList();
      loadGroupDetails(g.code);
    });
    groupsListEl.appendChild(div);
  });
}

// Load a single group's details using its code (works with ID or code)
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
          <td>${p.name || '(no name)'}</td>
          <td>${p.email || '&mdash;'}</td>
          <td>${receiver ? receiver.name : '—'}</td>
          <td><a href="${participantUrl}" target="_blank">View link</a></td>
        </tr>
      `;
    })
    .join('');

  groupDetailsEl.innerHTML = `
    <div>
      <p><strong>Group:</strong> ${group.groupName}</p>
      <p><strong>Organizer:</strong> ${group.organizerName} (${group.organizerEmail})</p>
      <p><strong>Code:</strong> <code>${group.code}</code></p>

      <div class="links">
        <a href="${organizerUrl}" target="_blank">Organizer JSON</a>
      </div>

      <h4>Participants &amp; Assignments</h4>
      <table>
        <thead>
          <tr>
            <th>Participant</th>
            <th>Email</th>
            <th>Got</th>
            <th>Link</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

// Initial load
loadGroups();
