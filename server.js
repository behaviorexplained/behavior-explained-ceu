require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const PDFDocument = require('pdfkit');
const { Resend } = require('resend');

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);
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
        course_id INTEGER
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
        completed_at TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS bundle_enrollments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        bundle_id INTEGER,
        paid INTEGER DEFAULT 0,
        approved INTEGER DEFAULT 0,
        enrolled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS quiz_questions (
        id SERIAL PRIMARY KEY,
        course_id INTEGER,
        question TEXT NOT NULL,
        option_a TEXT,
        option_b TEXT,
        option_c TEXT,
        option_d TEXT,
        correct_answer TEXT
      );
    `);
    console.log('Database tables ready');
  } finally {
    client.release();
  }
}

// Certificate generator
async function generateCertificate(user, course, completedAt) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 0 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = 792, H = 612;

    // Background
    doc.rect(0, 0, W, H).fill('#FCF1F2');

    // Top bar
    doc.rect(0, 0, W, 12).fill('#FC3526');

    // Bottom bar
    doc.rect(0, H - 12, W, 12).fill('#1ACBA3');

    // Left accent
    doc.rect(0, 12, 8, H - 24).fill('#CEDD2E');

    // Right accent
    doc.rect(W - 8, 12, 8, H - 24).fill('#FAA1E4');

    // Header
    doc.fontSize(11).fillColor('#FC3526').font('Helvetica-Bold')
      .text('BEHAVIOR EXPLAINED', 0, 36, { align: 'center', characterSpacing: 4 });

    doc.fontSize(9).fillColor('#888').font('Helvetica')
      .text('ACE Provider | IP-26-12514', 0, 52, { align: 'center' });

    // Divider
    doc.moveTo(60, 72).lineTo(W - 60, 72).stroke('#ddd');

    // Certificate title
    doc.fontSize(28).fillColor('#1a1a1a').font('Helvetica-Bold')
      .text('CERTIFICATE OF COMPLETION', 0, 90, { align: 'center', characterSpacing: 2 });

    // Subtitle
    doc.fontSize(12).fillColor('#666').font('Helvetica')
      .text('This certifies that', 0, 132, { align: 'center' });

    // Student name
    doc.fontSize(32).fillColor('#FC3526').font('Helvetica-Bold')
      .text(user.name, 0, 155, { align: 'center' });

    // BACB number
    if (user.bacb_number) {
      doc.fontSize(11).fillColor('#888').font('Helvetica')
        .text(`BACB Certification #: ${user.bacb_number}`, 0, 196, { align: 'center' });
    }

    // Course completion text
    doc.fontSize(12).fillColor('#444').font('Helvetica')
      .text('has successfully completed the continuing education course:', 0, 220, { align: 'center' });

    // Course title
    doc.fontSize(20).fillColor('#1a1a1a').font('Helvetica-Bold')
      .text(course.title, 60, 245, { align: 'center', width: W - 120 });

    // Divider
    doc.moveTo(150, 300).lineTo(W - 150, 300).stroke('#eee');

    // Details grid
    const detailY = 315;
    const col1 = 80, col2 = 280, col3 = 480, col4 = 640;

    // CEU Credits
    doc.fontSize(9).fillColor('#888').font('Helvetica')
      .text('CEU CREDITS AWARDED', col1, detailY, { width: 160 });
    doc.fontSize(16).fillColor('#1ACBA3').font('Helvetica-Bold')
      .text(`${course.ceu_credits} CEUs`, col1, detailY + 14, { width: 160 });

    // Category
    const ceuType = course.is_ethics && course.is_supervision
      ? 'Ethics & Supervision'
      : course.is_ethics ? 'Ethics' : course.is_supervision ? 'Supervision' : 'General';
    doc.fontSize(9).fillColor('#888').font('Helvetica')
      .text('CEU CATEGORY', col2, detailY, { width: 160 });
    doc.fontSize(14).fillColor('#1a1a1a').font('Helvetica-Bold')
      .text(ceuType, col2, detailY + 14, { width: 160 });

    // Date
    const dateStr = new Date(completedAt).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric'
    });
    doc.fontSize(9).fillColor('#888').font('Helvetica')
      .text('DATE COMPLETED', col3, detailY, { width: 160 });
    doc.fontSize(14).fillColor('#1a1a1a').font('Helvetica-Bold')
      .text(dateStr, col3, detailY + 14, { width: 160 });

    // Modality
    doc.fontSize(9).fillColor('#888').font('Helvetica')
      .text('MODALITY', col4, detailY, { width: 120 });
    doc.fontSize(11).fillColor('#1a1a1a').font('Helvetica-Bold')
      .text('Online\nAsynchronous', col4, detailY + 14, { width: 120 });

    // Divider
    doc.moveTo(150, 385).lineTo(W - 150, 385).stroke('#eee');

    // Signature area
    doc.fontSize(9).fillColor('#888').font('Helvetica')
      .text('INSTRUCTOR', 200, 400, { align: 'center', width: 180 });
    doc.fontSize(14).fillColor('#1a1a1a').font('Helvetica-Bold')
      .text('Alyssa Rogers', 200, 414, { align: 'center', width: 180 });
    doc.moveTo(200, 432).lineTo(380, 432).stroke('#ccc');

    doc.fontSize(9).fillColor('#888').font('Helvetica')
      .text('ACE PROVIDER', 420, 400, { align: 'center', width: 180 });
    doc.fontSize(14).fillColor('#1a1a1a').font('Helvetica-Bold')
      .text('Behavior Explained', 420, 414, { align: 'center', width: 180 });
    doc.moveTo(420, 432).lineTo(600, 432).stroke('#ccc');

    // Provider number
    doc.fontSize(9).fillColor('#aaa').font('Helvetica')
      .text('ACE Provider Number: IP-26-12514 | Renewal Date: 3/31/2027', 0, 450, { align: 'center' });

    doc.end();
  });
}

