import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowRight, ArrowUpRight, Check, FileText, FolderOpen,
  LoaderCircle, Monitor, Moon, Plus, RefreshCw, RotateCw, Search, Sparkles, Sun, Trash2 } from "lucide-react";
import ApplicationDashboard from "./ApplicationDashboard";
import BoardsView, { BoardsDatabaseSettings } from "./BoardsView";
import LocationEditor from "./LocationEditor";
import ResumePicker from "./ResumePicker";
import AnalysisErrorBanner from "./AnalysisErrorBanner";
import { ErrorBanner, SavedFeedbackProvider, useSavedFeedback } from "./WorkspaceFeedback";
import { pasteJobDescription } from "../../lib/job-text-paste";
import type { DesktopState } from "../bridge";
import type { Plan, PlanInput } from "../store";
import type { Application, Resume } from "../../lib/application-types";
import { AnalysisSettings } from "./AnalysisSettings";
import AnalysisGuide from "./AnalysisGuide";
import { useTabTransition } from "./useTabTransition";
import { AnalysisFlowProvider, SidebarCredits, useAnalysisFlow } from "./AnalysisFlow";
import { CreditsSettings } from "./CreditsSettings";
import { onlineModel } from "../../shared/online-models";
import PlanRecommendations from "./PlanRecommendations";
import PlanAnalysisProgress from "./PlanAnalysisProgress";
import { BackgroundAnalysisProvider, useBackgroundAnalysis } from "./BackgroundAnalysis";
import { jobRunning } from "./analysis-jobs";
import NavigationButton from "./NavigationButton";
import UpdateButton from "./UpdateButton";
import SettingsAction from "./SettingsAction";
import { LOCAL_MODELS } from "../local-model-catalog";
import { importanceForTerms } from "../plan-importance";
import { useInteractiveScrollbars, useWorkspaceShortcuts } from "./useWorkspaceShortcuts";

type Tab = "plan" | "applications" | "boards" | "settings";

function emptyPlan(currentOverview = ""): PlanInput {
  return { listingUrl: "", company: "", title: "", team: "", locations: "",
    description: "", snapshotText: "", snapshotSource: "", currentOverview,
    resumeId: "", keywords: [], themes: [], overview: "" };
}

function inputFromPlan(plan: Plan): PlanInput {
  return { listingUrl: plan.listingUrl, company: plan.company, title: plan.title,
    team: plan.team, locations: plan.locations, description: plan.description,
    snapshotText: plan.snapshotText, snapshotSource: plan.snapshotSource,
    currentOverview: plan.currentOverview, resumeId: plan.resumeId,
    keywords: plan.keywords, themes: plan.themes, overview: plan.overview };
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "The request could not be completed.");
  return body;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

function formatUpdated(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(value));
}

