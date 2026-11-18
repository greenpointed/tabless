import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { JOB_STATUSES, type Job, type Contact, type ActionItem, type JobStatus } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import {
  ArrowLeft, ExternalLink, MapPin, DollarSign, Calendar, User,
  Plus, Trash2, Edit3, Save, X, Building2, Wifi, Loader2,
  ChevronDown, ChevronUp, Search, Star, AlertCircle,
} from "lucide-react";
import { Link } from "wouter";
import { format, parseISO } from "date-fns";

// ─── Helpers ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  return <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium status-${CSS.escape(status)}`}>{status}</span>;
}

function RtoDisplay({ days, notes }: { days: number | null | undefined; notes?: string | null }) {
  if (days === null || days === undefined) return <span className="text-muted-foreground italic text-sm">Unknown — click Lookup to search</span>;
  const label = days === 0 ? "Fully Remote" : days === 5 ? "Fully On-site" : `${days} day${days > 1 ? "s" : ""}/week in-office`;
  return (
    <span className="text-sm text-foreground font-medium">
      {label}
      {notes && <span className="text-muted-foreground font-normal ml-2">({notes})</span>}
    </span>
  );
}

type ContactForm = { name: string; role?: string; email?: string; linkedin?: string; notes?: string };

// ─── Job Detail ────────────────────────────────────────────────────────

