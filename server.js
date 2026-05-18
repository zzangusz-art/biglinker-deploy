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
app.use(express.static(path.join(__dirname, 'public')));

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

// ── SPA 폴백 ──────────────────────────────────────────
app.get('*', (req, res) => {
  const idx = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(idx)) res.sendFile(idx);
  else res.status(404).send('BigLinker — public/index.html을 배포해주세요.');
});

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
  CREATE INDEX IF NOT EXISTS idx_tl_sched_date ON tl_schedule(class_date);
  CREATE INDEX IF NOT EXISTS idx_tl_rec_date   ON tl_recordings(class_date);
  CREATE INDEX IF NOT EXISTS idx_tl_sess_stu   ON tl_test_sessions(student_id, created_at DESC);
`);

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
  const cnt = db.prepare("SELECT COUNT(*) as c FROM tl_level_questions").get().c;
  if (cnt > 0) return;

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
    ['lq02','어휘','밑줄 친 단어의 의미로 가장 적절한 것은?\n"The politician\'s ambiguous statement left voters perplexed."',null,'명확한','모호한','강력한','단호한','B','ambiguous = 모호한, 애매한',1],
    ['lq03','어휘','다음 빈칸에 들어갈 가장 적절한 단어는?\n"The new policy was designed to _____ economic inequality."',null,'exacerbate','ameliorate','perpetuate','ignore','B','ameliorate = 개선하다, 완화하다',3],
    ['lq04','어휘','밑줄 친 단어와 반의어는?\n"The CEO made an impulsive decision without consulting the board."',null,'hasty','reckless','deliberate','spontaneous','C','impulsive의 반의어는 deliberate(신중한)',2],
    ['lq05','어휘','다음 문맥에서 "inveterate"의 의미로 가장 적절한 것은?\n"He was an inveterate gambler who could not stop despite losing everything."',null,'occasional','habitual','reluctant','amateur','B','inveterate = 뿌리 깊은, 습관적인',3],
    ['lq06','어휘','빈칸에 알맞은 단어는?\n"The two countries signed a _____ agreement to promote trade."',null,'bilateral','unilateral','multilateral','neutral','A','bilateral = 양자간의 (two parties)',2],
    ['lq07','어휘','밑줄 친 표현의 의미는?\n"The company decided to cut corners to meet the deadline."',null,'일을 꼼꼼히 하다','지름길을 이용하다','비용/품질을 줄이다','시간을 절약하다','C','cut corners = 요령을 피우다, 부실하게 하다',2],
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
    // 논리 10문제
    ['lq31','논리','다음 논증의 오류는?\n"모든 성공한 사람들은 열심히 일한다. 그는 열심히 일한다. 따라서 그는 성공할 것이다."',null,
      '허수아비 오류','전건 긍정의 오류','후건 긍정의 오류','미끄러운 경사면 오류','C',
      'P→Q, Q ∴ P 형태 = 후건 긍정의 오류(affirming the consequent)',3],
    ['lq32','논리','다음 추론의 빈칸에 들어갈 결론은?\n"독서를 많이 하는 사람은 어휘력이 높다. 어휘력이 높은 사람은 글쓰기를 잘한다. 따라서 ___."',null,
      '글쓰기를 잘 하는 사람은 독서를 많이 한다.',
      '독서를 많이 하는 사람은 글쓰기를 잘 한다.',
      '어휘력이 낮은 사람은 독서를 하지 않는다.',
      '글쓰기를 잘 하려면 어휘력을 키워야 한다.','B',
      '삼단논법: A→B, B→C ∴ A→C',1],
    ['lq33','논리','다음 중 논리적으로 동치인 것은?\n"비가 오면 우산을 쓴다."',null,
      '우산을 쓰면 비가 온다.',
      '비가 오지 않으면 우산을 쓰지 않는다.',
      '우산을 쓰지 않으면 비가 오지 않는다.',
      '비도 오고 우산도 쓴다.','C',
      'P→Q의 대우: ¬Q→¬P',3],
    ['lq34','논리','다음 주장에 대한 반론으로 가장 적절한 것은?\n"온라인 쇼핑의 증가로 전통 소매업이 쇠퇴하고 있으므로, 온라인 쇼핑을 규제해야 한다."',null,
      '온라인 쇼핑은 편리하다.',
      '전통 소매업 쇠퇴의 원인이 온라인 쇼핑만은 아니며, 규제가 소비자 이익을 해칠 수 있다.',
      '전통 소매업자들을 위한 지원이 필요하다.',
      '온라인 쇼핑몰의 수가 계속 증가하고 있다.','B',
      '원인 단순화 오류 지적 + 규제의 부작용 반론',3],
    ['lq35','논리','다음 퍼즐을 풀어라.\n갑, 을, 병 세 사람이 있다. 갑은 을보다 나이가 많다. 병은 갑보다 나이가 많다. 가장 나이가 많은 사람은?',null,'갑','을','병','알 수 없다','C','병 > 갑 > 을',1],
    ['lq36','논리','다음 조건에서 항상 참인 것은?\n"X팀이 이기면 Y팀이 진다. Y팀이 지면 Z팀이 이긴다."',null,
      'X팀이 지면 Z팀도 진다.',
      'X팀이 이기면 Z팀이 이긴다.',
      'Z팀이 이기면 X팀이 이긴다.',
      'Y팀이 이기면 Z팀도 이긴다.','B',
      'X→¬Y, ¬Y→Z 연쇄 추론: X→Z',2],
    ['lq37','논리','다음 논증의 전제와 결론 구조를 파악할 때, 빠진 전제는?\n전제1: 모든 포유류는 온혈동물이다.\n결론: 따라서 고래는 온혈동물이다.',null,
      '온혈동물은 모두 포유류이다.',
      '고래는 포유류이다.',
      '고래는 온혈동물을 먹는다.',
      '포유류는 물속에서도 살 수 있다.','B','삼단논법의 숨은 전제: 고래∈포유류',2],
    ['lq38','논리','다음 글의 주장을 약화시키는 것은?\n"운동을 규칙적으로 하는 사람들이 더 오래 산다. 따라서 장수하려면 운동을 해야 한다."',null,
      '규칙적인 운동은 심혈관 건강에 좋다.',
      '오래 사는 사람들 중 운동을 하지 않는 사람도 많다.',
      '운동은 스트레스 해소에 도움이 된다.',
      '건강한 사람일수록 운동을 더 많이 한다.','D',
      '역인과관계: 건강해서 운동하는 것 → 운동이 장수 원인이라는 주장 약화',3],
    ['lq39','논리','다음 중 귀납적 추론의 예는?',null,
      '모든 인간은 죽는다. 소크라테스는 인간이다. 따라서 소크라테스는 죽는다.',
      '관찰한 100마리의 까마귀가 모두 검었다. 따라서 모든 까마귀는 검다.',
      '삼각형의 내각의 합은 180도이다. 이것은 삼각형이다. 내각의 합은 180도이다.',
      '만약 비가 오면 땅이 젖는다. 비가 왔다. 따라서 땅이 젖었다.','B',
      '귀납: 개별 사례 → 일반 법칙 도출',2],
    ['lq40','논리','다음 논증에서 결론을 가장 잘 지지하는 전제는?\n결론: 소셜미디어는 청소년의 정신 건강에 해롭다.',null,
      '많은 청소년이 소셜미디어를 사용한다.',
      '소셜미디어 사용 시간과 우울증 발생률 사이에 강한 정적 상관관계가 있다는 연구가 있다.',
      '소셜미디어 기업들은 막대한 수익을 올리고 있다.',
      '성인들도 소셜미디어를 많이 사용한다.','B',
      '결론(소셜미디어→정신건강 해로움)을 직접적으로 지지하는 증거',3],
  ];

  levelQuestions.forEach(q => lvlQ.run(...q));

  // ── 섹션별 일반 테스트 문제 (각 섹션 15문제씩 = 60문제) ──
  const sectionQ = [
    // 어휘 — COMMON
    ['tq01','어휘','COMMON','"Ubiquitous" means:',null,'rare','everywhere','ancient','complex','B','ubiquitous = 어디에나 있는, 편재하는',1,null],
    ['tq02','어휘','COMMON','다음 빈칸에 알맞은 단어: "The treaty was meant to _____ tensions between the two nations."',null,'exacerbate','alleviate','intensify','provoke','B','alleviate = 완화하다, 경감하다',2,null],
    ['tq03','어휘','COMMON','"Ephemeral"과 반의어 관계인 것은?',null,'transient','fleeting','permanent','momentary','C','ephemeral = 단명하는 ↔ permanent',2,null],
    ['tq04','어휘','SEOUL','"The professor gave an _____ lecture that covered too many topics without depth."',null,'profound','cursory','exhaustive','meticulous','B','cursory = 피상적인, 대충 훑어보는',3,null],
    ['tq05','어휘','SKY','"The diplomat\'s _____ remarks helped defuse the international crisis."',null,'provocative','incendiary','conciliatory','belligerent','C','conciliatory = 화해적인, 달래는',3,null],
    ['tq06','어휘','COMMON','문맥상 "benign"의 의미로 적절한 것은?\n"The doctor assured the patient that the tumor was benign."',null,'malignant','dangerous','harmless','aggressive','C','benign = (의학) 양성의, 무해한',1,null],
    ['tq07','어휘','COMMON','"Manifest" as a verb means:',null,'to hide','to show clearly','to deny','to question','B','manifest = 명백히 드러내다',2,null],
    ['tq08','어휘','SEOUL','빈칸에 알맞은 단어: "The CEO\'s _____ leadership style alienated many employees."',null,'inclusive','autocratic','collaborative','empathetic','B','autocratic = 독재적인, 권위적인',3,null],
    ['tq09','어휘','COMMON','"Diligent"과 유사한 의미의 단어는?',null,'lazy','careless','industrious','impulsive','C','diligent = industrious = 부지런한',1,null],
    ['tq10','어휘','SKY','"The scholar\'s _____ critique challenged long-held assumptions in the field."',null,'superficial','cursory','incisive','perfunctory','C','incisive = 날카로운, 예리한',3,null],
    // 문법 — COMMON/SEOUL/SKY
    ['tq11','문법','COMMON','빈칸에 알맞은 것: "She _____ in Paris for three years before moving to London."',null,'lived','has lived','had lived','was living','C','for + 기간 + before 과거 → 과거완료',2,null],
    ['tq12','문법','COMMON','어법상 올바른 문장은?',null,
      'The committee have reached its decision.',
      'The committee has reached their decision.',
      'The committee has reached its decision.',
      'The committee have reached their decisions.','C','committee는 단수 집합명사(미국식) → has/its',2,null],
    ['tq13','문법','COMMON','빈칸에 알맞은 것: "_____ difficult the problem may be, we must find a solution."',null,'However','Whatever','Wherever','Whenever','A','however + 형용사 = 아무리 ~해도',2,null],
    ['tq14','문법','SEOUL','틀린 부분을 찾으시오:\n"The report that was ① submitted ② by the researchers ③ contains ④ important informations."',null,'①','②','③','④','D','information = 불가산명사, informations 불가',2,null],
    ['tq15','문법','SKY','빈칸에 알맞은 것:\n"Not until the 20th century _____ the full extent of the damage realized."',null,'was','did','had','were','A','부정어 도치: Not until ~ was + 주어',3,null],
    ['tq16','문법','COMMON','올바른 문장은?',null,
      'I look forward to meet you.',
      'I look forward to meeting you.',
      'I look forward to have met you.',
      'I look forward meeting you.','B','look forward to + V-ing',1,null],
    ['tq17','문법','COMMON','빈칸에 알맞은 관계대명사:\n"The author _____ book won the prize gave a speech."',null,'who','whom','whose','which','C','선행사 + whose + 명사 = 소유격 관계대명사',2,null],
    ['tq18','문법','SEOUL','어법상 옳은 것은?',null,
      'If I were you, I will accept the offer.',
      'If I were you, I would accept the offer.',
      'If I am you, I would accept the offer.',
      'If I was you, I will accept the offer.','B','가정법 과거: If + were, would + 원형',2,null],
    ['tq19','문법','SKY','빈칸에 알맞은 것:\n"The policy, along with several amendments, _____ approved yesterday."',null,'were','have been','was','are','C','주어 = The policy (단수) → was',3,null],
    ['tq20','문법','COMMON','어법상 올바른 것은?',null,
      'Despite of the rain, they continued playing.',
      'Despite the rain, they continued playing.',
      'Although the rain, they continued playing.',
      'Even the rain, they continued playing.','B','despite + 명사구 (despite of X)',2,null],
    // 독해 — COMMON
    ['tq21','독해','COMMON',`다음 글의 요지는?
