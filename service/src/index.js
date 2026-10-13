/**
 * Railway render service.
 *
 *   GET  /health                  liveness + what the container actually has
 *   POST /jobs                    multipart photos[] + facts JSON -> { jobId }
 *   GET  /jobs                    recent jobs
 *   GET  /jobs/:id                full job JSON
 *   GET  /jobs/:id/events         SSE: stage, progress, node payloads, ledger, artefacts
 *   GET  /jobs/:id/file/:name     streams an artefact
 *   POST /archive                 import surviving files as an archived job (archive.js)
 *
 * With STUDIO_ACCESS_KEY set, every non-GET request needs the x-studio-key header.
 *
 * D3:
 *   GET  /jobs/:id/hooks                       hook cards: plan, preflight, hook, versions
 *   POST /jobs/:id/hooks/:reelN/generate       build the hook (paid or free), 409 on BLOCK
 *   POST /jobs/:id/reels/:reelN/export         render a numbered 1080x1920 master
 *   POST /jobs/:id/retune                      re-cut the hook window and re-render. FREE:
 *                                              reverse, cut, overlays, assembly. Zero
 *                                              model calls, measured by the ledger.
 *   GET  /jobs/:id/reels/:reelN/versions
 *   GET  /jobs/:id/interiors                   hero interiors, estimate, glide records
 *   POST /jobs/:id/interiors/generate          Veo glides (INTERIOR_MOTION=veo only)
 *
 * The GCP service-account key lives here and only here. /web never sees it.
 */
import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { config, versions, rules, costModel } from "./config.js";
import {
  newJobId,
  createJob,
  readJob,
  writeJob,
  listJobs,
  bus,
  photosDir,
  jobDir,
  emit,
} from "./store.js";
import { runJobDetached, resumeJob, assembleJob } from "./pipeline.js";
import { ledgerTotals } from "./ledger.js";
import { ffmpegVersion, pythonStatus, fontStatus } from "./lib/media.js";
import { vertexStatus } from "./lib/vertex.js";
import { corsMiddleware } from "./lib/cors.js";
import { saveNode, setLock } from "./brain/runner.js";
import { regenerateNode, rebuildRecipes, runBrain } from "./brain/index.js";
import { rebuildCostInr, staleKeys, NODE_LABEL } from "./brain/graph.js";
import { preGenerationCheck } from "./brain/preflight.js";
import { buildHook } from "./hook/index.js";
import { exportReel } from "./render/export.js";
import { buildGlides, selectHeroInteriors, glideEstimate } from "./interiors/glide.js";
import { jobFlags, parseOptions, resolveOptions } from "./jobOptions.js";
import { accessMiddleware } from "./lib/access.js";
import { mountArchive } from "./archive.js";

/** Which schema an edited payload is validated against, by node. */
const SCHEMA_BY_NODE = {
  B0: null, // { assets: PhotoAsset[] }, validated per asset by the node itself
  B1: "ListingTruth",
  B2: "TierPersona",
  B3: "FormatPlan",
  B4: "HookPlan",
  B5: "ShotList",
  B6: "CopySet",
  B7: "PacingPlan",
  B8: "PreflightResult",
};

const app = express();
app.disable("x-powered-by");

app.use(corsMiddleware(config.allowedOrigin));
app.use(accessMiddleware(config.accessKey));
app.use(express.json({ limit: "2mb" }));

/** An archived job is a record, not a run: it can be read and duplicated, nothing else. */
app.use("/jobs/:id", (req, res, next) => {
  if (req.method === "GET" || req.method === "OPTIONS" || req.path === "/duplicate" || !req.params.id) return next();
  if (readJob(req.params.id)?.status === "archived") {
    return res.status(409).json({ error: "archived job: duplicate it to run this listing again" });
  }
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: config.maxPhotos },
});

/* --------------------------------------------------------------- health */

app.get("/health", async (_req, res) => {
  const [ffmpeg, python] = await Promise.all([ffmpegVersion(), pythonStatus()]);
  const fonts = fontStatus();
  res.json({
    ok: true,
    service: "reel-studio-service",
    stage: "D3",
    uptimeS: Math.round(process.uptime()),
    node: process.version,
    dataDir: config.dataDir,
    dataDirWritable: isWritable(config.dataDir),
    shared: versions,
    ffmpeg,
    python,
    fonts,
    vertex: vertexStatus(),
    interiorMotion: config.interiorMotion,
    accessKeyRequired: Boolean(config.accessKey),
  });
});

function isWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The rules the browser canvas needs so it does not carry its own copy of the truth. */
app.get("/rules", (_req, res) => {
  res.json({
    version: rules.version,
    type_systems: rules.type_systems,
    safe_zone_9x16: rules.safe_zone_9x16,
    tiers: rules.tiers,
    transitions: rules.transitions,
    motion_vocabulary: rules.motion_vocabulary,
    job_defaults: rules.job_defaults,
  });
});

/* ----------------------------------------------------------------- jobs */

app.post("/jobs", upload.array(config.uploadFieldName, config.maxPhotos), (req, res) => {
  const files = req.files || [];
  if (files.length === 0) {
    return res
      .status(400)
      .json({ error: `no files. Send multipart field "${config.uploadFieldName}"` });
  }

  let facts = {};
  if (req.body?.facts) {
    try {
      facts = JSON.parse(req.body.facts);
    } catch (err) {
      return res.status(400).json({ error: `facts is not valid JSON: ${err.message}` });
    }
  }

  /* Run controls from the dashboard. Validated before anything is written: a malformed
     toggle is a 400, never a silent default that might turn into a paid run. */
  let options;
  try {
    options = parseOptions(req.body?.options ? JSON.parse(req.body.options) : {});
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  /* Bucket assignment. The client sends its own split (exterior / interior /
     floor_plan) because the user can drag photos between buckets; if it does not,
     everything lands in "unsorted" and B0 classifies it in D2. Never guessed silently. */
  let buckets = {};
  if (req.body?.buckets) {
    try {
      buckets = JSON.parse(req.body.buckets);
    } catch {
      buckets = {};
    }
  }

  const jobId = newJobId();
  const job = createJob(jobId, facts);
  job.options = { requested: options, effective: resolveOptions(options) };

  files.forEach((file, i) => {
    const ext = path.extname(file.originalname) || ".jpg";
    const id = `p${String(i + 1).padStart(3, "0")}`;
    const storedName = `${id}${ext.toLowerCase()}`;
    fs.writeFileSync(path.join(photosDir(jobId), storedName), file.buffer);
    job.photos.push({
      id,
      filename: file.originalname,
      storedName,
      bucket: buckets[file.originalname] || buckets[String(i)] || "unsorted",
      sortIndex: i,
      bytes: file.size,
      mimeType: file.mimetype,
      width: null,
      height: null,
      excluded_reason: null,
    });
  });
  writeJob(job);

  res.status(202).json({
    jobId,
    options: job.options,
    photoCount: job.photos.length,
    events: `/jobs/${jobId}/events`,
    job: `/jobs/${jobId}`,
  });

  runJobDetached(jobId);
});

app.get("/jobs", (_req, res) => {
  res.json(
    listJobs()
      .slice(0, 50)
      .map((j) => ({
        jobId: j.jobId,
        status: j.status,
        stage: j.stage,
        progress: j.progress,
        photoCount: j.photos.length,
        createdAt: j.createdAt,
        address: [j.facts?.address_line, j.facts?.city].filter(Boolean).join(", ") || null,
        options: j.options?.effective ?? null,
        duplicateOf: j.duplicate_of ?? null,
        reels: Object.keys(j.reels || {}).length,
        failureReason: j.failureReason ?? null,
        ledger: ledgerTotals(j.ledger),
        archived: j.archived ? { items: j.archived.items.length, lost: j.archived.lost.length } : null,
      })),
  );
});

app.get("/jobs/:id", (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).json({ error: "no such job" });
  res.json({ ...job, ledgerTotals: ledgerTotals(job.ledger) });
});

/* ----------------------------------------------------------- brain nodes */

/** The node cards: status, model, cost, elapsed, staleness, rebuild cost. */
app.get("/jobs/:id/nodes", (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).json({ error: "no such job" });

  const keys = Object.keys(job.nodes);
  const cards = keys.map((k) => {
    const n = job.nodes[k];
    const wouldStale = staleKeys(k, keys);
    return {
      key: k,
      node: n.node,
      reelN: n.reelN ?? null,
      label: NODE_LABEL[n.node],
      status: n.status,
      version: n.version,
      model: n.model,
      costInr: n.cost_inr,
      calls: n.calls,
      elapsedMs: n.elapsed_ms,
      attempts: n.attempts ?? 1,
      locked: n.locked,
      stale: n.stale,
      failureReason: n.failure_reason,
      generatedAt: n.generated_at,
      parentVersions: n.parent_versions,
      editedBy: n.edited_by ?? null,
      /* What re-running this node would cost downstream, shown before the click. */
      wouldStale,
      rebuildCostInr: rebuildCostInr(wouldStale, { photoCount: job.photos.length }),
    };
  });

  res.json({
    jobId: job.jobId,
    cards,
    ledger: ledgerTotals(job.ledger),
    dedupe: job.dedupe ?? null,
    recipeNotes: job.recipeNotes ?? [],
    recipeProblems: job.recipeProblems ?? [],
  });
});

