import { useEffect, useState } from "react";
import { Check, FolderOpen, LoaderCircle, Pencil, Plus, RefreshCw, X } from "lucide-react";
import type { Board, BoardsState } from "../../shared/boards";
import SettingsAction from "./SettingsAction";

const initial: BoardsState = { filePath: "", filename: "", dirty: false, error: "", boards: [], progress: [] };
const message = (error: unknown) => (error instanceof Error ? error.message : "This action could not be completed. Try again.")
  .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");

function useBoards() {
  const [state, setState] = useState<BoardsState>(initial), [error, setError] = useState(""), [working, setWorking] = useState(false);
  useEffect(() => {
    let active = true, received = false;
    const remove = window.desktop!.onBoardsChanged(next => { received = true; if (active) setState(next); });
    void window.desktop!.boardsState().then(next => { if (active && !received) setState(next); }).catch(error => { if (active) setError(message(error)); });
    return () => { active = false; remove(); };
  }, []);
  async function act(action: () => Promise<unknown>) {
    setError(""); setWorking(true);
    try { await action(); return true; }
    catch (error) { setError(message(error)); return false; }
    finally { setWorking(false); }
  }
  return { state, error, working, act };
}

function DatabaseControls({ state, working, act }: Pick<ReturnType<typeof useBoards>, "state" | "working" | "act">) {
  const busy = working || state.progress.length > 0;
  return <div className="boards-database">
    <div className="database-location"><span>Current file</span><strong>{state.filename || "No Boards database selected"}</strong>
      {state.filePath && <code title={state.filePath}>{state.filePath}</code>}</div>
    {state.dirty && <p className="sync-warning" role="status">Boards changes are saved on this computer and waiting to reach your database file.</p>}
    <div className="settings-actions">
      <SettingsAction icon={FolderOpen} disabled={busy || state.dirty} onClick={() => void act(() => window.desktop!.chooseBoardsDatabase("open"))}>Open Boards database</SettingsAction>
      <SettingsAction icon={Plus} disabled={busy || state.dirty} onClick={() => void act(() => window.desktop!.chooseBoardsDatabase("create"))}>Create Boards database</SettingsAction>
      {state.dirty && <><SettingsAction icon={RefreshCw} disabled={busy} onClick={() => void act(() => window.desktop!.retryBoardsSave())}>Retry save</SettingsAction>
        <SettingsAction icon={FolderOpen} disabled={busy} onClick={() => void act(() => window.desktop!.saveBoardsRecovery())}>Save recovery copy</SettingsAction></>}
    </div>
  </div>;
}

export function BoardsDatabaseSettings() {
  const controls = useBoards();
  return <section className="settings-section" aria-labelledby="boards-database-settings">
    <div className="settings-section-heading"><h2 id="boards-database-settings">Boards database</h2></div>
    <div className="settings-content"><DatabaseControls {...controls} />
      {(controls.error || controls.state.error) && <p className="boards-error" role="alert">{controls.error || controls.state.error}</p>}
      <p className="settings-help">Choose your OneDrive folder to keep Boards history across your computers.</p>
    </div>
  </section>;
}