// Send certificate email
async function sendCertificateEmail(user, course, pdfBuffer, completedAt) {
  const dateStr = new Date(completedAt).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  });

  try {
    await resend.emails.send({
      from: 'Behavior Explained <onboarding@resend.dev>',
      to: user.email,
      subject: `Your CEU Certificate — ${course.title}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
          <div style="background: #FC3526; height: 6px; border-radius: 3px 3px 0 0;"></div>
          <div style="background: white; padding: 40px; border: 1px solid #eee; border-top: none;">
            <h1 style="color: #1a1a1a; font-size: 28px; margin-bottom: 8px;">🎉 Congratulations, ${user.name}!</h1>
            <p style="color: #666; font-size: 16px; margin-bottom: 24px;">You've successfully completed your CEU course.</p>

            <div style="background: #FCF1F2; border-radius: 12px; padding: 24px; margin-bottom: 24px;">
              <p style="margin: 0 0 8px; color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Course Completed</p>
              <p style="margin: 0; color: #1a1a1a; font-size: 18px; font-weight: bold;">${course.title}</p>
            </div>

            <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
              <tr>
                <td style="padding: 12px; background: #f9f9f9; border-radius: 8px; text-align: center;">
                  <p style="margin: 0; color: #888; font-size: 11px; text-transform: uppercase;">CEU Credits</p>
                  <p style="margin: 4px 0 0; color: #1ACBA3; font-size: 24px; font-weight: bold;">${course.ceu_credits}</p>
                </td>
                <td style="width: 16px;"></td>
                <td style="padding: 12px; background: #f9f9f9; border-radius: 8px; text-align: center;">
                  <p style="margin: 0; color: #888; font-size: 11px; text-transform: uppercase;">Date Completed</p>
                  <p style="margin: 4px 0 0; color: #1a1a1a; font-size: 16px; font-weight: bold;">${dateStr}</p>
                </td>
                <td style="width: 16px;"></td>
                <td style="padding: 12px; background: #f9f9f9; border-radius: 8px; text-align: center;">
                  <p style="margin: 0; color: #888; font-size: 11px; text-transform: uppercase;">BACB #</p>
                  <p style="margin: 4px 0 0; color: #1a1a1a; font-size: 16px; font-weight: bold;">${user.bacb_number || 'N/A'}</p>
                </td>
              </tr>
            </table>

            <p style="color: #666; font-size: 14px; margin-bottom: 24px;">Your certificate is attached to this email as a PDF. You can also download it anytime from your dashboard.</p>

            <div style="border-top: 1px solid #eee; padding-top: 24px; margin-top: 24px;">
              <p style="color: #aaa; font-size: 12px; margin: 0;">ACE Provider: Alyssa Rogers | Provider #: IP-26-12514</p>
              <p style="color: #aaa; font-size: 12px; margin: 4px 0 0;">Modality: Online Asynchronous | Behavior Explained</p>
            </div>
          </div>
          <div style="background: #1ACBA3; height: 6px; border-radius: 0 0 3px 3px;"></div>
        </div>
      `,
      attachments: [{
        filename: `${course.title.replace(/[^a-z0-9]/gi, '_')}_Certificate.pdf`,
        content: pdfBuffer.toString('base64'),
      }]
    });
    return true;
  } catch (err) {
    console.error('Email error:', err);
    return false;
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

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'arogers@behaviorexplained.com';

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
app.get('/success', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'success.html')));

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

// STRIPE PAYMENT ROUTES
app.post('/api/checkout/course/:courseId', requireAuth, async (req, res) => {
  try {
    const course = await pool.query('SELECT * FROM courses WHERE id = $1', [req.params.courseId]);
    if (!course.rows[0]) return res.json({ error: 'Course not found' });
    const existing = await pool.query(
      'SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2 AND paid = 1',
      [req.session.userId, req.params.courseId]
    );
    if (existing.rows[0]) return res.json({ error: 'Already enrolled' });
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: course.rows[0].title,
            description: `${course.rows[0].ceu_credits} CEU Credits — Online Asynchronous`,
          },
          unit_amount: Math.round(course.rows[0].price * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${req.protocol}://${req.get('host')}/success?type=course&id=${req.params.courseId}`,
      cancel_url: `${req.protocol}://${req.get('host')}/courses`,
      metadata: {
        user_id: req.session.userId.toString(),
        course_id: req.params.courseId.toString(),
        type: 'course'
      }
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.json({ error: 'Payment failed to initialize' });
  }
});