function PlanView({ analysisProvider, ollamaModel, builtInModelId, builtInReady, onDirtyChange, initialSelectedId, onSelectionChange, onApplied }: {
  analysisProvider: DesktopState["analysisProvider"]; ollamaModel: string;
  builtInModelId: string; builtInReady: boolean;
  onDirtyChange: (dirty: boolean) => void;
  initialSelectedId: string | null; onSelectionChange: (id: string | null) => void;
  onApplied: (application: Application, created: boolean) => void;
}) {
  const savedFeedback = useSavedFeedback();
  const retryAction = useRef<() => void>(() => undefined);
  const [listingMessage, setListingMessage] = useState("");
  const descriptionInput = useRef<HTMLTextAreaElement>(null);
  const tailoringSection = useRef<HTMLDivElement>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PlanInput>(() => emptyPlan());
  const [savedDraft, setSavedDraft] = useState<PlanInput>(() => emptyPlan());
  const [lastCurrentOverview, setLastCurrentOverview] = useState("");
  const [filter, setFilter] = useState("");
  const [planListExpanded, setPlanListExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [moving, setMoving] = useState(false);
  const { jobs } = useBackgroundAnalysis();
  const resumeProgress = selectedId ? jobs.get({ kind: "resume", id: selectedId }) : undefined;
  const tailoring = jobRunning(resumeProgress);
  useLayoutEffect(() => {
    if (tailoring) tailoringSection.current?.scrollIntoView({ block: "end", behavior: "instant" });
  }, [tailoring]);
  const analysisProgress = tailoring ? resumeProgress : selectedId ? jobs.get({ kind: "plan", id: selectedId }) : undefined;
  const analyzing = jobRunning(analysisProgress);
  const cancelling = Boolean(analysisProgress?.cancelling);
  const [preparing, setPreparing] = useState(false);
  const handledResults = useRef(new Set<string>());
  const initialSelection = useRef(initialSelectedId);
  const analysisFlow = useAnalysisFlow();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const builtInModel = LOCAL_MODELS.find((model) => model.id === builtInModelId);

  const listingController = useRef<AbortController | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(savedDraft) || Boolean(resumeFile);
  const navigatingBusy = reading || saving || preparing || moving;
  const busy = navigatingBusy || analyzing;
  const selectedPlan = plans.find((plan) => plan.id === selectedId);
  const hasAnalysis = Boolean(selectedPlan && (selectedPlan.matchAnalyzedAt || selectedPlan.keywords.length));
  const jobIsCurrent = selectedPlan &&
    (["listingUrl", "company", "title", "team", "locations", "description"] as const)
      .every((key) => draft[key] === selectedPlan[key]);
  const keywordImportance = importanceForTerms(selectedPlan?.keywords || [],
    jobIsCurrent ? selectedPlan.keywordImportance : [], draft.keywords);
  const themeImportance = importanceForTerms(selectedPlan?.themes || [],
    jobIsCurrent ? selectedPlan.themeImportance : [], draft.themes);
  const matchIsCurrent = selectedPlan && !resumeFile &&
    (["listingUrl", "company", "title", "team", "locations", "description",
      "currentOverview", "resumeId"] as const).every((key) => draft[key] === selectedPlan[key]);
  const matchStrength = matchIsCurrent ? selectedPlan.matchStrength : null;
  const matchNotes = matchIsCurrent ? selectedPlan.matchNotes : "";
  const overviewRationale = matchIsCurrent && draft.overview === selectedPlan.overview
    ? selectedPlan.overviewRationale : "";
  const overviewUnchanged = draft.overview.trim().replace(/\s+/g, " ") ===
    draft.currentOverview.trim().replace(/\s+/g, " ");
  const canAnalyze = Boolean(draft.listingUrl &&
    (draft.resumeId || resumeFile) &&
    draft.description.trim().length >= 100);

  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { if (!loading) onSelectionChange(selectedId); }, [loading, selectedId, onSelectionChange]);
  useEffect(() => {
    if (loading) return;
    let active = true;
    const receive = () => { if (!active) return;
    for (const job of jobs.snapshot()) {
      if (job.kind === "match" || jobRunning(job) || handledResults.current.has(job.requestId)) continue;
      handledResults.current.add(job.requestId);
      const plan = job.result?.plan;
      if (plan) {
        setPlans((current) => current.map((item) => item.id === plan.id && item.updatedAt <= plan.updatedAt ? plan : item)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
        if (selectedId === plan.id && (!selectedPlan || selectedPlan.updatedAt <= plan.updatedAt)) {
          setDraft(inputFromPlan(plan)); setSavedDraft(inputFromPlan(plan)); setLastCurrentOverview(plan.currentOverview);
        }
      }
      if (selectedId === job.id) {
        setError(job.error);
        setNotice("");
        if (job.status === "succeeded") savedFeedback();
        if (job.error) retryAction.current = () => {
          setError("");
          void jobs.start({ kind: job.kind, id: job.id }, { modelLabel: job.modelLabel,
            prepare: (signal) => analysisFlow.prepare({ kind: job.kind, id: job.id }, signal) });
        };
      }
    } };
    const unsubscribe = jobs.subscribe(receive);
    // Replay results that finished while this page was closed or loading.
    queueMicrotask(receive);
    return () => { active = false; unsubscribe(); };
  }, [jobs, loading, selectedId, selectedPlan, savedFeedback, analysisFlow]);

  const loadPlans = useCallback(() => {
    setLoading(true); setError("");
    retryAction.current = loadPlans;
    void Promise.all([
      fetch("/api/plans", { cache: "no-store" }).then((response) => readJson<{ plans: Plan[]; lastCurrentOverview: string }>(response)),
      fetch("/api/resumes", { cache: "no-store" }).then((response) => readJson<{ resumes: Resume[] }>(response)),
    ])
      .then(([{ plans, lastCurrentOverview }, { resumes }]) => {
        setPlans(plans); setResumes(resumes); setLastCurrentOverview(lastCurrentOverview || "");
        const initial = plans.find((plan) => plan.id === initialSelection.current) || plans[0];
        if (initial) {
        setSelectedId(initial.id); setDraft(inputFromPlan(initial)); setSavedDraft(inputFromPlan(initial));
        } else { setDraft(emptyPlan(lastCurrentOverview)); setSavedDraft(emptyPlan(lastCurrentOverview)); }
      })
      .catch((cause) => setError(errorText(cause)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { loadPlans(); }, [loadPlans]);

  useEffect(() => {
    if (listingMessage !== "Details added") return;
    const timer = setTimeout(() => setListingMessage(""), 2400);
    return () => clearTimeout(timer);
  }, [listingMessage]);

  const visiblePlans = useMemo(() => plans.filter((plan) =>
    `${plan.title} ${plan.company} ${plan.listingUrl}`.toLowerCase().includes(filter.toLowerCase())), [plans, filter]);

  function update<K extends keyof PlanInput>(key: K, value: PlanInput[K]) {
    if (analyzing) return;
    if (selectedId) jobs.dismiss({ kind: "plan", id: selectedId });
    setDraft((current) => {
      if (key === "listingUrl" && value !== current.listingUrl) {
        listingController.current?.abort();
        return { ...current, listingUrl: String(value),
          description: current.description === current.snapshotText ? "" : current.description,
          snapshotText: "", snapshotSource: "" };
      }
      return { ...current, [key]: value };
    });
    setNotice("");
  }

  function choose(plan: Plan | null) {
    if (navigatingBusy) return;
    if (dirty && !window.confirm("Discard unsaved changes to this plan?")) return;
    listingController.current?.abort();
    setSelectedId(plan?.id || null);
    setPlanListExpanded(false);
    setDraft(plan ? inputFromPlan(plan) : emptyPlan(lastCurrentOverview));
    setSavedDraft(plan ? inputFromPlan(plan) : emptyPlan(lastCurrentOverview));
    setResumeFile(null);
    const job = plan ? jobs.snapshot().filter(job => job.id === plan.id && job.kind !== "match").sort((a,b) => b.startedAt-a.startedAt)[0] : undefined;
    setError(job?.error || "");
    setNotice(""); setListingMessage("");
    if (job?.error) retryAction.current = () => void analyze(job.kind === "resume");
  }

  const readListing = useCallback(async (url: string) => {
    if (!url.trim()) return;
    listingController.current?.abort();
    const controller = new AbortController();
    listingController.current = controller;
    retryAction.current = () => void readListing(url);
    setReading(true); setError(""); setNotice(""); setListingMessage("");
    try {
      const { details, text } = await readJson<{ details: {
        company: string; title: string; team: string; locations: string;
      }; text: string }>(await fetch("/api/job-posting", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }), signal: controller.signal }));
      if (controller.signal.aborted) return;
      setDraft((current) => current.listingUrl.trim() === url.trim() ? ({ ...current,
        company: current.company || details.company, title: current.title || details.title,
        team: current.team || details.team, locations: current.locations || details.locations,
        description: current.description || text,
        snapshotText: current.snapshotSource === "page" && current.snapshotText ? current.snapshotText : text || current.snapshotText,
        snapshotSource: text ? "page" : current.snapshotSource,
      }) : current);
      setListingMessage(text ? "Details added" : "Could not get the job description. Paste it below.");
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(`${errorText(cause)} You can paste the job description below.`);
    } finally {
      if (listingController.current === controller) { listingController.current = null; setReading(false); }
    }
  }, []);

  useEffect(() => {
    const url = draft.listingUrl.trim();
    if (!/^https:\/\//i.test(url) || draft.snapshotText ||
        (selectedId && savedDraft.listingUrl === url)) return;
    const timer = window.setTimeout(() => void readListing(url), 650);
    return () => window.clearTimeout(timer);
  }, [draft.listingUrl, draft.snapshotText, selectedId, savedDraft.listingUrl, readListing]);

  useEffect(() => () => listingController.current?.abort(), []);

  async function save(value = draft): Promise<Plan> {
    if (selectedId && jobs.snapshot().some(job => job.id === selectedId && job.kind !== "match" && jobRunning(job))) throw new Error("Finish or cancel analysis before editing this plan.");
    if (selectedId) jobs.dismiss({ kind: "plan", id: selectedId });
    retryAction.current = () => { void save().catch((cause) => setError(errorText(cause))); };
    setSaving(true); setError("");
    try {
      try {
        if (new URL(value.listingUrl).protocol !== "https:") throw new Error();
      } catch { throw new Error("Enter a public HTTPS job listing link before saving this plan."); }
      let nextValue = value;
      if (resumeFile) {
        const form = new FormData();
        form.append("file", resumeFile);
        const { resume } = await readJson<{ resume: Resume }>(await fetch("/api/resumes", {
          method: "POST", body: form,
        }));
        setResumes((current) => [resume, ...current]);
        nextValue = { ...value, resumeId: resume.id };
        setDraft(nextValue);
        setResumeFile(null);
      }
      const response = await fetch(selectedId ? `/api/plans/${selectedId}` : "/api/plans", {
        method: selectedId ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextValue),
      });
      const { plan } = await readJson<{ plan: Plan }>(response);
      setPlans((current) => [plan, ...current.filter((item) => item.id !== plan.id)]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      setSelectedId(plan.id); setDraft(inputFromPlan(plan)); setSavedDraft(inputFromPlan(plan));
      setLastCurrentOverview(plan.currentOverview);
      savedFeedback();
      return plan;
    } finally { setSaving(false); }
  }

  async function saveClick(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    try { await save(); }
    catch (cause) { setError(errorText(cause)); }
  }

  async function moveToApplied() {
    if (busy) return;
    retryAction.current = () => void moveToApplied();
    setMoving(true); setError(""); setNotice("");
    try {
      const saved = dirty || !selectedId ? await save() : selectedPlan;
      if (!saved) throw new Error("Save this plan before moving it to Applied.");
      retryAction.current = () => void moveToApplied();
      setNotice("");
      const { application, created } = await readJson<{ application: Application; created: boolean }>(
        await fetch(`/api/plans/${saved.id}/apply`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedUpdatedAt: saved.updatedAt }) }));
      onDirtyChange(false);
      onApplied(application, created);
    } catch (cause) { setError(errorText(cause)); }
    finally { setMoving(false); }
  }

  async function analyze(tailor = false) {
    if (busy || !canAnalyze) return;
    setError(""); setNotice("");
    retryAction.current = () => void analyze(tailor);
    setPreparing(true);
    try {
      const saved = dirty || !selectedId ? await save() : selectedPlan;
      if (!saved) throw new Error("Save this plan before analyzing it.");
      setNotice("");
      const modelLabel = analysisProvider === "ollama" ? ollamaModel || "Ollama" : analysisProvider === "builtin"
        ? builtInModel?.name || "Local model" : onlineModel(analysisProvider === "credits" ? analysisFlow.state.credits.model
          : analysisProvider === "anthropic" ? analysisFlow.state.anthropicModel : analysisFlow.state.openaiModel).name;
      retryAction.current = () => void analyze(tailor);
      const source = { kind: tailor ? "resume" as const : "plan" as const, id: saved.id };
      void jobs.start(source, { modelLabel, prepare: (signal) => analysisFlow.prepare(source, signal) });
    } catch (cause) { setError(errorText(cause)); }
    finally { setPreparing(false); }
  }

  async function cancelAnalysis() {
    if (!selectedId) return;
    retryAction.current = () => void cancelAnalysis();
    try { await jobs.cancel({ kind: tailoring ? "resume" : "plan", id: selectedId }); }
    catch (cause) { setError(errorText(cause)); }
  }

  async function remove() {
    if (!selectedId || analyzing || !window.confirm("Delete this saved plan?")) return;
    retryAction.current = () => void remove();
    setError("");
    try {
      const response = await fetch(`/api/plans/${selectedId}`, { method: "DELETE" });
      if (!response.ok) await readJson(response);
      jobs.dismiss({ kind: "plan", id: selectedId });
      const remaining = plans.filter((item) => item.id !== selectedId);
      setPlans(remaining);
      const next = remaining[0] || null;
      setSelectedId(next?.id || null);
      setDraft(next ? inputFromPlan(next) : emptyPlan(lastCurrentOverview));
      setSavedDraft(next ? inputFromPlan(next) : emptyPlan(lastCurrentOverview));
      setResumeFile(null);
      setNotice("Plan deleted.");
    } catch (cause) { setError(errorText(cause)); }
  }

  return <main className="desktop-main plan-page" aria-label="Plan">
    <div className="workspace-toolbar">
      <button className="button button-secondary plan-rail-toggle" type="button" data-command="search-toggle"
        aria-expanded={planListExpanded} aria-controls="saved-plan-list" disabled={navigatingBusy}
        onClick={() => setPlanListExpanded((value) => !value)}><FileText size={16} aria-hidden="true" /> Saved plans ({plans.length})</button>
      <button className="button button-primary" type="button" data-command="new" onClick={() => choose(null)} disabled={navigatingBusy}>
        <Plus size={18} aria-hidden="true" /> New plan
      </button>
    </div>
    <div className={`plan-layout${planListExpanded ? " plans-open" : ""}`}>
      <aside className="plan-list" id="saved-plan-list" aria-label="Saved plans">
        <div className="plan-list-head"><h2>Saved plans</h2><span>{plans.length}</span></div>
        <label className="search-field plan-search"><Search size={16} aria-hidden="true" />
          <span className="visually-hidden">Search plans</span>
          <input data-command="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search plans" />
        </label>
        {loading && <p className="rail-note">Loading plans...</p>}
        {!loading && plans.length === 0 && <div className="plan-rail-empty"><FileText size={21} aria-hidden="true" />
          <p>Your saved plans will appear here.</p></div>}
        {!loading && plans.length > 0 && visiblePlans.length === 0 && <p className="rail-note">No plans match this search.</p>}
        <div className="plan-items">{visiblePlans.map((plan) => <button key={plan.id} type="button"
          className={`plan-item ${selectedId === plan.id ? "selected" : ""}`}
          onClick={() => choose(plan)} disabled={navigatingBusy} aria-current={selectedId === plan.id ? "page" : undefined}>
          <strong>{plan.title || "Untitled role"}{jobs.snapshot().some(job => job.kind !== "match" && job.id === plan.id && jobRunning(job)) &&
            <LoaderCircle size={13} className="spin plan-item-progress" aria-label="Analysis in progress" />}</strong>
          <span className="plan-item-meta"><span>{plan.company || new URL(plan.listingUrl).hostname}</span><small>Edited {formatUpdated(plan.updatedAt)}</small></span>
        </button>)}</div>
      </aside>

      <form className="plan-editor" onSubmit={saveClick}>
        <div className="plan-editor-head"><div><h2>{draft.title || "New plan"}</h2>
          {(draft.company || draft.team) && <p>{[draft.company, draft.team].filter(Boolean).join(" · ")}</p>}</div>
          <span className={`save-state ${dirty ? "unsaved" : ""}`}>{dirty ? "Unsaved changes" : ""}</span>
        </div>
        <div className="plan-document-scroll">
        <AnalysisErrorBanner message={error} retry={() => retryAction.current()} busy={busy} />
        {notice && <p className="notice" role="status">{notice}</p>}
        <div className="plan-document">
        <div className="plan-inputs">
        <fieldset className="plan-section" disabled={analyzing || saving || moving}>
          <div className="plan-section-heading"><h3>Job posting</h3>{draft.listingUrl && <a href={draft.listingUrl} target="_blank" rel="noopener noreferrer">Open listing <ArrowUpRight size={14} aria-hidden="true" /></a>}</div>
          <label className="field"><span id="plan-listing-label">Job listing link</span><div className="listing-input-row">
            <input type="url" value={draft.listingUrl} onChange={(event) => update("listingUrl", event.target.value)}
              aria-labelledby="plan-listing-label" placeholder="https://..." required maxLength={2000} />
            <button className="button button-secondary" type="button" onClick={() => void readListing(draft.listingUrl)}
              disabled={!draft.listingUrl || busy}>{reading ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />} Fill from link</button>
          </div></label>
          {listingMessage === "Details added" && <span className="listing-feedback" role="status">Details added</span>}
          <div className="plan-meta-grid">
            <label className="field"><span>Company</span><input value={draft.company} onChange={(event) => update("company", event.target.value)} placeholder="Company name" /></label>
            <label className="field"><span>Job title</span><input value={draft.title} onChange={(event) => update("title", event.target.value)} placeholder="Product Manager" /></label>
            <label className="field"><span>Team</span><input value={draft.team} onChange={(event) => update("team", event.target.value)} placeholder="If listed" /></label>
            <LocationEditor value={draft.locations} onChange={(value) => update("locations", value)} />
          </div>
          <label className="field"><span>Job description</span><textarea ref={descriptionInput} className="description-area" value={draft.description}
            onChange={(event) => update("description", event.target.value)}
            onPaste={(event) => pasteJobDescription(event, (value) => update("description", value))}
            placeholder="Paste job description" maxLength={80000} /></label>
          {listingMessage && listingMessage !== "Details added" && !draft.description.trim() && <p className="listing-feedback" role="status">
            {listingMessage} <button className="text-action" type="button" onClick={() => descriptionInput.current?.focus()}>Paste description</button></p>}
        </fieldset>
        <div className="plan-section cv-section">
          <fieldset className="plan-fields" disabled={analyzing || saving || moving}>
          <div className="plan-section-heading"><h3>Your resume</h3></div>
          <label className="field"><span id="current-cv-overview-label">Current summary</span>
            <textarea className="current-overview-area" value={draft.currentOverview}
              aria-labelledby="current-cv-overview-label"
              onChange={(event) => update("currentOverview", event.target.value)}
              placeholder="Paste your resume summary" maxLength={20000} />
          </label>
          <ResumePicker resumes={resumes} value={draft.resumeId} file={resumeFile} disabled={busy}
            onSelect={(value) => update("resumeId", value)} onFile={setResumeFile} />
          </fieldset>
          <div className="plan-analyze-actions">
            <button className="button button-primary analysis-button" type="button" onClick={() => void analyze()}
              disabled={busy || !canAnalyze} aria-label={analyzing && !tailoring ? "Analysis in progress" : "Analyze"}>
              {analyzing && !tailoring ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <Sparkles size={17} aria-hidden="true" />}
              Analyze
            </button>
            {analyzing && !tailoring && <button className="button button-secondary" type="button" onClick={() => void cancelAnalysis()}
              disabled={cancelling || analysisProgress?.stage === "saving"}>Cancel</button>}
            <small>{analyzing && analysisProgress?.modelLabel ? analysisProgress.modelLabel : analysisProvider === "ollama" ? (ollamaModel || "Ollama") : analysisProvider === "builtin"
              ? (builtInModel?.name || "Local model") : onlineModel(analysisProvider === "credits" ? analysisFlow.state.credits.model
                : analysisProvider === "anthropic" ? analysisFlow.state.anthropicModel : analysisFlow.state.openaiModel).name}</small>
          </div>
          <div className="plan-progress-slot">
            {analyzing && !tailoring && analysisProgress && <PlanAnalysisProgress key={analysisProgress.requestId}
              stage={analysisProgress.stage} startedAt={analysisProgress.startedAt} />}
            {!analyzing && !canAnalyze && <p className="analysis-requirements">Add a job link, job description (100+ characters), and a resume to analyze.</p>}
          </div>
          {analysisProvider === "builtin" && builtInReady && builtInModel?.basic && <p className="analysis-hint">
            Compact mode uses basic keyword coverage and limited overview suggestions.</p>}
        </div>
        </div>
        <fieldset className="plan-section analysis-section" disabled={analyzing || saving || moving}>
          <div className="plan-section-heading"><h3>Resume direction</h3></div>
          <div className="match-result" aria-busy={analyzing}><span>Resume match</span>
            <div className="match-result-value">
              {matchStrength === null ? <span className="unscored-badge">Not analyzed</span> : <strong>{matchStrength}%</strong>}
              {matchStrength !== null && <span className="score-track" aria-hidden="true"><span style={{ width: `${matchStrength}%` }} /></span>}
              {hasAnalysis && <button className="match-refresh" type="button" aria-label="Refresh analysis" title="Refresh analysis"
                onClick={() => void analyze()} disabled={busy || !canAnalyze}><RefreshCw size={16} aria-hidden="true" /></button>}
            </div>
            {!analyzing && matchStrength !== null && <details className="match-why">
              <summary>Why this score</summary>
              {matchNotes ? <p>{matchNotes}</p> : <p>Analyze again to add an explanation. <button className="text-action" type="button" disabled={busy || !canAnalyze} onClick={() => void analyze()}>Add explanation</button></p>}
            </details>}
          </div>
          <div className="analysis-grid">
            <PlanRecommendations kind="keywords" values={draft.keywords} importance={keywordImportance} busy={busy}
              onChange={(value) => update("keywords", value)} />
            <PlanRecommendations kind="themes" values={draft.themes} importance={themeImportance} busy={busy}
              onChange={(value) => update("themes", value)} />
          </div>
          <label className="field"><span>Suggested edits - Resume summary</span>
            <textarea className="overview-area" value={draft.overview}
              onChange={(event) => update("overview", event.target.value)}
              placeholder="Your tailored summary will appear here." /></label>
          {overviewRationale && <div className="overview-rationale">
            <strong>{overviewUnchanged ? "No wording changes" : "What changed"}</strong>
            <p>{overviewRationale}</p>
          </div>}
        </fieldset>
        {hasAnalysis && <div className="tailored-resume-section" ref={tailoringSection}>
          <div className="tailored-resume-actions"><button type="button" className="button button-secondary" disabled={busy || !canAnalyze}
            onClick={() => void analyze(true)}>{tailoring ? <LoaderCircle size={17} className="spin" aria-hidden="true" /> : <Sparkles size={17} aria-hidden="true" />}Create tailored resume</button>
            {tailoring && <button type="button" className="text-action" disabled={cancelling || resumeProgress?.stage === "saving"} onClick={() => void cancelAnalysis()}>Cancel</button>}
          </div>
          {tailoring && resumeProgress && <PlanAnalysisProgress key={resumeProgress.requestId} task="resume" stage={resumeProgress.stage} startedAt={resumeProgress.startedAt} />}
          {selectedPlan?.tailoredResume && <div className="tailored-resume-files">{(["docx", "pdf"] as const).map(format => {
            const file = selectedPlan.tailoredResume![format];
            return <button key={file.id} type="button" className="tailored-resume-file" title="Show in folder" onClick={() => {
              const reveal = () => { void window.desktop!.revealTailoredResume(selectedPlan.id, format).catch(cause => setError(errorText(cause))); };
              retryAction.current = reveal; reveal();
            }}><FileText size={18} aria-hidden="true" /><span>{file.filename}</span><span className="file-format">{format === "docx" ? "Word" : "PDF"}</span><FolderOpen size={15} aria-hidden="true" /></button>;
          })}</div>}
        </div>}
        </div>
        </div>
        <div className="plan-actions">
          {selectedId && <button className="button-delete" type="button" onClick={() => void remove()} disabled={busy}>
            <Trash2 size={16} aria-hidden="true" /> Delete plan</button>}
          <div className="plan-save-actions">
            <button className="button button-secondary" type="submit" data-command="save" disabled={busy || !draft.listingUrl}>
              {saving ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />} Save plan
            </button>
            <button className="button button-primary" type="button" disabled={busy || !draft.listingUrl}
              onClick={() => void moveToApplied()}>
              Move to Applied {moving ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <ArrowRight size={17} aria-hidden="true" />}
            </button>
          </div>
        </div>
      </form>
    </div>
  </main>;
}

