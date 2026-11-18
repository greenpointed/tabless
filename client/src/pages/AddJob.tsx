import { useState, useRef, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { JOB_STATUSES, type JobStatus } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useForm, Controller } from "react-hook-form";
import { useLocation } from "wouter";
import {
  ArrowLeft, Link2, Loader2, Sparkles, CheckCircle2,
  AlertCircle, ChevronRight, Building2, MapPin,
  DollarSign, ExternalLink, X, ListPlus,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

type ParsedJob = {
  postedAt?: string | null;
  role: string;
  company: string;
  location: string;
  salaryBase: string;
  salaryRsu: string;
  salaryBonus: string;
  salaryTotal: string;
  rtoDays: number | null;
  rtoNotes: string;
  source: string;
  notes: string;
};

type FormValues = {
  postedAt?: string | null;
  company: string;
  role: string;
  status: JobStatus;
  location: string;
  url: string;
  salaryBase: string;
  salaryRsu: string;
  salaryBonus: string;
  salaryTotal: string;
  rtoDays: number | null;
  rtoNotes: string;
  source: string;
  appliedAt: string;
  priority: number;
  notes: string;
  nextSteps: string;
};

// ─── Field confidence pill ─────────────────────────────────────────────────

function AutoFilled({ value }: { value: string | number | null | undefined }) {
  if (!value && value !== 0) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-700 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-950 px-1.5 py-0.5 rounded-full ml-1.5">
      <Sparkles size={9} />auto-filled
    </span>
  );
}

// ─── Step 1: URL input (single or multi) ─────────────────────────────────

function StepUrl({
  onParsedSingle,
  onParsedBulk,
  onSkip,
}: {
  onParsedSingle: (url: string, data: ParsedJob) => void;
  onParsedBulk: (urls: string[]) => void;
  onSkip: () => void;
}) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Parse URLs from the textarea — one per line, filter blanks/invalid
  const getUrls = () =>
    text
      .split("\n")
      .map(l => l.trim())
      .filter(l => {
        if (!l) return false;
        try { new URL(l); return true; } catch { return false; }
      });

  const invalidLines = text
    .split("\n")
    .map(l => l.trim())
    .filter(l => {
      if (!l) return false;
      try { new URL(l); return false; } catch { return true; }
    });

  const urls = getUrls();
  const isBulk = urls.length > 1;
  const hasInput = text.trim().length > 0;

  const handleParse = async () => {
    if (!hasInput) return;

    if (urls.length === 0) {
      setStatus("error");
      setErrorMsg("No valid URLs found. Make sure each URL starts with https://");
      return;
    }

    // Bulk mode — hand off to bulk step immediately
    if (isBulk) {
      onParsedBulk(urls);
      return;
    }

    // Single URL mode — parse inline then hand to form
    const trimmed = urls[0];
    setStatus("loading");
    setErrorMsg("");

    try {
      const res = await apiRequest("POST", "/api/parse-job", { url: trimmed });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Failed to parse");
      }
      const data: ParsedJob = await res.json();
      onParsedSingle(trimmed, data);
    } catch (err: any) {
      setStatus("error");
      setErrorMsg(err.message || "Couldn't read that page. You can fill in the details manually.");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Cmd/Ctrl+Enter submits; plain Enter adds a newline (multi-URL UX)
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleParse();
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-56px)] px-4 py-12">
      <div className="w-full max-w-lg">

        {/* Icon + heading */}
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <ListPlus size={26} className="text-primary" />
          </div>
          <h1 className="text-xl font-bold mb-1.5">Add jobs</h1>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto">
            Paste one or more job posting URLs — one per line — and we'll automatically extract the title, company, location, salary, and office policy.
          </p>
        </div>

        {/* URL textarea */}
        <div className="space-y-3">
          <div className="relative">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={e => { setText(e.target.value); setStatus("idle"); setErrorMsg(""); }}
              onKeyDown={handleKeyDown}
              placeholder={"https://jobs.company.com/roles/senior-pm\nhttps://boards.greenhouse.io/acme/jobs/123\nhttps://lever.co/startup/..."}
              rows={5}
              className="w-full px-4 py-3 text-sm rounded-xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground/50 transition-all resize-none font-mono leading-relaxed"
              data-testid="input-url"
            />
          </div>

          {/* URL count badge */}
          {urls.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary bg-primary/10 px-2.5 py-1 rounded-full">
                <CheckCircle2 size={11} />
                {urls.length} valid URL{urls.length !== 1 ? "s" : ""} detected
              </span>
              {invalidLines.length > 0 && (
                <span className="inline-flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-950/60 px-2.5 py-1 rounded-full">
                  <AlertCircle size={11} />
                  {invalidLines.length} line{invalidLines.length !== 1 ? "s" : ""} skipped
                </span>
              )}
            </div>
          )}

          {/* Error state */}
          {status === "error" && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/8 border border-destructive/20 text-sm text-destructive">
              <AlertCircle size={15} className="flex-shrink-0 mt-0.5" />
              <div>
                <p>{errorMsg}</p>
                <button
                  onClick={onSkip}
                  className="text-xs underline underline-offset-2 mt-1 text-muted-foreground hover:text-foreground"
                >
                  Fill in manually instead →
                </button>
              </div>
            </div>
          )}

          {/* Supported sites hint */}
          <p className="text-xs text-muted-foreground/60 text-center">
            Works with LinkedIn, Greenhouse, Lever, Workday, iCIMS, and most career pages · ⌘↵ to submit
          </p>

          {/* CTA */}
          <Button
            className="w-full h-11 text-sm font-medium"
            onClick={handleParse}
            disabled={status === "loading" || !hasInput || urls.length === 0}
            data-testid="btn-parse"
          >
            {status === "loading" ? (
              <><Loader2 size={15} className="mr-2 animate-spin" />Reading job posting…</>
            ) : isBulk ? (
              <><Sparkles size={15} className="mr-2" />Auto-fill {urls.length} jobs</>
            ) : (
              <><Sparkles size={15} className="mr-2" />Auto-fill from URL</>
            )}
          </Button>

          {/* Skip */}
          <button
            onClick={onSkip}
            className="w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors py-1"
            data-testid="btn-skip"
          >
            Skip — fill in manually
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Bulk review step ──────────────────────────────────────────────────────

