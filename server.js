'use strict';
/**
 * BigLinker 코칭그룹 — 백엔드 서버
 * Node.js + Express + SQLite + JWT + Multer + Anthropic SDK
 * 배포: Railway / Render / VPS 모두 가능
 */

require('dotenv').config();
const express    = require('express');
const Database   = require('better-sqlite3');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const Anthropic  = require('@anthropic-ai/sdk');

const app        = express();
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'bl-change-this-secret-in-production';
const DB_PATH    = process.env.DB_PATH    || './biglinker.db';
const UPLOADS    = process.env.UPLOADS_DIR || './uploads';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',');

if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });

// ─── DATABASE ─────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    username     TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role         TEXT NOT NULL CHECK(role IN ('admin','consultant','student')),
    name         TEXT NOT NULL,
    email        TEXT,
    school       TEXT,
    grade        TEXT,
    target_univ  TEXT,
    target_dept  TEXT,
    specialties  TEXT,
    consultant_id TEXT,
    memo         TEXT,
    created_at   INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS gb_data (
    student_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    content    TEXT,
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS exams (
    id              TEXT PRIMARY KEY,
    student_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject         TEXT NOT NULL,
    teacher         TEXT,
    teacher_note    TEXT,
    eval_type       TEXT DEFAULT '제출' CHECK(eval_type IN ('구술','발표','토론','제출')),
    time            TEXT,
    topic           TEXT NOT NULL,
    ratio           INTEGER DEFAULT 0,
    elements        TEXT,
    due_date        TEXT,
    status          TEXT DEFAULT '예정' CHECK(status IN ('예정','진행중','완료')),
    submitted       INTEGER DEFAULT 0,
    consultant_note TEXT,
    materials       TEXT,
    created_at      INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS exam_feedbacks (
    id         TEXT PRIMARY KEY,
    exam_id    TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK(role IN ('student','consultant')),
    author     TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS report_feedbacks (
    id                TEXT PRIMARY KEY,
    student_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type              TEXT,
    title             TEXT NOT NULL,
    student_content   TEXT NOT NULL,
    consultant_content TEXT,
    status            TEXT DEFAULT '요청중',
    student_read      INTEGER DEFAULT 1,
    created_at        INTEGER DEFAULT (strftime('%s','now')),
    updated_at        INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS analysis_history (
    id         TEXT PRIMARY KEY,
    student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       TEXT,
    content    TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS files (
    id            TEXT PRIMARY KEY,
    student_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    stored_path   TEXT NOT NULL,
    mime_type     TEXT,
    size          INTEGER,
    description   TEXT,
    created_at    INTEGER DEFAULT (strftime('%s','now'))
  );
`);

// ─── SEED DEFAULT ADMIN ──────────────────────────────────────────────
function seedDefaults() {
  const adminExists = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
  if (!adminExists) {
    const hash = bcrypt.hashSync('admin1234', 10);
    db.prepare(`INSERT OR IGNORE INTO users (id,username,password_hash,role,name) VALUES (?,?,?,?,?)`)
      .run('adm_1', 'admin', hash, 'admin', '관리자');

    const consHash = bcrypt.hashSync('1234', 10);
    db.prepare(`INSERT OR IGNORE INTO users (id,username,password_hash,role,name,specialties) VALUES (?,?,?,?,?,?)`)
      .run('cons_1', 'cons01', consHash, 'consultant', '김컨설턴트', '자연계·의약계');

    const stHash = bcrypt.hashSync('1234', 10);
    db.prepare(`INSERT OR IGNORE INTO users (id,username,password_hash,role,name,school,grade,target_univ,target_dept,consultant_id) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run('st_1', 'kim2024', stHash, 'student', '김동형', '숭실고등학교', '2', '가톨릭대학교', '간호학과', 'cons_1');

    // 샘플 수행평가
    const sampleExams = [
      { id:'ex1', sid:'st_1', subj:'생명과학Ⅰ', teacher:'박영수', etype:'제출', time:'23:59',
        tnote:'실험 보고서 형식 중시, 결론에 미래 적용 필수', topic:'항상성과 건강 탐구 보고서',
        ratio:30, elements:'실험설계 30%, 결과분석 40%, 결론 30%', due:'2026-05-20',
        status:'진행중', cnote:'체온 조절 탐구 → 간호학 연계 결론 권장', mats:'교재 p.124-156' },
      { id:'ex2', sid:'st_1', subj:'수학Ⅱ', teacher:'김철수', etype:'발표', time:'15:30',
        tnote:'풀이 과정 상세히, 오류 분석 포함 시 가점', topic:'함수의 극한과 연속 응용 발표',
        ratio:20, elements:'발표 40%, 풀이과정 35%, 창의성 25%', due:'2026-05-12',
        status:'완료', cnote:'지수함수 의료 모델링 연계 성공', mats:'' },
      { id:'ex3', sid:'st_1', subj:'국어', teacher:'이미영', etype:'발표', time:'10:00',
        tnote:'비판적 독해 + 자신의 의견 명확히', topic:'의학 비문학 비판적 읽기 논술',
        ratio:25, elements:'이해 30%, 분석 40%, 논술 30%', due:'2026-05-28',
        status:'예정', cnote:'헌혈 통계 분석 경험 활용 권장', mats:'헌혈 감소 기사 모음' },
      { id:'ex4', sid:'st_1', subj:'영어', teacher:'최지원', etype:'구술', time:'14:00',
        tnote:'의사소통 내용 우선', topic:'건강·의료 영어 프레젠테이션',
        ratio:25, elements:'유창성 20%, 내용 50%, PPT 30%', due:'2026-06-10',
        status:'예정', cnote:'WHO 간호 정책 영문 자료 추천', mats:'WHO Nursing Report 2024' },
    ];
    const ins = db.prepare(`INSERT OR IGNORE INTO exams (id,student_id,subject,teacher,eval_type,time,teacher_note,topic,ratio,elements,due_date,status,consultant_note,materials) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    sampleExams.forEach(e => ins.run(e.id, e.sid, e.subj, e.teacher, e.etype, e.time, e.tnote, e.topic, e.ratio, e.elements, e.due, e.status, e.cnote, e.mats));

    // 샘플 피드백
    db.prepare(`INSERT OR IGNORE INTO exam_feedbacks (id,exam_id,role,author,content,created_at) VALUES (?,?,?,?,?,?)`).run('cf1','ex1','consultant','김컨설턴트','결론에 저체온증 환자 간호와 항상성 회복 과정을 연결하면 좋겠습니다.',Math.floor(Date.now()/1000)-172800);
    db.prepare(`INSERT OR IGNORE INTO exam_feedbacks (id,exam_id,role,author,content,created_at) VALUES (?,?,?,?,?,?)`).run('cf2','ex1','student','김동형','감사합니다! 간호학 파트를 추가해서 다시 보여드릴게요.',Math.floor(Date.now()/1000)-86400);

    db.prepare(`INSERT OR IGNORE INTO report_feedbacks (id,student_id,type,title,student_content,consultant_content,status,created_at) VALUES (?,?,?,?,?,?,?,?)`).run('fb1','st_1','수행평가 보고서','생명과학 항상성 보고서 초안 피드백 요청','항상성 탐구 보고서 초안을 작성했는데 결론 부분이 약한 것 같습니다.','결론에 간호학 연계를 강화하세요. 저체온증 환자의 항상성 회복 과정을 체온조절 메커니즘과 연결하면 훨씬 설득력이 높아집니다.','피드백완료',Math.floor(Date.now()/1000)-172800);
    db.prepare(`INSERT OR IGNORE INTO report_feedbacks (id,student_id,type,title,student_content,status,created_at) VALUES (?,?,?,?,?,?,?)`).run('fb2','st_1','생기부 세특','수학 세특 탐구 주제 심화 방향 문의','코로나 지수함수 모델링을 더 심화하고 싶은데, 어떤 방향이 좋을까요?','요청중',Math.floor(Date.now()/1000)-3600);

    console.log('✅ 기본 계정 및 샘플 데이터 생성 완료');
  }
}
seedDefaults();

// ─── MIDDLEWARE ────────────────────────────────────────────────────────
app.use(cors({
  origin: ALLOWED_ORIGINS.length === 1 && ALLOWED_ORIGINS[0] === '*' ? '*' : ALLOWED_ORIGINS,
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(UPLOADS)); // 업로드 파일 서빙
app.use(express.static(path.join(__dirname, 'public')));

// Multer 설정: 학생별 폴더 분리
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOADS, req.user?.id || 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB

// ─── AUTH MIDDLEWARE ───────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: '로그인이 필요합니다' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: '세션이 만료되었습니다. 다시 로그인해주세요.' }); }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: '관리자 권한이 필요합니다' });
  next();
}

function adminOrConsultant(req, res, next) {
  if (!['admin','consultant'].includes(req.user?.role))
    return res.status(403).json({ error: '권한이 없습니다' });
  next();
}

// 학생 접근 권한: 본인 or 관리자 or 담당 컨설턴트
function canAccessStudent(req, res, next) {
  const targetId = req.params.studentId || req.params.id;
  if (req.user.role === 'admin') return next();
  if (req.user.role === 'student' && req.user.id === targetId) return next();
  if (req.user.role === 'consultant') {
    const st = db.prepare('SELECT consultant_id FROM users WHERE id=?').get(targetId);
    if (st?.consultant_id === req.user.id) return next();
  }
  res.status(403).json({ error: '이 학생 데이터에 접근할 권한이 없습니다' });
}

// ─── RATE LIMITERS ─────────────────────────────────────────────────────
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const aiLimiter   = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

// ─── HELPERS ───────────────────────────────────────────────────────────
function uid() { return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`; }

// ─── AUTH ROUTES ───────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status:'ok', uptime:Math.floor(process.uptime()) }));

app.post('/api/auth/login', authLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요' });

  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다' });

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, name: user.name },
    JWT_SECRET, { expiresIn: '7d' }
  );

  // 로그인 응답에 필요한 초기 데이터 포함
  const payload = { token, user: { id:user.id, username:user.username, role:user.role, name:user.name } };

  if (user.role === 'admin') {
    payload.students   = db.prepare("SELECT * FROM users WHERE role='student' ORDER BY created_at DESC").all().map(clean);
    payload.consultants = db.prepare("SELECT * FROM users WHERE role='consultant' ORDER BY created_at DESC").all().map(clean);
    payload.apiKey     = db.prepare("SELECT value FROM settings WHERE key='api_key'").get()?.value || '';
    payload.model      = db.prepare("SELECT value FROM settings WHERE key='model'").get()?.value || 'claude-sonnet-4-6';
  } else if (user.role === 'consultant') {
    payload.myStudents = db.prepare("SELECT * FROM users WHERE role='student' AND consultant_id=?").all(user.id).map(clean);
    payload.students   = payload.myStudents;
    payload.consultants = [clean(user)];
  } else {
    payload.studentData = getFullStudentData(user.id);
    payload.consultant  = user.consultant_id ? clean(db.prepare('SELECT * FROM users WHERE id=?').get(user.consultant_id)) : null;
  }

  res.json(payload);
});

function clean(u) {
  if (!u) return null;
  const { password_hash, ...safe } = u;
  return safe;
}

function getFullStudentData(sid) {
  const exams = db.prepare('SELECT * FROM exams WHERE student_id=? ORDER BY due_date').all(sid).map(e => ({
    ...e,
    submitted: !!e.submitted,
    calFeedbacks: db.prepare('SELECT * FROM exam_feedbacks WHERE exam_id=? ORDER BY created_at').all(e.id).map(f => ({ ...f, ts: f.created_at * 1000 }))
  }));
  const feedbacks = db.prepare('SELECT * FROM report_feedbacks WHERE student_id=? ORDER BY created_at DESC').all(sid).map(f => ({
    ...f, createdAt: f.created_at*1000, updatedAt: f.updated_at*1000, studentRead: !!f.student_read
  }));
  const history = db.prepare('SELECT * FROM analysis_history WHERE student_id=? ORDER BY created_at DESC LIMIT 100').all(sid).map(h => ({ ...h, ts: h.created_at*1000 }));
  const gb = db.prepare('SELECT content FROM gb_data WHERE student_id=?').get(sid)?.content || '';
  const files = db.prepare('SELECT * FROM files WHERE student_id=? ORDER BY created_at DESC').all(sid);
  return { exams, feedbacks, history, gb, files };
}

// ─── USER MANAGEMENT (Admin) ───────────────────────────────────────────
app.get('/api/users', auth, adminOnly, (req, res) => {
  const { role } = req.query;
  const where = role ? 'WHERE role=?' : "WHERE role != 'admin'";
  const rows = role
    ? db.prepare(`SELECT * FROM users ${where} ORDER BY created_at DESC`).all(role)
    : db.prepare(`SELECT * FROM users ${where} ORDER BY created_at DESC`).all();
  res.json(rows.map(clean));
});

app.post('/api/users', auth, adminOnly, (req, res) => {
  const { username, password, role, name, school, grade, targetUniv, targetDept, specialties, consultantId, memo, email } = req.body;
  if (!username || !password || !role || !name)
    return res.status(400).json({ error: '필수 정보가 누락되었습니다' });
  if (db.prepare('SELECT id FROM users WHERE username=?').get(username))
    return res.status(409).json({ error: '이미 사용 중인 아이디입니다' });

  const id = `${role.slice(0,2)}_${uid()}`;
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(`INSERT INTO users (id,username,password_hash,role,name,email,school,grade,target_univ,target_dept,specialties,consultant_id,memo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, username, hash, role, name, email||null, school||null, grade||null, targetUniv||null, targetDept||null, specialties||null, consultantId||null, memo||null);

  res.json(clean(db.prepare('SELECT * FROM users WHERE id=?').get(id)));
});

app.put('/api/users/:id', auth, (req, res) => {
  // 관리자: 모든 필드 수정 / 일반 사용자: 본인 프로필만
  if (req.user.role !== 'admin' && req.user.id !== req.params.id)
    return res.status(403).json({ error: '권한 없음' });

  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다' });

  const { name, school, grade, targetUniv, targetDept, specialties, consultantId, memo, email, password } = req.body;
  const hash = password ? bcrypt.hashSync(password, 10) : user.password_hash;

  // 아이디 중복 체크
  if (req.body.username && req.body.username !== user.username) {
    if (db.prepare('SELECT id FROM users WHERE username=? AND id!=?').get(req.body.username, req.params.id))
      return res.status(409).json({ error: '이미 사용 중인 아이디입니다' });
  }

  db.prepare(`UPDATE users SET name=?,email=?,school=?,grade=?,target_univ=?,target_dept=?,specialties=?,consultant_id=?,memo=?,password_hash=? WHERE id=?`)
    .run(name||user.name, email||user.email, school||user.school, grade||user.grade,
      targetUniv||user.target_univ, targetDept||user.target_dept,
      specialties||user.specialties, req.user.role==='admin' ? (consultantId??user.consultant_id) : user.consultant_id,
      memo||user.memo, hash, req.params.id);

  res.json(clean(db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id)));
});

app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  if (!db.prepare('SELECT id FROM users WHERE id=?').get(req.params.id))
    return res.status(404).json({ error: '사용자를 찾을 수 없습니다' });
  // 파일 삭제
  const files = db.prepare('SELECT stored_path FROM files WHERE student_id=?').all(req.params.id);
  files.forEach(f => { try { fs.unlinkSync(f.stored_path); } catch {} });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ─── SETTINGS ──────────────────────────────────────────────────────────
app.get('/api/settings', auth, adminOnly, (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const s = {};
  rows.forEach(r => { if (r.key !== 'api_key') s[r.key] = r.value; else s.apiKeySet = !!r.value; });
  res.json(s);
});

app.post('/api/settings', auth, adminOnly, (req, res) => {
  const { apiKey, model } = req.body;
  if (apiKey !== undefined) db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run('api_key', apiKey);
  if (model)   db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run('model', model);
  res.json({ success: true });
});

// ─── 생기부 ─────────────────────────────────────────────────────────────
app.get('/api/students/:studentId/gb', auth, canAccessStudent, (req, res) => {
  const gb = db.prepare('SELECT content FROM gb_data WHERE student_id=?').get(req.params.studentId);
  res.json({ content: gb?.content || '' });
});

app.put('/api/students/:studentId/gb', auth, canAccessStudent, (req, res) => {
  const { content } = req.body;
  db.prepare('INSERT OR REPLACE INTO gb_data (student_id,content,updated_at) VALUES (?,?,strftime(\'%s\',\'now\'))')
    .run(req.params.studentId, content || '');
  res.json({ success: true });
});

// ─── EXAMS ─────────────────────────────────────────────────────────────
app.get('/api/students/:studentId/exams', auth, canAccessStudent, (req, res) => {
  const exams = db.prepare('SELECT * FROM exams WHERE student_id=? ORDER BY due_date').all(req.params.studentId)
    .map(e => ({
      ...e, submitted: !!e.submitted,
      calFeedbacks: db.prepare('SELECT * FROM exam_feedbacks WHERE exam_id=? ORDER BY created_at').all(e.id)
        .map(f => ({ ...f, ts: f.created_at * 1000 }))
    }));
  res.json(exams);
});

app.post('/api/students/:studentId/exams', auth, adminOrConsultant, canAccessStudent, (req, res) => {
  const e = req.body;
  if (!e.subject || !e.topic) return res.status(400).json({ error: '과목과 주제는 필수입니다' });
  const VALID_TYPES = ['구술','발표','토론','제출'];
  const evalType = VALID_TYPES.includes(e.evalType) ? e.evalType : '제출';
  const VALID_STATUS = ['예정','진행중','완료'];
  const status = VALID_STATUS.includes(e.status) ? e.status : '예정';
  const id = `ex_${uid()}`;
  db.prepare(`INSERT INTO exams (id,student_id,subject,teacher,eval_type,time,teacher_note,topic,ratio,elements,due_date,status,submitted,consultant_note,materials) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.params.studentId, e.subject, e.teacher||'', evalType, e.time||'', e.teacherNote||'', e.topic, e.ratio||0, e.elements||'', e.dueDate||'', status, e.submitted?1:0, e.consultantNote||'', e.materials||'');
  const created = { ...db.prepare('SELECT * FROM exams WHERE id=?').get(id), submitted: !!e.submitted, calFeedbacks: [] };
  res.json(created);
});

app.put('/api/exams/:id', auth, adminOrConsultant, (req, res) => {
  const ex = db.prepare('SELECT * FROM exams WHERE id=?').get(req.params.id);
  if (!ex) return res.status(404).json({ error: '수행평가를 찾을 수 없습니다' });
  const e = req.body;
  const VALID_TYPES = ['구술','발표','토론','제출'];
  const VALID_STATUS = ['예정','진행중','완료'];
  const evalType = VALID_TYPES.includes(e.evalType) ? e.evalType : ex.eval_type;
  const status = VALID_STATUS.includes(e.status) ? e.status : ex.status;
  db.prepare(`UPDATE exams SET subject=?,teacher=?,eval_type=?,time=?,teacher_note=?,topic=?,ratio=?,elements=?,due_date=?,status=?,submitted=?,consultant_note=?,materials=? WHERE id=?`)
    .run(e.subject||ex.subject, e.teacher??ex.teacher, evalType, e.time??ex.time, e.teacherNote??ex.teacher_note, e.topic||ex.topic, e.ratio??ex.ratio, e.elements??ex.elements, e.dueDate??ex.due_date, status, (e.submitted??ex.submitted)?1:0, e.consultantNote??ex.consultant_note, e.materials??ex.materials, req.params.id);
  const updated = { ...db.prepare('SELECT * FROM exams WHERE id=?').get(req.params.id), submitted: !!(e.submitted??ex.submitted), calFeedbacks: db.prepare('SELECT * FROM exam_feedbacks WHERE exam_id=?').all(req.params.id).map(f=>({...f,ts:f.created_at*1000})) };
  res.json(updated);
});

app.delete('/api/exams/:id', auth, adminOrConsultant, (req, res) => {
  db.prepare('DELETE FROM exams WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// 수행평가 캘린더 피드백
app.post('/api/exams/:id/feedbacks', auth, (req, res) => {
  const ex = db.prepare('SELECT student_id FROM exams WHERE id=?').get(req.params.id);
  if (!ex) return res.status(404).json({ error: '수행평가를 찾을 수 없습니다' });
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: '내용을 입력해주세요' });
  const id = `cf_${uid()}`;
  const ts = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO exam_feedbacks (id,exam_id,role,author,content,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, req.params.id, req.user.role, req.user.name, content.trim(), ts);
  res.json({ id, role: req.user.role, author: req.user.name, content: content.trim(), ts: ts * 1000, created_at: ts });
});

// ─── REPORT FEEDBACKS ──────────────────────────────────────────────────
app.get('/api/students/:studentId/feedbacks', auth, canAccessStudent, (req, res) => {
  const fbs = db.prepare('SELECT * FROM report_feedbacks WHERE student_id=? ORDER BY created_at DESC').all(req.params.studentId)
    .map(f => ({ ...f, createdAt: f.created_at*1000, updatedAt: f.updated_at*1000, studentRead: !!f.student_read }));
  res.json(fbs);
});

app.post('/api/students/:studentId/feedbacks', auth, canAccessStudent, (req, res) => {
  if (req.user.role !== 'student' && req.user.id !== req.params.studentId && req.user.role !== 'admin')
    return res.status(403).json({ error: '학생만 피드백 요청을 생성할 수 있습니다' });
  const { type, title, studentContent } = req.body;
  if (!title || !studentContent) return res.status(400).json({ error: '제목과 내용은 필수입니다' });
  const id = `fb_${uid()}`;
  const ts = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO report_feedbacks (id,student_id,type,title,student_content,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req.params.studentId, type||'기타', title, studentContent, '요청중', ts, ts);
  res.json({ id, type, title, studentContent, status:'요청중', createdAt:ts*1000, updatedAt:ts*1000 });
});

app.put('/api/feedbacks/:id', auth, adminOrConsultant, (req, res) => {
  const fb = db.prepare('SELECT * FROM report_feedbacks WHERE id=?').get(req.params.id);
  if (!fb) return res.status(404).json({ error: '피드백을 찾을 수 없습니다' });
  const { consultantContent, status } = req.body;
  const ts = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE report_feedbacks SET consultant_content=?,status=?,updated_at=? WHERE id=?')
    .run(consultantContent||fb.consultant_content, status||'피드백완료', ts, req.params.id);
  const updated = db.prepare('SELECT * FROM report_feedbacks WHERE id=?').get(req.params.id);
  res.json({ ...updated, createdAt: updated.created_at*1000, updatedAt: updated.updated_at*1000 });
});

// ─── ANALYSIS HISTORY ──────────────────────────────────────────────────
app.get('/api/students/:studentId/history', auth, canAccessStudent, (req, res) => {
  const hist = db.prepare('SELECT * FROM analysis_history WHERE student_id=? ORDER BY created_at DESC LIMIT 100').all(req.params.studentId)
    .map(h => ({ ...h, ts: h.created_at * 1000 }));
  res.json(hist);
});

app.post('/api/students/:studentId/history', auth, canAccessStudent, (req, res) => {
  const { type, content } = req.body;
  const id = `h_${uid()}`;
  const ts = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO analysis_history (id,student_id,type,content,created_at) VALUES (?,?,?,?,?)')
    .run(id, req.params.studentId, type||'', (content||'').slice(0, 500), ts);
  // 최대 100건 유지
  const oldest = db.prepare('SELECT id FROM analysis_history WHERE student_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 100').all(req.params.studentId);
  if (oldest.length) db.prepare(`DELETE FROM analysis_history WHERE id IN (${oldest.map(()=>'?').join(',')})`).run(...oldest.map(o=>o.id));
  res.json({ id, type, content, ts: ts * 1000 });
});

// ─── FILE UPLOAD ────────────────────────────────────────────────────────
app.get('/api/students/:studentId/files', auth, canAccessStudent, (req, res) => {
  const files = db.prepare('SELECT * FROM files WHERE student_id=? ORDER BY created_at DESC').all(req.params.studentId);
  res.json(files.map(f => ({ ...f, url: `/uploads/${req.params.studentId}/${path.basename(f.stored_path)}` })));
});

app.post('/api/students/:studentId/files', auth, canAccessStudent, (req, res, next) => {
  // 요청 유저 ID를 multer destination에 전달하기 위해 임시 설정
  req.user = { ...req.user, id: req.params.studentId };
  next();
}, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다' });
  const id = `f_${uid()}`;
  const ts = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO files (id,student_id,original_name,stored_path,mime_type,size,description,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req.params.studentId, req.file.originalname, req.file.path, req.file.mimetype, req.file.size, req.body.description||'', ts);
  res.json({ id, originalName: req.file.originalname, url: `/uploads/${req.params.studentId}/${req.file.filename}`, mimeType: req.file.mimetype, size: req.file.size });
});

app.delete('/api/files/:id', auth, (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.id);
  if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다' });
  if (req.user.role !== 'admin' && req.user.id !== file.student_id)
    return res.status(403).json({ error: '권한 없음' });
  try { fs.unlinkSync(file.stored_path); } catch {}
  db.prepare('DELETE FROM files WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ─── CLAUDE API PROXY (서버사이드 스트리밍) ────────────────────────────
app.post('/api/claude/stream', auth, aiLimiter, async (req, res) => {
  const apiKey = db.prepare("SELECT value FROM settings WHERE key='api_key'").get()?.value;
  if (!apiKey) return res.status(503).json({ error: 'API 키가 설정되지 않았습니다. 관리자에게 문의하세요.' });

  const model = db.prepare("SELECT value FROM settings WHERE key='model'").get()?.value || 'claude-sonnet-4-6';
  const { system, userMsg, maxTokens } = req.body;
  if (!userMsg) return res.status(400).json({ error: '메시지가 없습니다' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const anthropic = new Anthropic({ apiKey });
    const stream = await anthropic.messages.create({
      model, max_tokens: maxTokens || 1500, stream: true,
      system: system || '당신은 대입 전문 컨설턴트입니다.',
      messages: [{ role: 'user', content: userMsg }]
    });

    let full = '';
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.text) {
        full += event.delta.text;
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }
    res.write(`data: ${JSON.stringify({ done: true, full })}\n\n`);
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// ─── GLOBAL ERROR HANDLER ──────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || '서버 오류가 발생했습니다' });
});

// ─── SPA FALLBACK ──────────────────────────────────────────────────────
app.get('*', (req, res) => {
  const idx = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(idx)) res.sendFile(idx);
  else res.status(404).send('BigLinker — public/index.html을 배포해주세요.');
});

// ─── START ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 BigLinker 서버 시작: http://localhost:${PORT}`);
  console.log(`📦 데이터베이스: ${path.resolve(DB_PATH)}`);
  console.log(`📁 업로드 폴더: ${path.resolve(UPLOADS)}\n`);
});

process.on('SIGTERM',()=>{db.close();process.exit(0);});
