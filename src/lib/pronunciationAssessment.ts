import { PronunciationAssessment, PronunciationAssessmentStatus, PronunciationNormalizedResult, PronunciationStatusResponse } from '../types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function buildStatusResponse(
  assessment: PronunciationAssessment | null,
): PronunciationStatusResponse {
  if (!assessment) {
    return { status: 'available', canAnalyze: true, assessmentId: null };
  }

  const { status, id } = assessment;

  const canAnalyze: boolean = status === 'failed_retryable' || status === 'failed_final';

  if (status === 'completed' && assessment.pronunciationScore !== null) {
    const result: PronunciationNormalizedResult = {
      pronunciationScore:   assessment.pronunciationScore!,
      accuracyScore:        assessment.accuracyScore ?? 0,
      fluencyScore:         assessment.fluencyScore ?? 0,
      completenessScore:    assessment.completenessScore ?? 0,
      prosodyScore:         assessment.prosodyScore ?? null,
      recognizedText:       assessment.recognizedText ?? '',
      wordsJson:            Array.isArray(assessment.wordsJson) ? assessment.wordsJson : [],
      rawSegments:          Array.isArray(assessment.rawResultJson) ? assessment.rawResultJson : [],
      audioDurationSeconds: assessment.audioDurationSeconds ?? 0,
    };
    return { status, canAnalyze, assessmentId: id, result };
  }

  return { status, canAnalyze, assessmentId: id };
}

export function rowToAssessment(row: Record<string, unknown>): PronunciationAssessment {
  return {
    id: String(row.id ?? ''),
    userId: String(row.user_id ?? ''),
    textVersionId: String(row.text_version_id ?? ''),
    status: (row.status as PronunciationAssessmentStatus) ?? 'processing',
    referenceText: String(row.reference_text ?? ''),
    languageCode: String(row.language_code ?? 'en-US'),
    azureRegion: String(row.azure_region ?? ''),
    activeAttemptId: row.active_attempt_id != null ? String(row.active_attempt_id) : null,
    attemptStartedAt: row.attempt_started_at != null ? String(row.attempt_started_at) : null,
    pronunciationScore: row.pronunciation_score != null ? Number(row.pronunciation_score) : null,
    accuracyScore: row.accuracy_score != null ? Number(row.accuracy_score) : null,
    fluencyScore: row.fluency_score != null ? Number(row.fluency_score) : null,
    completenessScore: row.completeness_score != null ? Number(row.completeness_score) : null,
    prosodyScore: row.prosody_score != null ? Number(row.prosody_score) : null,
    recognizedText: row.recognized_text != null ? String(row.recognized_text) : null,
    wordsJson: row.words_json ?? null,
    rawResultJson: row.raw_result_json ?? null,
    audioPath: row.audio_path != null ? String(row.audio_path) : null,
    audioDurationSeconds: row.audio_duration_seconds != null ? Number(row.audio_duration_seconds) : null,
    errorCode: row.error_code != null ? String(row.error_code) : null,
    errorMessage: row.error_message != null ? String(row.error_message) : null,
    startedAt: row.started_at != null ? String(row.started_at) : null,
    completedAt: row.completed_at != null ? String(row.completed_at) : null,
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}
