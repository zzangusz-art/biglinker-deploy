'use strict';
/**
 * BigLinker 코칭그룹 — 백엔드 서버 (Enterprise Edition)
 * ──────────────────────────────────────────────────────
 * Node.js + Express + SQLite + JWT + Multer + Anthropic SDK
 * 보안: API 키 서버사이드 전용 (ENV 우선), JWT 강제 시크릿
 * RAG: BM25 기반 지식베이스 검색 → Claude 컨텍스트 주입
 * 분석: score_history / learning_analytics / recommendations 스키마
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
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const Anthropic  = require('@anthropic-ai/sdk');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── JWT 시크릿: 환경변수 필수 (없으면 경고 후 임시값 사용) ────────────────
const JWT_SECRET = (() => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const fallback = `bl-dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  console.warn('[WARN] JWT_SECRET 환경변수 미설정 — 서버 재시작 시 모든 세션 무효화됩니다. 운영 환경에서는 반드시 설정하세요.');
  return fallback;
})();

const DB_PATH  = process.env.DB_PATH    || './biglinker.db';
const UPLOADS  = process.env.UPLOADS_DIR || './uploads';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',');

// DB 디렉터리 자동 생성 (Railway /data 볼륨 등 경로가 없을 수 있음)
const DB_DIR = path.dirname(path.resolve(DB_PATH));
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });

// ═══════════════════════════════════════════════════════
// LOGGER
// ═══════════════════════════════════════════════════════
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function log(level, msg, meta = {}) {
  if (LEVELS[level] > LEVELS[LOG_LEVEL]) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta });
  level === 'error' ? console.error(line) : console.log(line);
}

// ═══════════════════════════════════════════════════════
// DATABASE
// ═══════════════════════════════════════════════════════
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── 기존 테이블 ───────────────────────────────────────
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

  CREATE TABLE IF NOT EXISTS grades (
    id             TEXT PRIMARY KEY,
    student_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    year           INTEGER NOT NULL,
    semester       INTEGER NOT NULL,
    subject        TEXT NOT NULL,
    credits        INTEGER DEFAULT 2,
    raw_score      REAL,
    subject_avg    REAL,
    std_dev        REAL,
    grade_level    REAL,
    achievement    TEXT,
    rank_in_class  INTEGER,
    total_students INTEGER,
    notes          TEXT,
    created_at     INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS analysis_results (
    student_id  TEXT NOT NULL,
    type        TEXT NOT NULL,
    content     TEXT,
    updated_at  INTEGER DEFAULT (strftime('%s','now')),
    PRIMARY KEY (student_id, type)
  );
`);

// ── 신규 테이블 (Enterprise 기능) ─────────────────────
db.exec(`
  /* RAG 지식베이스 청크 */
  CREATE TABLE IF NOT EXISTS kb_chunks (
    id         TEXT PRIMARY KEY,
    source     TEXT NOT NULL,
    category   TEXT,
    title      TEXT NOT NULL,
    content    TEXT NOT NULL,
    tokens     TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  /* 역량 점수 히스토리 (분석 결과 저장 시 자동 기록) */
  CREATE TABLE IF NOT EXISTS score_history (
    id             TEXT PRIMARY KEY,
    student_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    analysis_type  TEXT NOT NULL,
    scores         TEXT,
    created_at     INTEGER DEFAULT (strftime('%s','now'))
  );

  /* 학습 이벤트 로그 */
  CREATE TABLE IF NOT EXISTS learning_analytics (
    id          TEXT PRIMARY KEY,
    student_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_type  TEXT NOT NULL,
    metadata    TEXT,
    created_at  INTEGER DEFAULT (strftime('%s','now'))
  );

  /* 개인화 추천 */
  CREATE TABLE IF NOT EXISTS recommendations (
    id         TEXT PRIMARY KEY,
    student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category   TEXT NOT NULL,
    priority   INTEGER DEFAULT 0,
    title      TEXT NOT NULL,
    content    TEXT NOT NULL,
    source     TEXT,
    is_read    INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    expires_at INTEGER
  );
`);

// ─── 인덱스 (성능) ────────────────────────────────────
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_score_history_student ON score_history(student_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_analytics_student     ON learning_analytics(student_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_reco_student          ON recommendations(student_id, is_read, priority DESC);
  CREATE INDEX IF NOT EXISTS idx_kb_category           ON kb_chunks(category);
`);

// ═══════════════════════════════════════════════════════
// BM25 — RAG 검색 엔진 (외부 의존성 없는 순수 JS 구현)
// ═══════════════════════════════════════════════════════
class BM25 {
  constructor(k1 = 1.5, b = 0.75) {
    this.k1 = k1; this.b = b;
    this.corpus = []; // [{id, meta, tf:{term:freq}, len}]
    this.idf    = {};
    this.avgdl  = 0;
  }

