/**
 * exportReel: one hook + one recipe -> one numbered 1080x1920 master.
 *
 * The first export and every retune go through here, and the only difference is the
 * hook window. That is what makes a retune free: it re-runs reverse, cut, truth lock,
 * overlays and assembly — ffmpeg and Pillow — and nothing that can call a model. The
 * version record carries the ledger row count before and after, so "free" is a
 * measured claim, not a label.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rules, config } from "../config.js";
import { readJob, writeJob, emit, jobDir, outDir, photosDir } from "../store.js";
import { cutAndLock, HOOK_WINDOW_S } from "../hook/paid.js";
import { hookDisclosure, motionDisclosure } from "../hook/compliance.js";
import { selectHeroInteriors } from "../interiors/glide.js";
import { jobFlags } from "../jobOptions.js";
import { evaluateRules } from "../brain/preflight.js";
import { renderReel } from "./render.js";

const run = promisify(execFile);
const FPS = rules.job_defaults.fps;
const [MW, MH] = rules.job_defaults.master_size_9x16.split("x").map(Number);

/** Per-reel mutex. Two exports of one reel writing the same version number is a bug. */
const busy = new Set();

/**
 * @param opts.windowStart   seconds into the reversed clip; null = the hook's own window
 *                           (rules.json playback), else the tail (retune.mjs)
 * @param opts.windowLength  null = the hook's own, else HOOK_WINDOW_S (hook-v4.mjs WINDOW_LEN)
 * @param opts.speed         null = the hook's own playback speed, else 1
 * @param opts.kind          "export" | "retune" | "mls"
 *                           "mls" drops the hook and every overlay for a Bright-safe cut.
 */
export async function exportReel(jobId, reelN, { windowStart = null, windowLength = null, speed = null, kind = "export" } = {}) {
  const lockKey = `${jobId}:${reelN}`;
  if (busy.has(lockKey)) throw Object.assign(new Error(`reel ${reelN} is already rendering`), { status: 409 });
  busy.add(lockKey);
  try {
    return await exportInner(jobId, reelN, { windowStart, windowLength, speed, kind });
  } finally {
    busy.delete(lockKey);
  }
}

