const express = require('express');
const router = express.Router();
const db = require('../db/database');

// GET /api/contacts — list all, newest first
router.get('/', (req, res) => {
  const { q, lead_type, limit = 200, offset = 0 } = req.query;

  let sql = 'SELECT * FROM contacts';
  const params = [];
  const conditions = [];

  if (q) {
    conditions.push(`(first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR phone LIKE ?)`);
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (lead_type) {
    conditions.push('lead_type = ?');
    params.push(lead_type);
  }

  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(Number(limit), Number(offset));

  const contacts = db.prepare(sql).all(...params);
  res.json(contacts);
});

// GET /api/contacts/:id — single contact with notes + comms
router.get('/:id', (req, res) => {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Not found' });

  const notes = db.prepare(
    'SELECT * FROM contact_notes WHERE contact_id = ? ORDER BY created_at DESC'
  ).all(contact.id);

  const communications = db.prepare(
    'SELECT * FROM communications WHERE contact_id = ? ORDER BY created_at DESC'
  ).all(contact.id);

  res.json({ ...contact, notes, communications });
});

// PATCH /api/contacts/:id — update contact fields
router.patch('/:id', (req, res) => {
  const contact = db.prepare('SELECT id FROM contacts WHERE id = ?').get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Not found' });

  const allowed = ['first_name', 'last_name', 'phone', 'alt_phone', 'email', 'role', 'tags', 'notes', 'lead_type', 'lead_source'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  updates.updated_at = new Date().toISOString();
  updates.id = contact.id;

  const setClauses = Object.keys(updates).filter(k => k !== 'id').map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE contacts SET ${setClauses} WHERE id = @id`).run(updates);

  res.json(db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id));
});

// DELETE /api/contacts/:id
router.delete('/:id', (req, res) => {
  const contact = db.prepare('SELECT id FROM contacts WHERE id = ?').get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM contacts WHERE id = ?').run(contact.id);
  res.json({ ok: true });
});

// POST /api/contacts/:id/notes — add a note
router.post('/:id/notes', (req, res) => {
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'body required' });

  const contact = db.prepare('SELECT id FROM contacts WHERE id = ?').get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  const result = db.prepare(
    'INSERT INTO contact_notes (contact_id, body) VALUES (?, ?)'
  ).run(contact.id, body.trim());

  res.status(201).json(db.prepare('SELECT * FROM contact_notes WHERE id = ?').get(result.lastInsertRowid));
});

module.exports = router;
