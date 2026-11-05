import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { boardInputSchema, type Board, type BoardInput, type BoardScan } from "../shared/boards";
import { boardSearchKey } from "../lib/board-identity";
import { writeProfileSettings } from "./settings-persistence";

const APPLICATION_ID = 0x5a424259;
type Row = Record<string, unknown>;
type Recovery = { target: string; working: string; hash: string };
function watchKey(url: string, instructions: string) {
  const link = boardSearchKey(url);
  return instructions ? JSON.stringify([link, instructions]) : link;
}
async function hash(file: string) { return createHash("sha256").update(await readFile(file)).digest("hex"); }
function contents(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    validate(db);
    return JSON.stringify([db.prepare("SELECT * FROM boards ORDER BY id").all(),
      db.prepare("SELECT * FROM board_checks ORDER BY id").all(),
      db.prepare("SELECT * FROM board_jobs ORDER BY board_id,revision,identity").all(),
      db.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all()]);
  } finally { db.close(); }
}
function validate(db: DatabaseSync) {
  if (db.prepare("PRAGMA application_id").get()?.application_id !== APPLICATION_ID ||
      ![1, 2].includes(Number(db.prepare("PRAGMA user_version").get()?.user_version)) ||
      db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") {
    throw new Error("Choose a Zebby Boards database. Your Applications database is a separate file.");
  }
}
function schema(db: DatabaseSync) {
  db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 2;
    CREATE TABLE boards (id TEXT PRIMARY KEY, company TEXT NOT NULL, url TEXT NOT NULL,
      search_key TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL DEFAULT 1, instructions TEXT NOT NULL DEFAULT '',
      last_check_id INTEGER NOT NULL DEFAULT 0, reviewed_through INTEGER NOT NULL DEFAULT 0,
      last_checked_at TEXT NOT NULL DEFAULT '', last_attempt_at TEXT NOT NULL DEFAULT '',
      total_count INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE TABLE board_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, checked_at TEXT NOT NULL, status TEXT NOT NULL,
      pages INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
      provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '');
    CREATE TABLE board_jobs (board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, identity TEXT NOT NULL, url TEXT NOT NULL,
      first_check_id INTEGER NOT NULL, last_check_id INTEGER NOT NULL, matches INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(board_id, revision, identity));
    CREATE INDEX board_jobs_unreviewed ON board_jobs(board_id, revision, first_check_id);`);
}

function upgradeWorkingCopy(db: DatabaseSync) {
  if (db.prepare("PRAGMA user_version").get()?.user_version !== 1) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`ALTER TABLE boards ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
      ALTER TABLE board_jobs ADD COLUMN matches INTEGER NOT NULL DEFAULT 1;
      PRAGMA user_version = 2; COMMIT;`);
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export class BoardsStore {
  private db: DatabaseSync | null = null;
  private target = "";
  private working = "";
  private sourceHash = "";
  private dirty = false;
  private queue: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private recoveryFile: string;
  constructor(private readonly profile: string) { this.recoveryFile = path.join(profile, "boards-pending.json"); }
  get generation() { return this.epoch; }
  get status() { return { filePath: this.target, filename: this.target ? path.basename(this.target) : "", dirty: this.dirty }; }
  private database() { if (!this.db) throw new Error("Choose a Boards database first."); return this.db; }
  private async current() {
    if (!(await stat(this.target).catch(() => null))?.isFile()) throw new Error("The Boards database is missing. Wait for OneDrive, then retry.");
    if (await hash(this.target) !== this.sourceHash) throw new Error(this.dirty
      ? "The Boards database changed outside this app. Save a recovery copy before reopening it."
      : "The Boards database changed outside this app. Open it again before making changes.");
  }
  private async flush() {
    await this.current();
    try { await backup(this.database(), this.target); }
    catch { throw new Error("Boards changes are saved on this computer. Use Retry save when OneDrive is ready."); }
    this.sourceHash = await hash(this.target);
    await unlink(this.recoveryFile).catch(error => { if (error.code !== "ENOENT") throw error; });
    this.dirty = false;
  }
  private write<T>(action: (db: DatabaseSync) => T): Promise<T> {
    const run = this.queue.then(async () => {
      if (this.dirty) throw new Error("Use Retry save for the Boards database before making another change.");
      await this.current();
      const db = this.database();
      // Write the recovery marker before committing locally. A crash after the
      // commit must never cause startup to replace pending data with cloud data.
      await writeProfileSettings(this.recoveryFile, JSON.stringify({ target: this.target, working: this.working, hash: this.sourceHash }));
      db.exec("BEGIN IMMEDIATE");
      let result: T;
      try { result = action(db); db.exec("COMMIT"); }
      catch (error) { db.exec("ROLLBACK"); await unlink(this.recoveryFile); throw error; }
      this.dirty = true;
      await this.flush();
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
  async create(file: string) {
    await this.queue;
    if (this.dirty) throw new Error("Save pending Boards changes before creating another database.");
    await mkdir(this.profile, { recursive: true });
    const temporary = path.join(this.profile, `boards-new-${randomUUID()}.sqlite`);
    const db = new DatabaseSync(temporary);
    try { schema(db); } finally { db.close(); }
    try { await copyFile(temporary, file, constants.COPYFILE_EXCL); }
    finally { await unlink(temporary); }
    await this.open(file);
  }
  async open(file: string) {
    await this.queue;
    if (this.dirty) throw new Error("Save pending Boards changes or save a recovery copy before opening another database.");
    await mkdir(this.profile, { recursive: true });
    const target = path.resolve(file);
    let recovered: Recovery | null = null;
    try { recovered = JSON.parse(await readFile(this.recoveryFile, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("The pending Boards save could not be read. Keep the local recovery files."); }
    const working = path.join(this.profile, `boards-${createHash("sha256").update(target.toLowerCase()).digest("hex")}.sqlite`);
    if (recovered && (recovered.target !== target || recovered.working !== working || !/^[a-f0-9]{64}$/.test(recovered.hash))) {
      throw new Error("Open the Boards database with pending changes first: " + recovered.target);
    }
    const incoming = recovered ? working : working + ".incoming";
    let sourceHash = recovered?.hash || "";
    if (!recovered) {
      await copyFile(target, incoming);
      sourceHash = await hash(incoming);
      if (sourceHash !== await hash(target)) { await unlink(incoming); throw new Error("The Boards database changed while opening. Wait for OneDrive and try again."); }
    }
    const check = new DatabaseSync(incoming, { readOnly: !recovered });
    try { validate(check); } finally { check.close(); }
    // SQLite backup changes header counters. Compare records, not file bytes,
    // when recovering a crash after publication but before marker removal.
    if (recovered) {
      const publishedHash = await hash(target).catch(() => "");
      let publishedContents: string | null = null;
      try { if (publishedHash && publishedHash !== sourceHash) publishedContents = contents(target); }
      catch { /* A damaged cloud file must not prevent local recovery. */ }
      if (publishedContents !== null && publishedContents === contents(working)) {
        await unlink(this.recoveryFile); sourceHash = publishedHash; recovered = null;
      }
    }
    this.db?.close();
    if (incoming !== working) { await copyFile(incoming, working); await unlink(incoming); }
    this.db = new DatabaseSync(working);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 3000;");
    upgradeWorkingCopy(this.db);
    this.target = target; this.working = working; this.sourceHash = sourceHash; this.dirty = Boolean(recovered); this.epoch++;
  }
  async recoverOnStartup(): Promise<boolean> {
    let marker: Recovery;
    try { marker = JSON.parse(await readFile(this.recoveryFile, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    if (typeof marker?.target !== "string") throw new Error("The pending Boards save could not be read.");
    await this.open(marker.target); return true;
  }
  async retrySave() {
    const run = this.queue.then(async () => { if (this.dirty) await this.flush(); });
    this.queue = run.catch(() => undefined); return run;
  }
  async saveRecoveryCopy(file: string) {
    const run = this.queue.then(async () => {
      // Exclusive creation prevents the recovery action from overwriting a database.
      await copyFile(this.working, file, constants.COPYFILE_EXCL);
      await unlink(this.recoveryFile).catch(error => { if (error.code !== "ENOENT") throw error; });
      this.dirty = false;
      return file;
    });
    this.queue = run.catch(() => undefined); return run;
  }
  list(): Board[] {
    if (!this.db) return [];
    return (this.db.prepare(`SELECT b.*, (SELECT COUNT(*) FROM board_jobs j WHERE j.board_id=b.id AND j.revision=b.revision
      AND j.matches=1 AND j.first_check_id>b.reviewed_through) AS new_count FROM boards b ORDER BY b.created_at,b.id`).all() as Row[]).map(row => ({
      id: String(row.id), company: String(row.company), url: String(row.url), revision: Number(row.revision),
      instructions: String(row.instructions),
      lastCheckedAt: String(row.last_checked_at), lastAttemptAt: String(row.last_attempt_at), lastCheckId: Number(row.last_check_id),
      newCount: Number(row.new_count), totalCount: Number(row.total_count), error: String(row.error), createdAt: String(row.created_at),
    }));
  }
  get(id: string) { const board = this.list().find(board => board.id === id); if (!board) throw new Error("This board is no longer available."); return board; }
  knownMatches(id: string, revision: number) {
    const rows = this.database().prepare("SELECT identity,matches FROM board_jobs WHERE board_id=? AND revision=?").all(id, revision);
    return new Map(rows.map(row => [String(row.identity), Boolean(row.matches)]));
  }
  async add(inputs: BoardInput[]) {
    if (!inputs.length || inputs.length > 100) throw new Error("Add between 1 and 100 board links.");
    const values = inputs.map(input => boardInputSchema.parse(input));
    return this.write(db => values.map(input => {
      const instructions = input.instructions ?? "", key = watchKey(input.url, instructions);
      if (db.prepare("SELECT id FROM boards WHERE search_key=?").get(key)) throw new Error("This board link is already saved with the same tracking instructions.");
      const id = randomUUID();
      db.prepare("INSERT INTO boards(id,company,url,search_key,instructions,created_at) VALUES (?,?,?,?,?,?)")
        .run(id, input.company, input.url, key, instructions, new Date().toISOString()); return id;
    }));
  }
  async update(id: string, input: BoardInput) {
    const value = boardInputSchema.parse(input);
    return this.write(db => {
      const board = this.get(id), instructions = value.instructions ?? board.instructions;
      const key = watchKey(value.url, instructions), changed = watchKey(board.url, board.instructions) !== key;
      if (db.prepare("SELECT id FROM boards WHERE search_key=? AND id<>?").get(key, id)) throw new Error("This board link is already saved with the same tracking instructions.");
      db.prepare("UPDATE boards SET company=?,url=?,search_key=?,instructions=? WHERE id=?").run(value.company, value.url, key, instructions, id);
      if (changed) db.prepare("UPDATE boards SET revision=revision+1,last_check_id=0,reviewed_through=0,last_checked_at='',last_attempt_at='',total_count=0,error='' WHERE id=?").run(id);
    });
  }
  async remove(id: string) { return this.write(db => { db.prepare("DELETE FROM boards WHERE id=?").run(id); }); }
  async reviewed(id: string, through: number) {
    return this.write(db => {
      const board = this.get(id);
      if (!Number.isSafeInteger(through) || through < 0 || through > board.lastCheckId) throw new Error("Refresh Boards before marking this check reviewed.");
      const check = db.prepare("SELECT id FROM board_checks WHERE id=? AND board_id=? AND revision=? AND status='complete'").get(through, id, board.revision);
      if (!check) throw new Error("This check belongs to an earlier board link. Refresh Boards.");
      db.prepare("UPDATE boards SET reviewed_through=MAX(reviewed_through,?) WHERE id=?").run(through, id);
    });
  }
  async complete(id: string, revision: number, generation: number, scan: BoardScan) {
    return this.write(db => {
      const board = this.get(id);
      if (this.epoch !== generation || board.revision !== revision) throw new Error("The board or database changed during this check. Check it again.");
      const now = new Date().toISOString();
      const jobs = [...new Map(scan.jobs.map(job => [job.key, job])).values()];
      const total = jobs.filter(job => job.matches).length;
      const check = Number(db.prepare("INSERT INTO board_checks(board_id,revision,checked_at,status,pages,total,provider,model) VALUES (?,?,?,'complete',?,?,?,?)")
        .run(id, revision, now, scan.pages, total, scan.provider, scan.model).lastInsertRowid);
      const insert = db.prepare(`INSERT INTO board_jobs(board_id,revision,identity,url,first_check_id,last_check_id,matches) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(board_id,revision,identity) DO UPDATE SET url=excluded.url,last_check_id=excluded.last_check_id`);
      for (const job of jobs) insert.run(id, revision, job.key, job.url, check, check, Number(job.matches));
      db.prepare("UPDATE boards SET last_check_id=?,last_checked_at=?,last_attempt_at=?,total_count=?,error='',reviewed_through=CASE WHEN last_check_id=0 THEN ? ELSE reviewed_through END WHERE id=?")
        .run(check, now, now, total, check, id);
    });
  }
  async failed(id: string, revision: number, generation: number, message: string) {
    return this.write(db => {
      const board = this.get(id);
      if (this.epoch !== generation || board.revision !== revision) return;
      const now = new Date().toISOString(), error = message.slice(0, 1000);
      db.prepare("INSERT INTO board_checks(board_id,revision,checked_at,status,error) VALUES(?,?,?,'failed',?)").run(id, revision, now, error);
      db.prepare("UPDATE boards SET last_attempt_at=?,error=? WHERE id=?").run(now, error, id);
    });
  }
  async close() { await this.queue; this.db?.close(); this.db = null; this.epoch++; }
}
