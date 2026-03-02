import test from 'node:test';
import assert from 'node:assert/strict';

import { decideVoiceCall } from './voiceCallDecision.js';

test('completed status sends no sms by default', () => {
  const decision = decideVoiceCall({ callStatus: 'completed', businessId: 'biz_1' });
  assert.equal(decision.normalizedStatus, 'completed');
  assert.deepEqual(decision.sms, { send: false, kind: null, reason: null });
});

test('failed-like statuses send missed call sms when business id is present', () => {
  const decision = decideVoiceCall({ callStatus: 'busy', businessId: 'biz_1' });
  assert.equal(decision.normalizedStatus, 'failed');
  assert.deepEqual(decision.sms, { send: true, kind: 'MISSED_CALL', reason: 'failed_call' });
});

test('does not send missed call sms when business id is missing', () => {
  const decision = decideVoiceCall({ callStatus: 'failed', businessId: '' });
  assert.equal(decision.normalizedStatus, 'failed');
  assert.deepEqual(decision.sms, { send: false, kind: null, reason: null });
});

test('not ready with auto sms enabled sends unavailable sms with reason', () => {
  const decision = decideVoiceCall({
    callStatus: 'started',
    businessId: 'biz_1',
    isReady: false,
    isShuttingDown: false,
    afterHours: false,
    afterHoursAutoSmsEnabled: true,
  });
  assert.equal(decision.normalizedStatus, 'started');
  assert.deepEqual(decision.sms, { send: true, kind: 'UNAVAILABLE', reason: 'not_ready' });
});

test('after hours with auto sms enabled sets unavailable reason after_hours', () => {
  const decision = decideVoiceCall({
    callStatus: 'started',
    businessId: 'biz_1',
    isReady: true,
    isShuttingDown: false,
    afterHours: true,
    afterHoursAutoSmsEnabled: true,
  });
  assert.equal(decision.normalizedStatus, 'started');
  assert.deepEqual(decision.sms, { send: true, kind: 'UNAVAILABLE', reason: 'after_hours' });
});

test('shutting down takes precedence over not ready and after hours', () => {
  const decision = decideVoiceCall({
    callStatus: 'started',
    businessId: 'biz_1',
    isReady: false,
    isShuttingDown: true,
    afterHours: true,
    afterHoursAutoSmsEnabled: true,
  });
  assert.equal(decision.normalizedStatus, 'started');
  assert.deepEqual(decision.sms, { send: true, kind: 'UNAVAILABLE', reason: 'shutting_down' });
});

test('combined case sets kind BOTH with canonical reason', () => {
  const decision = decideVoiceCall({
    callStatus: 'no-answer',
    businessId: 'biz_1',
    isReady: false,
    isShuttingDown: false,
    afterHours: false,
    afterHoursAutoSmsEnabled: true,
  });
  assert.equal(decision.normalizedStatus, 'failed');
  assert.deepEqual(decision.sms, { send: true, kind: 'BOTH', reason: 'failed_call_and_unavailable' });
});

test('does not send unavailable sms when auto sms disabled', () => {
  const decision = decideVoiceCall({
    callStatus: 'started',
    businessId: 'biz_1',
    isReady: false,
    isShuttingDown: false,
    afterHours: true,
    afterHoursAutoSmsEnabled: false,
  });
  assert.equal(decision.normalizedStatus, 'started');
  assert.deepEqual(decision.sms, { send: false, kind: null, reason: null });
});
