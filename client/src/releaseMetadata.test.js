import { getReleaseMetadata } from './releaseMetadata';

it('formats the source revision and reproducible source date in UTC', () => {
  expect(getReleaseMetadata(
    '0123456789abcdef0123456789abcdef01234567',
    String(Date.parse('2026-11-17T00:00:00.000Z') / 1000),
  )).toEqual({
    versionLabel: 'Release 0123456',
    date: '2026-11-17',
    dateLabel: '17 Nov 2026',
  });
});

it('labels local builds without inventing release metadata', () => {
  expect(getReleaseMetadata(undefined, undefined)).toEqual({
    versionLabel: 'Development build',
    date: null,
    dateLabel: null,
  });
});

it('omits invalid source timestamps instead of displaying a false release date', () => {
  expect(getReleaseMetadata('0123456789abcdef', 'not-an-epoch')).toEqual({
    versionLabel: 'Release 0123456',
    date: null,
    dateLabel: null,
  });
});
