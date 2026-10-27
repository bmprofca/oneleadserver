process.env.TZ = process.env.TZ || 'Asia/Kolkata';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const pool = require('./src/config/db');

const authRoutes = require('./src/routes/auth');
const userRoutes = require('./src/routes/users');
const productRoutes = require('./src/routes/products');
const leadRoutes = require('./src/routes/leads');
const reminderRoutes = require('./src/routes/reminders');
const appointmentRoutes = require('./src/routes/appointments');
const dashboardRoutes = require('./src/routes/dashboard');
const activityRoutes = require('./src/routes/activities');
const taskRoutes = require('./src/routes/tasks');
const reportRoutes = require('./src/routes/reports');
const tagRoutes = require('./src/routes/tags');
const auditRoutes = require('./src/routes/audit');
const settingsRoutes = require('./src/routes/settings');
const { HttpError } = require('./src/lib/http');

const app = express();
const PORT = process.env.PORT || 5000;

// Behind the hosting proxy, use X-Forwarded-For for client IPs (audit log, sessions).
app.set('trust proxy', 1);

app.use(helmet());
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(
  morgan('dev', {
    skip: (req, res) => res.statusCode < 400,
  })
);

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    return res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    return res.status(500).json({ status: 'error', database: err.message });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/products', productRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/activities', activityRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/tags', tagRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/settings', settingsRoutes);

app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError || (err.status && err.status < 500)) {
    return res.status(err.status).json({ message: err.message, ...(err.extra || {}) });
  }
  if (err.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ message: 'A record with these details already exists' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Invalid JSON body' });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ message: 'File is too large (max 15 MB)' });
  }
  console.error(err);
  return res.status(500).json({ message: 'Internal server error' });
});

// Refuse to serve against a database that is missing schema migrations:
// the code expects the new columns, so running anyway would fail mid-request.
async function assertSchemaCurrent() {
  const migrations = require('./src/migrations');
  let applied = new Set();
  try {
    const [rows] = await pool.query('SELECT id FROM schema_migrations');
    applied = new Set(rows.map((r) => r.id));
  } catch (err) {
    if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
  }
  const pending = migrations.filter((m) => !applied.has(m.id)).map((m) => m.id);
  if (pending.length) {
    console.error('\nDatabase schema is out of date. Pending migrations:');
    pending.forEach((id) => console.error(`  - ${id}`));
    console.error('\nBack up, then migrate:  npm run backup-db && npm run migrate\n');
    process.exit(1);
  }
}

assertSchemaCurrent()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`OneLead SERVER running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Startup check failed:', err.message);
    process.exit(1);
  });
