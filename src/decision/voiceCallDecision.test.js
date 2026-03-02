import test from 'node:test';
import assert from 'node:assert/strict';

import { decideVoiceCall } from './voiceCallDecision.js';

test('normalizes completed status and sends no sms by default', () => {
  const decision = decideVoiceCall({ callStatus: 'completed', businessId: 'biz_1' });
  assert.equal(decision.action, 'NO_SMS');
  assert.equal(decision.details.normalizedStatus, 'completed');
});

test('normalizes failed-like statuses and returns missed call action', () => {
  const decision = decideVoiceCall({ callStatus: 'busy', businessId: 'biz_1' });
  assert.equal(decision.action, 'SEND_MISSED_CALL_SMS');
  assert.equal(decision.details.normalizedStatus, 'failed');
});

test('does not send missed call sms when business id is missing', () => {
  const decision = decideVoiceCall({ callStatus: 'failed', businessId: '' });
  assert.equal(decision.action, 'NO_SMS');
});

test('returns unavailable sms when not ready and auto sms enabled', () => {
  const decision = decideVoiceCall({
    callStatus: 'started',
    businessId: 'biz_1',
    isReady: false,
    isShuttingDown: false,
    afterHours: false,
    afterHoursAutoSmsEnabled: true,
  });
  assert.equal(decision.action, 'SEND_UNAVAILABLE_SMS');
  assert.equal(decision.reason, 'not_ready');
});

test('returns unavailable sms when after hours and auto sms enabled', () => {
  const decision = decideVoiceCall({
    callStatus: 'started',
    businessId: 'biz_1',
    isReady: true,
    isShuttingDown: false,
    afterHours: true,
    afterHoursAutoSmsEnabled: true,
  });
  assert.equal(decision.action, 'SEND_UNAVAILABLE_SMS');
  assert.equal(decision.reason, 'after_hours');
});

test('returns combined action when failed and unavailable conditions both match', () => {
  const decision = decideVoiceCall({
    callStatus: 'no-answer',
    businessId: 'biz_1',
    isReady: true,
    isShuttingDown: true,
    afterHours: false,
    afterHoursAutoSmsEnabled: true,
  });
  assert.equal(decision.action, 'SEND_MISSED_AND_UNAVAILABLE_SMS');
  assert.equal(decision.details.unavailableReason, 'not_ready');
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
  assert.equal(decision.action, 'NO_SMS');
});
