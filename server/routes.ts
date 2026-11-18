import type { Express } from "express";
import { Server } from "http";
import { readFileSync } from "node:fs";
import { storage } from "./storage";
import { insertJobSchema, insertContactSchema, insertActionItemSchema } from "@shared/schema";

export function registerRoutes(httpServer: Server, app: Express) {
  // ── Jobs ──────────────────────────────────────────────────────────────
  app.get("/api/jobs", async (_req, res) => {
    res.json(await storage.getJobs());
  });

  app.get("/api/jobs/:id", async (req, res) => {
    const job = await storage.getJob(parseInt(req.params.id));
    if (!job) return res.status(404).json({ error: "Not found" });
    res.json(job);
  });

  app.post("/api/jobs", async (req, res) => {
    const parsed = insertJobSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const job = await storage.createJob(parsed.data);
    // Fire-and-forget: auto-fetch Blind rating in background
    if (job.company && !job.blindRating) {
      (async () => {
        try {
          const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
          const slug = job.company.replace(/[^a-zA-Z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
          const r = await fetch(`https://www.teamblind.com/company/${slug}`, {
            headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
            signal: AbortSignal.timeout(8000),
            redirect: "follow",
          });
          const html = await r.text();
          const jldMatches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>(.*?)<\/script>/gs);
          for (const m of jldMatches) {
            try {
              const d = JSON.parse(m[1]);
              if (d["@type"] === "EmployerAggregateRating" && d.ratingValue) {
                const v = parseFloat(d.ratingValue);
                if (v >= 1 && v <= 5) {
                  await storage.updateJob(job.id, { blindRating: v.toFixed(1) });
                  break;
                }
              }
            } catch { /* skip */ }
          }
        } catch { /* silent fail */ }
      })();
    }
    // Fire-and-forget: auto-score relevance in background
    if (job.role) {
      (async () => {
        try {
          // Use notes from parse-job if already populated (avoids re-fetching)
          let description = job.notes || "";
          // Only attempt a page fetch if we don't already have a useful description
          if (job.url && description.length < 200) {
            try {
              // Check for Greenhouse URLs first — reliable structured data, fast
              const ghJid  = job.url.match(/[?&]gh_jid=(\d+)/)?.[1];
              const ghPath = job.url.match(/greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
              if (ghJid || ghPath) {
                let boardSlug = "", jobId = "";
                if (ghPath) { boardSlug = ghPath[1]; jobId = ghPath[2]; }
                else if (ghJid) { boardSlug = job.url.match(/\/\/(?:www\.)?([a-z0-9-]+)\./i)?.[1] ?? ""; jobId = ghJid; }
                if (boardSlug && jobId) {
                  const ghRes = await fetch(`https://boards-api.greenhouse.io/v1/boards/${boardSlug}/jobs/${jobId}`, { signal: AbortSignal.timeout(8000) });
                  if (ghRes.ok) {
                    const ghData = await ghRes.json() as Record<string, unknown>;
                    const ghContent = (ghData.content as string) ?? "";
                    description = ghContent.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
                  }
                }
              }
              // Fall back to HTML fetch if still no description
              if (description.length < 200) {
                const pageRes = await fetch(job.url, {
                  headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
                  signal: AbortSignal.timeout(8000),
                });
                const html = await pageRes.text();
                description = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
              }
            } catch { /* URL fetch failed — score with role/company only */ }
          }
          const result = await scoreRelevance(job.role, job.company || "", description);
          if (result) await storage.updateJob(job.id, { relevanceScore: result.score, relevanceSummary: result.summary });
        } catch { /* silent fail */ }
      })();
    }
    res.status(201).json(job);
  });

  app.patch("/api/jobs/:id", async (req, res) => {
    const parsed = insertJobSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const updated = await storage.updateJob(parseInt(req.params.id), parsed.data);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });

  app.delete("/api/jobs/:id", async (req, res) => {
    await storage.deleteJob(parseInt(req.params.id));
    res.status(204).send();
  });

  app.get("/api/jobs/deleted", async (_req, res) => {
    res.json(await storage.getDeletedJobs());
  });

  app.post("/api/jobs/:id/restore", async (req, res) => {
    const restored = await storage.restoreJob(parseInt(req.params.id));
    if (!restored) return res.status(404).json({ error: "Not found" });
    res.json(restored);
  });

  // ── Contacts ──────────────────────────────────────────────────────────
  app.get("/api/jobs/:id/contacts", async (req, res) => {
    res.json(await storage.getContactsByJob(parseInt(req.params.id)));
  });

  app.post("/api/contacts", async (req, res) => {
    const parsed = insertContactSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    res.status(201).json(await storage.createContact(parsed.data));
  });

  app.delete("/api/contacts/:id", async (req, res) => {
    await storage.deleteContact(parseInt(req.params.id));
    res.status(204).send();
  });

  // ── Action Items ──────────────────────────────────────────────────────
  app.get("/api/jobs/:id/actions", async (req, res) => {
    res.json(await storage.getActionItemsByJob(parseInt(req.params.id)));
  });

  app.post("/api/actions", async (req, res) => {
    const parsed = insertActionItemSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    res.status(201).json(await storage.createActionItem(parsed.data));
  });

  app.patch("/api/actions/:id", async (req, res) => {
    const { done } = req.body;
    const updated = await storage.updateActionItem(parseInt(req.params.id), Boolean(done));
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });

  app.delete("/api/actions/:id", async (req, res) => {
    await storage.deleteActionItem(parseInt(req.params.id));
    res.status(204).send();
  });

  // ── Parse Job Posting URL ─────────────────────────────────────────────
  app.post("/api/parse-job", async (req, res) => {
    const { url } = req.body as { url?: string };
    if (!url) return res.status(400).json({ error: "url required" });

    try {
      // ── Greenhouse fast-path ──────────────────────────────────────────────
      // URLs like sofi.com/careers/job/?gh_jid=123 or job-boards.greenhouse.io/company/jobs/123
      // are JS-rendered wrappers — fetch the Greenhouse Jobs API directly instead.
      const ghJid  = url.match(/[?&]gh_jid=(\d+)/)?.[1];
      const ghPath = url.match(/greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
      const ghIds  = greenhouseIds(url);
      if (ghJid || ghPath || ghIds) {
        // Derive board slug + job id
        let boardSlug = "", jobId = "";
        if (ghIds) {
          [boardSlug, jobId] = ghIds;
        } else if (ghPath) {
          boardSlug = ghPath[1]; jobId = ghPath[2];
        } else if (ghJid) {
          // Board slug lives in the hostname or path — e.g. sofi.com → "sofi"
          const hostSlug = url.match(/\/\/(?:www\.)?([a-z0-9-]+)\./i)?.[1] ?? "";
          boardSlug = hostSlug; jobId = ghJid;
        }
        if (boardSlug && jobId) {
          try {
            const ghRes = await fetch(
              `https://boards-api.greenhouse.io/v1/boards/${boardSlug}/jobs/${jobId}`,
              { signal: AbortSignal.timeout(8000) }
            );
            if (ghRes.ok) {
              const ghData = await ghRes.json() as Record<string, unknown>;
              const ghTitle    = (ghData.title as string) ?? "";
              const ghLoc      = (ghData.location as { name?: string })?.name ?? "";
              const ghContent  = (ghData.content as string) ?? "";
              const ghNotes    = ghContent.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim().slice(0, 2000);
              // Company name: top-level company_name field is most reliable
              const ghCompany  = (ghData.company_name as string)
                ?? boardSlug.charAt(0).toUpperCase() + boardSlug.slice(1);
              // Salary: check metadata for Pay Range, then fall back to content text
              let ghSalaryBase = "";
              const ghMeta = (ghData.metadata as Array<{name:string,value:unknown}>) ?? [];
              const payRange = ghMeta.find(m => m.name === "Pay Range" || m.name === "Pay Transparency Range");
              if (payRange) {
                if (typeof payRange.value === "string") ghSalaryBase = payRange.value;
                else if (payRange.value && typeof payRange.value === "object") {
                  const v = payRange.value as {min_value?:string,max_value?:string,unit?:string};
                  if (v.min_value && v.max_value) ghSalaryBase = `$${Number(v.min_value).toLocaleString()} - $${Number(v.max_value).toLocaleString()}`;
                }
              }
              if (!ghSalaryBase) {
                // Fallback: extract from the full job description text (e.g. Figma's
                // "Annual Base Salary Range: $169,000 - $303,000 USD" format).
                // Some boards (e.g. Figma) double-encode their content: "<p>" instead of "<p>",
                // so unescape entities FIRST, then strip tags, then collapse whitespace.
                const ghText = ghContent
                  .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
                  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
                  .replace(/&amp;/g, "&")
                  .replace(/&mdash;|&ndash;/g, "-").replace(/&nbsp;/g, " ")
                  .replace(/<[^>]+>/g, " ")
                  .replace(/&[a-z]+;/gi, " ")
                  .replace(/\s+/g, " ");
                const rangeMatch = ghText.match(
                  /(?:base salary|salary|pay)\s*range\s*:?\s*(\$[\d,]+)\s*(?:to|-|–|—)?\s*(\$[\d,]+)/i
                );
                if (rangeMatch) ghSalaryBase = `${rangeMatch[1]} - ${rangeMatch[2]}`;
              }
              // Posted date
              const ghPosted = await firstPublishedDate(url, ghData.first_published as string);
              return res.json({
                role:        ghTitle,
                company:     ghCompany,
                location:    ghLoc,
                salaryBase:  ghSalaryBase,
                salaryRsu:   "",
                salaryBonus: "",
                salaryTotal: "",
                rtoDays:     null,
                rtoNotes:    "",
                source:      "Greenhouse",
                postedAt:    ghPosted,
                notes:       ghNotes,
                raw:         ghNotes.slice(0, 300),
              });
            }
          } catch { /* fall through to normal fetch */ }
        }
      }
      // ── Normal HTML fetch ─────────────────────────────────────────────────
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        return res.status(422).json({ error: `Could not fetch URL (${response.status})` });
      }

      const html = await response.text();

      const text = html
        .replace(/<script[^>]*>.*?<\/script>/gis, " ")
        .replace(/<style[^>]*>.*?<\/style>/gis, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ").trim();

      const titleTagMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const pageTitle = titleTagMatch ? titleTagMatch[1].replace(/\s+/g, " ").trim() : "";

      let structuredRole = "", structuredCompany = "", structuredLocation = "";
      let structuredSalaryMin = "", structuredSalaryMax = "";
      let structuredDescription = "", structuredPostedAt = "";

      const jsonLdMatches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>(.*?)<\/script>/gis);
      for (const m of jsonLdMatches) {
        try {
          const data = JSON.parse(m[1]);
          const jobs = Array.isArray(data) ? data : [data];
          for (const item of jobs) {
            if (item["@type"] === "JobPosting" || item.title) {
              structuredRole = item.title || item.jobTitle || "";
              structuredCompany = item.hiringOrganization?.name || item.employer?.name || "";
              const loc = item.jobLocation?.[0] || item.jobLocation || {};
              const addr = loc.address || {};
              structuredLocation = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean).join(", ");
              const wage = item.baseSalary || item.estimatedSalary || {};
              const val = wage.value || {};
              structuredSalaryMin = val.minValue ? String(val.minValue) : "";
              structuredSalaryMax = val.maxValue ? String(val.maxValue) : val.value ? String(val.value) : "";
              structuredDescription = item.description ? item.description.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000) : "";
              if (item.datePosted) structuredPostedAt = item.datePosted.slice(0, 10);
              break;
            }
          }
        } catch (_) {}
      }

      let role = structuredRole;
      if (!role) {
        const metaTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
          || html.match(/<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)["']/i);
        if (metaTitle) role = metaTitle[1];
      }
      if (!role && pageTitle) {
        role = pageTitle;
      }
      // Clean role: strip company branding, location suffixes, and site suffixes from any source
      if (role) {
        role = role
          .replace(/\s*[-–—|]\s*.{2,40}(careers?|jobs?|hiring).*$/i, "")  // "- Unity Careers", "| OpenAI Jobs"
          .replace(/\s*[|]\s*[A-Z][^|]+$/i, "")                           // "| OpenAI"
          .replace(/,?\s*(san francisco|new york|seattle|austin|remote|ca,\s*usa|ny|wa|los angeles|chicago|denver|boston)[,\s][^|,]*/gi, "") // strip location+trailing
          .replace(/,?\s*\busa\b.*$/i, "") // strip trailing ", USA" or "USA"
          .trim();
        // Strip trailing "- Company Name" only if it looks like a company name:
        // 1-3 words, no common English words (serve, business, growth, etc)
        const trailingDash = role.match(/\s*[-–—]\s*([A-Z][a-zA-Z0-9 .'&]{1,30})$/);
        if (trailingDash) {
          const candidate = trailingDash[1].trim();
          const words = candidate.split(/\s+/);
          const commonWords = /^(serve|business|growth|lead|manager|director|engineer|analyst|senior|junior|staff|principal|associate|head|vp|global|regional|technical|digital|data|product|solutions|platform|operations|services|systems|strategy|development)$/i;
          const hasCommonWord = words.some(w => commonWords.test(w));
          if (!hasCommonWord && words.length <= 3) {
            role = role.replace(/\s*[-–—]\s*[A-Z][a-zA-Z0-9 .'&]{1,30}$/, "").trim();
          }
        }
      }

      let company = structuredCompany;
      if (!company) {
        const metaCompany = html.match(/"hiringOrganization"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/i)
          || html.match(/data-company=["']([^"']+)["']/i)
          || html.match(/company-name["']?[^>]*>([^<]{2,60})</i);
        if (metaCompany) company = metaCompany[1];
      }
      // Extract company from page title patterns: "Role | Company", "Role - Company Careers", "Role at Company"
      if (!company && pageTitle) {
        const pipeMatch = pageTitle.match(/[|]\s*([A-Za-z][A-Za-z0-9 .,'&-]{1,40})$/);
        const dashCareersMatch = pageTitle.match(/-\s*([A-Za-z][A-Za-z0-9 .,'&-]{1,30})\s+Careers?\s*$/i);
        const atMatch = pageTitle.match(/ at ([A-Z][^|\-–]+?)(?:\s*[|\-–]|$)/i);
        if (pipeMatch) company = pipeMatch[1].trim();
        else if (dashCareersMatch) company = dashCareersMatch[1].trim();
        else if (atMatch) company = atMatch[1].trim();
      }
      // Also check og:site_name and og:description for company
      if (!company) {
        const siteName = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)
          || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i);
        if (siteName) company = siteName[1].trim();
      }

      let location = structuredLocation;
      if (!location) {
        const locPatterns = [
          /location["']?\s*:?\s*["']?([A-Za-z\s]+,\s*[A-Z]{2})["']?/i,
          /([A-Za-z\s]{3,30},\s*(?:CA|NY|WA|TX|MA|IL|CO|FL|GA|AZ|OR|NJ|MN|OH|PA|VA|NC|DC))/,
          /(Remote|Hybrid|San Francisco|New York|Seattle|Austin|Boston|Chicago|Los Angeles|Denver)/i,
        ];
        for (const pat of locPatterns) {
          const m = text.match(pat);
          if (m) { location = m[1].trim(); break; }
        }
      }

      let salaryBase = "", salaryRsu = "", salaryBonus = "", salaryTotal = "";
      if (structuredSalaryMin || structuredSalaryMax) {
        const fmt = (v: string) => {
          const n = parseFloat(v);
          if (!n) return v;
          return n >= 1000 ? "$" + Math.round(n).toLocaleString() : "$" + n + "/hr";
        };
        salaryBase = structuredSalaryMin && structuredSalaryMax
          ? `${fmt(structuredSalaryMin)} – ${fmt(structuredSalaryMax)}`
          : fmt(structuredSalaryMax || structuredSalaryMin);
      } else {
        const salaryPatterns = [
          /(\$[\d,]+(?:\.\d+)?[Kk]?\s*[-–—to]+\s*\$[\d,]+(?:\.\d+)?[Kk]?\s*(?:\/yr|\/year|per year|annually|annual)?)/i,
          /(\$[\d,]+(?:\.\d+)?[Kk]?\s*(?:per year|\/yr|annually|annual base salary))/i,
          /(?:base salary|base pay|salary range)\s*:?\s*(\$[\d,K]+(?:\s*[-–]\s*\$[\d,K]+)?)/i,
          // Multi-line stacked format (e.g. Figma): "Annual Base Salary Range:" \n "$169,000" \n "$303,000 USD"
          /(?:base salary|salary|pay)\s*range\s*:?\s*\n?\s*(\$[\d,]+)\s*\n?\s*(?:to|-|–)?\s*\n?\s*(\$[\d,]+)/i,
        ];
        for (const pat of salaryPatterns) {
          const m = text.match(pat);
          if (m) {
            // Multi-line pattern returns two capture groups — join them into a range
            if (m[2] && m[1] && !m[0].includes("-") && !m[0].includes("–")) {
              salaryBase = `${m[1]} - ${m[2]}`;
            } else {
              salaryBase = (m[1] || m[0]).trim();
            }
            break;
          }
        }
      }

      const rsuPatterns = [
        /(?:RSU|equity|stock|restricted stock)[^.]{0,60}(\$[\d,K]+(?:\s*[-–]\s*\$[\d,K]+)?(?:\/yr|\/year|over \d years?)?)/i,
        /(\$[\d,K]+(?:\s*[-–]\s*\$[\d,K]+)?\s*(?:in equity|in RSUs|in stock))/i,
      ];
      for (const pat of rsuPatterns) {
        const m = text.match(pat);
        if (m) { salaryRsu = m[1].trim(); break; }
      }

      const bonusPatterns = [
        /(?:target bonus|annual bonus|performance bonus)[^.]{0,60}(\d+(?:\.\d+)?%)/i,
        /(\d+(?:\.\d+)?%\s*(?:target|annual|performance)\s*bonus)/i,
        /bonus[^.]{0,40}(\$[\d,K]+)/i,
      ];
      for (const pat of bonusPatterns) {
        const m = text.match(pat);
        if (m) { salaryBonus = m[1].trim(); break; }
      }

      let rtoDays: number | null = null;
      let rtoNotes = "";
      const rtoPatterns: Array<[RegExp, number, string]> = [
        [/fully remote|100%\s*remote|remote[-\s]first|work from anywhere/i, 0, "Fully remote"],
        [/(\d)\s*days?(?:\s*(?:per|a|each)\s*week|\/week)?\s*(?:in[-\s]?office|on[-\s]?site|in[-\s]?person|from the office|hybrid)/i, -1, ""],
        [/(?:in[-\s]?office|from the office|on[-\s]?site|in[-\s]?person|hybrid)[^.\n]{0,80}?(\d)\s*days?/i, -1, ""],
        [/(?:expected to work|work from|come into|in the office)[^.\n]{0,80}?(\d)\s*days?(?:\s*(?:per|a|each)\s*week|\/week)/i, -1, ""],
        [/hybrid[^.\n]{0,80}?(\d)\s*days?/i, -1, ""],
        [/on[-\s]?site|fully on[-\s]?site|100%\s*(?:in[-\s]?office|on[-\s]?site)/i, 5, "Fully on-site"],
      ];
      for (const [pat, days, note] of rtoPatterns) {
        const m = text.match(pat);
        if (m) {
          if (days === -1) {
            const d = parseInt(m[1] || m[2] || "3");
            rtoDays = isNaN(d) ? null : d;
            rtoNotes = `${rtoDays} day${rtoDays !== 1 ? "s" : ""}/week (from job description)`;
          } else {
            rtoDays = days;
            rtoNotes = note;
          }
          break;
        }
      }

      let postedAt = structuredPostedAt;
      if (!postedAt) {
        const metaDate = html.match(/<meta[^>]+(?:published_time|datePublished|date)["'][^>]+content=["']([\d]{4}-[\d]{2}-[\d]{2})/i)
          || html.match(/<meta[^>]+content=["']([\d]{4}-[\d]{2}-[\d]{2})["'][^>]+(?:published|date)/i)
          || html.match(/"datePosted"\s*:\s*"([\d]{4}-[\d]{2}-[\d]{2})/i);
        if (metaDate) postedAt = metaDate[1];
      }
      if (!postedAt) {
        const textDatePatterns = [
          /(?:posted(?:\s+on)?|date posted|job posted)[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i,
          /(?:posted(?:\s+on)?|date posted)[:\s]+([\d]{1,2}\/[\d]{1,2}\/[\d]{4})/i,
          /(?:posted(?:\s+on)?|date posted)[:\s]+([\d]{4}-[\d]{2}-[\d]{2})/i,
        ];
        for (const pat of textDatePatterns) {
          const m = text.match(pat);
          if (m) {
            try {
              const d = new Date(m[1]);
              if (!isNaN(d.getTime())) { postedAt = d.toISOString().slice(0, 10); break; }
            } catch {}
          }
        }
      }
      // Keep the earliest known publish date (ATS original date, first archive
      // capture, or the date shown on the page) rather than a refreshed repost date.
      postedAt = await firstPublishedDate(url, postedAt);

      let source = "";
      if (url.includes("linkedin.com")) source = "LinkedIn";
      else if (url.includes("lever.co")) source = "Lever";
      else if (url.includes("greenhouse.io") || url.includes("boards.greenhouse")) source = "Greenhouse";
      else if (url.includes("workday") || url.includes("myworkdayjobs")) source = "Workday";
      else if (url.includes("icims.com")) source = "iCIMS";
      else if (url.includes("smartrecruiters")) source = "SmartRecruiters";
      else if (url.includes("indeed.com")) source = "Indeed";
      else if (url.includes("glassdoor.com")) source = "Glassdoor";
      else if (url.includes("careers.") || url.includes("/careers/") || url.includes("/jobs/")) source = "Company website";

      res.json({
        role: role.slice(0, 120),
        company: company.slice(0, 100),
        location,
        salaryBase,
        salaryRsu,
        salaryBonus,
        salaryTotal,
        rtoDays,
        rtoNotes,
        source,
        postedAt: postedAt || null,
        notes: structuredDescription.slice(0, 500),
        raw: text.slice(0, 300),
      });
    } catch (err: any) {
      res.status(422).json({ error: err?.message || "Failed to parse URL" });
    }
  });

  // ── Resume text for relevance scoring ────────────────────────────────
  // Optional private file, never committed or bundled into the client.
  const RESUME_TEXT = process.env.RESUME_FILE
    ? readFileSync(process.env.RESUME_FILE, "utf8").trim()
    : "";

  const scoreRelevance = async (jobTitle: string, jobCompany: string, jobDescription: string): Promise<{ score: number; summary: string } | null> => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || !RESUME_TEXT) return null;
    const prompt = `You are a strict, critical recruiter scoring a candidate's resume against a specific job posting.
Evaluate only the supplied candidate evidence. Reserve 85+ for near-perfect matches.

CANDIDATE RESUME:
${RESUME_TEXT}

JOB: ${jobTitle} at ${jobCompany}
JOB DESCRIPTION:
${jobDescription.slice(0, 3000)}

---
STEP 1 — Score each dimension 0–20. Be brutally honest. Show your work.

A. DOMAIN MATCH (0–20)
Does the candidate's demonstrated domain experience match what this role needs?
- 18–20: Exact domain match supported by the resume
- 13–17: Significant overlap supported by the resume
- 8–12: Partial overlap; core domain concepts would need to be learned
- 3–7: Adjacent but meaningfully different domain (e.g., healthcare PM, legal tech, infra)
- 0–2: Completely different domain

B. INDUSTRY / COMPANY FIT (0–20)
Does the company type and industry match the candidate's background?
- 18–20: Same vertical
- 13–17: Adjacent industry with clear transferability
- 8–12: Different but plausible fit
- 3–7: Significant industry mismatch
- 0–2: Completely mismatched industry

C. SENIORITY / SCOPE FIT (0–20)
Does the role's expected scope, autonomy and impact level match the candidate's demonstrated experience?
- 18–20: Strong level match supported by evidence
- 13–17: Slight stretch or slight under-level
- 8–12: Meaningful scope or seniority mismatch
- 3–7: Clear gap in management or specialization evidence
- 0–2: Wrong level entirely

D. TECHNICAL / HARD SKILL MATCH (0–20)
Does the candidate have the specific technical skills this role explicitly requires?
- 18–20: All key technical requirements met (analytics tools, APIs, data infra, specific platforms)
- 13–17: Most requirements met, one gap
- 8–12: Some overlap but clear hard skill gaps called out in JD
- 3–7: Minimal technical match; required skills are not demonstrated
- 0–2: Hard requirements are not met

E. IMPACT EVIDENCE (0–20)
Can the candidate point to quantified impact relevant to this role's success metrics?
- 18–20: Strong, specific, quantified results matching this role's KPIs (e.g., revenue, retention, conversion)
- 13–17: Good quantified results, slightly different metric type
- 8–12: Some quantified results but mostly in different areas
- 3–7: Thin or generic impact evidence for this specific role
- 0–2: No relevant impact evidence

---
STEP 2 — Sum the five scores. That is the final score (0–100).

STEP 3 — Write a 2-sentence summary: the strongest reason the candidate should apply, and the biggest evidence gap.

Respond with ONLY valid JSON (no markdown, no explanation outside the JSON):
{
  "a": <0-20>,
  "b": <0-20>,
  "c": <0-20>,
  "d": <0-20>,
  "e": <0-20>,
  "score": <sum of a+b+c+d+e>,
  "summary": "<strength>. <gap>."
}`;

    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-4o", messages: [{ role: "user", content: prompt }], temperature: 0.3, max_tokens: 400 }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await r.json();
      const rawText = data.choices?.[0]?.message?.content?.trim() ?? "";
      // Strip markdown code fences if present (gpt-4o sometimes wraps in ```json ... ```)
      const text = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
      const parsed = JSON.parse(text);
      // Accept both dimension-based and legacy formats
      let finalScore: number;
      if (typeof parsed.a === "number" && typeof parsed.b === "number") {
        finalScore = Math.round(parsed.a + parsed.b + parsed.c + parsed.d + parsed.e);
      } else if (typeof parsed.score === "number") {
        finalScore = Math.round(parsed.score);
      } else {
        return null;
      }
      if (typeof parsed.summary === "string") {
        return { score: Math.max(0, Math.min(100, finalScore)), summary: parsed.summary };
      }
    } catch {}
    return null;
  };

  app.post("/api/score-job/:id", async (req, res) => {
    const job = await storage.getJob(Number(req.params.id));
    if (!job) return res.status(404).json({ error: "Not found" });
    let description = job.notes || "";
    if (job.url && description.length < 200) {
      try {
        // Prefer Greenhouse API for gh_jid URLs — avoids JS-rendered page failures
        const ghJid  = job.url.match(/[?&]gh_jid=(\d+)/)?.[1];
        const ghPath = job.url.match(/greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
        if (ghJid || ghPath) {
          let boardSlug = "", jobId = "";
          if (ghPath) { boardSlug = ghPath[1]; jobId = ghPath[2]; }
          else if (ghJid) { boardSlug = job.url.match(/\/\/(?:www\.)?([a-z0-9-]+)\./i)?.[1] ?? ""; jobId = ghJid; }
          if (boardSlug && jobId) {
            const ghRes = await fetch(`https://boards-api.greenhouse.io/v1/boards/${boardSlug}/jobs/${jobId}`, { signal: AbortSignal.timeout(8000) });
            if (ghRes.ok) {
              const ghData = await ghRes.json() as Record<string, unknown>;
              const ghContent = (ghData.content as string) ?? "";
              description = ghContent.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
            }
          }
        }
        if (description.length < 200) {
          const pageRes = await fetch(job.url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" }, signal: AbortSignal.timeout(8000) });
          const html = await pageRes.text();
          description = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
        }
      } catch { /* score with what we have */ }
    }
    const result = await scoreRelevance(job.role || "", job.company || "", description);
    if (!result) return res.status(500).json({ error: "Scoring unavailable" });
    await storage.updateJob(job.id, { relevanceScore: result.score, relevanceSummary: result.summary });
    res.json(result);
  });

  // ── Ratings Lookup ────────────────────────────────────────────────────
  app.get("/api/lookup-ratings", async (req, res) => {
    const { company } = req.query as { company?: string };
    if (!company) return res.status(400).json({ error: "company required" });
    const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

    const fetchBlindRating = async () => {
      const slug = company.replace(/[^a-zA-Z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
      try {
        const r = await fetch(`https://www.teamblind.com/company/${slug}`, {
          headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
          signal: AbortSignal.timeout(8000), redirect: "follow",
        });
        const html = await r.text();
        const jldMatches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>(.*?)<\/script>/gs);
        for (const m of jldMatches) {
          try {
            const d = JSON.parse(m[1]);
            if (d["@type"] === "EmployerAggregateRating" && d.ratingValue) {
              const v = parseFloat(d.ratingValue);
              if (v >= 1 && v <= 5) return { rating: v.toFixed(1), url: `https://www.teamblind.com/company/${slug}` };
            }
          } catch {}
        }
        return { rating: null, url: `https://www.teamblind.com/company/${slug}` };
      } catch {
        return { rating: null, url: `https://www.teamblind.com/search?q=${encodeURIComponent(company)}` };
      }
    };

    try {
      const blind = await fetchBlindRating();
      res.json({
        glassdoor: { rating: null, blocked: true, url: `https://www.glassdoor.com/Search/results.htm?keyword=${encodeURIComponent(company)}`, snippets: [] },
        blind: { rating: blind.rating, blocked: false, url: blind.url, snippets: [] },
      });
    } catch {
      res.status(500).json({ error: "Lookup failed" });
    }
  });

  // ── RTO Lookup ────────────────────────────────────────────────────────
  app.get("/api/rto-lookup", async (req, res) => {
    const { company, role } = req.query as { company?: string; role?: string };
    if (!company) return res.status(400).json({ error: "company required" });
    try {
      const query = encodeURIComponent(`${company} ${role ?? ""} return to office policy RTO days per week 2024 2025`);
      const response = await fetch(`https://html.duckduckgo.com/html/?q=${query}`, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; tabless/1.0)", Accept: "text/html" },
      });
      const html = await response.text();
      const snippets: string[] = [];
      for (const m of html.matchAll(/<a class="result__snippet"[^>]*>(.*?)<\/a>/gs)) {
        const clean = m[1].replace(/<[^>]+>/g, "").trim();
        if (clean) snippets.push(clean);
        if (snippets.length >= 5) break;
      }
      const titles: string[] = [];
      for (const m of html.matchAll(/<a class="result__a"[^>]*>(.*?)<\/a>/gs)) {
        const clean = m[1].replace(/<[^>]+>/g, "").trim();
        if (clean) titles.push(clean);
        if (titles.length >= 5) break;
      }
      res.json({ snippets, titles });
    } catch {
      res.status(500).json({ error: "Lookup failed" });
    }
  });
}

// ── First-published date ─────────────────────────────────────────────────
// "Date Posted" is the earliest known date the posting URL was published.
// Job boards often refresh their visible "posted" date when a role is reposted,
// so we gather every available signal and keep the earliest one:
//   • ATS APIs: Greenhouse first_published, Ashby publishedDate,
//     Lever createdAt, Workday startDate
//   • Earliest Wayback Machine capture of the posting URL
//   • Any date already found on the page (JSON-LD datePosted, meta tags)
const isoDay = (v: unknown): string => {
  if (!v) return "";
  const d = new Date(typeof v === "number" ? v : String(v));
  return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
};

async function fetchJson(url: string, init: RequestInit = {}, ms = 8000): Promise<any | null> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function greenhouseIds(url: string): [string, string] | null {
  const path = url.match(/greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/);
  if (path) return [path[1], path[2]];
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const q = u.searchParams;
  if (u.pathname.includes("/embed/job_app") && q.get("for") && q.get("token")) return [q.get("for")!, q.get("token")!];
  const jid = q.get("gh_jid");
  if (!jid) return null;
  const careerpuck = u.pathname.match(/job-board\/([^/]+)\//);
  if (careerpuck) return [careerpuck[1], jid];
  const slug = u.hostname.replace(/^www\./, "").split(".")[0];
  return [slug, jid];
}

async function atsPublishedDate(url: string): Promise<string> {
  const gh = greenhouseIds(url);
  if (gh) {
    const d = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${gh[0]}/jobs/${gh[1]}`);
    return isoDay(d?.first_published);
  }
  const ashby = url.match(/jobs\.ashbyhq\.com\/([^/]+)\/([0-9a-f-]{36})/i);
  if (ashby) {
    const d = await fetchJson("https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operationName: "ApiJobPosting",
        variables: { organizationHostedJobsPageName: decodeURIComponent(ashby[1]), jobPostingId: ashby[2] },
        query: "query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) { jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) { publishedDate } }",
      }),
    });
    return isoDay(d?.data?.jobPosting?.publishedDate);
  }
  const lever = url.match(/jobs\.lever\.co\/([^/]+)\/([0-9a-f-]{36})/i);
  if (lever) {
    const d = await fetchJson(`https://api.lever.co/v0/postings/${lever[1]}/${lever[2]}`);
    return isoDay(d?.createdAt);
  }
  const wd = url.match(/^https?:\/\/([^.]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/]+)(\/job\/[^?#]+)/);
  if (wd) {
    const d = await fetchJson(`https://${wd[1]}.${wd[2]}.myworkdayjobs.com/wday/cxs/${wd[1]}/${wd[3]}${wd[4]}`, { headers: { Accept: "application/json" } });
    return isoDay(d?.jobPostingInfo?.startDate);
  }
  const wds = url.match(/^https?:\/\/(wd\d+)\.myworkdaysite\.com\/recruiting\/([^/]+)\/([^/]+)\/details\/([^?#]+)/);
  if (wds) {
    const d = await fetchJson(`https://${wds[1]}.myworkdaysite.com/wday/cxs/${wds[2]}/${wds[3]}/job/${wds[4]}`, { headers: { Accept: "application/json" } });
    return isoDay(d?.jobPostingInfo?.startDate);
  }
  return "";
}

async function waybackFirstCapture(url: string): Promise<string> {
  let u: URL;
  try { u = new URL(url); } catch { return ""; }
  const keep = new URLSearchParams();
  for (const k of ["id", "gh_jid", "for", "token"]) { const v = u.searchParams.get(k); if (v) keep.set(k, v); }
  const key = u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/application\/?$/, "") + (keep.toString() ? `?${keep}` : "");
  // The availability API returns the snapshot closest to the timestamp; asking
  // for 1996 yields the earliest capture. It is much faster than the CDX search.
  const params = new URLSearchParams({ url: key, timestamp: "19960101" });
  const d = await fetchJson(`https://archive.org/wayback/available?${params}`, {}, 8000);
  const snap = d?.archived_snapshots?.closest;
  const t: string | undefined = snap && String(snap.status) === "200" ? snap.timestamp : undefined;
  return t ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : "";
}

export async function firstPublishedDate(url: string, ...known: Array<string | null | undefined>): Promise<string> {
  const [ats, wayback] = await Promise.all([atsPublishedDate(url), waybackFirstCapture(url)]);
  const today = new Date().toISOString().slice(0, 10);
  const dates = [ats, wayback, ...known.map(isoDay)].filter(d => d && d <= today).sort();
  return dates[0] ?? "";
}
