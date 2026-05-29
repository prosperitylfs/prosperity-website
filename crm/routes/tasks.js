const express = require('express');
const router  = express.Router();
const db      = require('../db/database');

// ─── GET /api/tasks/stats ────────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const nd = new Date(); nd.setDate(nd.getDate() + 1);
  const tomorrow = nd.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

  const overdue    = db.prepare("SELECT COUNT(*) AS n FROM follow_up_tasks WHERE status='Pending' AND due_date < ?").get(today).n;
  const dueToday   = db.prepare("SELECT COUNT(*) AS n FROM follow_up_tasks WHERE status='Pending' AND due_date = ?").get(today).n;
  const dueTomorrow = db.prepare("SELECT COUNT(*) AS n FROM follow_up_tasks WHERE status='Pending' AND due_date = ?").get(tomorrow).n;
  const upcoming   = db.prepare("SELECT COUNT(*) AS n FROM follow_up_tasks WHERE status='Pending' AND due_date > ?").get(tomorrow).n;
  res.json({ overdue, dueToday, dueTomorrow, upcoming });
});

// ─── GET /api/tasks/contact/:contact_id ─────────────────────────────────────
router.get('/contact/:contact_id', (req, res) => {
  const tasks = db.prepare(`
    SELECT * FROM follow_up_tasks
    WHERE contact_id = ?
    ORDER BY
      CASE status WHEN 'Pending' THEN 0 WHEN 'Cancelled' THEN 1 ELSE 2 END,
      due_date ASC
  `).all(req.params.contact_id);
  res.json(tasks);
});

// ─── POST /api/tasks ─────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const { contact_id, task_type, due_date, due_time, notes, priority } = req.body;
  if (!contact_id) return res.status(400).json({ error: 'contact_id required' });
  if (!due_date)   return res.status(400).json({ error: 'due_date required' });
  if (!task_type)  return res.status(400).json({ error: 'task_type required' });

  if (!db.prepare('SELECT id FROM contacts WHERE id = ?').get(contact_id))
    return res.status(404).json({ error: 'Contact not found' });

  const r = db.prepare(
    `INSERT INTO follow_up_tasks (contact_id, task_type, due_date, due_time, notes, priority)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(Number(contact_id), task_type, due_date, due_time || null, notes || null, priority || 'Medium');

  res.status(201).json(db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(r.lastInsertRowid));
});

// ─── PATCH /api/tasks/:id ────────────────────────────────────────────────────
router.patch('/:id', (req, res) => {
  const task = db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });

  const allowed = ['task_type', 'due_date', 'due_time', 'notes', 'priority', 'status'];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });

  if (updates.status === 'Completed' && task.status !== 'Completed') {
    updates.completed_at = new Date().toISOString();
  } else if (updates.status && updates.status !== 'Completed') {
    updates.completed_at = null;
  }

  updates.id = task.id;
  const set = Object.keys(updates).filter(k => k !== 'id').map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE follow_up_tasks SET ${set} WHERE id = @id`).run(updates);

  res.json(db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(task.id));
});

// ─── DELETE /api/tasks/:id ───────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  const task = db.prepare('SELECT id FROM follow_up_tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM follow_up_tasks WHERE id = ?').run(task.id);
  res.json({ ok: true });
});

module.exports = router;