app.post('/api/checkout/bundle/:bundleId', requireAuth, async (req, res) => {
  try {
    const bundle = await pool.query('SELECT * FROM bundles WHERE id = $1', [req.params.bundleId]);
    if (!bundle.rows[0]) return res.json({ error: 'Bundle not found' });
    const existing = await pool.query(
      'SELECT * FROM bundle_enrollments WHERE user_id = $1 AND bundle_id = $2 AND paid = 1',
      [req.session.userId, req.params.bundleId]
    );
    if (existing.rows[0]) return res.json({ error: 'Already enrolled in bundle' });
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: bundle.rows[0].title,
            description: bundle.rows[0].description || 'CEU Bundle Package',
          },
          unit_amount: Math.round(bundle.rows[0].price * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${req.protocol}://${req.get('host')}/success?type=bundle&id=${req.params.bundleId}`,
      cancel_url: `${req.protocol}://${req.get('host')}/courses`,
      metadata: {
        user_id: req.session.userId.toString(),
        bundle_id: req.params.bundleId.toString(),
        type: 'bundle'
      }
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.json({ error: 'Payment failed to initialize' });
  }
});

// Success route
app.get('/api/enroll-after-payment', requireAuth, async (req, res) => {
  const { type, id } = req.query;
  if (type === 'course') {
    const existing = await pool.query(
      'SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2',
      [req.session.userId, id]
    );
    if (!existing.rows[0]) {
      await pool.query('INSERT INTO enrollments (user_id, course_id, paid) VALUES ($1, $2, 1)', [req.session.userId, id]);
    } else {
      await pool.query('UPDATE enrollments SET paid = 1 WHERE user_id = $1 AND course_id = $2', [req.session.userId, id]);
    }
  } else if (type === 'bundle') {
    const existing = await pool.query(
      'SELECT * FROM bundle_enrollments WHERE user_id = $1 AND bundle_id = $2',
      [req.session.userId, id]
    );
    if (!existing.rows[0]) {
      await pool.query('INSERT INTO bundle_enrollments (user_id, bundle_id, paid, approved) VALUES ($1, $2, 1, 0)', [req.session.userId, id]);
    }
  }
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

// CERTIFICATE ROUTES
app.get('/api/certificate/:courseId', requireAuth, async (req, res) => {
  try {
    const enrollment = await pool.query(
      'SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2 AND completed = 1',
      [req.session.userId, req.params.courseId]
    );
    if (!enrollment.rows[0]) return res.status(403).json({ error: 'Course not completed' });

    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
    const courseResult = await pool.query('SELECT * FROM courses WHERE id = $1', [req.params.courseId]);

    const user = userResult.rows[0];
    const course = courseResult.rows[0];
    const completedAt = enrollment.rows[0].completed_at || new Date();

    const pdfBuffer = await generateCertificate(user, course, completedAt);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${course.title.replace(/[^a-z0-9]/gi, '_')}_Certificate.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Certificate error:', err);
    res.status(500).json({ error: 'Failed to generate certificate' });
  }
});

app.post('/api/certificate/:courseId/email', requireAuth, async (req, res) => {
  try {
    const enrollment = await pool.query(
      'SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2 AND completed = 1',
      [req.session.userId, req.params.courseId]
    );
    if (!enrollment.rows[0]) return res.json({ error: 'Course not completed' });

    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
    const courseResult = await pool.query('SELECT * FROM courses WHERE id = $1', [req.params.courseId]);

    const user = userResult.rows[0];
    const course = courseResult.rows[0];
    const completedAt = enrollment.rows[0].completed_at || new Date();

    const pdfBuffer = await generateCertificate(user, course, completedAt);
    await sendCertificateEmail(user, course, pdfBuffer, completedAt);

    await pool.query(
      'UPDATE enrollments SET certificate_sent = 1 WHERE user_id = $1 AND course_id = $2',
      [req.session.userId, req.params.courseId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Certificate email error:', err);
    res.json({ error: 'Failed to send certificate' });
  }
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

    // Auto-send certificate email
    try {
      const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
      const courseResult = await pool.query('SELECT * FROM courses WHERE id = $1', [req.params.courseId]);
      const pdfBuffer = await generateCertificate(userResult.rows[0], courseResult.rows[0], new Date());
      await sendCertificateEmail(userResult.rows[0], courseResult.rows[0], pdfBuffer, new Date());
      await pool.query(
        'UPDATE enrollments SET certificate_sent = 1 WHERE user_id = $1 AND course_id = $2',
        [req.session.userId, req.params.courseId]
      );
    } catch (err) {
      console.error('Auto-certificate error:', err);
    }
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
