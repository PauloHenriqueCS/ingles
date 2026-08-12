import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveUserListeningLevel } from '../daily/resolve-user-listening-level';
import { resolveListeningActivityDate } from '../daily/resolve-listening-activity-date';
import { levelGroupForCefr, type ListeningLevelGroup } from '../listening-level-group';
import { generateListeningStory, signToken, type ListeningStoryResult, type StoryPartResult } from '../story-session/generate-listening-story';
import { SharedStoryGeneratingError, type AcquireSharedStoryResult, type SharedStoryContent } from './listening-shared-story-types';

// Long enough to cover a realistic OpenAI + Azure TTS run with margin; short
// enough that a genuinely crashed/killed request doesn't block the group for
// long before another request can take over. No cron/recovery routine reaps
// this — the next request re-checks lock_expires_at itself (see the
// migration's acquire_or_get_listening_shared_story RPC).
export const SHARED_STORY_LOCK_DURATION_SECONDS = 180;

// Reuses the EXISTING private Storage bucket (already provisioned; not part
// of this change) — just a namespace, not the broken publication pipeline.
const SHARED_STORY_AUDIO_BUCKET = 'listening-audio';

function audioPathForPart(levelGroup: ListeningLevelGroup, storyId: string, partId: 1 | 2, mimeType: string): string {
  // Deterministic by (level_group, story_id, part) only — no user_id, no
  // playback rate, no attempt number, no timestamp, per the task's explicit
  // identity rule.
  const ext = mimeType === 'audio/mpeg' ? 'mp3' : 'bin';
  return `shared/${levelGroup}/${storyId}/part${partId}.${ext}`;
}

async function uploadPartAudio(
  serviceClient: SupabaseClient,
  levelGroup: ListeningLevelGroup,
  storyId: string,
  part: StoryPartResult,
): Promise<string> {
  const path = audioPathForPart(levelGroup, storyId, part.id, part.audioMimeType);
  const bytes = Buffer.from(part.audioBase64, 'base64');
  const { error } = await serviceClient.storage.from(SHARED_STORY_AUDIO_BUCKET).upload(path, bytes, {
    contentType: part.audioMimeType,
    upsert: true, // path is deterministic per story — safe to overwrite the same identity, never creates a second one
  });
  if (error) throw new Error(`SHARED_STORY_AUDIO_UPLOAD_FAILED_PART${part.id}: ${error.message}`);
  return path;
}

async function downloadPartAudioBase64(serviceClient: SupabaseClient, path: string): Promise<string> {
  const { data, error } = await serviceClient.storage.from(SHARED_STORY_AUDIO_BUCKET).download(path);
  if (error || !data) throw new Error(`SHARED_STORY_AUDIO_DOWNLOAD_FAILED: ${error?.message ?? 'no data'}`);
  const buf = Buffer.from(await data.arrayBuffer());
  return buf.toString('base64');
}

async function persistSharedStory(
  serviceClient: SupabaseClient,
  storyId: string,
  levelGroup: ListeningLevelGroup,
  story: ListeningStoryResult,
): Promise<void> {
  const [part1Path, part2Path] = await Promise.all([
    uploadPartAudio(serviceClient, levelGroup, storyId, story.parts[0]),
    uploadPartAudio(serviceClient, levelGroup, storyId, story.parts[1]),
  ]);

  const content: SharedStoryContent = {
    title: story.title,
    level: story.level,
    summary: story.summary,
    parts: [
      { id: 1, text: story.parts[0].text, question: story.parts[0].question },
      { id: 2, text: story.parts[1].text, question: story.parts[1].question },
    ],
  };

  const { error } = await serviceClient
    .from('listening_shared_stories')
    .update({
      status: 'ready',
      content,
      part1_audio_path: part1Path,
      part2_audio_path: part2Path,
      audio_mime_type: story.parts[0].audioMimeType,
      error_message: null,
      lock_expires_at: null,
    })
    .eq('id', storyId);
  if (error) throw new Error(`SHARED_STORY_PERSIST_FAILED: ${error.message}`);
}

async function markSharedStoryFailed(serviceClient: SupabaseClient, storyId: string, err: unknown): Promise<void> {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  // Best-effort — the caller re-throws the ORIGINAL error regardless of
  // whether this write itself succeeds, so a DB hiccup here never masks the
  // real failure reason.
  await serviceClient
    .from('listening_shared_stories')
    .update({ status: 'failed', error_message: message })
    .eq('id', storyId)
    .then(() => {}, () => {});
}

