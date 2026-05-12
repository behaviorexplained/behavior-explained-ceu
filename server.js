require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Database setup
async function setupDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        license_number TEXT,
        license_type TEXT,
        bacb_number TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS courses (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        price REAL NOT NULL,
        ceu_credits REAL NOT NULL,
        video_url TEXT,
        thumbnail TEXT,
        category TEXT,
        is_ethics INTEGER DEFAULT 0,
        is_supervision INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS bundles (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        price REAL NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS bundle_courses (
        bundle_id INTEGER,
        course_id INTEGER,
        FOREIGN KEY(bundle_id) REFERENCES bundles(id),
        FOREIGN KEY(course_id) REFERENCES courses(id)
      );

      CREATE TABLE IF NOT EXISTS enrollments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        course_id INTEGER,
        paid INTEGER DEFAULT 0,
        completed INTEGER DEFAULT 0,
        quiz_passed INTEGER DEFAULT 0,
        quiz_attempts INTEGER DEFAULT 0,
        certificate_sent INTEGER DEFAULT 0,
        enrolled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(course_id) REFERENCES courses(id)
      );

      CREATE TABLE IF NOT EXISTS bundle_enrollments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        bundle_id INTEGER,
        paid INTEGER DEFAULT 0,
        approved INTEGER DEFAULT 0,
        enrolled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(bundle_id) REFERENCES bundles(id)
      );

      CREATE TABLE IF NOT EXISTS quiz_questions (
        id SERIAL PRIMARY KEY,
        course_id INTEGER,
        question TEXT NOT NULL,
        option_a TEXT,
        option_b TEXT,
        option_c TEXT,
        option_d TEXT,
        correct_answer TEXT,
        FOREIGN KEY(course_id) REFERENCES courses(id)
      );
    `);
    console.log('Database tables ready');
  } finally {
    client.release();
  }
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public', { etag: false, maxAge: 0, setHeaders: (res) => {
  res.setHeader('Cache-Control', 'no-store');
}}));
app.use(session({
  secret: process.env.SESSION_SECRET || 'behavior-explained-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// Admin email
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'arogers@behaviorexplained.com';

// Auth middleware
const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.redirect('/login');
  next();
};

const requireAdmin = async (req, res, next) => {
  if (!req.session.userId) return res.redirect('/login');
  const result = await pool.query('SELECT email FROM users WHERE id = $1', [req.session.userId]);
  if (!result.rows[0] || result.rows[0].email !== ADMIN_EMAIL) return res.redirect('/');
  next();
};

// PAGES
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));
app.get('/courses', (req, res) => res.sendFile(path.join(__dirname, 'public', 'courses.html')));
app.get('/dashboard', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// AUTH ROUTES
app.post('/api/signup', async (req, res) => {
  const { name, email, password, license_number, license_type, bacb_number } = req.body;
  if (!name || !email || !password) return res.json({ error: 'All fields required' });
  const hashed = bcrypt.hashSync(password, 10);
  try {
    const result = await pool.query(
      'INSERT INTO users (name, email, password, license_number, license_type, bacb_number) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [name, email, hashed, license_number, license_type, bacb_number]
    );
    req.session.userId = result.rows[0].id;
    req.session.userName = name;
    res.json({ success: true });
  } catch (e) {
    res.json({ error: 'Email already registered' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = result.rows[0];
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.json({ error: 'Invalid email or password' });
  }
  req.session.userId = user.id;
  req.session.userName = user.name;
  req.session.isAdmin = user.email === ADMIN_EMAIL;
  res.json({ success: true, isAdmin: req.session.isAdmin });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', async (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  const result = await pool.query(
    'SELECT id, name, email, license_number, license_type, bacb_number FROM users WHERE id = $1',
    [req.session.userId]
  );
  const user = result.rows[0];
  const isAdmin = user.email === ADMIN_EMAIL;
  req.session.isAdmin = isAdmin;
  res.json({ loggedIn: true, ...user, isAdmin });
});

// COURSE ROUTES
app.get('/api/courses', async (req, res) => {
  const result = await pool.query('SELECT * FROM courses ORDER BY created_at DESC');
  res.json(result.rows);
});

app.get('/api/courses/:id', async (req, res) => {
  const result = await pool.query('SELECT * FROM courses WHERE id = $1', [req.params.id]);
  if (!result.rows[0]) return res.json({ error: 'Course not found' });
  res.json(result.rows[0]);
});

app.post('/api/courses', requireAdmin, async (req, res) => {
  const { title, description, price, ceu_credits, video_url, thumbnail, category, is_ethics, is_supervision } = req.body;
  const result = await pool.query(
    'INSERT INTO courses (title, description, price, ceu_credits, video_url, thumbnail, category, is_ethics, is_supervision) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
    [title, description, price, ceu_credits, video_url, thumbnail, category, is_ethics ? 1 : 0, is_supervision ? 1 : 0]
  );
  res.json({ success: true, id: result.rows[0].id });
});

app.put('/api/courses/:id', requireAdmin, async (req, res) => {
  const { title, description, price, ceu_credits, video_url, thumbnail, category, is_ethics, is_supervision } = req.body;
  await pool.query(
    'UPDATE courses SET title=$1, description=$2, price=$3, ceu_credits=$4, video_url=$5, thumbnail=$6, category=$7, is_ethics=$8, is_supervision=$9 WHERE id=$10',
    [title, description, price, ceu_credits, video_url, thumbnail, category, is_ethics ? 1 : 0, is_supervision ? 1 : 0, req.params.id]
  );
  res.json({ success: true });
});

app.delete('/api/courses/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM courses WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// BUNDLE ROUTES
app.get('/api/bundles', async (req, res) => {
  const bundles = await pool.query('SELECT * FROM bundles ORDER BY created_at DESC');
  const bundlesWithCourses = await Promise.all(bundles.rows.map(async b => {
    const courses = await pool.query(`
      SELECT c.* FROM courses c
      JOIN bundle_courses bc ON c.id = bc.course_id
      WHERE bc.bundle_id = $1
    `, [b.id]);
    return { ...b, courses: courses.rows };
  }));
  res.json(bundlesWithCourses);
});

app.post('/api/bundles', requireAdmin, async (req, res) => {
  const { title, description, price, course_ids } = req.body;
  const result = await pool.query(
    'INSERT INTO bundles (title, description, price) VALUES ($1, $2, $3) RETURNING id',
    [title, description, price]
  );
  const bundleId = result.rows[0].id;
  for (const id of course_ids) {
    await pool.query('INSERT INTO bundle_courses (bundle_id, course_id) VALUES ($1, $2)', [bundleId, id]);
  }
  res.json({ success: true, id: bundleId });
});

app.delete('/api/bundles/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM bundle_courses WHERE bundle_id = $1', [req.params.id]);
  await pool.query('DELETE FROM bundles WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ENROLLMENT ROUTES
app.get('/api/my-courses', requireAuth, async (req, res) => {
  const result = await pool.query(`
    SELECT e.*, c.title, c.description, c.ceu_credits, c.video_url, c.thumbnail, c.category, c.is_ethics, c.is_supervision
    FROM enrollments e
    JOIN courses c ON e.course_id = c.id
    WHERE e.user_id = $1 AND e.paid = 1
  `, [req.session.userId]);
  res.json(result.rows);
});

app.post('/api/enroll/:courseId', requireAuth, async (req, res) => {
  const existing = await pool.query(
    'SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2',
    [req.session.userId, req.params.courseId]
  );
  if (existing.rows[0]) return res.json({ error: 'Already enrolled' });
  await pool.query(
    'INSERT INTO enrollments (user_id, course_id, paid) VALUES ($1, $2, 1)',
    [req.session.userId, req.params.courseId]
  );
  res.json({ success: true });
});

app.post('/api/enroll-bundle/:bundleId', requireAuth, async (req, res) => {
  const existing = await pool.query(
    'SELECT * FROM bundle_enrollments WHERE user_id = $1 AND bundle_id = $2',
    [req.session.userId, req.params.bundleId]
  );
  if (existing.rows[0]) return res.json({ error: 'Already enrolled in bundle' });
  await pool.query(
    'INSERT INTO bundle_enrollments (user_id, bundle_id, paid, approved) VALUES ($1, $2, 1, 0)',
    [req.session.userId, req.params.bundleId]
  );
  res.json({ success: true, message: 'Bundle enrollment pending approval' });
});

// QUIZ ROUTES
app.get('/api/quiz/:courseId', requireAuth, async (req, res) => {
  const enrollment = await pool.query(
    'SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2 AND paid = 1',
    [req.session.userId, req.params.courseId]
  );
  if (!enrollment.rows[0]) return res.json({ error: 'Not enrolled' });
  const questions = await pool.query(
    'SELECT id, question, option_a, option_b, option_c, option_d FROM quiz_questions WHERE course_id = $1',
    [req.params.courseId]
  );
  res.json(questions.rows);
});

app.post('/api/quiz/:courseId/submit', requireAuth, async (req, res) => {
  const { answers } = req.body;
  const questions = await pool.query('SELECT * FROM quiz_questions WHERE course_id = $1', [req.params.courseId]);
  if (!questions.rows.length) return res.json({ error: 'No quiz found' });

  let correct = 0;
  questions.rows.forEach(q => {
    if (answers[q.id] === q.correct_answer) correct++;
  });

  const score = Math.round((correct / questions.rows.length) * 100);
  const passed = score >= 80;

  await pool.query(
    'UPDATE enrollments SET quiz_attempts = quiz_attempts + 1 WHERE user_id = $1 AND course_id = $2',
    [req.session.userId, req.params.courseId]
  );

  if (passed) {
    await pool.query(
      'UPDATE enrollments SET quiz_passed = 1, completed = 1, completed_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND course_id = $2',
      [req.session.userId, req.params.courseId]
    );
  }

  res.json({ score, passed, correct, total: questions.rows.length });
});

app.post('/api/quiz/questions', requireAdmin, async (req, res) => {
  const { course_id, questions } = req.body;
  await pool.query('DELETE FROM quiz_questions WHERE course_id = $1', [course_id]);
  for (const q of questions) {
    await pool.query(
      'INSERT INTO quiz_questions (course_id, question, option_a, option_b, option_c, option_d, correct_answer) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [course_id, q.question, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_answer]
    );
  }
  res.json({ success: true });
});

// ADMIN ROUTES
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const result = await pool.query('SELECT id, name, email, license_number, license_type, bacb_number, created_at FROM users');
  res.json(result.rows);
});

app.get('/api/admin/enrollments', requireAdmin, async (req, res) => {
  const result = await pool.query(`
    SELECT e.*, u.name as user_name, u.email, c.title as course_title
    FROM enrollments e
    JOIN users u ON e.user_id = u.id
    JOIN courses c ON e.course_id = c.id
    ORDER BY e.enrolled_at DESC
  `);
  res.json(result.rows);
});

app.get('/api/admin/bundle-enrollments', requireAdmin, async (req, res) => {
  const result = await pool.query(`
    SELECT be.*, u.name as user_name, u.email, b.title as bundle_title
    FROM bundle_enrollments be
    JOIN users u ON be.user_id = u.id
    JOIN bundles b ON be.bundle_id = b.id
    ORDER BY be.enrolled_at DESC
  `);
  res.json(result.rows);
});

app.post('/api/admin/approve-bundle/:id', requireAdmin, async (req, res) => {
  const enrollment = await pool.query('SELECT * FROM bundle_enrollments WHERE id = $1', [req.params.id]);
  if (!enrollment.rows[0]) return res.json({ error: 'Enrollment not found' });
  await pool.query('UPDATE bundle_enrollments SET approved = 1 WHERE id = $1', [req.params.id]);
  const courses = await pool.query(`
    SELECT c.id FROM courses c
    JOIN bundle_courses bc ON c.id = bc.course_id
    WHERE bc.bundle_id = $1
  `, [enrollment.rows[0].bundle_id]);
  for (const c of courses.rows) {
    await pool.query(
      'INSERT INTO enrollments (user_id, course_id, paid) VALUES ($1, $2, 1) ON CONFLICT DO NOTHING',
      [enrollment.rows[0].user_id, c.id]
    );
  }
  res.json({ success: true });
});

// START
setupDatabase().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Behavior Explained CEU Platform running on port ${PORT}`));
}).catch(err => {
  console.error('Database setup failed:', err);
  process.exit(1);
});

// v2