function SettingsView({ state, onState, onUpdate, onCheckUpdates, updateWorking }: { state: DesktopState; onState: (value: DesktopState) => void;
  onUpdate: () => void; onCheckUpdates: () => Promise<void>; updateWorking: boolean }) {
  const { openCredits } = useAnalysisFlow();
  const savedFeedback = useSavedFeedback();
  const retryAction = useRef<() => void>(() => undefined);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function choose(kind: "open" | "create") {
    retryAction.current = () => void choose(kind);
    setWorking(true); setError(""); setNotice("");
    try { const result = await window.desktop!.chooseDatabase(kind);
      if (result) { onState(result); setNotice(kind === "create" ? "New database created." : "Database opened."); }
    } catch (cause) { setError(errorText(cause)); }
    finally { setWorking(false); }
  }

  async function retry() {
    retryAction.current = () => void retry();
    setWorking(true); setError("");
    try { onState(await window.desktop!.retrySync()); setNotice(""); savedFeedback(); }
    catch (cause) { setError(errorText(cause)); }
    finally { setWorking(false); }
  }

  async function changeAppearance(value: DesktopState["appearance"]) {
    retryAction.current = () => void changeAppearance(value);
    setWorking(true); setError(""); setNotice("");
    onState({ ...state, appearance: value });
    try { onState(await window.desktop!.setAppearance(value)); }
    catch (cause) { onState(state); setError(errorText(cause)); }
    finally { setWorking(false); }
  }

  async function openLogs() {
    retryAction.current = () => void openLogs();
    setWorking(true); setError(""); setNotice("");
    try { await window.desktop!.openLogs(); }
    catch (cause) { setError(errorText(cause)); }
    finally { setWorking(false); }
  }

  async function checkUpdates() {
    retryAction.current = () => void checkUpdates();
    setError("");
    try { await onCheckUpdates(); }
    catch (cause) { setError(errorText(cause)); }
  }

  return <main className="desktop-main settings-page" aria-label="Settings">
    <ErrorBanner message={error} retry={() => retryAction.current()} busy={working} />
    {notice && <p className="notice" role="status">{notice}</p>}
    <section className="settings-section" aria-labelledby="database-settings">
      <div className="settings-section-heading"><h2 id="database-settings">Database</h2></div>
      <div className="settings-content">
        <div className="database-location"><span>Current file</span><strong>{state.filename || "No database selected"}</strong>
          {state.filePath && <code title={state.filePath}>{state.filePath}</code>}</div>
        {state.dirty && <p className="sync-warning">Changes have not reached {state.filename || "your database file"}. Retry the save before switching computers.</p>}
        <div className="settings-actions"><SettingsAction icon={FolderOpen} onClick={() => void choose("open")} disabled={working}>Open database</SettingsAction>
          <SettingsAction icon={Plus} data-command="new" onClick={() => void choose("create")} disabled={working}>Create new database</SettingsAction>
          {state.dirty && <SettingsAction variant="primary" icon={RotateCw} onClick={() => void retry()} disabled={working}>Retry save</SettingsAction>}
        </div>
        <p className="settings-help">Quit Zebby and wait for file sync before switching computers.</p>
      </div>
    </section>
    <section className="settings-section" aria-labelledby="ai-settings">
      <div className="settings-section-heading"><h2 id="ai-settings">Analysis</h2><AnalysisGuide /></div>
      <div className="settings-content"><AnalysisSettings state={state} onState={onState} openCredits={openCredits} /></div>
    </section>
    <CreditsSettings />
    <BoardsDatabaseSettings />
    <section className="settings-section" aria-labelledby="appearance-settings">
      <div className="settings-section-heading"><h2 id="appearance-settings">Appearance</h2></div>
      <div className="settings-content"><div className="appearance-options" role="radiogroup" aria-label="Appearance">
        {([ ["auto", "System", Monitor], ["light", "Light", Sun], ["dark", "Dark", Moon] ] as const).map(([value, label, Icon]) =>
          <label key={value} className={`appearance-option ${state.appearance === value ? "selected" : ""}`}>
            <input type="radio" name="appearance" value={value} checked={state.appearance === value}
              onChange={() => void changeAppearance(value)} disabled={working} />
            <Icon size={17} aria-hidden="true" /><span>{label}</span>
          </label>)}</div>
      </div>
    </section>
    <section className="settings-section" aria-labelledby="logs-settings">
      <div className="settings-section-heading"><h2 id="logs-settings">Logs</h2></div>
      <div className="settings-content">
        <div className="settings-links">
          <button className="settings-link" type="button" onClick={() => void openLogs()} disabled={working}>
            Open logs folder <ArrowUpRight size={15} aria-hidden="true" /></button>
          <a className="settings-link" href="https://github.com/desigrit/zebby-the-scout-beta/issues/new" target="_blank" rel="noopener noreferrer">
            Report an issue <ArrowUpRight size={15} aria-hidden="true" /></a>
        </div>
      </div>
    </section>
    <section className="settings-section" aria-labelledby="updates-settings">
      <div className="settings-section-heading"><h2 id="updates-settings">Updates</h2><p>{state.appName || document.title} {state.updates.currentVersion}</p></div>
      <div className="settings-content">
        {state.distributionChannel === "store" ? <>
          <div className="settings-actions"><SettingsAction icon={ArrowUpRight} onClick={() => void checkUpdates()}>Open Microsoft Store</SettingsAction></div>
          <p className="settings-help">Updates are managed by Microsoft Store.</p>
        </> : <>
        <div className="settings-actions">
          {!state.updates.available && !state.updates.error && <SettingsAction icon={RefreshCw} busy={state.updates.checking}
            onClick={() => void checkUpdates()} disabled={state.updates.checking}>Check for updates</SettingsAction>}
          {!state.updates.download.error && <UpdateButton updates={state.updates} working={updateWorking} onClick={onUpdate} settings />}
        </div>
        {!state.updates.available && !state.updates.error && state.updates.checkedAt && !state.updates.checking && <p className="settings-help" role="status">Up to date</p>}
        {state.updates.available && <a className="settings-link" href={state.updates.available.releaseUrl} target="_blank" rel="noopener noreferrer">
          Release notes <ArrowUpRight size={15} aria-hidden="true" /></a>}
        <ErrorBanner message={state.updates.download.error || (state.updates.error ? "Could not check for updates." : "")}
          retry={state.updates.download.error ? onUpdate : () => void checkUpdates()} busy={updateWorking || state.updates.checking} />
        </>}
      </div>
    </section>
  </main>;
}

