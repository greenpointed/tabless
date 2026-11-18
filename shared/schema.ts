import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const JOB_STATUSES = [
  "Interested",
  "Applied",
  "Phone Screen",
  "Interview",
  "Offer",
  "Rejected",
  "Withdrawn",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const jobs = sqliteTable("jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  company: text("company").notNull(),
  role: text("role").notNull(),
  status: text("status").notNull().default("Interested"),
  location: text("location"),
  url: text("url"),

  // Compensation breakdown
  salaryBase: text("salary_base"),         // e.g. "$160,000"
  salaryRsu: text("salary_rsu"),           // e.g. "$50,000/yr"
  salaryBonus: text("salary_bonus"),       // e.g. "15% target"
  salaryTotal: text("salary_total"),       // e.g. "$230,000"

  // Office policy
  rtoDays: integer("rto_days"),            // days/week in-office; null = unknown
  rtoNotes: text("rto_notes"),             // e.g. "3 days flex, Tue/Wed/Thu"

  // Meta
  source: text("source"),
  appliedAt: text("applied_at"),
  priority: integer("priority").notNull().default(2), // 1=High, 2=Med, 3=Low

  // Free-form notes fields
  notes: text("notes"),                    // general notes
  nextSteps: text("next_steps"),           // what to do next (free text)

  // Review ratings
  glassdoorRating: text("glassdoor_rating"),  // e.g. "3.8"
  blindRating: text("blind_rating"),          // e.g. "3.2"

  // Job posting date (from page, not tracker)
  postedAt: text("posted_at"),               // ISO date string, e.g. "2026-03-15"
  deletedAt: text("deleted_at"),             // null = active, timestamp = soft-deleted

  // Resume relevance scoring
  relevanceScore: integer("relevance_score"),   // 0–100
  relevanceSummary: text("relevance_summary"),   // 1–2 sentence rationale

  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});

export const insertJobSchema = createInsertSchema(jobs).omit({
  id: true,
  createdAt: true,
});

export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobs.$inferSelect;

// Action items per job (checklist)
export const actionItems = sqliteTable("action_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("job_id").notNull(),
  text: text("text").notNull(),
  done: integer("done").notNull().default(0),  // 0=open, 1=done
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});

export const insertActionItemSchema = createInsertSchema(actionItems).omit({ id: true, createdAt: true });
export type InsertActionItem = z.infer<typeof insertActionItemSchema>;
export type ActionItem = typeof actionItems.$inferSelect;

// Contacts per job
export const contacts = sqliteTable("contacts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("job_id").notNull(),
  name: text("name").notNull(),
  role: text("role"),
  email: text("email"),
  linkedin: text("linkedin"),
  notes: text("notes"),
});

export const insertContactSchema = createInsertSchema(contacts).omit({ id: true });
export type InsertContact = z.infer<typeof insertContactSchema>;
export type Contact = typeof contacts.$inferSelect;
