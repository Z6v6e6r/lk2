import { describe, expect, it } from 'vitest';

import {
  ReportArgumentError,
  maskPhone,
  parseReportArguments,
} from './report-phone-identity-anomalies.js';

describe('phone identity anomaly report arguments and masking', () => {
  it('defaults to the configured Web Push app and environment', () => {
    expect(parseReportArguments([], {})).toEqual({
      appId: 'padlhub-web',
      environment: 'SANDBOX',
      showPhones: false,
      failOnAnomalies: false,
      failOnAny: false,
    });
    expect(
      parseReportArguments([], {
        WEB_PUSH_APP_ID: 'padlhub-web-beta',
        WEB_PUSH_ENVIRONMENT: 'PRODUCTION',
      }),
    ).toMatchObject({ appId: 'padlhub-web-beta', environment: 'PRODUCTION' });
  });

  it('accepts explicit overrides and gates', () => {
    expect(
      parseReportArguments([
        '--tenant',
        'local-padel',
        '--app-id',
        'other-app',
        '--environment',
        'PRODUCTION',
        '--show-phones',
        '--fail-on-any',
      ]),
    ).toEqual({
      tenantKey: 'local-padel',
      appId: 'other-app',
      environment: 'PRODUCTION',
      showPhones: true,
      failOnAnomalies: false,
      failOnAny: true,
    });
  });

  it('refuses a flag without a value instead of widening to every tenant', () => {
    expect(() => parseReportArguments(['--tenant'])).toThrow(ReportArgumentError);
    expect(() => parseReportArguments(['--tenant', '--show-phones'])).toThrow(ReportArgumentError);
    expect(() => parseReportArguments(['--environment', 'staging'])).toThrow(ReportArgumentError);
    expect(() => parseReportArguments([], { WEB_PUSH_ENVIRONMENT: 'STAGING' })).toThrow(
      ReportArgumentError,
    );
  });

  it('masks every phone but the last four digits', () => {
    // The provider phone is unconstrained text, so a short value must not be revealed either.
    expect(maskPhone('+79104303190')).toBe('•••• 3190');
    expect(maskPhone('+79995550003')).toBe('•••• 0003');
    expect(maskPhone('12345')).toBe('•••• 2345');
    expect(maskPhone('123')).toBe('••••');
    expect(maskPhone('')).toBe('••••');
  });
});