app.get("/jobs/:id/nodes/:key", (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).json({ error: "no such job" });
  const n = job.nodes[req.params.key];
  if (!n) return res.status(404).json({ error: "no such node" });
  res.json(n);
});

/** Save an edited payload. Validates, bumps the version, stales descendants. */
app.patch("/jobs/:id/nodes/:key", (req, res) => {
  try {
    const schema = SCHEMA_BY_NODE[req.params.key.split(":")[0]] || null;
    const record = saveNode(req.params.id, req.params.key, req.body?.payload, { schema });
    res.json({ ok: true, node: record });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Re-run ONE node. Siblings untouched. */
app.post("/jobs/:id/nodes/:key/regenerate", async (req, res) => {
  try {
    const payload = await regenerateNode(req.params.id, req.params.key);
    res.json({ ok: true, payload });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/jobs/:id/nodes/:key/lock", (req, res) => {
  try {
    res.json({ ok: true, node: setLock(req.params.id, req.params.key, req.body?.locked) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Resume a failed job. Nodes already stored as ok and not stale are reused, so a
 * transient network failure late in the graph costs one call, not the whole brain.
 */
app.post("/jobs/:id/resume", (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).json({ error: "no such job" });
  res.status(202).json({ ok: true, resuming: req.params.id });
  resumeJob(req.params.id);
});

/** Rebuild the recipes from the stored nodes. Pure function, zero cost. */
app.post("/jobs/:id/recipes/rebuild", (req, res) => {
  try {
    res.json({ ok: true, ...rebuildRecipes(req.params.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/jobs/:id/recipes", (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).json({ error: "no such job" });
  res.json({
    recipes: job.recipes ?? [],
    notes: job.recipeNotes ?? [],
    problems: job.recipeProblems ?? [],
  });
});

/* ------------------------------------------------------ dashboard: summary */

/**
 * The live dashboard's view of a job: everything it draws, none of the event log or the
 * node payloads that make /jobs/:id heavy. Polled on every SSE event.
 */
app.get("/jobs/:id/summary", (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).json({ error: "no such job" });
  const flags = jobFlags(job);
  res.json({
    jobId: job.jobId,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    failureReason: job.failureReason,
    duplicateOf: job.duplicate_of ?? null,
    reusedBrain: job.reused_brain ?? [],
    facts: job.facts,
    photoCount: job.photos.length,
    photos: job.photos.map((p) => ({ id: p.id, name: p.storedName, excluded_reason: p.excluded_reason })),
    options: job.options ?? null,
    flags,
    nodes: Object.values(job.nodes).map((n) => ({
      key: n.key,
      node: n.node,
      reelN: n.reelN ?? null,
      label: NODE_LABEL[n.node],
      status: n.status,
      version: n.version,
      model: n.model,
      costInr: n.cost_inr,
      elapsedMs: n.elapsed_ms,
      attempts: n.attempts ?? 1,
      locked: n.locked,
      stale: n.stale,
      failureReason: n.failure_reason,
      copiedFrom: n.copied_from ?? null,
      concept: n.node === "B4" ? n.payload?.concept_id : undefined,
    })),
    hooks: job.hooks ?? {},
    hookHistory: job.hook_history ?? {},
    interiorClips: job.interior_clips ?? {},
    reels: Object.fromEntries(Object.entries(job.reels || {}).map(([n, r]) => [n, r.versions])),
    recipes: (job.recipes || []).map((r) => ({ reelId: r.reelId, tier: r.tier, durationS: r.durationS })),
    runIssues: job.run_issues ?? [],
    archived: job.archived ?? null,
    ledger: job.ledger,
    ledgerTotals: ledgerTotals(job.ledger),
    guards: {
      warnUsd: costModel.guards.warn_above_usd_per_listing,
      blockUsd: costModel.guards.block_above_usd_per_listing,
      usdInr: costModel.fx.usd_inr,
    },
  });
});

/**
 * Same photos, different run controls. No re-upload: the photos are copied on the
 * service. By default the brain is reused too — B0 through B7 except the hook plans are
 * copied and LOCKED, so a 2.5d vs veo comparison differs in the toggles and nothing else,
 * and the duplicate does not pay for the brain twice. B4 and B8 run again, because they
 * depend on the options.
 */
app.post("/jobs/:id/duplicate", (req, res) => {
  const src = readJob(req.params.id);
  if (!src) return res.status(404).json({ error: "no such job" });
  let options;
  try {
    options = parseOptions(req.body?.options ?? src.options?.requested ?? {});
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  const reuseBrain = req.body?.reuseBrain !== false;

  const jobId = newJobId();
  const job = createJob(jobId, src.facts);
  job.options = { requested: options, effective: resolveOptions(options) };
  job.duplicate_of = src.jobId;
  for (const photo of src.photos) {
    fs.copyFileSync(path.join(photosDir(src.jobId), photo.storedName), path.join(photosDir(jobId), photo.storedName));
    job.photos.push({ ...photo });
  }
  if (reuseBrain) {
    const keep = Object.keys(src.nodes).filter((k) => {
      const n = src.nodes[k];
      return n.status === "ok" && !["B4", "B8"].includes(n.node);
    });
    for (const k of keep) {
      job.nodes[k] = { ...structuredClone(src.nodes[k]), locked: true, stale: false, copied_from: src.jobId };
    }
    job.dedupe = structuredClone(src.dedupe ?? null);
    job.reused_brain = keep;
  }
  writeJob(job);
  res.status(202).json({ jobId, duplicateOf: src.jobId, reusedBrain: job.reused_brain ?? [], options: job.options });
  runJobDetached(jobId);
});

/* ------------------------------------------------------------ D3: hooks */

/** Hooks currently being generated, so a double click does not buy two Veo clips. */
const generating = new Set();

app.get("/jobs/:id/hooks", (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).json({ error: "no such job" });
  const reels = (job.nodes.B3?.payload?.reels || []).map((r) => {
    const planNode = job.nodes[`B4:${r.reel_n}`];
    return {
      reel_n: r.reel_n,
      format_id: r.format_id,
      tier: r.tier,
      plan: planNode?.payload ?? null,
      plan_status: planNode ? { status: planNode.status, stale: planNode.stale, version: planNode.version, cost_inr: planNode.cost_inr } : null,
      preflight: planNode ? preGenerationCheck(job, r.reel_n) : null,
      generating: generating.has(`${job.jobId}:${r.reel_n}`),
      hook: job.hooks?.[r.reel_n] ?? null,
      versions: job.reels?.[r.reel_n]?.versions ?? [],
    };
  });
  res.json({ jobId: job.jobId, reels, ledger: ledgerTotals(job.ledger), generativeEnabled: jobFlags(job).generative });
});

app.post("/jobs/:id/hooks/:reelN/generate", (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).json({ error: "no such job" });
  const reelN = Number(req.params.reelN);
  const gate = preGenerationCheck(job, reelN);
  if (!gate.pass) {
    return res.status(409).json({
      error: "pre_generation preflight BLOCK",
      blocks: gate.results.filter((r) => r.level === "BLOCK"),
    });
  }
  const key = `${job.jobId}:${reelN}`;
  if (generating.has(key)) return res.status(409).json({ error: `reel ${reelN} hook is already generating` });

  generating.add(key);
  res.status(202).json({ ok: true, reelN, events: `/jobs/${job.jobId}/events` });
  buildHook(job.jobId, reelN, { supersedeReason: req.body?.reason || null })
    .catch((err) => emit(job.jobId, "hook", { reelN, step: "failed", reason: err.message.slice(0, 500) }))
    .finally(() => generating.delete(key));
});

app.post("/jobs/:id/reels/:reelN/export", async (req, res) => {
  try {
    const record = await exportReel(req.params.id, Number(req.params.reelN), { kind: "export" });
    res.json({ ok: true, version: record });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * Phase 2. The only route that assembles, and it refuses a job that is not
 * sitting at the gate. ffmpeg only, so it spends nothing and may be re-run.
 *
 * body: { selection?: { "1": "sketch_to_real", "2": "block_build", ... } }
 */
app.post("/jobs/:id/assemble", async (req, res) => {
  const selection = (req.body && req.body.selection) || null;
  try {
    await assembleJob(req.params.id, selection);
    res.json({ ok: true, jobId: req.params.id, cost_usd: 0 });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/jobs/:id/retune", async (req, res) => {
  const { reelN, windowStart = null, windowLength, speed } = req.body || {};
  if (!reelN) return res.status(400).json({ error: "reelN is required" });
  try {
    const record = await exportReel(req.params.id, Number(reelN), {
      kind: "retune",
      windowStart: windowStart == null ? null : Number(windowStart),
      ...(windowLength != null ? { windowLength: Number(windowLength) } : {}),
      ...(speed != null ? { speed: Number(speed) } : {}),
    });
    res.json({ ok: true, free: record.ledger.new_rows === 0, version: record });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/jobs/:id/reels/:reelN/versions", (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).json({ error: "no such job" });
  res.json({ versions: job.reels?.[req.params.reelN]?.versions ?? [] });
});

/* ------------------------------------------------------ interior glides */

const glideRuns = new Set();

app.get("/jobs/:id/interiors", (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).json({ error: "no such job" });
  const heroes = selectHeroInteriors(job);
  const pending = heroes.filter((h) => !job.interior_clips?.[h.photo_id]);
  res.json({
    interiorMotion: jobFlags(job).interiorMotion,
    generativeEnabled: jobFlags(job).generative,
    generating: glideRuns.has(job.jobId),
    heroes,
    estimate: glideEstimate(pending.length, costModel),
    clips: job.interior_clips || {},
  });
});

app.post("/jobs/:id/interiors/generate", (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).json({ error: "no such job" });
  const flags = jobFlags(job);
  if (flags.interiorMotion !== "veo") return res.status(409).json({ error: "this job runs interiors in 2.5d" });
  if (!flags.generative) return res.status(409).json({ error: "generative is off for this job" });
  if (glideRuns.has(job.jobId)) return res.status(409).json({ error: "glides already generating for this job" });
  glideRuns.add(job.jobId);
  res.status(202).json({ ok: true, heroes: selectHeroInteriors(job) });
  buildGlides(job.jobId, { photoIds: req.body?.photoIds ?? null })
    .catch((err) => emit(job.jobId, "interior", { step: "failed", reason: err.message.slice(0, 400) }))
    .finally(() => glideRuns.delete(job.jobId));
});

/* ------------------------------------------------------------------ SSE */

app.get("/jobs/:id/events", (req, res) => {
  const jobId = req.params.id;
  const job = readJob(jobId);
  if (!job) return res.status(404).json({ error: "no such job" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (event) => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Replay first: a client that connects after the job finished still sees the whole
  // job rather than an empty stream.
  const from = Number(req.query.from ?? 0);
  for (const event of job.events.slice(from)) send(event);

  if (job.status === "completed" || job.status === "failed" || job.status === "archived") {
    send({ type: "eof", at: new Date().toISOString() });
    return res.end();
  }

  const onEvent = (event) => {
    send(event);
    if (event.type === "completed" || event.type === "failed") {
      send({ type: "eof", at: new Date().toISOString() });
      res.end();
    }
  };
  bus(jobId).on("event", onEvent);

  const keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(keepAlive);
    bus(jobId).off("event", onEvent);
  });
});

/* -------------------------------------------------------------- artefacts */

app.get("/jobs/:id/file/:name", (req, res) => {
  const jobId = req.params.id;
  if (!readJob(jobId)) return res.status(404).json({ error: "no such job" });

  // Resolve inside the job directory and refuse anything that escapes it.
  const name = path.basename(req.params.name);
  const root = jobDir(jobId);
  const candidates = [
    path.join(photosDir(jobId), name),
    path.join(root, "out", name),
  ];
  const hit = candidates.find(
    (p) => p.startsWith(root + path.sep) && fs.existsSync(p),
  );
  if (!hit) return res.status(404).json({ error: "no such file" });
  // A cross-origin <a download> is ignored by browsers; the header is what downloads.
  if (req.query.download) res.attachment(name);

  res.sendFile(hit);
});

/* ------------------------------------------------------------------ boot */

mountArchive(app);

app.use((req, res) => res.status(404).json({ error: `no route ${req.method} ${req.path}` }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "internal error" });
});

const server = app.listen(config.port, () => {
  console.log(
    `reel-studio-service listening on :${config.port}\n` +
      `  data      ${config.dataDir}\n` +
      `  shared    rules v${versions.rules}, cost-model v${versions.costModel}\n` +
      `  generative ${config.generativeEnabled ? "ENABLED" : "disabled (paid video gated)"}`,
  );
});

// Railway restarts containers; finish in-flight responses before dying.
process.on("SIGTERM", () => {
  console.log("SIGTERM, closing");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
});
