// Auto follow-up task helper — used by twilio.js and email.js.
// Creates a single "Pending" task for a contact, skipping if an open task of
// the same type with the same note keyword already exists.

const db = require('../db/database');

// Returns { date, time } in CT for `minutesFromNow` minutes in the future.
// date = 'YYYY-MM-DD', time = 'HH:MM' (24-hour).
function ctDueDateAndTime(minutesFromNow) {
  const dt = new Date(Date.now() + minutesFromNow * 60 * 1000);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(dt).map(({ type, value }) => [type, value])
  );
  // Some environments return '24' for midnight; normalise to '00'.
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}`,
  };
}

/**
 * Create a follow-up task for a contact, deduplicating against open tasks of the
 * same type that contain `dedupKeyword` in their notes.
 *
 * @param {number} contactId    - contacts.id
 * @param {string} taskType     - 'Call' | 'SMS' | 'Email'
 * @param {number} dueMins      - minutes from now for the due time (CT)
 * @param {string} notes        - full task note
 * @param {string} dedupKeyword - substring that uniquely identifies this auto-task
 *                                category for duplicate detection
 * @returns {number|null} new follow_up_tasks.id, or null if a duplicate was found
 */
function createAutoTask(contactId, taskType, dueMins, notes, dedupKeyword) {
  const existing = db.prepare(`
    SELECT id FROM follow_up_tasks
    WHERE contact_id = ? AND task_type = ? AND status = 'Pending' AND notes LIKE ?
    LIMIT 1
  `).get(contactId, taskType, `%${dedupKeyword}%`);

  if (existing) {
    console.log(`[auto-task] skip duplicate  contact_id=${contactId} type=${taskType} existing_id=${existing.id}`);
    return null;
  }

  const { date, time } = ctDueDateAndTime(dueMins);
  const result = db.prepare(`
    INSERT INTO follow_up_tasks (contact_id, task_type, due_date, due_time, notes, priority)
    VALUES (?, ?, ?, ?, ?, 'Medium')
  `).run(contactId, taskType, date, time, notes);

  console.log(`[auto-task] created  contact_id=${contactId} type=${taskType} due=${date} ${time} id=${result.lastInsertRowid}`);
  return result.lastInsertRowid;
}

module.exports = { createAutoTask };