  /** 한국어·영어 혼합 토크나이저 */
  _tok(txt) {
    return txt
      .replace(/[^\w가-힣ㄱ-ㅎㅏ-ㅣ]/g, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter(t => t.length >= 1);
  }

  /** 코퍼스 전체 재빌드 */
  build(docs /* [{id, text, meta?}] */) {
    this.corpus = docs.map(d => {
      const tokens = this._tok(d.text);
      const tf = {};
      tokens.forEach(t => { tf[t] = (tf[t] || 0) + 1; });
      return { id: d.id, meta: d.meta || {}, tf, len: tokens.length };
    });
    this._reindex();
    log('info', `[BM25] 코퍼스 빌드 완료`, { docs: this.corpus.length });
  }

  _reindex() {
    if (!this.corpus.length) return;
    this.avgdl = this.corpus.reduce((s, d) => s + d.len, 0) / this.corpus.length;
    const df = {}, N = this.corpus.length;
    this.corpus.forEach(d => Object.keys(d.tf).forEach(t => { df[t] = (df[t] || 0) + 1; }));
    this.idf = {};
    Object.keys(df).forEach(t => {
      this.idf[t] = Math.log((N - df[t] + 0.5) / (df[t] + 0.5) + 1);
    });
  }

  /** 쿼리에 맞는 상위 K 문서 반환 */
  search(query, topK = 4) {
    if (!this.corpus.length) return [];
    const qTerms = this._tok(query);
    const scores = this.corpus.map(d => {
      let sc = 0;
      qTerms.forEach(t => {
        const idf = this.idf[t] || 0;
        const f   = d.tf[t]    || 0;
        sc += idf * (f * (this.k1 + 1)) /
              (f + this.k1 * (1 - this.b + this.b * d.len / this.avgdl));
      });
      return { id: d.id, score: sc, meta: d.meta };
    });
    return scores
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

const bm25 = new BM25();

/** DB에서 BM25 코퍼스 재로드 */
function rebuildBM25() {
  const chunks = db.prepare('SELECT id, title, content, category FROM kb_chunks').all();
  bm25.build(chunks.map(c => ({
    id:   c.id,
    text: `${c.title} ${c.content}`,
    meta: { title: c.title, category: c.category }
  })));
}

// ═══════════════════════════════════════════════════════
// 점수 추출기 (AI 출력 텍스트 → 숫자 맵)
// 2027 수시카드 마스터플랜 11대 세부 항목 기준
// ═══════════════════════════════════════════════════════
const SCORE_PATTERNS = [
  // ── 역량 종합 점수 ──────────────────────────────────
  { key: '학업역량',          re: /\[SCORE:학업역량\]\s*([0-9]+(?:\.[0-9]+)?)/ },
  { key: '진로역량',          re: /\[SCORE:진로역량\]\s*([0-9]+(?:\.[0-9]+)?)/ },
  { key: '공동체역량',        re: /\[SCORE:공동체역량\]\s*([0-9]+(?:\.[0-9]+)?)/ },

  // ── 학업역량 3대 세부 항목 ──────────────────────────
  { key: '학업성취도',        re: /\[SCORE:학업성취도\]\s*([0-9]+(?:\.[0-9]+)?)/ },
  { key: '탐구역량',          re: /\[SCORE:탐구역량\]\s*([0-9]+(?:\.[0-9]+)?)/ },
  { key: '학업태도',          re: /\[SCORE:학업태도\]\s*([0-9]+(?:\.[0-9]+)?)/ },

  // ── 진로역량 5대 세부 항목 ──────────────────────────
  { key: '전공연계교과선택',  re: /\[SCORE:전공연계교과선택\]\s*([0-9]+(?:\.[0-9]+)?)/ },
  { key: '전공연계성취도',    re: /\[SCORE:전공연계성취도\]\s*([0-9]+(?:\.[0-9]+)?)/ },
  { key: '진로탐색활동',      re: /\[SCORE:진로탐색활동\]\s*([0-9]+(?:\.[0-9]+)?)/ },
  { key: '기록충실성',        re: /\[SCORE:기록충실성\]\s*([0-9]+(?:\.[0-9]+)?)/ },
  { key: '자기주도탐색',      re: /\[SCORE:자기주도탐색\]\s*([0-9]+(?:\.[0-9]+)?)/ },

  // ── 공동체역량 3대 세부 항목 ────────────────────────
  { key: '소통협업',          re: /\[SCORE:소통협업\]\s*([0-9]+(?:\.[0-9]+)?)/ },
  { key: '리더십경험',        re: /\[SCORE:리더십경험\]\s*([0-9]+(?:\.[0-9]+)?)/ },
  { key: '배려책임감',        re: /\[SCORE:배려책임감\]\s*([0-9]+(?:\.[0-9]+)?)/ },

  // ── 레거시 키 폴백 (이전 버전 호환) ─────────────────
  { key: '탐구심',            re: /\[SCORE:탐구심\]\s*([0-9]+(?:\.[0-9]+)?)/ },
  { key: '학업발전도',        re: /\[SCORE:학업발전도\]\s*([0-9]+(?:\.[0-9]+)?)/ },
  { key: '과목세특질',        re: /\[SCORE:과목세특질\]\s*([0-9]+(?:\.[0-9]+)?)/ },
  { key: '진로일관성',        re: /\[SCORE:진로일관성\]\s*([0-9]+(?:\.[0-9]+)?)/ },
  { key: '전공적합성',        re: /\[SCORE:전공적합성\]\s*([0-9]+(?:\.[0-9]+)?)/ },
  { key: '발전가능성',        re: /\[SCORE:발전가능성\]\s*([0-9]+(?:\.[0-9]+)?)/ },
  { key: '협력성',            re: /\[SCORE:협력성\]\s*([0-9]+(?:\.[0-9]+)?)/ },
  { key: '리더십',            re: /\[SCORE:리더십\]\s*([0-9]+(?:\.[0-9]+)?)/ },
  { key: '나눔배려',          re: /\[SCORE:나눔.{0,2}배려\]\s*([0-9]+(?:\.[0-9]+)?)/ },
  { key: '출결성실성',        re: /\[SCORE:출결.{0,2}성실성\]\s*([0-9]+(?:\.[0-9]+)?)/ },

  // ── 자연어 폴백 ─────────────────────────────────────
  { key: '학업역량',   re: /학업역량[^\d]{0,10}([6-9]\d|\d{2,3}(?:\.\d)?)점/ },
  { key: '진로역량',   re: /진로역량[^\d]{0,10}([6-9]\d|\d{2,3}(?:\.\d)?)점/ },
  { key: '공동체역량', re: /공동체역량[^\d]{0,10}([6-9]\d|\d{2,3}(?:\.\d)?)점/ },
];

function extractScores(content) {
  if (!content) return {};
  const out = {};
  for (const { key, re } of SCORE_PATTERNS) {
    if (out[key]) continue; // 이미 추출됨
    const m = content.match(re);
    if (m) {
      const v = parseFloat(m[1]);
      if (v >= 0 && v <= 100) out[key] = v;
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════
// 추천 생성 (규칙 기반)
// ═══════════════════════════════════════════════════════
function generateRecommendations(studentId, scores, analysisType) {
  const now = Math.floor(Date.now() / 1000);
  const recs = [];

  const thresholds = [
    { key: '학업역량',   label: '학업역량',
      keys: ['학업성취도','탐구역량','학업태도'],
      legacyKeys: ['탐구심','학업발전도','과목세특질','학습태도'] },
    { key: '진로역량',   label: '진로역량',
      keys: ['전공연계교과선택','전공연계성취도','진로탐색활동','기록충실성','자기주도탐색'],
      legacyKeys: ['진로일관성','전공적합성','진로탐색활동','발전가능성'] },
    { key: '공동체역량', label: '공동체역량',
      keys: ['소통협업','리더십경험','배려책임감'],
      legacyKeys: ['협력성','나눔배려','리더십','출결성실성'] },
  ];

  for (const group of thresholds) {
    const mainScore = scores[group.key];
    if (!mainScore) continue;
    // 신규 11-item 키 우선, 없으면 레거시 키 폴백
    const activeKeys = group.keys.some(k => scores[k] != null) ? group.keys
                     : (group.legacyKeys || group.keys);
    const subScores = activeKeys.map(k => scores[k]).filter(v => v != null);
    if (!subScores.length) continue;
    const minSub  = Math.min(...subScores);
    const weakKey = activeKeys[subScores.indexOf(minSub)];

    if (mainScore < 60) {
      recs.push({
        category: group.key,
        priority: 10,
        title: `${group.label} 집중 보완 필요`,
        content: `현재 ${group.label} 점수가 ${mainScore}점으로 경쟁력이 낮습니다. `
               + `특히 "${weakKey}" 항목(${minSub}점)이 가장 취약합니다. `
               + `담당 컨설턴트와 보완 전략을 수립하세요.`,
        source: analysisType,
      });
    } else if (mainScore < 75) {
      recs.push({
        category: group.key,
        priority: 5,
        title: `${group.label} 향상 여지 있음`,
        content: `${group.label} ${mainScore}점 — 양호 수준입니다. `
               + `"${weakKey}"(${minSub}점) 항목을 강화하면 상위 학교 지원 경쟁력이 올라갑니다.`,
        source: analysisType,
      });
    } else {
      recs.push({
        category: group.key,
        priority: 2,
        title: `${group.label} 강점 유지`,
        content: `${group.label} ${mainScore}점으로 우수합니다. 현재 강점을 유지하며 면접·자소서에 적극 활용하세요.`,
        source: analysisType,
      });
    }
  }

  // 수행평가 임박 체크
  const upcomingExams = db.prepare(`
    SELECT subject, topic, due_date FROM exams
    WHERE student_id=? AND status != '완료'
    AND due_date >= date('now') AND due_date <= date('now','+14 days')
    ORDER BY due_date LIMIT 3
  `).all(studentId);

  if (upcomingExams.length) {
    const list = upcomingExams.map(e => `${e.subject} "${e.topic}" (${e.due_date})`).join(', ');
    recs.push({
      category: '수행평가',
      priority: 8,
      title: '2주 내 수행평가 임박',
      content: `마감 임박 수행평가: ${list}. 컨설턴트 피드백을 미리 요청하세요.`,
      source: 'system',
    });
  }

  // 기존 추천 삭제 후 새로 삽입 (source 기준)
  db.prepare("DELETE FROM recommendations WHERE student_id=? AND source=?").run(studentId, analysisType);
  const ins = db.prepare(`
    INSERT INTO recommendations (id,student_id,category,priority,title,content,source,created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  recs.forEach(r => ins.run(uid(), studentId, r.category, r.priority, r.title, r.content, r.source, now));
}

// ═══════════════════════════════════════════════════════
// SEED DEFAULTS
// ═══════════════════════════════════════════════════════
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

    db.prepare(`INSERT OR IGNORE INTO exam_feedbacks (id,exam_id,role,author,content,created_at) VALUES (?,?,?,?,?,?)`).run('cf1','ex1','consultant','김컨설턴트','결론에 저체온증 환자 간호와 항상성 회복 과정을 연결하면 좋겠습니다.',Math.floor(Date.now()/1000)-172800);
    db.prepare(`INSERT OR IGNORE INTO exam_feedbacks (id,exam_id,role,author,content,created_at) VALUES (?,?,?,?,?,?)`).run('cf2','ex1','student','김동형','감사합니다! 간호학 파트를 추가해서 다시 보여드릴게요.',Math.floor(Date.now()/1000)-86400);
    db.prepare(`INSERT OR IGNORE INTO report_feedbacks (id,student_id,type,title,student_content,consultant_content,status,created_at) VALUES (?,?,?,?,?,?,?,?)`).run('fb1','st_1','수행평가 보고서','생명과학 항상성 보고서 초안 피드백 요청','항상성 탐구 보고서 초안을 작성했는데 결론 부분이 약한 것 같습니다.','결론에 간호학 연계를 강화하세요. 저체온증 환자의 항상성 회복 과정을 체온조절 메커니즘과 연결하면 훨씬 설득력이 높아집니다.','피드백완료',Math.floor(Date.now()/1000)-172800);
    db.prepare(`INSERT OR IGNORE INTO report_feedbacks (id,student_id,type,title,student_content,status,created_at) VALUES (?,?,?,?,?,?,?)`).run('fb2','st_1','생기부 세특','수학 세특 탐구 주제 심화 방향 문의','코로나 지수함수 모델링을 더 심화하고 싶은데, 어떤 방향이 좋을까요?','요청중',Math.floor(Date.now()/1000)-3600);

    log('info', '기본 계정 및 샘플 데이터 생성 완료');
  }
}
seedDefaults();

// ── 지식베이스(KB) 시딩 ─────────────────────────────
function seedKnowledgeBase() {
  // 신규 KB 청크 (INSERT OR REPLACE 로 최신 내용 유지)
  const KB = [
    {
      id: 'kb_overview',
      source: 'evaluation_criteria',
      category: 'overview',
      title: '2027 수시카드 마스터플랜 개요 — 11대 세부 항목 평가 체계',
      content: `2027 수시카드 마스터플랜은 학생부종합전형(학종) 합격을 위해 생기부 3대 역량 11개 세부 항목을 100점 만점으로 수치화하는 평가 프레임워크입니다.
3대 역량: ①학업역량(3항목), ②진로역량(5항목), ③공동체역량(3항목)
5점 척도 → 100점 환산: 5점(90~95점)=우수, 4점(75~89점)=양호, 3점(55~74점)=보통, 2점(35~54점)=미흡, 1점(15~34점)=부족
일반고 학생 평균은 50~65점이며, 90점 이상 또는 30점 이하는 생기부에 명확한 근거가 있을 때만 부여합니다.
총점이 높아도 특정 역량이 50점 미만이면 합불에 영향을 줍니다.
추가 평가요소: 고교유형(특목·자사고 가산), 면접역량, 수능최저충족가능성, 특별전형 해당 여부`,
    },
    {
      id: 'kb_academic',
      source: 'evaluation_criteria',
      category: 'academic',
      title: '학업역량 평가 기준 — 3대 세부 항목 (2027 수시카드)',
      content: `학업역량은 3개 세부 항목으로 평가합니다. 가중 평균: 학업성취도 40% + 탐구역량 35% + 학업태도 25%

①학업성취도 (40%): 주요 과목의 등급·성취도·표준편차 등이 적절한가?
  우수(90~95점): 주요 과목 1~2등급 또는 성취도 A, 표준편차 우위 → 5점
  양호(75~89점): 2~3등급 또는 성취도 B, 일부 과목 상위 → 4점
  보통(55~74점): 3~4등급, 편차 있음 → 3점
  미흡(35~54점): 4등급 이하, 성취 들쭉날쭉 → 2점

②탐구역량 (35%): 수업 참여·발표·과제 수행 등에서의 적극성과 꾸준함이 드러나는가?
  우수(90~95점): 교사 세특에 "자발적 탐구", "창의적 발표" 등 구체 표현 + 심화 과정 기재 → 5점
  양호(75~89점): 참여는 적극적이나 탐구 깊이 불명확 → 4점
  보통(55~74점): 수업 참여 언급은 있으나 일반적 → 3점
  미흡(35~54점): 수동적·관찰적 기재 중심 → 2점

③학업태도 (25%): 교과 기반 심화 탐구(보고서·실험·발표 등)가 존재하고 주도성이 드러나는가?
  우수(90~95점): 소논문·자율 탐구 보고서·실험 설계 기재 + 3년 일관 → 5점
  양호(75~89점): 일부 심화 탐구 + 산발적 → 4점
  보통(55~74점): 수업 내 과제 수행 수준 → 3점`,
    },
    {
      id: 'kb_academic_detail',
      source: 'evaluation_criteria',
      category: 'academic',
      title: '학업역량 세부 항목별 판단 기준',
      content: `[학업성취도 판단 기준]
- 주요 과목(국·영·수·과) 1~2등급 또는 성취도 A → 우수(90점↑)
- 1학년→3학년 등급 향상 궤적 있으면 가산
- 특정 과목만 높고 나머지 미흡하면 양호 이하
- 표준편차가 낮은 경쟁 집단에서 높은 등급일수록 가산

[탐구역량 판단 기준]
- 교사 세특에 "~를 스스로 탐구", "실험을 설계하여" 등 주도성 표현 → 우수
- "적극 참여", "발표 우수" 수준은 보통
- 여러 과목에 걸쳐 탐구 기재 일관성 있으면 우수

[학업태도 판단 기준]
- 교과 연계 소논문·탐구 보고서·자체 실험 → 우수
- 3년간 동일 진로 방향 학업 태도 일관성 → 우수
- 단발성 활동·수상 이력만 있으면 보통
- 교사 추천·멘토링 역할 기재 시 가산`,
    },
    {
      id: 'kb_career',
      source: 'evaluation_criteria',
      category: 'career',
      title: '진로역량 평가 기준 — 5대 세부 항목 (2027 수시카드)',
      content: `진로역량은 5개 세부 항목으로 평가합니다. 가중 평균: 전공연계교과선택20% + 전공연계성취도25% + 진로탐색활동20% + 기록충실성20% + 자기주도탐색15%

①전공연계교과선택 (20%): 진로와 관련된 과목을 스스로 선택하고 연계 학습을 시도했는가?
  우수: 의약계→생명과학·화학·수학 모두 선택, 이공계→수학·물리·정보 선택 → 4~5점
  보통: 일부 선택, 나머지 누락 → 3점
  미흡: 진로와 무관한 과목 선택 → 2점

②전공연계성취도 (25%): 진로 관련 교과목에서의 성취 수준과 태도가 일정하거나 우수한가?
  우수: 진로 관련 과목 1~2등급 + 세특에 진로 연계 탐구 → 5점
  양호: 성취 양호하나 세특 연계 약함 → 4점
  보통: 진로 과목 이수하나 성취 보통 → 3점

③진로탐색활동 (20%): 관련 직업군 탐색·인터뷰·자율주제 탐구·진로독서 등이 구체적으로 나타나는가?
  우수: 직업인 인터뷰 기록 + 진로 독서(책 제목·내용 인용) + 현장체험 → 5점
  양호: 일부 활동 있으나 구체성 부족 → 4점
  보통: 학교 진로 수업 참여 기재만 → 3점

④기록충실성 (20%): 창의적 체험활동·자율활동의 기록이 구체적이고 실제 활동 내용이 드러나는가?
  우수: 창체·자율활동 기록에 날짜·내용·배움 구체 기재 → 5점
  보통: 활동 나열만, 배움·성찰 없음 → 3점

⑤자기주도탐색 (15%): 자발적으로 계획·실행한 활동(자율동아리, 소논문 등)이 존재하는가?
  우수: 자율동아리 창설·운영 또는 소논문 제출 → 5점 (단, 없는 경우 3점이 일반적)
  양호: 자율동아리 참여 → 4점
  보통: 정규 활동 이외 자기 주도 활동 없음 → 3점`,
    },
    {
      id: 'kb_career_detail',
      source: 'evaluation_criteria',
      category: 'career',
      title: '진로역량 세부 항목별 판단 기준',
      content: `[전공연계교과선택 판단 기준]
- 의약계 희망: 생명과학Ⅱ·화학Ⅱ·수학Ⅱ 모두 선택 → 우수
- 이공계 희망: 수학·물리·정보 선택 → 우수
- 인문계 희망: 사회·역사·언어 심화 선택 → 우수
- 과목 선택이 진로와 일치하지 않으면 감점

[전공연계성취도 판단 기준]
- 진로 과목 1등급 + 세특에 심화 탐구 → 5점(90점)
- 진로 과목 2등급 + 적극적 참여 세특 → 4점(80점)
- 진로 과목 3등급 이하 → 3점 이하

[진로탐색활동 판단 기준]
- "의사 OOO 인터뷰 진행" 처럼 구체적 인터뷰 기재 → 우수
- 독서 기록에 책 제목·저자·인용 내용 기재 → 우수
- "진로 탐색 활동 참여"만 기재 → 보통

[기록충실성 판단 기준]
- 창체 기록 500자 이상, 활동별 성찰 포함 → 우수
- 자율활동에서 학생의 역할·배움 구체 기재 → 우수
- 활동명만 기재, 내용 없음 → 미흡

[자기주도탐색 판단 기준]
- 자율동아리 창설·소논문 → 우수(5점)
- 자율동아리 참여 → 양호(4점)
- 없음 → 보통(3점) — 없다고 크게 감점은 아님(가중치 15%로 낮음)`,
    },
    {
      id: 'kb_community',
      source: 'evaluation_criteria',
      category: 'community',
      title: '공동체역량 평가 기준 — 3대 세부 항목 (2027 수시카드)',
      content: `공동체역량은 3개 세부 항목으로 평가합니다. 가중 평균: 소통협업 40% + 리더십경험 35% + 배려책임감 25%

①소통협업 (40%): 공동 프로젝트·모둠활동·행사 기획 등에서 협업 태도가 드러나는가?
  우수(90~95점): 역할 분담·조율·의견 통합 구체적 기재 + 결과물 언급 → 4~5점
  양호(75~89점): 협업 참여 기재 있으나 역할 불명확 → 3~4점
  보통(55~74점): "팀원과 협력" 정도의 일반 기재 → 3점

②리더십경험 (35%): 역할 수행·모임 운영 등에서 리더십이 드러나는 경험이 존재하는가?
  우수(90~95점): 반장·학생회·동아리장 + 실제 기획·추진 성과 기재 → 4~5점
  양호(75~89점): 리더 역할은 있으나 활동 성과 기재 약함 → 3~4점
  보통(55~74점): 리더 역할 없음, 팀원 참여 → 3점

③배려책임감 (25%): 공동체 규칙 준수·갈등 조정·배려적 행동의 구체 사례가 생기부에 드러나는가?
  우수(90~95점): 갈등 조정 사례·배려 행동 구체 기재 + 봉사활동 진로 연계 → 4~5점
  양호(75~89점): 봉사 참여 있고 배려 언급 있으나 추상적 → 3~4점
  보통(55~74점): 규칙 준수·출결 성실 수준 → 3점`,
    },
    {
      id: 'kb_community_detail',
      source: 'evaluation_criteria',
      category: 'community',
      title: '공동체역량 세부 항목별 판단 기준',
      content: `[소통협업 판단 기준]
- 모둠 활동 세특에 "팀장으로서 의견 조율", "역할 분담 후 결과물 완성" → 우수
- 단순 "모둠 참여" 기재 → 보통
- 여러 과목에 걸쳐 협업 역할 기재 일관성 있으면 우수

[리더십경험 판단 기준]
- 반장·동아리장 + 실제 행사 기획, 프로젝트 추진 결과 기재 → 우수
- 역할만 있고 활동 내용 없으면 양호 이하
- 비공식 리더십(소그룹 조장, 스터디 운영)도 인정되나 공식 임원보다 낮음
- 반장을 3년 내내 했어도 세특에 리더십 발현 내용 없으면 보통

[배려책임감 판단 기준]
- 봉사활동 시간 50시간 이상 + 내용 구체 + 진로 연계 → 우수
- 갈등 상황 → 조정 과정 → 결과 기재 → 우수
- 봉사 이수만 있고 내용 없으면 보통
- 3년간 무결석·무지각 기재 시 기본 가산`,
    },
    {
      id: 'kb_admission_strategy',
      source: 'admission_guide',
      category: 'admission',
      title: '수시 학종 지원 전략 가이드',
      content: `학생부종합전형(학종)은 내신+비교과(생기부)를 종합 평가합니다.
핵심 전략: 1) 강점 역량 파악 → 2) 약점 역량 보완 → 3) 지원 학교 선정.
상위권(서울대·연고대·의대): 학업역량 85점 이상 + 진로역량 80점 이상 + 내신 1~2등급.
중상위권(건동홍·중경외시·의약계 지방): 학업역량 75점 이상 + 내신 2~3등급.
안정권(지방 거점 국립대): 학업역량 65점 이상 + 내신 3~4등급.
합격컷 분석 시 반드시 수능 최저학력기준 충족 여부 확인 필요.
면접 있는 학교는 생기부 기반 예상 질문 준비 필수.
지원 포트폴리오: 소신 1개 + 적정 2개 + 안정 2개 구성 권장.`,
    },
    {
      id: 'kb_cutoff_analysis',
      source: 'admission_guide',
      category: 'cutoff',
      title: '합격컷 분석 기준 및 방법',
      content: `합격컷 분석은 학생의 역량 점수를 바탕으로 지원 가능한 학교·학과의 합격 가능성을 판단합니다.
[분석 항목] 내신 등급, 학업역량, 진로역량, 공동체역량, 수능 최저 충족 여부.
[합격 가능성 분류]
- 도전(Reach): 현 역량보다 1~2단계 높은 목표. 합격률 20% 이하.
- 적정(Match): 현 역량과 비슷한 수준. 합격률 50~70%.
- 안정(Safe): 현 역량보다 낮은 목표. 합격률 80% 이상.
[지원 전략] 학종 3~4개 + 교과전형 1~2개 + 논술/수능 1~2개 조합 권장.
최근 3년 입시 결과 기준 합격컷: 의대(학업역량 90↑+진로 85↑), 간호학과(학업역량 75↑+진로 70↑).`,
    },
    {
      id: 'kb_interview_guide',
      source: 'admission_guide',
      category: 'interview',
      title: '학종 면접 준비 가이드',
      content: `학종 면접은 생기부 기반 제출서류 확인 면접이 주류입니다.
[핵심 준비 사항]
1. 생기부 전체 숙지: 각 세특, 활동, 수상의 구체적 내용 설명 가능해야 함.
2. 예상 질문 유형: ①세특 심화질문 ②활동 동기·배운 점 ③진로 연결성 ④시사·전공 상식.
3. 답변 구조: STAR(Situation-Task-Action-Result) 형태 권장.
[자주 나오는 질문 패턴]
- "○○ 탐구를 더 깊이 해본 게 있나요?"
- "이 활동이 전공과 어떻게 연결되나요?"
- "가장 인상 깊었던 세특 주제는?"
- "본인의 강점 3가지는?"
[평가 기준] 논리성, 전공 이해도, 소통 능력, 성장 가능성.`,
    },
    {
      id: 'kb_gb_writing',
      source: 'admission_guide',
      category: 'gb',
      title: '생기부 세특 작성 전략',
      content: `생기부 세특(세부능력 및 특기사항)은 학종의 핵심 평가 자료입니다.
[고득점 세특의 특징]
1. 구체성: "실험을 통해 ~를 발견했으며" 처럼 수치·과정이 명확.
2. 주도성: "스스로 주제를 선정하여", "자발적으로 조사" 등의 표현.
3. 연계성: 교과 내용 → 진로 연계 → 추가 탐구의 흐름.
4. 깊이: 교과서 수준을 넘어 외부 자료·논문 참조.
[과목별 핵심]
- 수학: 실생활 또는 진로 연계 문제 탐구, 증명 과정 기재.
- 과학: 실험 설계→수행→분석→결론 전 과정 기재.
- 국어/영어: 비판적 읽기, 글쓰기 역량 표현.
[작성 시 주의] 단순 수업 참여 기재 금지. 학생 특기를 교사가 관찰한 형태로 기재.`,
    },
    {
      id: 'kb_score_improvement',
      source: 'coaching_guide',
      category: 'strategy',
      title: '역량 점수 향상 전략',
      content: `역량 점수를 높이기 위한 단계별 전략입니다.
[학업역량 향상]
- 세특에 탐구 주제를 명확히 기재 (교사와 협의).
- 관심 과목 소논문 또는 심화 보고서 작성.
- 경시대회·올림피아드 참여 (결과보다 과정 중요).
[진로역량 향상]
- 진로 관련 책 3권 이상 독서 후 독서록 세특 반영.
- 관련 직업인 인터뷰 또는 현장체험 활동.
- 자율동아리 창설 또는 진로 연계 동아리 활동 강화.
[공동체역량 향상]
- 학생회·반장 등 리더십 역할 도전.
- 진로 연계 봉사활동 (의약계 → 병원 봉사 등).
- 팀 프로젝트에서 조장 역할 및 결과물 명시.
[우선순위] 50점 이하 항목 → 50~70점 항목 → 70점 이상 유지 순으로 집중.`,
    },
    {
      id: 'kb_rag_usage',
      source: 'system',
      category: 'system',
      title: 'RAG 지식베이스 활용 안내',
      content: `이 시스템은 BM25 검색 기반 RAG(검색 증강 생성)를 사용합니다.
AI 분석 시 질문 내용에 관련된 평가 기준, 지원 전략, 코칭 가이드를 자동으로 검색하여 AI 답변의 정확도와 일관성을 높입니다.
지식베이스에는 2027 수시카드 마스터플랜 평가 기준, 합격컷 분석 기준, 면접 준비 가이드, 생기부 세특 작성 전략 등이 포함되어 있습니다.
관리자는 /api/rag/kb 엔드포인트를 통해 지식베이스를 추가·수정·삭제할 수 있습니다.`,
    },
  ];

  // INSERT OR REPLACE → 서버 재시작 시 항상 최신 내용으로 갱신
  const ins = db.prepare(`
    INSERT OR REPLACE INTO kb_chunks (id,source,category,title,content,created_at)
    VALUES (?,?,?,?,?,strftime('%s','now'))
  `);
  KB.forEach(c => ins.run(c.id, c.source, c.category, c.title, c.content));
  log('info', `[RAG] 지식베이스 ${KB.length}개 청크 시딩/갱신 완료`);
}
seedKnowledgeBase();
rebuildBM25(); // 시동 시 BM25 인덱스 로드

// ═══════════════════════════════════════════════════════
// API KEY 헬퍼 (ENV 우선 → DB 폴백)
// ═══════════════════════════════════════════════════════
function getApiKey() {
  // 1순위: 환경변수 (Railway/Render 배포 시 가장 안전)
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  // 2순위: DB 설정 (관리자 UI에서 저장)
  return db.prepare("SELECT value FROM settings WHERE key='api_key'").get()?.value || null;
}

function getModel() {
  return db.prepare("SELECT value FROM settings WHERE key='model'").get()?.value || 'claude-sonnet-4-6';
}

// ═══════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════

// 보안 헤더 (CSP는 인라인 스크립트를 허용하도록 완화)
app.use(helmet({
  contentSecurityPolicy: false, // SPA 인라인 스크립트 허용
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: ALLOWED_ORIGINS.length === 1 && ALLOWED_ORIGINS[0] === '*' ? '*' : ALLOWED_ORIGINS,
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// 요청 ID + 접근 로그
app.use((req, _res, next) => {
  req.reqId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  if (req.path.startsWith('/api/')) {
    log('debug', `→ ${req.method} ${req.path}`, { reqId: req.reqId, ip: req.ip });
  }
  next();
});

app.use('/uploads', express.static(UPLOADS));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Multer 설정
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOADS, req.user?.id || 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// ═══════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ═══════════════════════════════════════════════════════
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: '로그인이 필요합니다' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: '세션이 만료되었습니다. 다시 로그인해주세요.' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: '관리자 권한이 필요합니다' });
  next();
}

function adminOrConsultant(req, res, next) {
  if (!['admin', 'consultant'].includes(req.user?.role))
    return res.status(403).json({ error: '권한이 없습니다' });
  next();
}

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

// ═══════════════════════════════════════════════════════
// RATE LIMITERS
// ═══════════════════════════════════════════════════════
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const aiLimiter   = rateLimit({ windowMs: 60 * 1000, max: 30 });
const ragLimiter  = rateLimit({ windowMs: 60 * 1000, max: 60 });

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════
function uid() { return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`; }

function clean(u) {
  if (!u) return null;
  const { password_hash, consultant_id, target_univ, target_dept, created_at, ...safe } = u;
  return {
    ...safe,
    consultantId: consultant_id || '',
    targetUniv:   target_univ   || '',
    targetDept:   target_dept   || '',
    createdAt:    created_at    || 0,
  };
}

function cleanExam(e) {
  const { student_id, eval_type, teacher_note, due_date, consultant_note, created_at, ...rest } = e;
  return {
    ...rest,
    studentId:      student_id,
    evalType:       eval_type       || '제출',
    teacherNote:    teacher_note    || '',
    dueDate:        due_date        || '',
    consultantNote: consultant_note || '',
    submitted:      !!e.submitted,
    calFeedbacks:   db.prepare('SELECT * FROM exam_feedbacks WHERE exam_id=? ORDER BY created_at').all(e.id)
                      .map(f => ({ ...f, ts: f.created_at * 1000 })),
  };
}

function cleanFb(f) {
  return {
    ...f,
    studentContent:    f.student_content,
    consultantContent: f.consultant_content,
    createdAt:  f.created_at * 1000,
    updatedAt:  f.updated_at * 1000,
    studentRead: !!f.student_read,
  };
}

function getFullStudentData(sid) {
  const exams     = db.prepare('SELECT * FROM exams WHERE student_id=? ORDER BY due_date').all(sid).map(cleanExam);
  const feedbacks = db.prepare('SELECT * FROM report_feedbacks WHERE student_id=? ORDER BY created_at DESC').all(sid).map(cleanFb);
  const history   = db.prepare('SELECT * FROM analysis_history WHERE student_id=? ORDER BY created_at DESC LIMIT 100').all(sid)
                      .map(h => ({ ...h, ts: h.created_at * 1000 }));
  const gb        = db.prepare('SELECT content FROM gb_data WHERE student_id=?').get(sid)?.content || '';
  const files     = db.prepare('SELECT * FROM files WHERE student_id=? ORDER BY created_at DESC').all(sid);
  const grades    = db.prepare('SELECT * FROM grades WHERE student_id=? ORDER BY year,semester,subject').all(sid);
  const analysisRows = db.prepare('SELECT type,content,updated_at FROM analysis_results WHERE student_id=?').all(sid);
  const analyses  = {};
  analysisRows.forEach(r => { analyses[r.type] = { content: r.content, updatedAt: r.updated_at * 1000 }; });
  return { exams, feedbacks, history, gb, files, grades, analyses };
}

// ═══════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: Math.floor(process.uptime()), rag: bm25.corpus.length }));

app.post('/api/auth/login', authLimiter, (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요' });

    // 입력값 길이 제한
    if (username.length > 60 || password.length > 128)
      return res.status(400).json({ error: '입력값이 너무 깁니다' });

    const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다' });

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, name: user.name },
      JWT_SECRET,
      { expiresIn: '7d' },
    );

    const payload = { token, user: clean(user) };

    if (user.role === 'admin') {
      payload.students    = db.prepare("SELECT * FROM users WHERE role='student' ORDER BY created_at DESC").all().map(clean);
      payload.consultants = db.prepare("SELECT * FROM users WHERE role='consultant' ORDER BY created_at DESC").all().map(clean);
      // ⚠ API 키는 절대 클라이언트에 반환하지 않음 — apiKeySet 여부만 전달
      payload.apiKeySet   = !!getApiKey();
      payload.model       = getModel();
    } else if (user.role === 'consultant') {
      payload.myStudents  = db.prepare("SELECT * FROM users WHERE role='student' AND consultant_id=?").all(user.id).map(clean);
      payload.students    = payload.myStudents;
      payload.consultants = [clean(user)];
    } else {
      payload.studentData = getFullStudentData(user.id);
      payload.consultant  = user.consultant_id
        ? clean(db.prepare('SELECT * FROM users WHERE id=?').get(user.consultant_id))
        : null;
    }

    log('info', '로그인 성공', { user: user.username, role: user.role });
    res.json(payload);
  } catch (err) {
    log('error', '로그인 오류', { err: err.message });
    res.status(500).json({ error: '서버 오류가 발생했습니다' });
  }
});

// ═══════════════════════════════════════════════════════
// USER MANAGEMENT (Admin)
// ═══════════════════════════════════════════════════════
app.get('/api/users', auth, adminOnly, (req, res) => {
  const { role } = req.query;
  const rows = role
    ? db.prepare('SELECT * FROM users WHERE role=? ORDER BY created_at DESC').all(role)
    : db.prepare("SELECT * FROM users WHERE role != 'admin' ORDER BY created_at DESC").all();
  res.json(rows.map(clean));
});

app.post('/api/users', auth, adminOnly, (req, res) => {
  try {
    const { username, password, role, name, school, grade, targetUniv, targetDept, specialties, consultantId, memo, email } = req.body;
    if (!username || !password || !role || !name)
      return res.status(400).json({ error: '필수 정보가 누락되었습니다' });
    if (!['admin','consultant','student'].includes(role))
      return res.status(400).json({ error: '유효하지 않은 역할입니다' });
    if (db.prepare('SELECT id FROM users WHERE username=?').get(username))
      return res.status(409).json({ error: '이미 사용 중인 아이디입니다' });

    const id   = `${role.slice(0, 2)}_${uid()}`;
    const hash = bcrypt.hashSync(password, 10);
    db.prepare(`INSERT INTO users (id,username,password_hash,role,name,email,school,grade,target_univ,target_dept,specialties,consultant_id,memo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, username, hash, role, name, email || null, school || null, grade || null, targetUniv || null, targetDept || null, specialties || null, consultantId || null, memo || null);

    res.json(clean(db.prepare('SELECT * FROM users WHERE id=?').get(id)));
  } catch (err) {
    log('error', '사용자 생성 오류', { err: err.message });
    res.status(500).json({ error: '서버 오류가 발생했습니다' });
  }
});

app.put('/api/users/:id', auth, (req, res) => {
  if (req.user.role !== 'admin' && req.user.id !== req.params.id)
    return res.status(403).json({ error: '권한 없음' });

  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다' });

  const { name, school, grade, targetUniv, targetDept, specialties, consultantId, memo, email, password } = req.body;
  const hash = password ? bcrypt.hashSync(password, 10) : user.password_hash;

  if (req.body.username && req.body.username !== user.username) {
    if (db.prepare('SELECT id FROM users WHERE username=? AND id!=?').get(req.body.username, req.params.id))
      return res.status(409).json({ error: '이미 사용 중인 아이디입니다' });
  }

  db.prepare(`UPDATE users SET name=?,email=?,school=?,grade=?,target_univ=?,target_dept=?,specialties=?,consultant_id=?,memo=?,password_hash=? WHERE id=?`)
    .run(name || user.name, email || user.email, school || user.school, grade || user.grade,
      targetUniv || user.target_univ, targetDept || user.target_dept,
      specialties || user.specialties,
      req.user.role === 'admin' ? (consultantId ?? user.consultant_id) : user.consultant_id,
      memo || user.memo, hash, req.params.id);

  res.json(clean(db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id)));
});

app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  if (!db.prepare('SELECT id FROM users WHERE id=?').get(req.params.id))
    return res.status(404).json({ error: '사용자를 찾을 수 없습니다' });
  const files = db.prepare('SELECT stored_path FROM files WHERE student_id=?').all(req.params.id);
  files.forEach(f => { try { fs.unlinkSync(f.stored_path); } catch {} });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════
app.get('/api/settings', auth, adminOnly, (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const s = {};
  rows.forEach(r => { if (r.key !== 'api_key') s[r.key] = r.value; });
  // API 키는 설정 여부만 반환 (키 값 자체 절대 노출 금지)
  s.apiKeySet = !!getApiKey();
  s.apiKeySource = process.env.ANTHROPIC_API_KEY ? 'env' : (db.prepare("SELECT value FROM settings WHERE key='api_key'").get()?.value ? 'db' : 'none');
  res.json(s);
});

app.post('/api/settings', auth, adminOnly, (req, res) => {
  const { apiKey, model } = req.body;
  // API 키는 DB에만 저장 (env 우선이므로 env 설정 시 DB값 무시됨)
  if (apiKey !== undefined && apiKey !== '') {
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run('api_key', apiKey);
    log('info', 'API 키 DB 저장 완료', { admin: req.user.username });
  }
  if (model) db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run('model', model);
  res.json({ success: true, apiKeySet: !!getApiKey() });
});

// ═══════════════════════════════════════════════════════
// 생기부
// ═══════════════════════════════════════════════════════
app.get('/api/students/:studentId/gb', auth, canAccessStudent, (req, res) => {
  const gb = db.prepare('SELECT content FROM gb_data WHERE student_id=?').get(req.params.studentId);
  res.json({ content: gb?.content || '' });
});

app.put('/api/students/:studentId/gb', auth, canAccessStudent, (req, res) => {
  const { content } = req.body;
  db.prepare("INSERT OR REPLACE INTO gb_data (student_id,content,updated_at) VALUES (?,?,strftime('%s','now'))")
    .run(req.params.studentId, content || '');
  // 학습 이벤트 기록
  db.prepare('INSERT INTO learning_analytics (id,student_id,event_type,metadata,created_at) VALUES (?,?,?,?,strftime(\'%s\',\'now\'))')
    .run(uid(), req.params.studentId, 'gb_update', JSON.stringify({ len: (content || '').length }));
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════
// EXAMS
// ═══════════════════════════════════════════════════════
app.get('/api/students/:studentId/exams', auth, canAccessStudent, (req, res) => {
  const exams = db.prepare('SELECT * FROM exams WHERE student_id=? ORDER BY due_date').all(req.params.studentId).map(cleanExam);
  res.json(exams);
});

app.post('/api/students/:studentId/exams', auth, adminOrConsultant, canAccessStudent, (req, res) => {
  const e = req.body;
  if (!e.subject || !e.topic) return res.status(400).json({ error: '과목과 주제는 필수입니다' });
  const VALID_TYPES  = ['구술','발표','토론','제출'];
  const VALID_STATUS = ['예정','진행중','완료'];
  const evalType = VALID_TYPES.includes(e.evalType)   ? e.evalType  : '제출';
  const status   = VALID_STATUS.includes(e.status)    ? e.status    : '예정';
  const id = `ex_${uid()}`;
  db.prepare(`INSERT INTO exams (id,student_id,subject,teacher,eval_type,time,teacher_note,topic,ratio,elements,due_date,status,submitted,consultant_note,materials) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.params.studentId, e.subject, e.teacher || '', evalType, e.time || '', e.teacherNote || '', e.topic, e.ratio || 0, e.elements || '', e.dueDate || '', status, e.submitted ? 1 : 0, e.consultantNote || '', e.materials || '');
  res.json(cleanExam(db.prepare('SELECT * FROM exams WHERE id=?').get(id)));
});

app.put('/api/exams/:id', auth, adminOrConsultant, (req, res) => {
  const ex = db.prepare('SELECT * FROM exams WHERE id=?').get(req.params.id);
  if (!ex) return res.status(404).json({ error: '수행평가를 찾을 수 없습니다' });
  const e = req.body;
  const VALID_TYPES  = ['구술','발표','토론','제출'];
  const VALID_STATUS = ['예정','진행중','완료'];
  const evalType = VALID_TYPES.includes(e.evalType)   ? e.evalType  : ex.eval_type;
  const status   = VALID_STATUS.includes(e.status)    ? e.status    : ex.status;
  db.prepare(`UPDATE exams SET subject=?,teacher=?,eval_type=?,time=?,teacher_note=?,topic=?,ratio=?,elements=?,due_date=?,status=?,submitted=?,consultant_note=?,materials=? WHERE id=?`)
    .run(e.subject || ex.subject, e.teacher ?? ex.teacher, evalType, e.time ?? ex.time, e.teacherNote ?? ex.teacher_note, e.topic || ex.topic, e.ratio ?? ex.ratio, e.elements ?? ex.elements, e.dueDate ?? ex.due_date, status, (e.submitted ?? ex.submitted) ? 1 : 0, e.consultantNote ?? ex.consultant_note, e.materials ?? ex.materials, req.params.id);
  res.json(cleanExam(db.prepare('SELECT * FROM exams WHERE id=?').get(req.params.id)));
});

app.delete('/api/exams/:id', auth, adminOrConsultant, (req, res) => {
  db.prepare('DELETE FROM exams WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

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

// ═══════════════════════════════════════════════════════
// REPORT FEEDBACKS
// ═══════════════════════════════════════════════════════
app.get('/api/students/:studentId/feedbacks', auth, canAccessStudent, (req, res) => {
  const fbs = db.prepare('SELECT * FROM report_feedbacks WHERE student_id=? ORDER BY created_at DESC').all(req.params.studentId).map(cleanFb);
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
    .run(id, req.params.studentId, type || '기타', title, studentContent, '요청중', ts, ts);
  res.json({ id, type, title, studentContent, status: '요청중', createdAt: ts * 1000, updatedAt: ts * 1000 });
});

app.put('/api/feedbacks/:id', auth, adminOrConsultant, (req, res) => {
  const fb = db.prepare('SELECT * FROM report_feedbacks WHERE id=?').get(req.params.id);
  if (!fb) return res.status(404).json({ error: '피드백을 찾을 수 없습니다' });
  const { consultantContent, status } = req.body;
  const ts = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE report_feedbacks SET consultant_content=?,status=?,updated_at=? WHERE id=?')
    .run(consultantContent || fb.consultant_content, status || '피드백완료', ts, req.params.id);
  res.json(cleanFb(db.prepare('SELECT * FROM report_feedbacks WHERE id=?').get(req.params.id)));
});

// ═══════════════════════════════════════════════════════
// ANALYSIS HISTORY
// ═══════════════════════════════════════════════════════
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
    .run(id, req.params.studentId, type || '', (content || '').slice(0, 500), ts);
  // 최대 100건 유지
  const oldest = db.prepare('SELECT id FROM analysis_history WHERE student_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 100').all(req.params.studentId);
  if (oldest.length)
    db.prepare(`DELETE FROM analysis_history WHERE id IN (${oldest.map(() => '?').join(',')})`).run(...oldest.map(o => o.id));
  res.json({ id, type, content, ts: ts * 1000 });
});

// ═══════════════════════════════════════════════════════
// FILE UPLOAD
// ═══════════════════════════════════════════════════════
app.get('/api/students/:studentId/files', auth, canAccessStudent, (req, res) => {
  const files = db.prepare('SELECT * FROM files WHERE student_id=? ORDER BY created_at DESC').all(req.params.studentId);
  res.json(files.map(f => ({ ...f, url: `/uploads/${req.params.studentId}/${path.basename(f.stored_path)}` })));
});

app.post('/api/students/:studentId/files', auth, canAccessStudent, (req, res, next) => {
  req.user = { ...req.user, id: req.params.studentId };
  next();
}, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다' });
  const id = `f_${uid()}`;
  const ts = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO files (id,student_id,original_name,stored_path,mime_type,size,description,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req.params.studentId, req.file.originalname, req.file.path, req.file.mimetype, req.file.size, req.body.description || '', ts);
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

// ═══════════════════════════════════════════════════════
// CLAUDE API PROXY — SSE 스트리밍 + RAG 컨텍스트 주입
// ═══════════════════════════════════════════════════════
app.post('/api/claude/stream', auth, aiLimiter, async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(503).json({ error: 'API 키가 설정되지 않았습니다. 관리자에게 문의하세요.' });

  const model = getModel();
  const { system, userMsg, messages, maxTokens, ragQuery, studentId } = req.body;

  if (!userMsg && (!messages || !messages.length))
    return res.status(400).json({ error: '메시지가 없습니다' });

  const msgArray = (messages && messages.length)
    ? messages
    : [{ role: 'user', content: userMsg }];

  const tokens = Math.min(parseInt(maxTokens) || 8000, 8000);

  // ── RAG 컨텍스트 구성 ─────────────────────────────
  let ragContext = '';
  if (ragQuery && bm25.corpus.length) {
    const hits = bm25.search(ragQuery, 3);
    if (hits.length) {
      const chunks = hits.map(h => {
        const row = db.prepare('SELECT title, content FROM kb_chunks WHERE id=?').get(h.id);
        return row ? `[${row.title}]\n${row.content}` : '';
      }).filter(Boolean);
      if (chunks.length) {
        ragContext = `\n\n---\n【참고 지식베이스 (관련 평가 기준 자동 검색)】\n${chunks.join('\n\n')}\n---\n`;
        log('debug', '[RAG] 컨텍스트 주입', { query: ragQuery.slice(0, 50), hits: hits.length });
      }
    }
  }

  const finalSystem = (system || '당신은 대입 전문 컨설턴트입니다.') + ragContext;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const anthropic = new Anthropic({ apiKey });
    const stream = await anthropic.messages.create({
      model, max_tokens: tokens, stream: true,
      system: finalSystem,
      messages: msgArray,
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

    // 학습 이벤트 기록 (비동기)
    if (studentId) {
      try {
        db.prepare('INSERT INTO learning_analytics (id,student_id,event_type,metadata,created_at) VALUES (?,?,?,?,strftime(\'%s\',\'now\'))')
          .run(uid(), studentId, 'ai_call', JSON.stringify({ model, tokens: full.length, ragUsed: !!ragQuery }));
      } catch {}
    }
  } catch (err) {
    log('error', 'Claude API 오류', { err: err.message, reqId: req.reqId });
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// ═══════════════════════════════════════════════════════
// GRADES
// ═══════════════════════════════════════════════════════
app.get('/api/students/:studentId/grades', auth, canAccessStudent, (req, res) => {
  res.json(db.prepare('SELECT * FROM grades WHERE student_id=? ORDER BY year,semester,subject').all(req.params.studentId));
});

app.post('/api/students/:studentId/grades', auth, canAccessStudent, (req, res) => {
  const { year, semester, subject, credits, rawScore, subjectAvg, stdDev, gradeLevel, achievement, rankInClass, totalStudents, notes } = req.body;
  if (!year || !semester || !subject) return res.status(400).json({ error: '학년, 학기, 과목은 필수입니다' });
  const id = `gr_${uid()}`;
  const ts = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO grades (id,student_id,year,semester,subject,credits,raw_score,subject_avg,std_dev,grade_level,achievement,rank_in_class,total_students,notes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, req.params.studentId, year, semester, subject, credits || 2, rawScore || null, subjectAvg || null, stdDev || null, gradeLevel || null, achievement || null, rankInClass || null, totalStudents || null, notes || null, ts);
  res.json(db.prepare('SELECT * FROM grades WHERE id=?').get(id));
});

app.put('/api/grades/:id', auth, (req, res) => {
  const g = db.prepare('SELECT * FROM grades WHERE id=?').get(req.params.id);
  if (!g) return res.status(404).json({ error: '성적을 찾을 수 없습니다' });
  if (req.user.role !== 'admin' && req.user.id !== g.student_id) return res.status(403).json({ error: '권한 없음' });
  const { year, semester, subject, credits, rawScore, subjectAvg, stdDev, gradeLevel, achievement, rankInClass, totalStudents, notes } = req.body;
  db.prepare('UPDATE grades SET year=?,semester=?,subject=?,credits=?,raw_score=?,subject_avg=?,std_dev=?,grade_level=?,achievement=?,rank_in_class=?,total_students=?,notes=? WHERE id=?')
    .run(year ?? g.year, semester ?? g.semester, subject || g.subject, credits ?? g.credits, rawScore ?? g.raw_score, subjectAvg ?? g.subject_avg, stdDev ?? g.std_dev, gradeLevel ?? g.grade_level, achievement ?? g.achievement, rankInClass ?? g.rank_in_class, totalStudents ?? g.total_students, notes ?? g.notes, req.params.id);
  res.json(db.prepare('SELECT * FROM grades WHERE id=?').get(req.params.id));
});

app.delete('/api/grades/:id', auth, (req, res) => {
  const g = db.prepare('SELECT * FROM grades WHERE id=?').get(req.params.id);
  if (!g) return res.status(404).json({ error: '성적을 찾을 수 없습니다' });
  if (req.user.role !== 'admin' && req.user.id !== g.student_id) return res.status(403).json({ error: '권한 없음' });
  db.prepare('DELETE FROM grades WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════
// ANALYSIS RESULTS — 저장 시 점수 추출 + 히스토리 자동 기록
// ═══════════════════════════════════════════════════════
app.get('/api/students/:studentId/analyses', auth, canAccessStudent, (req, res) => {
  const rows = db.prepare('SELECT type,content,updated_at FROM analysis_results WHERE student_id=?').all(req.params.studentId);
  const result = {};
  rows.forEach(r => { result[r.type] = { content: r.content, updatedAt: r.updated_at * 1000 }; });
  res.json(result);
});

app.put('/api/students/:studentId/analyses/:type', auth, canAccessStudent, (req, res) => {
  try {
    const { content } = req.body;
    const { studentId, type } = req.params;
    const ts = Math.floor(Date.now() / 1000);

    // 분석 결과 저장
    db.prepare('INSERT OR REPLACE INTO analysis_results (student_id,type,content,updated_at) VALUES (?,?,?,?)')
      .run(studentId, type, content, ts);

    // 점수 추출 + score_history 기록
    const scores = extractScores(content || '');
    if (Object.keys(scores).length) {
      db.prepare('INSERT INTO score_history (id,student_id,analysis_type,scores,created_at) VALUES (?,?,?,?,?)')
        .run(uid(), studentId, type, JSON.stringify(scores), ts);
      log('debug', '[분석] 점수 추출 완료', { studentId, type, scores });

      // 추천 재생성 (비동기 처리 — 메인 응답에 영향 없음)
      try { generateRecommendations(studentId, scores, type); } catch (e) {
        log('warn', '[추천] 생성 오류', { err: e.message });
      }
    }

    // 학습 이벤트 기록
    db.prepare("INSERT INTO learning_analytics (id,student_id,event_type,metadata,created_at) VALUES (?,?,?,?,strftime('%s','now'))")
      .run(uid(), studentId, 'analysis_save', JSON.stringify({ type, hasScores: Object.keys(scores).length > 0 }));

    res.json({ success: true, scoresExtracted: Object.keys(scores).length });
  } catch (err) {
    log('error', '분석 저장 오류', { err: err.message });
    res.status(500).json({ error: '서버 오류가 발생했습니다' });
  }
});

// ═══════════════════════════════════════════════════════
// RAG — 지식베이스 관리 + 검색
// ═══════════════════════════════════════════════════════

/** KB 검색 (일반 사용자 허용 — 관련 평가 기준 참조 목적) */
app.get('/api/rag/search', auth, ragLimiter, (req, res) => {
  const { q, category, topK = 4 } = req.query;
  if (!q) return res.status(400).json({ error: '검색어(q)가 필요합니다' });

  let hits = bm25.search(String(q), parseInt(topK));

  // 카테고리 필터 (옵션)
  if (category) {
    hits = hits.filter(h => h.meta.category === category);
  }

  const results = hits.map(h => {
    const row = db.prepare('SELECT id,title,content,category,source FROM kb_chunks WHERE id=?').get(h.id);
    return row ? { ...row, score: h.score } : null;
  }).filter(Boolean);

  res.json({ query: q, results });
});

/** KB 목록 조회 (관리자 전용) */
app.get('/api/rag/kb', auth, adminOnly, (req, res) => {
  const { category } = req.query;
  const rows = category
    ? db.prepare('SELECT id,source,category,title,created_at FROM kb_chunks WHERE category=? ORDER BY category,title').all(category)
    : db.prepare('SELECT id,source,category,title,created_at FROM kb_chunks ORDER BY category,title').all();
  res.json(rows);
});

/** KB 청크 단건 조회 (관리자 전용) */
app.get('/api/rag/kb/:id', auth, adminOnly, (req, res) => {
  const row = db.prepare('SELECT * FROM kb_chunks WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '청크를 찾을 수 없습니다' });
  res.json(row);
});

/** KB 청크 추가 (관리자 전용) */
app.post('/api/rag/kb', auth, adminOnly, (req, res) => {
  try {
    const { source, category, title, content } = req.body;
    if (!source || !title || !content) return res.status(400).json({ error: 'source, title, content는 필수입니다' });
    const id = `kb_${uid()}`;
    db.prepare('INSERT INTO kb_chunks (id,source,category,title,content,created_at) VALUES (?,?,?,?,?,strftime(\'%s\',\'now\'))')
      .run(id, source, category || 'general', title, content);
    rebuildBM25();
    log('info', '[RAG] KB 청크 추가', { id, title });
    res.json({ id, success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** KB 청크 수정 (관리자 전용) */
app.put('/api/rag/kb/:id', auth, adminOnly, (req, res) => {
  const row = db.prepare('SELECT id FROM kb_chunks WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '청크를 찾을 수 없습니다' });
  const { source, category, title, content } = req.body;
  db.prepare('UPDATE kb_chunks SET source=COALESCE(?,source), category=COALESCE(?,category), title=COALESCE(?,title), content=COALESCE(?,content) WHERE id=?')
    .run(source || null, category || null, title || null, content || null, req.params.id);
  rebuildBM25();
  res.json({ success: true });
});

/** KB 청크 삭제 (관리자 전용) */
app.delete('/api/rag/kb/:id', auth, adminOnly, (req, res) => {
  db.prepare('DELETE FROM kb_chunks WHERE id=?').run(req.params.id);
  rebuildBM25();
  res.json({ success: true });
});

/** BM25 재인덱스 (관리자 전용) */
app.post('/api/rag/reindex', auth, adminOnly, (req, res) => {
  rebuildBM25();
  res.json({ success: true, chunks: bm25.corpus.length });
});

// ═══════════════════════════════════════════════════════
// SCORE HISTORY (역량 점수 이력)
// ═══════════════════════════════════════════════════════
app.get('/api/students/:studentId/score-history', auth, canAccessStudent, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const rows = db.prepare('SELECT * FROM score_history WHERE student_id=? ORDER BY created_at DESC LIMIT ?')
    .all(req.params.studentId, limit);
  res.json(rows.map(r => ({
    ...r,
    scores:    JSON.parse(r.scores || '{}'),
    createdAt: r.created_at * 1000,
  })));
});

/** 최근 역량 점수 요약 (최신 academic/career/community 결과 기반) */
app.get('/api/students/:studentId/score-summary', auth, canAccessStudent, (req, res) => {
  const types = ['academic', 'career', 'community', 'dashboard'];
  const summary = {};
  for (const t of types) {
    const row = db.prepare('SELECT scores,created_at FROM score_history WHERE student_id=? AND analysis_type=? ORDER BY created_at DESC LIMIT 1')
      .get(req.params.studentId, t);
    if (row) {
      summary[t] = {
        scores:    JSON.parse(row.scores),
        updatedAt: row.created_at * 1000,
      };
    }
  }
  res.json(summary);
});

// ═══════════════════════════════════════════════════════
// LEARNING ANALYTICS
// ═══════════════════════════════════════════════════════
app.get('/api/students/:studentId/analytics', auth, canAccessStudent, (req, res) => {
  const sid = req.params.studentId;

  // 이벤트 집계
  const eventCounts = db.prepare(`
    SELECT event_type, COUNT(*) AS cnt
    FROM learning_analytics WHERE student_id=?
    GROUP BY event_type
  `).all(sid);

  // 역량 점수 최신값
  const latestScores = {};
  ['academic','career','community'].forEach(t => {
    const row = db.prepare('SELECT scores FROM score_history WHERE student_id=? AND analysis_type=? ORDER BY created_at DESC LIMIT 1').get(sid, t);
    if (row) latestScores[t] = JSON.parse(row.scores);
  });

  // 점수 추이 (최근 10회 academic)
  const scoreTrend = db.prepare(`
    SELECT analysis_type, scores, created_at
    FROM score_history WHERE student_id=?
    ORDER BY created_at DESC LIMIT 10
  `).all(sid).map(r => ({
    type:      r.analysis_type,
    scores:    JSON.parse(r.scores),
    createdAt: r.created_at * 1000,
  }));

  // 미완료 수행평가 수
  const pendingExams = db.prepare("SELECT COUNT(*) AS n FROM exams WHERE student_id=? AND status != '완료'").get(sid)?.n || 0;

  // 미답변 피드백 수
  const pendingFbs = db.prepare("SELECT COUNT(*) AS n FROM report_feedbacks WHERE student_id=? AND status='요청중'").get(sid)?.n || 0;

  // 분석 완료 섹션 수
  const analysisDone = db.prepare("SELECT COUNT(*) AS n FROM analysis_results WHERE student_id=?").get(sid)?.n || 0;

  res.json({
    eventCounts: Object.fromEntries(eventCounts.map(e => [e.event_type, e.cnt])),
    latestScores,
    scoreTrend,
    summary: { pendingExams, pendingFbs, analysisDone },
  });
});

// ═══════════════════════════════════════════════════════
// RECOMMENDATIONS
// ═══════════════════════════════════════════════════════
app.get('/api/students/:studentId/recommendations', auth, canAccessStudent, (req, res) => {
  const { unreadOnly } = req.query;
  const rows = unreadOnly === '1'
    ? db.prepare('SELECT * FROM recommendations WHERE student_id=? AND is_read=0 ORDER BY priority DESC, created_at DESC').all(req.params.studentId)
    : db.prepare('SELECT * FROM recommendations WHERE student_id=? ORDER BY priority DESC, is_read, created_at DESC LIMIT 20').all(req.params.studentId);
  res.json(rows.map(r => ({ ...r, createdAt: r.created_at * 1000 })));
});

/** 추천 읽음 표시 */
app.put('/api/recommendations/:id/read', auth, (req, res) => {
  db.prepare('UPDATE recommendations SET is_read=1 WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

/** 추천 전체 읽음 (학생 전체) */
app.put('/api/students/:studentId/recommendations/read-all', auth, canAccessStudent, (req, res) => {
  db.prepare('UPDATE recommendations SET is_read=1 WHERE student_id=?').run(req.params.studentId);
  res.json({ success: true });
});

/** 수동 추천 추가 (컨설턴트·관리자) */
app.post('/api/students/:studentId/recommendations', auth, adminOrConsultant, canAccessStudent, (req, res) => {
  const { category, priority, title, content } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'title과 content는 필수입니다' });
  const id = uid();
  const ts = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO recommendations (id,student_id,category,priority,title,content,source,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req.params.studentId, category || '일반', parseInt(priority) || 5, title, content, `manual:${req.user.name}`, ts);
  res.json({ id, success: true });
});

// ═══════════════════════════════════════════════════════
// GLOBAL ERROR HANDLER
// ═══════════════════════════════════════════════════════
app.use((err, req, res, _next) => {
  log('error', '미처리 예외', { err: err.message, path: req.path, reqId: req.reqId });
  const status = err.status || 500;
  res.status(status).json({ error: err.message || '서버 오류가 발생했습니다' });
});

// ── SPA 폴백 (편입 LMS 라우트 등록 후 맨 마지막에 위치해야 함 → server.js 하단으로 이동됨) ──

// ═══════════════════════════════════════════════════════════════════════
// ██████╗ ██╗ ██████╗ ██╗     ██╗███╗   ██╗██╗  ██╗███████╗██████╗
// ██╔══██╗██║██╔════╝ ██║     ██║████╗  ██║██║ ██╔╝██╔════╝██╔══██╗
// ██████╔╝██║██║  ███╗██║     ██║██╔██╗ ██║█████╔╝ █████╗  ██████╔╝
// ██╔══██╗██║██║   ██║██║     ██║██║╚██╗██║██╔═██╗ ██╔══╝  ██╔══██╗
// ██████╔╝██║╚██████╔╝███████╗██║██║ ╚████║██║  ██╗███████╗██║  ██║
// ╚═════╝ ╚═╝ ╚═════╝ ╚══════╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
//  편입 하이브리드 LMS — 온오프라인 통합 플랫폼
// ═══════════════════════════════════════════════════════════════════════

// ── 편입 LMS DB 스키마 ─────────────────────────────────────────────
db.exec(`
  /* 편입 LMS 사용자 (기존 coaching users 와 분리) */
  CREATE TABLE IF NOT EXISTS tl_users (
    id           TEXT PRIMARY KEY,
    username     TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role         TEXT NOT NULL CHECK(role IN ('admin','instructor','student')),
    name         TEXT NOT NULL,
    email        TEXT,
    phone        TEXT,
    class_level  TEXT DEFAULT 'unassigned' CHECK(class_level IN ('A','B','C','unassigned')),
    instructor_id TEXT REFERENCES tl_users(id),
    memo         TEXT,
    created_at   INTEGER DEFAULT (strftime('%s','now'))
  );

  /* 일일 라이브 강의 스케줄 (오전 1~3교시) */
  CREATE TABLE IF NOT EXISTS tl_schedule (
    id           TEXT PRIMARY KEY,
    class_date   TEXT NOT NULL,
    period       INTEGER NOT NULL CHECK(period IN (1,2,3)),
    subject      TEXT NOT NULL,
    instructor_id TEXT REFERENCES tl_users(id),
    zoom_url     TEXT,
    class_level  TEXT DEFAULT 'ALL',
    start_time   TEXT DEFAULT '09:00',
    end_time     TEXT DEFAULT '10:00',
    created_at   INTEGER DEFAULT (strftime('%s','now')),
    UNIQUE(class_date, period)
  );

  /* 녹화본 링크 (강사가 수업 후 등록) */
  CREATE TABLE IF NOT EXISTS tl_recordings (
    id           TEXT PRIMARY KEY,
    class_date   TEXT NOT NULL,
    period       INTEGER NOT NULL CHECK(period IN (1,2,3)),
    subject      TEXT NOT NULL,
    instructor_id TEXT NOT NULL REFERENCES tl_users(id),
    zoom_url     TEXT NOT NULL,
    description  TEXT,
    class_level  TEXT DEFAULT 'ALL',
    views        INTEGER DEFAULT 0,
    created_at   INTEGER DEFAULT (strftime('%s','now'))
  );

  /* 출석 관리 */
  CREATE TABLE IF NOT EXISTS tl_attendance (
    id           TEXT PRIMARY KEY,
    schedule_id  TEXT NOT NULL REFERENCES tl_schedule(id),
    student_id   TEXT NOT NULL REFERENCES tl_users(id),
    status       TEXT NOT NULL DEFAULT 'present' CHECK(status IN ('present','absent','late')),
    note         TEXT,
    marked_by    TEXT REFERENCES tl_users(id),
    marked_at    INTEGER DEFAULT (strftime('%s','now')),
    UNIQUE(schedule_id, student_id)
  );

  /* 레벨테스트 문제은행 */
  CREATE TABLE IF NOT EXISTS tl_level_questions (
    id             TEXT PRIMARY KEY,
    section        TEXT NOT NULL CHECK(section IN ('어휘','문법','독해','논리')),
    question_text  TEXT NOT NULL,
    passage        TEXT,
    option_a       TEXT NOT NULL,
    option_b       TEXT NOT NULL,
    option_c       TEXT NOT NULL,
    option_d       TEXT NOT NULL,
    correct_answer TEXT NOT NULL CHECK(correct_answer IN ('A','B','C','D')),
    explanation    TEXT,
    difficulty     INTEGER DEFAULT 2 CHECK(difficulty IN (1,2,3)),
    created_at     INTEGER DEFAULT (strftime('%s','now'))
  );

  /* 레벨테스트 결과 */
  CREATE TABLE IF NOT EXISTS tl_level_results (
    id              TEXT PRIMARY KEY,
    student_id      TEXT,
    student_name    TEXT,
    total_score     INTEGER NOT NULL,
    total_questions INTEGER NOT NULL,
    section_scores  TEXT NOT NULL,
    assigned_class  TEXT NOT NULL CHECK(assigned_class IN ('A','B','C')),
    answers         TEXT NOT NULL,
    completed_at    INTEGER DEFAULT (strftime('%s','now'))
  );

  /* 섹션별·학교별 테스트 문제은행 */
  CREATE TABLE IF NOT EXISTS tl_test_questions (
    id              TEXT PRIMARY KEY,
    section         TEXT NOT NULL CHECK(section IN ('어휘','문법','독해','논리')),
    university_type TEXT DEFAULT 'COMMON' CHECK(university_type IN ('SKY','SEOUL','COMMON')),
    question_text   TEXT NOT NULL,
    passage         TEXT,
    option_a        TEXT NOT NULL,
    option_b        TEXT NOT NULL,
    option_c        TEXT NOT NULL,
    option_d        TEXT NOT NULL,
    correct_answer  TEXT NOT NULL CHECK(correct_answer IN ('A','B','C','D')),
    explanation     TEXT,
    difficulty      INTEGER DEFAULT 2 CHECK(difficulty IN (1,2,3)),
    tags            TEXT,
    created_at      INTEGER DEFAULT (strftime('%s','now'))
  );

  /* 단어 테스트 단어장 */
  CREATE TABLE IF NOT EXISTS tl_vocab (
    id         TEXT PRIMARY KEY,
    word       TEXT NOT NULL,
    meaning    TEXT NOT NULL,
    example    TEXT,
    difficulty INTEGER DEFAULT 2 CHECK(difficulty IN (1,2,3)),
    category   TEXT DEFAULT 'GENERAL',
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  /* 테스트 세션 (학생이 치르는 테스트 기록) */
  CREATE TABLE IF NOT EXISTS tl_test_sessions (
    id              TEXT PRIMARY KEY,
    student_id      TEXT NOT NULL REFERENCES tl_users(id),
    session_type    TEXT NOT NULL CHECK(session_type IN ('vocab','grammar','reading','logic','mixed','university')),
    university_type TEXT DEFAULT 'COMMON',
    questions       TEXT NOT NULL,
    answers         TEXT,
    score           INTEGER,
    total           INTEGER,
    section_scores  TEXT,
    completed_at    INTEGER,
    created_at      INTEGER DEFAULT (strftime('%s','now'))
  );

  /* 인덱스 */
  CREATE INDEX IF NOT EXISTS idx_tl_sched_date  ON tl_schedule(class_date);
  CREATE INDEX IF NOT EXISTS idx_tl_rec_date    ON tl_recordings(class_date);
  CREATE INDEX IF NOT EXISTS idx_tl_sess_stu    ON tl_test_sessions(student_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_tl_att_student ON tl_attendance(student_id, marked_at DESC);
  CREATE INDEX IF NOT EXISTS idx_tl_att_sched   ON tl_attendance(schedule_id);
`);

// ── 스키마 마이그레이션 (기존 배포 DB에 컬럼 추가) ─────────────────
try { db.exec('ALTER TABLE tl_test_sessions ADD COLUMN question_results TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE tl_test_sessions ADD COLUMN display_type TEXT');     } catch(e) {}

// ── 편입 LMS 시드 데이터 ───────────────────────────────────────────
function seedTransferLMS() {
  const adminExists = db.prepare("SELECT id FROM tl_users WHERE role='admin' LIMIT 1").get();
  if (adminExists) return;

  const h = s => bcrypt.hashSync(s, 10);

  // 관리자
  db.prepare(`INSERT OR IGNORE INTO tl_users (id,username,password_hash,role,name) VALUES (?,?,?,?,?)`)
    .run('tl_adm1','transfer_admin', h('admin1234'),'admin','편입관리자');

  // 강사 2명
  db.prepare(`INSERT OR IGNORE INTO tl_users (id,username,password_hash,role,name,email) VALUES (?,?,?,?,?,?)`)
    .run('tl_ins1','instructor01', h('1234'),'instructor','김영어','kim@biglinker.kr');
  db.prepare(`INSERT OR IGNORE INTO tl_users (id,username,password_hash,role,name,email) VALUES (?,?,?,?,?,?)`)
    .run('tl_ins2','instructor02', h('1234'),'instructor','박논리','park@biglinker.kr');

  // 학생 6명 (A/B/C 각 2명)
  [
    ['tl_st1','s_choi','최민준','A','tl_ins1'],
    ['tl_st2','s_park','박서연','A','tl_ins1'],
    ['tl_st3','s_kim','김지호','B','tl_ins2'],
    ['tl_st4','s_lee','이다은','B','tl_ins2'],
    ['tl_st5','s_jung','정현우','C','tl_ins1'],
    ['tl_st6','s_han','한수진','C','tl_ins2'],
  ].forEach(([id,un,nm,cl,ins]) => {
    db.prepare(`INSERT OR IGNORE INTO tl_users (id,username,password_hash,role,name,class_level,instructor_id) VALUES (?,?,?,?,?,?,?)`)
      .run(id, un, h('1234'), 'student', nm, cl, ins);
  });

  // 오늘 스케줄
  const today = new Date().toISOString().slice(0,10);
  [
    [1,'영어 어휘·독해','tl_ins1','https://zoom.us/j/demo1','09:00','10:30'],
    [2,'문법·작문','tl_ins2','https://zoom.us/j/demo2','10:40','12:10'],
    [3,'논리·추론','tl_ins1','https://zoom.us/j/demo3','13:10','14:40'],
  ].forEach(([p,subj,ins,url,st,et]) => {
    db.prepare(`INSERT OR IGNORE INTO tl_schedule (id,class_date,period,subject,instructor_id,zoom_url,start_time,end_time)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(`sch_${today}_${p}`, today, p, subj, ins, url, st, et);
  });

  log('info', '[Transfer LMS] 시드 데이터 생성 완료');
}

function seedTransferQuestions() {
  // 기존 시드 ID 강제 교체 (영어 문제로 전환)
  const seedLvlIds = Array.from({length:40},(_,i)=>`lq${String(i+1).padStart(2,'0')}`);
  const seedTqIds  = Array.from({length:50},(_,i)=>`tq${String(i+1).padStart(2,'0')}`);
  const phL = seedLvlIds.map(()=>'?').join(',');
  const phT = seedTqIds.map(()=>'?').join(',');
  db.prepare(`DELETE FROM tl_level_questions WHERE id IN (${phL})`).run(...seedLvlIds);
  db.prepare(`DELETE FROM tl_test_questions  WHERE id IN (${phT})`).run(...seedTqIds);

  const lvlQ = db.prepare(`INSERT OR IGNORE INTO tl_level_questions
    (id,section,question_text,passage,option_a,option_b,option_c,option_d,correct_answer,explanation,difficulty)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

  const testQ = db.prepare(`INSERT OR IGNORE INTO tl_test_questions
    (id,section,university_type,question_text,passage,option_a,option_b,option_c,option_d,correct_answer,explanation,difficulty,tags)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const vocab = db.prepare(`INSERT OR IGNORE INTO tl_vocab
    (id,word,meaning,example,difficulty,category) VALUES (?,?,?,?,?,?)`);

  // ── 레벨테스트 문제 (40개) ────────────────────────
  const levelQuestions = [
    // 어휘 10문제
    ['lq01','어휘','밑줄 친 단어와 의미가 가장 가까운 것은?\n"The scientist\'s hypothesis was subsequently corroborated by extensive research."',null,'refuted','confirmed','questioned','proposed','B','corroborate = 확인하다, 뒷받침하다',2],
    ['lq02','어휘','Choose the word closest in meaning to the underlined word.\n"The politician\'s ambiguous statement left voters perplexed."',null,'clear','vague','forceful','decisive','B','ambiguous = unclear, vague (모호한)',1],
    ['lq03','어휘','다음 빈칸에 들어갈 가장 적절한 단어는?\n"The new policy was designed to _____ economic inequality."',null,'exacerbate','ameliorate','perpetuate','ignore','B','ameliorate = 개선하다, 완화하다',3],
    ['lq04','어휘','밑줄 친 단어와 반의어는?\n"The CEO made an impulsive decision without consulting the board."',null,'hasty','reckless','deliberate','spontaneous','C','impulsive의 반의어는 deliberate(신중한)',2],
    ['lq05','어휘','다음 문맥에서 "inveterate"의 의미로 가장 적절한 것은?\n"He was an inveterate gambler who could not stop despite losing everything."',null,'occasional','habitual','reluctant','amateur','B','inveterate = 뿌리 깊은, 습관적인',3],
    ['lq06','어휘','빈칸에 알맞은 단어는?\n"The two countries signed a _____ agreement to promote trade."',null,'bilateral','unilateral','multilateral','neutral','A','bilateral = 양자간의 (two parties)',2],
    ['lq07','어휘','What does the underlined expression mean?\n"The company decided to cut corners to meet the deadline."',null,'to work carefully and thoroughly','to take a physical shortcut','to reduce quality or skip steps','to save time by working faster','C','cut corners = to do something poorly to save time or money',2],
    ['lq08','어휘',"다음 중 'pragmatic'과 가장 유사한 의미의 단어는?",null,'idealistic','practical','theoretical','philosophical','B','pragmatic = 실용적인',1],
    ['lq09','어휘','빈칸에 가장 적절한 단어는?\n"The court found the evidence _____, so the case was dismissed."',null,'conclusive','inadmissible','compelling','relevant','B','inadmissible = 허용되지 않는 (법정 증거)',3],
    ['lq10','어휘','밑줄 친 단어의 의미는?\n"Her laconic response surprised everyone at the meeting."',null,'lengthy','enthusiastic','brief','confusing','C','laconic = 간결한, 말수가 적은',2],
    // 문법 10문제
    ['lq11','문법','다음 중 어법상 올바른 문장은?',null,
      'Neither the students nor the teacher were prepared.',
      'Neither the students nor the teacher was prepared.',
      'Neither the students nor the teacher are prepared.',
      'Neither the students nor the teacher is prepared.','B',
      'neither A nor B에서 동사는 B(teacher)에 일치 → was',2],
    ['lq12','문법','다음 빈칸에 알맞은 것은?\n"By the time she arrived, the meeting _____."',null,
      'already ended','had already ended','has already ended','already ending','B',
      '과거 완료: By the time + 과거 → had p.p.',1],
    ['lq13','문법','어법상 틀린 부분은?\n"The data ① shows ② that ③ more than half of students ④ struggles with time management."',null,'①','②','③','④','D',
      'students는 복수 → struggles → struggle',1],
    ['lq14','문법','빈칸에 알맞은 것은?\n"I wish I _____ more time to study last year."',null,'have had','had had','would have','had','B',
      'wish + 가정법 과거완료 → had had',2],
    ['lq15','문법','다음 중 어법상 올바른 것은?',null,
      'Interesting in science, the lab was visited by the student.',
      'Interested in science, the student visited the lab.',
      'Being interest in science, the student visited the lab.',
      'The student, interesting in science, visited the lab.','B',
      '분사구문의 의미상 주어는 주절 주어와 일치해야 함',2],
    ['lq16','문법','빈칸에 알맞은 것은?\n"It is essential that every employee _____ the new protocol."',null,'follows','follow','followed','following','B',
      'It is essential that + 동사원형 (should 생략 가정법)',3],
    ['lq17','문법','어법상 올바른 문장은?',null,
      'The number of applicants have increased significantly.',
      'A number of applicants has increased significantly.',
      'The number of applicants has increased significantly.',
      'A number of applicants have increases significantly.','C',
      'the number of = 단수, a number of = 복수',2],
    ['lq18','문법','빈칸에 알맞은 접속사는?\n"_____ he studied hard, he failed the exam."',null,'Despite','Although','Because','Therefore','B',
      'although = 비록 ~이지만 (역접 부사절 접속사)',1],
    ['lq19','문법','밑줄 친 부분 중 어법상 틀린 것은?\n"She suggested ① that he ② should take ③ the opportunity ④ serious."',null,'①','②','③','④','D',
      'take + 목적어 + 부사: seriously',2],
    ['lq20','문법','다음 중 어법상 올바른 것은?',null,
      'Having finished his work, the office was left by him.',
      'Having finished his work, he left the office.',
      'His work having finished, he left the office.',
      'Finishing his work, the office was left.','B',
      '분사구문 주어 = 주절 주어(he)',2],
    // 독해 10문제
    ['lq21','독해',`다음 글의 주제로 가장 적절한 것은?
"Neuroplasticity refers to the brain's ability to reorganize itself by forming new neural connections. This process occurs throughout life, though it is most active during childhood. Research suggests that engaging in mentally stimulating activities can enhance neuroplasticity, potentially delaying cognitive decline associated with aging."`,null,
      '아동기 두뇌 발달의 중요성',
      '신경가소성의 개념과 인지 건강에 미치는 영향',
      '노화에 따른 인지 능력 감소',
      '정신적 자극 활동의 종류','B','neuroplasticity와 cognitive health의 관계 설명',2],
    ['lq22','독해',`다음 글의 빈칸에 들어갈 가장 적절한 것은?
"The discovery of antibiotics in the 20th century revolutionized medicine. However, the overuse and misuse of these drugs has led to the emergence of antibiotic-resistant bacteria. This phenomenon, known as antimicrobial resistance, poses a _____ threat to global public health."`,null,
      'minimal','temporary','significant','theoretical','C','항생제 내성이 공중보건에 미치는 심각한 위협 강조',2],
    ['lq23','독해',`글의 흐름상 빈칸에 가장 적절한 연결어는?
"The company invested heavily in research and development. _____, it failed to commercialize its innovations effectively."`,null,
      'Therefore','Nevertheless','Furthermore','Similarly','B','역접 관계: 투자했음에도 상업화 실패',1],
    ['lq24','독해',`다음 글의 내용과 일치하지 않는 것은?
"The Mediterranean diet, characterized by high consumption of vegetables, fruits, whole grains, and olive oil, has been associated with numerous health benefits. Studies show it reduces the risk of cardiovascular disease by up to 30%. Unlike many restrictive diets, it emphasizes balance rather than elimination."`,null,
      '지중해식 식단은 채소와 과일을 많이 포함한다.',
      '심혈관 질환 위험을 최대 30%까지 줄인다.',
      '엄격한 음식 제한을 강조한다.',
      '올리브 오일이 주요 성분이다.','C','지중해식 식단은 elimination이 아닌 balance를 강조',2],
    ['lq25','독해',`다음 글의 목적으로 가장 적절한 것은?
"We are writing to inform you that your subscription will expire on June 30th. To continue enjoying uninterrupted access to all premium features, please renew your subscription before the expiration date. Early renewal comes with a 15% discount."`,null,
      '새 서비스 출시 안내','구독 갱신 요청 및 할인 혜택 안내','개인정보 정책 변경 통보','기술 지원 요청','B','구독 만료 알림 + 갱신 유도 + 할인 안내',1],
    ['lq26','독해',`글에서 필자의 주장으로 가장 적절한 것은?
"While artificial intelligence offers tremendous potential, we must approach its development with caution. The rapid advancement of AI without adequate ethical frameworks could lead to unforeseen consequences. Therefore, governments, companies, and researchers must collaborate to establish clear guidelines before proceeding further."`,null,
      'AI 개발을 전면 중단해야 한다.',
      'AI는 인간을 대체할 것이다.',
      'AI 발전에는 윤리적 프레임워크와 협력이 선행되어야 한다.',
      '정부가 AI를 독점적으로 관리해야 한다.','C','필자는 cautious approach + ethical framework + collaboration 주장',3],
    ['lq27','독해',`다음 글의 제목으로 가장 적절한 것은?
"Urban green spaces, such as parks and gardens, provide more than aesthetic pleasure. They act as carbon sinks, absorbing CO2 from the atmosphere. They also reduce the urban heat island effect and improve mental well-being among city residents. Investment in green infrastructure is therefore both an environmental and public health priority."`,null,
      'The Aesthetic Value of City Parks',
      'Urban Green Spaces: Environmental and Health Benefits',
      'Climate Change and Carbon Emissions',
      'Mental Health Challenges in Urban Areas','B','도시 녹지의 환경적·건강적 혜택 전반 설명',2],
    ['lq28','독해',`다음 글을 읽고 筆者가 가장 강조하는 것은?
"Education is not merely the transmission of knowledge; it is the cultivation of critical thinking. Students who learn to question assumptions, evaluate evidence, and construct logical arguments are better prepared for the complexities of modern society than those who simply memorize facts."`,null,
      '지식 암기의 중요성','비판적 사고 교육의 필요성','교사의 역할 강화','현대 사회의 복잡성',
      'B','필자는 critical thinking > knowledge transmission 강조',2],
    ['lq29','독해',`빈칸에 가장 적절한 것은?
"Economists distinguish between needs and wants. Needs are essential for survival, while wants are _____ but not necessary. Understanding this distinction is fundamental to personal financial management."`,null,
      'harmful','desirable','obligatory','irrelevant','B','wants = desirable(바람직하지만 필수가 아닌)',1],
    ['lq30','독해',`다음 문단에서 전체 흐름과 관계없는 문장은?
"① Renewable energy sources are becoming increasingly cost-competitive. ② Solar panel prices have dropped by over 90% in the past decade. ③ Coal remains an important source of energy in developing countries. ④ Wind energy capacity has expanded dramatically worldwide."`,null,'①','②','③','④','C',
      '③은 재생에너지의 발전 맥락에서 벗어난 문장',3],
    // 논리 10문제 — 영어 지문 기반 편입 영어 논리
    ['lq31','논리','다음 빈칸에 들어갈 가장 적절한 연결어는?',
      'The human brain contains approximately 86 billion neurons. _____, these neurons form trillions of connections called synapses, which enable the transmission of information throughout the nervous system.',
      'In contrast','Moreover','Therefore','Nevertheless','B','앞 문장에 추가 정보를 더하므로 Moreover(게다가)',1],
    ['lq32','논리','다음 글에서 전체 흐름과 관계없는 문장은?',
      '① The Internet of Things (IoT) refers to a network of physical devices connected to the internet. ② These devices collect and share data, enabling smarter decisions in homes and cities. ③ Quantum computing is expected to revolutionize cryptography and drug discovery. ④ Smart thermostats and wearable health monitors are common examples of IoT devices.',
      '①','②','③','④','C','③은 양자 컴퓨팅에 관한 내용으로 IoT 주제와 무관',2],
    ['lq33','논리','주어진 세 문장을 논리적 순서에 맞게 배열한 것은?',
      '(A) However, recent studies suggest that moderate coffee consumption may offer health benefits including reduced risk of type 2 diabetes.\n(B) For many years, health experts warned against excessive coffee drinking due to its high caffeine content.\n(C) These findings have prompted researchers to revisit conventional dietary guidelines.',
      '(A)-(B)-(C)','(B)-(A)-(C)','(C)-(B)-(A)','(B)-(C)-(A)','B','B(기존 경고) → A(역접: 최근 연구 결과) → C(결론: 가이드라인 재검토)',2],
    ['lq34','논리','다음 글의 빈칸에 들어갈 가장 적절한 것은?',
      'Procrastination is often misunderstood as laziness, but research reveals it is primarily an emotional regulation problem. People avoid tasks not because they are lazy, but because _____.',
      'they lack the necessary skills to complete them',
      'the tasks trigger negative emotions such as anxiety or self-doubt',
      'they prefer to work under pressure and tight deadlines',
      'the rewards for completing the tasks are insufficient','B','procrastination = emotional regulation problem → 부정적 감정 회피',2],
    ['lq35','논리','다음 주장을 약화시키는 것으로 가장 적절한 것은?\n주장: "Online education is more effective than traditional classroom learning because students can learn at their own pace."',null,
      'Online courses offer a wider variety of subjects than most universities.',
      'Online learning platforms are available 24 hours a day.',
      'Research shows that online courses have significantly lower completion rates than in-person courses.',
      'Students in remote areas benefit greatly from online education.','C','완료율이 낮다는 것은 효과성 주장을 직접 약화시킴',3],
    ['lq36','논리','다음 글의 내용을 한 문장으로 요약할 때 빈칸에 가장 적절한 것은?',
      'Bees play a critical role in pollinating crops that humans depend on for food. Without bees, the production of many fruits, vegetables, and nuts would decline sharply. Unfortunately, bee populations have been falling due to pesticide use, habitat loss, and climate change.\n\n요약: The decline of bee populations poses a serious threat to _____ and demands urgent action.',
      'biodiversity in tropical rainforests',
      'global food security',
      'the commercial honey industry',
      'climate change research','B','꿀벌 감소 → 수분 작용 감소 → 식량 안보 위협',2],
    ['lq37','논리','다음 주장을 강화하는 것으로 가장 적절한 것은?\n주장: "Regular physical exercise improves mental health by reducing symptoms of depression and anxiety."',null,
      'Exercise equipment sales have increased significantly in recent years.',
      'A longitudinal study of 10,000 participants found that regular exercisers reported 40% lower rates of clinical depression.',
      'Many people find it difficult to maintain a consistent exercise routine.',
      'Mental health treatment typically involves both therapy and medication.','B','직접적인 경험 증거가 주장을 가장 강력하게 지지',3],
    ['lq38','논리','다음 글에서 필자의 주장으로 가장 적절한 것은?',
      'Despite widespread belief that multitasking enhances productivity, cognitive science research consistently demonstrates the opposite. The human brain cannot truly process multiple complex tasks simultaneously; instead, it rapidly switches between tasks, increasing both the time required and the number of errors. Organizations that encourage multitasking may therefore be inadvertently reducing their overall efficiency.',
      'Multitasking skills can be improved through focused training.',
      'Organizations should redesign workplaces to eliminate distraction.',
      'Multitasking actually decreases rather than increases productivity.',
      'Cognitive science has many useful applications in business management.','C','필자의 핵심 주장: 멀티태스킹 = 생산성 저하',2],
    ['lq39','논리','다음 글에서 추론할 수 있는 것으로 가장 적절한 것은?',
      'The Turing Test, proposed by Alan Turing in 1950, measures a machine\'s ability to exhibit intelligent behavior indistinguishable from a human. While some chatbots have reportedly passed versions of this test, critics argue that passing it does not indicate genuine intelligence—only the appearance of it.',
      'Alan Turing believed machines would eventually surpass human intelligence.',
      'All modern AI systems have successfully passed the original Turing Test.',
      'There is ongoing debate over whether passing the Turing Test constitutes true intelligence.',
      'The Turing Test is now universally regarded as an outdated benchmark.','C','critics argue → debate exists → C 추론 가능',2],
    ['lq40','논리','다음 글의 빈칸에 들어갈 가장 적절한 것은?',
      'Economic inequality has been rising in most developed countries. While some economists argue this is an inevitable consequence of technological progress, others contend that policy choices—such as tax structures and labor regulations—play a decisive role. The debate centers on whether rising inequality is _____ or a correctable outcome of deliberate policy decisions.',
      'a natural and unavoidable law of free markets',
      'a temporary phenomenon that will eventually self-correct',
      'a direct result of individual moral failings',
      'a sign of healthy economic competition and innovation','A','빈칸 뒤 or와 대조: 교정 가능한 정책 결과 vs. 불가피한 자연법칙',3],
  ];

  levelQuestions.forEach(q => lvlQ.run(...q));

  // ── 섹션별 일반 테스트 문제 (각 섹션 15문제씩 = 60문제) ──
  const sectionQ = [
    // 어휘 — COMMON
    ['tq01','어휘','COMMON','"Ubiquitous" means:',null,'rare','everywhere','ancient','complex','B','ubiquitous = 어디에나 있는, 편재하는',1,'동의어·유의어'],
    ['tq02','어휘','COMMON','다음 빈칸에 알맞은 단어: "The treaty was meant to _____ tensions between the two nations."',null,'exacerbate','alleviate','intensify','provoke','B','alleviate = 완화하다, 경감하다',2,'빈칸·문맥추론'],
    ['tq03','어휘','COMMON','"Ephemeral"과 반의어 관계인 것은?',null,'transient','fleeting','permanent','momentary','C','ephemeral = 단명하는 ↔ permanent',2,'반의어'],
    ['tq04','어휘','SEOUL','"The professor gave an _____ lecture that covered too many topics without depth."',null,'profound','cursory','exhaustive','meticulous','B','cursory = 피상적인, 대충 훑어보는',3,'빈칸·문맥추론'],
    ['tq05','어휘','SKY','"The diplomat\'s _____ remarks helped defuse the international crisis."',null,'provocative','incendiary','conciliatory','belligerent','C','conciliatory = 화해적인, 달래는',3,'동의어·유의어'],
    ['tq06','어휘','COMMON','문맥상 "benign"의 의미로 적절한 것은?\n"The doctor assured the patient that the tumor was benign."',null,'malignant','dangerous','harmless','aggressive','C','benign = (의학) 양성의, 무해한',1,'빈칸·문맥추론'],
    ['tq07','어휘','COMMON','"Manifest" as a verb means:',null,'to hide','to show clearly','to deny','to question','B','manifest = 명백히 드러내다',2,'어휘정의'],
    ['tq08','어휘','SEOUL','빈칸에 알맞은 단어: "The CEO\'s _____ leadership style alienated many employees."',null,'inclusive','autocratic','collaborative','empathetic','B','autocratic = 독재적인, 권위적인',3,'빈칸·문맥추론'],
    ['tq09','어휘','COMMON','"Diligent"과 유사한 의미의 단어는?',null,'lazy','careless','industrious','impulsive','C','diligent = industrious = 부지런한',1,'동의어·유의어'],
    ['tq10','어휘','SKY','"The scholar\'s _____ critique challenged long-held assumptions in the field."',null,'superficial','cursory','incisive','perfunctory','C','incisive = 날카로운, 예리한',3,'동의어·유의어'],
    // 문법 — COMMON/SEOUL/SKY
    ['tq11','문법','COMMON','빈칸에 알맞은 것: "She _____ in Paris for three years before moving to London."',null,'lived','has lived','had lived','was living','C','for + 기간 + before 과거 → 과거완료',2,'시제·완료'],
    ['tq12','문법','COMMON','어법상 올바른 문장은?',null,
      'The committee have reached its decision.',
      'The committee has reached their decision.',
      'The committee has reached its decision.',
      'The committee have reached their decisions.','C','committee는 단수 집합명사(미국식) → has/its',2,'수일치·명사'],
    ['tq13','문법','COMMON','빈칸에 알맞은 것: "_____ difficult the problem may be, we must find a solution."',null,'However','Whatever','Wherever','Whenever','A','however + 형용사 = 아무리 ~해도',2,'전치사·접속사'],
    ['tq14','문법','SEOUL','틀린 부분을 찾으시오:\n"The report that was ① submitted ② by the researchers ③ contains ④ important informations."',null,'①','②','③','④','D','information = 불가산명사, informations 불가',2,'수일치·명사'],
    ['tq15','문법','SKY','빈칸에 알맞은 것:\n"Not until the 20th century _____ the full extent of the damage realized."',null,'was','did','had','were','A','부정어 도치: Not until ~ was + 주어',3,'가정법·도치'],
    ['tq16','문법','COMMON','올바른 문장은?',null,
      'I look forward to meet you.',
      'I look forward to meeting you.',
      'I look forward to have met you.',
      'I look forward meeting you.','B','look forward to + V-ing',1,'분사·관계사'],
    ['tq17','문법','COMMON','빈칸에 알맞은 관계대명사:\n"The author _____ book won the prize gave a speech."',null,'who','whom','whose','which','C','선행사 + whose + 명사 = 소유격 관계대명사',2,'분사·관계사'],
    ['tq18','문법','SEOUL','어법상 옳은 것은?',null,
      'If I were you, I will accept the offer.',
      'If I were you, I would accept the offer.',
      'If I am you, I would accept the offer.',
      'If I was you, I will accept the offer.','B','가정법 과거: If + were, would + 원형',2,'가정법·도치'],
    ['tq19','문법','SKY','빈칸에 알맞은 것:\n"The policy, along with several amendments, _____ approved yesterday."',null,'were','have been','was','are','C','주어 = The policy (단수) → was',3,'수일치·명사'],
    ['tq20','문법','COMMON','어법상 올바른 것은?',null,
      'Despite of the rain, they continued playing.',
      'Despite the rain, they continued playing.',
      'Although the rain, they continued playing.',
      'Even the rain, they continued playing.','B','despite + 명사구 (despite of X)',2,'전치사·접속사'],
    // 독해 — COMMON
    ['tq21','독해','COMMON',`다음 글의 요지는?
"The placebo effect demonstrates the power of the mind over the body. When patients believe they are receiving effective treatment—even if it is an inert substance—they often experience real physiological improvements. This phenomenon highlights the importance of the doctor-patient relationship and patient expectations in medical outcomes."`,
    null,
    '위약 효과는 의학적으로 검증되지 않았다.',
    '의사-환자 관계는 치료 효과에 영향을 미친다.',
    '정신이 신체에 미치는 영향과 의사-환자 관계의 중요성이 치료 결과를 좌우한다.',
    '위약은 진짜 약과 동일한 효과를 낸다.','C','위약 효과를 통해 mind-body connection + 의사-환자 관계 중요성 설명',2,'주제·요지'],
    ['tq22','독해','SEOUL',`빈칸에 가장 적절한 것은?
"The transition from hunter-gatherer societies to agricultural communities was not merely a change in food production; it fundamentally altered human social structures. The surplus food generated by farming allowed for _____, giving rise to cities, specialized labor, and complex governance systems."`,
    null,'population decline','nomadic lifestyles','population growth and settlement','simpler social organization','C',
    '농업 → 잉여식량 → 인구증가 및 정착 → 도시화',3,'빈칸완성'],
    ['tq23','독해','SKY',`다음 글의 논리적 구조로 가장 적절한 것은?
"Critics argue that social media polarizes political discourse. However, research indicates that most users primarily consume content aligning with their existing beliefs—a phenomenon called confirmation bias. This suggests the problem may not be social media per se, but rather pre-existing psychological tendencies amplified by algorithmic recommendation systems."`,
    null,
      '주장 → 반박 → 종합',
      '문제 제기 → 원인 분석 → 해결책 제시',
      '통념 → 반론 → 재해석',
      '가설 → 검증 → 결론','C',
      'Critics(통념) → However research(반론) → This suggests(재해석)',3,'글의구조·흐름'],
    ['tq24','독해','COMMON',`내용과 일치하는 것은?
"Ocean acidification, caused by the absorption of CO2, threatens marine ecosystems. As seawater becomes more acidic, organisms that build shells or skeletons from calcium carbonate—such as corals and mollusks—struggle to maintain their structures. This has cascading effects throughout the food web."`,
    null,
      '해양 산성화는 CO2 배출을 증가시킨다.',
      '탄산칼슘 구조물을 만드는 생물들이 영향을 받는다.',
      '산성화는 먹이사슬에 제한적인 영향만 미친다.',
      '산호는 산성화에 영향을 받지 않는다.','B','corals and mollusks struggle → B 정답',2,'내용일치'],
    ['tq25','독해','SEOUL',`글의 흐름상 가장 어색한 문장은?
"① The concept of emotional intelligence (EI) has gained prominence in organizational psychology. ② EI refers to the ability to perceive, understand, and manage emotions. ③ High EI is associated with better leadership effectiveness and team performance. ④ IQ tests have been criticized for cultural bias."`,
    null,'①','②','③','④','D','④는 IQ에 관한 내용으로 EI 주제와 무관',3,'무관문장'],
    // 논리 — 영어 지문 기반 편입 영어 논리
    ['tq26','논리','COMMON','다음 빈칸 (A)와 (B)에 들어갈 연결어로 가장 적절한 것은?',
      'Renewable energy sources such as wind and solar power are becoming increasingly affordable. (A) _____, they still face significant challenges in terms of energy storage and grid stability. (B) _____, sustained investment in battery technology and smart grid infrastructure is essential for a successful energy transition.',
      '(A) Furthermore — (B) Similarly',
      '(A) Nevertheless — (B) Therefore',
      '(A) In addition — (B) However',
      '(A) As a result — (B) Moreover','B','(A) 역접(비록 저렴해졌지만 도전과제), (B) 결과/결론(따라서 투자 필요)',2,'연결어'],
    ['tq27','논리','COMMON','다음 글에서 전체 흐름과 관계없는 문장은?',
      '① Microplastics—tiny plastic fragments less than 5mm—have been found in every ocean on Earth. ② They enter marine ecosystems through the breakdown of larger plastic debris and runoff from land. ③ Marine mammals such as dolphins are known for their complex social behaviors and communication skills. ④ Scientists have detected microplastics in fish, seabirds, and even in human blood, raising serious health concerns.',
      '①','②','③','④','C','③ 돌고래 사회 행동은 미세플라스틱 주제와 무관',2,'무관문장·완성'],
    ['tq28','논리','SEOUL','주어진 글 다음에 이어질 내용의 순서로 가장 적절한 것은?',
      "The concept of 'nudge theory' in behavioral economics suggests that small changes in the way choices are presented can significantly influence people's decision-making without restricting their freedom.\n\n(A) For example, placing healthy food at eye level in cafeterias increased healthy choices by up to 30% in one study.\n(B) Critics, however, argue that nudging is a subtle form of manipulation that undermines individual autonomy.\n(C) Governments worldwide have begun applying nudge theory to public health and financial policy.",
      '(A)-(C)-(B)','(C)-(A)-(B)','(B)-(A)-(C)','(A)-(B)-(C)','B','C(정부 적용) → A(구체적 사례) → B(반론/비판)',3,'순서·배열'],
    ['tq29','논리','SKY','다음 주장을 가장 효과적으로 약화시키는 것은?\n주장: "Social media use among teenagers should be restricted, as studies show a clear correlation between social media use and increased rates of depression in this age group."',null,
      'Teenagers spend an average of four hours per day on social media.',
      'Several large-scale studies have failed to replicate the correlation between social media use and teenage depression.',
      'Many teenagers use social media to maintain friendships and access educational content.',
      'Social media companies have introduced screen-time monitoring features.','B','연구 재현 실패 = 상관관계 증거 자체를 직접 공격',3,'논지약화·강화'],
    ['tq30','논리','SKY','다음 글에서 추론할 수 있는 결론으로 가장 적절한 것은?',
      "In economics, the 'tragedy of the commons' describes a situation in which individuals acting in self-interest collectively deplete a shared resource, even when it is clear that this outcome harms everyone in the long run. This concept has been applied to environmental issues such as overfishing and air pollution, where individual incentives conflict with collective well-being.",
      'Individuals must be prevented from owning any resources to avoid overexploitation.',
      'Technological innovation alone can resolve the overuse of shared resources.',
      'Effective management of shared resources most likely requires collective governance or regulation.',
      'The tragedy of the commons only applies to environmental problems, not economic ones.','C','공유자원의 비극 → 개인 인센티브와 공공이익 충돌 → 집단 거버넌스/규제 필요',3,'추론·결론'],

    // ── 독해 추가 10문제 (tq31-tq40) ─────────────────────────────────
    ['tq31','독해','COMMON',`다음 글의 주제로 가장 적절한 것은?`,
      `Sleep is not merely a passive state of unconsciousness. During sleep, the brain consolidates memories, removes metabolic waste, and repairs cellular damage. Research shows that chronic sleep deprivation impairs cognitive function, weakens the immune system, and increases the risk of metabolic disorders such as diabetes. Despite this, modern societies continue to glorify overwork and minimize the importance of sleep.`,
      'The relationship between sleep duration and academic performance',
      'The active biological functions of sleep and the risks of sleep deprivation',
      'The cultural attitudes toward sleep in different societies',
      'The stages of sleep and their effects on dreaming','B','수면의 생물학적 기능과 수면 부족 위험성이 핵심 주제',1,'주제·요지'],
    ['tq32','독해','SEOUL',`다음 글의 빈칸에 들어갈 가장 적절한 것은?`,
      `Artificial intelligence has transformed many industries, but its impact on creative fields raises complex questions. Proponents argue that AI tools democratize creativity by making sophisticated design and writing accessible to non-experts. Critics, however, contend that AI-generated content lacks the _____ that distinguishes authentic human expression from mere pattern replication.`,
      'technical precision','aesthetic consistency','intentionality and lived experience','commercial viability','C','AI 비판론 = 의도성과 살아있는 경험의 부재가 핵심',2,'빈칸완성'],
    ['tq33','독해','COMMON',`다음 글의 내용과 일치하지 않는 것은?`,
      `The Mediterranean diet, characterized by high consumption of vegetables, legumes, whole grains, and olive oil, has been associated with reduced risk of cardiovascular disease and cognitive decline. Studies suggest that the anti-inflammatory properties of its components—particularly omega-3 fatty acids from fish and antioxidants from fruits—play a central role. Unlike many popular diets, the Mediterranean diet emphasizes lifestyle factors such as communal eating and moderate physical activity.`,
      'The Mediterranean diet is linked to lower rates of heart disease.',
      'Omega-3 fatty acids and antioxidants contribute to its health benefits.',
      'The diet focuses exclusively on food choices, not lifestyle factors.',
      'Communal eating is considered part of the Mediterranean dietary pattern.','C','지중해 식단은 식품뿐 아니라 생활방식(공동식사, 운동)도 포함 → C가 불일치',1,'내용일치'],
    ['tq34','독해','SEOUL',`글에서 필자가 가장 강조하는 것은?`,
      `Cities worldwide are facing a housing affordability crisis. While governments have introduced rent controls and subsidized housing programs, these measures often treat symptoms rather than underlying causes. The fundamental issue is a mismatch between housing supply and demand, exacerbated by restrictive zoning laws that limit high-density development. Until municipalities reform zoning regulations to allow more housing units in desirable areas, affordability will remain elusive.`,
      'The need to increase government subsidies for low-income housing',
      'The importance of reforming zoning laws to increase housing supply',
      'The role of rent controls in stabilizing housing markets',
      'The relationship between population growth and housing demand','B','필자는 조닝법 개혁을 통한 공급 증가를 핵심 해결책으로 강조',2,'주제·요지'],
    ['tq35','독해','SKY',`다음 글의 논리 전개 방식으로 가장 적절한 것은?`,
      `The "broken windows theory" proposed that visible signs of disorder—such as broken windows and graffiti—signal that an area is uncared for, thereby encouraging further crime. New York City applied this theory in the 1990s, aggressively prosecuting minor violations. Crime rates subsequently fell, which was cited as confirmation. However, crime declined simultaneously in many cities that did not adopt these policies, suggesting that broader economic and demographic factors may have been the actual cause.`,
      'A phenomenon is described, then refuted using comparative evidence.',
      'A theory is proposed, supported with data, and extended to new contexts.',
      'Two competing theories are compared, and a synthesis is offered.',
      'Historical events are narrated chronologically to identify a turning point.','A','깨진 유리창 이론 소개 → 적용 사례 → 비교 증거로 반박',3,'글의구조·흐름'],
    ['tq36','독해','COMMON',`다음 문단에서 전체 흐름과 관계없는 문장은?`,
      `① Bilingual education offers significant cognitive advantages. ② Studies show that managing two languages strengthens executive function, particularly skills related to attention and task-switching. ③ Bilingual individuals tend to delay the onset of dementia by several years compared to monolinguals. ④ Learning a second language in adulthood is considerably more difficult than in childhood.`,
      '①','②','③','④','D','④는 성인 제2언어 학습의 어려움으로 인지적 이점과 무관한 흐름',1,'무관문장'],
    ['tq37','독해','SEOUL',`빈칸에 들어갈 가장 적절한 것은?`,
      `Corporate social responsibility (CSR) has evolved from a peripheral concern to a central business strategy. Initially regarded as philanthropy, CSR is now recognized as a driver of competitive advantage. Firms that demonstrate genuine commitment to environmental sustainability and ethical labor practices attract top talent, build consumer trust, and reduce regulatory risk. In this sense, _____.`,
      'social responsibility and profitability are fundamentally at odds',
      'doing good and doing well in business are increasingly compatible goals',
      'CSR initiatives are most effective when imposed by external regulation',
      'consumer demand for ethical products has been consistently overstated','B','CSR가 경쟁 우위가 된다는 논지 → 선의와 이익이 양립 가능함',2,'빈칸완성'],
    ['tq38','독해','SKY',`다음 글에서 추론할 수 있는 것으로 가장 적절한 것은?`,
      `The Dunning-Kruger effect describes a cognitive bias in which individuals with limited knowledge in a domain overestimate their competence, while highly skilled individuals tend to underestimate theirs. This asymmetry arises because true expertise requires sufficient knowledge to recognize what one does not know. Thus, the awareness of ignorance itself becomes a marker of competence.`,
      'Experts are less prone to making mistakes than novices in any field.',
      'Self-assessment is a reliable indicator of actual performance.',
      'Recognizing the limits of one\'s knowledge is characteristic of genuine expertise.',
      'The Dunning-Kruger effect applies only to academic or technical domains.','C','진정한 전문성 = 자신의 무지를 인식하는 능력이라는 추론이 핵심',3,'글의구조·흐름'],
    ['tq39','독해','COMMON',`글의 주제로 가장 적절한 것은?`,
      `Microplastics—tiny plastic particles less than 5 millimeters in size—have been detected in oceans, freshwater systems, soil, and even the human bloodstream. They originate from the degradation of larger plastic waste and are ingested by marine organisms, entering the food chain. While the long-term health effects on humans remain under investigation, evidence suggests potential disruption of endocrine function and inflammatory responses.`,
      'The economic costs of plastic pollution in marine ecosystems',
      'The sources, spread, and potential health impacts of microplastics',
      'The effectiveness of current regulations on plastic production',
      'The methods used to detect microplastics in the environment','B','미세플라스틱의 출처, 확산 경로, 잠재적 건강 영향이 주제',1,'주제·요지'],
    ['tq40','독해','SKY',`다음 글의 빈칸 (A)와 (B)에 들어갈 말로 가장 적절한 것은?`,
      `Universal Basic Income (UBI) proposes providing all citizens with a regular, unconditional cash payment. Supporters argue that UBI would alleviate poverty and provide a safety net in an era of increasing automation. (A) _____, critics contend that it could reduce work incentives and impose unsustainable fiscal burdens. (B) _____, pilot programs in Finland and Kenya have shown promising results in improving well-being without significantly reducing employment.`,
      '(A) Therefore — (B) As a result',
      '(A) However — (B) Nevertheless',
      '(A) Similarly — (B) In addition',
      '(A) Furthermore — (B) Consequently','B','지지 주장 → However(역접) 비판 → Nevertheless(역접) 실험 결과 긍정',3,'빈칸완성'],

    // ── 논리 추가 10문제 (tq41-tq50) ─────────────────────────────────
    ['tq41','논리','COMMON','다음 빈칸에 들어갈 가장 적절한 연결어는?',
      `Smartphones have made communication faster and more convenient. _____, studies indicate that excessive smartphone use is linked to increased loneliness and reduced quality of face-to-face interaction.`,
      'Therefore','In addition','Nevertheless','As a result','C','앞 문장(편의성) ↔ 뒤 문장(부작용) 역접 관계 → Nevertheless',1,'연결어'],
    ['tq42','논리','COMMON','다음 글에서 전체 흐름과 관계없는 문장은?',
      `① The rise of e-commerce has fundamentally changed consumer behavior. ② Online shopping offers convenience, wider product selection, and often lower prices. ③ Many traditional brick-and-mortar retailers have struggled to adapt. ④ The history of currency exchange dates back to ancient Mesopotamia.`,
      '①','②','③','④','D','④는 통화 교환의 역사로 전자상거래 주제와 완전히 무관',1,'무관문장·완성'],
    ['tq43','논리','SEOUL','주어진 세 문장을 논리적 순서에 맞게 배열한 것은?',
      `(A) As a result, governments and international organizations are exploring carbon pricing mechanisms to internalize these costs.\n(B) The burning of fossil fuels releases carbon dioxide, a greenhouse gas that drives climate change.\n(C) However, the economic costs of climate change—including extreme weather events and rising sea levels—are not reflected in the market price of fossil fuels.`,
      '(B)-(A)-(C)','(C)-(A)-(B)','(B)-(C)-(A)','(A)-(C)-(B)','C','화석연료 연소(B) → 시장가격 미반영(C) → 정책 대응(A)',2,'순서·배열'],
    ['tq44','논리','SEOUL','다음 글의 빈칸에 들어갈 가장 적절한 것은?',
      `Philosophy of language has long grappled with the question of how words acquire meaning. One influential view holds that meaning is determined not by reference to objects in the world but by the role words play within a system of language—that is, by their relationships to other words. According to this view, understanding a word means knowing _____.`,
      'the historical origin and etymology of the word',
      'how to pronounce it correctly in different dialects',
      'how it functions in relation to other words in the language system',
      'which physical object in the world it points to','C','단어 의미 = 언어 체계 내 다른 단어들과의 관계적 기능',2,'빈칸완성'],
    ['tq45','논리','COMMON','다음 주장을 약화시키는 것으로 가장 적절한 것은?\n주장: "Raising the minimum wage leads to increased unemployment because employers cannot afford to hire as many workers."',null,
      'A meta-analysis of studies finds that minimum wage increases have minimal effect on overall employment levels.',
      'Small businesses report that labor costs account for their largest operating expense.',
      'Some economists predict job losses of up to 1.4 million from a minimum wage increase.',
      'Labor unions have historically supported minimum wage legislation.','A','고용에 미미한 영향이라는 메타분석 = 최저임금→실업 주장을 직접 약화',2,'논지약화·강화'],
    ['tq46','논리','SEOUL','다음 글에서 추론할 수 있는 것으로 가장 적절한 것은?',
      `Every successful scientific theory must make predictions that are, in principle, falsifiable—that is, it must be possible to specify observations that would prove the theory wrong. A theory that can accommodate any possible observation is not scientifically meaningful. For this reason, astrology is not considered a science: its predictions are so vague that they cannot be definitively refuted.`,
      'Scientific theories are valuable only when they have been proven correct.',
      'Falsifiability is a necessary condition for a claim to qualify as scientific.',
      'Astrology makes accurate predictions, but they are difficult to test empirically.',
      'A theory becomes more scientific as the number of its predictions increases.','B','반증가능성 = 과학적 이론의 필요 조건이라는 추론',2,'추론·결론'],
    ['tq47','논리','SKY','주어진 글 다음에 이어질 내용의 순서로 가장 적절한 것은?',
      `주어진 글: The placebo effect—in which patients improve after receiving inert treatments—has long puzzled medical researchers.\n\n(A) Nonetheless, the effect is real and measurable, with patients reporting genuine pain relief and showing physiological changes after taking placebos.\n(B) This suggests that the mind's expectations can directly influence bodily processes.\n(C) One might assume this effect is simply a matter of self-deception or wishful thinking.`,
      '(C)-(A)-(B)','(A)-(C)-(B)','(B)-(A)-(C)','(C)-(B)-(A)','A','가정(C) → 실제 효과 반박(A) → 의미 도출(B)',3,'순서·배열'],
    ['tq48','논리','SKY','다음 주장을 강화하는 것으로 가장 적절한 것은?\n주장: "Urban green spaces such as parks and gardens play a crucial role in improving the mental health of city residents."',null,
      'Urbanization has been linked to increased rates of anxiety and depression globally.',
      'A longitudinal study finds that residents living near parks report significantly lower stress levels and fewer depressive episodes.',
      'City governments spend a significant portion of their budgets on maintaining public parks.',
      'Air quality in cities with more tree cover tends to be better than in those without.','B','종단 연구에서 공원 근처 거주자 스트레스/우울 감소 = 주장 직접 강화',3,'논지약화·강화'],
    ['tq49','논리','SEOUL','다음 글의 내용을 요약할 때 빈칸에 들어갈 가장 적절한 말은?\n→ 언어가 사고를 완전히 결정한다는 강한 주장은 지지받지 못하지만, 언어가 일부 _____ 과정에 영향을 미친다는 약한 주장은 지지를 받는다.',
      `Language shapes the way we perceive reality. The Sapir-Whorf hypothesis, in its strong form, suggests that the language one speaks determines one's thoughts and perceptions. Empirical support for this strong version is limited; however, evidence does suggest that language can influence certain cognitive processes, such as color perception and spatial reasoning, in more subtle ways.`,
      '경제적','인지적','감정적','사회적','B','color perception, spatial reasoning = 인지적(cognitive) 과정',2,'추론·결론'],
    ['tq50','논리','SKY','다음 빈칸 (A)와 (B)에 들어갈 연결어로 가장 적절한 것은?',
      `In democratic societies, freedom of expression is considered a fundamental right. (A) _____, this freedom is not absolute: speech that incites violence, constitutes fraud, or violates others' privacy may be lawfully restricted. (B) _____, the challenge for policymakers is to define the precise boundaries between protected speech and harmful expression without enabling censorship.`,
      '(A) Therefore — (B) Similarly',
      '(A) However — (B) Consequently',
      '(A) In addition — (B) However',
      '(A) Similarly — (B) Therefore','B','표현의 자유 원칙 → However(제한 존재) → Consequently(정책적 과제)',3,'연결어'],
  ];

  sectionQ.forEach(q => testQ.run(...q));

  // ── 단어장 ────────────────────────────────────────
  const words = [
    ['w01','ubiquitous','어디에나 있는, 편재하는','Smartphones have become ubiquitous in modern society.',2,'GENERAL'],
    ['w02','ameliorate','개선하다, 완화하다','The new policy aims to ameliorate poverty.',3,'GENERAL'],
    ['w03','ephemeral','단명하는, 덧없는','Social media trends are often ephemeral.',2,'GENERAL'],
    ['w04','conciliate','달래다, 화해시키다','She tried to conciliate the angry customer.',3,'GENERAL'],
    ['w05','pragmatic','실용적인','We need a pragmatic approach to this problem.',1,'GENERAL'],
    ['w06','diligent','부지런한, 성실한','He is a diligent student who studies every day.',1,'GENERAL'],
    ['w07','ambiguous','모호한, 불분명한','The contract contained ambiguous language.',2,'GENERAL'],
    ['w08','corroborate','확인하다, 뒷받침하다','New evidence corroborated the original theory.',3,'GENERAL'],
    ['w09','laconic','간결한, 말수가 적은','He gave a laconic reply: "No."',3,'GENERAL'],
    ['w10','inveterate','습관적인, 뿌리 깊은','She is an inveterate reader of mystery novels.',3,'GENERAL'],
    ['w11','bilateral','양자간의','The two countries signed a bilateral agreement.',2,'ACADEMIC'],
    ['w12','inadmissible','허용되지 않는','The evidence was declared inadmissible.',3,'ACADEMIC'],
    ['w13','exacerbate','악화시키다','Lack of sleep can exacerbate stress.',2,'ACADEMIC'],
    ['w14','manifest','명백히 드러내다, 명백한','His talent manifested early in life.',2,'ACADEMIC'],
    ['w15','benign','온화한, (의학) 양성의','The doctor confirmed the tumor was benign.',2,'ACADEMIC'],
    ['w16','cursory','피상적인, 성급한','He gave only a cursory glance at the report.',3,'ACADEMIC'],
    ['w17','incisive','예리한, 날카로운','She made an incisive observation.',3,'ACADEMIC'],
    ['w18','autocratic','독재적인, 권위주의적인','His autocratic management style was criticized.',3,'ACADEMIC'],
    ['w19','alleviate','완화하다, 경감하다','Exercise can alleviate symptoms of depression.',2,'GENERAL'],
    ['w20','perpetuate','영속시키다, 지속시키다','Such policies perpetuate inequality.',3,'ACADEMIC'],
    ['w21','substantiate','입증하다','Please substantiate your claims with evidence.',3,'ACADEMIC'],
    ['w22','dichotomy','이분법, 양분','There is a false dichotomy between work and fun.',3,'ACADEMIC'],
    ['w23','mitigate','완화하다, 경감하다','Measures were taken to mitigate the damage.',2,'GENERAL'],
    ['w24','scrutinize','면밀히 조사하다','The committee scrutinized every detail.',3,'ACADEMIC'],
    ['w25','tenacious','끈질긴, 완강한','She was tenacious in pursuing her goals.',2,'GENERAL'],
    ['w26','coerce','강요하다','He was coerced into signing the document.',3,'GENERAL'],
    ['w27','discrepancy','불일치, 모순','There was a discrepancy in the accounts.',2,'ACADEMIC'],
    ['w28','unprecedented','전례 없는','The pandemic caused unprecedented disruption.',2,'GENERAL'],
    ['w29','formidable','강력한, 만만치 않은','She faced formidable challenges.',2,'GENERAL'],
    ['w30','articulate','명확히 표현하다; 말을 잘 하는','He articulated his ideas clearly.',2,'GENERAL'],
  ];

  words.forEach(w => vocab.run(...w));
  log('info', '[Transfer LMS] 문제/단어 시딩 완료');
}

seedTransferLMS();
seedTransferQuestions();

// ── 편입 LMS Auth 미들웨어 ─────────────────────────────────────────
function tlAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: '로그인이 필요합니다' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.system || decoded.system !== 'transfer') {
      return res.status(401).json({ error: '편입 LMS 토큰이 아닙니다' });
    }
    req.tUser = decoded;
    next();
  } catch {
    res.status(401).json({ error: '세션이 만료되었습니다. 다시 로그인해주세요.' });
  }
}

function tlAdmin(req, res, next) {
  if (req.tUser?.role !== 'admin') return res.status(403).json({ error: '관리자 권한이 필요합니다' });
  next();
}

function tlAdminOrInstructor(req, res, next) {
  if (!['admin','instructor'].includes(req.tUser?.role))
    return res.status(403).json({ error: '강사/관리자 권한이 필요합니다' });
  next();
}

function tlUid() { return `tl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`; }

// ── 편입 LMS API 라우터 ────────────────────────────────────────────
// 로그인
app.post('/api/tl/login', authLimiter, (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요' });

    const user = db.prepare('SELECT * FROM tl_users WHERE username=?').get(username);
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: '아이디 또는 비밀번호가 잘못되었습니다' });

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, name: user.name,
        class_level: user.class_level, system: 'transfer' },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    const { password_hash, ...safe } = user;
    res.json({ token, user: safe });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 관리자: 학생 관리 ───────────────────────────────────────────────
app.get('/api/tl/students', tlAuth, tlAdminOrInstructor, (req, res) => {
  try {
    let rows;
    if (req.tUser.role === 'admin') {
      rows = db.prepare(`SELECT u.*, i.name as instructor_name
        FROM tl_users u LEFT JOIN tl_users i ON u.instructor_id=i.id
        WHERE u.role='student' ORDER BY u.class_level, u.name`).all();
    } else {
      rows = db.prepare(`SELECT u.*, i.name as instructor_name
        FROM tl_users u LEFT JOIN tl_users i ON u.instructor_id=i.id
        WHERE u.role='student' AND u.instructor_id=?
        ORDER BY u.class_level, u.name`).all(req.tUser.id);
    }
    res.json(rows.map(r => { const {password_hash,...s}=r; return s; }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tl/students', tlAuth, tlAdmin, (req, res) => {
  try {
    const { username, password, name, email, phone, class_level='unassigned', instructor_id='', memo='' } = req.body;
    if (!username || !password || !name)
      return res.status(400).json({ error: '필수 항목을 입력하세요' });
    if (db.prepare('SELECT id FROM tl_users WHERE username=?').get(username))
      return res.status(409).json({ error: '이미 존재하는 아이디입니다' });
    const id = tlUid();
    db.prepare(`INSERT INTO tl_users (id,username,password_hash,role,name,email,phone,class_level,instructor_id,memo)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, username, bcrypt.hashSync(password,10), 'student', name, email||'', phone||'',
           class_level, instructor_id||null, memo);
    res.json({ ok:true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/tl/students/:id', tlAuth, tlAdminOrInstructor, (req, res) => {
  try {
    const { name, email, phone, class_level, instructor_id, memo, password } = req.body;
    const fields = [];
    const vals = [];
    if (name) { fields.push('name=?'); vals.push(name); }
    if (email !== undefined) { fields.push('email=?'); vals.push(email); }
    if (phone !== undefined) { fields.push('phone=?'); vals.push(phone); }
    if (class_level) { fields.push('class_level=?'); vals.push(class_level); }
    if (instructor_id !== undefined) { fields.push('instructor_id=?'); vals.push(instructor_id||null); }
    if (memo !== undefined) { fields.push('memo=?'); vals.push(memo); }
    if (password) { fields.push('password_hash=?'); vals.push(bcrypt.hashSync(password,10)); }
    if (!fields.length) return res.status(400).json({ error: '수정할 항목이 없습니다' });
    vals.push(req.params.id);
    db.prepare(`UPDATE tl_users SET ${fields.join(',')} WHERE id=? AND role='student'`).run(...vals);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/tl/students/:id', tlAuth, tlAdmin, (req, res) => {
  try {
    db.prepare("DELETE FROM tl_users WHERE id=? AND role='student'").run(req.params.id);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 강사 관리 ────────────────────────────────────────────────────
app.get('/api/tl/instructors', tlAuth, tlAdmin, (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM tl_users WHERE role='instructor' ORDER BY name").all();
    res.json(rows.map(r => { const {password_hash,...s}=r; return s; }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tl/instructors', tlAuth, tlAdmin, (req, res) => {
  try {
    const { username, password, name, email, phone } = req.body;
    if (!username || !password || !name) return res.status(400).json({ error: '필수 항목 누락' });
    if (db.prepare('SELECT id FROM tl_users WHERE username=?').get(username))
      return res.status(409).json({ error: '이미 존재하는 아이디' });
    const id = tlUid();
    db.prepare(`INSERT INTO tl_users (id,username,password_hash,role,name,email,phone)
      VALUES (?,?,?,?,?,?,?)`)
      .run(id, username, bcrypt.hashSync(password,10), 'instructor', name, email||'', phone||'');
    res.json({ ok:true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/tl/instructors/:id', tlAuth, tlAdmin, (req, res) => {
  try {
    db.prepare("DELETE FROM tl_users WHERE id=? AND role='instructor'").run(req.params.id);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 스케줄 (오전 라이브 수업) ────────────────────────────────────
app.get('/api/tl/schedule', tlAuth, (req, res) => {
  try {
    const { date } = req.query;
    const target = date || new Date().toISOString().slice(0,10);
    const rows = db.prepare(`
      SELECT s.*, u.name as instructor_name
      FROM tl_schedule s LEFT JOIN tl_users u ON s.instructor_id=u.id
      WHERE s.class_date=? ORDER BY s.period`).all(target);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tl/schedule', tlAuth, tlAdminOrInstructor, (req, res) => {
  try {
    const { class_date, period, subject, zoom_url, class_level='ALL', start_time, end_time } = req.body;
    if (!class_date || !period || !subject || !zoom_url)
      return res.status(400).json({ error: '필수 항목 누락' });
    const instructor_id = req.tUser.role === 'instructor' ? req.tUser.id : (req.body.instructor_id || req.tUser.id);
    const id = `sch_${class_date}_${period}`;
    db.prepare(`INSERT OR REPLACE INTO tl_schedule
      (id,class_date,period,subject,instructor_id,zoom_url,class_level,start_time,end_time)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, class_date, period, subject, instructor_id, zoom_url, class_level,
           start_time||'09:00', end_time||'10:00');
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/tl/schedule/:id', tlAuth, tlAdminOrInstructor, (req, res) => {
  try {
    db.prepare('DELETE FROM tl_schedule WHERE id=?').run(req.params.id);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 출석 관리 ──────────────────────────────────────────────────────

// 내 출석 통계 조회 (학생용)
app.get('/api/tl/attendance/my', tlAuth, (req, res) => {
  try {
    const sid = req.tUser.id;
    // 오전(start_time < 12:00) / 오후 구분하여 집계
    const rows = db.prepare(`
      SELECT a.status, s.start_time, s.period, s.subject, s.class_date, s.id as schedule_id
      FROM tl_attendance a
      JOIN tl_schedule s ON a.schedule_id = s.id
      WHERE a.student_id = ?
      ORDER BY s.class_date DESC, s.period ASC
    `).all(sid);

    const morning   = { present:0, absent:0, late:0, total:0 };
    const afternoon = { present:0, absent:0, late:0, total:0 };

    rows.forEach(r => {
      const slot = (r.start_time||'09:00') < '12:00' ? morning : afternoon;
      slot.total++;
      if (r.status === 'present') slot.present++;
      else if (r.status === 'absent') slot.absent++;
      else if (r.status === 'late') slot.late++;
    });

    morning.rate   = morning.total   > 0 ? Math.round((morning.present + morning.late * 0.5) / morning.total * 100) : null;
    afternoon.rate = afternoon.total > 0 ? Math.round((afternoon.present + afternoon.late * 0.5) / afternoon.total * 100) : null;

    const recent = rows.slice(0, 20).map(r => ({
      date: r.class_date, period: r.period, subject: r.subject,
      start_time: r.start_time,
      time_slot: (r.start_time||'09:00') < '12:00' ? '오전' : '오후',
      status: r.status,
    }));

    res.json({ morning, afternoon, recent });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 특정 스케줄 출석 목록 (강사/관리자)
app.get('/api/tl/attendance/schedule/:scheduleId', tlAuth, tlAdminOrInstructor, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT a.*, u.name as student_name, u.class_level
      FROM tl_attendance a JOIN tl_users u ON a.student_id = u.id
      WHERE a.schedule_id = ? ORDER BY u.name
    `).all(req.params.scheduleId);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 출석 일괄 등록/수정 (강사/관리자) — 스케줄ID + 학생별 상태 배열
app.post('/api/tl/attendance', tlAuth, tlAdminOrInstructor, (req, res) => {
  try {
    const { schedule_id, entries } = req.body;
    // entries = [{ student_id, status, note }]
    if (!schedule_id || !Array.isArray(entries))
      return res.status(400).json({ error: 'schedule_id와 entries 필요' });

    const sched = db.prepare('SELECT id FROM tl_schedule WHERE id=?').get(schedule_id);
    if (!sched) return res.status(404).json({ error: '스케줄을 찾을 수 없습니다' });

    const upsert = db.prepare(`
      INSERT INTO tl_attendance (id, schedule_id, student_id, status, note, marked_by, marked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(schedule_id, student_id) DO UPDATE SET
        status=excluded.status, note=excluded.note,
        marked_by=excluded.marked_by, marked_at=excluded.marked_at
    `);
    const now = Math.floor(Date.now() / 1000);
    const insertMany = db.transaction((rows) => {
      rows.forEach(e => {
        const aid = `att_${schedule_id}_${e.student_id}`;
        upsert.run(aid, schedule_id, e.student_id, e.status || 'present', e.note || null, req.tUser.id, now);
      });
    });
    insertMany(entries);
    res.json({ ok: true, count: entries.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 단일 출석 수정
app.put('/api/tl/attendance/:id', tlAuth, tlAdminOrInstructor, (req, res) => {
  try {
    const { status, note } = req.body;
    db.prepare(`UPDATE tl_attendance SET status=?, note=?, marked_by=?, marked_at=? WHERE id=?`)
      .run(status, note || null, req.tUser.id, Math.floor(Date.now()/1000), req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 전체 출석 현황 (관리자 — 날짜별)
app.get('/api/tl/attendance', tlAuth, tlAdminOrInstructor, (req, res) => {
  try {
    const { date, schedule_id } = req.query;
    let q = `SELECT a.*, u.name as student_name, u.class_level,
               s.class_date, s.period, s.subject, s.start_time
             FROM tl_attendance a
             JOIN tl_users u ON a.student_id = u.id
             JOIN tl_schedule s ON a.schedule_id = s.id
             WHERE 1=1`;
    const params = [];
    if (date)        { q += ' AND s.class_date=?'; params.push(date); }
    if (schedule_id) { q += ' AND a.schedule_id=?'; params.push(schedule_id); }
    q += ' ORDER BY s.class_date DESC, s.period, u.name';
    res.json(db.prepare(q).all(...params));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 녹화본 링크 ────────────────────────────────────────────────────
app.get('/api/tl/recordings', tlAuth, (req, res) => {
  try {
    const { date, limit=20 } = req.query;
    let q = `SELECT r.*, u.name as instructor_name
      FROM tl_recordings r LEFT JOIN tl_users u ON r.instructor_id=u.id`;
    const params = [];
    if (date) { q += ' WHERE r.class_date=?'; params.push(date); }
    q += ' ORDER BY r.class_date DESC, r.period LIMIT ?';
    params.push(parseInt(limit));
    res.json(db.prepare(q).all(...params));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tl/recordings', tlAuth, tlAdminOrInstructor, (req, res) => {
  try {
    const { class_date, period, subject, zoom_url, description, class_level='ALL' } = req.body;
    if (!class_date || !period || !subject || !zoom_url)
      return res.status(400).json({ error: '필수 항목 누락' });
    const id = tlUid();
    const instructor_id = req.tUser.role === 'instructor' ? req.tUser.id
                        : (req.body.instructor_id || req.tUser.id);
    db.prepare(`INSERT INTO tl_recordings (id,class_date,period,subject,instructor_id,zoom_url,description,class_level)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, class_date, period, subject, instructor_id, zoom_url, description||'', class_level);
    res.json({ ok:true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/tl/recordings/:id', tlAuth, tlAdminOrInstructor, (req, res) => {
  try {
    const rec = db.prepare('SELECT instructor_id FROM tl_recordings WHERE id=?').get(req.params.id);
    if (!rec) return res.status(404).json({ error: '없는 녹화본' });
    if (req.tUser.role !== 'admin' && rec.instructor_id !== req.tUser.id)
      return res.status(403).json({ error: '권한 없음' });
    db.prepare('DELETE FROM tl_recordings WHERE id=?').run(req.params.id);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 녹화본 조회수 증가
app.post('/api/tl/recordings/:id/view', tlAuth, (req, res) => {
  db.prepare('UPDATE tl_recordings SET views=views+1 WHERE id=?').run(req.params.id);
  res.json({ ok:true });
});

// ── 레벨테스트 ─────────────────────────────────────────────────────
app.get('/api/tl/level-test/questions', (req, res) => {
  try {
    // 전체 레벨테스트 문제 (랜덤 40개)
    const rows = db.prepare(`
      SELECT id,section,question_text,passage,option_a,option_b,option_c,option_d,difficulty
      FROM tl_level_questions ORDER BY RANDOM() LIMIT 40`).all();
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tl/level-test/submit', (req, res) => {
  try {
    const { answers, student_name, student_id } = req.body;
    if (!answers || typeof answers !== 'object')
      return res.status(400).json({ error: '답안 형식 오류' });

    const questions = db.prepare('SELECT * FROM tl_level_questions').all();
    const qMap = Object.fromEntries(questions.map(q => [q.id, q]));

    let total = 0, correct = 0;
    const sectionCorrect = { 어휘:0, 문법:0, 독해:0, 논리:0 };
    const sectionTotal   = { 어휘:0, 문법:0, 독해:0, 논리:0 };
    const feedback = [];

    Object.entries(answers).forEach(([qid, ans]) => {
      const q = qMap[qid];
      if (!q) return;
      total++;
      sectionTotal[q.section] = (sectionTotal[q.section]||0) + 1;
      const isCorrect = ans === q.correct_answer;
      if (isCorrect) { correct++; sectionCorrect[q.section] = (sectionCorrect[q.section]||0)+1; }
      feedback.push({ qid, correct: isCorrect, correct_answer: q.correct_answer,
                      explanation: q.explanation||'', section: q.section });
    });

    const pct = total > 0 ? Math.round(correct/total*100) : 0;
    const assigned_class = pct >= 80 ? 'A' : pct >= 60 ? 'B' : 'C';

    const section_scores = {};
    ['어휘','문법','독해','논리'].forEach(s => {
      section_scores[s] = {
        correct: sectionCorrect[s]||0,
        total:   sectionTotal[s]||0,
        pct: sectionTotal[s] ? Math.round((sectionCorrect[s]||0)/sectionTotal[s]*100) : 0
      };
    });

    const id = tlUid();
    db.prepare(`INSERT INTO tl_level_results
      (id,student_id,student_name,total_score,total_questions,section_scores,assigned_class,answers)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, student_id||null, student_name||'미등록', correct, total,
           JSON.stringify(section_scores), assigned_class, JSON.stringify(answers));

    // 학생 반 자동 배정
    if (student_id) {
      db.prepare("UPDATE tl_users SET class_level=? WHERE id=?").run(assigned_class, student_id);
    }

    res.json({ result_id: id, score: correct, total, pct, assigned_class, section_scores, feedback });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tl/level-test/results', tlAuth, tlAdminOrInstructor, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM tl_level_results ORDER BY completed_at DESC LIMIT 100').all();
    res.json(rows.map(r => ({ ...r, section_scores: JSON.parse(r.section_scores||'{}') })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 섹션별 테스트 문제 ─────────────────────────────────────────────
app.get('/api/tl/questions', tlAuth, (req, res) => {
  try {
    const { section, university_type, limit=10 } = req.query;
    let q = `SELECT id,section,university_type,question_text,passage,option_a,option_b,option_c,option_d,difficulty
      FROM tl_test_questions WHERE 1=1`;
    const p = [];
    if (section) { q += ' AND section=?'; p.push(section); }
    if (university_type) { q += ' AND (university_type=? OR university_type=\'COMMON\')'; p.push(university_type); }
    q += ' ORDER BY RANDOM() LIMIT ?';
    p.push(parseInt(limit));
    res.json(db.prepare(q).all(...p));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tl/questions', tlAuth, tlAdminOrInstructor, (req, res) => {
  try {
    const { section, university_type='COMMON', question_text, passage='',
            option_a, option_b, option_c, option_d, correct_answer, explanation='', difficulty=2 } = req.body;
    if (!section||!question_text||!option_a||!option_b||!option_c||!option_d||!correct_answer)
      return res.status(400).json({ error: '필수 항목 누락' });
    const id = tlUid();
    db.prepare(`INSERT INTO tl_test_questions
      (id,section,university_type,question_text,passage,option_a,option_b,option_c,option_d,correct_answer,explanation,difficulty)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id,section,university_type,question_text,passage,option_a,option_b,option_c,option_d,
           correct_answer,explanation,difficulty);
    res.json({ ok:true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/tl/questions/:id', tlAuth, tlAdminOrInstructor, (req, res) => {
  try {
    db.prepare('DELETE FROM tl_test_questions WHERE id=?').run(req.params.id);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 전체 문제 목록 (관리자용)
app.get('/api/tl/questions/all', tlAuth, tlAdminOrInstructor, (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM tl_test_questions ORDER BY section, created_at DESC').all());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 단어장 ────────────────────────────────────────────────────────
app.get('/api/tl/vocab', tlAuth, (req, res) => {
  try {
    const { limit=20, difficulty } = req.query;
    let q = 'SELECT * FROM tl_vocab WHERE 1=1';
    const p = [];
    if (difficulty) { q += ' AND difficulty=?'; p.push(parseInt(difficulty)); }
    q += ' ORDER BY RANDOM() LIMIT ?';
    p.push(parseInt(limit));
    res.json(db.prepare(q).all(...p));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tl/vocab', tlAuth, tlAdminOrInstructor, (req, res) => {
  try {
    const { word, meaning, example='', difficulty=2, category='GENERAL' } = req.body;
    if (!word||!meaning) return res.status(400).json({ error: '단어/뜻 필수' });
    const id = tlUid();
    db.prepare('INSERT INTO tl_vocab (id,word,meaning,example,difficulty,category) VALUES (?,?,?,?,?,?)')
      .run(id,word,meaning,example,difficulty,category);
    res.json({ ok:true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 테스트 세션 ────────────────────────────────────────────────────
app.post('/api/tl/test/start', tlAuth, (req, res) => {
  try {
    if (req.tUser.role !== 'student') return res.status(403).json({ error: '학생만 테스트 가능' });
    const { session_type, university_type='COMMON', count=10, sections } = req.body;

    let questions = [];

    if (session_type === 'vocab') {
      questions = db.prepare('SELECT id,word,meaning,example,difficulty FROM tl_vocab ORDER BY RANDOM() LIMIT ?')
        .all(parseInt(count));
    } else if (session_type === 'mixed') {
      const sects = sections || ['어휘','문법','독해','논리'];
      const perSect = Math.max(2, Math.floor(count / sects.length));
      sects.forEach(s => {
        const qs = db.prepare(`SELECT id,section,question_text,passage,option_a,option_b,option_c,option_d,difficulty
          FROM tl_test_questions WHERE section=? AND (university_type=? OR university_type='COMMON')
          ORDER BY RANDOM() LIMIT ?`).all(s, university_type, perSect);
        questions.push(...qs);
      });
    } else if (session_type === 'university') {
      questions = db.prepare(`SELECT id,section,university_type,question_text,passage,option_a,option_b,option_c,option_d,difficulty
        FROM tl_test_questions WHERE university_type=? ORDER BY RANDOM() LIMIT ?`)
        .all(university_type, parseInt(count));
    } else {
      // grammar / reading / logic / vocab_section(어휘) — university_type 무관하게 전체 포함
      const sectionMap = { grammar:'문법', reading:'독해', logic:'논리', vocab_section:'어휘' };
      const section = sectionMap[session_type] || session_type;
      questions = db.prepare(`SELECT id,section,question_text,passage,option_a,option_b,option_c,option_d,difficulty,tags
        FROM tl_test_questions WHERE section=?
        ORDER BY RANDOM() LIMIT ?`).all(section, parseInt(count));
    }

    if (!questions.length) return res.status(404).json({ error: '문제를 찾을 수 없습니다. 강사에게 문제 등록을 요청하세요.' });

    // vocab_section은 CHECK constraint 우회를 위해 'grammar'로 저장하되 display_type 보존
    const VALID_TYPES = ['vocab','grammar','reading','logic','mixed','university'];
    const storeType   = VALID_TYPES.includes(session_type) ? session_type : 'grammar';
    const displayType = session_type; // 원본 타입 별도 저장

    const id = tlUid();
    db.prepare(`INSERT INTO tl_test_sessions
      (id,student_id,session_type,display_type,university_type,questions,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, req.tUser.id, storeType, displayType, university_type,
           JSON.stringify(questions.map(q=>q.id)), Math.floor(Date.now()/1000));

    res.json({ session_id: id, questions });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tl/test/submit', tlAuth, (req, res) => {
  try {
    if (req.tUser.role !== 'student') return res.status(403).json({ error: '학생만 제출 가능' });
    const { session_id, answers } = req.body;
    const session = db.prepare('SELECT * FROM tl_test_sessions WHERE id=? AND student_id=?')
      .get(session_id, req.tUser.id);
    if (!session) return res.status(404).json({ error: '세션 없음' });

    const qIds = JSON.parse(session.questions||'[]');
    const isVocab = session.session_type === 'vocab';

    let correct = 0, total = qIds.length;
    const sectionCorrect = {}, sectionTotal = {};
    const feedback = [];

    if (isVocab) {
      const words = db.prepare(`SELECT * FROM tl_vocab WHERE id IN (${qIds.map(()=>'?').join(',')})`)
        .all(...qIds);
      const wMap = Object.fromEntries(words.map(w=>[w.id,w]));
      Object.entries(answers).forEach(([wid, userAns]) => {
        const w = wMap[wid];
        if (!w) return;
        // vocab test: user types the meaning; check if it contains key words
        const correctMeaning = w.meaning.toLowerCase();
        const userLower = (userAns||'').toLowerCase().trim();
        const isCorrect = userLower.length > 0 &&
          (correctMeaning.includes(userLower) || userLower.includes(correctMeaning.split(',')[0].split(' ').slice(0,2).join(' ')));
        if (isCorrect) correct++;
        feedback.push({ wid, word: w.word, meaning: w.meaning, userAnswer: userAns, correct: isCorrect });
      });
    } else {
      const questions = db.prepare(`SELECT * FROM tl_test_questions WHERE id IN (${qIds.map(()=>'?').join(',')})`)
        .all(...qIds);
      const qMap = Object.fromEntries(questions.map(q=>[q.id,q]));
      Object.entries(answers).forEach(([qid,ans]) => {
        const q = qMap[qid];
        if (!q) return;
        const s = q.section||'기타';
        sectionTotal[s] = (sectionTotal[s]||0)+1;
        const isCorrect = ans === q.correct_answer;
        if (isCorrect) { correct++; sectionCorrect[s] = (sectionCorrect[s]||0)+1; }
        feedback.push({ qid, section: s, correct: isCorrect,
                        correct_answer: q.correct_answer, explanation: q.explanation||'',
                        question_text: q.question_text, tags: q.tags||'' });
      });
    }

    const sectionScores = {};
    Object.keys(sectionTotal).forEach(s => {
      sectionScores[s] = { correct: sectionCorrect[s]||0, total: sectionTotal[s],
                           pct: Math.round((sectionCorrect[s]||0)/sectionTotal[s]*100) };
    });

    // 문항별 결과 저장 (세부 분석용)
    const qResults = feedback.map(f => ({
      qid: f.qid||f.wid, correct: f.correct,
      section: f.section||'어휘', tags: f.tags||''
    }));

    const pct = total > 0 ? Math.round(correct/total*100) : 0;
    const now = Math.floor(Date.now()/1000);
    db.prepare(`UPDATE tl_test_sessions
      SET answers=?, score=?, total=?, section_scores=?, question_results=?, completed_at=? WHERE id=?`)
      .run(JSON.stringify(answers), correct, total, JSON.stringify(sectionScores),
           JSON.stringify(qResults), now, session_id);

    res.json({ score: correct, total, pct, section_scores: sectionScores, feedback });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tl/test/history', tlAuth, (req, res) => {
  try {
    const sid = req.tUser.role === 'student' ? req.tUser.id : req.query.student_id;
    if (!sid) return res.status(400).json({ error: 'student_id 필요' });
    const rows = db.prepare(`
      SELECT id,session_type,university_type,score,total,section_scores,completed_at,created_at
      FROM tl_test_sessions WHERE student_id=? AND completed_at IS NOT NULL
      ORDER BY completed_at DESC LIMIT 50`).all(sid);
    res.json(rows.map(r => ({
      ...r,
      section_scores: r.section_scores ? JSON.parse(r.section_scores) : {},
      pct: r.total > 0 ? Math.round(r.score/r.total*100) : 0,
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 내 레벨테스트 최근 결과 ────────────────────────────────────────
app.get('/api/tl/level-test/my-result', tlAuth, (req, res) => {
  try {
    const result = db.prepare(
      'SELECT * FROM tl_level_results WHERE student_id=? ORDER BY completed_at DESC LIMIT 1'
    ).get(req.tUser.id);
    if (!result) return res.json(null);
    result.section_scores = result.section_scores ? JSON.parse(result.section_scores) : {};
    result.pct = result.total_questions > 0
      ? Math.round(result.total_score / result.total_questions * 100) : 0;
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 강약점 분석 ────────────────────────────────────────────────────
app.get('/api/tl/analytics', tlAuth, (req, res) => {
  try {
    const sid = req.tUser.role === 'student' ? req.tUser.id : req.query.student_id;
    if (!sid) return res.status(400).json({ error: 'student_id 필요' });

    const sessions = db.prepare(`
      SELECT session_type,score,total,section_scores,completed_at FROM tl_test_sessions
      WHERE student_id=? AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 100`).all(sid);

    if (!sessions.length) return res.json({ message: '테스트 기록 없음', sections: {}, overall: 0 });

    // ── 섹션별 집계 ─────────────────────────────────────────────
    const sectionAgg = {};
    sessions.forEach(s => {
      const scores = s.section_scores ? JSON.parse(s.section_scores) : {};
      Object.entries(scores).forEach(([sec, data]) => {
        if (!sectionAgg[sec]) sectionAgg[sec] = { correct:0, total:0 };
        sectionAgg[sec].correct += data.correct||0;
        sectionAgg[sec].total   += data.total||0;
      });
    });

    // ── 태그별 세부 집계 ────────────────────────────────────────
    const tagSessions = db.prepare(`
      SELECT question_results FROM tl_test_sessions
      WHERE student_id=? AND completed_at IS NOT NULL AND question_results IS NOT NULL`).all(sid);

    const tagAgg = {}; // { section: { tag: { correct, total } } }
    tagSessions.forEach(s => {
      const results = JSON.parse(s.question_results || '[]');
      results.forEach(r => {
        const sec  = r.section || '기타';
        const tags = (r.tags || '').split(',').map(t=>t.trim()).filter(Boolean);
        if (!tags.length) return;
        if (!tagAgg[sec]) tagAgg[sec] = {};
        tags.forEach(tag => {
          if (!tagAgg[sec][tag]) tagAgg[sec][tag] = { correct:0, total:0 };
          tagAgg[sec][tag].total++;
          if (r.correct) tagAgg[sec][tag].correct++;
        });
      });
    });

    // 세부요소 pct 계산
    const subElements = {};
    Object.entries(tagAgg).forEach(([sec, tags]) => {
      subElements[sec] = {};
      Object.entries(tags).forEach(([tag, {correct,total}]) => {
        subElements[sec][tag] = { correct, total,
          pct: total>0 ? Math.round(correct/total*100) : 0 };
      });
    });

    // ── 섹션별 권장 세부요소 (태그 없을 때 기본 가이드) ────────────
    const SUB_GUIDE = {
      '어휘': ['동의어·유의어','반의어','빈칸·문맥추론','숙어·표현','고급어휘'],
      '문법': ['시제·완료','가정법·도치','분사·관계사','수일치·명사','전치사·접속사'],
      '독해': ['주제·요지','빈칸완성','내용일치','글의구조·흐름','무관문장'],
      '논리': ['연결어','순서·배열','논지약화·강화','추론·결론','무관문장·완성'],
    };

    const sectionResults = {};
    let totalCorrect=0, totalQ=0;
    Object.entries(sectionAgg).forEach(([sec,{correct,total}]) => {
      const pct = total>0 ? Math.round(correct/total*100) : 0;
      const level = pct>=80?'우수':pct>=60?'보통':'취약';
      // 태그 데이터가 없을 때 섹션 점수 기반 세부요소 추정
      const tagData = subElements[sec] || {};
      const subGuide = SUB_GUIDE[sec] || [];
      const subElementsForSec = {};
      if (Object.keys(tagData).length > 0) {
        Object.assign(subElementsForSec, tagData);
      } else {
        // 태그 없음: 섹션 점수에 가우시안 노이즈를 추가해 추정값 제공
        subGuide.forEach((tag, i) => {
          const offset = [0, -8, +6, -12, +4][i] || 0;
          const est = Math.max(0, Math.min(100, pct + offset));
          subElementsForSec[tag] = { correct: Math.round(est/100*10), total:10, pct: est, estimated: true };
        });
      }
      sectionResults[sec] = { correct, total, pct, level, sub: subElementsForSec,
        feedback: pct>=80
          ? `${sec} 우수! 심화 문제와 학교별 유형에 도전하세요.`
          : pct>=60
          ? `${sec} 보통. 틀린 유형을 집중 복습하세요.`
          : `${sec} 취약! 기초 개념을 다시 학습하세요.`
      };
      totalCorrect += correct; totalQ += total;
    });

    const overall = totalQ>0 ? Math.round(totalCorrect/totalQ*100) : 0;
    const weak   = Object.entries(sectionResults).filter(([,v])=>v.pct<60).map(([k])=>k);
    const strong = Object.entries(sectionResults).filter(([,v])=>v.pct>=80).map(([k])=>k);

    const recommendations = [];
    if (weak.includes('어휘')) recommendations.push('어휘: 동의어·반의어 위주로 매일 10단어 암기, 단어 테스트 꾸준히 반복하세요.');
    if (weak.includes('문법')) recommendations.push('문법: 시제·가정법·관계사 핵심 규칙을 정리하고 오답 노트를 작성하세요.');
    if (weak.includes('독해')) recommendations.push('독해: 지문을 소리 내어 읽고 문단별 핵심 문장을 한 줄 요약 연습하세요.');
    if (weak.includes('논리')) recommendations.push('논리: 연결어·순서배열 유형부터 패턴을 익히고 논증 구조 분석을 연습하세요.');
    if (!weak.length) recommendations.push('전 영역 양호! 학교 유형별 테스트로 목표 대학 패턴을 집중 연습하세요.');

    res.json({
      overall, sections: sectionResults, weak, strong,
      test_count: sessions.length, recommendations,
      last_test: sessions[0]?.completed_at,
      sub_elements: subElements,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 관리자 대시보드 통계 ──────────────────────────────────────────
app.get('/api/tl/admin/stats', tlAuth, tlAdmin, (req, res) => {
  try {
    const students   = db.prepare("SELECT COUNT(*) as c FROM tl_users WHERE role='student'").get().c;
    const instructors= db.prepare("SELECT COUNT(*) as c FROM tl_users WHERE role='instructor'").get().c;
    const classA     = db.prepare("SELECT COUNT(*) as c FROM tl_users WHERE role='student' AND class_level='A'").get().c;
    const classB     = db.prepare("SELECT COUNT(*) as c FROM tl_users WHERE role='student' AND class_level='B'").get().c;
    const classC     = db.prepare("SELECT COUNT(*) as c FROM tl_users WHERE role='student' AND class_level='C'").get().c;
    const unassigned = db.prepare("SELECT COUNT(*) as c FROM tl_users WHERE role='student' AND class_level='unassigned'").get().c;
    const recordings = db.prepare("SELECT COUNT(*) as c FROM tl_recordings").get().c;
    const tests      = db.prepare("SELECT COUNT(*) as c FROM tl_test_sessions WHERE completed_at IS NOT NULL").get().c;
    const levelTests = db.prepare("SELECT COUNT(*) as c FROM tl_level_results").get().c;
    const todayTests = db.prepare(`SELECT COUNT(*) as c FROM tl_test_sessions
      WHERE completed_at >= strftime('%s',date('now')) AND completed_at IS NOT NULL`).get().c;
    res.json({ students, instructors, classA, classB, classC, unassigned, recordings, tests, levelTests, todayTests });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 내 정보 조회 ───────────────────────────────────────────────────
app.get('/api/tl/me', tlAuth, (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM tl_users WHERE id=?').get(req.tUser.id);
    if (!user) return res.status(404).json({ error: '사용자 없음' });
    const { password_hash, ...safe } = user;
    res.json(safe);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 학생 테스트 현황 (강사/관리자용) ──────────────────────────────
app.get('/api/tl/students/:id/stats', tlAuth, tlAdminOrInstructor, (req, res) => {
  try {
    const user = db.prepare("SELECT * FROM tl_users WHERE id=? AND role='student'").get(req.params.id);
    if (!user) return res.status(404).json({ error: '학생 없음' });
    const { password_hash, ...safe } = user;
    const sessions = db.prepare(`
      SELECT session_type,score,total,pct,section_scores,completed_at FROM tl_test_sessions
      WHERE student_id=? AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 20`)
      .all(req.params.id)
      .map(s => ({ ...s, pct: s.total>0?Math.round(s.score/s.total*100):0,
                          section_scores: s.section_scores?JSON.parse(s.section_scores):{} }));
    const levelResult = db.prepare(`SELECT * FROM tl_level_results WHERE student_id=? ORDER BY completed_at DESC LIMIT 1`)
      .get(req.params.id);
    res.json({ user: safe, sessions, levelResult });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 오늘의 학습 현황 (학생용) ────────────────────────────────────
app.get('/api/tl/today', tlAuth, (req, res) => {
  try {
    const today = new Date().toISOString().slice(0,10);
    const schedule = db.prepare(`
      SELECT s.*, u.name as instructor_name FROM tl_schedule s
      LEFT JOIN tl_users u ON s.instructor_id=u.id
      WHERE s.class_date=? ORDER BY s.period`).all(today);
    const recordings = db.prepare(`
      SELECT r.*, u.name as instructor_name FROM tl_recordings r
      LEFT JOIN tl_users u ON r.instructor_id=u.id
      WHERE r.class_date=? ORDER BY r.period`).all(today);
    const todayTests = db.prepare(`
      SELECT id,session_type,score,total,completed_at FROM tl_test_sessions
      WHERE student_id=? AND completed_at >= strftime('%s',date('now')) AND completed_at IS NOT NULL`)
      .all(req.tUser.id);
    res.json({ schedule, recordings, todayTests, date: today });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════
//  ERP — 빅링커 사내 통합 업무 시스템
//  대표(ceo) · 관리자(manager) · 직원(employee)
// ═══════════════════════════════════════════════════════

try { db.exec("ALTER TABLE users ADD COLUMN erp_role TEXT DEFAULT NULL"); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS erp_employees (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    department TEXT DEFAULT '운영팀',
    position TEXT DEFAULT '직원',
    employment_type TEXT DEFAULT '정규직',
    hire_date TEXT,
    base_salary INTEGER DEFAULT 0,
    phone TEXT DEFAULT '',
    emergency_contact TEXT DEFAULT '',
    bank_info TEXT DEFAULT '',
    status TEXT DEFAULT '재직'
  );
  CREATE TABLE IF NOT EXISTS erp_attendance (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    work_date TEXT NOT NULL,
    check_in TEXT,
    check_out TEXT,
    work_hours REAL DEFAULT 0,
    status TEXT DEFAULT '정상',
    note TEXT DEFAULT '',
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS erp_tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    assignee_id TEXT REFERENCES users(id),
    creator_id TEXT NOT NULL REFERENCES users(id),
    priority TEXT DEFAULT '보통',
    status TEXT DEFAULT '대기',
    due_date TEXT,
    category TEXT DEFAULT '일반',
    completed_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS erp_schedules (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    creator_id TEXT REFERENCES users(id),
    attendees TEXT DEFAULT '[]',
    type TEXT DEFAULT '일반',
    start_dt TEXT NOT NULL,
    end_dt TEXT,
    location TEXT DEFAULT '',
    all_day INTEGER DEFAULT 0,
    color TEXT DEFAULT '#4f7dff',
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS erp_notices (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    author_id TEXT REFERENCES users(id),
    target TEXT DEFAULT '전체',
    is_pinned INTEGER DEFAULT 0,
    views INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS erp_approvals (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT DEFAULT '',
    requester_id TEXT NOT NULL REFERENCES users(id),
    approver_id TEXT REFERENCES users(id),
    status TEXT DEFAULT '대기',
    approver_note TEXT DEFAULT '',
    requested_at INTEGER DEFAULT (strftime('%s','now')),
    processed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS erp_revenue (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    amount INTEGER NOT NULL,
    category TEXT DEFAULT '수강료',
    client_id TEXT REFERENCES users(id),
    payment_date TEXT,
    status TEXT DEFAULT '완료',
    note TEXT DEFAULT '',
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS erp_expenses (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    amount INTEGER NOT NULL,
    category TEXT DEFAULT '운영비',
    spender_id TEXT REFERENCES users(id),
    expense_date TEXT,
    status TEXT DEFAULT '승인',
    note TEXT DEFAULT '',
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS erp_okrs (
    id TEXT PRIMARY KEY,
    objective TEXT NOT NULL,
    key_result TEXT NOT NULL,
    owner_id TEXT REFERENCES users(id),
    quarter TEXT DEFAULT '',
    progress INTEGER DEFAULT 0,
    status TEXT DEFAULT '진행중',
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS erp_payroll (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    year_month TEXT NOT NULL,
    base_salary INTEGER DEFAULT 0,
    bonus INTEGER DEFAULT 0,
    deduction INTEGER DEFAULT 0,
    net_salary INTEGER DEFAULT 0,
    status TEXT DEFAULT '예정',
    payment_date TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  /* 연차/휴가 신청 */
  CREATE TABLE IF NOT EXISTS erp_leave_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    leave_type TEXT NOT NULL CHECK(leave_type IN ('연차','병가','경조사','기타')),
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    num_days REAL NOT NULL,
    reason TEXT DEFAULT '',
    approver_id TEXT REFERENCES users(id),
    status TEXT DEFAULT '신청',
    approver_note TEXT DEFAULT '',
    requested_at INTEGER DEFAULT (strftime('%s','now')),
    processed_at INTEGER
  );

  /* 개인별 월별 매출 */
  CREATE TABLE IF NOT EXISTS erp_individual_sales (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    year_month TEXT NOT NULL,
    amount INTEGER DEFAULT 0,
    category TEXT DEFAULT '컨설팅',
    description TEXT DEFAULT '',
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now')),
    UNIQUE(user_id, year_month, category)
  );

  /* 출퇴근 상세 기록 (휴가/휴무 정보 추가) */
  ALTER TABLE erp_attendance ADD COLUMN leave_type TEXT DEFAULT NULL;
  ALTER TABLE erp_attendance ADD COLUMN leave_reason TEXT DEFAULT '';
  ALTER TABLE erp_attendance ADD COLUMN leave_approved_by TEXT;
`);

try {
  db.exec(`
    ALTER TABLE erp_attendance ADD COLUMN leave_type TEXT DEFAULT NULL;
    ALTER TABLE erp_attendance ADD COLUMN leave_reason TEXT DEFAULT '';
    ALTER TABLE erp_attendance ADD COLUMN leave_approved_by TEXT;
  `);
} catch {}

// 인덱스
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_erp_leave ON erp_leave_requests(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_erp_sales ON erp_individual_sales(user_id, year_month);
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_erp_att ON erp_attendance(user_id, work_date);
  CREATE INDEX IF NOT EXISTS idx_erp_task_a ON erp_tasks(assignee_id, status);
  CREATE INDEX IF NOT EXISTS idx_erp_sched ON erp_schedules(start_dt);
  CREATE INDEX IF NOT EXISTS idx_erp_notice ON erp_notices(is_pinned DESC, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_erp_appr_r ON erp_approvals(requester_id, status);
  CREATE INDEX IF NOT EXISTS idx_erp_appr_a ON erp_approvals(approver_id, status);
`);

function seedErp() {
  if (!db.prepare("SELECT id FROM users WHERE username='ceo'").get()) {
    const h = bcrypt.hashSync('ceo1234', 10);
    db.prepare("INSERT OR IGNORE INTO users (id,username,password_hash,role,name,erp_role) VALUES (?,?,?,?,?,?)")
      .run('erp_ceo','ceo',h,'admin','대표이사','ceo');
    db.prepare("INSERT OR IGNORE INTO erp_employees (user_id,department,position,employment_type,hire_date,base_salary,phone) VALUES (?,?,?,?,?,?,?)")
      .run('erp_ceo','경영진','대표이사','정규직','2020-03-01',0,'010-1000-0001');
  }
  db.prepare("UPDATE users SET erp_role='manager' WHERE role='admin' AND erp_role IS NULL").run();
  db.prepare("UPDATE users SET erp_role='employee' WHERE role='consultant' AND erp_role IS NULL").run();

  const empIns = db.prepare("INSERT OR IGNORE INTO erp_employees (user_id,department,position,employment_type,hire_date,base_salary) VALUES (?,?,?,?,?,?)");
  db.prepare("SELECT * FROM users WHERE erp_role IN ('ceo','manager','employee')").all().forEach(u => {
    const dept = u.erp_role==='ceo'?'경영진':u.role==='admin'?'운영팀':'컨설팅팀';
    const pos  = u.erp_role==='ceo'?'대표이사':u.role==='admin'?'팀장':'컨설턴트';
    const hd   = u.created_at ? new Date(u.created_at*1000).toISOString().slice(0,10) : '2024-01-01';
    empIns.run(u.id, dept, pos, '정규직', hd, 0);
  });

  if (!db.prepare("SELECT id FROM erp_revenue LIMIT 1").get()) {
    const ri = db.prepare("INSERT OR IGNORE INTO erp_revenue (id,title,amount,category,payment_date,status,note) VALUES (?,?,?,?,?,?,?)");
    [['2026-02','1800000'],['2026-03','2100000'],['2026-04','2350000'],['2026-05','1950000']].forEach(([m,a],i)=>{
      ri.run(`rev_${i*3+1}`,`${m} 수강료 수납`,parseInt(a),'수강료',`${m}-10`,'완료','');
      ri.run(`rev_${i*3+2}`,`${m} 컨설팅비`,650000,'컨설팅비',`${m}-15`,'완료','');
      if(i===2) ri.run(`rev_${i*3+3}`,'기업교육 강의료',2500000,'기업교육','2026-04-20','완료','A기업 직원 연수');
    });
    ri.run('rev_13','국제협력 프로그램비',1200000,'기타','2026-05-05','완료','');
  }
  if (!db.prepare("SELECT id FROM erp_expenses LIMIT 1").get()) {
    const ei = db.prepare("INSERT OR IGNORE INTO erp_expenses (id,title,amount,category,expense_date,status) VALUES (?,?,?,?,?,?)");
    [['exp_1','사무실 임대료',900000,'임대료','2026-05-01'],
     ['exp_2','인터넷·전기 요금',87000,'공과금','2026-05-08'],
     ['exp_3','교육 교재 구매',145000,'교재비','2026-05-10'],
     ['exp_4','마케팅 광고비',300000,'마케팅','2026-05-12'],
     ['exp_5','소프트웨어 구독',55000,'IT비용','2026-05-01'],
     ['exp_6','회식비',120000,'복리후생','2026-05-15']].forEach(r=>ei.run(...r,'승인'));
  }
  if (!db.prepare("SELECT id FROM erp_notices LIMIT 1").get()) {
    const ni = db.prepare("INSERT OR IGNORE INTO erp_notices (id,title,content,author_id,target,is_pinned,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)");
    const now = Math.floor(Date.now()/1000);
    ni.run('nt_1','[필독] 2026년 5월 사내 공지','5월 한 달 동안 신규 학생 모집이 진행됩니다. 각 컨설턴트분들은 담당 학생 면담 일정을 반드시 확인해주세요. 이달 목표 달성을 위해 적극적인 참여 부탁드립니다.','erp_ceo','전체',1,now-86400*3,now-86400*3);
    ni.run('nt_2','수시 컨설팅 강화 방안 공유','2027학년도 수시 전략 강화를 위한 내부 교육을 진행합니다.\n일정: 5/25(월) 오후 3시\n장소: 대회의실\n참석 대상: 전 컨설턴트','adm_1','전체',0,now-86400,now-86400);
    ni.run('nt_3','[필독] 개인정보 보호 교육 안내','연 1회 의무 개인정보 보호 교육이 실시됩니다. 6/1까지 온라인 교육 이수 후 확인서를 운영팀에 제출해주세요.','adm_1','전체',0,now-3600*2,now-3600*2);
  }
  if (!db.prepare("SELECT id FROM erp_okrs LIMIT 1").get()) {
    const oi = db.prepare("INSERT OR IGNORE INTO erp_okrs (id,objective,key_result,owner_id,quarter,progress,status) VALUES (?,?,?,?,?,?,?)");
    oi.run('okr_1','2026 Q2 수강생 만족도 최고치 달성','수강생 만족도 설문 평균 4.5점 이상 달성','erp_ceo','2026-Q2',68,'진행중');
    oi.run('okr_2','2026 Q2 수강생 만족도 최고치 달성','컨설팅 피드백 응답률 95% 이상 유지','adm_1','2026-Q2',82,'진행중');
    oi.run('okr_3','신규 사업 영역 개척','기업교육 계약 3건 이상 신규 수주','erp_ceo','2026-Q2',33,'진행중');
    oi.run('okr_4','신규 사업 영역 개척','국제협력 파트너 2개 기관 이상 확보','erp_ceo','2026-Q2',50,'진행중');
    oi.run('okr_5','내부 운영 효율화','업무 자동화로 주당 반복 업무 2시간 절감','adm_1','2026-Q2',40,'진행중');
  }
  if (!db.prepare("SELECT id FROM erp_tasks LIMIT 1").get()) {
    const ti = db.prepare("INSERT OR IGNORE INTO erp_tasks (id,title,description,assignee_id,creator_id,priority,status,due_date,category) VALUES (?,?,?,?,?,?,?,?,?)");
    const nw = new Date(Date.now()+7*86400000).toISOString().slice(0,10);
    const td = new Date().toISOString().slice(0,10);
    ti.run('tsk_1','5월 학생 성과 보고서 작성','담당 학생 전체 역량 분석 결과 취합 및 보고서 작성','cons_1','adm_1','높음','진행중',nw,'보고');
    ti.run('tsk_2','신규 수강생 온보딩 자료 업데이트','2026년 기준 최신 입학 요강 반영','cons_1','adm_1','보통','대기',nw,'운영');
    ti.run('tsk_3','홈페이지 서비스 소개 개선','gobiglinker.com 용역 서비스 상세 설명 추가','adm_1','erp_ceo','보통','대기',nw,'IT');
    ti.run('tsk_4','6월 기업교육 제안서 작성','B기업 방문 교육 제안서 초안 준비','adm_1','erp_ceo','긴급','진행중',td,'영업');
    ti.run('tsk_5','컨설턴트 역량 교육 일정 수립','수시 전략 심화 교육 커리큘럼 기획','adm_1','erp_ceo','보통','완료',td,'교육');
  }
  if (!db.prepare("SELECT id FROM erp_approvals LIMIT 1").get()) {
    const ai = db.prepare("INSERT OR IGNORE INTO erp_approvals (id,type,title,content,requester_id,approver_id,status,requested_at) VALUES (?,?,?,?,?,?,?,?)");
    const now = Math.floor(Date.now()/1000);
    ai.run('appr_1','휴가신청','[연차] 5/30(금) 연차 1일 신청','개인 사정으로 연차를 신청합니다.','cons_1','adm_1','대기',now-3600*5);
    ai.run('appr_2','지출결의','교육 교재 구매비 145,000원','신규 수강생 배부용 교재 구매 승인 요청','cons_1','adm_1','승인',now-86400*2);
    ai.run('appr_3','업무보고','5월 3주차 주간 업무 보고','수행 업무: 학생 4명 세특 피드백, 신규 면담 2건','cons_1','adm_1','승인',now-86400*7);
  }
  log('info','[ERP] 시드 완료');
}
seedErp();

// ── ERP 인증 미들웨어 ─────────────────────────────────
function erpGetRole(userId) {
  const u = db.prepare("SELECT erp_role, role FROM users WHERE id=?").get(userId);
  if (!u) return null;
  if (u.erp_role) return u.erp_role;
  if (u.role === 'admin') return 'manager';
  if (u.role === 'consultant') return 'employee';
  return null;
}

function erpAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: '로그인이 필요합니다' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    req.user.erpRole = erpGetRole(req.user.id);
    if (!req.user.erpRole) return res.status(403).json({ error: 'ERP 접근 권한이 없습니다' });
    next();
  } catch { res.status(401).json({ error: '세션이 만료되었습니다' }); }
}

function erpManager(req, res, next) {
  if (!['ceo','manager'].includes(req.user.erpRole))
    return res.status(403).json({ error: '관리자 이상 권한이 필요합니다' });
  next();
}

function erpCeo(req, res, next) {
  if (req.user.erpRole !== 'ceo')
    return res.status(403).json({ error: '대표 권한이 필요합니다' });
  next();
}

// ── ERP 현재 사용자 ──────────────────────────────────
app.get('/api/erp/me', erpAuth, (req, res) => {
  const u = db.prepare("SELECT id,name,username,role,erp_role FROM users WHERE id=?").get(req.user.id);
  const emp = db.prepare("SELECT * FROM erp_employees WHERE user_id=?").get(u.id);
  res.json({ id:u.id, name:u.name, username:u.username, role:u.role, erpRole:req.user.erpRole,
    department:emp?.department||'', position:emp?.position||'', status:emp?.status||'재직',
    hire_date:emp?.hire_date||'', base_salary:emp?.base_salary||0, phone:emp?.phone||'' });
});

// ── ERP 대시보드 ─────────────────────────────────────
app.get('/api/erp/dashboard', erpAuth, (req, res) => {
  const role = req.user.erpRole;
  const today = new Date().toISOString().slice(0,10);
  const thisMonth = today.slice(0,7);

  const notices = db.prepare("SELECT id,title,is_pinned,created_at FROM erp_notices ORDER BY is_pinned DESC,created_at DESC LIMIT 5").all();
  const myTasks = db.prepare("SELECT id,title,priority,status,due_date FROM erp_tasks WHERE assignee_id=? AND status!='완료' ORDER BY priority DESC,due_date LIMIT 8").all(req.user.id);
  const todayAtt = db.prepare("SELECT check_in,check_out,status FROM erp_attendance WHERE user_id=? AND work_date=?").get(req.user.id, today);
  const base = { notices, myTasks, todayAttendance: todayAtt||null, today };

  if (role === 'ceo') {
    const monthRev = db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM erp_revenue WHERE strftime('%Y-%m',payment_date)=? AND status='완료'").get(thisMonth)?.t||0;
    const monthExp = db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM erp_expenses WHERE strftime('%Y-%m',expense_date)=? AND status='승인'").get(thisMonth)?.t||0;
    const totalStudents = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='student'").get()?.n||0;
    const totalEmp = db.prepare("SELECT COUNT(*) AS n FROM erp_employees WHERE status='재직'").get()?.n||0;
    const pendingAppr = db.prepare("SELECT COUNT(*) AS n FROM erp_approvals WHERE status='대기'").get()?.n||0;
    const monthlyRev = db.prepare("SELECT strftime('%Y-%m',payment_date) AS m, SUM(amount) AS t FROM erp_revenue WHERE status='완료' AND payment_date>=date('now','-5 months') GROUP BY m ORDER BY m").all();
    const monthlyExp = db.prepare("SELECT strftime('%Y-%m',expense_date) AS m, SUM(amount) AS t FROM erp_expenses WHERE status='승인' AND expense_date>=date('now','-5 months') GROUP BY m ORDER BY m").all();
    const teamAtt = db.prepare("SELECT u.id,u.name,e.department,a.check_in,a.check_out,a.status FROM users u LEFT JOIN erp_employees e ON u.id=e.user_id LEFT JOIN erp_attendance a ON u.id=a.user_id AND a.work_date=? WHERE u.erp_role IS NOT NULL AND u.role!='student' ORDER BY e.department,u.name").all(today);
    const pendingApprList = db.prepare("SELECT a.*,r.name AS rname FROM erp_approvals a LEFT JOIN users r ON a.requester_id=r.id WHERE a.status='대기' ORDER BY a.requested_at DESC LIMIT 5").all();
    return res.json({...base, kpi:{monthRev,monthExp,profit:monthRev-monthExp,totalStudents,totalEmp,pendingAppr}, monthlyRev, monthlyExp, teamAtt, pendingApprList});
  }

  if (role === 'manager') {
    const pendingAppr = db.prepare("SELECT COUNT(*) AS n FROM erp_approvals WHERE approver_id=? AND status='대기'").get(req.user.id)?.n||0;
    const teamTasks = db.prepare("SELECT t.*,u.name AS aname FROM erp_tasks t LEFT JOIN users u ON t.assignee_id=u.id WHERE t.status!='완료' ORDER BY CASE t.priority WHEN '긴급' THEN 0 WHEN '높음' THEN 1 ELSE 2 END,t.due_date LIMIT 15").all();
    const teamAtt = db.prepare("SELECT u.id,u.name,e.department,a.check_in,a.check_out,a.status FROM users u LEFT JOIN erp_employees e ON u.id=e.user_id LEFT JOIN erp_attendance a ON u.id=a.user_id AND a.work_date=? WHERE u.role IN ('consultant','admin') OR u.erp_role IN ('employee','manager') ORDER BY u.name").all(today);
    const studentCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='student'").get()?.n||0;
    return res.json({...base, pendingAppr, teamTasks, teamAtt, studentCount});
  }

  const myApprovals = db.prepare("SELECT id,type,title,status,requested_at FROM erp_approvals WHERE requester_id=? ORDER BY requested_at DESC LIMIT 5").all(req.user.id);
  const myStudents = db.prepare("SELECT id,name,school,grade,target_univ FROM users WHERE consultant_id=? AND role='student'").all(req.user.id);
  res.json({...base, myApprovals, myStudents});
});

// ── 직원 관리 ────────────────────────────────────────
app.get('/api/erp/employees', erpAuth, erpManager, (req, res) => {
  res.json(db.prepare("SELECT u.id,u.name,u.username,u.role,u.erp_role,u.email,e.department,e.position,e.employment_type,e.hire_date,e.base_salary,e.phone,e.status FROM users u LEFT JOIN erp_employees e ON u.id=e.user_id WHERE u.erp_role IS NOT NULL AND u.role!='student' ORDER BY e.department,u.name").all());
});

app.put('/api/erp/employees/:id', erpAuth, erpManager, (req, res) => {
  const {department,position,employment_type,hire_date,base_salary,phone,emergency_contact,bank_info,status} = req.body;
  db.prepare("INSERT INTO erp_employees (user_id,department,position,employment_type,hire_date,base_salary,phone,emergency_contact,bank_info,status) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET department=excluded.department,position=excluded.position,employment_type=excluded.employment_type,hire_date=excluded.hire_date,base_salary=excluded.base_salary,phone=excluded.phone,emergency_contact=excluded.emergency_contact,bank_info=excluded.bank_info,status=excluded.status")
    .run(req.params.id,department||'',position||'',employment_type||'정규직',hire_date||'',parseInt(base_salary)||0,phone||'',emergency_contact||'',bank_info||'',status||'재직');
  res.json({success:true});
});

// ── 출퇴근 ───────────────────────────────────────────
app.get('/api/erp/attendance', erpAuth, (req, res) => {
  const targetId = req.user.erpRole==='employee' ? req.user.id : (req.query.userId||req.user.id);
  const from = req.query.from || new Date(Date.now()-30*86400000).toISOString().slice(0,10);
  const to   = req.query.to   || new Date().toISOString().slice(0,10);
  res.json(db.prepare("SELECT a.*,u.name FROM erp_attendance a JOIN users u ON a.user_id=u.id WHERE a.user_id=? AND a.work_date BETWEEN ? AND ? ORDER BY a.work_date DESC").all(targetId,from,to));
});

app.get('/api/erp/attendance/team', erpAuth, erpManager, (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0,10);
  res.json(db.prepare("SELECT u.id,u.name,u.role,e.department,e.position,a.check_in,a.check_out,a.status,a.work_hours,a.note FROM users u LEFT JOIN erp_employees e ON u.id=e.user_id LEFT JOIN erp_attendance a ON u.id=a.user_id AND a.work_date=? WHERE u.erp_role IS NOT NULL AND u.role!='student' ORDER BY e.department,u.name").all(date));
});

app.post('/api/erp/attendance/checkin', erpAuth, (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const now   = new Date().toTimeString().slice(0,5);
  if (db.prepare("SELECT id FROM erp_attendance WHERE user_id=? AND work_date=?").get(req.user.id,today))
    return res.status(400).json({error:'이미 출근 처리되었습니다'});
  const status = parseInt(now.split(':')[0]) >= 9 ? '지각' : '정상';
  const id = uid();
  db.prepare("INSERT INTO erp_attendance (id,user_id,work_date,check_in,status) VALUES (?,?,?,?,?)").run(id,req.user.id,today,now,status);
  res.json({success:true,checkIn:now,status,id});
});

app.post('/api/erp/attendance/checkout', erpAuth, (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const now   = new Date().toTimeString().slice(0,5);
  const att = db.prepare("SELECT * FROM erp_attendance WHERE user_id=? AND work_date=?").get(req.user.id,today);
  if (!att) return res.status(400).json({error:'출근 기록이 없습니다'});
  if (att.check_out) return res.status(400).json({error:'이미 퇴근 처리되었습니다'});
  const [h1,m1]=att.check_in.split(':').map(Number), [h2,m2]=now.split(':').map(Number);
  const hours = Math.max(0,((h2*60+m2)-(h1*60+m1))/60);
  const status = att.status==='지각'?'지각':(hours<8?'조퇴':'정상');
  db.prepare("UPDATE erp_attendance SET check_out=?,work_hours=?,status=? WHERE id=?").run(now,parseFloat(hours.toFixed(2)),status,att.id);
  res.json({success:true,checkOut:now,workHours:hours.toFixed(1),status});
});

app.post('/api/erp/attendance/admin', erpAuth, erpManager, (req, res) => {
  const {user_id,work_date,check_in,check_out,status,note} = req.body;
  const hours = (check_in&&check_out) ? (() => { const [h1,m1]=check_in.split(':').map(Number),[h2,m2]=check_out.split(':').map(Number); return Math.max(0,((h2*60+m2)-(h1*60+m1))/60); })() : 0;
  const ex = db.prepare("SELECT id FROM erp_attendance WHERE user_id=? AND work_date=?").get(user_id,work_date);
  if (ex) db.prepare("UPDATE erp_attendance SET check_in=?,check_out=?,status=?,work_hours=?,note=? WHERE id=?").run(check_in||null,check_out||null,status||'정상',hours,note||'',ex.id);
  else db.prepare("INSERT INTO erp_attendance (id,user_id,work_date,check_in,check_out,status,work_hours,note) VALUES (?,?,?,?,?,?,?,?)").run(uid(),user_id,work_date,check_in||null,check_out||null,status||'정상',hours,note||'');
  res.json({success:true});
});

// ── 업무 태스크 ──────────────────────────────────────
app.get('/api/erp/tasks', erpAuth, (req, res) => {
  let q = "SELECT t.*,u.name AS aname,c.name AS cname FROM erp_tasks t LEFT JOIN users u ON t.assignee_id=u.id LEFT JOIN users c ON t.creator_id=c.id WHERE 1=1";
  const p = [];
  if (req.user.erpRole==='employee' && req.query.all!=='1') { q+=' AND t.assignee_id=?'; p.push(req.user.id); }
  if (req.query.status) { q+=' AND t.status=?'; p.push(req.query.status); }
  if (req.query.assignee) { q+=' AND t.assignee_id=?'; p.push(req.query.assignee); }
  q+=" ORDER BY CASE t.priority WHEN '긴급' THEN 0 WHEN '높음' THEN 1 WHEN '보통' THEN 2 ELSE 3 END,t.due_date LIMIT 100";
  res.json(db.prepare(q).all(...p));
});

app.post('/api/erp/tasks', erpAuth, erpManager, (req, res) => {
  const {title,description,assignee_id,priority,status,due_date,category} = req.body;
  if (!title) return res.status(400).json({error:'title 필수'});
  const id = uid();
  db.prepare("INSERT INTO erp_tasks (id,title,description,assignee_id,creator_id,priority,status,due_date,category) VALUES (?,?,?,?,?,?,?,?,?)").run(id,title,description||'',assignee_id||null,req.user.id,priority||'보통',status||'대기',due_date||null,category||'일반');
  res.json({id,success:true});
});

app.put('/api/erp/tasks/:id', erpAuth, (req, res) => {
  const t = db.prepare("SELECT * FROM erp_tasks WHERE id=?").get(req.params.id);
  if (!t) return res.status(404).json({error:'없음'});
  if (req.user.erpRole==='employee' && t.assignee_id!==req.user.id) return res.status(403).json({error:'권한 없음'});
  const {title,description,assignee_id,priority,status,due_date,category} = req.body;
  const isDone = status==='완료' && t.status!=='완료';
  db.prepare("UPDATE erp_tasks SET title=COALESCE(?,title),description=COALESCE(?,description),assignee_id=COALESCE(?,assignee_id),priority=COALESCE(?,priority),status=COALESCE(?,status),due_date=COALESCE(?,due_date),category=COALESCE(?,category),completed_at=? WHERE id=?")
    .run(title||null,description||null,assignee_id||null,priority||null,status||null,due_date||null,category||null,isDone?Math.floor(Date.now()/1000):t.completed_at,req.params.id);
  res.json({success:true});
});

app.delete('/api/erp/tasks/:id', erpAuth, erpManager, (req, res) => {
  db.prepare("DELETE FROM erp_tasks WHERE id=?").run(req.params.id);
  res.json({success:true});
});

// ── 일정 ─────────────────────────────────────────────
app.get('/api/erp/schedules', erpAuth, (req, res) => {
  const from = req.query.from || new Date(Date.now()-30*86400000).toISOString().slice(0,10);
  const to   = req.query.to   || new Date(Date.now()+60*86400000).toISOString().slice(0,10);
  res.json(db.prepare("SELECT s.*,u.name AS cname FROM erp_schedules s LEFT JOIN users u ON s.creator_id=u.id WHERE date(s.start_dt) BETWEEN ? AND ? ORDER BY s.start_dt").all(from,to));
});

app.post('/api/erp/schedules', erpAuth, (req, res) => {
  const {title,description,attendees,type,start_dt,end_dt,location,all_day,color} = req.body;
  if (!title||!start_dt) return res.status(400).json({error:'필수 항목 누락'});
  const id = uid();
  db.prepare("INSERT INTO erp_schedules (id,title,description,creator_id,attendees,type,start_dt,end_dt,location,all_day,color) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id,title,description||'',req.user.id,JSON.stringify(attendees||[]),type||'일반',start_dt,end_dt||null,location||'',all_day?1:0,color||'#4f7dff');
  res.json({id,success:true});
});

app.put('/api/erp/schedules/:id', erpAuth, (req, res) => {
  const s = db.prepare("SELECT creator_id FROM erp_schedules WHERE id=?").get(req.params.id);
  if (!s) return res.status(404).json({error:'없음'});
  if (req.user.erpRole==='employee' && s.creator_id!==req.user.id) return res.status(403).json({error:'권한 없음'});
  const {title,description,attendees,type,start_dt,end_dt,location,all_day,color} = req.body;
  db.prepare("UPDATE erp_schedules SET title=COALESCE(?,title),description=COALESCE(?,description),attendees=COALESCE(?,attendees),type=COALESCE(?,type),start_dt=COALESCE(?,start_dt),end_dt=COALESCE(?,end_dt),location=COALESCE(?,location),all_day=COALESCE(?,all_day),color=COALESCE(?,color) WHERE id=?")
    .run(title||null,description||null,attendees?JSON.stringify(attendees):null,type||null,start_dt||null,end_dt||null,location||null,all_day!=null?all_day?1:0:null,color||null,req.params.id);
  res.json({success:true});
});

app.delete('/api/erp/schedules/:id', erpAuth, (req, res) => {
  const s = db.prepare("SELECT creator_id FROM erp_schedules WHERE id=?").get(req.params.id);
  if (!s) return res.status(404).json({error:'없음'});
  if (req.user.erpRole==='employee' && s.creator_id!==req.user.id) return res.status(403).json({error:'권한 없음'});
  db.prepare("DELETE FROM erp_schedules WHERE id=?").run(req.params.id);
  res.json({success:true});
});

// ── 공지사항 ──────────────────────────────────────────
app.get('/api/erp/notices', erpAuth, (req, res) => {
  res.json(db.prepare("SELECT n.*,u.name AS aname FROM erp_notices n LEFT JOIN users u ON n.author_id=u.id ORDER BY n.is_pinned DESC,n.created_at DESC LIMIT 50").all().map(n=>({...n,createdAt:n.created_at*1000})));
});

app.get('/api/erp/notices/:id', erpAuth, (req, res) => {
  db.prepare("UPDATE erp_notices SET views=views+1 WHERE id=?").run(req.params.id);
  const n = db.prepare("SELECT n.*,u.name AS aname FROM erp_notices n LEFT JOIN users u ON n.author_id=u.id WHERE n.id=?").get(req.params.id);
  if (!n) return res.status(404).json({error:'없음'});
  res.json({...n,createdAt:n.created_at*1000});
});

app.post('/api/erp/notices', erpAuth, erpManager, (req, res) => {
  const {title,content,target,is_pinned} = req.body;
  if (!title||!content) return res.status(400).json({error:'필수 항목 누락'});
  const id=uid(), ts=Math.floor(Date.now()/1000);
  db.prepare("INSERT INTO erp_notices (id,title,content,author_id,target,is_pinned,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id,title,content,req.user.id,target||'전체',is_pinned?1:0,ts,ts);
  res.json({id,success:true});
});

app.put('/api/erp/notices/:id', erpAuth, erpManager, (req, res) => {
  const {title,content,target,is_pinned} = req.body;
  const ts=Math.floor(Date.now()/1000);
  db.prepare("UPDATE erp_notices SET title=COALESCE(?,title),content=COALESCE(?,content),target=COALESCE(?,target),is_pinned=COALESCE(?,is_pinned),updated_at=? WHERE id=?").run(title||null,content||null,target||null,is_pinned!=null?is_pinned?1:0:null,ts,req.params.id);
  res.json({success:true});
});

app.delete('/api/erp/notices/:id', erpAuth, erpManager, (req, res) => {
  db.prepare("DELETE FROM erp_notices WHERE id=?").run(req.params.id);
  res.json({success:true});
});

// ── 결재 ─────────────────────────────────────────────
app.get('/api/erp/approvals', erpAuth, (req, res) => {
  let q="SELECT a.*,r.name AS rname,ap.name AS apname FROM erp_approvals a LEFT JOIN users r ON a.requester_id=r.id LEFT JOIN users ap ON a.approver_id=ap.id WHERE 1=1";
  const p=[];
  if (req.user.erpRole==='employee') { q+=' AND a.requester_id=?'; p.push(req.user.id); }
  else if (req.query.role==='approver') { q+=' AND a.approver_id=?'; p.push(req.user.id); }
  if (req.query.status) { q+=' AND a.status=?'; p.push(req.query.status); }
  q+=' ORDER BY a.requested_at DESC LIMIT 100';
  res.json(db.prepare(q).all(...p).map(a=>({...a,requestedAt:a.requested_at*1000})));
});

app.post('/api/erp/approvals', erpAuth, (req, res) => {
  const {type,title,content,approver_id} = req.body;
  if (!type||!title) return res.status(400).json({error:'필수 항목 누락'});
  const appId = approver_id || db.prepare("SELECT id FROM users WHERE (erp_role='manager' OR role='admin') AND id!=? LIMIT 1").get(req.user.id)?.id;
  const id=uid();
  db.prepare("INSERT INTO erp_approvals (id,type,title,content,requester_id,approver_id,status,requested_at) VALUES (?,?,?,?,?,?,?,?)").run(id,type,title,content||'',req.user.id,appId||null,'대기',Math.floor(Date.now()/1000));
  res.json({id,success:true});
});

app.put('/api/erp/approvals/:id/process', erpAuth, erpManager, (req, res) => {
  const {status,approver_note} = req.body;
  if (!['승인','반려'].includes(status)) return res.status(400).json({error:'상태 오류'});
  db.prepare("UPDATE erp_approvals SET status=?,approver_note=?,approver_id=?,processed_at=? WHERE id=?").run(status,approver_note||'',req.user.id,Math.floor(Date.now()/1000),req.params.id);
  res.json({success:true});
});

// ── 재무 ─────────────────────────────────────────────
app.get('/api/erp/finance/summary', erpAuth, erpCeo, (req, res) => {
  const months=[];
  for(let i=5;i>=0;i--){const d=new Date();d.setMonth(d.getMonth()-i);months.push(d.toISOString().slice(0,7));}
  const monthly = months.map(m=>({
    month:m,
    revenue: db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM erp_revenue WHERE strftime('%Y-%m',payment_date)=? AND status='완료'").get(m)?.t||0,
    expense: db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM erp_expenses WHERE strftime('%Y-%m',expense_date)=? AND status='승인'").get(m)?.t||0,
  })).map(r=>({...r,profit:r.revenue-r.expense}));
  const revCat = db.prepare("SELECT category,SUM(amount) AS total FROM erp_revenue WHERE status='완료' AND payment_date>=date('now','-3 months') GROUP BY category ORDER BY total DESC").all();
  const expCat = db.prepare("SELECT category,SUM(amount) AS total FROM erp_expenses WHERE status='승인' AND expense_date>=date('now','-3 months') GROUP BY category ORDER BY total DESC").all();
  res.json({monthly,revCat,expCat});
});

app.get('/api/erp/revenue', erpAuth, erpCeo, (req, res) => {
  res.json(db.prepare("SELECT r.*,u.name AS cname FROM erp_revenue r LEFT JOIN users u ON r.client_id=u.id ORDER BY r.payment_date DESC,r.created_at DESC LIMIT 100").all());
});

app.post('/api/erp/revenue', erpAuth, erpCeo, (req, res) => {
  const {title,amount,category,client_id,payment_date,status,note}=req.body;
  if (!title||!amount) return res.status(400).json({error:'필수 항목 누락'});
  const id=uid();
  db.prepare("INSERT INTO erp_revenue (id,title,amount,category,client_id,payment_date,status,note) VALUES (?,?,?,?,?,?,?,?)").run(id,title,parseInt(amount),category||'수강료',client_id||null,payment_date||null,status||'완료',note||'');
  res.json({id,success:true});
});

app.delete('/api/erp/revenue/:id', erpAuth, erpCeo, (req, res) => {
  db.prepare("DELETE FROM erp_revenue WHERE id=?").run(req.params.id); res.json({success:true});
});

app.get('/api/erp/expenses', erpAuth, erpCeo, (req, res) => {
  res.json(db.prepare("SELECT e.*,u.name AS sname FROM erp_expenses e LEFT JOIN users u ON e.spender_id=u.id ORDER BY e.expense_date DESC,e.created_at DESC LIMIT 100").all());
});

app.post('/api/erp/expenses', erpAuth, erpManager, (req, res) => {
  const {title,amount,category,expense_date,note}=req.body;
  if (!title||!amount) return res.status(400).json({error:'필수 항목 누락'});
  const id=uid();
  db.prepare("INSERT INTO erp_expenses (id,title,amount,category,spender_id,expense_date,status,note) VALUES (?,?,?,?,?,?,?,?)").run(id,title,parseInt(amount),category||'운영비',req.user.id,expense_date||null,'승인',note||'');
  res.json({id,success:true});
});

// ── OKR ──────────────────────────────────────────────
app.get('/api/erp/okrs', erpAuth, (req, res) => {
  res.json(db.prepare("SELECT o.*,u.name AS oname FROM erp_okrs o LEFT JOIN users u ON o.owner_id=u.id ORDER BY o.quarter DESC,o.status,o.created_at DESC").all());
});

app.post('/api/erp/okrs', erpAuth, erpManager, (req, res) => {
  const {objective,key_result,owner_id,quarter,progress,status}=req.body;
  if (!objective||!key_result) return res.status(400).json({error:'필수 항목 누락'});
  const id=uid();
  db.prepare("INSERT INTO erp_okrs (id,objective,key_result,owner_id,quarter,progress,status) VALUES (?,?,?,?,?,?,?)").run(id,objective,key_result,owner_id||req.user.id,quarter||'',parseInt(progress)||0,status||'진행중');
  res.json({id,success:true});
});

app.put('/api/erp/okrs/:id', erpAuth, (req, res) => {
  const {objective,key_result,owner_id,quarter,progress,status}=req.body;
  db.prepare("UPDATE erp_okrs SET objective=COALESCE(?,objective),key_result=COALESCE(?,key_result),owner_id=COALESCE(?,owner_id),quarter=COALESCE(?,quarter),progress=COALESCE(?,progress),status=COALESCE(?,status) WHERE id=?")
    .run(objective||null,key_result||null,owner_id||null,quarter||null,progress!=null?parseInt(progress):null,status||null,req.params.id);
  res.json({success:true});
});

app.delete('/api/erp/okrs/:id', erpAuth, erpCeo, (req, res) => {
  db.prepare("DELETE FROM erp_okrs WHERE id=?").run(req.params.id); res.json({success:true});
});

// ── 급여 ─────────────────────────────────────────────
app.get('/api/erp/payroll', erpAuth, (req, res) => {
  const uid2 = req.user.erpRole==='employee' ? req.user.id : (req.query.userId||null);
  let q="SELECT p.*,u.name FROM erp_payroll p JOIN users u ON p.user_id=u.id WHERE 1=1";
  const p=[];
  if(uid2){q+=' AND p.user_id=?';p.push(uid2);}
  if(req.query.year_month){q+=' AND p.year_month=?';p.push(req.query.year_month);}
  q+=' ORDER BY p.year_month DESC,u.name LIMIT 200';
  res.json(db.prepare(q).all(...p));
});

app.post('/api/erp/payroll', erpAuth, erpCeo, (req, res) => {
  const {user_id,year_month,base_salary,bonus,deduction,status,payment_date}=req.body;
  if (!user_id||!year_month) return res.status(400).json({error:'필수 항목 누락'});
  const base=parseInt(base_salary)||0, bon=parseInt(bonus)||0, ded=parseInt(deduction)||0, net=base+bon-ded;
  const id=uid();
  db.prepare("INSERT OR REPLACE INTO erp_payroll (id,user_id,year_month,base_salary,bonus,deduction,net_salary,status,payment_date) VALUES (?,?,?,?,?,?,?,?,?)").run(id,user_id,year_month,base,bon,ded,net,status||'예정',payment_date||null);
  res.json({id,net_salary:net,success:true});
});

// ── ERP 사용자 목록 (배정용) ──────────────────────────
app.get('/api/erp/users', erpAuth, erpManager, (req, res) => {
  res.json(db.prepare("SELECT u.id,u.name,u.role,u.erp_role,e.department,e.position FROM users u LEFT JOIN erp_employees e ON u.id=e.user_id WHERE u.erp_role IS NOT NULL AND u.role!='student' ORDER BY u.name").all());
});

// ═══════════════════════════════════════════════════════
// 출퇴근 상세 관리 API
// ═══════════════════════════════════════════════════════

// 출퇴근 기록 수정 (시간 조정, 휴가 등록)
app.put('/api/erp/attendance/:id', erpAuth, (req, res) => {
  const { id } = req.params;
  const { check_in, check_out, work_hours, leave_type, leave_reason, status } = req.body;

  const attendance = db.prepare("SELECT * FROM erp_attendance WHERE id=?").get(id);
  if (!attendance) return res.status(404).json({ error: '기록을 찾을 수 없습니다' });

  // 자신의 기록만 수정 가능, 관리자는 모든 기록 수정 가능
  const isManager = req.user.erp_role === 'manager' || req.user.erp_role === 'ceo';
  if (attendance.user_id !== req.user.id && !isManager) {
    return res.status(403).json({ error: '권한이 없습니다' });
  }

  db.prepare(`
    UPDATE erp_attendance
    SET check_in=COALESCE(?, check_in),
        check_out=COALESCE(?, check_out),
        work_hours=COALESCE(?, work_hours),
        leave_type=COALESCE(?, leave_type),
        leave_reason=COALESCE(?, leave_reason),
        status=COALESCE(?, status),
        leave_approved_by=CASE WHEN ? THEN ? ELSE leave_approved_by END
    WHERE id=?
  `).run(check_in, check_out, work_hours, leave_type, leave_reason, status, isManager, req.user.id, id);

  res.json({ success: true, message: '기록이 수정되었습니다' });
});

// 월별 출퇴근 현황
app.get('/api/erp/attendance/monthly/:year_month', erpAuth, (req, res) => {
  const { year_month } = req.params;
  const userId = req.query.userId;

  // 자신의 데이터만 조회 가능, 관리자/대표는 전체 조회 가능
  const isManager = req.user.erp_role === 'manager' || req.user.erp_role === 'ceo';
  const target = (isManager && userId) ? userId : req.user.id;

  const records = db.prepare(`
    SELECT id, user_id, work_date, check_in, check_out, work_hours,
           status, leave_type, leave_reason, created_at
    FROM erp_attendance
    WHERE user_id=? AND work_date LIKE ?
    ORDER BY work_date ASC
  `).all(target, year_month + '%');

  const summary = {
    totalDays: records.length,
    workDays: records.filter(r => r.status === '정상').length,
    leaveDays: records.filter(r => r.leave_type).length,
    totalWorkHours: records.reduce((s, r) => s + (r.work_hours || 0), 0)
  };

  res.json({ records, summary });
});

// ═══════════════════════════════════════════════════════
// 연차/휴가 관리 API
// ═══════════════════════════════════════════════════════

// 연차/휴가 신청
app.post('/api/erp/leave-requests', erpAuth, (req, res) => {
  const { leave_type, start_date, end_date, num_days, reason } = req.body;

  if (!leave_type || !start_date || !end_date || !num_days) {
    return res.status(400).json({ error: '필수 정보가 누락되었습니다' });
  }

  const id = `leave_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  db.prepare(`
    INSERT INTO erp_leave_requests (id, user_id, leave_type, start_date, end_date, num_days, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.user.id, leave_type, start_date, end_date, num_days, reason || '');

  res.json({ success: true, id, message: '휴가 신청이 완료되었습니다' });
});

// 내 연차/휴가 신청 조회
app.get('/api/erp/leave-requests', erpAuth, (req, res) => {
  const leaves = db.prepare(`
    SELECT l.*, u.name as approver_name
    FROM erp_leave_requests l
    LEFT JOIN users u ON l.approver_id=u.id
    WHERE l.user_id=?
    ORDER BY l.requested_at DESC
  `).all(req.user.id);

  res.json(leaves);
});

// 연차/휴가 신청 목록 (관리자/대표용)
app.get('/api/erp/leave-requests/pending', erpAuth, erpManager, (req, res) => {
  const leaves = db.prepare(`
    SELECT l.*, u.name as requester_name, e.department
    FROM erp_leave_requests l
    JOIN users u ON l.user_id=u.id
    LEFT JOIN erp_employees e ON l.user_id=e.user_id
    WHERE l.status='신청'
    ORDER BY l.requested_at ASC
  `).all();

  res.json(leaves);
});

// 연차/휴가 승인/반려
app.put('/api/erp/leave-requests/:id/process', erpAuth, erpManager, (req, res) => {
  const { id } = req.params;
  const { status, note } = req.body; // status: '승인' or '반려'

  if (!['승인', '반려'].includes(status)) {
    return res.status(400).json({ error: '유효한 상태가 아닙니다' });
  }

  db.prepare(`
    UPDATE erp_leave_requests
    SET status=?, approver_id=?, approver_note=?, processed_at=strftime('%s','now')
    WHERE id=?
  `).run(status, req.user.id, note || '', id);

  res.json({ success: true, message: `휴가가 ${status}되었습니다` });
});

// ═══════════════════════════════════════════════════════
// 개인별 월별 매출 API
// ═══════════════════════════════════════════════════════

// 개인별 월별 매출 등록/수정
app.post('/api/erp/individual-sales', erpAuth, (req, res) => {
  const { year_month, amount, category, description } = req.body;

  if (!year_month || amount === undefined) {
    return res.status(400).json({ error: '필수 정보가 누락되었습니다' });
  }

  const existing = db.prepare(
    "SELECT id FROM erp_individual_sales WHERE user_id=? AND year_month=? AND category=?"
  ).get(req.user.id, year_month, category || '컨설팅');

  const id = existing?.id || `sales_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  if (existing) {
    db.prepare(`
      UPDATE erp_individual_sales
      SET amount=?, description=?, updated_at=strftime('%s','now')
      WHERE id=?
    `).run(amount, description || '', id);
  } else {
    db.prepare(`
      INSERT INTO erp_individual_sales (id, user_id, year_month, amount, category, description)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, req.user.id, year_month, amount, category || '컨설팅', description || '');
  }

  res.json({ success: true, id, message: '매출이 기록되었습니다' });
});

// 개인별 월별 매출 조회
app.get('/api/erp/individual-sales', erpAuth, (req, res) => {
  const userId = req.query.userId;
  const isManager = req.user.erp_role === 'manager' || req.user.erp_role === 'ceo';

  const target = (isManager && userId) ? userId : req.user.id;

  const sales = db.prepare(`
    SELECT id, user_id, year_month, amount, category, description, created_at, updated_at
    FROM erp_individual_sales
    WHERE user_id=?
    ORDER BY year_month DESC, category ASC
  `).all(target);

  // 월별 합계 계산
  const monthlySummary = {};
  sales.forEach(s => {
    if (!monthlySummary[s.year_month]) {
      monthlySummary[s.year_month] = 0;
    }
    monthlySummary[s.year_month] += s.amount;
  });

  res.json({ sales, monthlySummary });
});

// 팀 전체 매출 현황 (관리자/대표용)
app.get('/api/erp/team-sales/:year_month', erpAuth, erpManager, (req, res) => {
  const { year_month } = req.params;

  const teamSales = db.prepare(`
    SELECT u.id, u.name, SUM(s.amount) as total_amount, COUNT(DISTINCT s.category) as categories
    FROM erp_individual_sales s
    JOIN users u ON s.user_id=u.id
    WHERE s.year_month=?
    GROUP BY s.user_id
    ORDER BY total_amount DESC
  `).all(year_month);

  const totalTeamSales = teamSales.reduce((s, t) => s + t.total_amount, 0);

  res.json({ teamSales, totalTeamSales });
});

// ═══════════════════════════════════════════════════════
// 공유 캘린더 API (기존 schedules 확대)
// ═══════════════════════════════════════════════════════

// 캘린더 이벤트 상세 조회
app.get('/api/erp/calendar/events/:id', erpAuth, (req, res) => {
  const event = db.prepare(`
    SELECT s.*, u.name as creator_name
    FROM erp_schedules s
    LEFT JOIN users u ON s.creator_id=u.id
    WHERE s.id=?
  `).get(req.params.id);

  if (!event) return res.status(404).json({ error: '일정을 찾을 수 없습니다' });

  event.attendees = event.attendees ? JSON.parse(event.attendees) : [];
  res.json(event);
});

// 기간별 캘린더 이벤트 조회 (공유 캘린더)
app.get('/api/erp/calendar/events', erpAuth, (req, res) => {
  const { start_dt, end_dt } = req.query;

  if (!start_dt || !end_dt) {
    return res.status(400).json({ error: 'start_dt, end_dt 필수' });
  }

  const events = db.prepare(`
    SELECT s.*, u.name as creator_name
    FROM erp_schedules s
    LEFT JOIN users u ON s.creator_id=u.id
    WHERE s.start_dt >= ? AND s.start_dt < ?
    ORDER BY s.start_dt ASC
  `).all(start_dt, end_dt);

  events.forEach(e => {
    e.attendees = e.attendees ? JSON.parse(e.attendees) : [];
  });

  res.json(events);
});

// 캘린더 이벤트 생성
app.post('/api/erp/calendar/events', erpAuth, (req, res) => {
  const { title, description, type, start_dt, end_dt, location, attendees, color, all_day } = req.body;

  if (!title || !start_dt) {
    return res.status(400).json({ error: '제목과 시작 시간은 필수입니다' });
  }

  const id = `event_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  db.prepare(`
    INSERT INTO erp_schedules (id, title, description, creator_id, type, start_dt, end_dt, location, attendees, color, all_day)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, title, description || '', req.user.id, type || '일반',
    start_dt, end_dt || null, location || '',
    JSON.stringify(attendees || []), color || '#4f7dff', all_day ? 1 : 0
  );

  res.json({ success: true, id, message: '일정이 추가되었습니다' });
});

// 캘린더 이벤트 수정
app.put('/api/erp/calendar/events/:id', erpAuth, (req, res) => {
  const { id } = req.params;
  const { title, description, type, start_dt, end_dt, location, attendees, color, all_day } = req.body;

  const event = db.prepare("SELECT * FROM erp_schedules WHERE id=?").get(id);
  if (!event) return res.status(404).json({ error: '일정을 찾을 수 없습니다' });

  // 작성자만 수정 가능, 대표는 모든 일정 수정 가능
  if (event.creator_id !== req.user.id && req.user.erp_role !== 'ceo') {
    return res.status(403).json({ error: '권한이 없습니다' });
  }

  db.prepare(`
    UPDATE erp_schedules
    SET title=COALESCE(?, title),
        description=COALESCE(?, description),
        type=COALESCE(?, type),
        start_dt=COALESCE(?, start_dt),
        end_dt=COALESCE(?, end_dt),
        location=COALESCE(?, location),
        attendees=COALESCE(?, attendees),
        color=COALESCE(?, color),
        all_day=COALESCE(?, all_day)
    WHERE id=?
  `).run(title, description, type, start_dt, end_dt, location,
         attendees ? JSON.stringify(attendees) : null, color, all_day !== undefined ? (all_day ? 1 : 0) : null, id);

  res.json({ success: true, message: '일정이 수정되었습니다' });
});

// 캘린더 이벤트 삭제
app.delete('/api/erp/calendar/events/:id', erpAuth, (req, res) => {
  const event = db.prepare("SELECT * FROM erp_schedules WHERE id=?").get(req.params.id);
  if (!event) return res.status(404).json({ error: '일정을 찾을 수 없습니다' });

  // 작성자만 삭제 가능, 대표는 모든 일정 삭제 가능
  if (event.creator_id !== req.user.id && req.user.erp_role !== 'ceo') {
    return res.status(403).json({ error: '권한이 없습니다' });
  }

  db.prepare("DELETE FROM erp_schedules WHERE id=?").run(req.params.id);
  res.json({ success: true, message: '일정이 삭제되었습니다' });
});

// ── 기본 경로: ERP로 리다이렉트 ────────────────────
app.get('/', (_req, res) => res.redirect('/erp'));

// ── ERP 프론트엔드 ────────────────────────────────────
app.get('/erp', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'erp.html')));
app.get('/erp/*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'erp.html')));

// ─────────────────────────────────────────────────────────────────
// 편입 LMS 프론트엔드 라우팅
app.get('/transfer', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'transfer.html')));
app.get('/transfer/*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'transfer.html')));

// ── SPA 폴백 (반드시 모든 라우트 등록 후 마지막에 위치) ──────────
app.get('*', (req, res) => {
  const idx = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(idx)) res.sendFile(idx);
  else res.status(404).send('BigLinker — public/index.html을 배포해주세요.');
});

// ═══════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════
app.listen(PORT, () => {
  log('info', `BigLinker 서버 시작`, {
    port: PORT,
    db:   path.resolve(DB_PATH),
    rag:  bm25.corpus.length,
    env:  process.env.NODE_ENV || 'development',
    apiKeySource: process.env.ANTHROPIC_API_KEY ? 'env' : 'db',
  });
});

process.on('SIGTERM', () => { db.close(); process.exit(0); });
process.on('uncaughtException', err => {
  log('error', 'uncaughtException', { err: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  log('error', 'unhandledRejection', { reason: String(reason) });
});