function Welcome({ state, onState }: { state: DesktopState; onState: (value: DesktopState) => void }) {
  const [error, setError] = useState(state.startupError);
  const retryAction = useRef<(() => void) | null>(null);
  const [working, setWorking] = useState(false);
  async function choose(kind: "open" | "create") {
    retryAction.current = () => void choose(kind);
    setWorking(true); setError("");
    try { const result = await window.desktop!.chooseDatabase(kind); if (result) onState(result); }
    catch (cause) { setError(errorText(cause)); }
    finally { setWorking(false); }
  }
  return <main className="welcome-page" aria-label="Welcome"><img className="welcome-graphic" src="./icon.png" alt="" />
    <div className="welcome-copy"><h1>Your search, in one place.</h1>
      <p>Plan for the roles you want, then track every application and resume you send.</p></div>
    <ErrorBanner message={error} retry={() => retryAction.current ? retryAction.current() : void choose("open")} busy={working} />
    <div className="welcome-actions"><button className="button button-primary" onClick={() => void choose("create")} disabled={working}>
      <Plus size={18} aria-hidden="true" /> Create database</button>
      <button className="button button-secondary" onClick={() => void choose("open")} disabled={working}>
      <FolderOpen size={18} aria-hidden="true" /> Open existing database</button></div>
    <p className="welcome-foot">Choose a folder that syncs across your computers if you want to share one database between them.</p>
  </main>;
}