"The placebo effect demonstrates the power of the mind over the body. When patients believe they are receiving effective treatment—even if it is an inert substance—they often experience real physiological improvements. This phenomenon highlights the importance of the doctor-patient relationship and patient expectations in medical outcomes."`,
    null,
    '위약 효과는 의학적으로 검증되지 않았다.',
    '의사-환자 관계는 치료 효과에 영향을 미친다.',
    '정신이 신체에 미치는 영향과 의사-환자 관계의 중요성이 치료 결과를 좌우한다.',
    '위약은 진짜 약과 동일한 효과를 낸다.','C','위약 효과를 통해 mind-body connection + 의사-환자 관계 중요성 설명',2,null],
    ['tq22','독해','SEOUL',`빈칸에 가장 적절한 것은?
"The transition from hunter-gatherer societies to agricultural communities was not merely a change in food production; it fundamentally altered human social structures. The surplus food generated by farming allowed for _____, giving rise to cities, specialized labor, and complex governance systems."`,
    null,'population decline','nomadic lifestyles','population growth and settlement','simpler social organization','C',
    '농업 → 잉여식량 → 인구증가 및 정착 → 도시화',3,null],
    ['tq23','독해','SKY',`다음 글의 논리적 구조로 가장 적절한 것은?
"Critics argue that social media polarizes political discourse. However, research indicates that most users primarily consume content aligning with their existing beliefs—a phenomenon called confirmation bias. This suggests the problem may not be social media per se, but rather pre-existing psychological tendencies amplified by algorithmic recommendation systems."`,
    null,
      '주장 → 반박 → 종합',
      '문제 제기 → 원인 분석 → 해결책 제시',
      '통념 → 반론 → 재해석',
      '가설 → 검증 → 결론','C',
      'Critics(통념) → However research(반론) → This suggests(재해석)',3,null],
    ['tq24','독해','COMMON',`내용과 일치하는 것은?
