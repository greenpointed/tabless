import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { JOB_STATUSES, type Job, type JobStatus } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useForm, Controller } from "react-hook-form";
import {
  Plus, LayoutGrid, List, Briefcase, CheckCircle2, TrendingUp,
  ExternalLink, Trash2, Edit3, Sun, Moon, MapPin,
  DollarSign, Calendar, Search, ArrowUpRight, Building2, Wifi, WifiOff, Star, RotateCcw,
} from "lucide-react";
import { Link, useLocation } from "wouter";
import { format, parseISO } from "date-fns";

// ─── Types ─────────────────────────────────────────────────────────────

type FormValues = {
  company: string;
  role: string;
  status: JobStatus;
  location?: string;
  url?: string;
  salaryBase?: string;
  salaryRsu?: string;
  salaryBonus?: string;
  salaryTotal?: string;
  rtoDays?: number | null;
  rtoNotes?: string;
  source?: string;
  appliedAt?: string;
  priority: number;
  notes?: string;
  nextSteps?: string;
};

const STATUS_ORDER: JobStatus[] = [
  "Interested", "Applied", "Phone Screen", "Interview", "Offer", "Rejected", "Withdrawn",
];

const PRIORITY_LABELS: Record<number, string> = { 1: "High", 2: "Medium", 3: "Low" };

// ─── Helpers ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium status-${CSS.escape(status)}`}>
      {status}
    </span>
  );
}

function RtoBadge({ days }: { days: number | null | undefined }) {
  if (days === null || days === undefined) {
    return <span className="text-xs text-muted-foreground/50 italic">Unknown</span>;
  }
  if (days === 0) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
        <Wifi size={10} />Remote
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
      <Building2 size={10} />{days}d/wk
    </span>
  );
}

const STATUS_DOT_COLORS: Record<string, string> = {
  "Interested":    "bg-slate-400",       // gray — not yet acted on
  "Applied":       "bg-blue-500",        // blue — in motion
  "Phone Screen":  "bg-yellow-400",      // yellow — warming up
  "Interview":     "bg-orange-500",      // orange — active
  "Offer":         "bg-emerald-500",     // green — success
  "Rejected":      "bg-red-500",         // red — closed
  "Withdrawn":     "bg-slate-300",       // light gray — inactive
};