export default function App() {
  useInteractiveScrollbars();
  const [state, setState] = useState<DesktopState | null>(null);
  const appearance = state?.appearance;
  const [tab, setTab, settleTab] = useTabTransition<Tab>("plan");
  useWorkspaceShortcuts(settleTab);
  const scrollToAnalysis = useRef(false);
  const [dirtyPlan, setDirtyPlan] = useState(false);
  const [dirtyBoard, setDirtyBoard] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [applicationSelection, setApplicationSelection] = useState<{ id: string; notice: string } | null>(null);
  const [databaseVersion, setDatabaseVersion] = useState(0);
  const [sidebarSaving, setSidebarSaving] = useState(false);
  const [shellError, setShellError] = useState("");
  const shellRetry = useRef<() => void>(() => undefined);
  const [updateWorking, setUpdateWorking] = useState(false);
  const loaded = state !== null;
  useEffect(() => {
    if (loaded) void window.desktop!.confirmUpdateLoaded().catch(() => { /* Main process records cleanup errors. */ });
  }, [loaded]);
  const navigate = useCallback((target: Tab) => {
    if (target !== "plan" && dirtyPlan && !window.confirm("Discard unsaved changes to this plan?")) return false;
    if (target !== "boards" && dirtyBoard && !window.confirm("Discard unsaved changes to this board?")) return false;
    scrollToAnalysis.current = false;
    setApplicationSelection(null); setTab(target);
    return true;
  }, [dirtyPlan, dirtyBoard, setTab]);
  useLayoutEffect(() => {
    if (tab === "settings" && scrollToAnalysis.current) {
      scrollToAnalysis.current = false;
      document.getElementById("ai-settings")?.scrollIntoView({ block: "start" });
    }
  }, [tab]);
  function openAnalysisSettings() {
    if (!navigate("settings")) return;
    if (tab === "settings") document.getElementById("ai-settings")?.scrollIntoView({ block: "start" });
    else scrollToAnalysis.current = true;
  }

  async function toggleSidebar() {
    if (!state || sidebarSaving) return;
    shellRetry.current = () => void toggleSidebar();
    const collapsed = !state.sidebarCollapsed;
    setShellError(""); setSidebarSaving(true);
    setState((current) => current ? { ...current, sidebarCollapsed: collapsed } : current);
    try { await window.desktop!.setSidebarCollapsed(collapsed); }
    catch {
      setState((current) => current ? { ...current, sidebarCollapsed: !collapsed } : current);
      setShellError("Could not save the navigation preference. Try again.");
    } finally { setSidebarSaving(false); }
  }

  async function applyUpdate() {
    if (!state || updateWorking) return;
    shellRetry.current = () => void applyUpdate();
    const restart = state.updates.download.phase === "ready";
    if (restart && document.querySelector('[role="dialog"], .desktop-dashboard .editor')) {
      setShellError("Finish editing the open form or dialog before updating."); return;
    }
    if (restart && dirtyBoard && !window.confirm("Restart to update and discard unsaved changes to this board?")) return;
    if (restart && dirtyPlan && !window.confirm("Restart to update and discard unsaved changes to this plan?")) return;
    setUpdateWorking(true); setShellError("");
    try {
      if (restart) await window.desktop!.installUpdate();
      else { const updates = await window.desktop!.downloadUpdate(); setState((current) => current ? { ...current, updates } : current); }
    } catch (cause) { setShellError(errorText(cause)); }
    finally { setUpdateWorking(false); }
  }

  async function checkUpdates() {
    if (state?.distributionChannel === "store") { await window.desktop!.openStoreUpdates(); return; }
    const updates = await window.desktop!.checkForUpdates();
    setState((current) => current ? { ...current, updates } : current);
  }

  useEffect(() => {
    void window.desktop!.state().then(setState);
    const removeChanged = window.desktop!.onDatabaseChanged((next) => {
      scrollToAnalysis.current = false;
      setState(next); setDatabaseVersion((current) => current + 1); setSelectedPlanId(null); setApplicationSelection(null); setTab("plan");
    });
    const removeNavigate = window.desktop!.onNavigate((target) => {
      if (target === "plan" || target === "applications" || target === "boards" || target === "settings") navigate(target);
    });
    const removeModelsChanged = window.desktop!.onLocalModelsChanged((next) => {
      setState((current) => current ? { ...current, builtInModelId: next.builtInModelId,
        localModels: next.localModels, acceptedModelTerms: next.acceptedModelTerms,
        modelsFolder: next.modelsFolder, localEngine: next.localEngine, localCompute: next.localCompute,
        totalMemory: next.totalMemory, availableMemory: next.availableMemory } : next);
    });
    const removeCreditsChanged = window.desktop!.onCreditsChanged((next) => {
      setState((current) => current ? { ...current, credits: next.credits } : next);
    });
    const removeUpdatesChanged = window.desktop!.onUpdatesChanged((updates) => {
      setState((current) => current ? { ...current, updates } : current);
    });
    return () => { removeChanged(); removeNavigate(); removeModelsChanged(); removeUpdatesChanged(); removeCreditsChanged(); };
  }, [navigate, setTab]);

  useEffect(() => {
    if (!appearance) return;
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => { document.documentElement.dataset.theme = appearance === "auto"
      ? (system.matches ? "dark" : "light") : appearance; };
    update();
    system.addEventListener("change", update);
    return () => system.removeEventListener("change", update);
  }, [appearance]);

  if (!state) return <div className="desktop-loading"><LoaderCircle className="spin" size={24} /> Opening workspace...</div>;
  return <SavedFeedbackProvider><AnalysisFlowProvider state={state} onState={setState} onOpenSettings={openAnalysisSettings}><BackgroundAnalysisProvider key={databaseVersion}><div className={`desktop-shell ${state.platform === "darwin" ? "platform-mac" : "platform-windows"}${state.sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
    <header className="desktop-titlebar" aria-label="Window title bar">
      <div className="titlebar-sidebar" aria-hidden="true" />
      <div className="titlebar-caption">{state.appName || document.title}</div>
    </header>
    <aside className="desktop-sidebar" inert={updateWorking && state.updates.download.phase === "ready" || state.updates.download.phase === "installing"}>
      <div className="sidebar-brand"><button className="sidebar-toggle" type="button" onClick={() => void toggleSidebar()}
        disabled={sidebarSaving} aria-expanded={!state.sidebarCollapsed} aria-controls="desktop-navigation"
        aria-label={state.sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
        title={state.sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}>
        <img className="brand-mark" src="./icon.png" alt="" /></button></div>
      <nav id="desktop-navigation" className="sidebar-nav" aria-label="Workspace">
        <NavigationButton kind="plan" label="Plan" selected={tab === "plan"} collapsed={state.sidebarCollapsed} onActivate={() => navigate("plan")} />
        <NavigationButton kind="applications" label="Applications" selected={tab === "applications"} collapsed={state.sidebarCollapsed} onActivate={() => navigate("applications")} />
        <NavigationButton kind="boards" label="Boards" selected={tab === "boards"} collapsed={state.sidebarCollapsed} onActivate={() => navigate("boards")} />
        <NavigationButton kind="settings" label="Settings" selected={tab === "settings"} collapsed={state.sidebarCollapsed} onActivate={() => navigate("settings")} />
      </nav>
      {(state.updates.available || state.credits.wallet?.purchased || state.filePath && !state.sidebarCollapsed) && <div className="sidebar-footer">
        <SidebarCredits />
        {state.distributionChannel !== "store" && <UpdateButton updates={state.updates} collapsed={state.sidebarCollapsed} working={updateWorking} onClick={() => void applyUpdate()} />}
        {state.filePath && !state.sidebarCollapsed && <div className="sidebar-database" title={state.filePath}>
        <span>Current database</span><strong>{state.filename}</strong>
        {state.dirty && <small>Save pending</small>}
        </div>}
      </div>}
    </aside>
    <div className="desktop-workspace" inert={updateWorking && state.updates.download.phase === "ready" || state.updates.download.phase === "installing"}>
      <ErrorBanner message={shellError} className="workspace-warning" retry={() => shellRetry.current()} busy={updateWorking || sidebarSaving} />
      {state.dirty && tab !== "settings" && <div className="workspace-warning" role="alert"><span>Changes have not reached {state.filename || "your database file"}.</span>
        <button type="button" onClick={() => navigate("settings")}>Retry save in Settings</button></div>}
      {state.startupError && tab === "settings" && <div className="workspace-warning" role="alert">
        <span>The previous database could not be opened. Choose a database to continue.</span>
      </div>}
      {tab === "boards" ? <BoardsView desktop={state} openSettings={openAnalysisSettings} onDirtyChange={setDirtyBoard} /> : !state.filePath ? (tab === "settings" ? <SettingsView state={state} onState={setState} onUpdate={() => void applyUpdate()} onCheckUpdates={checkUpdates} updateWorking={updateWorking} /> : <Welcome state={state} onState={setState} />)
      : tab === "plan" ? <PlanView key={databaseVersion}
        analysisProvider={state.analysisProvider} ollamaModel={state.ollamaModel}
        builtInModelId={state.builtInModelId} builtInReady={Boolean(state.localModels?.some((model) =>
          model.id === state.builtInModelId && model.status === "ready") &&
          (!LOCAL_MODELS.find((model) => model.id === state.builtInModelId)?.license ||
            state.acceptedModelTerms?.includes(state.builtInModelId)))}
        onDirtyChange={setDirtyPlan} initialSelectedId={selectedPlanId} onSelectionChange={setSelectedPlanId}
        onApplied={(application, created) => {
          setDirtyPlan(false);
          setApplicationSelection({ id: application.id, notice: created ? "Moved to Applied." : "This job is already in Applications." });
          setTab("applications");
        }} />
      : tab === "applications" ? <ApplicationDashboard key={databaseVersion} initialSelection={applicationSelection} />
      : <SettingsView state={state} onState={setState} onUpdate={() => void applyUpdate()} onCheckUpdates={checkUpdates} updateWorking={updateWorking} />}</div>
  </div></BackgroundAnalysisProvider></AnalysisFlowProvider></SavedFeedbackProvider>;
}
