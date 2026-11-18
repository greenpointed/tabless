import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import type { Job, InsertJob, Contact, InsertContact, ActionItem, InsertActionItem } from "@shared/schema";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("Set SUPABASE_URL and SUPABASE_KEY for your own empty database.");
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Column mapping: JS camelCase ↔ DB snake_case ────────────────────────────

function toDb(data: Partial<InsertJob>): Record<string, any> {
  const m: Record<string, any> = {};
  if (data.company           !== undefined) m.company            = data.company;
  if (data.role              !== undefined) m.role               = data.role;
  if (data.status            !== undefined) m.status             = data.status;
  if (data.location          !== undefined) m.location           = data.location;
  if (data.url               !== undefined) m.url                = data.url;
  if (data.salaryBase        !== undefined) m.salary_base        = data.salaryBase;
  if (data.salaryRsu         !== undefined) m.salary_rsu         = data.salaryRsu;
  if (data.salaryBonus       !== undefined) m.salary_bonus       = data.salaryBonus;
  if (data.salaryTotal       !== undefined) m.salary_total       = data.salaryTotal;
  if (data.rtoDays           !== undefined) m.rto_days           = data.rtoDays;
  if (data.rtoNotes          !== undefined) m.rto_notes          = data.rtoNotes;
  if (data.source            !== undefined) m.source             = data.source;
  // Guard: empty or unparseable date strings crash the dashboard (new Date('').toISOString() throws).
  // Normalize any date-ish field to either a valid YYYY-MM-DD string or null.
  const safeDate = (v: any): string | null => {
    if (v === undefined || v === null || v === "") return null;
    const d = new Date(v);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  };
  if (data.appliedAt         !== undefined) m.applied_at         = safeDate(data.appliedAt);
  if (data.postedAt          !== undefined) m.posted_at          = safeDate(data.postedAt);
  if (data.priority          !== undefined) m.priority           = data.priority;
  if (data.notes             !== undefined) m.notes              = data.notes;
  if (data.nextSteps         !== undefined) m.next_steps         = data.nextSteps;
  if (data.glassdoorRating   !== undefined) m.glassdoor_rating   = data.glassdoorRating;
  if (data.blindRating       !== undefined) m.blind_rating       = data.blindRating;
  if (data.relevanceScore    !== undefined) m.relevance_score    = data.relevanceScore;
  if (data.relevanceSummary  !== undefined) m.relevance_summary  = data.relevanceSummary;
  return m;
}

function fromDb(row: Record<string, any>): Job {
  return {
    id:               row.id,
    company:          row.company,
    role:             row.role,
    status:           row.status,
    location:         row.location ?? null,
    url:              row.url ?? null,
    salaryBase:       row.salary_base ?? null,
    salaryRsu:        row.salary_rsu ?? null,
    salaryBonus:      row.salary_bonus ?? null,
    salaryTotal:      row.salary_total ?? null,
    rtoDays:          row.rto_days ?? null,
    rtoNotes:         row.rto_notes ?? null,
    source:           row.source ?? null,
    appliedAt:        row.applied_at ?? null,
    priority:         row.priority ?? 2,
    notes:            row.notes ?? null,
    nextSteps:        row.next_steps ?? null,
    glassdoorRating:  row.glassdoor_rating ?? null,
    blindRating:      row.blind_rating ?? null,
    postedAt:         row.posted_at ?? null,
    relevanceScore:   row.relevance_score ?? null,
    relevanceSummary: row.relevance_summary ?? null,
    deletedAt:        row.deleted_at ?? null,
    createdAt:        row.created_at,
  } as Job;
}

// ─── Storage class ────────────────────────────────────────────────────────────

export interface IStorage {
  getJobs(): Promise<Job[]>;
  getDeletedJobs(): Promise<Job[]>;
  getJob(id: number): Promise<Job | undefined>;
  createJob(job: InsertJob): Promise<Job>;
  updateJob(id: number, data: Partial<InsertJob>): Promise<Job | undefined>;
  deleteJob(id: number): Promise<void>;
  restoreJob(id: number): Promise<Job | undefined>;
  hardDeleteJob(id: number): Promise<void>;

  getContactsByJob(jobId: number): Promise<Contact[]>;
  createContact(contact: InsertContact): Promise<Contact>;
  deleteContact(id: number): Promise<void>;

  getActionItemsByJob(jobId: number): Promise<ActionItem[]>;
  createActionItem(item: InsertActionItem): Promise<ActionItem>;
  updateActionItem(id: number, done: boolean): Promise<ActionItem | undefined>;
  deleteActionItem(id: number): Promise<void>;
}

export class Storage implements IStorage {
  // ── Jobs ──────────────────────────────────────────────────────────────────