async function exportInner(jobId, reelN, { windowStart, windowLength, speed, kind }) {
  const job = readJob(jobId);
  if (!job) throw Object.assign(new Error("no such job"), { status: 404 });
  const hook = job.hooks?.[reelN];
  if (!hook) throw Object.assign(new Error(`reel ${reelN} has no hook yet; generate it first`), { status: 409 });
  const baseRecipe = (job.recipes || []).find((r) => r.reelId === `reel-${reelN}`);
  if (!baseRecipe) throw Object.assign(new Error(`reel ${reelN} has no recipe`), { status: 409 });

  const ledgerBefore = job.ledger.length;
  const version = (job.reels?.[reelN]?.versions?.length ?? 0) + 1;
  const tag = `reel-${reelN}_v${version}`;
  const reelRoot = path.join(jobDir(jobId), "render", `reel-${reelN}`);
  const vDir = path.join(reelRoot, `v${version}`);
  fs.mkdirSync(vDir, { recursive: true });
  const started = Date.now();
  emit(jobId, "render", { reelN, step: "start", version, kind });

  /* ---------------------------------------------------------------- the hook */
  const paid = hook.generation_path === "reverse_conceal" && hook.forward_path;
  let hookClip;
  let lockAtS;
  let lockDoneS;
  let cut = null;
  if (paid) {
    /* A retune that names only a window start keeps the hook's own length and speed. */
    cut = await cutAndLock({
      forwardPath: hook.forward_path,
      heroPath: hook.hero_path,
      outDir: path.join(vDir, "hook"),
      windowStart: windowStart ?? hook.window_start_s ?? null,
      windowLength: windowLength ?? hook.window_length_s ?? HOOK_WINDOW_S,
      speed: speed ?? hook.playback_speed ?? 1,
      frames: hook.truth_lock_frames ?? rules.job_defaults.truth_lock_frames,
    });
    hookClip = cut.lockedPath;
    lockAtS = cut.lockAtS;
    lockDoneS = cut.lockDoneS;
  } else {
    if (windowStart != null) {
      emit(jobId, "render", { reelN, step: "note", note: "free hook has no generated clip; window ignored" });
    }
    hookClip = hook.clip_path;
    lockAtS = 0;
    lockDoneS = hook.duration_s;
  }

/** Timeline values are compared downstream at millisecond precision. */
function round3(n) {
  return Math.round(n * 1000) / 1000;
}

  /* ------------------------------------------------------ effective recipe */
  const recipe = structuredClone(baseRecipe);

  /* ---------------------------------------------------------- the MLS cut.
     Bright bans superimposed text, graphics, logos and identifiable people on
     MLS media, with a $250 fine for branded media. A reel carrying a hook and
     captions is a social asset and must never reach a Bright virtual tour
     field. The MLS cut drops the hook segment entirely and strips every
     overlay from what is left, so the export is real photographs, camera
     moves and music. No model is called: this is still free. */
  const mlsCut = kind === "mls";
  if (mlsCut) {
    recipe.segments = recipe.segments.filter((s) => s.kind !== "hook");
    if (recipe.segments.length === 0) {
      throw Object.assign(
        new Error("MLS cut has no segments left once the hook is removed"),
        { status: 409 },
      );
    }
    /* Rebase the timeline so the reel starts at zero after the hook is gone. */
    const shift = recipe.segments[0].tIn;
    for (const seg of recipe.segments) {
      seg.tIn = round3(seg.tIn - shift);
      seg.tOut = round3(seg.tOut - shift);
      seg.overlays = []; // no captions, no disclosure, no CTA band, no branding
    }
    recipe.durationS = round3(recipe.segments[recipe.segments.length - 1].tOut);
    recipe.narration = [];
  }
  /* The MLS cut has no hook segment, so none of the hook wiring applies and the
     disclosure must not be re-added: there is nothing AI-generated left to
     disclose, and any overlay at all would breach the Bright media rule. */
  const hookSeg = mlsCut
    ? null
    : recipe.segments.find((s) => s.kind === "hook") || recipe.segments[0];
  const slot = hookSeg ? hookSeg.tOut - hookSeg.tIn : 0;
  /* The hook slot comes from B7's beat grid; the clip comes from Veo. If the slot is
     shorter than the reveal, start the clip later so the truth lock still lands inside
     the slot, with a few frames of the untouched photo held before the cut. */
  const holdAfterLock = paid ? 0.1 : 0;
  const hookStartS = Math.max(0, lockDoneS + holdAfterLock - slot);
  const reelLockAt = hookSeg ? hookSeg.tIn + Math.max(0, lockAtS - hookStartS) : 0;
  const reelLockDone = hookSeg ? hookSeg.tIn + (lockDoneS - hookStartS) : 0;

  if (hookSeg) {
    hookSeg.source = {
      type: paid ? "generated" : "clip",
      id: `hook:${reelN}:${hook.concept_id}`,
      url: `/jobs/${jobId}/file/${tag}_hook.mp4`,
    };
    // B6 may have left an empty disclosure on the hook; it is replaced, never stacked.
    hookSeg.overlays = hookSeg.overlays.filter((o) => o.kind !== "disclosure");
  }

  const truth = job.nodes.B1?.payload;
  let disclosure = null;
  if (paid && !mlsCut) {
    disclosure = hookDisclosure({ market: truth.market, truth, truthLockS: reelLockDone });
    if (disclosure.problems.length) {
      throw Object.assign(new Error(`US_ALTERED_NO_DISCLOSURE: ${disclosure.problems.join("; ")}`), { status: 409 });
    }
    hookSeg.overlays.push({
      kind: "disclosure",
      system: "address_only",
      lines: [disclosure.label],
      tIn: hookSeg.tIn,
      tOut: hookSeg.tOut,
      fadeS: 0.05,
    });
    const cta = recipe.segments.find((s) => s.kind === "cta");
    const band = cta?.overlays.find((o) => o.kind === "cta_band");
    if (disclosure.ctaLine && band && !band.lines.includes(disclosure.ctaLine)) {
      band.lines.push(disclosure.ctaLine);
    }
  }
  /* ------------------------------------------------------- interior glides */
  /* INTERIOR_MOTION=veo swaps a still for its APPROVED glide. Export never generates:
     a hero interior without a clip is recorded and stays 2.5d, because a reel that
     triggers new clip generation breaks the build-once asset pool. */
  const glides = [];
  const glidesMissing = [];
  const flags = jobFlags(job);
  /* The MLS cut stays on untouched photographs with ffmpeg parallax. A Veo
     glide is AI-generated motion and would require an on-frame disclosure,
     which is itself a superimposed graphic and therefore banned on MLS media.
     Dropping to 2.5d removes the dilemma instead of resolving it badly. */
  if (flags.interiorMotion === "veo" && !mlsCut) {
    const clips = job.interior_clips || {};
    for (const seg of recipe.segments) {
      if (seg.kind !== "interior") continue;
      const pid = seg.source.photoId ?? seg.source.id;
      const rec = clips[pid];
      if (!rec) continue;
      if (rec.status !== "approved") {
        glides.push({ photo_id: pid, used: false, status: rec.status, reason: rec.reason });
        continue;
      }
      seg.source = { type: "generated", id: `glide:${pid}`, photoId: pid, url: `/jobs/${jobId}/file/${rec.clip_file}` };
      glides.push({ photo_id: pid, used: true, status: "approved", tIn: seg.tIn, tOut: seg.tOut, motion: seg.motion });
    }
    for (const h of selectHeroInteriors(job)) {
      if (!clips[h.photo_id]) glidesMissing.push(h.photo_id);
    }
    if (glides.some((g) => g.used)) {
      const motion = motionDisclosure({ market: truth.market, truth, hookGenerated: Boolean(paid) });
      if (motion.problems.length) {
        throw Object.assign(new Error(`INTERIOR_ALTERED: ${motion.problems.join("; ")}`), { status: 409 });
      }
      for (const seg of recipe.segments) {
        if (seg.source.type !== "generated" || seg.kind !== "interior") continue;
        seg.overlays = seg.overlays.filter((o) => o.kind !== "disclosure");
        seg.overlays.push({ kind: "disclosure", system: "address_only", lines: [motion.label], tIn: seg.tIn, tOut: seg.tOut, fadeS: 0.05 });
      }
      const band = recipe.segments.find((s) => s.kind === "cta")?.overlays.find((o) => o.kind === "cta_band");
      if (band) {
        // The motion line covers the opening scene too; never print both.
        band.lines = band.lines.filter((l) => l !== disclosure?.ctaLine);
        if (!band.lines.includes(motion.ctaLine)) band.lines.push(motion.ctaLine);
      }
      disclosure = { ...(disclosure || {}), motionLabel: motion.label, ctaLine: motion.ctaLine };
    }
  }

  recipe.truthLock = {
    atS: Number(reelLockAt.toFixed(3)),
    frames: hook.truth_lock_frames ?? rules.job_defaults.truth_lock_frames,
    sourcePhotoId: hook.source_photo_id,
  };

  /* ---------------------------------------------------------------- render */
  const photoPath = (photoId) => {
    const photo = job.photos.find((p) => p.id === photoId);
    return photo ? path.join(photosDir(jobId), photo.storedName) : null;
  };
  const outPath = path.join(outDir(jobId), `${tag}.mp4`);
  const glideFor = (seg) => {
    if (seg.kind !== "interior" || seg.source.type !== "generated") return null;
    const rec = job.interior_clips?.[seg.source.photoId];
    return rec?.status === "approved" ? { clipPath: rec.clip_path, durationS: rec.clip_duration_s } : null;
  };
  const rendered = await renderReel(recipe, {
    hookPath: hookClip,
    hookStartS,
    glideFor,
    photoPath,
    workDir: vDir,
    outPath,
    jobId,
    segmentCacheDir: path.join(reelRoot, "segcache"),
  });
  fs.copyFileSync(hookClip, path.join(outDir(jobId), `${tag}_hook.mp4`));
  fs.writeFileSync(path.join(outDir(jobId), `${tag}_recipe.json`), JSON.stringify(recipe, null, 2));

  /* ------------------------------------------------- export-time preflight */
  /* Evaluated on the EFFECTIVE recipe — the strings that were actually rendered,
     including the disclosure and CTA lines export added — not on B6's payload. */
  const { results } = evaluateRules(
    {
      hookRecord: hook,
      overlayBoxes: rendered.overlayBoxes,
      recipes: [recipe],
      allAssets: job.nodes.B0?.payload?.assets || [],
      interiorMotion: flags.interiorMotion,
      interiorClips: job.interior_clips || {},
    },
    "pre_export",
    { only: ["Q_FAIL_TWICE", "SAFE_ZONE", "CAPTION_DEFECT", "CAPTION_SUBJECT_MISMATCH", "INTERIOR_ALTERED"] },
  );
  const blocks = results.filter((r) => r.level === "BLOCK");

  /* ------------------------------------------------------------- evidence */
  const probe = await probeVideo(outPath);
  const truthLockSsim = await ssimHookEndVsHero(path.join(vDir, "segments", "seg_00.mp4"), hook.hero_path);
  const lockFrame = path.join(outDir(jobId), `${tag}_lock_frame.png`);
  await run("ffmpeg", ["-y", "-v", "error", "-ss", Math.max(0, Math.min(hookSeg.tOut - 0.05, reelLockDone + 0.02)).toFixed(3), "-i", outPath, "-frames:v", "1", lockFrame]);
  const sheet = path.join(outDir(jobId), `${tag}_sheet.png`);
  await run("ffmpeg", ["-y", "-v", "error", "-i", outPath, "-vf", "fps=2,scale=216:-1,tile=8x4:padding=4:color=black", "-frames:v", "1", "-update", "1", sheet]);

  const after = readJob(jobId);
  const newRows = after.ledger.slice(ledgerBefore);
  const record = {
    version,
    kind,
    status: blocks.length ? "blocked" : "ok",
    blocked_by: blocks.map((b) => `${b.rule_id}: ${b.evidence}`),
    created_at: new Date().toISOString(),
    elapsed_ms: Date.now() - started,
    hook: {
      concept_id: hook.concept_id,
      generation_path: hook.generation_path,
      fell_back: hook.fell_back,
      window_start_s: cut ? Number(cut.windowStart.toFixed(3)) : null,
      window_length_s: cut ? Number(cut.windowLength.toFixed(3)) : null,
      playback_speed: cut ? cut.speed : null,
      reversed_duration_s: cut ? Number(cut.reversedDuration.toFixed(3)) : null,
      clip_start_in_slot_s: Number(hookStartS.toFixed(3)),
    },
    truth_lock: {
      at_s: Number(reelLockAt.toFixed(3)),
      done_s: Number(reelLockDone.toFixed(3)),
      frames: recipe.truthLock.frames,
      source_photo_id: hook.source_photo_id,
      ssim_hook_last_frame_vs_hero: truthLockSsim,
    },
    disclosure: disclosure
      ? { label: disclosure.label ?? null, motion_label: disclosure.motionLabel ?? null, cta_line: disclosure.ctaLine }
      : null,
    interior_motion: flags.interiorMotion,
    glides,
    glides_missing: glidesMissing,
    files: {
      master: path.basename(outPath),
      silent: path.basename(rendered.silentPath),
      hook: `${tag}_hook.mp4`,
      sheet: path.basename(sheet),
      lock_frame: path.basename(lockFrame),
      recipe: `${tag}_recipe.json`,
    },
    video: probe,
    audio_note: rendered.audioNote,
    segments: rendered.segments,
    segment_cache_hits: rendered.segmentCacheHits,
    overlay_boxes: rendered.overlayBoxes,
    preflight: results,
    ledger: {
      rows_before: ledgerBefore,
      rows_after: after.ledger.length,
      new_rows: newRows.length,
      cost_inr: Number(newRows.reduce((s, r) => s + (r.cost_inr || 0), 0).toFixed(4)),
    },
  };

  after.reels = after.reels || {};
  after.reels[reelN] = after.reels[reelN] || { versions: [] };
  after.reels[reelN].versions.push(record);
  writeJob(after);
  emit(jobId, "render", {
    reelN,
    step: "done",
    version,
    kind,
    status: record.status,
    file: record.files.master,
    costInr: record.ledger.cost_inr,
  });
  return record;
}

