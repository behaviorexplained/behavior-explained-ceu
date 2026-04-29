require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const db = new Database('database.db');

// Database setup
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    license_number TEXT,
    license_type TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    price REAL NOT NULL,
    ceu_credits REAL NOT NULL,
    video_url TEXT,
    thumbnail TEXT,
    category TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS enrollments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    course_id INTEGER,
    paid INTEGER DEFAULT 0,
    completed INTEGER DEFAULT 0,
    quiz_passed INTEGER DEFAULT 0,
    certificate_sent INTEGER DEFAULT 0,
    enrolled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(course_id) REFERENCES courses(id)
  );

  CREATE TABLE IF NOT EXISTS quiz_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'behavior-explained-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// Auth middleware
const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.redirect('/login');
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.session.isAdmin) return res.redirect('/');
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
app.post('/api/signup', (req, res) => {
  const { name, email, password, license_number, license_type } = req.body;
  if (!name || !email || !password) return res.json({ error: 'All fields required' });
  const hashed = bcrypt.hashSync(password, 10);
  try {
    const stmt = db.prepare('INSERT INTO users (name, email, password, license_number, license_type) VALUES (?, ?, ?, ?, ?)');
    const result = stmt.run(name, email, hashed, license_number, license_type);
    req.session.userId = result.lastInsertRowid;
    req.session.userName = name;
    res.json({ success: true });
  } catch (e) {
    res.json({ error: 'Email already registered' });
  }
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.json({ error: 'Invalid email or password' });
  }
  req.session.userId = user.id;
  req.session.userName = user.name;
  req.session.isAdmin = email === (process.env.ADMIN_EMAIL || 'arogers@behaviorexplained.com');
  res.json({ success: true, isAdmin: req.session.isAdmin });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  const user = db.prepare('SELECT id, name, email, license_number, license_type FROM users WHERE id = ?').get(req.session.userId);
  res.json({ loggedIn: true, ...user, isAdmin: req.session.isAdmin });
});

// COURSE ROUTES
app.get('/api/courses', (req, res) => {
  const courses = db.prepare('SELECT * FROM courses ORDER BY created_at DESC').all();
  res.json(courses);
});

app.get('/api/courses/:id', (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) return res.json({ error: 'Course not found' });
  res.json(course);
});

app.post('/api/courses', requireAdmin, (req, res) => {
  const { title, description, price, ceu_credits, video_url, thumbnail, category } = req.body;
  const stmt = db.prepare('INSERT INTO courses (title, description, price, ceu_credits, video_url, thumbnail, category) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const result = stmt.run(title, description, price, ceu_credits, video_url, thumbnail, category);
  res.json({ success: true, id: result.lastInsertRowid });
});

// ENROLLMENT ROUTES
app.get('/api/my-courses', requireAuth, (req, res) => {
  const enrollments = db.prepare(`
    SELECT e.*, c.title, c.description, c.ceu_credits, c.video_url, c.thumbnail, c.category
    FROM enrollments e
    JOIN courses c ON e.course_id = c.id
    WHERE e.user_id = ? AND e.paid = 1
  `).all(req.session.userId);
  res.json(enrollments);
});

app.post('/api/enroll/:courseId', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM enrollments WHERE user_id = ? AND course_id = ?').get(req.session.userId, req.params.courseId);
  if (existing) return res.json({ error: 'Already enrolled' });
  const stmt = db.prepare('INSERT INTO enrollments (user_id, course_id, paid) VALUES (?, ?, 1)');
  stmt.run(req.session.userId, req.params.courseId);
  res.json({ success: true });
});

// QUIZ ROUTES
app.get('/api/quiz/:courseId', requireAuth, (req, res) => {
  const questions = db.prepare('SELECT id, question, option_a, option_b, option_c, option_d FROM quiz_questions WHERE course_id = ?').all(req.params.courseId);
  res.json(questions);
});

app.post('/api/quiz/:courseId/submit', requireAuth, (req, res) => {
  const { answers } = req.body;
  const questions = db.prepare('SELECT * FROM quiz_questions WHERE course_id = ?').all(req.params.courseId);
  if (questions.length === 0) return res.json({ error: 'No quiz found' });

  let correct = 0;
  questions.forEach(q => {
    if (answers[q.id] === q.correct_answer) correct++;
  });

  const score = Math.round((correct / questions.length) * 100);
  const passed = score >= 80;

  if (passed) {
    db.prepare('UPDATE enrollments SET quiz_passed = 1, completed = 1, completed_at = CURRENT_TIMESTAMP WHERE user_id = ? AND course_id = ?')
      .run(req.session.userId, req.params.courseId);
  }

  res.json({ score, passed, correct, total: questions.length });
});

app.post('/api/quiz/questions', requireAdmin, (req, res) => {
  const { course_id, questions } = req.body;
  db.prepare('DELETE FROM quiz_questions WHERE course_id = ?').run(course_id);
  const stmt = db.prepare('INSERT INTO quiz_questions (course_id, question, option_a, option_b, option_c, option_d, correct_answer) VALUES (?, ?, ?, ?, ?, ?, ?)');
  questions.forEach(q => stmt.run(course_id, q.question, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_answer));
  res.json({ success: true });
});

// ADMIN ROUTES
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, name, email, license_number, license_type, created_at FROM users').all();
  res.json(users);
});

app.get('/api/admin/enrollments', requireAdmin, (req, res) => {
  const enrollments = db.prepare(`
    SELECT e.*, u.name as user_name, u.email, c.title as course_title
    FROM enrollments e
    JOIN users u ON e.user_id = u.id
    JOIN courses c ON e.course_id = c.id
    ORDER BY e.enrolled_at DESC
  `).all();
  res.json(enrollments);
});

// START
const PORT = process.env.PORT || 3000;
app.use(express.static('public', { etag: false, maxAge: 0 }));
app.listen(PORT, () => console.log(`Behavior Explained running on port ${PORT}`));