  async getJobs(): Promise<Job[]> {
    const { data, error } = await supabase.from("jobs").select("*").is("deleted_at", null).order("id");
    if (error) throw error;
    return (data || []).map(fromDb);
  }

  async getDeletedJobs(): Promise<Job[]> {
    const { data, error } = await supabase.from("jobs").select("*").not("deleted_at", "is", null).order("deleted_at", { ascending: false });
    if (error) throw error;
    return (data || []).map(fromDb);
  }

  async getJob(id: number): Promise<Job | undefined> {
    const { data, error } = await supabase.from("jobs").select("*").eq("id", id).single();
    if (error) return undefined;
    return fromDb(data);
  }

  async createJob(job: InsertJob): Promise<Job> {
    const row = toDb(job);
    row.created_at = new Date().toISOString().replace("T", " ").slice(0, 19);

    // Retry up to 20 times if the sequence is behind the max id (duplicate key)
    for (let attempt = 0; attempt < 20; attempt++) {
      const { data, error } = await supabase.from("jobs").insert(row).select().single();
      if (!error) return fromDb(data);

      const isDuplicateKey = error.message?.includes("duplicate key") ||
                             error.code === "23505";
      if (!isDuplicateKey) throw error;

      // Sequence is behind — insert and delete a placeholder to advance it
      const { data: bump } = await supabase
        .from("jobs")
        .insert({ company: "__seq__", role: "__seq__", status: "Interested" })
        .select("id").single();
      if (bump?.id) await supabase.from("jobs").delete().eq("id", bump.id);
    }
    throw new Error("createJob: could not advance sequence after 20 attempts");
  }

  async updateJob(id: number, data: Partial<InsertJob>): Promise<Job | undefined> {
    const row = toDb(data);
    const { data: updated, error } = await supabase
      .from("jobs").update(row).eq("id", id).select().single();
    if (error) return undefined;
    return fromDb(updated);
  }

  async deleteJob(id: number): Promise<void> {
    // Soft delete — just stamp deleted_at
    await supabase.from("jobs").update({
      deleted_at: new Date().toISOString().replace("T", " ").slice(0, 19)
    }).eq("id", id);
  }

  async restoreJob(id: number): Promise<Job | undefined> {
    const { data, error } = await supabase
      .from("jobs").update({ deleted_at: null }).eq("id", id).select().single();
    if (error) return undefined;
    return fromDb(data);
  }

  async hardDeleteJob(id: number): Promise<void> {
    await supabase.from("action_items").delete().eq("job_id", id);
    await supabase.from("contacts").delete().eq("job_id", id);
    await supabase.from("jobs").delete().eq("id", id);
  }

  // ── Contacts ──────────────────────────────────────────────────────────────

  async getContactsByJob(jobId: number): Promise<Contact[]> {
    const { data, error } = await supabase.from("contacts").select("*").eq("job_id", jobId);
    if (error) throw error;
    return (data || []).map(r => ({
      id: r.id, jobId: r.job_id, name: r.name,
      role: r.role ?? null, email: r.email ?? null,
      linkedin: r.linkedin ?? null, notes: r.notes ?? null,
    } as Contact));
  }

  async createContact(contact: InsertContact): Promise<Contact> {
    const { data, error } = await supabase.from("contacts").insert({
      job_id: contact.jobId, name: contact.name, role: contact.role,
      email: contact.email, linkedin: contact.linkedin, notes: contact.notes,
    }).select().single();
    if (error) throw error;
    return { ...data, jobId: data.job_id } as Contact;
  }

  async deleteContact(id: number): Promise<void> {
    await supabase.from("contacts").delete().eq("id", id);
  }

  // ── Action Items ──────────────────────────────────────────────────────────

  async getActionItemsByJob(jobId: number): Promise<ActionItem[]> {
    const { data, error } = await supabase.from("action_items").select("*").eq("job_id", jobId);
    if (error) throw error;
    return (data || []).map(r => ({
      id: r.id, jobId: r.job_id, text: r.text, done: r.done,
      createdAt: r.created_at,
    } as ActionItem));
  }

  async createActionItem(item: InsertActionItem): Promise<ActionItem> {
    const { data, error } = await supabase.from("action_items").insert({
      job_id: item.jobId, text: item.text, done: item.done ?? false,
      created_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    }).select().single();
    if (error) throw error;
    return { ...data, jobId: data.job_id } as ActionItem;
  }

  async updateActionItem(id: number, done: boolean): Promise<ActionItem | undefined> {
    const { data, error } = await supabase
      .from("action_items").update({ done }).eq("id", id).select().single();
    if (error) return undefined;
    return { ...data, jobId: data.job_id } as ActionItem;
  }

  async deleteActionItem(id: number): Promise<void> {
    await supabase.from("action_items").delete().eq("id", id);
  }
}

export const storage = new Storage();
