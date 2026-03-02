import test from 'node:test';
import assert from 'node:assert/strict';

import { decideVoiceCall } from './voiceCallDecision.js';

test('completed status sends no sms by default', () => {
  const decision = decideVoiceCall({ callStatus: 'completed', businessId: 'biz_1' });
  assert.equal(decision.normalizedStatus, 'completed');
  assert.equal(decision.sendMissedCallSms, false);
  assert.equal(decision.sendUnavailableSms, false);
  assert.equal(decision.unavailableReason, null);
  assert.equal(decision.combined, false);
});

test('failed-like statuses send missed call sms when business id is present', () => {
  const decision = decideVoiceCall({ callStatus: 'busy', businessId: 'biz_1' });
  assert.equal(decision.normalizedStatus, 'failed');
  assert.equal(decision.sendMissedCallSms, true);
  assert.equal(decision.sendUnavailableSms, false);
  assert.equal(decision.unavailableReason, null);
  assert.equal(decision.combined, false);
});

test('does not send missed call sms when business id is missing', () => {
  const decision = decideVoiceCall({ callStatus: 'failed', businessId: '' });
  assert.equal(decision.normalizedStatus, 'failed');
  assert.equal(decision.sendMissedCallSms, false);
  assert.equal(decision.sendUnavailableSms, false);
  assert.equal(decision.unavailableReason, null);
  assert.equal(decision.combined, false);
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
  assert.equal(decision.sendMissedCallSms, false);
  assert.equal(decision.sendUnavailableSms, true);
  assert.equal(decision.unavailableReason, 'not_ready');
  assert.equal(decision.combined, false);
});

test('after hours with auto sms enabled sets unavailableReason after_hours', () => {
  const decision = decideVoiceCall({
    callStatus: 'started',
    businessId: 'biz_1',
    isReady: true,
    isShuttingDown: false,
    afterHours: true,
    afterHoursAutoSmsEnabled: true,
  });
  assert.equal(decision.normalizedStatus, 'started');
  assert.equal(decision.sendMissedCallSms, false);
  assert.equal(decision.sendUnavailableSms, true);
  assert.equal(decision.unavailableReason, 'after_hours');
  assert.equal(decision.combined, false);
});

test('combined case sets combined true and both sms booleans true', () => {
  const decision = decideVoiceCall({
    callStatus: 'no-answer',
    businessId: 'biz_1',
    isReady: false,
    isShuttingDown: false,
    afterHours: false,
    afterHoursAutoSmsEnabled: true,
  });
  assert.equal(decision.normalizedStatus, 'failed');
  assert.equal(decision.sendMissedCallSms, true);
  assert.equal(decision.sendUnavailableSms, true);
  assert.equal(decision.unavailableReason, 'not_ready');
  assert.equal(decision.combined, true);
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
  assert.equal(decision.sendMissedCallSms, false);
  assert.equal(decision.sendUnavailableSms, false);
  assert.equal(decision.unavailableReason, null);
  assert.equal(decision.combined, false);
});
