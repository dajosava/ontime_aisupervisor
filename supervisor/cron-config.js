const BRANCH_NAME_BY_INBOX = {
  '49': 'HmoOntime',
  '48': 'nogontime',
  '51': 'cenontime',
  '52': 'FB Hermosillo OTC'
};

function branchNameForInbox(inboxId, explicit) {
  const id = String(inboxId || '').trim();
  return String(explicit || '').trim() || BRANCH_NAME_BY_INBOX[id] || `Inbox ${id}`;
}

function parseTimeString(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute, label: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}

function parseEnvCronSchedules(raw) {
  if (!raw || !String(raw).trim()) return [];
  return String(raw)
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const bits = part.split(':');
      if (bits.length < 3) return null;
      const inboxId = bits[0].trim();
      const time = parseTimeString(`${bits[1]}:${bits[2]}`);
      if (!inboxId || !time) return null;
      return {
        inbox_id: inboxId,
        branch_name: branchNameForInbox(inboxId),
        time: time.label,
        enabled: true
      };
    })
    .filter(Boolean);
}

function normalizeCronScheduleEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const inboxId = String(entry.inbox_id || entry.inboxId || '').trim();
  const time = parseTimeString(entry.time);
  if (!inboxId || !time) return null;
  return {
    inbox_id: inboxId,
    branch_name: branchNameForInbox(inboxId, entry.branch_name || entry.branchName),
    time: time.label,
    enabled: entry.enabled !== false
  };
}

function normalizeCronSchedules(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const normalized = normalizeCronScheduleEntry(item);
    if (!normalized) continue;
    const key = `${normalized.inbox_id}@${normalized.time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out.sort((a, b) => {
    const ta = a.time.localeCompare(b.time);
    if (ta !== 0) return ta;
    return a.inbox_id.localeCompare(b.inbox_id);
  });
}

function timeToCronExpression(timeLabel) {
  const parsed = parseTimeString(timeLabel);
  if (!parsed) return null;
  return `${parsed.minute} ${parsed.hour} * * *`;
}

function validateCronSchedules(schedules) {
  if (!Array.isArray(schedules)) return;
  if (schedules.length > 20) {
    throw new Error('Máximo 20 horarios programados.');
  }
  for (const entry of schedules) {
    const normalized = normalizeCronScheduleEntry(entry);
    if (!normalized) {
      throw new Error('Cada horario debe tener inbox_id y hora válida (HH:MM).');
    }
  }
}

module.exports = {
  BRANCH_NAME_BY_INBOX,
  branchNameForInbox,
  parseTimeString,
  parseEnvCronSchedules,
  normalizeCronScheduleEntry,
  normalizeCronSchedules,
  timeToCronExpression,
  validateCronSchedules
};