// Creates (or leaves untouched) the user's PENDING association to a story:
// completed=false, tagged with the SP activity_date so "one pending per user per
// day" is DB-enforced (uq_ulsp_one_pending_per_day). Idempotent per
// (user, shared_story). NEVER sets completed — preparing does not consume quota.
async function attachUserProgress(
  serviceClient: SupabaseClient,
  userId: string,
  sharedStoryId: string,
  activityDate: string,
  levelGroup: ListeningLevelGroup,
): Promise<void> {
  const { error } = await serviceClient
    .from('user_listening_shared_progress')
    .upsert(
      { user_id: userId, shared_story_id: sharedStoryId, activity_date: activityDate },
      { onConflict: 'user_id,shared_story_id', ignoreDuplicates: true },
    );
  if (!error) return;
  // A concurrent request already created a DIFFERENT pending for this user/day
  // (uq_ulsp_one_pending_per_day). Don't create a second pending — signal the
  // client to retry; the retry recovers the winning pending in step 0.
  if (error.code === '23505' || /uq_ulsp_one_pending_per_day/.test(error.message ?? '')) {
    throw new SharedStoryGeneratingError(levelGroup);
  }
  throw new Error(`SHARED_STORY_PROGRESS_ATTACH_FAILED: ${error.message}`);
}

// The user's PENDING (completed=false) story for a given SP day, if any. At most
// one exists (uq_ulsp_one_pending_per_day). Returns the shared story row so the
// caller can decide: 'ready' → recover it; 'generating' → still preparing;
// 'failed'/expired → stale, drop the pending and prepare fresh.
async function findPendingStory(
  serviceClient: SupabaseClient,
  userId: string,
  practiceDate: string,
): Promise<{
  id: string; status: string; content: SharedStoryContent | null;
  part1_audio_path: string | null; part2_audio_path: string | null;
  audio_mime_type: string | null; lock_expires_at: string | null;
} | null> {
  const { data: pending, error: pErr } = await serviceClient
    .from('user_listening_shared_progress')
    .select('shared_story_id')
    .eq('user_id', userId)
    .eq('completed', false)
    .eq('activity_date', practiceDate)
    .maybeSingle();
  if (pErr) throw new Error(`SHARED_STORY_PENDING_LOOKUP_FAILED: ${pErr.message}`);
  if (!pending) return null;

  const { data: story, error: sErr } = await serviceClient
    .from('listening_shared_stories')
    .select('id, status, content, part1_audio_path, part2_audio_path, audio_mime_type, lock_expires_at')
    .eq('id', pending.shared_story_id as string)
    .maybeSingle();
  if (sErr) throw new Error(`SHARED_STORY_PENDING_STORY_LOOKUP_FAILED: ${sErr.message}`);
  return (story as never) ?? null;
}

async function dropStalePending(serviceClient: SupabaseClient, userId: string, sharedStoryId: string): Promise<void> {
  // Service-role only (there is no RLS DELETE policy for users). Removes a
  // pending whose story failed/expired so the user can prepare a fresh one
  // without hitting the one-pending-per-day unique index.
  await serviceClient
    .from('user_listening_shared_progress')
    .delete()
    .eq('user_id', userId)
    .eq('shared_story_id', sharedStoryId)
    .eq('completed', false)
    .then(() => {}, () => {});
}

function reconstructFromContent(content: SharedStoryContent, audio: [string, string], mimeType: string, secret: string): ListeningStoryResult {
  return {
    title: content.title,
    level: content.level,
    summary: content.summary,
    parts: [
      {
        id: 1,
        text: content.parts[0].text,
        audioBase64: audio[0],
        audioMimeType: mimeType,
        question: content.parts[0].question,
        answerToken: signToken(content.parts[0].question.correctOptionIndex, content.parts[0].question.explanationPt, secret),
      },
      {
        id: 2,
        text: content.parts[1].text,
        audioBase64: audio[1],
        audioMimeType: mimeType,
        question: content.parts[1].question,
        answerToken: signToken(content.parts[1].question.correctOptionIndex, content.parts[1].question.explanationPt, secret),
      },
    ],
  };
}

/**
 * Wraps the EXISTING on-the-fly story flow (generateListeningStory) with
 * reuse + a database-backed lock, keyed by (level_group, practice_date) —
 * see supabase/migrations/20260724050000_create_listening_shared_stories.sql.
 * Never touches prompts, TTS, voice, duration, or the shape of
 * ListeningStoryResult itself; those all still come straight from
 * generateListeningStory, unmodified.
 */