export default function JobDetail({ params }: { params: { id: string } }) {
  const id = parseInt(params.id);
  const { toast } = useToast();

  const [editingNotes, setEditingNotes] = useState(false);
  const [editingNextSteps, setEditingNextSteps] = useState(false);
  const [notesValue, setNotesValue] = useState("");
  const [nextStepsValue, setNextStepsValue] = useState("");
  const [showContactForm, setShowContactForm] = useState(false);
  const [editingStatus, setEditingStatus] = useState(false);
  const [newAction, setNewAction] = useState("");
  const [rtoLookupResult, setRtoLookupResult] = useState<{ snippets: string[]; titles: string[] } | null>(null);
  const [rtoLookupLoading, setRtoLookupLoading] = useState(false);
  const [showRtoResult, setShowRtoResult] = useState(false);

  // Ratings lookup state
  type RatingsResult = { glassdoor: { rating: string | null; blocked?: boolean; url?: string; snippets: string[] }; blind: { rating: string | null; blocked?: boolean; url?: string; snippets: string[] } };
  const [ratingsResult, setRatingsResult] = useState<RatingsResult | null>(null);
  const [ratingsLoading, setRatingsLoading] = useState(false);
  const [showRatingsResult, setShowRatingsResult] = useState(false);
  const [editingGlassdoor, setEditingGlassdoor] = useState(false);
  const [editingBlind, setEditingBlind] = useState(false);
  const [glassdoorValue, setGlassdoorValue] = useState("");
  const [blindValue, setBlindValue] = useState("");

  const { data: job, isLoading } = useQuery<Job>({
    queryKey: ["/api/jobs", id],
    queryFn: async () => { const r = await apiRequest("GET", `/api/jobs/${id}`); return r.json(); },
  });

  const { data: contacts = [] } = useQuery<Contact[]>({
    queryKey: ["/api/jobs", id, "contacts"],
    queryFn: async () => { const r = await apiRequest("GET", `/api/jobs/${id}/contacts`); return r.json(); },
  });

  const { data: actions = [] } = useQuery<ActionItem[]>({
    queryKey: ["/api/jobs", id, "actions"],
    queryFn: async () => { const r = await apiRequest("GET", `/api/jobs/${id}/actions`); return r.json(); },
  });

  const updateMutation = useMutation({
    mutationFn: (data: Partial<Job>) => apiRequest("PATCH", `/api/jobs/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/jobs", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/jobs"] });
      setEditingNotes(false);
      setEditingNextSteps(false);
      setEditingStatus(false);
      toast({ title: "Saved" });
    },
  });

  const addActionMutation = useMutation({
    mutationFn: (text: string) => apiRequest("POST", "/api/actions", { jobId: id, text, done: 0 }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/jobs", id, "actions"] }); setNewAction(""); },
  });

  const toggleActionMutation = useMutation({
    mutationFn: ({ actionId, done }: { actionId: number; done: boolean }) =>
      apiRequest("PATCH", `/api/actions/${actionId}`, { done }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/jobs", id, "actions"] }),
  });

  const deleteActionMutation = useMutation({
    mutationFn: (actionId: number) => apiRequest("DELETE", `/api/actions/${actionId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/jobs", id, "actions"] }),
  });

  const addContactMutation = useMutation({
    mutationFn: (data: ContactForm) => apiRequest("POST", "/api/contacts", { ...data, jobId: id }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/jobs", id, "contacts"] }); setShowContactForm(false); reset(); toast({ title: "Contact added" }); },
  });

  const deleteContactMutation = useMutation({
    mutationFn: (cId: number) => apiRequest("DELETE", `/api/contacts/${cId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/jobs", id, "contacts"] }),
  });

  const { register, handleSubmit, reset } = useForm<ContactForm>();

  const handleRatingsLookup = async () => {
    if (!job) return;
    setRatingsLoading(true);
    setShowRatingsResult(true);
    try {
      const r = await apiRequest("GET", `/api/lookup-ratings?company=${encodeURIComponent(job.company)}`);
      const data: RatingsResult = await r.json();
      setRatingsResult(data);
      // Auto-save if we got ratings and they're not already set
      const updates: Partial<Job> = {};
      if (data.glassdoor.rating && !job.glassdoorRating) updates.glassdoorRating = data.glassdoor.rating;
      if (data.blind.rating && !job.blindRating) updates.blindRating = data.blind.rating;
      if (Object.keys(updates).length > 0) updateMutation.mutate(updates);
    } catch {
      toast({ title: "Ratings lookup failed", variant: "destructive" });
    } finally {
      setRatingsLoading(false);
    }
  };

  const handleRtoLookup = async () => {
    if (!job) return;
    setRtoLookupLoading(true);
    setShowRtoResult(true);
    try {
      const r = await apiRequest("GET", `/api/rto-lookup?company=${encodeURIComponent(job.company)}&role=${encodeURIComponent(job.role)}`);
      const data = await r.json();
      setRtoLookupResult(data);
    } catch {
      toast({ title: "Lookup failed", variant: "destructive" });
    } finally {
      setRtoLookupLoading(false);
    }
  };

  const openActions = actions.filter(a => !a.done);
  const doneActions = actions.filter(a => a.done);

  if (isLoading) return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="space-y-3 w-60"><div className="skeleton h-8 rounded" /><div className="skeleton h-4 w-2/3 rounded" /></div>
    </div>
  );

  if (!job) return <div className="min-h-screen bg-background flex items-center justify-center text-muted-foreground">Job not found.</div>;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link href="/"><button className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors" data-testid="link-back"><ArrowLeft size={14} />All jobs</button></Link>
          <span className="text-muted-foreground/40">/</span>
          <span className="text-sm font-medium truncate">{job.company} — {job.role}</span>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8">

        {/* ── Hero ── */}
        <div className="mb-6">
          <div className="flex items-start justify-between gap-4 mb-3 flex-wrap">
            <div>
              <h1 className="text-xl font-bold mb-0.5">{job.company}</h1>
              <p className="text-base text-muted-foreground">{job.role}</p>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              {editingStatus ? (
                <div className="flex items-center gap-2">
                  <Select defaultValue={job.status} onValueChange={v => updateMutation.mutate({ status: v as JobStatus })}>
                    <SelectTrigger className="w-40 h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>{JOB_STATUSES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                  </Select>
                  <button onClick={() => setEditingStatus(false)}><X size={14} className="text-muted-foreground" /></button>
                </div>
              ) : (
                <button onClick={() => setEditingStatus(true)} className="group flex items-center gap-1" data-testid="btn-edit-status">
                  <StatusBadge status={job.status} />
                  <Edit3 size={11} className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              )}
              <span className={`text-xs font-medium ${job.priority === 1 ? "text-red-600 dark:text-red-400" : job.priority === 2 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>
                {["High", "Medium", "Low"][job.priority - 1]} Priority
              </span>
            </div>
          </div>

          {/* Meta chips */}
          <div className="flex flex-wrap gap-2">
            {job.location && <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-sm text-muted-foreground"><MapPin size={13} />{job.location}</div>}
            {job.appliedAt && <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-sm text-muted-foreground"><Calendar size={13} />Applied {format(parseISO(job.appliedAt), "MMM d, yyyy")}</div>}
            {job.source && <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-sm text-muted-foreground">via {job.source}</div>}
            {job.url && <a href={job.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-sm font-medium hover:bg-primary/20 transition-colors" data-testid="link-posting"><ExternalLink size={13} />View posting</a>}
          </div>
        </div>

        {/* ── 3-col grid ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

          {/* Left — notes + next steps */}
          <div className="lg:col-span-2 space-y-5">

            {/* Compensation */}
            <section className="bg-card border border-border rounded-lg p-5">
              <h2 className="font-semibold text-sm mb-3">Compensation</h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {[
                  { label: "Base", value: job.salaryBase },
                  { label: "RSUs / Equity", value: job.salaryRsu },
                  { label: "Bonus", value: job.salaryBonus },
                  { label: "Total Comp", value: job.salaryTotal },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
                    <p className="text-sm font-semibold text-foreground">{value || <span className="font-normal text-muted-foreground/60 italic">—</span>}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* Ratings */}
            <section className="bg-card border border-border rounded-lg p-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-semibold text-sm">Company Reviews</h2>
                <button
                  onClick={handleRatingsLookup}
                  disabled={ratingsLoading}
                  className="flex items-center gap-1.5 text-xs text-primary hover:opacity-80 transition-opacity disabled:opacity-50"
                  data-testid="btn-ratings-lookup"
                >
                  {ratingsLoading ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
                  Lookup ratings
                </button>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Glassdoor */}
                <div className="bg-secondary/50 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-1.5">
                      <div className="w-5 h-5 rounded bg-[#0caa41] flex items-center justify-center flex-shrink-0">
                        <span className="text-white font-bold" style={{ fontSize: "9px" }}>G</span>
                      </div>
                      <span className="text-xs font-semibold">Glassdoor</span>
                    </div>
                    <button
                      onClick={() => { setGlassdoorValue(job.glassdoorRating || ""); setEditingGlassdoor(true); }}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                      aria-label="Edit Glassdoor rating"
                    >
                      <Edit3 size={11} />
                    </button>
                  </div>

                  {editingGlassdoor ? (
                    <div className="flex items-center gap-1.5">
                      <Input
                        value={glassdoorValue}
                        onChange={e => setGlassdoorValue(e.target.value)}
                        placeholder="e.g. 3.8"
                        className="h-7 text-xs w-20"
                        autoFocus
                      />
                      <button
                        onClick={() => { updateMutation.mutate({ glassdoorRating: glassdoorValue || null }); setEditingGlassdoor(false); }}
                        className="text-primary text-xs font-medium"
                      ><Save size={12} /></button>
                      <button onClick={() => setEditingGlassdoor(false)} className="text-muted-foreground"><X size={12} /></button>
                    </div>
                  ) : job.glassdoorRating ? (
                    <div className="flex items-center gap-1">
                      <Star size={14} className="fill-amber-400 stroke-amber-500" />
                      <span className="text-lg font-bold text-foreground">{job.glassdoorRating}</span>
                      <span className="text-xs text-muted-foreground">/ 5</span>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground/60 italic">Not set — click Lookup</p>
                  )}
                </div>

                {/* Blind */}
                <div className="bg-secondary/50 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-1.5">
                      <div className="w-5 h-5 rounded bg-[#2563eb] flex items-center justify-center flex-shrink-0">
                        <span className="text-white font-bold" style={{ fontSize: "9px" }}>B</span>
                      </div>
                      <span className="text-xs font-semibold">Blind</span>
                    </div>
                    <button
                      onClick={() => { setBlindValue(job.blindRating || ""); setEditingBlind(true); }}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                      aria-label="Edit Blind rating"
                    >
                      <Edit3 size={11} />
                    </button>
                  </div>

                  {editingBlind ? (
                    <div className="flex items-center gap-1.5">
                      <Input
                        value={blindValue}
                        onChange={e => setBlindValue(e.target.value)}
                        placeholder="e.g. 3.2"
                        className="h-7 text-xs w-20"
                        autoFocus
                      />
                      <button
                        onClick={() => { updateMutation.mutate({ blindRating: blindValue || null }); setEditingBlind(false); }}
                        className="text-primary text-xs font-medium"
                      ><Save size={12} /></button>
                      <button onClick={() => setEditingBlind(false)} className="text-muted-foreground"><X size={12} /></button>
                    </div>
                  ) : job.blindRating ? (
                    <div className="flex items-center gap-1">
                      <Star size={14} className="fill-blue-400 stroke-blue-500" />
                      <span className="text-lg font-bold text-foreground">{job.blindRating}</span>
                      <span className="text-xs text-muted-foreground">/ 5</span>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground/60 italic">Not set — click Lookup</p>
                  )}
                </div>
              </div>

              {/* Lookup result notices */}
              {showRatingsResult && ratingsResult && (
                <div className="mt-4 border-t border-border pt-4 space-y-2">
                  {/* Glassdoor blocked notice */}
                  {ratingsResult.glassdoor.blocked && (
                    <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50">
                      <AlertCircle size={13} className="text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                      <div className="text-xs text-amber-800 dark:text-amber-300">
                        <span className="font-medium">Glassdoor blocks automated access.</span>{" "}
                        <a href={ratingsResult.glassdoor.url} target="_blank" rel="noopener noreferrer"
                          className="underline underline-offset-2 hover:opacity-80">
                          Open Glassdoor ↗
                        </a>{" "}to look up the rating, then enter it manually with the pencil icon above.
                      </div>
                    </div>
                  )}
                  {/* Blind result */}
                  {!ratingsResult.blind.blocked && (
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">
                        {ratingsResult.blind.rating
                          ? <>Blind rating found: <span className="font-semibold text-foreground">{ratingsResult.blind.rating} / 5</span> — saved automatically.</>  
                          : <>No Blind rating found for this company. <a href={ratingsResult.blind.url} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">Check Blind ↗</a></>  
                        }
                      </p>
                      {ratingsResult.blind.rating && (
                        <a href={ratingsResult.blind.url} target="_blank" rel="noopener noreferrer"
                          className="text-xs text-primary flex items-center gap-0.5 hover:opacity-80 flex-shrink-0 ml-2">
                          <ExternalLink size={10} />Blind
                        </a>
                      )}
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* RTO */}
            <section className="bg-card border border-border rounded-lg p-5">
              <div className="flex items-center justify-between mb-2">
                <h2 className="font-semibold text-sm">Office Policy (RTO)</h2>
                <button
                  onClick={handleRtoLookup}
                  disabled={rtoLookupLoading}
                  className="flex items-center gap-1.5 text-xs text-primary hover:opacity-80 transition-opacity disabled:opacity-50"
                  data-testid="btn-rto-lookup"
                >
                  {rtoLookupLoading ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
                  Lookup
                </button>
              </div>
              <RtoDisplay days={job.rtoDays} notes={job.rtoNotes} />

              {showRtoResult && (
                <div className="mt-3 border-t border-border pt-3">
                  <p className="text-xs font-semibold text-muted-foreground mb-2">Web search results for "{job.company} RTO policy":</p>
                  {rtoLookupLoading
                    ? <div className="skeleton h-16 rounded" />
                    : rtoLookupResult && (
                      <div className="space-y-2">
                        {rtoLookupResult.snippets.length === 0
                          ? <p className="text-xs text-muted-foreground italic">No results found</p>
                          : rtoLookupResult.snippets.map((s, i) => (
                            <div key={i} className="text-xs text-muted-foreground bg-secondary/60 rounded p-2 leading-relaxed">{s}</div>
                          ))
                        }
                        <div className="flex items-center gap-2 mt-2 flex-wrap">
                          <p className="text-xs font-medium text-muted-foreground">Set RTO:</p>
                          {[0, 1, 2, 3, 4, 5].map(d => (
                            <button
                              key={d}
                              onClick={() => updateMutation.mutate({ rtoDays: d })}
                              className="px-2 py-0.5 rounded text-xs border border-border hover:bg-secondary transition-colors"
                              data-testid={`btn-set-rto-${d}`}
                            >
                              {d === 0 ? "Remote" : d === 5 ? "On-site" : `${d}d/wk`}
                            </button>
                          ))}
                        </div>
                      </div>
                    )
                  }
                </div>
              )}
            </section>

            {/* Next Steps */}
            <section className="bg-card border border-border rounded-lg p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-sm">Next Steps</h2>
                {!editingNextSteps
                  ? <button onClick={() => { setNextStepsValue(job.nextSteps || ""); setEditingNextSteps(true); }} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1" data-testid="btn-edit-nextsteps"><Edit3 size={12} />Edit</button>
                  : <div className="flex gap-2">
                    <button onClick={() => updateMutation.mutate({ nextSteps: nextStepsValue })} className="text-xs text-primary font-medium flex items-center gap-1" data-testid="btn-save-nextsteps"><Save size={12} />Save</button>
                    <button onClick={() => setEditingNextSteps(false)} className="text-xs text-muted-foreground">Cancel</button>
                  </div>
                }
              </div>
              {editingNextSteps
                ? <Textarea value={nextStepsValue} onChange={e => setNextStepsValue(e.target.value)} rows={4} placeholder="What needs to happen next? Prep, follow-ups, research..." className="text-sm resize-none" data-testid="textarea-nextsteps" />
                : <div className="text-sm text-muted-foreground whitespace-pre-wrap min-h-[60px]">
                  {job.nextSteps || <span className="italic text-muted-foreground/50">No next steps yet. Click Edit to add.</span>}
                </div>
              }
            </section>

            {/* Action Items */}
            <section className="bg-card border border-border rounded-lg p-5">
              <h2 className="font-semibold text-sm mb-3">Action Items</h2>

              {/* New action input */}
              <div className="flex gap-2 mb-4">
                <Input
                  value={newAction}
                  onChange={e => setNewAction(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && newAction.trim()) { addActionMutation.mutate(newAction.trim()); } }}
                  placeholder="e.g. Email recruiter, Prep case study..."
                  className="text-sm h-8"
                  data-testid="input-action"
                />
                <Button
                  size="sm"
                  className="h-8 px-3 flex-shrink-0"
                  onClick={() => newAction.trim() && addActionMutation.mutate(newAction.trim())}
                  disabled={addActionMutation.isPending || !newAction.trim()}
                  data-testid="btn-add-action"
                >
                  <Plus size={13} />
                </Button>
              </div>

              {/* Open items */}
              {openActions.length === 0 && doneActions.length === 0 && (
                <p className="text-xs text-muted-foreground/60 italic">No action items. Add one above.</p>
              )}

              <div className="space-y-1.5">
                {openActions.map(a => (
                  <div key={a.id} className="flex items-center gap-2.5 group" data-testid={`action-${a.id}`}>
                    <Checkbox
                      checked={false}
                      onCheckedChange={v => toggleActionMutation.mutate({ actionId: a.id, done: Boolean(v) })}
                      id={`action-${a.id}`}
                      className="flex-shrink-0"
                    />
                    <label htmlFor={`action-${a.id}`} className="text-sm text-foreground flex-1 cursor-pointer">{a.text}</label>
                    <button onClick={() => deleteActionMutation.mutate(a.id)} className="p-0.5 text-muted-foreground/30 hover:text-destructive opacity-0 group-hover:opacity-100 transition-all" aria-label="Delete action" data-testid={`btn-del-action-${a.id}`}><Trash2 size={12} /></button>
                  </div>
                ))}
              </div>

              {/* Completed items */}
              {doneActions.length > 0 && (
                <div className="mt-3 pt-3 border-t border-border space-y-1.5">
                  <p className="text-xs text-muted-foreground/60 font-medium mb-1.5">Completed ({doneActions.length})</p>
                  {doneActions.map(a => (
                    <div key={a.id} className="flex items-center gap-2.5 group opacity-60" data-testid={`action-done-${a.id}`}>
                      <Checkbox
                        checked={true}
                        onCheckedChange={v => toggleActionMutation.mutate({ actionId: a.id, done: Boolean(v) })}
                        id={`action-done-${a.id}`}
                        className="flex-shrink-0"
                      />
                      <label htmlFor={`action-done-${a.id}`} className="text-sm line-through text-muted-foreground flex-1 cursor-pointer">{a.text}</label>
                      <button onClick={() => deleteActionMutation.mutate(a.id)} className="p-0.5 text-muted-foreground/30 hover:text-destructive opacity-0 group-hover:opacity-100 transition-all" aria-label="Delete" data-testid={`btn-del-done-${a.id}`}><Trash2 size={12} /></button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Notes */}
            <section className="bg-card border border-border rounded-lg p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-sm">Notes</h2>
                {!editingNotes
                  ? <button onClick={() => { setNotesValue(job.notes || ""); setEditingNotes(true); }} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1" data-testid="btn-edit-notes"><Edit3 size={12} />Edit</button>
                  : <div className="flex gap-2">
                    <button onClick={() => updateMutation.mutate({ notes: notesValue })} className="text-xs text-primary font-medium flex items-center gap-1" data-testid="btn-save-notes"><Save size={12} />Save</button>
                    <button onClick={() => setEditingNotes(false)} className="text-xs text-muted-foreground">Cancel</button>
                  </div>
                }
              </div>
              {editingNotes
                ? <Textarea value={notesValue} onChange={e => setNotesValue(e.target.value)} rows={6} placeholder="Key contacts, requirements, prep notes, impressions..." className="text-sm resize-none" data-testid="textarea-notes" />
                : <div className="text-sm text-muted-foreground whitespace-pre-wrap min-h-[60px]">
                  {job.notes || <span className="italic text-muted-foreground/50">No notes yet.</span>}
                </div>
              }
            </section>
          </div>

          {/* Right — contacts */}
          <div className="space-y-5">
            <section className="bg-card border border-border rounded-lg p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-sm">Contacts</h2>
                <button onClick={() => setShowContactForm(v => !v)} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors" data-testid="btn-add-contact">
                  <Plus size={12} />Add
                </button>
              </div>

              {showContactForm && (
                <form onSubmit={handleSubmit(data => addContactMutation.mutate(data))} className="mb-4 space-y-2 p-3 bg-secondary/50 rounded-lg">
                  <Input {...register("name", { required: true })} placeholder="Name *" className="h-8 text-xs" data-testid="input-contact-name" />
                  <Input {...register("role")} placeholder="Title" className="h-8 text-xs" />
                  <Input {...register("email")} type="email" placeholder="Email" className="h-8 text-xs" />
                  <Input {...register("linkedin")} placeholder="LinkedIn URL" className="h-8 text-xs" />
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" className="h-7 text-xs flex-1" disabled={addContactMutation.isPending}>Save</Button>
                    <button type="button" onClick={() => { setShowContactForm(false); reset(); }} className="text-xs text-muted-foreground px-2">Cancel</button>
                  </div>
                </form>
              )}

              {contacts.length === 0
                ? <p className="text-xs text-muted-foreground/50 italic">No contacts yet</p>
                : <div className="space-y-3">
                  {contacts.map(c => (
                    <div key={c.id} className="group flex items-start gap-2" data-testid={`contact-${c.id}`}>
                      <div className="w-7 h-7 rounded-full bg-secondary flex items-center justify-center flex-shrink-0 mt-0.5">
                        <User size={12} className="text-muted-foreground" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold">{c.name}</p>
                        {c.role && <p className="text-xs text-muted-foreground">{c.role}</p>}
                        {c.email && <a href={`mailto:${c.email}`} className="text-xs text-primary hover:underline">{c.email}</a>}
                        {c.linkedin && <a href={c.linkedin} target="_blank" rel="noopener noreferrer" className="block text-xs text-primary hover:underline truncate">LinkedIn</a>}
                      </div>
                      <button onClick={() => deleteContactMutation.mutate(c.id)} className="p-0.5 text-muted-foreground/30 hover:text-destructive opacity-0 group-hover:opacity-100 transition-all" data-testid={`btn-del-contact-${c.id}`}><Trash2 size={11} /></button>
                    </div>
                  ))}
                </div>
              }
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