async function probeVideo(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,profile,width,height,r_frame_rate,pix_fmt,nb_frames:format=duration,size",
    "-of", "json",
    file,
  ]);
  const j = JSON.parse(stdout);
  const s = j.streams?.[0] || {};
  return {
    codec: s.codec_name,
    profile: s.profile,
    width: s.width,
    height: s.height,
    fps: s.r_frame_rate,
    pix_fmt: s.pix_fmt,
    frames: Number(s.nb_frames),
    duration_s: Number(Number(j.format?.duration).toFixed(3)),
    bytes: Number(j.format?.size),
  };
}

/**
 * The truth lock, measured: SSIM between the hook segment's last frame (before any
 * overlay is composited) and the untouched hero at master size. ~1.0 means the hook
 * ends on the real photograph and not on something that looks like it.
 */
async function ssimHookEndVsHero(hookSegmentPath, heroPath) {
  try {
    const last = hookSegmentPath.replace(/\.mp4$/, "_last.png");
    await run("ffmpeg", ["-y", "-v", "error", "-sseof", "-0.2", "-i", hookSegmentPath, "-update", "1", last]);
    const { stderr } = await run("ffmpeg", [
      "-v", "info",
      "-i", last,
      "-i", heroPath,
      "-filter_complex",
      `[1:v]scale=${MW}:${MH}:force_original_aspect_ratio=increase,crop=${MW}:${MH},format=yuv420p[h];[0:v]format=yuv420p[a];[a][h]ssim`,
      "-f", "null", "-",
    ]);
    const m = stderr.match(/All:([\d.]+)/);
    return m ? Number(Number(m[1]).toFixed(4)) : null;
  } catch {
    return null;
  }
}

export { FPS };