type BulkItem = {
  url: string;
  status: "loading" | "success" | "error";
  data?: ParsedJob;
  errorMsg?: string;
  dismissed: boolean;
};

function BulkJobCard({
  item,
  onDismiss,
}: {
  item: BulkItem;
  onDismiss: () => void;
}) {
  const hostname = (() => {
    try { return new URL(item.url).hostname.replace(/^www\./, ""); } catch { return item.url; }
  })();

  return (
    <div
      className={`relative rounded-xl border bg-card transition-all ${
        item.status === "error"
          ? "border-destructive/30 bg-destructive/5"
          : item.status === "success"
          ? "border-emerald-300/50 dark:border-emerald-800/50"
          : "border-border"
      }`}
    >
      {/* Dismiss button */}
      <button
        onClick={onDismiss}
        className="absolute top-3 right-3 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
        aria-label="Remove"
      >
        <X size={13} />
      </button>

      <div className="p-4 pr-10">
        {item.status === "loading" && (
          <div className="flex items-center gap-3">
            <Loader2 size={16} className="animate-spin text-primary flex-shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-muted-foreground truncate">Reading posting…</p>
              <p className="text-xs text-muted-foreground/60 truncate mt-0.5">{hostname}</p>
            </div>
          </div>
        )}

        {item.status === "error" && (
          <div className="flex items-start gap-3">
            <AlertCircle size={16} className="text-destructive flex-shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-destructive">Couldn't read this posting</p>
              <p className="text-xs text-muted-foreground/70 truncate mt-0.5">{hostname}</p>
              <p className="text-xs text-destructive/80 mt-1">{item.errorMsg}</p>
            </div>
          </div>
        )}

        {item.status === "success" && item.data && (
          <div className="space-y-2">
            <div className="flex items-start gap-2">
              <CheckCircle2 size={15} className="text-emerald-600 dark:text-emerald-400 flex-shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold leading-tight truncate">
                  {item.data.role || <span className="text-muted-foreground italic">Unknown title</span>}
                </p>
                <p className="text-sm text-muted-foreground truncate">{item.data.company}</p>
              </div>
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-shrink-0 text-primary/70 hover:text-primary transition-colors"
                onClick={e => e.stopPropagation()}
              >
                <ExternalLink size={13} />
              </a>
            </div>

            {/* Chip row */}
            <div className="flex flex-wrap gap-1.5 pl-5">
              {item.data.location && (
                <span className="inline-flex items-center gap-1 text-[11px] bg-secondary text-secondary-foreground px-2 py-0.5 rounded-md">
                  <MapPin size={9} />{item.data.location}
                </span>
              )}
              {item.data.rtoDays !== null && item.data.rtoDays !== undefined && (
                <span className="inline-flex items-center gap-1 text-[11px] bg-secondary text-secondary-foreground px-2 py-0.5 rounded-md">
                  <Building2 size={9} />{item.data.rtoDays}d/wk RTO
                </span>
              )}
              {(item.data.salaryBase || item.data.salaryTotal) && (
                <span className="inline-flex items-center gap-1 text-[11px] bg-secondary text-secondary-foreground px-2 py-0.5 rounded-md">
                  <DollarSign size={9} />{item.data.salaryBase || item.data.salaryTotal}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StepBulk({
  urls,
  onBack,
}: {
  urls: string[];
  onBack: () => void;
}) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [items, setItems] = useState<BulkItem[]>(() =>
    urls.map(url => ({ url, status: "loading", dismissed: false }))
  );
  const [saving, setSaving] = useState(false);

  // Fire all parse requests in parallel
  useEffect(() => {
    urls.forEach((url, idx) => {
      apiRequest("POST", "/api/parse-job", { url })
        .then(async res => {
          if (!res.ok) {
            const body = await res.json();
            throw new Error(body.error || "Failed to parse");
          }
          const data: ParsedJob = await res.json();
          setItems(prev => prev.map((item, i) =>
            i === idx ? { ...item, status: "success", data } : item
          ));
        })
        .catch((err: any) => {
          setItems(prev => prev.map((item, i) =>
            i === idx ? { ...item, status: "error", errorMsg: err.message || "Unknown error" } : item
          ));
        });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismiss = (idx: number) =>
    setItems(prev => prev.map((item, i) => i === idx ? { ...item, dismissed: true } : item));

  const visible = items.filter(i => !i.dismissed);
  const successItems = visible.filter(i => i.status === "success");
  const loadingCount = visible.filter(i => i.status === "loading").length;
  const canSave = successItems.length > 0 && loadingCount === 0;

  const handleSaveAll = async () => {
    setSaving(true);
    let saved = 0;
    let failed = 0;

    await Promise.all(
      successItems.map(async item => {
        const d = item.data!;
        try {
          const res = await apiRequest("POST", "/api/jobs", {
            url: item.url,
            role: d.role || "",
            company: d.company || "",
            location: d.location || "",
            salaryBase: d.salaryBase || "",
            salaryRsu: d.salaryRsu || "",
            salaryBonus: d.salaryBonus || "",
            salaryTotal: d.salaryTotal || "",
            postedAt: d.postedAt || "",
            rtoDays: d.rtoDays,
            rtoNotes: d.rtoNotes || "",
            source: d.source || "",
            notes: d.notes || "",
            status: "Interested",
            priority: 2,
          });
          if (!res.ok) throw new Error();
          saved++;
        } catch {
          failed++;
        }
      })
    );

    queryClient.invalidateQueries({ queryKey: ["/api/jobs"] });
    setSaving(false);

    if (failed === 0) {
      toast({ title: `${saved} job${saved !== 1 ? "s" : ""} added` });
    } else {
      toast({
        title: `${saved} saved, ${failed} failed`,
        variant: "destructive",
      });
    }
    navigate("/");
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">

      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={onBack}
          className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
          data-testid="btn-back"
          aria-label="Back"
        >
          <ArrowLeft size={18} />
        </button>
        <div>
          <h1 className="text-lg font-bold leading-tight">Review {urls.length} jobs</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {loadingCount > 0
              ? `Reading ${loadingCount} more posting${loadingCount !== 1 ? "s" : ""}…`
              : `${successItems.length} ready to save${visible.filter(i => i.status === "error").length > 0 ? `, ${visible.filter(i => i.status === "error").length} failed` : ""}`
            }
          </p>
        </div>
      </div>

      {/* Cards */}
      <div className="space-y-3 mb-6">
        {items.map((item, idx) =>
          item.dismissed ? null : (
            <BulkJobCard key={item.url + idx} item={item} onDismiss={() => dismiss(idx)} />
          )
        )}
        {visible.length === 0 && (
          <div className="text-center py-10 text-sm text-muted-foreground">
            All jobs dismissed.{" "}
            <button onClick={onBack} className="underline hover:text-foreground">Go back</button>
          </div>
        )}
      </div>

      {/* Save all footer */}
      {visible.length > 0 && (
        <div className="flex items-center gap-3 pb-8">
          <Button
            className="flex-1 h-11 text-sm font-medium"
            onClick={handleSaveAll}
            disabled={!canSave || saving}
            data-testid="btn-save-all"
          >
            {saving ? (
              <><Loader2 size={14} className="mr-2 animate-spin" />Saving…</>
            ) : loadingCount > 0 ? (
              <><Loader2 size={14} className="mr-2 animate-spin" />Waiting for results…</>
            ) : (
              <><CheckCircle2 size={14} className="mr-2" />Save {successItems.length} job{successItems.length !== 1 ? "s" : ""}</>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Step 2: Review & edit prefilled form ────────────────────────────────

function StepForm({
  url,
  prefilled,
  onBack,
}: {
  url: string;
  prefilled: Partial<FormValues>;
  onBack: () => void;
}) {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const { register, handleSubmit, control, formState: { errors } } = useForm<FormValues>({
    defaultValues: {
      company: "",
      role: "",
      status: "Interested",
      location: "",
      url,
      salaryBase: "",
      salaryRsu: "",
      salaryBonus: "",
      salaryTotal: "",
      rtoDays: null,
      rtoNotes: "",
      source: "",
      appliedAt: "",
      postedAt: "",
      priority: 2,
      notes: "",
      nextSteps: "",
      ...prefilled,
    },
  });

  const createMutation = useMutation({
    mutationFn: (data: FormValues) => apiRequest("POST", "/api/jobs", data),
    onSuccess: async (res) => {
      const job = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/jobs"] });
      toast({ title: "Job added" });
      navigate(`/jobs/${job.id}`);
    },
    onError: () => toast({ title: "Failed to save", variant: "destructive" }),
  });

  const hasPrefill = Boolean(prefilled.role || prefilled.company);

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">

      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={onBack}
          className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
          data-testid="btn-back"
          aria-label="Back"
        >
          <ArrowLeft size={18} />
        </button>
        <div>
          <h1 className="text-lg font-bold leading-tight">
            {hasPrefill ? "Review & confirm" : "Add job manually"}
          </h1>
          {hasPrefill && (
            <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
              <Sparkles size={10} className="text-emerald-600" />
              Fields auto-filled from the job posting — review and adjust as needed
            </p>
          )}
        </div>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto flex items-center gap-1 text-xs text-primary hover:opacity-80 transition-opacity flex-shrink-0"
          >
            <ExternalLink size={12} />
            View posting
          </a>
        )}
      </div>

      <form onSubmit={handleSubmit(data => createMutation.mutate(data))} className="space-y-6">

        {/* ── Core ─────────────────────────────────────────── */}
        <section className="bg-card border border-border rounded-xl p-5 space-y-4">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Position</h2>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="f-company">
                Company *
                <AutoFilled value={prefilled.company} />
              </Label>
              <Input
                id="f-company"
                data-testid="input-company"
                {...register("company", { required: true })}
                className={prefilled.company ? "border-emerald-300 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/20" : ""}
              />
              {errors.company && <p className="text-xs text-destructive">Required</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="f-role">
                Title *
                <AutoFilled value={prefilled.role} />
              </Label>
              <Input
                id="f-role"
                data-testid="input-role"
                {...register("role", { required: true })}
                className={prefilled.role ? "border-emerald-300 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/20" : ""}
              />
              {errors.role && <p className="text-xs text-destructive">Required</p>}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Controller name="status" control={control} render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger data-testid="select-status"><SelectValue /></SelectTrigger>
                  <SelectContent>{JOB_STATUSES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                </Select>
              )} />
            </div>
            <div className="space-y-1.5">
              <Label>Priority</Label>
              <Controller name="priority" control={control} render={({ field }) => (
                <Select value={String(field.value)} onValueChange={v => field.onChange(Number(v))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">High</SelectItem>
                    <SelectItem value="2">Medium</SelectItem>
                    <SelectItem value="3">Low</SelectItem>
                  </SelectContent>
                </Select>
              )} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="f-source">
                Source
                <AutoFilled value={prefilled.source} />
              </Label>
              <Input id="f-source" {...register("source")} placeholder="LinkedIn, Referral, etc."
                className={prefilled.source ? "border-emerald-300 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/20" : ""}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="f-applied">Applied Date</Label>
              <Input id="f-applied" type="date" {...register("appliedAt")} />
            </div>
          </div>
        </section>

        {/* ── Location + RTO ───────────────────────────────── */}
        <section className="bg-card border border-border rounded-xl p-5 space-y-4">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Location & Office</h2>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="f-location">
                <MapPin size={12} className="inline mr-1" />
                Location
                <AutoFilled value={prefilled.location} />
              </Label>
              <Input id="f-location" {...register("location")} placeholder="e.g. San Francisco, CA"
                className={prefilled.location ? "border-emerald-300 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/20" : ""}
              />
            </div>
            <div className="space-y-1.5">
              <Label>
                <Building2 size={12} className="inline mr-1" />
                RTO (days/week)
                <AutoFilled value={prefilled.rtoDays} />
              </Label>
              <Controller name="rtoDays" control={control} render={({ field }) => (
                <Select
                  value={field.value === null || field.value === undefined ? "unknown" : String(field.value)}
                  onValueChange={v => field.onChange(v === "unknown" ? null : Number(v))}
                >
                  <SelectTrigger className={prefilled.rtoDays !== null && prefilled.rtoDays !== undefined ? "border-emerald-300 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/20" : ""} data-testid="select-rto">
                    <SelectValue placeholder="Unknown" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unknown">Unknown</SelectItem>
                    <SelectItem value="0">0 — Fully Remote</SelectItem>
                    <SelectItem value="1">1 day/week</SelectItem>
                    <SelectItem value="2">2 days/week</SelectItem>
                    <SelectItem value="3">3 days/week</SelectItem>
                    <SelectItem value="4">4 days/week</SelectItem>
                    <SelectItem value="5">5 — Fully On-site</SelectItem>
                  </SelectContent>
                </Select>
              )} />
            </div>
          </div>

          {prefilled.rtoNotes && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground bg-secondary/60 rounded-lg px-3 py-2">
              <Sparkles size={10} className="text-emerald-600 flex-shrink-0" />
              Found in posting: <span className="italic ml-0.5">{prefilled.rtoNotes}</span>
            </div>
          )}
          <Input {...register("rtoNotes")} placeholder="RTO notes, e.g. Tue/Wed/Thu required" className="text-sm" />
        </section>

        {/* ── Compensation ─────────────────────────────────── */}
        <section className="bg-card border border-border rounded-xl p-5 space-y-4">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <DollarSign size={12} className="inline mr-1" />
            Compensation
          </h2>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="f-base">
                Base Salary
                <AutoFilled value={prefilled.salaryBase} />
              </Label>
              <Input id="f-base" {...register("salaryBase")} placeholder="e.g. $160,000"
                className={prefilled.salaryBase ? "border-emerald-300 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/20" : ""}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="f-rsu">
                RSUs / Equity
                <AutoFilled value={prefilled.salaryRsu} />
              </Label>
              <Input id="f-rsu" {...register("salaryRsu")} placeholder="e.g. $200k over 4yr"
                className={prefilled.salaryRsu ? "border-emerald-300 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/20" : ""}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="f-bonus">
                Bonus
                <AutoFilled value={prefilled.salaryBonus} />
              </Label>
              <Input id="f-bonus" {...register("salaryBonus")} placeholder="e.g. 15% target"
                className={prefilled.salaryBonus ? "border-emerald-300 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/20" : ""}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="f-total">Total Comp (est.)</Label>
              <Input id="f-total" {...register("salaryTotal")} placeholder="e.g. $230,000" />
            </div>
          </div>
        </section>

        {/* ── Notes ────────────────────────────────────────── */}
        <section className="bg-card border border-border rounded-xl p-5 space-y-4">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Notes</h2>
          <div className="space-y-1.5">
            <Label htmlFor="f-notes">
              Notes
              <AutoFilled value={prefilled.notes} />
            </Label>
            <Textarea
              id="f-notes"
              {...register("notes")}
              rows={3}
              placeholder="Key info, impressions, requirements..."
              className={`resize-none ${prefilled.notes ? "border-emerald-300 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/20" : ""}`}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="f-next">Next Steps</Label>
            <Textarea id="f-next" {...register("nextSteps")} rows={2} placeholder="What needs to happen next?" className="resize-none" />
          </div>
        </section>

        {/* ── Submit ─────────────────────────────────────── */}
        <div className="flex items-center gap-3 pb-8">
          <Button
            type="submit"
            className="flex-1 h-11 text-sm font-medium"
            disabled={createMutation.isPending}
            data-testid="btn-save"
          >
            {createMutation.isPending
              ? <><Loader2 size={14} className="mr-2 animate-spin" />Saving…</>
              : <><CheckCircle2 size={14} className="mr-2" />Save job</>
            }
          </Button>
        </div>
      </form>
    </div>
  );
}

// ─── Main AddJob page ────────────────────────────────────────────────────

export default function AddJob() {
  const [, navigate] = useLocation();
  const [step, setStep] = useState<"url" | "form" | "bulk">("url");
  const [parsedUrl, setParsedUrl] = useState("");
  const [prefilled, setPrefilled] = useState<Partial<FormValues>>({});
  const [bulkUrls, setBulkUrls] = useState<string[]>([]);

  // Breadcrumb label
  const stepLabel = step === "url" ? "1. Paste URLs" : step === "bulk" ? "2. Review jobs" : "2. Review details";

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
          <button
            onClick={() => navigate("/")}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            data-testid="link-back"
          >
            <ArrowLeft size={14} />
            All jobs
          </button>
          <span className="text-muted-foreground/40">/</span>
          <span className="text-sm font-medium">Add job</span>

          {/* Breadcrumb step */}
          <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={step === "url" ? "text-foreground font-medium" : ""}>1. Paste URLs</span>
            <ChevronRight size={12} />
            <span className={step !== "url" ? "text-foreground font-medium" : ""}>{step === "bulk" ? "2. Review jobs" : "2. Review details"}</span>
          </div>
        </div>
      </header>

      {step === "url" && (
        <StepUrl
          onParsedSingle={(url, data) => {
            setParsedUrl(url);
            setPrefilled({
              url,
              role: data.role || "",
              company: data.company || "",
              location: data.location || "",
              salaryBase: data.salaryBase || "",
              salaryRsu: data.salaryRsu || "",
              salaryBonus: data.salaryBonus || "",
              salaryTotal: data.salaryTotal || "",
              rtoDays: data.rtoDays,
              rtoNotes: data.rtoNotes || "",
              source: data.source || "",
              postedAt: data.postedAt || "",
              notes: data.notes || "",
            });
            setStep("form");
          }}
          onParsedBulk={(urls) => {
            setBulkUrls(urls);
            setStep("bulk");
          }}
          onSkip={() => {
            setParsedUrl("");
            setPrefilled({});
            setStep("form");
          }}
        />
      )}

      {step === "bulk" && (
        <StepBulk
          urls={bulkUrls}
          onBack={() => setStep("url")}
        />
      )}

      {step === "form" && (
        <StepForm
          url={parsedUrl}
          prefilled={prefilled}
          onBack={() => setStep("url")}
        />
      )}
    </div>
  );
}