function StatusDot({ status }: { status: string }) {
  const color = STATUS_DOT_COLORS[status] ?? "bg-slate-400";
  return <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${color}`} title={status} />;
}

function StatCard({ label, value, icon: Icon, sub }: { label: string; value: number | string; icon: any; sub?: string }) {
  return (
    <div className="bg-card border border-border rounded-lg p-4 flex items-center gap-3">
      <div className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center flex-shrink-0">
        <Icon size={16} className="text-muted-foreground" />
      </div>
      <div>
        <p className="text-xl font-bold text-foreground leading-none">{value}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
        {sub && <p className="text-xs text-primary mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// ─── Job Form ─────────────────────────────────────────────────────────

function JobForm({ defaultValues, onSubmit, isPending, submitLabel }: {
  defaultValues?: Partial<FormValues>;
  onSubmit: (data: FormValues) => void;
  isPending: boolean;
  submitLabel: string;
}) {
  const { register, handleSubmit, control, formState: { errors } } = useForm<FormValues>({
    defaultValues: { company: "", role: "", status: "Interested", priority: 2, ...defaultValues },
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 pt-1">
      {/* Row 1 */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="f-company">Company *</Label>
          <Input id="f-company" data-testid="input-company" {...register("company", { required: true })} placeholder="e.g. Google" />
          {errors.company && <p className="text-xs text-destructive">Required</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="f-role">Title *</Label>
          <Input id="f-role" data-testid="input-role" {...register("role", { required: true })} placeholder="e.g. Product Manager" />
          {errors.role && <p className="text-xs text-destructive">Required</p>}
        </div>
      </div>

      {/* Row 2 */}
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

      {/* Compensation */}
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground pt-1">Compensation</p>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="f-base">Base Salary</Label>
          <Input id="f-base" {...register("salaryBase")} placeholder="e.g. $160,000" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="f-rsu">RSUs / Equity</Label>
          <Input id="f-rsu" {...register("salaryRsu")} placeholder="e.g. $200k over 4yr" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="f-bonus">Bonus</Label>
          <Input id="f-bonus" {...register("salaryBonus")} placeholder="e.g. 15% target" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="f-total">Total Comp (est.)</Label>
          <Input id="f-total" {...register("salaryTotal")} placeholder="e.g. $230,000" />
        </div>
      </div>

      {/* Location + RTO */}
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground pt-1">Location & Office</p>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="f-location">Location</Label>
          <Input id="f-location" {...register("location")} placeholder="e.g. San Francisco, CA" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="f-rto">RTO (days/week)</Label>
          <Controller name="rtoDays" control={control} render={({ field }) => (
            <Select
              value={field.value === null || field.value === undefined ? "unknown" : String(field.value)}
              onValueChange={v => field.onChange(v === "unknown" ? null : Number(v))}
            >
              <SelectTrigger data-testid="select-rto"><SelectValue placeholder="Unknown" /></SelectTrigger>
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
      <div className="space-y-1.5">
        <Label htmlFor="f-rto-notes">RTO Notes</Label>
        <Input id="f-rto-notes" {...register("rtoNotes")} placeholder="e.g. Tue/Wed/Thu required" />
      </div>

      {/* Misc */}
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground pt-1">Details</p>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="f-source">Source</Label>
          <Input id="f-source" {...register("source")} placeholder="e.g. LinkedIn, Referral" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="f-applied">Applied Date</Label>
          <Input id="f-applied" type="date" {...register("appliedAt")} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="f-url">Job URL</Label>
        <Input id="f-url" {...register("url")} placeholder="https://..." />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="f-notes">Notes</Label>
        <Textarea id="f-notes" {...register("notes")} placeholder="Key info, impressions..." rows={2} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="f-next">Next Steps</Label>
        <Textarea id="f-next" {...register("nextSteps")} placeholder="What needs to happen next..." rows={2} />
      </div>

      <Button type="submit" className="w-full" disabled={isPending} data-testid="button-submit">
        {isPending ? "Saving..." : submitLabel}
      </Button>
    </form>
  );
}

// ─── Kanban ────────────────────────────────────────────────────────────

function KanbanCard({ job, onEdit, onDelete }: { job: Job; onEdit: (j: Job) => void; onDelete: (id: number) => void }) {
  return (
    <div className="bg-card border border-border rounded-lg p-3 group hover:shadow-sm hover:border-primary/30 transition-all" data-testid={`card-job-${job.id}`}>
      <div className="flex items-start justify-between gap-1 mb-0.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <StatusDot status={job.status} />
          <Link href={`/jobs/${job.id}`}>
            <span className="font-semibold text-sm text-foreground truncate hover:text-primary transition-colors cursor-pointer">{job.company}</span>
          </Link>
        </div>
        <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
          <button onClick={() => onEdit(job)} className="p-0.5 rounded hover:bg-secondary" data-testid={`btn-edit-${job.id}`} aria-label="Edit">
            <Edit3 size={12} />
          </button>
          <button onClick={() => onDelete(job.id)} className="p-0.5 rounded hover:bg-destructive/10 text-destructive" data-testid={`btn-delete-${job.id}`} aria-label="Delete">
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground truncate">{job.role}</p>
      {job.location && <p className="text-xs text-muted-foreground/60 truncate mt-0.5 flex items-center gap-0.5"><MapPin size={9} />{job.location}</p>}

      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
        <RtoBadge days={job.rtoDays} />
        {job.salaryTotal && <span className="text-xs text-muted-foreground font-medium">{job.salaryTotal}</span>}
      </div>
      {(job.glassdoorRating || job.blindRating) && (
        <div className="flex items-center gap-2 mt-1.5">
          {job.glassdoorRating && (
            <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400">
              <Star size={9} className="fill-amber-400 stroke-amber-500" />{job.glassdoorRating} GD
            </span>
          )}
          {job.blindRating && (
            <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-blue-700 dark:text-blue-400">
              <Star size={9} className="fill-blue-400 stroke-blue-500" />{job.blindRating} Blind
            </span>
          )}
        </div>
      )}

      {job.nextSteps && (
        <p className="text-xs text-primary/80 mt-1.5 line-clamp-2 border-t border-border pt-1.5">
          → {job.nextSteps}
        </p>
      )}
      {job.appliedAt && (
        <p className="text-xs text-muted-foreground/50 mt-1">{format(parseISO(job.appliedAt), "MMM d")}</p>
      )}
    </div>
  );
}

function KanbanColumn({ status, jobs: colJobs, onEdit, onDelete }: {
  status: JobStatus; jobs: Job[]; onEdit: (j: Job) => void; onDelete: (id: number) => void;
}) {
  return (
    <div className="flex-shrink-0 w-56" data-testid={`col-${status}`}>
      <div className="flex items-center gap-2 mb-2">
        <StatusBadge status={status} />
        <span className="text-xs text-muted-foreground">{colJobs.length}</span>
      </div>
      <div className="space-y-2 min-h-[80px]">
        {colJobs.length === 0
          ? <div className="h-16 rounded-lg border border-dashed border-border flex items-center justify-center"><span className="text-xs text-muted-foreground/50">—</span></div>
          : colJobs.map(j => <KanbanCard key={j.id} job={j} onEdit={onEdit} onDelete={onDelete} />)
        }
      </div>
    </div>
  );
}

// ─── List Table ────────────────────────────────────────────────────────

// ─── Sort helpers ──────────────────────────────────────────────────────

type SortKey = "company" | "role" | "status" | "rtoDays" | "salaryBase" | "postedAt" | "appliedAt" | "blindRating" | "relevanceScore" | "nextSteps";
type SortDir = "asc" | "desc";

function sortJobs(jobs: Job[], key: SortKey, dir: SortDir): Job[] {
  return [...jobs].sort((a, b) => {
    const av: any = a[key as keyof Job];
    const bv: any = b[key as keyof Job];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") return dir === "asc" ? av - bv : bv - av;
    const cmp = String(av).toLowerCase().localeCompare(String(bv).toLowerCase());
    return dir === "asc" ? cmp : -cmp;
  });
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <span className="ml-1 opacity-30 text-[10px]">⇅</span>;
  return <span className="ml-1 text-[10px]">{dir === "asc" ? "↑" : "↓"}</span>;
}

function ListRow({ job, onEdit, onDelete, onRestore, isDeleted }: { job: Job; onEdit: (j: Job) => void; onDelete: (id: number) => void; onRestore?: (id: number) => void; isDeleted?: boolean }) {
  return (
    <tr className="border-b border-border hover:bg-secondary/40 transition-colors group" data-testid={`row-${job.id}`}>
      {/* Company */}
      <td className="px-3 py-2.5 whitespace-nowrap">
        <div className="flex items-center gap-1.5">
          <StatusDot status={job.status} />
          <Link href={`/jobs/${job.id}`}>
            <span className="font-semibold text-sm hover:text-primary transition-colors cursor-pointer">{job.company}</span>
          </Link>
        </div>
      </td>
      {/* Relevance */}
      <td className="px-3 py-2.5 whitespace-nowrap">
        {job.relevanceScore != null
          ? <span
              title={job.relevanceSummary || undefined}
              className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-bold cursor-help ${
                job.relevanceScore >= 80 ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300" :
                job.relevanceScore >= 60 ? "bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300" :
                job.relevanceScore >= 40 ? "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300" :
                "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300"
              }`}
            >{job.relevanceScore}</span>
          : <span className="text-muted-foreground/40 text-xs">—</span>
        }
      </td>
      {/* Title */}
      <td className="px-3 py-2.5 text-sm text-muted-foreground min-w-[260px]">
        <span className="block">{job.role}</span>
      </td>
      {/* Link */}
      <td className="px-3 py-2.5 text-center">
        {job.url
          ? <a href={job.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:opacity-70 transition-opacity" data-testid={`link-${job.id}`} aria-label="Job posting"><ExternalLink size={14} /></a>
          : <span className="text-muted-foreground/30">—</span>
        }
      </td>
      {/* Status */}
      <td className="px-3 py-2.5 whitespace-nowrap"><StatusBadge status={job.status} /></td>
      {/* RTO */}
      <td className="px-3 py-2.5 whitespace-nowrap"><RtoBadge days={job.rtoDays} /></td>
      {/* Base */}
      <td className="px-3 py-2.5 text-sm text-muted-foreground whitespace-nowrap">{job.salaryBase || "—"}</td>
      {/* Date Posted */}
      <td className="px-3 py-2.5 text-sm text-muted-foreground whitespace-nowrap">
        {(() => {
          if (!job.postedAt) return "—";
          try { const d = parseISO(job.postedAt); return isNaN(d.getTime()) ? "—" : format(d, "MMM d, yyyy"); }
          catch { return "—"; }
        })()}
      </td>
      {/* Date Applied */}
      <td className="px-3 py-2.5 text-sm text-muted-foreground whitespace-nowrap">
        {(() => {
          if (!job.appliedAt) return "—";
          try { const d = parseISO(job.appliedAt); return isNaN(d.getTime()) ? "—" : format(d, "MMM d, yyyy"); }
          catch { return "—"; }
        })()}
      </td>
      {/* Blind Reviews */}
      <td className="px-3 py-2.5 whitespace-nowrap">
        {job.blindRating
          ? <span className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 dark:text-blue-400">
              <Star size={11} className="fill-blue-400 stroke-blue-500" />{job.blindRating}
            </span>
          : <span className="text-muted-foreground/40 text-xs">—</span>
        }
      </td>
      {/* Next Steps */}
      <td className="px-3 py-2.5 text-sm text-muted-foreground max-w-[200px]">
        <span className="line-clamp-2 block">{job.nextSteps || "—"}</span>
      </td>
      {/* Actions */}
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {isDeleted ? (
            <button onClick={() => onRestore?.(job.id)} className="p-1 rounded hover:bg-emerald-100 text-emerald-700 dark:hover:bg-emerald-950 dark:text-emerald-400" aria-label="Restore" title="Restore job"><RotateCcw size={13} /></button>
          ) : (
            <>
              <button onClick={() => onEdit(job)} className="p-1 rounded hover:bg-secondary" aria-label="Edit" data-testid={`btn-edit-tbl-${job.id}`}><Edit3 size={13} /></button>
              <button onClick={() => onDelete(job.id)} className="p-1 rounded hover:bg-destructive/10 text-destructive" aria-label="Delete" data-testid={`btn-del-tbl-${job.id}`}><Trash2 size={13} /></button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

// ─── Dashboard ─────────────────────────────────────────────────────────

export default function Dashboard() {
  const [, navigate] = useLocation();
  const [view, setView] = useState<"board" | "list">("list");
  const [isDark, setIsDark] = useState(
    typeof window !== "undefined" ? document.documentElement.classList.contains("dark") : false
  );
  const [editJob, setEditJob] = useState<Job | null>(null);
  const [filterStatus, setFilterStatus] = useState<JobStatus | "All" | "Deleted">("All");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const { toast } = useToast();

  // Numeric/rating columns should default to descending (highest first) on first click
  const descFirstKeys: SortKey[] = ["relevanceScore", "salaryBase", "blindRating", "rtoDays"];

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(descFirstKeys.includes(key) ? "desc" : "asc");
    }
  }

  const toggleTheme = () => {
    const next = isDark ? "light" : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    setIsDark(!isDark);
  };

  const { data: jobs = [], isLoading } = useQuery<Job[]>({ queryKey: ["/api/jobs"] });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<FormValues> }) => apiRequest("PATCH", `/api/jobs/${id}`, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/jobs"] }); setEditJob(null); toast({ title: "Updated" }); },
  });

  const [undoJob, setUndoJob] = useState<Job | null>(null);
  const [undoTimer, setUndoTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/jobs/${id}`),
    onMutate: (id: number) => {
      const allJobs = queryClient.getQueryData<Job[]>(["/api/jobs"]) || [];
      const job = allJobs.find(j => j.id === id) || null;
      setUndoJob(job);
      if (undoTimer) clearTimeout(undoTimer);
      const timer = setTimeout(() => {
        setUndoJob(null);
        queryClient.invalidateQueries({ queryKey: ["/api/jobs/deleted"] });
      }, 6000);
      setUndoTimer(timer);
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/jobs"] }); },
  });

  const restoreMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/jobs/${id}/restore`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/jobs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/jobs/deleted"] });
      setUndoJob(null);
      if (undoTimer) clearTimeout(undoTimer);
      toast({ title: "Job restored" });
    },
  });

  const { data: deletedJobs = [] } = useQuery<Job[]>({
    queryKey: ["/api/jobs/deleted"],
    enabled: filterStatus === "Deleted",
  });

  const activeCount = jobs.filter(j => !["Rejected", "Withdrawn"].includes(j.status)).length;
  const interviewCount = jobs.filter(j => ["Interview", "Phone Screen"].includes(j.status)).length;
  const offerCount = jobs.filter(j => j.status === "Offer").length;

  const baseFiltered = (filterStatus === "Deleted" ? deletedJobs : jobs).filter(j => {
    if (filterStatus !== "All" && filterStatus !== "Deleted" && j.status !== filterStatus) return false;
    const q = search.toLowerCase();
    return !q || j.company.toLowerCase().includes(q) || j.role.toLowerCase().includes(q) || (j.location || "").toLowerCase().includes(q);
  });

  const filtered = sortKey ? sortJobs(baseFiltered, sortKey, sortDir) : baseFiltered;

  const byStatus = (s: JobStatus) => filtered.filter(j => j.status === s);

  type ColDef = { label: string; sortKey?: SortKey };
  const TABLE_COLS: ColDef[] = [
    { label: "Company",       sortKey: "company" },
    { label: "Relevance",     sortKey: "relevanceScore" },
    { label: "Title",         sortKey: "role" },
    { label: "Link" },
    { label: "Status",        sortKey: "status" },
    { label: "RTO",           sortKey: "rtoDays" },
    { label: "Base Salary",   sortKey: "salaryBase" },
    { label: "Date Posted",   sortKey: "postedAt" },
    { label: "Date Applied",  sortKey: "appliedAt" },
    { label: "Blind Reviews", sortKey: "blindRating" },
    { label: "Next Steps",    sortKey: "nextSteps" },
    { label: "" },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Undo delete toast */}
      {undoJob && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-foreground text-background px-4 py-3 rounded-xl shadow-xl text-sm font-medium animate-in slide-in-from-bottom-4">
          <span>Deleted <span className="font-semibold">{undoJob.company}</span></span>
          <button
            onClick={() => restoreMutation.mutate(undoJob.id)}
            className="ml-1 px-3 py-1 rounded-lg bg-background/20 hover:bg-background/30 transition-colors font-semibold text-xs"
          >
            Undo
          </button>
        </div>
      )}
      {/* ── Header ─── */}
      <header className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur">
        <div className="max-w-[1600px] mx-auto px-4 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 flex-shrink-0">
            <svg aria-label="TabLess" viewBox="0 0 32 32" fill="none" className="w-7 h-7" xmlns="http://www.w3.org/2000/svg">
              <rect x="4" y="10" width="24" height="18" rx="2.5" className="fill-primary" />
              <rect x="11" y="4" width="10" height="8" rx="1.5" className="fill-primary/40" />
              <rect x="13" y="6" width="6" height="4" rx="1" fill="white" fillOpacity="0.8" />
              <rect x="8" y="17" width="16" height="1.5" rx="0.75" fill="white" fillOpacity="0.7" />
              <rect x="8" y="21" width="11" height="1.5" rx="0.75" fill="white" fillOpacity="0.5" />
            </svg>
            <span className="font-semibold text-sm">TabLess</span>
          </div>

          <div className="relative flex-1 max-w-sm hidden sm:block">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text" placeholder="Search companies, roles..." value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-sm rounded-md border border-border bg-secondary/50 focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
              data-testid="input-search"
            />
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center bg-secondary rounded-md p-0.5">
              <button onClick={() => setView("list")} className={`p-1.5 rounded transition-colors ${view === "list" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground"}`} aria-label="List view" data-testid="btn-list-view"><List size={14} /></button>
              <button onClick={() => setView("board")} className={`p-1.5 rounded transition-colors ${view === "board" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground"}`} aria-label="Board view" data-testid="btn-board-view"><LayoutGrid size={14} /></button>
            </div>
            <button onClick={toggleTheme} className="p-1.5 rounded-md border border-border hover:bg-secondary transition-colors" aria-label="Toggle theme" data-testid="btn-theme">
              {isDark ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <Button size="sm" onClick={() => navigate("/add")} data-testid="btn-add"><Plus size={14} className="mr-1" />Add job</Button>
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto px-4 py-5">
        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          <StatCard label="Total tracked" value={jobs.length} icon={Briefcase} />
          <StatCard label="Active pipeline" value={activeCount} icon={TrendingUp} />
          <StatCard label="In interview" value={interviewCount} icon={Calendar} />
          <StatCard label="Offers" value={offerCount} icon={CheckCircle2} sub={offerCount > 0 ? "Congrats!" : undefined} />
        </div>

        {/* Filter chips */}
        <div className="flex items-center gap-1.5 mb-4 flex-wrap">
          {(["All", ...STATUS_ORDER, "Deleted"] as const).map(s => (
            <button
              key={s}
              onClick={() => setFilterStatus(s as JobStatus | "All")}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${filterStatus === s ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:bg-secondary/80"}`}
              data-testid={`filter-${s}`}
            >
              {s} {s === "Deleted" ? `(${deletedJobs.length})` : s !== "All" && `(${jobs.filter(j => j.status === s).length})`}
            </button>
          ))}
        </div>

        {/* Loading */}
        {isLoading && <div className="space-y-2">{[1, 2, 3].map(i => <div key={i} className="skeleton h-12 rounded-lg" />)}</div>}

        {/* Empty state */}
        {!isLoading && jobs.length === 0 && (
          <div className="flex flex-col items-center justify-center text-center py-20 gap-4">
            <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center"><Briefcase size={22} className="text-muted-foreground" /></div>
            <div>
              <h2 className="text-base font-semibold mb-1">No jobs tracked yet</h2>
              <p className="text-sm text-muted-foreground max-w-xs">Add your first opportunity to start tracking your search.</p>
            </div>
            <Button onClick={() => navigate("/add")}><Plus size={14} className="mr-1" />Add your first job</Button>
          </div>
        )}

        {/* ── LIST VIEW ── */}
        {!isLoading && jobs.length > 0 && view === "list" && (
          <div className="rounded-lg border border-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[1100px]">
                <thead className="bg-secondary/60 border-b border-border">
                  <tr>
                    {TABLE_COLS.map((col, i) => (
                      <th
                        key={i}
                        className={`px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap ${
                          col.sortKey ? "cursor-pointer select-none hover:text-foreground transition-colors" : ""
                        }`}
                        onClick={() => col.sortKey && handleSort(col.sortKey)}
                      >
                        {col.label}
                        {col.sortKey && <SortIcon active={sortKey === col.sortKey} dir={sortDir} />}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0
                    ? <tr><td colSpan={TABLE_COLS.length} className="px-4 py-10 text-center text-sm text-muted-foreground">No jobs match your filter</td></tr>
                    : filtered.map(j => <ListRow key={j.id} job={j} onEdit={setEditJob} onDelete={id => deleteMutation.mutate(id)} onRestore={filterStatus === "Deleted" ? id => restoreMutation.mutate(id) : undefined} isDeleted={filterStatus === "Deleted"} />)
                  }
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── KANBAN VIEW ── */}
        {!isLoading && jobs.length > 0 && view === "board" && (
          <div className="overflow-x-auto pb-4">
            <div className="flex gap-3 min-w-max">
              {STATUS_ORDER.map(s => (
                <KanbanColumn key={s} status={s} jobs={byStatus(s)} onEdit={setEditJob} onDelete={id => deleteMutation.mutate(id)} />
              ))}
            </div>
          </div>
        )}
      </main>

      {/* ── Edit Dialog ── */}
      <Dialog open={!!editJob} onOpenChange={open => !open && setEditJob(null)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Edit — {editJob?.company}</DialogTitle></DialogHeader>
          {editJob && (
            <JobForm
              defaultValues={{
                company: editJob.company, role: editJob.role, status: editJob.status as JobStatus,
                location: editJob.location ?? "", url: editJob.url ?? "",
                salaryBase: editJob.salaryBase ?? "", salaryRsu: editJob.salaryRsu ?? "",
                salaryBonus: editJob.salaryBonus ?? "", salaryTotal: editJob.salaryTotal ?? "",
                rtoDays: editJob.rtoDays ?? null, rtoNotes: editJob.rtoNotes ?? "",
                source: editJob.source ?? "", appliedAt: editJob.appliedAt ?? "",
                priority: editJob.priority, notes: editJob.notes ?? "",
                nextSteps: editJob.nextSteps ?? "",
              }}
              onSubmit={data => updateMutation.mutate({ id: editJob.id, data })}
              isPending={updateMutation.isPending}
              submitLabel="Save changes"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