"Ocean acidification, caused by the absorption of CO2, threatens marine ecosystems. As seawater becomes more acidic, organisms that build shells or skeletons from calcium carbonate—such as corals and mollusks—struggle to maintain their structures. This has cascading effects throughout the food web."`,
    null,
      '해양 산성화는 CO2 배출을 증가시킨다.',
      '탄산칼슘 구조물을 만드는 생물들이 영향을 받는다.',
      '산성화는 먹이사슬에 제한적인 영향만 미친다.',
      '산호는 산성화에 영향을 받지 않는다.','B','corals and mollusks struggle → B 정답',2,null],
    ['tq25','독해','SEOUL',`글의 흐름상 가장 어색한 문장은?
"① The concept of emotional intelligence (EI) has gained prominence in organizational psychology. ② EI refers to the ability to perceive, understand, and manage emotions. ③ High EI is associated with better leadership effectiveness and team performance. ④ IQ tests have been criticized for cultural bias."`,
    null,'①','②','③','④','D','④는 IQ에 관한 내용으로 EI 주제와 무관',3,null],
    // 논리 — COMMON/SEOUL/SKY
    ['tq26','논리','COMMON','다음 삼단논법의 결론은?\n전제1: 법을 어기는 자는 처벌을 받는다.\n전제2: 그는 법을 어겼다.',null,
      '그는 처벌을 받아야 한다.','그는 법을 잘 안다.','그는 반성할 것이다.','그는 다시 법을 어길 것이다.','A','직접 삼단논법',1,null],
    ['tq27','논리','COMMON','다음 논증의 오류 유형은?\n"유명 운동선수가 이 음료를 마신다. 따라서 이 음료는 건강에 좋다."',null,
      '허수아비 오류','권위에 호소하는 오류','미끄러운 경사면 오류','논점 이탈의 오류','B','celebrity endorsement = 권위(인기)에 호소하는 오류',2,null],
    ['tq28','논리','SEOUL','다음 조건에서 반드시 참인 것은?\n조건: 비가 오면 소풍을 취소한다. 소풍을 취소하면 박물관을 방문한다.',null,
      '박물관을 방문하면 비가 온 것이다.',
      '비가 오면 박물관을 방문한다.',
      '소풍을 가면 비가 오지 않은 것이다.',
      '박물관을 방문하지 않으면 소풍을 갔다.','B','P→Q, Q→R ∴ P→R 연쇄 삼단논법',2,null],
    ['tq29','논리','SKY','다음 논증의 가장 치명적인 약점은?\n"A국의 총기 소지 허용 이후 범죄율이 감소했다. 따라서 총기 소지를 허용하면 범죄가 줄어든다."',null,
      '총기 소지 허용은 위험하다.',
      '상관관계와 인과관계를 혼동하고 있으며, 다른 요인들을 고려하지 않았다.',
      '범죄율 감소 자료가 신뢰할 수 없다.',
      '총기 관련 법률은 국가마다 다르다.','B','상관관계≠인과관계 + 제3변수 무시',3,null],
    ['tq30','논리','SKY','5명(A,B,C,D,E)이 한 줄로 서 있다. 조건: A는 B보다 앞에 있다. C는 D보다 앞에 있다. B는 C 바로 뒤에 있다. E는 맨 앞이다. 맨 뒤에 서 있는 사람은?',null,'A','B','C','D','D',
      'E-A-C-B-D 순서: E(1st),A(2nd),C(3rd),B(4th),D(5th)',3,null],
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
      // grammar / reading / logic / vocab section
      const sectionMap = { grammar:'문법', reading:'독해', logic:'논리', vocab_section:'어휘' };
      const section = sectionMap[session_type] || session_type;
      questions = db.prepare(`SELECT id,section,question_text,passage,option_a,option_b,option_c,option_d,difficulty
        FROM tl_test_questions WHERE section=? AND (university_type=? OR university_type='COMMON')
        ORDER BY RANDOM() LIMIT ?`).all(section, university_type, parseInt(count));
    }

    if (!questions.length) return res.status(404).json({ error: '문제를 찾을 수 없습니다' });

    const id = tlUid();
    db.prepare(`INSERT INTO tl_test_sessions
      (id,student_id,session_type,university_type,questions,created_at) VALUES (?,?,?,?,?,?)`)
      .run(id, req.tUser.id, session_type, university_type, JSON.stringify(questions.map(q=>q.id)),
           Math.floor(Date.now()/1000));

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
                        question_text: q.question_text });
      });
    }

    const sectionScores = {};
    Object.keys(sectionTotal).forEach(s => {
      sectionScores[s] = { correct: sectionCorrect[s]||0, total: sectionTotal[s],
                           pct: Math.round((sectionCorrect[s]||0)/sectionTotal[s]*100) };
    });

    const pct = total > 0 ? Math.round(correct/total*100) : 0;
    const now = Math.floor(Date.now()/1000);
    db.prepare(`UPDATE tl_test_sessions
      SET answers=?, score=?, total=?, section_scores=?, completed_at=? WHERE id=?`)
      .run(JSON.stringify(answers), correct, total, JSON.stringify(sectionScores), now, session_id);

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

// ── 강약점 분석 ────────────────────────────────────────────────────
app.get('/api/tl/analytics', tlAuth, (req, res) => {
  try {
    const sid = req.tUser.role === 'student' ? req.tUser.id : req.query.student_id;
    if (!sid) return res.status(400).json({ error: 'student_id 필요' });

    const sessions = db.prepare(`
      SELECT session_type,score,total,section_scores,completed_at FROM tl_test_sessions
      WHERE student_id=? AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 100`).all(sid);

    if (!sessions.length) return res.json({ message: '테스트 기록 없음', sections: {}, overall: 0 });

    const sectionAgg = {};
    sessions.forEach(s => {
      const scores = s.section_scores ? JSON.parse(s.section_scores) : {};
      Object.entries(scores).forEach(([sec, data]) => {
        if (!sectionAgg[sec]) sectionAgg[sec] = { correct:0, total:0 };
        sectionAgg[sec].correct += data.correct||0;
        sectionAgg[sec].total   += data.total||0;
      });
    });

    const sectionResults = {};
    let totalCorrect=0, totalQ=0;
    Object.entries(sectionAgg).forEach(([sec,{correct,total}]) => {
      const pct = total>0 ? Math.round(correct/total*100) : 0;
      sectionResults[sec] = { correct, total, pct,
        level: pct>=80?'우수':pct>=60?'보통':'취약',
        feedback: pct>=80
          ? `${sec} 영역 우수! 현재 수준 유지하며 심화 문제에 도전하세요.`
          : pct>=60
          ? `${sec} 영역 보통 수준. 틀린 문제 유형을 집중적으로 복습하세요.`
          : `${sec} 영역 취약! 기초 개념부터 체계적으로 다시 학습하세요.`
      };
      totalCorrect += correct; totalQ += total;
    });

    const overall = totalQ>0 ? Math.round(totalCorrect/totalQ*100) : 0;
    const weak = Object.entries(sectionResults)
      .filter(([,v])=>v.pct<60).map(([k])=>k);
    const strong = Object.entries(sectionResults)
      .filter(([,v])=>v.pct>=80).map(([k])=>k);

    const recommendations = [];
    if (weak.includes('어휘')) recommendations.push('매일 단어 테스트 10개씩 꾸준히 학습하세요.');
    if (weak.includes('문법')) recommendations.push('문법 기초 강의 녹화본을 재복습하고 문법 문제를 집중적으로 풀어보세요.');
    if (weak.includes('독해')) recommendations.push('독해 지문을 소리 내어 읽고 문단별 핵심 내용을 요약 정리해보세요.');
    if (weak.includes('논리')) recommendations.push('논리 추론 문제 풀이 전략을 강사에게 질문하고 유형별로 정리하세요.');
    if (!weak.length) recommendations.push('전 영역 양호! 학교 유형별 테스트로 목표 대학에 맞춘 연습을 진행하세요.');

    res.json({
      overall, sections: sectionResults, weak, strong,
      test_count: sessions.length, recommendations,
      last_test: sessions[0]?.completed_at
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

// ─────────────────────────────────────────────────────────────────
// 편입 LMS 프론트엔드 라우팅
app.get('/transfer', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'transfer.html')));
app.get('/transfer/*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'transfer.html')));

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
