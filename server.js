const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function readSecretConfig() {
  const config = fs.readFileSync(path.join(__dirname, 'secret.config'), 'utf8');
  const [name, value] = config.trim().split('=', 2);

  if (name !== 'DATABASE_CONNECTION' || !value) {
    throw new Error('secret.config must contain DATABASE_CONNECTION=...');
  }

  return value;
}

const port = Number(process.env.PORT || 3000);
const database = new DatabaseSync(path.join(__dirname, readSecretConfig()));
const slotTimes = ['09:00', '11:00', '13:00', '15:00', '17:00'];

database.exec(`
  CREATE TABLE IF NOT EXISTS walk_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    walk_date TEXT NOT NULL,
    slot_time TEXT NOT NULL,
    booked_by TEXT,
    booked_at TEXT,
    UNIQUE (walk_date, slot_time),
    CHECK (
      (booked_by IS NULL AND booked_at IS NULL)
      OR
      (booked_by IS NOT NULL AND booked_at IS NOT NULL)
    )
  );

  CREATE TABLE IF NOT EXISTS feedings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_name TEXT NOT NULL,
    fed_at TEXT NOT NULL
  );
`);

function currentDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function ensureTodaySlots() {
  const insertSlot = database.prepare(
    'INSERT OR IGNORE INTO walk_slots (walk_date, slot_time) VALUES (?, ?)'
  );
  const today = currentDate();

  for (const slotTime of slotTimes) {
    insertSlot.run(today, slotTime);
  }
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';

    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10_000) {
        reject(new Error('Request body is too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

async function reserveSlot(request, response) {
  try {
    const payload = JSON.parse(await readRequestBody(request));
    const walkDate = typeof payload.walkDate === 'string' ? payload.walkDate : '';
    const slotTime = typeof payload.slotTime === 'string' ? payload.slotTime : '';
    const employeeName = typeof payload.employeeName === 'string'
      ? payload.employeeName.trim()
      : '';

    if (
      walkDate !== currentDate()
      || !slotTimes.includes(slotTime)
      || !employeeName
    ) {
      sendJson(response, 400, { error: 'Укажите ФИО и выберите доступный слот на сегодня.' });
      return;
    }

    const bookedAt = new Date().toISOString();
    const result = database.prepare(`
      UPDATE walk_slots
      SET booked_by = ?, booked_at = ?
      WHERE walk_date = ? AND slot_time = ? AND booked_by IS NULL
    `).run(employeeName, bookedAt, walkDate, slotTime);

    if (result.changes === 0) {
      sendJson(response, 409, {
        error: 'Этот слот уже занят. Выберите другой слот.',
      });
      return;
    }

    const slot = database.prepare(
      'SELECT id, walk_date, slot_time, booked_by, booked_at FROM walk_slots WHERE walk_date = ? AND slot_time = ?'
    ).get(walkDate, slotTime);
    sendJson(response, 201, { slot });
  } catch (error) {
    sendJson(response, 400, { error: 'Не удалось обработать запись. Проверьте данные.' });
  }
}

async function createFeeding(request, response) {
  try {
    const payload = JSON.parse(await readRequestBody(request));
    const employeeName = typeof payload.employeeName === 'string'
      ? payload.employeeName.trim()
      : '';

    if (!employeeName) {
      sendJson(response, 400, { error: 'Укажите ФИО сотрудника.' });
      return;
    }

    const fedAt = new Date().toISOString();
    const result = database.prepare(
      'INSERT INTO feedings (employee_name, fed_at) VALUES (?, ?)'
    ).run(employeeName, fedAt);
    const feeding = database.prepare(
      'SELECT id, employee_name, fed_at FROM feedings WHERE id = ?'
    ).get(result.lastInsertRowid);
    sendJson(response, 201, { feeding });
  } catch (error) {
    sendJson(response, 400, { error: 'Не удалось сохранить отметку кормления.' });
  }
}

function requestHandler(request, response) {
  if (request.method === 'GET' && request.url === '/api/timeslots') {
    ensureTodaySlots();
    const slots = database.prepare(
      'SELECT id, walk_date, slot_time, booked_by, booked_at FROM walk_slots WHERE walk_date = ? ORDER BY slot_time'
    ).all(currentDate());
    sendJson(response, 200, { date: currentDate(), slots });
    return;
  }

  if (request.method === 'POST' && request.url === '/api/reservation') {
    reserveSlot(request, response);
    return;
  }

  if (request.method === 'GET' && request.url === '/api/latest-feeding') {
    const feeding = database.prepare(
      'SELECT id, employee_name, fed_at FROM feedings ORDER BY id DESC LIMIT 1'
    ).get() || null;
    sendJson(response, 200, { feeding });
    return;
  }

  if (request.method === 'POST' && request.url === '/api/feeding') {
    createFeeding(request, response);
    return;
  }

  if (request.method === 'GET' && request.url === '/') {
    const page = fs.readFileSync(path.join(__dirname, 'index.html'));
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(page);
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

ensureTodaySlots();
const server = http.createServer(requestHandler);
server.listen(port, () => {
  console.log(`DogBoris is running at http://localhost:${port}`);
});

function closeDatabase() {
  database.close();
  server.close();
}

process.on('SIGINT', closeDatabase);
process.on('SIGTERM', closeDatabase);