export async function getOrCreateSharedListeningStory(
  userId: string,
  serviceClient: SupabaseClient,
  openaiKey: string,
  azureKey: string,
  azureRegion: string,
  secret: string,
  storyPackage?: string | null,
  theme?: string | null,
): Promise<ListeningStoryResult & { sharedStoryId: string }> {
  const cefrLevel = await resolveUserListeningLevel(serviceClient, userId);
  const levelGroup = levelGroupForCefr(cefrLevel);
  const practiceDate = resolveListeningActivityDate();

  // ── Step 0: RECOVER a PENDING story ────────────────────────────────────────
  // Preparing a story only creates a PENDING association (completed=false);
  // while it exists, the user must ALWAYS get that same story back — leaving,
  // refreshing, logging out, or switching devices must not swap it or advance
  // the sequence. Because the pending lives in the DB (not local cache), this
  // is device-independent. At most one pending per user/day (unique index).
  const pending = await findPendingStory(serviceClient, userId, practiceDate);
  if (pending) {
    const lockExpired = pending.lock_expires_at
      ? new Date(pending.lock_expires_at).getTime() < Date.now()
      : false;
    if (pending.status === 'ready' && pending.content && pending.part1_audio_path && pending.part2_audio_path) {
      const [a1, a2] = await Promise.all([
        downloadPartAudioBase64(serviceClient, pending.part1_audio_path),
        downloadPartAudioBase64(serviceClient, pending.part2_audio_path),
      ]);
      const story = reconstructFromContent(pending.content, [a1, a2], pending.audio_mime_type ?? 'audio/mpeg', secret);
      return { ...story, sharedStoryId: pending.id };
    }
    if (pending.status === 'generating' && !lockExpired) {
      // Still being prepared (this or a concurrent request). Client retries.
      throw new SharedStoryGeneratingError(levelGroup);
    }
    // 'failed', an expired 'generating', or a 'ready' row missing content:
    // stale pending → drop it so a fresh story can be prepared without tripping
    // the one-pending-per-day index. The user never practiced it, so no quota
    // was consumed.
    await dropStalePending(serviceClient, userId, pending.id);
  }

  // ── Prepare a NEW story ────────────────────────────────────────────────────
  // Only reached when the user has no valid pending. The daily limit is gated
  // by checkListeningCanStart in the handler BEFORE this runs — and a pending
  // always implies "under limit" (preparing at the limit is blocked), so
  // recovery above never needs the limit; only new preparation is gated.
  //
  // User-aware acquire: returns the next shared story this user has NOT opened
  // yet for today's level group (cache reuse across users), or allocates a new
  // slot to generate only when none is available.
  const { data, error } = await serviceClient.rpc('acquire_or_get_listening_shared_story', {
    p_user_id: userId,
    p_level_group: levelGroup,
    p_target_level: cefrLevel,
    p_practice_date: practiceDate,
    p_lock_duration_seconds: SHARED_STORY_LOCK_DURATION_SECONDS,
  });
  if (error) throw new Error(`SHARED_STORY_LOCK_RPC_FAILED: ${error.message}`);

  const row = (data as Array<{
    id: string; status: string; won: boolean; content: SharedStoryContent | null;
    part1_audio_path: string | null; part2_audio_path: string | null;
    audio_mime_type: string | null; error_message: string | null;
  }>)[0];
  if (!row) throw new Error('SHARED_STORY_LOCK_RPC_RETURNED_NO_ROW');

  const result: AcquireSharedStoryResult = {
    id: row.id,
    status: row.status as AcquireSharedStoryResult['status'],
    won: row.won,
    content: row.content,
    part1AudioPath: row.part1_audio_path,
    part2AudioPath: row.part2_audio_path,
    audioMimeType: row.audio_mime_type,
    errorMessage: row.error_message,
  };

  if (result.won) {
    try {
      const story = await generateListeningStory(userId, serviceClient, openaiKey, azureKey, azureRegion, secret, storyPackage, theme);
      await persistSharedStory(serviceClient, result.id, levelGroup, story);
      await attachUserProgress(serviceClient, userId, result.id, practiceDate, levelGroup);
      return { ...story, sharedStoryId: result.id };
    } catch (err) {
      await markSharedStoryFailed(serviceClient, result.id, err);
      throw err;
    }
  }

  if (result.status === 'ready') {
    if (!result.content || !result.part1AudioPath || !result.part2AudioPath) {
      throw new Error('SHARED_STORY_READY_BUT_INCOMPLETE');
    }
    const [audio1, audio2] = await Promise.all([
      downloadPartAudioBase64(serviceClient, result.part1AudioPath),
      downloadPartAudioBase64(serviceClient, result.part2AudioPath),
    ]);
    const story = reconstructFromContent(result.content, [audio1, audio2], result.audioMimeType ?? 'audio/mpeg', secret);
    await attachUserProgress(serviceClient, userId, result.id, practiceDate, levelGroup);
    return { ...story, sharedStoryId: result.id };
  }

  // status === 'generating', won === false: another request holds a live lock.
  throw new SharedStoryGeneratingError(levelGroup);
}
