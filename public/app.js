const form = document.getElementById('group-form');
const submitBtn = document.getElementById('submitBtn');
const resultCard = document.getElementById('result-card');
const summaryDiv = document.getElementById('summary');
const organizerLinkDiv = document.getElementById('organizer-link');
const participantLinksDiv = document.getElementById('participant-links');
const rawJsonPre = document.getElementById('raw-json');

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating...';

  const groupName = document.getElementById('groupName').value.trim();
  const organizerName = document.getElementById('organizerName').value.trim();
  const organizerEmail = document.getElementById('organizerEmail').value.trim();
  const participantsText = document.getElementById('participants').value.trim();

  const participants = [];
  if (participantsText) {
    const lines = participantsText.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const [namePart, emailPart] = trimmed.split(',');
      const name = (namePart || '').trim();
      const email = (emailPart || '').trim();

      if (name) {
        participants.push({ name, email });
      }
    }
  }

  const payload = {
    groupName,
    organizerName,
    organizerEmail,
    participants,
  };

  try {
    const response = await fetch('/api/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      alert('Error: ' + (data.error || 'Unknown error'));
      console.error('Error response:', data);
      return;
    }

    // Show result card
    resultCard.style.display = 'block';

    summaryDiv.innerHTML = `
      <p><strong>Group:</strong> ${data.groupName}</p>
      <p><strong>Organizer:</strong> ${data.organizerName} (${data.organizerEmail})</p>
      <p><strong>Created At:</strong> ${data.createdAt}</p>
    `;

    organizerLinkDiv.innerHTML = `
      <div>
        <a href="${data.organizerUrl}" target="_blank">${data.organizerUrl}</a>
        <span class="tag">Organizer</span>
      </div>
    `;

    participantLinksDiv.innerHTML = '';
    (data.participantUrls || []).forEach((p) => {
      const div = document.createElement('div');
      div.innerHTML = `
        <strong>${p.name}</strong>:
        <a href="${p.url}" target="_blank">${p.url}</a>
      `;
      participantLinksDiv.appendChild(div);
    });

    rawJsonPre.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    console.error('Request failed:', err);
    alert('Request failed. Check console for details.');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Group';
  }
});
