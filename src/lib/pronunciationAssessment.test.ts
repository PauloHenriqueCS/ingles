import { describe, it, expect } from 'vitest';
import { isValidUuid, buildStatusResponse, rowToAssessment } from './pronunciationAssessment';
import { PronunciationAssessment } from '../types';

const VALID_UUID = '123e4567-e89b-12d3-a456-426614174000';

const baseAssessment: PronunciationAssessment = {
  id: VALID_UUID,
  userId: VALID_UUID,
  textVersionId: VALID_UUID,
  status: 'completed',
  referenceText: 'Hello world',
  languageCode: 'en-US',
  azureRegion: 'eastus',
  activeAttemptId: null,
  attemptStartedAt: null,
  pronunciationScore: 85,
  accuracyScore: 88,
  fluencyScore: 82,
  completenessScore: 90,
  prosodyScore: 80,
  recognizedText: 'Hello world',
  wordsJson: null,
  rawResultJson: null,
  audioPath: null,
  audioDurationSeconds: null,
  errorCode: null,
  errorMessage: null,
  startedAt: '2026-07-13T10:00:00Z',
  completedAt: '2026-07-13T10:00:05Z',
  createdAt: '2026-07-13T10:00:00Z',
  updatedAt: '2026-07-13T10:00:05Z',
};

describe('isValidUuid', () => {
  it('accepts a valid UUID v4', () => {
    expect(isValidUuid(VALID_UUID)).toBe(true);
  });

  it('rejects a non-UUID string', () => {
    expect(isValidUuid('not-a-uuid')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidUuid('')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isValidUuid(null)).toBe(false);
    expect(isValidUuid(undefined)).toBe(false);
    expect(isValidUuid(123)).toBe(false);
  });
});

describe('buildStatusResponse', () => {
  it('returns available when no assessment exists', () => {
    const r = buildStatusResponse(null);
    expect(r.status).toBe('available');
    expect(r.canAnalyze).toBe(true);
    expect(r.assessmentId).toBeNull();
  });

  it('returns completed status, canAnalyze true', () => {
    const r = buildStatusResponse(baseAssessment);
    expect(r.status).toBe('completed');
    expect(r.canAnalyze).toBe(true);
    expect(r.assessmentId).toBe(VALID_UUID);
  });

  it('returns processing status, canAnalyze false', () => {
    const r = buildStatusResponse({ ...baseAssessment, status: 'processing' });
    expect(r.status).toBe('processing');
    expect(r.canAnalyze).toBe(false);
  });

  it('returns failed_retryable status, canAnalyze true', () => {
    const r = buildStatusResponse({ ...baseAssessment, status: 'failed_retryable' });
    expect(r.status).toBe('failed_retryable');
    expect(r.canAnalyze).toBe(true);
  });

  it('returns failed_final status, canAnalyze true', () => {
    const r = buildStatusResponse({ ...baseAssessment, status: 'failed_final' });
    expect(r.status).toBe('failed_final');
    expect(r.canAnalyze).toBe(true);
  });
});

describe('rowToAssessment', () => {
  it('maps all fields from a DB row', () => {
    const row: Record<string, unknown> = {
      id: VALID_UUID,
      user_id: VALID_UUID,
      text_version_id: VALID_UUID,
      status: 'completed',
      reference_text: 'Hello',
      language_code: 'en-US',
      azure_region: 'eastus',
      pronunciation_score: '85.50',
      accuracy_score: '88.00',
      fluency_score: null,
      completeness_score: null,
      prosody_score: null,
      recognized_text: 'Hello',
      words_json: null,
      raw_result_json: null,
      audio_path: null,
      audio_duration_seconds: null,
      error_code: null,
      error_message: null,
      started_at: '2026-07-13T10:00:00Z',
      completed_at: '2026-07-13T10:00:05Z',
      created_at: '2026-07-13T10:00:00Z',
      updated_at: '2026-07-13T10:00:05Z',
    };

    const a = rowToAssessment(row);
    expect(a.id).toBe(VALID_UUID);
    expect(a.pronunciationScore).toBe(85.5);
    expect(a.accuracyScore).toBe(88);
    expect(a.fluencyScore).toBeNull();
    expect(a.status).toBe('completed');
  });

  it('handles missing optional fields gracefully', () => {
    const row: Record<string, unknown> = {
      id: VALID_UUID,
      user_id: VALID_UUID,
      text_version_id: VALID_UUID,
      status: 'processing',
      reference_text: 'Test',
      language_code: 'en-US',
      azure_region: 'westus',
      created_at: '2026-07-13T10:00:00Z',
      updated_at: '2026-07-13T10:00:00Z',
    };

    const a = rowToAssessment(row);
    expect(a.pronunciationScore).toBeNull();
    expect(a.errorCode).toBeNull();
    expect(a.completedAt).toBeNull();
  });
});

// Integration stubs — require live Supabase + Azure
describe.todo('GET /api/pronunciation/status — integration');
describe.todo('UNIQUE constraint — blocks duplicate assessment for same text_version_id');
describe.todo('RLS — user cannot read another user\'s assessment');
describe.todo('RLS — browser INSERT is rejected (no INSERT policy)');