function companyFromUrl(value: string) {
  const url = new URL(value), host = url.hostname.replace(/^(www\.|jobs\.|careers\.)/, "");
  if (host === "metacareers.com") return "Meta";
  const name = /greenhouse|lever\.co|ashbyhq/.test(host) ? url.pathname.split("/").filter(Boolean)[0] || host : host.split(".")[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export default function BoardsView({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const controls = useBoards(), { state, error, working, act } = controls;
  const [adding, setAdding] = useState(false), [editing, setEditing] = useState<Board | null>(null);
  const [links, setLinks] = useState(""), [company, setCompany] = useState("");
  const [instructions, setInstructions] = useState("");
  const [databaseOpen, setDatabaseOpen] = useState(false);
  const dirty = editing ? links !== editing.url || company !== editing.company || instructions !== (editing.instructions || "")
    : adding && Boolean(links || company || instructions);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  function reset() { setAdding(false); setEditing(null); setLinks(""); setCompany(""); setInstructions(""); }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    const success = await act(async () => {
      const urls = links.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      if (!urls.length) throw new Error("Paste at least one board link.");
      if (editing && urls.length !== 1) throw new Error("Use one link when editing a board.");
      const inputs = urls.map(url => ({ url, company: company.trim() || companyFromUrl(url), instructions: instructions.trim() }));
      if (editing) await window.desktop!.updateBoard(editing.id, inputs[0]);
      else await window.desktop!.addBoards(inputs);
    });
    if (success) reset();
  }
  function canReplaceDraft() { return !dirty || window.confirm("Discard unsaved changes to this board?"); }
  function beginAdd() { if (canReplaceDraft()) { reset(); setAdding(true); } }
  function edit(board: Board) {
    if (editing?.id === board.id || !canReplaceDraft()) return;
    setEditing(board); setCompany(board.company); setLinks(board.url); setInstructions(board.instructions || ""); setAdding(false);
  }
  return <main className="desktop-main boards-page" aria-label="Boards">
    <div className="boards-toolbar"><div className="boards-title"><h1>Boards</h1><span className="boards-private">Private</span></div>
      {state.filePath && <div className="boards-toolbar-actions">
        <button type="button" className="button button-secondary" disabled={working || state.dirty || !state.boards.length || state.progress.length > 0}
          onClick={() => void act(() => window.desktop!.checkBoards())}><RefreshCw size={16} aria-hidden="true" />Check all</button>
        <button type="button" className="button button-primary" data-command="new" disabled={working || state.dirty}
          onClick={beginAdd}><Plus size={17} aria-hidden="true" />Add boards</button>
      </div>}
    </div>
    {(error || state.error) && <p className="boards-error" role="alert">{error || state.error}</p>}
    {state.dirty && <div className="boards-save-pending" role="status"><span>Boards changes are waiting to reach your database file.</span>
      <button type="button" className="boards-text-action" disabled={working} onClick={() => void act(() => window.desktop!.retryBoardsSave())}>Retry save</button>
      <button type="button" className="boards-text-action" disabled={working || state.progress.length > 0} onClick={() => void act(() => window.desktop!.saveBoardsRecovery())}>Save recovery copy</button></div>}
    {!state.filePath ? <div className="boards-setup"><h2>Keep your boards together</h2>
      <p>Create a Boards database in your OneDrive folder, or open one you already use.</p><DatabaseControls {...controls} /></div>
    : <>
      {(adding || editing) && <form className="boards-editor" onSubmit={event => void save(event)} aria-label={editing ? "Edit board" : "Add boards"}>
        <label><span>{editing ? "Board link" : "Board links"}</span><textarea autoFocus rows={editing ? 2 : 3} value={links} required maxLength={100000}
          placeholder="Paste links here, one per line" onChange={event => setLinks(event.target.value)} disabled={working} /></label>
        <label className="boards-company-field"><span>Company name <small>(optional)</small></span><input value={company} maxLength={120}
          placeholder="Use the website name" onChange={event => setCompany(event.target.value)} disabled={working} /></label>
        <label><span>Tracking instructions <small>(optional)</small></span>
          <textarea rows={2} value={instructions} maxLength={2000} disabled={working}
            placeholder="Only track Senior or Principal Product Manager roles."
            aria-describedby="board-instructions-help" onChange={event => setInstructions(event.target.value)} /></label>
        <p id="board-instructions-help" className="board-field-help">{!editing && links.trim().split(/\r?\n/).filter(Boolean).length > 1
          ? "These instructions apply to each link above. Leave blank to track all openings."
          : "Describe the titles, seniority, or team headings to look for. Leave blank to track all openings."}</p>
        {editing && (links.trim() !== editing.url || instructions.trim() !== (editing.instructions || "")) &&
          <p className="settings-help">Changing the link or instructions starts a new baseline on the next check.</p>}
        {!editing && <p className="settings-help">The first check saves your starting point. Later checks look for new listings.</p>}
        <div className="boards-editor-actions"><button type="submit" className="button button-primary" disabled={working || state.dirty}>
          {working && <LoaderCircle size={16} className="spin" aria-hidden="true" />}{editing ? "Save board" : "Add and check"}</button>
          <button type="button" className="button button-secondary" disabled={working} onClick={reset}>Cancel</button></div>
      </form>}
      {!state.boards.length && !adding ? <div className="boards-empty"><h2>Your next opportunity starts here</h2>
        <p>Save the company career pages you check regularly.</p>
        <button type="button" className="button button-primary" onClick={() => setAdding(true)} disabled={state.dirty}><Plus size={17} aria-hidden="true" />Add your first boards</button></div>
      : state.boards.length > 0 && <div className="boards-list" aria-label="Saved boards">
        <div className="boards-columns" aria-hidden="true"><span>Company and board link</span><span>Last checked on</span><span>Updates</span><span /></div>
        {state.boards.map(board => {
          const progress = state.progress.find(item => item.boardId === board.id);
          return <article key={board.id} className="board-row" aria-label={board.company}>
            <div className="board-identity"><strong>{board.company}</strong><a href={board.url} target="_blank" rel="noopener noreferrer" title={board.url}>{board.url}</a>
              {board.instructions && <span className="board-instructions" title={board.instructions}>{board.instructions}</span>}</div>
            <div className="board-date"><span className="board-mobile-label">Last checked on</span>{board.lastCheckedAt
              ? <time dateTime={board.lastCheckedAt} title={new Date(board.lastCheckedAt).toLocaleString()}>{new Date(board.lastCheckedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</time>
              : <span>Never checked</span>}</div>
            <div className="board-result">
              {board.newCount > 0 ? <><span className="board-discoveries" role="status">{board.newCount} new {board.newCount === 1 ? "listing" : "listings"} found</span>
                <button type="button" className="boards-text-action" disabled={working || state.dirty} onClick={() => void act(() => window.desktop!.markBoardReviewed(board.id, board.lastCheckId))}>
                  <Check size={14} aria-hidden="true" />Mark as reviewed</button></> : board.lastCheckedAt && <span className="board-no-updates">{board.error ? "Check incomplete" : "No new listings"}</span>}
              {board.instructions && board.lastCheckedAt && <span className="board-match-total">{board.totalCount} matching {board.totalCount === 1 ? "role" : "roles"} at last check</span>}
              {progress && <span className="board-progress" role="status"><LoaderCircle size={13} className="spin" aria-hidden="true" />{progress.message}</span>}
            </div>
            <div className="board-actions">{progress ? <button type="button" className="button button-secondary" disabled={progress.phase === "saving"}
              onClick={() => void act(() => window.desktop!.cancelBoardCheck(board.id))}>Cancel check</button>
              : <button type="button" className="button button-secondary" disabled={working || state.dirty} onClick={() => void act(() => window.desktop!.checkBoards([board.id]))}>
                <RefreshCw size={15} aria-hidden="true" />Check for updates</button>}
              <button type="button" className="board-icon-action" aria-label={`Edit ${board.company} board`} title="Edit board" disabled={working || Boolean(progress) || state.dirty} onClick={() => edit(board)}><Pencil size={15} aria-hidden="true" /></button>
              <button type="button" className="board-icon-action" aria-label={`Remove ${board.company} board`} title="Remove board" disabled={working || Boolean(progress) || state.dirty} onClick={() => void act(() => window.desktop!.removeBoard(board.id))}><X size={17} aria-hidden="true" /></button>
            </div>
            {board.error && !progress && <p className="board-check-error" role="alert">{board.error}</p>}
          </article>;
        })}
      </div>}
      <div className="boards-file-footer"><button type="button" className="boards-text-action" aria-expanded={databaseOpen} onClick={() => setDatabaseOpen(!databaseOpen)}><FolderOpen size={15} aria-hidden="true" />{state.filename}</button></div>
      {databaseOpen && <DatabaseControls {...controls} working={working || adding || Boolean(editing)} />}
    </>}
  </main>;
}
